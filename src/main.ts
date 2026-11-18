import { Capture } from './capture.ts';
import { DecodingService, entryTelegram } from './decoding.ts';
import { DefinitionLoader, localFile, type Cache } from './defs/loader.ts';
import type { LoadedFile } from './defs/repository.ts';
import { EbusdClient } from './ebusd/client.ts';
import { parseGrabResult, type ScanDevice } from './ebusd/protocol.ts';
import { loadSettings, saveSettings } from './settings.ts';
import { kvGet, kvSet, throttle } from './store/persistence.ts';
import { TelegramStore, type Entry } from './store/telegram-store.ts';
import {
  deviceLookup,
  renderCounts,
  renderDefinitionsReport,
  renderDetail,
  renderDevices,
  renderRows,
  renderStatus,
  type DefinitionsState,
  type DetailContext,
} from './ui/render.ts';
import { applyView, isKnown, type FilterMode, type SortMode, type ViewState } from './ui/view.ts';
import { AnnotationStore, parseTags } from './store/annotations.ts';
import { parseQuery, searchValue, type SearchHit } from './analysis/search.ts';
import { buildSeries, seriesId, valueAt, type SeriesData, type SeriesSource } from './analysis/series.ts';
import { chartLayout, renderChart, tFor, xFor, PLOT_LEFT, type ChartLayout } from './ui/chart.ts';
import { renderSearchResults, type ByteSelection } from './ui/analysis.ts';
import { esc, hex2, timestamp } from './ui/format.ts';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const settings = loadSettings();
const store = new TelegramStore();
const client = new EbusdClient();
const capture = new Capture(client, store, settings.pollIntervalMs);
const decoding = new DecodingService();
const annotations = new AnnotationStore();
const cache: Cache = { get: kvGet, set: kvSet };
const loader = new DefinitionLoader(cache);

const view: ViewState = { filter: 'all', sort: 'count', search: '' };
let selectedKey: string | undefined;
let stateDetail: string | undefined;
let defsState: DefinitionsState = { state: 'none' };
let remoteFiles: LoadedFile[] = [];
let localSources: Array<{ name: string; text: string }> = [];
let selection: ByteSelection | undefined;
let chartSources: SeriesSource[] = [];
let searchHits: SearchHit[] = [];

// ---------------------------------------------------------------------------
// Rendering

let frame = 0;
function scheduleRender(): void {
  if (!frame) frame = requestAnimationFrame(render);
}

function viewContext(): DetailContext {
  const definitionsLoaded = !!decoding.definitions;
  const ctx: DetailContext = {
    deviceName: deviceLookup(capture.status.devices),
    definitionsLoaded,
    decoded: (e: Entry) => decoding.get(e.key),
    annotations,
    charted: new Set(chartSources.map(seriesId)),
    telegram: entryTelegram,
    decodeSample: (e: Entry, i: number) => {
      const s = e.history[i];
      return s ? decoding.decodeSample(e, s) : undefined;
    },
  };
  if (selection) ctx.selection = selection;
  return ctx;
}

/** Short name of a message: circuit.name if decoded, else its addresses and command. */
function messageName(e: Entry): string {
  const d = decoding.get(e.key);
  if (d) return `${d.def.circuit}.${d.def.name}`;
  return `${hex2(e.source)}→${hex2(e.target)} ${hex2(e.pb)}${hex2(e.sb)}${e.id ? ` ${e.id}` : ''}`;
}

function render(): void {
  frame = 0;
  const all = store.entries();
  decoding.update(all);
  const ctx = viewContext();
  const shown = applyView(all, view, ctx);
  $('status').innerHTML = renderStatus(client.state, capture.status, stateDetail);
  $('devices').innerHTML = renderDevices(capture.status.devices, defsState, localSources.length);
  $('counts').innerHTML = renderCounts(all, shown.length, ctx);
  $('rows').innerHTML = renderRows(shown, ctx, selectedKey);
  const detail = $('detail');
  const entry = selectedKey ? store.get(selectedKey) : undefined;
  detail.hidden = !entry;
  // keep the detail panel stable while the pointer is over it (hover
  // highlighting) or while the user is typing a note
  const editing = detail.contains(document.activeElement) && document.activeElement?.matches('input, textarea');
  if (detail.dataset.key !== selectedKey || (!detail.matches(':hover') && !editing)) {
    detail.innerHTML = renderDetail(entry, ctx);
    detail.dataset.key = selectedKey ?? '';
  }
  $('btn-connect').textContent = client.state === 'disconnected' ? 'Connect' : 'Disconnect';
  renderChartArea();
  if (defsDialog.open) $('defs-report').innerHTML = renderDefinitionsReport(defsState, localSources.map((l) => l.name));
}

store.onChange(() => {
  decoding.invalidate();
  scheduleRender();
});
capture.onChange(() => {
  onDevices(capture.status.devices);
  scheduleRender();
});
client.onStateChange((_state, detail) => {
  stateDetail = detail;
  scheduleRender();
});
setInterval(scheduleRender, 5000); // keep "last seen" fresh

// ---------------------------------------------------------------------------
// Persistence (ARCH-6)

const CAPTURE_KEY = 'capture';
const DEVICES_KEY = 'devices';
const LOCAL_DEFS_KEY = 'local-definitions';
const ANNOTATIONS_KEY = 'annotations';
const autosave = throttle(() => void kvSet(CAPTURE_KEY, store.toJSON()).catch(console.error), 3000);

async function restore(): Promise<void> {
  try {
    const saved = await kvGet(CAPTURE_KEY);
    if (saved) store.load(saved);
    const devices = await kvGet<ScanDevice[]>(DEVICES_KEY);
    if (devices?.length && !capture.status.devices.length) capture.status.devices = devices;
    localSources = (await kvGet<Array<{ name: string; text: string }>>(LOCAL_DEFS_KEY)) ?? [];
    annotations.load(await kvGet(ANNOTATIONS_KEY));
  } catch (err) {
    console.warn('could not restore capture', err);
  }
  store.onChange(autosave);
  annotations.onChange(() => {
    void kvSet(ANNOTATIONS_KEY, annotations.toJSON()).catch(console.error);
    scheduleRender();
  });
}

// ---------------------------------------------------------------------------
// Definitions (DEC-1, DEC-2, DEC-6)

let loadedSignature = '';
let loadRun = 0;

function deviceSignature(devices: readonly ScanDevice[]): string {
  return devices.map((d) => `${d.address}:${d.manufacturer}:${d.deviceId}:${d.sw}:${d.hw}`).sort().join('|');
}

function applyDefinitionFiles(): void {
  const locals = localSources.map((l) => localFile(l.name, l.text));
  decoding.setFiles([...locals, ...remoteFiles]);
  decoding.setDevices(capture.status.devices);
  if (defsState.state === 'ready') defsState = { ...defsState, messages: decoding.definitions?.messageCount ?? 0 };
  else if (locals.length && defsState.state === 'none') {
    defsState = { state: 'ready', report: { files: locals, unmatched: [], errors: [], offline: false }, messages: decoding.definitions?.messageCount ?? 0, at: Date.now() };
  }
  scheduleRender();
}

async function loadDefinitions(force = false): Promise<void> {
  const devices = capture.status.devices;
  const signature = `${deviceSignature(devices)}#${JSON.stringify(settings.source)}`;
  if (!force && signature === loadedSignature) return;
  loadedSignature = signature;
  if (!devices.length) {
    remoteFiles = [];
    applyDefinitionFiles();
    return;
  }
  const run = ++loadRun;
  defsState = { state: 'loading' };
  scheduleRender();
  try {
    const report = await loader.load(devices, settings.source);
    if (run !== loadRun) return;
    remoteFiles = report.files;
    const locals = localSources.map((l) => localFile(l.name, l.text));
    defsState = { state: 'ready', report: { ...report, files: [...locals, ...report.files] }, messages: 0, at: Date.now() };
  } catch (err) {
    if (run !== loadRun) return;
    remoteFiles = [];
    defsState = { state: 'error', error: err instanceof Error ? err.message : String(err) };
  }
  applyDefinitionFiles();
}

let savedDevices = '';
function onDevices(devices: readonly ScanDevice[]): void {
  const signature = deviceSignature(devices);
  if (signature === savedDevices) return;
  savedDevices = signature;
  decoding.setDevices(devices);
  if (devices.length) void kvSet(DEVICES_KEY, devices).catch(() => {});
  void loadDefinitions();
}

const defsDialog = $('definitions') as HTMLDialogElement;
function openDefinitions(): void {
  ($('defs-url') as HTMLInputElement).value = settings.source.baseUrl;
  ($('defs-channel') as HTMLSelectElement).value = settings.source.channel;
  ($('defs-lang') as HTMLSelectElement).value = settings.source.language;
  $('defs-report').innerHTML = renderDefinitionsReport(defsState, localSources.map((l) => l.name));
  defsDialog.showModal();
}
$('btn-defs').addEventListener('click', openDefinitions);
$('devices').addEventListener('click', (ev) => {
  if ((ev.target as HTMLElement).closest('[data-action="definitions"]')) openDefinitions();
});
$('defs-reload').addEventListener('click', () => {
  const url = ($('defs-url') as HTMLInputElement).value.trim();
  if (/^https?:\/\//.test(url)) settings.source.baseUrl = url;
  settings.source.channel = ($('defs-channel') as HTMLSelectElement).value === 'next/' ? 'next/' : '';
  settings.source.language = ($('defs-lang') as HTMLSelectElement).value === 'de' ? 'de' : 'en';
  saveSettings(settings);
  void loadDefinitions(true);
});
const localInput = $('defs-local-file') as HTMLInputElement;
$('defs-add-local').addEventListener('click', () => localInput.click());
localInput.addEventListener('change', async () => {
  const files = [...(localInput.files ?? [])];
  localInput.value = '';
  for (const f of files) {
    const text = await f.text();
    localSources = [...localSources.filter((l) => l.name !== f.name), { name: f.name, text }];
  }
  await kvSet(LOCAL_DEFS_KEY, localSources);
  if (defsState.state === 'ready') {
    const locals = localSources.map((l) => localFile(l.name, l.text));
    defsState = { ...defsState, report: { ...defsState.report, files: [...locals, ...remoteFiles] } };
  }
  applyDefinitionFiles();
});
$('defs-clear-local').addEventListener('click', async () => {
  localSources = [];
  await kvSet(LOCAL_DEFS_KEY, localSources);
  if (defsState.state === 'ready') {
    defsState = { ...defsState, report: { ...defsState.report, files: [...remoteFiles] } };
    if (!remoteFiles.length) defsState = { state: 'none' };
  }
  applyDefinitionFiles();
});

// ---------------------------------------------------------------------------
// Connection

function connect(): void {
  client.connect(settings.bridgeUrl);
}

$('btn-connect').addEventListener('click', () => {
  if (client.state === 'disconnected') connect();
  else client.disconnect();
});

// ---------------------------------------------------------------------------
// Settings dialog

const dialog = $('settings') as HTMLDialogElement;
$('btn-settings').addEventListener('click', () => {
  ($('set-url') as HTMLInputElement).value = settings.bridgeUrl;
  ($('set-interval') as HTMLInputElement).value = String(settings.pollIntervalMs / 1000);
  dialog.showModal();
});
dialog.addEventListener('close', () => {
  if (dialog.returnValue !== 'save') return;
  const url = ($('set-url') as HTMLInputElement).value.trim();
  const seconds = Number(($('set-interval') as HTMLInputElement).value);
  const urlChanged = url !== settings.bridgeUrl;
  settings.bridgeUrl = url || settings.bridgeUrl;
  if (seconds >= 1) settings.pollIntervalMs = Math.round(seconds * 1000);
  capture.intervalMs = settings.pollIntervalMs;
  saveSettings(settings);
  if (urlChanged && client.state !== 'disconnected') connect();
});

// ---------------------------------------------------------------------------
// Toolbar

$('search').addEventListener('input', (ev) => {
  view.search = (ev.target as HTMLInputElement).value;
  scheduleRender();
});

for (const btn of document.querySelectorAll<HTMLButtonElement>('[data-filter]')) {
  btn.addEventListener('click', () => {
    view.filter = btn.dataset.filter as FilterMode;
    for (const b of document.querySelectorAll('[data-filter]')) b.classList.toggle('active', b === btn);
    scheduleRender();
  });
}

$('sort').addEventListener('change', (ev) => {
  view.sort = (ev.target as HTMLSelectElement).value as SortMode;
  scheduleRender();
});

$('btn-seen').addEventListener('click', () => store.markAllSeen());

$('btn-clear').addEventListener('click', () => {
  if (confirm('Delete all captured telegrams?')) {
    selectedKey = undefined;
    store.clear();
  }
});

$('btn-export').addEventListener('click', () => {
  const data = { ...store.toJSON(), devices: capture.status.devices, annotations: annotations.toJSON() };
  const blob = new Blob([JSON.stringify(data, null, 1)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `ebus-capture-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
});

// Import (CON-6): a capture exported from this app (.json), or the text output
// of `ebusctl grab result all` (.txt/.log), which is merged into the store.
const fileInput = $('file') as HTMLInputElement;
$('btn-import').addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', async () => {
  const file = fileInput.files?.[0];
  fileInput.value = '';
  if (!file) return;
  const text = await file.text();
  try {
    if (text.trimStart().startsWith('{')) {
      if (store.size && !confirm('Replace the current capture with the imported one?')) return;
      selectedKey = undefined;
      const data = JSON.parse(text) as { devices?: ScanDevice[]; annotations?: unknown };
      store.load(data);
      if (data.annotations) annotations.load(data.annotations, true);
      if (Array.isArray(data.devices) && data.devices.length && client.state !== 'connected') {
        capture.status.devices = data.devices;
        onDevices(data.devices);
      }
    } else {
      const lines = parseGrabResult(text.split(/\r?\n/));
      if (!lines.length) throw new Error('no telegrams found in file');
      const stats = store.ingest(lines, { now: file.lastModified || Date.now() });
      alert(`Imported ${lines.length} telegrams: ${stats.added} new messages, ${stats.changed} changed.`);
    }
  } catch (err) {
    alert(`Import failed: ${err instanceof Error ? err.message : String(err)}`);
  }
});

// ---------------------------------------------------------------------------
// Table and detail panel

$('rows').addEventListener('click', (ev) => {
  const row = (ev.target as HTMLElement).closest<HTMLTableRowElement>('tr[data-key]');
  if (!row) return;
  selectedKey = row.dataset.key === selectedKey ? undefined : row.dataset.key;
  selection = undefined;
  scheduleRender();
});

const detailEl = $('detail');
detailEl.addEventListener('click', (ev) => {
  const action = (ev.target as HTMLElement).closest<HTMLElement>('[data-action]')?.dataset.action;
  if (!action) return;
  const entry = selectedKey ? store.get(selectedKey) : undefined;
  if (action === 'close-detail') selectedKey = undefined;
  else if (action === 'mark-seen' && entry) store.markSeen(entry.key);
  else if (action === 'copy' && entry) {
    const text = entry.lastMasterHex + (entry.lastSlaveHex ? ` / ${entry.lastSlaveHex}` : '');
    void navigator.clipboard?.writeText(text);
  } else if (entry) {
    const el = (ev.target as HTMLElement).closest<HTMLElement>('[data-action]')!;
    const part = el.dataset.p === 's' ? 's' : 'm';
    switch (action) {
      case 'select-byte': {
        const offset = Number(el.dataset.i);
        const same = selection?.key === entry.key && selection.part === part && selection.offset === offset;
        selection = same ? undefined : { key: entry.key, part, offset };
        break;
      }
      case 'plot-bytes':
        addSeries({ kind: 'bytes', key: entry.key, part, offset: Number(el.dataset.i), type: el.dataset.type ?? 'UCH' });
        break;
      case 'plot-field':
        addSeries({ kind: 'field', key: entry.key, field: el.dataset.field ?? '' });
        break;
      case 'save-note':
        annotations.set(entry.key, {
          note: ($('note-text') as HTMLTextAreaElement).value,
          tags: parseTags(($('note-tags') as HTMLInputElement).value),
        });
        (document.activeElement as HTMLElement | null)?.blur();
        break;
      case 'toggle-ignore':
        annotations.set(entry.key, { ignored: !annotations.isIgnored(entry.key) });
        break;
    }
  }
  detailEl.dataset.key = ''; // force re-render
  scheduleRender();
});

// Hovering a field highlights its bytes and vice versa (DEC-5).
function highlight(part: string | undefined, from: number, len: number): void {
  for (const el of detailEl.querySelectorAll<HTMLElement>('.hl')) el.classList.remove('hl');
  if (!part) return;
  for (const b of detailEl.querySelectorAll<HTMLElement>(`.telegram .b[data-p="${part}"]`)) {
    const i = Number(b.dataset.i);
    if (i >= from && i < from + len) b.classList.add('hl');
  }
  for (const r of detailEl.querySelectorAll<HTMLElement>(`tr.field[data-p="${part}"]`)) {
    const f = Number(r.dataset.from);
    const l = Number(r.dataset.len);
    if (f < from + len && from < f + l) r.classList.add('hl');
  }
}
detailEl.addEventListener('mouseover', (ev) => {
  const target = ev.target as HTMLElement;
  const row = target.closest<HTMLElement>('tr.field');
  if (row) return highlight(row.dataset.p, Number(row.dataset.from), Number(row.dataset.len));
  const byte = target.closest<HTMLElement>('.telegram .b[data-p]');
  if (byte) return highlight(byte.dataset.p, Number(byte.dataset.i), 1);
  highlight(undefined, 0, 0);
});
detailEl.addEventListener('mouseleave', () => {
  highlight(undefined, 0, 0);
  scheduleRender();
});

document.addEventListener('keydown', (ev) => {
  if (ev.key === 'Escape' && selectedKey && !dialog.open && !defsDialog.open && !findDialog.open) {
    selectedKey = undefined;
    selection = undefined;
    scheduleRender();
  }
});

// ---------------------------------------------------------------------------
// Charts (UNK-8, UNK-10)

let chartModel: { layout: ChartLayout; series: SeriesData[] } | undefined;
let chartHoverX: number | undefined;

function addSeries(source: SeriesSource): void {
  const id = seriesId(source);
  if (!chartSources.some((s) => seriesId(s) === id)) chartSources = [...chartSources, source];
  detailEl.dataset.key = '';
  scheduleRender();
}

function renderChartArea(): void {
  const el = $('chart');
  const series: SeriesData[] = [];
  for (const src of chartSources) {
    const e = store.get(src.key);
    if (e) series.push(buildSeries(e, src, (en, s) => decoding.decodeSample(en, s), messageName(e)));
  }
  el.hidden = series.length === 0;
  if (!series.length) {
    chartModel = undefined;
    el.innerHTML = '';
    return;
  }
  const layout = chartLayout(series, el.clientWidth - 2);
  chartModel = { layout, series };
  el.innerHTML = `<div class="chart-title"><b>Over time</b> <span class="muted small">${timestamp(layout.t0)} – ${timestamp(layout.t1)} · values hold until the next change</span><button type="button" class="small" data-action="clear-chart">Remove all</button></div>${renderChart(series, layout)}`;
  if (chartHoverX !== undefined) showCrosshair(chartHoverX);
}

function showCrosshair(x: number): void {
  const el = $('chart');
  const line = el.querySelector<HTMLElement>('.crosshair');
  const tip = el.querySelector<HTMLElement>('.chart-tip');
  if (!chartModel || !line || !tip) return;
  const { layout, series } = chartModel;
  if (x < PLOT_LEFT || x > layout.width - 16) {
    line.hidden = tip.hidden = true;
    return;
  }
  const t = tFor(layout, x);
  line.hidden = tip.hidden = false;
  line.style.left = `${xFor(layout, t)}px`;
  tip.innerHTML =
    `<div class="muted">${timestamp(t)}</div>` +
    series
      .map((s) => {
        const p = valueAt(s, t);
        return `<div><span class="muted">${esc(s.label)}</span> <b>${p ? esc(p.text) : '–'}</b>${p && s.unit ? ` ${esc(s.unit)}` : ''}</div>`;
      })
      .join('');
  const left = x + 16 + tip.offsetWidth > layout.width ? x - 16 - tip.offsetWidth : x + 16;
  tip.style.left = `${Math.max(0, left)}px`;
}

const chartEl = $('chart');
chartEl.addEventListener('mousemove', (ev) => {
  const rect = chartEl.getBoundingClientRect();
  chartHoverX = ev.clientX - rect.left - 1;
  showCrosshair(chartHoverX);
});
chartEl.addEventListener('mouseleave', () => {
  chartHoverX = undefined;
  for (const el of chartEl.querySelectorAll<HTMLElement>('.crosshair, .chart-tip')) el.hidden = true;
});
chartEl.addEventListener('click', (ev) => {
  const el = (ev.target as HTMLElement).closest<HTMLElement>('[data-action]');
  if (el?.dataset.action === 'remove-series') chartSources = chartSources.filter((s) => seriesId(s) !== el.dataset.series);
  else if (el?.dataset.action === 'clear-chart') chartSources = [];
  else return;
  detailEl.dataset.key = '';
  scheduleRender();
});
window.addEventListener('resize', scheduleRender);

// ---------------------------------------------------------------------------
// Find a value (UNK-7)

const findDialog = $('find') as HTMLDialogElement;
$('btn-find').addEventListener('click', () => {
  findDialog.showModal();
  ($('find-value') as HTMLInputElement).focus();
});
$('find-close').addEventListener('click', () => findDialog.close());

function renderFindResults(): void {
  const byKey = new Map(store.entries().map((e) => [e.key, e]));
  $('find-results').innerHTML = renderSearchResults(searchHits, byKey, messageName, new Set(chartSources.map(seriesId)));
}

$('find-form').addEventListener('submit', (ev) => {
  ev.preventDefault();
  const tolStr = ($('find-tol') as HTMLInputElement).value;
  const query = parseQuery(($('find-value') as HTMLInputElement).value, tolStr ? Number(tolStr) : undefined);
  if (!query) return;
  const ctx = viewContext();
  const onlyUnknown = ($('find-unknown') as HTMLInputElement).checked;
  searchHits = searchValue(store.entries(), query, {
    history: ($('find-history') as HTMLInputElement).checked,
    filter: (e) => !annotations.isIgnored(e.key) && (!onlyUnknown || isKnown(e, ctx) !== true),
  });
  renderFindResults();
});

$('find-results').addEventListener('click', (ev) => {
  const el = (ev.target as HTMLElement).closest<HTMLElement>('[data-action]');
  const hit = searchHits[Number(el?.dataset.hit)];
  if (!el || !hit) return;
  if (el.dataset.action === 'plot-hit') {
    addSeries({ kind: 'bytes', key: hit.key, part: hit.part, offset: hit.offset, type: hit.type });
    renderFindResults();
  } else if (el.dataset.action === 'show-hit') {
    findDialog.close();
    selectedKey = hit.key;
    selection = { key: hit.key, part: hit.part, offset: hit.offset };
    if (annotations.isIgnored(hit.key)) setFilter('ignored');
    detailEl.dataset.key = '';
    scheduleRender();
  }
});

function setFilter(filter: FilterMode): void {
  view.filter = filter;
  for (const b of document.querySelectorAll<HTMLElement>('[data-filter]')) b.classList.toggle('active', b.dataset.filter === filter);
}

// ---------------------------------------------------------------------------
// Start

void restore().then(() => {
  applyDefinitionFiles();
  void loadDefinitions();
  render();
  // Connect automatically when the app is served by the bridge itself.
  try {
    if (new URL(settings.bridgeUrl).host === location.host) connect();
  } catch {
    // invalid URL in settings; user can fix it in the dialog
  }
});

import { Capture } from './capture.ts';
import { DecodingService, entryTelegram } from './decoding.ts';
import { DefinitionLoader, localFile, type Cache } from './defs/loader.ts';
import type { LoadedFile } from './defs/repository.ts';
import { EbusdClient } from './ebusd/client.ts';
import { parseGrabDecode, parseGrabResult, type ScanDevice } from './ebusd/protocol.ts';
import { messageKey, parseTelegram } from './ebus/telegram.ts';
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
  type EbusdHints,
} from './ui/render.ts';
import { applyView, isKnown, participants, type FilterMode, type SortMode, type ViewState } from './ui/view.ts';
import { AnnotationStore, parseTags } from './store/annotations.ts';
import { parseQuery, searchValue, valueFilter, type ParsedQuery, type SearchHit } from './analysis/search.ts';
import { buildSeries, seriesId, valueAt, type SeriesData, type SeriesSource } from './analysis/series.ts';
import { chartLayout, renderChart, tFor, xFor, PLOT_LEFT, type ChartLayout } from './ui/chart.ts';
import { renderSearchResults, type ByteSelection } from './ui/analysis.ts';
import { esc, hex2, timestamp } from './ui/format.ts';
import { TspCompiler } from './tsp/client.ts';
import type { CompileResult, TspDiagnostic } from './tsp/protocol.ts';
import {
  canPickDirectory,
  defaultEntry,
  ensureWritable,
  fromStored,
  pickDirectory,
  readDirectory,
  readFileList,
  toStored,
  translationFile,
  writeFiles,
  type ProjectData,
} from './tsp/project.ts';
import { selectCompiled } from './tsp/outputs.ts';
import { suggestFileName, writeTypeSpec } from './tsp/writer.ts';
import { createZip } from './util/zip.ts';
import { offsetOf, positionOf, renderDiagnostics, renderFiles, sortedDiagnostics } from './ui/typespec.ts';
import { initSplitter } from './ui/splitter.ts';
import { copyText, copyWithFeedback } from './ui/clipboard.ts';
import { createDraft, defaultCircuit, draftCsvLine, draftDefinition, setIdLength, validateDraft, type Direction, type Draft, type DraftField, type Issue } from './assistant/draft.ts';
import { DraftStore, DRAFTS_PATH, TSP_MARKER, draftTspPath } from './assistant/store.ts';
import { parseFilename } from './defs/select.ts';
import { renderDraftBytes, renderDraftFields, renderDraftHead, renderDraftSamples, renderDraftSelection, renderIssues, renderLiveLog, type DraftSelection, type LiveEntry } from './ui/assistant.ts';
import { decodeChecks, defineCommand, explainError, findCommand, hexOfSample, isError, parseFind, parseHexTelegram, readCommand, readProblem } from './ebusd/live.ts';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const settings = loadSettings();
const store = new TelegramStore();
const client = new EbusdClient();
const capture = new Capture(client, store, settings.pollIntervalMs);
const decoding = new DecodingService();
const annotations = new AnnotationStore();
const drafts = new DraftStore();
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
let tspProject: ProjectData | undefined;
let tspHandle: FileSystemDirectoryHandle | undefined;
/** CSV files of the last successful compilation (used for decoding). */
let tspCsv: Record<string, string> | undefined;
/** Entry file of the last successful compilation. */
let tspCompiledEntry: string | undefined;
let tspUse = true;

// ---------------------------------------------------------------------------
// Value filter (UNK-11, UNK-12)

/** Newest payloads per message searched when "history" is checked. */
const VALUE_FILTER_SAMPLES = 100;
let valueQuery: ParsedQuery | undefined;
let valueHistory = false;
let valueMatches: Map<string, SearchHit[]> | undefined;
let valueFilterDirty = false;

function valueFilterLabel(q: ParsedQuery): string {
  return q.kind === 'number' ? `${q.value} ±${Number(q.tolerance.toPrecision(3))}` : `"${q.text}"`;
}

function updateValueFilter(all: readonly Entry[]): void {
  if (!valueFilterDirty) return;
  valueFilterDirty = false;
  if (!valueQuery) {
    valueMatches = undefined;
    return;
  }
  const start = performance.now();
  valueMatches = valueFilter(all, valueQuery, {
    history: valueHistory,
    maxSamples: VALUE_FILTER_SAMPLES,
    fields: (e, s, latest) => (latest ? decoding.get(e.key) : decoding.decodeSample(e, s))?.result.fields,
  });
  const ms = performance.now() - start;
  if (ms > 500) console.warn(`value filter took ${ms.toFixed(0)} ms for ${all.length} messages`);
}

let valueInputTimer: ReturnType<typeof setTimeout> | undefined;
function readValueFilter(): void {
  const text = ($('vf-value') as HTMLInputElement).value;
  const tolStr = ($('vf-tol') as HTMLInputElement).value;
  const tol = tolStr === '' ? undefined : Number(tolStr);
  valueQuery = parseQuery(text, tol !== undefined && Number.isFinite(tol) && tol >= 0 ? tol : undefined);
  valueHistory = ($('vf-history') as HTMLInputElement).checked;
  $('vf-value').closest('.valuefilter')?.classList.toggle('active', !!valueQuery);
  valueFilterDirty = true;
  scheduleRender();
}
for (const id of ['vf-value', 'vf-tol']) {
  $(id).addEventListener('input', () => {
    clearTimeout(valueInputTimer);
    valueInputTimer = setTimeout(readValueFilter, 200);
  });
}
$('vf-history').addEventListener('change', readValueFilter);

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
    hasDraft: (key: string) => !!drafts.get(key),
    liveCommands: settings.liveCommands,
    ebusdHints: (key: string) => ebusdHints.get(key),
    telegram: entryTelegram,
    decodeSample: (e: Entry, i: number) => {
      const s = e.history[i];
      return s ? decoding.decodeSample(e, s) : undefined;
    },
  };
  if (selection) ctx.selection = selection;
  if (valueMatches) ctx.valueMatches = valueMatches;
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
  updateValueFilter(all);
  const ctx = viewContext();
  const shown = applyView(all, view, ctx);
  $('status').innerHTML = renderStatus(client.state, capture.status, stateDetail);
  const parts = participants(all, capture.status.devices);
  if (view.participant !== undefined && !parts.some((p) => p.key === view.participant)) view.participant = undefined;
  $('devices').innerHTML = renderDevices(capture.status.devices, defsState, localSources.length, parts, view.participant);
  const selectedPart = parts.find((p) => p.key === view.participant);
  const partName = selectedPart ? `${selectedPart.addresses.map(hex2).join('/') || hex2(selectedPart.key)}${selectedPart.device ? ` ${selectedPart.device.deviceId}` : ''}` : undefined;
  $('counts').innerHTML = renderCounts(all, shown.length, ctx, partName, valueQuery ? valueFilterLabel(valueQuery) : undefined);
  $('rows').innerHTML = renderRows(shown, ctx, selectedKey);
  const detail = $('detail');
  const entry = selectedKey ? store.get(selectedKey) : undefined;
  detail.hidden = !entry;
  $('splitter').hidden = !entry;
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
  valueFilterDirty = true;
  scheduleRender();
});
capture.onChange(() => {
  onDevices(capture.status.devices);
  scheduleRender();
});
client.onStateChange((_state, detail) => {
  updateLiveButtons();
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
const TSP_PROJECT_KEY = 'tsp-project';
const TSP_HANDLE_KEY = 'tsp-handle';
const TSP_CSV_KEY = 'tsp-csv';
const DRAFTS_KEY = 'drafts';
const autosave = throttle(() => void kvSet(CAPTURE_KEY, store.toJSON()).catch(console.error), 3000);

async function restore(): Promise<void> {
  try {
    const saved = await kvGet(CAPTURE_KEY);
    if (saved) store.load(saved);
    const devices = await kvGet<ScanDevice[]>(DEVICES_KEY);
    if (devices?.length && !capture.status.devices.length) capture.status.devices = devices;
    localSources = (await kvGet<Array<{ name: string; text: string }>>(LOCAL_DEFS_KEY)) ?? [];
    annotations.load(await kvGet(ANNOTATIONS_KEY));
    drafts.load(await kvGet(DRAFTS_KEY));
    tspProject = fromStored(await kvGet(TSP_PROJECT_KEY));
    tspHandle = await kvGet<FileSystemDirectoryHandle>(TSP_HANDLE_KEY);
    const compiled = await kvGet<{ entry?: string; csv: Record<string, string> } | Record<string, string>>(TSP_CSV_KEY);
    if (compiled && typeof compiled.csv === 'object') {
      tspCsv = compiled.csv as Record<string, string>;
      tspCompiledEntry = (compiled as { entry?: string }).entry;
    }
  } catch (err) {
    console.warn('could not restore capture', err);
  }
  store.onChange(autosave);
  annotations.onChange(() => {
    void kvSet(ANNOTATIONS_KEY, annotations.toJSON()).catch(console.error);
    scheduleRender();
  });
  drafts.onChange(() => {
    void kvSet(DRAFTS_KEY, drafts.toJSON()).catch(console.error);
    applyDefinitionFiles();
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
  valueFilterDirty = true;
  const locals = localSources.map((l) => localFile(l.name, l.text));
  // a single own file: use all its outputs; the whole configuration (main.tsp): pick per device
  const userFiles = new Set(tspCsv && tspCompiledEntry !== 'main.tsp' ? Object.keys(tspCsv) : []);
  const compiled = tspUse && tspCsv ? selectCompiled(tspCsv, capture.status.devices, userFiles) : [];
  const draftFile = drafts.definitionFile();
  const own = draftFile ? [draftFile, ...locals] : locals;
  decoding.setFiles([...own, ...compiled, ...remoteFiles]);
  decoding.setDevices(capture.status.devices);
  if (defsState.state === 'ready') defsState = { ...defsState, messages: decoding.definitions?.messageCount ?? 0 };
  else if ((own.length || compiled.length) && defsState.state === 'none') {
    defsState = { state: 'ready', report: { files: [...own, ...compiled], unmatched: [], errors: [], offline: false }, messages: decoding.definitions?.messageCount ?? 0, at: Date.now() };
  }
  if (defsState.state === 'ready') {
    const others = defsState.report.files.filter((f) => !f.path.startsWith('typespec:') && f.path !== DRAFTS_PATH);
    defsState = { ...defsState, report: { ...defsState.report, files: [...(draftFile ? [draftFile] : []), ...compiled, ...others] } };
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
  if (tspCsv) applyDefinitionFiles();
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
  const target = ev.target as HTMLElement;
  if (target.closest('[data-action="definitions"]')) return openDefinitions();
  // participant filter: one at a time, pressing it again (or "All") shows all
  const btn = target.closest<HTMLElement>('[data-participant]');
  if (!btn) return;
  const key = btn.dataset.participant === '' ? undefined : Number(btn.dataset.participant);
  view.participant = key === view.participant ? undefined : key;
  scheduleRender();
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
  ($('set-live') as HTMLInputElement).checked = settings.liveCommands;
  dialog.showModal();
});
dialog.addEventListener('close', () => {
  if (dialog.returnValue !== 'save') return;
  const url = ($('set-url') as HTMLInputElement).value.trim();
  const seconds = Number(($('set-interval') as HTMLInputElement).value);
  const urlChanged = url !== settings.bridgeUrl;
  settings.bridgeUrl = url || settings.bridgeUrl;
  if (seconds >= 1) settings.pollIntervalMs = Math.round(seconds * 1000);
  settings.liveCommands = ($('set-live') as HTMLInputElement).checked;
  capture.intervalMs = settings.pollIntervalMs;
  saveSettings(settings);
  detailEl.dataset.key = '';
  scheduleRender();
  updateLiveButtons();
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
  const data = { ...store.toJSON(), devices: capture.status.devices, annotations: annotations.toJSON(), drafts: drafts.toJSON() };
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
      const data = JSON.parse(text) as { devices?: ScanDevice[]; annotations?: unknown; drafts?: unknown };
      store.load(data);
      if (data.annotations) annotations.load(data.annotations, true);
      if (data.drafts) drafts.load(data.drafts, true);
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
    const button = (ev.target as HTMLElement).closest<HTMLElement>('[data-action]')!;
    void copyText(text).then((ok) => {
      if (!ok) prompt('Copying is not possible here – copy the telegram with Ctrl+C:', text);
      else {
        button.textContent = 'Copied';
        setTimeout(() => (button.textContent = 'Copy telegram'), 1500);
      }
    });
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
      case 'show-tsp': {
        const d = decoding.get(entry.key);
        if (d) showTypeSpecView(d.def, d.file.path);
        break;
      }
      case 'assistant':
        openAssistant(entry);
        break;
      case 'hexsend':
        openHexSend(entry);
        break;
      case 'ebusd-hints':
        void fetchEbusdHints(entry);
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
  if (ev.key === 'Escape' && selectedKey && !dialog.open && !defsDialog.open && !findDialog.open && !tspDialog.open && !tspViewDialog.open) {
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
    fields: (e, s, latest) => (latest ? decoding.get(e.key) : decoding.decodeSample(e, s))?.result.fields,
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
// TypeSpec project (M4)

const compiler = new TspCompiler();
const tspDialog = $('tsp') as HTMLDialogElement;
const tspText = $('tsp-text') as HTMLTextAreaElement;
let tspOpenFile: string | undefined;
let tspResult: CompileResult | undefined;
let tspDiags: TspDiagnostic[] = [];
let tspStatus = '';
let tspCompiling = false;

function saveProject(): void {
  if (tspProject) void kvSet(TSP_PROJECT_KEY, toStored(tspProject)).catch(console.error);
}

function editorDirty(): boolean {
  return !!tspProject && !!tspOpenFile && tspProject.files.get(tspOpenFile) !== tspText.value;
}

function applyEditor(): void {
  if (!tspProject || !tspOpenFile || !editorDirty()) return;
  tspProject.files.set(tspOpenFile, tspText.value);
  tspProject.changed.add(tspOpenFile);
  saveProject();
}

function renderTsp(): void {
  const p = tspProject;
  const files = p ? [...p.files.keys()].sort((a, b) => Number(b === 'main.tsp') - Number(a === 'main.tsp') || a.localeCompare(b)) : [];
  $('tsp-project').textContent = p ? `${p.name} · ${p.files.size} files${p.changed.size ? ` · ${p.changed.size} changed` : ''}${tspHandle ? '' : ' · not linked to a folder'}` : 'no project';
  ($('tsp-save') as HTMLButtonElement).disabled = !p || !p.changed.size || !tspHandle;
  ($('tsp-zip') as HTMLButtonElement).disabled = !p;
  ($('tsp-run') as HTMLButtonElement).disabled = !p || tspCompiling;
  ($('tsp-csv') as HTMLButtonElement).disabled = !tspResult || !Object.keys(tspResult.csv).length;
  ($('tsp-use') as HTMLInputElement).checked = tspUse;
  const entry = $('tsp-entry') as HTMLSelectElement;
  const tspFiles = files.filter((f) => f.endsWith('.tsp'));
  const current = entry.value || (p ? defaultEntry(p.files) : undefined) || '';
  entry.innerHTML = tspFiles.map((f) => `<option value="${esc(f)}"${f === current ? ' selected' : ''}>${esc(f)}</option>`).join('');
  $('tsp-diags').innerHTML = renderDiagnostics(tspDiags);
  $('tsp-files').innerHTML = renderFiles(files, p?.changed ?? new Set(), tspOpenFile, ($('tsp-filter') as HTMLInputElement).value, tspDiags);
  $('tsp-file').textContent = tspOpenFile ?? '';
  tspText.disabled = !tspOpenFile;
  ($('tsp-file-save') as HTMLButtonElement).disabled = !tspOpenFile;
  ($('tsp-file-revert') as HTMLButtonElement).disabled = !tspOpenFile;
  $('tsp-status').innerHTML = tspStatus;
}

function openTspFile(path: string, line?: number, column?: number): void {
  if (!tspProject) return;
  applyEditor();
  tspOpenFile = path;
  tspText.value = tspProject.files.get(path) ?? '';
  renderTsp();
  if (line) {
    const pos = offsetOf(tspText.value, line, column);
    tspText.focus();
    tspText.setSelectionRange(pos, pos);
    const lineHeight = parseFloat(getComputedStyle(tspText).lineHeight) || 18;
    tspText.scrollTop = Math.max(0, (line - 5) * lineHeight);
    updatePos();
  } else tspText.scrollTop = 0;
}

function updatePos(): void {
  const { line, column } = positionOf(tspText.value, tspText.selectionStart);
  $('tsp-pos').textContent = tspOpenFile ? `line ${line}, column ${column}${editorDirty() ? ' · not applied' : ''}` : '';
}

function setProject(p: ProjectData, handle: FileSystemDirectoryHandle | undefined): void {
  tspProject = p;
  tspHandle = handle;
  tspOpenFile = undefined;
  tspText.value = '';
  tspResult = undefined;
  tspDiags = [];
  tspStatus = `Opened ${esc(p.name)} with ${p.files.size} files.`;
  saveProject();
  if (handle) void kvSet(TSP_HANDLE_KEY, handle).catch(() => {});
  ($('tsp-entry') as HTMLSelectElement).value = '';
  const lang = $('tsp-lang') as HTMLSelectElement;
  lang.value = settings.source.language === 'de' && translationFile(p.files, 'de') ? 'de' : 'en';
  renderTsp();
  const entry = defaultEntry(p.files);
  if (entry) openTspFile(entry);
}

function download(name: string, data: Uint8Array | string, type: string): void {
  const blob = new Blob([data as BlobPart], { type });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

$('btn-tsp').addEventListener('click', () => {
  renderTsp();
  tspDialog.showModal();
  if (tspOpenFile === undefined && tspProject) {
    const entry = defaultEntry(tspProject.files);
    if (entry) openTspFile(entry);
  }
});
$('tsp-close').addEventListener('click', () => {
  applyEditor();
  tspDialog.close();
});
tspDialog.addEventListener('close', applyEditor);

const dirInput = $('tsp-dir') as HTMLInputElement;
$('tsp-open').addEventListener('click', async () => {
  if (tspProject?.changed.size && !confirm('Discard the changes in the current project?')) return;
  if (!canPickDirectory()) {
    dirInput.click();
    return;
  }
  try {
    const handle = await pickDirectory();
    tspStatus = 'Reading folder…';
    renderTsp();
    const files = await readDirectory(handle);
    setProject({ name: handle.name, files, changed: new Set() }, handle);
  } catch (err) {
    if ((err as Error).name !== 'AbortError') {
      tspStatus = `<span class="error-text">Could not open the folder: ${esc((err as Error).message)}</span>`;
      renderTsp();
    }
  }
});
dirInput.addEventListener('change', async () => {
  const list = dirInput.files;
  if (!list?.length) return;
  const { name, files } = await readFileList(list);
  dirInput.value = '';
  setProject({ name, files, changed: new Set() }, undefined);
});

$('tsp-files').addEventListener('click', (ev) => {
  const path = (ev.target as HTMLElement).closest<HTMLElement>('[data-file]')?.dataset.file;
  if (path) openTspFile(path);
});
$('tsp-filter').addEventListener('input', renderTsp);
$('tsp-diags').addEventListener('click', (ev) => {
  const i = Number((ev.target as HTMLElement).closest<HTMLElement>('[data-diag]')?.dataset.diag);
  const d = sortedDiagnostics(tspDiags)[i];
  if (d?.file && tspProject?.files.has(d.file)) openTspFile(d.file, d.line, d.column);
});
for (const ev of ['keyup', 'click', 'input']) tspText.addEventListener(ev, updatePos);
$('tsp-file-save').addEventListener('click', () => {
  applyEditor();
  updatePos();
  renderTsp();
});
$('tsp-file-revert').addEventListener('click', () => {
  if (tspProject && tspOpenFile) tspText.value = tspProject.files.get(tspOpenFile) ?? '';
  updatePos();
});

$('tsp-save').addEventListener('click', async () => {
  if (!tspProject || !tspHandle) return;
  applyEditor();
  try {
    if (!(await ensureWritable(tspHandle))) throw new Error('no permission to write to the folder');
    const n = await writeFiles(tspHandle, [...tspProject.changed].filter((p) => tspProject!.files.has(p)).map((p) => [p, tspProject!.files.get(p)!]));
    tspProject.changed.clear();
    saveProject();
    tspStatus = `Saved ${n} file${n === 1 ? '' : 's'} to ${esc(tspProject.name)}.`;
  } catch (err) {
    tspStatus = `<span class="error-text">Saving failed: ${esc((err as Error).message)}. Use "Download sources" instead.</span>`;
  }
  renderTsp();
});
$('tsp-zip').addEventListener('click', () => {
  if (!tspProject) return;
  applyEditor();
  download(`${tspProject.name}.zip`, createZip(tspProject.files), 'application/zip');
});
$('tsp-csv').addEventListener('click', () => {
  if (tspResult) download(`${tspProject?.name ?? 'typespec'}-csv.zip`, createZip(Object.entries(tspResult.csv)), 'application/zip');
});
$('tsp-use').addEventListener('change', (ev) => {
  tspUse = (ev.target as HTMLInputElement).checked;
  applyDefinitionFiles();
});

$('tsp-run').addEventListener('click', async () => {
  if (!tspProject || tspCompiling) return;
  applyEditor();
  const entry = ($('tsp-entry') as HTMLSelectElement).value || defaultEntry(tspProject.files);
  if (!entry) return;
  if (!(await compiler.available())) {
    tspStatus = '<span class="error-text">The TypeSpec compiler is not part of this build. Run <code>npm install</code> and <code>npm run build</code>.</span>';
    renderTsp();
    return;
  }
  const lang = ($('tsp-lang') as HTMLSelectElement).value;
  const translations = lang === 'en' ? undefined : translationFile(tspProject.files, lang);
  tspCompiling = true;
  tspStatus = `Compiling ${esc(entry)}…${tspResult ? '' : ' (loading the compiler the first time takes a moment)'}`;
  renderTsp();
  try {
    const req: Parameters<typeof compiler.compile>[0] = { files: Object.fromEntries(tspProject.files), entry };
    if (translations) req.translations = translations;
    tspResult = await compiler.compile(req);
    tspDiags = tspResult.diagnostics;
    const errors = tspDiags.filter((d) => d.severity === 'error').length;
    const csvCount = Object.keys(tspResult.csv).length;
    tspStatus =
      `Compiled in ${(tspResult.timeMs / 1000).toFixed(1)} s: ${csvCount} CSV file${csvCount === 1 ? '' : 's'}, ` +
      `<span class="${errors ? 'error-text' : ''}">${errors} error${errors === 1 ? '' : 's'}</span>, ${tspDiags.length - errors} warnings` +
      (tspResult.compilerVersion ? ` <span class="muted">(TypeSpec ${esc(tspResult.compilerVersion)})</span>` : '');
    if (csvCount) {
      tspCsv = tspResult.csv;
      tspCompiledEntry = entry;
      void kvSet(TSP_CSV_KEY, { entry, csv: tspCsv }).catch(() => {});
      applyDefinitionFiles();
    }
  } catch (err) {
    tspStatus = `<span class="error-text">Compiler failed: ${esc((err as Error).message.split('\n')[0] ?? '')}</span>`;
    console.error(err);
  } finally {
    tspCompiling = false;
    renderTsp();
  }
});

// TypeSpec for one decoded definition (TSP-3)
const tspViewDialog = $('tsp-view') as HTMLDialogElement;
let tspViewDefs: { name: string; text: string } | undefined;

function showTypeSpecView(def: import('./defs/definitions.ts').MessageDef, filePath: string): void {
  const path = filePath.replace(/^typespec:/, '');
  const manufacturer = path.includes('/') ? path.slice(0, path.indexOf('/')) : undefined;
  const text = writeTypeSpec([def], manufacturer ? { manufacturer } : {});
  tspViewDefs = { name: `${manufacturer ? `${manufacturer}/` : ''}${suggestFileName([def])}`, text };
  $('tsp-view-name').textContent = `${def.circuit}.${def.name}`;
  ($('tsp-view-text') as HTMLTextAreaElement).value = text;
  tspViewDialog.showModal();
}
$('tsp-view-close').addEventListener('click', () => tspViewDialog.close());
$('tsp-view-copy').addEventListener('click', () => {
  const ta = $('tsp-view-text') as HTMLTextAreaElement;
  void copyWithFeedback($('tsp-view-copy'), ta.value, ta);
});
$('tsp-view-add').addEventListener('click', () => {
  if (!tspViewDefs) return;
  if (!tspProject) setProject({ name: 'drafts', files: new Map(), changed: new Set() }, undefined);
  const p = tspProject!;
  let path = `drafts/${tspViewDefs.name.split('/').pop()}`;
  for (let i = 2; p.files.has(path); i++) path = path.replace(/(_\d+)?\.tsp$/, `_${i}.tsp`);
  p.files.set(path, tspViewDefs.text);
  p.changed.add(path);
  saveProject();
  tspViewDialog.close();
  ($('tsp-entry') as HTMLSelectElement).value = path;
  renderTsp();
  tspDialog.showModal();
  openTspFile(path);
});

// ---------------------------------------------------------------------------
// Definition assistant (M5, ASS-1..7)

const asDialog = $('assistant') as HTMLDialogElement;
let asDraft: Draft | undefined;
let asEntry: Entry | undefined;
let asSel: DraftSelection | undefined;
let asIssues: Issue[] = [];
let asDirty = false;

/** Circuit name for an address: from the loaded definition file of the device, else the scan ident. */
function circuitFor(address: number): string {
  for (const f of remoteFiles) {
    if (f.device !== address) continue;
    const info = parseFilename(f.path.split('/').pop() ?? '');
    if (info?.circuit) return info.circuit.toLowerCase();
  }
  const dev = capture.status.devices.find((d) => d.address === address);
  return defaultCircuit(dev?.deviceId, address);
}

function manufacturerFor(address: number): string | undefined {
  const dev = capture.status.devices.find((d) => d.address === address) ?? capture.status.devices.find((d) => d.manufacturer);
  const m = dev?.manufacturer.trim();
  return m && /^[A-Za-z]/.test(m) ? m.replace(/[^A-Za-z0-9]/g, '') : undefined;
}

function openAssistant(e: Entry): void {
  const saved = drafts.get(e.key);
  asEntry = e;
  asDraft = saved ? structuredClone(saved) : createDraft(e, { circuit: circuitFor, manufacturer: manufacturerFor });
  asDirty = false;
  asSel = undefined;
  $('as-telegram').textContent = `${hex2(e.source)} → ${hex2(e.target)} · ${hex2(e.pb)} ${hex2(e.sb)} ${e.id} · ${e.history.length} samples`;
  if (liveFor !== e.key) {
    liveLog = [];
    liveFor = e.key;
  }
  $('as-head').innerHTML = renderDraftHead(asDraft, e);
  renderAssistant(true);
  asDialog.showModal();
}

function draftState(): 'saved' | 'changed' | 'new' {
  if (!asDraft) return 'new';
  if (!drafts.get(asDraft.key)) return 'new';
  return asDirty ? 'changed' : 'saved';
}

/** Re-renders the assistant; the field editor only when `fields` (to keep the input focus while typing). */
function renderAssistant(fields: boolean): void {
  const d = asDraft;
  const e = asEntry;
  if (!d || !e) return;
  asIssues = validateDraft(d, e);
  $('as-bytes').innerHTML = renderDraftBytes(d, e, asSel);
  $('as-selection').innerHTML = renderDraftSelection(d, e, asSel);
  if (fields) $('as-fields').innerHTML = renderDraftFields(d, asIssues);
  else {
    const bad = new Set(asIssues.filter((i) => i.level === 'error' && i.field !== undefined).map((i) => i.field));
    $('as-fields').querySelectorAll('tbody tr').forEach((tr, i) => tr.classList.toggle('bad', bad.has(i)));
  }
  $('as-samples').innerHTML = renderDraftSamples(d, e);
  $('as-issues').innerHTML = renderIssues(asIssues, draftState());
  let preview: string;
  let csv = '';
  try {
    const def = draftDefinition(d);
    preview = writeTypeSpec([def], d.manufacturer ? { manufacturer: d.manufacturer } : {});
    csv = draftCsvLine(d);
  } catch (err) {
    preview = `// The draft cannot be converted yet:\n// ${err instanceof Error ? err.message : String(err)}`;
  }
  ($('as-preview') as HTMLTextAreaElement).value = preview;
  $('as-csv').textContent = csv;
  ($('as-delete') as HTMLButtonElement).disabled = !drafts.get(d.key);
  updateLiveButtons();
}

function changeDraft(fields = false): void {
  asDirty = true;
  if (asDraft) asDraft.updated = Date.now();
  renderAssistant(fields);
}

$('as-head').addEventListener('input', (ev) => {
  const el = ev.target as HTMLInputElement | HTMLSelectElement;
  const d = asDraft;
  if (!d || !asEntry || !el.dataset.draft) return;
  const v = el.value;
  switch (el.dataset.draft) {
    case 'name':
      d.name = v.trim();
      break;
    case 'circuit':
      d.circuit = v.trim();
      break;
    case 'manufacturer':
      if (v.trim()) d.manufacturer = v.trim();
      else delete d.manufacturer;
      break;
    case 'comment':
      if (v) d.comment = v;
      else delete d.comment;
      break;
    case 'direction':
      d.direction = v as Direction;
      break;
    case 'idlen': {
      const n = Number(v);
      if (!Number.isInteger(n) || n < 0) return;
      asDraft = { ...setIdLength(d, asEntry, n), fields: d.fields };
      if (asSel?.part === 'm' && asSel.from < asDraft.id.length) asSel = undefined;
      break;
    }
  }
  changeDraft(el.dataset.draft === 'idlen');
});

$('as-bytes').addEventListener('click', (ev) => {
  const el = (ev.target as HTMLElement).closest<HTMLElement>('[data-action="as-byte"]');
  if (!el) return;
  const part = el.dataset.p === 's' ? 's' : 'm';
  const i = Number(el.dataset.i);
  if ((ev as MouseEvent).shiftKey && asSel?.part === part) {
    asSel = { part, from: Math.min(asSel.from, i), to: Math.max(asSel.to, i) };
  } else if (asSel?.part === part && asSel.from === i && asSel.to === i) {
    asSel = undefined;
  } else asSel = { part, from: i, to: i };
  renderAssistant(false);
});

function addField(type: string, divisor?: number): void {
  const d = asDraft;
  if (!d || !asSel) return;
  const base = type.replace(/[^A-Za-z0-9]/g, '').toLowerCase();
  let name = `${asSel.part === 'm' ? 'd' : 'r'}${asSel.from}_${base}`;
  for (let n = 2; d.fields.some((f) => f.name === name); n++) name = `${asSel.part === 'm' ? 'd' : 'r'}${asSel.from}_${base}${n}`;
  const f: DraftField = { name, part: asSel.part, offset: asSel.from, type };
  if (divisor) f.divisor = divisor;
  d.fields.push(f);
  d.fields.sort((a, b) => (a.part === b.part ? a.offset - b.offset : a.part === 'm' ? -1 : 1));
  asSel = undefined;
  changeDraft(true);
  const idx = d.fields.indexOf(f);
  const input = $('as-fields').querySelector<HTMLInputElement>(`input[data-f="${idx}"][data-k="name"]`);
  input?.focus();
  input?.select();
}

$('as-selection').addEventListener('click', (ev) => {
  const el = (ev.target as HTMLElement).closest<HTMLElement>('[data-action]');
  if (!el) return;
  if (el.dataset.action === 'as-add') addField(el.dataset.type ?? 'UCH', el.dataset.divisor ? Number(el.dataset.divisor) : undefined);
  else if (el.dataset.action === 'as-add-manual') addField(($('as-type') as HTMLSelectElement).value);
});

$('as-fields').addEventListener('input', (ev) => {
  const el = ev.target as HTMLInputElement | HTMLSelectElement;
  const f = asDraft?.fields[Number(el.dataset.f)];
  const k = el.dataset.k as keyof DraftField | undefined;
  if (!f || !k) return;
  const v = el.value;
  if (k === 'divisor') {
    const n = Number(v);
    if (v.trim() && Number.isFinite(n) && n !== 0) f.divisor = n;
    else delete f.divisor;
  } else if (k === 'name' || k === 'type') f[k] = v.trim();
  else if (k === 'values' || k === 'unit' || k === 'comment') {
    if (v.trim()) f[k] = v.trim();
    else delete f[k];
  }
  changeDraft(k === 'type');
});
$('as-fields').addEventListener('click', (ev) => {
  const el = (ev.target as HTMLElement).closest<HTMLElement>('[data-action="as-remove"]');
  if (!el || !asDraft) return;
  asDraft.fields.splice(Number(el.dataset.f), 1);
  changeDraft(true);
});

$('as-save').addEventListener('click', () => {
  if (!asDraft) return;
  const errors = asIssues.filter((i) => i.level === 'error');
  if (errors.length && !confirm(`The draft has ${errors.length} error(s) and will not be used for decoding until they are fixed. Save anyway?`)) return;
  drafts.save(structuredClone(asDraft));
  asDirty = false;
  renderAssistant(false);
  detailEl.dataset.key = '';
});
$('as-delete').addEventListener('click', () => {
  if (!asDraft || !drafts.get(asDraft.key) || !confirm('Delete this draft?')) return;
  drafts.delete(asDraft.key);
  asDirty = true;
  renderAssistant(false);
  detailEl.dataset.key = '';
});
$('as-copy').addEventListener('click', () => {
  const ta = $('as-preview') as HTMLTextAreaElement;
  void copyWithFeedback($('as-copy'), ta.value, ta);
});
$('as-project').addEventListener('click', () => {
  if (!asDraft) return;
  if (asDirty || !drafts.get(asDraft.key)) drafts.save(structuredClone(asDraft));
  asDirty = false;
  const files = drafts.typeSpecFiles();
  if (!files.size) return alert('No draft can be converted yet; fix the errors first.');
  if (!tspProject) setProject({ name: 'drafts', files: new Map(), changed: new Set() }, undefined);
  const p = tspProject!;
  const foreign = [...files.keys()].filter((path) => p.files.has(path) && !p.files.get(path)!.startsWith(TSP_MARKER));
  if (foreign.length && !confirm(`Replace ${foreign.join(', ')}? ${foreign.length === 1 ? 'It was' : 'They were'} not written by the assistant.`)) return;
  let n = 0;
  for (const [path, text] of files) {
    if (p.files.get(path) === text) continue;
    p.files.set(path, text);
    p.changed.add(path);
    n++;
  }
  saveProject();
  const path = draftTspPath(asDraft.zz, asDraft.circuit);
  tspStatus = `Updated ${n} of ${files.size} assistant file${files.size === 1 ? '' : 's'} in the project${p.files.has('main.tsp') ? ' (not imported by main.tsp: compile the file as entry or add an import)' : ''}.`;
  asDialog.close();
  ($('tsp-entry') as HTMLSelectElement).value = files.has(path) ? path : '';
  renderTsp();
  tspDialog.showModal();
  if (files.has(path)) openTspFile(path);
});
$('as-close').addEventListener('click', () => {
  if (!asDirty || confirm('Discard the unsaved changes of the draft?')) asDialog.close();
});
asDialog.addEventListener('cancel', (ev) => {
  if (asDirty && !confirm('Discard the unsaved changes of the draft?')) ev.preventDefault();
});
asDialog.addEventListener('close', () => {
  asEntry = undefined;
  stopWatch();
  scheduleRender();
});

// ---------------------------------------------------------------------------
// Live test with ebusd (M6: CON-8, ASS-8)

let liveLog: LiveEntry[] = [];
let liveFor = '';
let liveBusy = false;
/** Message defined in ebusd whose value is followed with find. */
let watch: { key: string; draft: Draft; timer: ReturnType<typeof setInterval>; until: number } | undefined;

function addLive(entry: Omit<LiveEntry, 't'>): void {
  liveLog.push({ t: Date.now(), ...entry });
  if (liveLog.length > 50) liveLog.splice(0, liveLog.length - 50);
  $('as-live').innerHTML = renderLiveLog(liveLog);
}

/** Error entry for an ebusd answer, with an explanation if known. */
function liveError(text: string, command: string, answer: readonly string[]): Omit<LiveEntry, 't'> {
  const hint = explainError(answer[0] ?? '', command);
  return { state: 'bad', text, details: [answer.join(' ') || '(no answer)', ...(hint ? [hint] : [])], commands: [command] };
}

function updateLiveButtons(): void {
  const connected = client.state === 'connected';
  const d = asDraft;
  let valid = false;
  if (d) {
    try {
      draftDefinition(d);
      valid = d.fields.length > 0;
    } catch {
      valid = false;
    }
  }
  const why = !connected ? 'Not connected to ebusd' : !valid ? 'The draft has no valid fields yet' : '';
  const set = (name: string, extra: string) => {
    const b = document.querySelector<HTMLButtonElement>(`[data-live="${name}"]`);
    if (!b) return;
    const reason = why || extra;
    b.disabled = liveBusy || !!reason;
    b.dataset.title ??= b.title;
    b.title = reason || b.dataset.title;
  };
  const optIn = settings.liveCommands ? '' : 'Enable "Allow commands that send to the bus or change ebusd" in the settings';
  set('decode', '');
  set('define', optIn);
  set('read', optIn || (d ? (readProblem(d) ?? '') : ''));
}

async function liveCommand(command: string): Promise<string[]> {
  return client.command(command);
}

/** ebusd decodes the last distinct payloads with the draft; compare with the app (decode, no bus traffic). */
async function liveCompare(d: Draft, e: Entry): Promise<void> {
  const seen = new Set<string>();
  const samples = e.history.slice().reverse().filter((s) => {
    const k = `${s.master}/${s.slave}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  }).slice(0, 10);
  let compared = 0;
  const diffs: string[] = [];
  const commands: string[] = [];
  for (const s of samples) {
    for (const c of decodeChecks(d, e, s)) {
      const answer = await liveCommand(c.command);
      compared++;
      if (c.error ? !isError(answer) : answer.join('\n') !== c.expected) {
        if (isError(answer) && !c.error && /not found|blocked|not enabled/.test(answer[0]!)) {
          addLive(liveError('ebusd could not decode', c.command, answer));
          return;
        }
        diffs.push(`${timestamp(s.t)} ${c.part === 'm' ? 'data' : 'response'}: ebusd ${answer.join(' ')} · app ${c.expected}`);
        if (commands.length < 3) commands.push(c.command);
      }
    }
  }
  if (!compared) addLive({ state: 'warn', text: 'Nothing to compare: no payloads with data for the fields.' });
  else if (!diffs.length) addLive({ state: 'ok', text: `ebusd decodes ${samples.length} payload${samples.length === 1 ? '' : 's'} exactly like the app.` });
  else addLive({ state: 'bad', text: `ebusd decodes ${diffs.length} of ${compared} differently:`, details: diffs.slice(0, 5), commands });
}

async function liveDefine(d: Draft, e: Entry): Promise<void> {
  if (!confirm(`Add the draft ${d.circuit}.${d.name} to ebusd?\n\nebusd keeps it until it is restarted and then decodes these telegrams itself (other programs using ebusd, e.g. MQTT, see it too). Nothing is sent to the bus.`)) return;
  let command = defineCommand(d);
  let answer = await liveCommand(command);
  if (isError(answer) && /duplicate entry/.test(answer[0]!)) {
    if (!confirm(`ebusd already has a message with this command and ID (or the name ${d.circuit}.${d.name}).\n\nReplace it with the draft until ebusd restarts?`)) {
      addLive(liveError('Not defined', command, answer));
      return;
    }
    command = defineCommand(d, true);
    answer = await liveCommand(command);
  }
  if (isError(answer) || answer[0] !== 'done') {
    addLive(liveError('ebusd did not accept the draft', command, answer));
    return;
  }
  addLive({ state: 'ok', text: `Defined in ebusd as ${d.circuit}.${d.name}; following ebusd's value for 10 minutes…`, commands: [command] });
  startWatch(structuredClone(d), e);
}

function startWatch(d: Draft, e: Entry): void {
  stopWatch();
  const until = Date.now() + 10 * 60_000;
  const poll = async () => {
    if (!watch || Date.now() > watch.until || client.state !== 'connected') return stopWatch();
    const command = findCommand(d);
    const answer = await liveCommand(command).catch(() => [] as string[]);
    if (!watch) return;
    const found = parseFind(answer, d);
    const last = e.history.at(-1);
    const app = last ? decodeChecks(d, e, last).map((c) => c.expected).join(' / ') : '';
    const text = found.value !== undefined ? `ebusd: ${found.value}` : found.noData ? 'ebusd: no data yet (waiting for the telegram)' : `ebusd: ${answer.join(' ') || 'no answer'}`;
    const state: LiveEntry['state'] = found.value === undefined ? 'warn' : found.value === app ? 'ok' : 'info';
    // one line for the watched value, updated in place of the previous one
    liveLog = liveLog.filter((x) => x.commands?.[0] !== command);
    addLive({ state, text, details: [`app (latest payload): ${app}`], commands: [command] });
  };
  watch = { key: e.key, draft: d, until, timer: setInterval(() => void poll(), Math.max(3000, settings.pollIntervalMs)) };
  void poll();
}

function stopWatch(): void {
  if (watch) clearInterval(watch.timer);
  watch = undefined;
}

async function liveRead(d: Draft): Promise<void> {
  const command = readCommand(d);
  const tel = [d.zz, d.pb, d.sb, d.id.length, ...d.id].map(hex2).join(' ');
  if (!confirm(`ebusd will send this read request to the bus and decode the answer with the draft:\n\n${tel}\n\nOnly send requests that you have seen on the bus or know to be harmless. Send?`)) return;
  const answer = await liveCommand(command);
  if (isError(answer)) addLive(liveError('Reading failed', command, answer));
  else addLive({ state: 'ok', text: `Read from the bus: ${answer.join(' ')}`, commands: [command] });
}

document.querySelector('.as-live-head')!.addEventListener('click', (ev) => {
  const b = (ev.target as HTMLElement).closest<HTMLButtonElement>('[data-live]');
  const d = asDraft;
  const e = asEntry;
  if (!b || !d || !e || liveBusy) return;
  const run = b.dataset.live === 'decode' ? liveCompare(structuredClone(d), e) : b.dataset.live === 'define' ? liveDefine(structuredClone(d), e) : liveRead(structuredClone(d));
  liveBusy = true;
  updateLiveButtons();
  void run
    .catch((err: unknown) => addLive({ state: 'bad', text: err instanceof Error ? err.message : String(err) }))
    .finally(() => {
      liveBusy = false;
      updateLiveButtons();
    });
});
// ---------------------------------------------------------------------------
// ebusd's decoding hints (CON-5)

const ebusdHints = new Map<string, EbusdHints>();

async function fetchEbusdHints(e: Entry): Promise<void> {
  ebusdHints.set(e.key, { t: Date.now(), loading: true });
  detailEl.dataset.key = '';
  scheduleRender();
  let result: EbusdHints;
  try {
    const answer = await client.command('grab result decode');
    if (isError(answer)) result = { t: Date.now(), error: answer.join(' ') };
    else {
      const all = parseGrabDecode(answer);
      // the same telegram as the latest one captured, else the same message key
      const entry = all.find((x) => x.masterHex === e.lastMasterHex) ?? all.find((x) => messageKey(parseTelegram(x.masterHex, x.slaveHex)) === e.key);
      result = entry ? { t: Date.now(), entry } : { t: Date.now() };
    }
  } catch (err) {
    result = { t: Date.now(), error: err instanceof Error ? err.message : String(err) };
  }
  ebusdHints.set(e.key, result);
  detailEl.dataset.key = '';
  scheduleRender();
}

// ---------------------------------------------------------------------------
// Send a telegram with hex (M6: CON-7)

const hexDialog = $('hexsend') as HTMLDialogElement;
const hexInput = $('hex-input') as HTMLInputElement;
let hexLog: LiveEntry[] = [];

function checkHexInput(): ReturnType<typeof parseHexTelegram> {
  const r = parseHexTelegram(hexInput.value);
  $('hex-check').textContent = 'error' in r ? r.error : `To ${hex2(r.zz)}, command ${hex2(r.pb)} ${hex2(r.sb)}, ${r.data.length} data byte${r.data.length === 1 ? '' : 's'}${r.zz === 0xfe ? ' (broadcast)' : ''}.`;
  ($('hex-send') as HTMLButtonElement).disabled = 'error' in r || !settings.liveCommands || client.state !== 'connected';
  return r;
}

function openHexSend(e: Entry): void {
  const last = e.history.at(-1);
  hexInput.value = last ? hexOfSample(e, last).replace(/(..)(?!$)/g, '$1 ') : '';
  hexLog = [];
  $('hex-log').innerHTML = '';
  checkHexInput();
  hexDialog.showModal();
  hexInput.focus();
}

hexInput.addEventListener('input', () => void checkHexInput());
$('hex-close').addEventListener('click', () => hexDialog.close());
$('hex-send').addEventListener('click', () => {
  const r = checkHexInput();
  if ('error' in r) return;
  const spaced = r.hex.replace(/(..)(?!$)/g, '$1 ');
  if (!confirm(`Send this telegram to the bus?\n\n${spaced}\n\nIf it is a write command, it changes the device.`)) return;
  const command = `hex ${r.hex}`;
  ($('hex-send') as HTMLButtonElement).disabled = true;
  void client
    .command(command)
    .then((answer) => {
      const entry: LiveEntry = isError(answer)
        ? { t: Date.now(), ...liveError('Not sent', command, answer) }
        : { t: Date.now(), state: 'ok', text: `Answer: ${answer.join(' ')}`, commands: [command] };
      hexLog.push(entry);
    })
    .catch((err: unknown) => hexLog.push({ t: Date.now(), state: 'bad', text: err instanceof Error ? err.message : String(err), commands: [command] }))
    .finally(() => {
      $('hex-log').innerHTML = renderLiveLog(hexLog);
      checkHexInput();
    });
});

// ---------------------------------------------------------------------------
// Start

initSplitter(document.querySelector<HTMLElement>('.layout')!, $('splitter'), detailEl);

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

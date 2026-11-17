import { Capture } from './capture.ts';
import { EbusdClient } from './ebusd/client.ts';
import { parseGrabResult } from './ebusd/protocol.ts';
import { loadSettings, saveSettings } from './settings.ts';
import { kvGet, kvSet, throttle } from './store/persistence.ts';
import { TelegramStore } from './store/telegram-store.ts';
import {
  deviceLookup,
  renderCounts,
  renderDetail,
  renderDevices,
  renderRows,
  renderStatus,
} from './ui/render.ts';
import { applyView, type FilterMode, type SortMode, type ViewState } from './ui/view.ts';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const settings = loadSettings();
const store = new TelegramStore();
const client = new EbusdClient();
const capture = new Capture(client, store, settings.pollIntervalMs);

const view: ViewState = { filter: 'all', sort: 'count', search: '' };
let selectedKey: string | undefined;
let stateDetail: string | undefined;

// ---------------------------------------------------------------------------
// Rendering

let frame = 0;
function scheduleRender(): void {
  if (!frame) frame = requestAnimationFrame(render);
}

function render(): void {
  frame = 0;
  const name = deviceLookup(capture.status.devices);
  const all = store.entries();
  const shown = applyView(all, view, name);
  $('status').innerHTML = renderStatus(client.state, capture.status, stateDetail);
  $('devices').innerHTML = renderDevices(capture.status.devices);
  $('counts').innerHTML = renderCounts(all, shown.length);
  $('rows').innerHTML = renderRows(shown, name, selectedKey);
  const detail = $('detail');
  const entry = selectedKey ? store.get(selectedKey) : undefined;
  detail.hidden = !entry;
  detail.innerHTML = renderDetail(entry, name);
  $('btn-connect').textContent = client.state === 'disconnected' ? 'Connect' : 'Disconnect';
}

store.onChange(scheduleRender);
capture.onChange(scheduleRender);
client.onStateChange((_state, detail) => {
  stateDetail = detail;
  scheduleRender();
});
setInterval(scheduleRender, 5000); // keep "last seen" fresh

// ---------------------------------------------------------------------------
// Persistence (ARCH-6)

const CAPTURE_KEY = 'capture';
const autosave = throttle(() => void kvSet(CAPTURE_KEY, store.toJSON()).catch(console.error), 3000);

async function restore(): Promise<void> {
  try {
    const saved = await kvGet(CAPTURE_KEY);
    if (saved) store.load(saved);
  } catch (err) {
    console.warn('could not restore capture', err);
  }
  store.onChange(autosave);
}

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
  const blob = new Blob([JSON.stringify(store.toJSON(), null, 1)], { type: 'application/json' });
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
      store.load(JSON.parse(text));
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
  scheduleRender();
});

$('detail').addEventListener('click', (ev) => {
  const action = (ev.target as HTMLElement).closest<HTMLElement>('[data-action]')?.dataset.action;
  const entry = selectedKey ? store.get(selectedKey) : undefined;
  if (action === 'close-detail') selectedKey = undefined;
  else if (action === 'mark-seen' && entry) store.markSeen(entry.key);
  else if (action === 'copy' && entry) {
    const text = entry.lastMasterHex + (entry.lastSlaveHex ? ` / ${entry.lastSlaveHex}` : '');
    void navigator.clipboard?.writeText(text);
  }
  scheduleRender();
});

document.addEventListener('keydown', (ev) => {
  if (ev.key === 'Escape' && selectedKey && !dialog.open) {
    selectedKey = undefined;
    scheduleRender();
  }
});

// ---------------------------------------------------------------------------
// Start

void restore().then(() => {
  render();
  // Connect automatically when the app is served by the bridge itself.
  try {
    if (new URL(settings.bridgeUrl).host === location.host) connect();
  } catch {
    // invalid URL in settings; user can fix it in the dialog
  }
});

import { isMaster, slaveOfMaster } from '../ebus/address.ts';
import type { CaptureStatus } from '../capture.ts';
import type { ConnectionState } from '../ebusd/client.ts';
import type { ScanDevice } from '../ebusd/protocol.ts';
import type { Entry } from '../store/telegram-store.ts';
import { ago, bytesHtml, dateTime, duration, esc, hex2, timestamp, varyingBytes } from './format.ts';

/** Resolves a bus address to a device name using the scan result (master → its slave). */
export function deviceLookup(devices: readonly ScanDevice[]): (addr: number) => string | undefined {
  const bySlave = new Map(devices.map((d) => [d.address, d.deviceId || d.manufacturer]));
  return (addr) => {
    if (addr === 0xfe) return 'broadcast';
    const slave = isMaster(addr) ? slaveOfMaster(addr) : addr;
    return slave === undefined ? undefined : bySlave.get(slave);
  };
}

const STATE_TEXT: Record<ConnectionState, string> = {
  disconnected: 'Disconnected',
  connecting: 'Connecting…',
  connected: 'Connected',
  reconnecting: 'Reconnecting…',
};

export function renderStatus(state: ConnectionState, capture: CaptureStatus, detail?: string): string {
  const parts = [`<span class="dot ${state}"></span><span>${STATE_TEXT[state]}</span>`];
  if (state === 'connected' && capture.ebusdVersion) parts.push(`<span class="muted">${esc(capture.ebusdVersion)}</span>`);
  if (state === 'connected' && capture.lastPoll) parts.push(`<span class="muted">polled ${timestamp(capture.lastPoll)}</span>`);
  const err = capture.lastError ?? (state === 'reconnecting' ? detail : undefined);
  if (err) parts.push(`<span class="error" title="${esc(err)}">${esc(err)}</span>`);
  return parts.join('');
}

export function renderDevices(devices: readonly ScanDevice[]): string {
  if (!devices.length) return '';
  return devices
    .map(
      (d) =>
        `<span class="device" title="${esc(d.manufacturer)} ${esc(d.deviceId)} SW ${esc(d.sw)} HW ${esc(d.hw)}">` +
        `<b>${hex2(d.address)}</b> ${esc(d.manufacturer)} ${esc(d.deviceId)} <span class="muted">SW${esc(d.sw)} HW${esc(d.hw)}</span></span>`,
    )
    .join('');
}

export function renderCounts(all: readonly Entry[], shown: number): string {
  const newCount = all.filter((e) => e.isNew).length;
  const unknown = all.filter((e) => e.known === false).length;
  return `${shown} of ${all.length} messages · <span class="new-text">${newCount} new</span> · ${unknown} unknown`;
}

function knownBadge(e: Entry): string {
  if (e.known === true) return '<span class="tag known">known</span>';
  if (e.known === false) return '<span class="tag unknown">unknown</span>';
  return '<span class="tag">?</span>';
}

function addressCell(addr: number, name: (a: number) => string | undefined): string {
  const n = name(addr);
  return `<span class="mono">${hex2(addr)}</span>${n ? ` <span class="muted small">${esc(n)}</span>` : ''}`;
}

export function renderRows(
  entries: readonly Entry[],
  name: (a: number) => string | undefined,
  selectedKey: string | undefined,
  now = Date.now(),
): string {
  if (!entries.length) {
    return '<tr class="empty"><td colspan="9">No telegrams yet. Connect to ebusd or import a capture.</td></tr>';
  }
  return entries
    .map((e) => {
      const varMaster = varyingBytes(e.history.map((s) => s.master));
      const varSlave = varyingBytes(e.history.map((s) => s.slave));
      const last = e.history.at(-1);
      const cls = [e.isNew ? 'is-new' : '', e.key === selectedKey ? 'selected' : '', e.known ? 'is-known' : '']
        .filter(Boolean)
        .join(' ');
      return (
        `<tr data-key="${esc(e.key)}" class="${cls}">` +
        `<td class="c-status">${e.isNew ? '<span class="tag new">new</span>' : ''}${knownBadge(e)}</td>` +
        `<td class="c-src" data-label="From">${addressCell(e.source, name)}</td>` +
        `<td class="c-dst" data-label="To">${addressCell(e.target, name)}</td>` +
        `<td class="c-cmd mono" data-label="PB SB">${hex2(e.pb)} ${hex2(e.sb)}</td>` +
        `<td class="c-id mono" data-label="ID">${e.id ? esc(e.id) : '<span class="none">–</span>'}</td>` +
        `<td class="c-data mono" data-label="Data">${bytesHtml(last?.master ?? '', varMaster)}</td>` +
        `<td class="c-slave mono" data-label="Response">${e.kind === 'master-slave' ? bytesHtml(last?.slave ?? '', varSlave) : '<span class="none">–</span>'}</td>` +
        `<td class="c-num" data-label="Count">${e.count}<span class="muted small"> · ${duration(e.intervalMs)}</span></td>` +
        `<td class="c-num" data-label="Last seen" title="${esc(dateTime(e.lastSeen))}">${ago(e.lastSeen, now)}</td>` +
        `</tr>`
      );
    })
    .join('');
}

export function renderDetail(e: Entry | undefined, name: (a: number) => string | undefined): string {
  if (!e) return '<p class="muted">Select a message to see its history.</p>';
  const varMaster = varyingBytes(e.history.map((s) => s.master));
  const varSlave = varyingBytes(e.history.map((s) => s.slave));
  const rows = [...e.history]
    .reverse()
    .map((s, i, arr) => {
      const prev = arr[i + 1];
      const changedMaster = prev ? diffIndices(prev.master, s.master) : new Set<number>();
      const changedSlave = prev ? diffIndices(prev.slave, s.slave) : new Set<number>();
      return (
        `<tr><td class="mono small">${timestamp(s.t)}</td>` +
        `<td class="mono">${bytesHtml(s.master, changedMaster, 'chg')}</td>` +
        `<td class="mono">${e.kind === 'master-slave' ? bytesHtml(s.slave, changedSlave, 'chg') : ''}</td></tr>`
      );
    })
    .join('');
  const src = name(e.source);
  const dst = name(e.target);
  return `
    <div class="detail-head">
      <h2 class="mono">${hex2(e.source)} → ${hex2(e.target)} · ${hex2(e.pb)} ${hex2(e.sb)} ${esc(e.id)}</h2>
      <button type="button" class="icon" data-action="close-detail" aria-label="Close">×</button>
    </div>
    <dl class="facts">
      <dt>Type</dt><dd>${esc(e.kind)}</dd>
      <dt>From</dt><dd>${hex2(e.source)}${src ? ` (${esc(src)})` : ''}</dd>
      <dt>To</dt><dd>${hex2(e.target)}${dst ? ` (${esc(dst)})` : ''}</dd>
      <dt>Status</dt><dd>${knownBadge(e)}${e.isNew ? ' <span class="tag new">new</span>' : ''}${e.lengthMismatch ? ' <span class="tag warn">length mismatch</span>' : ''}</dd>
      ${e.info ? `<dt>ebusd</dt><dd>${esc(e.info)}</dd>` : ''}
      <dt>Count</dt><dd>${e.count}${e.intervalMs !== undefined ? ` · every ~${duration(e.intervalMs)}` : ''}</dd>
      <dt>First seen</dt><dd>${dateTime(e.firstSeen)}</dd>
      <dt>Last change</dt><dd>${dateTime(e.lastChanged)}</dd>
      <dt>Telegram</dt><dd class="mono wrap">${esc(e.lastMasterHex)}${e.lastSlaveHex ? ` / ${esc(e.lastSlaveHex)}` : ''}</dd>
    </dl>
    <div class="detail-actions">
      ${e.isNew ? '<button type="button" data-action="mark-seen">Mark as seen</button>' : ''}
      <button type="button" data-action="copy">Copy telegram</button>
    </div>
    <h3>Varying bytes</h3>
    <p class="mono">${bytesHtml(e.history.at(-1)?.master ?? '', varMaster)}${e.kind === 'master-slave' ? ` / ${bytesHtml(e.history.at(-1)?.slave ?? '', varSlave)}` : ''}</p>
    <h3>History <span class="muted small">(${e.history.length} distinct payloads, newest first, changed bytes marked)</span></h3>
    <table class="history"><thead><tr><th>Time</th><th>Data</th><th>Response</th></tr></thead><tbody>${rows}</tbody></table>`;
}

function diffIndices(a: string, b: string): Set<number> {
  const out = new Set<number>();
  const len = Math.max(a.length, b.length) / 2;
  for (let i = 0; i < len; i++) if (a.slice(i * 2, i * 2 + 2) !== b.slice(i * 2, i * 2 + 2)) out.add(i);
  return out;
}

import { isMaster, slaveOfMaster } from '../ebus/address.ts';
import type { CaptureStatus } from '../capture.ts';
import type { ConnectionState } from '../ebusd/client.ts';
import type { ScanDevice } from '../ebusd/protocol.ts';
import type { Decoded } from '../defs/repository.ts';
import type { DecodedField } from '../defs/fields.ts';
import type { LoadReport } from '../defs/loader.ts';
import type { Telegram } from '../ebus/telegram.ts';
import type { Entry } from '../store/telegram-store.ts';
import { ago, bytesHtml, dateTime, duration, esc, hex2, timestamp, varyingBytes } from './format.ts';
import { isKnown, type ViewContext } from './view.ts';

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

// ---------------------------------------------------------------------------
// Definitions

export type DefinitionsState =
  | { state: 'none' }
  | { state: 'loading' }
  | { state: 'ready'; report: LoadReport; messages: number; at: number }
  | { state: 'error'; error: string };

export function renderDevices(devices: readonly ScanDevice[], defs: DefinitionsState, localFiles: number): string {
  const chips = devices.map(
    (d) =>
      `<span class="device" title="${esc(d.manufacturer)} ${esc(d.deviceId)} SW ${esc(d.sw)} HW ${esc(d.hw)}">` +
      `<b>${hex2(d.address)}</b> ${esc(d.manufacturer)} ${esc(d.deviceId)} <span class="muted">SW${esc(d.sw)} HW${esc(d.hw)}</span></span>`,
  );
  let text: string;
  let cls = '';
  switch (defs.state) {
    case 'none':
      text = devices.length || localFiles ? 'Definitions: not loaded' : 'Definitions: waiting for devices';
      break;
    case 'loading':
      text = 'Definitions: loading…';
      break;
    case 'ready': {
      const files = defs.report.files.length;
      text = `Definitions: ${files} file${files === 1 ? '' : 's'} · ${defs.messages} messages`;
      if (defs.report.offline) text += ' (cached)';
      if (defs.report.unmatched.length || defs.report.errors.length) cls = ' warn';
      break;
    }
    case 'error':
      text = 'Definitions: failed to load';
      cls = ' warn';
      break;
  }
  chips.push(`<button type="button" class="device defs${cls}" data-action="definitions">${esc(text)}</button>`);
  return chips.join('');
}

export function renderDefinitionsReport(defs: DefinitionsState, localNames: readonly string[]): string {
  const parts: string[] = [];
  if (defs.state === 'loading') parts.push('<p class="muted">Loading…</p>');
  if (defs.state === 'error') parts.push(`<p class="error-text">${esc(defs.error)}</p>`);
  if (defs.state === 'none') parts.push('<p class="muted">No definitions loaded yet. They are loaded automatically once ebusd reports the devices on the bus (scan result).</p>');
  if (defs.state === 'ready') {
    const r = defs.report;
    parts.push(`<p class="small muted">Loaded ${dateTime(defs.at)}${r.offline ? ' from the local cache (network unavailable)' : ''}.</p>`);
    const rows = r.files
      .map((f) => {
        const name = f.url ? `<a href="${esc(f.url)}" target="_blank" rel="noopener">${esc(f.path)}</a>` : esc(f.path);
        const src = f.sourceUrl ? ` · <a href="${esc(f.sourceUrl)}" target="_blank" rel="noopener">TypeSpec</a>` : '';
        const who = f.local ? '<span class="tag">local</span>' : f.device !== undefined ? `<span class="mono">${hex2(f.device)}</span>` : '<span class="muted">common</span>';
        const errs = f.parsed.errors.length ? ` <span class="tag warn" title="${esc(f.parsed.errors.slice(0, 5).map((e) => `${e.line}: ${e.message}`).join('\n'))}">${f.parsed.errors.length} errors</span>` : '';
        return `<tr><td>${who}</td><td>${name}${src}${f.loadedBy ? ` <span class="muted small">via ${esc(f.loadedBy)}</span>` : ''}${errs}</td><td class="c-num">${f.parsed.messages.length}</td></tr>`;
      })
      .join('');
    parts.push(`<table class="defs-files"><thead><tr><th>Device</th><th>File</th><th class="c-num">Messages</th></tr></thead><tbody>${rows}</tbody></table>`);
    if (r.unmatched.length) {
      parts.push(`<p class="warn-text">No definition file for: ${r.unmatched.map((d) => `${hex2(d.address)} ${esc(d.manufacturer)} ${esc(d.deviceId)}`).join(', ')}</p>`);
    }
    if (r.errors.length) parts.push(`<details><summary>${r.errors.length} problems</summary><pre class="small">${esc(r.errors.join('\n'))}</pre></details>`);
  }
  if (localNames.length) parts.push(`<p class="small">Local files (take precedence): ${localNames.map(esc).join(', ')}</p>`);
  return parts.join('');
}

// ---------------------------------------------------------------------------
// Telegram list

export function renderCounts(all: readonly Entry[], shown: number, ctx: ViewContext): string {
  const newCount = all.filter((e) => e.isNew).length;
  const unknown = all.filter((e) => isKnown(e, ctx) === false).length;
  const decoded = ctx.definitionsLoaded ? ` · ${all.length - unknown} decoded` : '';
  return `${shown} of ${all.length} messages · <span class="new-text">${newCount} new</span> · ${unknown} unknown${decoded}`;
}

function knownBadge(e: Entry, ctx: ViewContext): string {
  const known = isKnown(e, ctx);
  const ebusd = e.known === undefined ? '' : ` title="ebusd: ${e.known ? 'known' : 'unknown'}"`;
  if (known === true) return `<span class="tag known"${ebusd}>${ctx.definitionsLoaded ? 'decoded' : 'known'}</span>`;
  if (known === false) return `<span class="tag unknown"${ebusd}>unknown</span>`;
  return '<span class="tag">?</span>';
}

function addressCell(addr: number, name: (a: number) => string | undefined): string {
  const n = name(addr);
  return `<span class="mono">${hex2(addr)}</span>${n ? ` <span class="muted small">${esc(n)}</span>` : ''}`;
}

/** Short value summary: "name=value unit; ..." of the first visible fields. */
export function fieldSummary(fields: readonly DecodedField[], max = 3): string {
  const visible = fields.filter((f) => !f.ignored && !f.constant);
  const parts = visible.slice(0, max).map((f) => `${f.name ? `${f.name}=` : ''}${f.text}${f.unit ? ` ${f.unit}` : ''}`);
  if (visible.length > max) parts.push('…');
  return parts.join('; ');
}

function messageCell(d: Decoded | undefined): string {
  if (!d) return '<span class="none">–</span>';
  const name = `<b>${esc(d.def.circuit)}.${esc(d.def.name)}</b>`;
  let detail: string;
  if (d.chain && !d.chain.complete) detail = `<span class="muted">part ${d.chain.index + 1}/${d.chain.count}, waiting for other parts</span>`;
  else if (d.result.error) detail = `<span class="warn-text">${esc(d.result.error)}</span>`;
  else detail = `<span class="muted">${esc(fieldSummary(d.result.fields))}</span>`;
  return `${name}<br><span class="small">${detail}</span>`;
}

export function renderRows(
  entries: readonly Entry[],
  ctx: ViewContext,
  selectedKey: string | undefined,
  now = Date.now(),
): string {
  const name = ctx.deviceName ?? (() => undefined);
  if (!entries.length) {
    return '<tr class="empty"><td colspan="10">No telegrams yet. Connect to ebusd or import a capture.</td></tr>';
  }
  return entries
    .map((e) => {
      const varMaster = varyingBytes(e.history.map((s) => s.master));
      const varSlave = varyingBytes(e.history.map((s) => s.slave));
      const last = e.history.at(-1);
      const known = isKnown(e, ctx);
      const cls = [e.isNew ? 'is-new' : '', e.key === selectedKey ? 'selected' : '', known ? 'is-known' : '']
        .filter(Boolean)
        .join(' ');
      return (
        `<tr data-key="${esc(e.key)}" class="${cls}">` +
        `<td class="c-status">${e.isNew ? '<span class="tag new">new</span>' : ''}${knownBadge(e, ctx)}</td>` +
        `<td class="c-src" data-label="From">${addressCell(e.source, name)}</td>` +
        `<td class="c-dst" data-label="To">${addressCell(e.target, name)}</td>` +
        `<td class="c-cmd mono" data-label="PB SB">${hex2(e.pb)} ${hex2(e.sb)}</td>` +
        `<td class="c-id mono" data-label="ID">${e.id ? esc(e.id) : '<span class="none">–</span>'}</td>` +
        `<td class="c-msg" data-label="Message">${messageCell(ctx.decoded?.(e))}</td>` +
        `<td class="c-data mono" data-label="Data">${bytesHtml(last?.master ?? '', varMaster)}</td>` +
        `<td class="c-slave mono" data-label="Response">${e.kind === 'master-slave' ? bytesHtml(last?.slave ?? '', varSlave) : '<span class="none">–</span>'}</td>` +
        `<td class="c-num" data-label="Count">${e.count}<span class="muted small"> · ${duration(e.intervalMs)}</span></td>` +
        `<td class="c-num" data-label="Last seen" title="${esc(dateTime(e.lastSeen))}">${ago(e.lastSeen, now)}</td>` +
        `</tr>`
      );
    })
    .join('');
}

// ---------------------------------------------------------------------------
// Detail panel

/** Telegram bytes as spans; data bytes carry data-p (part) and data-i (index after NN). */
export function telegramHtml(t: Telegram): string {
  const hdr = (b: number, title: string) => `<span class="b hdr" title="${title}">${hex2(b)}</span>`;
  const data = (bytes: Uint8Array, part: 'm' | 's') =>
    Array.from(bytes, (b, i) => `<span class="b" data-p="${part}" data-i="${i}">${hex2(b)}</span>`).join('');
  let html =
    hdr(t.source, 'QQ source') + hdr(t.target, 'ZZ target') + hdr(t.pb, 'PB') + hdr(t.sb, 'SB') + hdr(t.masterData.length, 'NN length') + data(t.masterData, 'm');
  if (t.slaveData) html += ` <span class="sep">/</span> ${hdr(t.slaveData.length, 'NN length')}${data(t.slaveData, 's')}`;
  return html;
}

function fieldBytes(t: Telegram, f: DecodedField): string {
  const src = f.part === 'm' ? t.masterData : t.slaveData;
  if (!src) return '';
  return Array.from(src.subarray(f.offset, f.offset + f.length), hex2).join(' ');
}

const TYPE_TEXT: Record<string, string> = { r: 'read', w: 'write', u: 'passive', uw: 'passive write' };
const CONDITION_TEXT: Record<string, string> = { none: '', true: 'conditions met', unknown: 'conditions unknown', false: 'conditions not met' };

function renderDecoded(d: Decoded, t: Telegram | undefined): string {
  const def = d.def;
  const source = d.file.url
    ? `<a href="${esc(d.file.url)}" target="_blank" rel="noopener">${esc(d.file.path)}:${def.line}</a>`
    : `${esc(d.file.path)}:${def.line}`;
  const tsp = d.file.sourceUrl ? ` · <a href="${esc(d.file.sourceUrl)}" target="_blank" rel="noopener">TypeSpec</a>` : '';
  const facts = [
    `<span class="tag">${esc(TYPE_TEXT[def.type] ?? def.type)}</span>`,
    d.file.local ? '<span class="tag">local</span>' : '',
    CONDITION_TEXT[d.condition] ? `<span class="tag${d.condition === 'unknown' ? ' unknown' : ''}">${CONDITION_TEXT[d.condition]}</span>` : '',
    d.alternatives ? `<span class="muted small">${d.alternatives} other definition${d.alternatives === 1 ? '' : 's'} match</span>` : '',
  ]
    .filter(Boolean)
    .join(' ');
  let body: string;
  if (d.chain && !d.chain.complete) {
    body = `<p class="muted">Chained message: this is part ${d.chain.index + 1} of ${d.chain.count}. The values are decoded once all parts have been captured.</p>`;
  } else {
    const rows = d.result.fields
      .map(
        (f) =>
          `<tr class="field${f.ignored ? ' ignored' : ''}${f.error ? ' bad' : ''}" data-p="${f.part}" data-from="${f.offset}" data-len="${f.length}">` +
          `<td>${esc(f.name || '–')}</td>` +
          `<td>${f.ignored ? '<span class="muted">ignored</span>' : f.error ? `<span class="warn-text">${esc(f.error)}</span>` : `<b>${esc(f.text)}</b>${f.unit ? ` ${esc(f.unit)}` : ''}`}</td>` +
          `<td class="mono small">${t ? esc(fieldBytes(t, f)) : ''}${f.bits ? ` <span class="muted">bit ${f.bits.first}${f.bits.count > 1 ? `+${f.bits.count}` : ''}</span>` : ''}</td>` +
          `<td class="muted small">${esc(f.def.typeName)}${f.def.divisorValues && !f.def.values ? ` ${esc(f.def.divisorValues)}` : ''}</td>` +
          `<td class="small">${esc(f.comment ?? '')}</td></tr>`,
      )
      .join('');
    body =
      `<table class="fields"><thead><tr><th>Field</th><th>Value</th><th>Bytes</th><th>Type</th><th>Comment</th></tr></thead><tbody>${rows}</tbody></table>` +
      (d.result.error ? `<p class="warn-text small">${esc(d.result.error)}</p>` : '') +
      (d.result.extra ? `<p class="muted small">Not covered by the definition: ${d.result.extra.m ? `${d.result.extra.m} master byte(s) ` : ''}${d.result.extra.s ? `${d.result.extra.s} response byte(s)` : ''}</p>` : '');
  }
  return `
    <h3>${esc(def.circuit)}.${esc(def.name)}</h3>
    ${def.comment ? `<p class="small">${esc(def.comment)}</p>` : ''}
    <p class="small">${facts}</p>
    <p class="small muted">Definition: ${source}${tsp}</p>
    ${body}`;
}

export interface DetailContext extends ViewContext {
  telegram?: (e: Entry) => Telegram | undefined;
  decodeSample?: (e: Entry, i: number) => Decoded | undefined;
}

export function renderDetail(e: Entry | undefined, ctx: DetailContext): string {
  if (!e) return '<p class="muted">Select a message to see its history.</p>';
  const name = ctx.deviceName ?? (() => undefined);
  const varMaster = varyingBytes(e.history.map((s) => s.master));
  const varSlave = varyingBytes(e.history.map((s) => s.slave));
  const decoded = ctx.decoded?.(e);
  const t = ctx.telegram?.(e);
  const showDecoded = !!decoded && !(decoded.chain && !decoded.chain.complete);
  const rows = e.history
    .map((s, i) => ({ s, i }))
    .reverse()
    .map(({ s, i }, n, arr) => {
      const prev = arr[n + 1]?.s;
      const changedMaster = prev ? diffIndices(prev.master, s.master) : new Set<number>();
      const changedSlave = prev ? diffIndices(prev.slave, s.slave) : new Set<number>();
      const dec = showDecoded ? ctx.decodeSample?.(e, i) : undefined;
      return (
        `<tr><td class="mono small">${timestamp(s.t)}</td>` +
        `<td class="mono">${bytesHtml(s.master, changedMaster, 'chg')}</td>` +
        `<td class="mono">${e.kind === 'master-slave' ? bytesHtml(s.slave, changedSlave, 'chg') : ''}</td>` +
        (showDecoded ? `<td class="small">${dec && !dec.result.error ? esc(fieldSummary(dec.result.fields, 4)) : ''}</td>` : '') +
        `</tr>`
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
    ${t ? `<p class="telegram mono">${telegramHtml(t)}</p>` : ''}
    ${decoded ? renderDecoded(decoded, t) : ctx.definitionsLoaded ? '<p class="muted">No definition matches this message.</p>' : ''}
    <dl class="facts">
      <dt>Type</dt><dd>${esc(e.kind)}</dd>
      <dt>From</dt><dd>${hex2(e.source)}${src ? ` (${esc(src)})` : ''}</dd>
      <dt>To</dt><dd>${hex2(e.target)}${dst ? ` (${esc(dst)})` : ''}</dd>
      <dt>Status</dt><dd>${knownBadge(e, ctx)}${e.isNew ? ' <span class="tag new">new</span>' : ''}${e.lengthMismatch ? ' <span class="tag warn">length mismatch</span>' : ''}${e.known !== undefined ? ` <span class="muted small">ebusd: ${e.known ? 'known' : 'unknown'}</span>` : ''}</dd>
      ${e.info ? `<dt>ebusd</dt><dd>${esc(e.info)}</dd>` : ''}
      <dt>Count</dt><dd>${e.count}${e.intervalMs !== undefined ? ` · every ~${duration(e.intervalMs)}` : ''}</dd>
      <dt>First seen</dt><dd>${dateTime(e.firstSeen)}</dd>
      <dt>Last change</dt><dd>${dateTime(e.lastChanged)}</dd>
    </dl>
    <div class="detail-actions">
      ${e.isNew ? '<button type="button" data-action="mark-seen">Mark as seen</button>' : ''}
      <button type="button" data-action="copy">Copy telegram</button>
    </div>
    <h3>Varying bytes</h3>
    <p class="mono">${bytesHtml(e.history.at(-1)?.master ?? '', varMaster)}${e.kind === 'master-slave' ? ` / ${bytesHtml(e.history.at(-1)?.slave ?? '', varSlave)}` : ''}</p>
    <h3>History <span class="muted small">(${e.history.length} distinct payloads, newest first, changed bytes marked)</span></h3>
    <table class="history"><thead><tr><th>Time</th><th>Data</th><th>Response</th>${showDecoded ? '<th>Decoded</th>' : ''}</tr></thead><tbody>${rows}</tbody></table>`;
}

function diffIndices(a: string, b: string): Set<number> {
  const out = new Set<number>();
  const len = Math.max(a.length, b.length) / 2;
  for (let i = 0; i < len; i++) if (a.slice(i * 2, i * 2 + 2) !== b.slice(i * 2, i * 2 + 2)) out.add(i);
  return out;
}

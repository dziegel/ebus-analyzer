// Detail panel parts for M3: byte map with candidate types, notes and tags,
// value search results.

import { bitPattern, byteStats, heatLevel, type ByteStat } from '../analysis/bytes.ts';
import { CANDIDATE_TYPES, decodeCandidate } from '../analysis/candidates.ts';
import type { SearchHit } from '../analysis/search.ts';
import { seriesId } from '../analysis/series.ts';
import { hexToBytes } from '../ebus/hex.ts';
import type { Annotation } from '../store/annotations.ts';
import type { Entry } from '../store/telegram-store.ts';
import { esc, hex2, timestamp } from './format.ts';

export interface ByteSelection {
  key: string;
  part: 'm' | 's';
  offset: number;
}

function cellTitle(s: ByteStat): string {
  if (s.distinct <= 1) return `byte ${s.index}: constant ${s.latest !== undefined ? hex2(s.latest) : ''}`;
  return `byte ${s.index}: ${s.distinct} values, ${hex2(s.min)}..${hex2(s.max)} (${s.min}..${s.max}), ${s.changes} changes, bits ${bitPattern(s.changedBits)}`;
}

function byteMap(e: Entry, part: 'm' | 's', selection: ByteSelection | undefined): string {
  const prefix = part === 'm' ? hexToBytes(e.id) : new Uint8Array(0);
  const stats = byteStats(e.history, part, prefix).slice(prefix.length);
  if (!stats.length) return '<span class="none">–</span>';
  return `<div class="bytemap">${stats
    .map((s) => {
      const sel = selection?.key === e.key && selection.part === part && selection.offset === s.index ? ' selected' : '';
      return (
        `<button type="button" class="cell h${heatLevel(s)}${sel}" data-action="select-byte" data-p="${part}" data-i="${s.index}" title="${esc(cellTitle(s))}">` +
        `<span class="idx">${s.index}</span><span class="val">${s.latest !== undefined ? hex2(s.latest) : '··'}</span>` +
        (s.changedBits && s.distinct > 1 ? `<span class="bits">${bitPattern(s.changedBits)}</span>` : '') +
        `</button>`
      );
    })
    .join('')}</div>`;
}

/** Values of each candidate type at the selected offset: latest, range over history. */
function candidates(e: Entry, sel: ByteSelection, charted: ReadonlySet<string>): string {
  const datas = e.history.map((s) => (sel.part === 'm' ? hexToBytes(e.id + s.master) : hexToBytes(s.slave)));
  const latest = datas.at(-1);
  if (!latest) return '';
  const rows = CANDIDATE_TYPES.map((c) => {
    const now = decodeCandidate(c, latest, sel.offset);
    if (!now) return '';
    const values = datas.map((d) => decodeCandidate(c, d, sel.offset)?.value).filter((v): v is number => v !== undefined);
    const lo = values.length ? Math.min(...values) : undefined;
    const hi = values.length ? Math.max(...values) : undefined;
    const id = seriesId({ kind: 'bytes', key: e.key, part: sel.part, offset: sel.offset, type: c.name });
    const range = lo === undefined ? '–' : lo === hi ? 'constant' : `${round(lo)} … ${round(hi!)}`;
    return (
      `<tr><td class="mono">${esc(c.name)}</td><td class="mono small">${sel.offset}..${sel.offset + c.length - 1}</td>` +
      `<td><b>${esc(now.text)}</b></td><td class="small muted">${range}</td>` +
      `<td>${charted.has(id) ? '<span class="muted small">charted</span>' : `<button type="button" class="small" data-action="plot-bytes" data-p="${sel.part}" data-i="${sel.offset}" data-type="${esc(c.name)}">Chart</button>`}</td></tr>`
    );
  }).join('');
  return `<table class="candidates"><thead><tr><th>As type</th><th>Bytes</th><th>Latest</th><th>Range in history</th><th></th></tr></thead><tbody>${rows}</tbody></table>`;
}

function round(v: number): string {
  return String(Math.round(v * 1000) / 1000);
}

export function renderByteAnalysis(e: Entry, selection: ByteSelection | undefined, charted: ReadonlySet<string>): string {
  const sel = selection?.key === e.key ? selection : undefined;
  return `
    <h3>Byte analysis <span class="muted small">(${e.history.length} payloads; darker = changes more often, x = bits that changed)</span></h3>
    <div class="small muted">Data${e.id ? ` (after ID ${esc(e.id)})` : ''}</div>
    ${byteMap(e, 'm', sel)}
    ${e.kind === 'master-slave' ? `<div class="small muted">Response</div>${byteMap(e, 's', sel)}` : ''}
    ${sel ? `<div class="small">Byte ${sel.offset} of the ${sel.part === 'm' ? 'data' : 'response'} decoded as:</div>${candidates(e, sel, charted)}` : '<p class="small muted">Select a byte to decode it as different data types and chart it over time.</p>'}`;
}

export function renderNotes(e: Entry, a: Annotation | undefined, allTags: readonly string[]): string {
  return `
    <h3>Notes</h3>
    <div class="notes" data-key="${esc(e.key)}">
      <textarea id="note-text" rows="2" placeholder="What do you know about this message?">${esc(a?.note ?? '')}</textarea>
      <input id="note-tags" type="text" list="tag-list" placeholder="Tags, e.g. heating, hwc" value="${esc((a?.tags ?? []).join(', '))}" />
      <datalist id="tag-list">${allTags.map((t) => `<option value="${esc(t)}"></option>`).join('')}</datalist>
      <div class="detail-actions">
        <button type="button" data-action="save-note">Save note</button>
        <button type="button" data-action="toggle-ignore">${a?.ignored ? 'Stop ignoring' : 'Ignore message'}</button>
      </div>
    </div>`;
}

export function renderSearchResults(
  hits: readonly SearchHit[],
  entries: ReadonlyMap<string, Entry>,
  messageName: (e: Entry) => string,
  charted: ReadonlySet<string>,
): string {
  if (!hits.length) return '<p class="muted">No matches.</p>';
  const rows = hits
    .map((h, i) => {
      const e = entries.get(h.key);
      if (!e) return '';
      const id = seriesId({ kind: 'bytes', key: h.key, part: h.part, offset: h.offset, type: h.type });
      const canChart = !h.type.startsWith('STR');
      return (
        `<tr><td><span class="mono">${esc(messageName(e))}</span></td>` +
        `<td class="small">${h.part === 'm' ? 'data' : 'response'}[${h.offset}${h.length > 1 ? `..${h.offset + h.length - 1}` : ''}]</td>` +
        `<td class="mono">${esc(h.type)}</td><td><b>${esc(h.text)}</b></td>` +
        `<td class="small muted">${h.latest ? 'latest' : timestamp(h.t)}</td>` +
        `<td class="actions"><button type="button" class="small" data-action="show-hit" data-hit="${i}">Show</button>` +
        (canChart ? (charted.has(id) ? ' <span class="muted small">charted</span>' : ` <button type="button" class="small" data-action="plot-hit" data-hit="${i}">Chart</button>`) : '') +
        `</td></tr>`
      );
    })
    .join('');
  return `<p class="small muted">${hits.length} match${hits.length === 1 ? '' : 'es'}${hits.length >= 300 ? ' (first 300)' : ''}, closest first.</p>
    <table class="search-results"><thead><tr><th>Message</th><th>Bytes</th><th>Type</th><th>Value</th><th>Found</th><th></th></tr></thead><tbody>${rows}</tbody></table>`;
}

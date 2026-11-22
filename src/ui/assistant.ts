// Definition assistant dialog (M5): byte grids, type suggestions, field
// editor, values per sample and issues. Pure rendering; wiring in main.ts.

import { bitPattern, byteStats, heatLevel } from '../analysis/bytes.ts';
import { hexToBytes } from '../ebus/hex.ts';
import type { Entry } from '../store/telegram-store.ts';
import {
  decodeSamples,
  fieldDef,
  suggestTypes,
  typeLength,
  typesForLength,
  type Draft,
  type DraftField,
  type Issue,
  type Part,
} from '../assistant/draft.ts';
import { esc, hex2, timestamp } from './format.ts';

export interface DraftSelection {
  part: Part;
  from: number;
  to: number;
}

const DIRECTIONS: Array<[string, string]> = [
  ['r', 'r – read (master asks, slave answers)'],
  ['w', 'w – write'],
  ['u', 'u – passive (broadcast / seen on the bus)'],
  ['uw', 'uw – passive write'],
];

export function renderDraftHead(d: Draft, e: Entry): string {
  const masterLen = hexToBytes(e.id + (e.history.at(-1)?.master ?? '')).length;
  const opt = (v: string, label: string, cur: string) => `<option value="${v}"${v === cur ? ' selected' : ''}>${esc(label)}</option>`;
  return `
    <label>Name<input data-draft="name" value="${esc(d.name)}" spellcheck="false"></label>
    <label>Circuit<input data-draft="circuit" value="${esc(d.circuit)}" spellcheck="false" size="10"></label>
    <label>Manufacturer<input data-draft="manufacturer" value="${esc(d.manufacturer ?? '')}" spellcheck="false" size="10" placeholder="(none)"></label>
    <label>Direction<select data-draft="direction">${DIRECTIONS.map(([v, l]) => opt(v, l, d.direction)).join('')}</select></label>
    <label>ID bytes<input data-draft="idlen" type="number" min="0" max="${masterLen}" value="${d.id.length}"></label>
    <label>Comment<input data-draft="comment" value="${esc(d.comment ?? '')}"></label>
    <span class="small muted">${hex2(d.zz)} · ${hex2(d.pb)}${hex2(d.sb)} · ID ${esc(d.id.map(hex2).join('') || '–')}</span>`;
}

function fieldAt(d: Draft, part: Part, i: number): DraftField | undefined {
  return d.fields.find((f) => {
    if (f.part !== part) return false;
    let len = 1;
    try {
      len = typeLength(f.type);
    } catch {
      // invalid type: treat as one byte
    }
    return i >= f.offset && i < f.offset + len;
  });
}

function grid(d: Draft, e: Entry, part: Part, sel: DraftSelection | undefined): string {
  const prefix = part === 'm' ? hexToBytes(e.id) : new Uint8Array(0);
  const stats = byteStats(e.history, part, prefix);
  if (!stats.length) return '<span class="none">–</span>';
  return `<div class="bytemap as-bytes">${stats
    .map((s) => {
      const isId = part === 'm' && s.index < d.id.length;
      const f = isId ? undefined : fieldAt(d, part, s.index);
      const selected = sel && sel.part === part && s.index >= sel.from && s.index <= sel.to;
      const cls = `cell h${heatLevel(s)}${isId ? ' idbyte' : ''}${f ? ' infield' : ''}${selected ? ' sel' : ''}`;
      const title = isId ? `byte ${s.index}: part of the ID` : `byte ${s.index}: ${s.distinct <= 1 ? 'constant' : `${s.distinct} values, ${s.min}..${s.max}, bits ${bitPattern(s.changedBits)}`}${f ? ` · field ${f.name} (${f.type})` : ''}`;
      return (
        `<button type="button" class="${cls}" data-action="as-byte" data-p="${part}" data-i="${s.index}" title="${esc(title)}"${isId ? ' disabled' : ''}>` +
        `<span class="idx">${s.index}</span><span class="val">${s.latest !== undefined ? hex2(s.latest) : '··'}</span>` +
        (f ? `<span class="fname">${esc(f.name || '?')}</span>` : s.changedBits && s.distinct > 1 ? `<span class="bits">${bitPattern(s.changedBits)}</span>` : '') +
        `</button>`
      );
    })
    .join('')}</div>`;
}

export function renderDraftBytes(d: Draft, e: Entry, sel: DraftSelection | undefined): string {
  return `
    <div class="as-part">Data (master) · bytes 0–${d.id.length - 1 >= 0 ? `${d.id.length - 1} are the ID` : '– no ID'} · click a byte, shift-click to extend</div>
    ${grid(d, e, 'm', sel)}
    ${e.kind === 'master-slave' ? `<div class="as-part">Response (slave)</div>${grid(d, e, 's', sel)}` : ''}`;
}

export function renderDraftSelection(d: Draft, e: Entry, sel: DraftSelection | undefined): string {
  if (!sel) return '<p class="small muted">Select the byte(s) of a value to get type suggestions and add it as a field.</p>';
  const len = sel.to - sel.from + 1;
  const where = `${sel.part === 'm' ? 'data' : 'response'} byte${len > 1 ? `s ${sel.from}–${sel.to}` : ` ${sel.from}`}`;
  const suggestions = suggestTypes(e, sel.part, sel.from, 8).filter((s) => len === 1 || s.length === len);
  const rows = suggestions
    .map(
      (s) =>
        `<tr><td class="mono">${esc(s.divisor ? `${s.type} ÷${s.divisor}` : s.type)}</td><td class="mono small">${sel.from}..${sel.from + s.length - 1}</td><td><b>${esc(s.latest ?? '')}</b></td><td class="small muted">${esc(s.reason)}</td>` +
        `<td><button type="button" class="small" data-action="as-add" data-type="${esc(s.type)}"${s.divisor ? ` data-divisor="${s.divisor}"` : ''}>Add as field</button></td></tr>`,
    )
    .join('');
  const types = typesForLength(len);
  return `
    <div><b>${esc(where)}</b>
      <span class="small"> · type <select id="as-type">${types.map((t) => `<option>${esc(t)}</option>`).join('')}</select>
      <button type="button" class="small" data-action="as-add-manual">Add field</button></span>
    </div>
    ${rows ? `<table><thead><tr><th>Suggested type</th><th>Bytes</th><th>Latest</th><th>Why</th><th></th></tr></thead><tbody>${rows}</tbody></table>` : '<p class="small muted">No numeric type fits all samples here; choose a type manually.</p>'}`;
}

export function renderDraftFields(d: Draft, issues: readonly Issue[]): string {
  if (!d.fields.length) return '<p class="small muted">No fields yet.</p>';
  const bad = new Set(issues.filter((i) => i.level === 'error' && i.field !== undefined).map((i) => i.field));
  const rows = d.fields
    .map((f, i) => {
      let len = 1;
      try {
        len = typeLength(f.type);
      } catch {
        // shown as an issue
      }
      const types = typesForLength(len);
      if (!types.includes(f.type)) types.unshift(f.type);
      const input = (k: keyof DraftField, v: string | number | undefined, extra = '') =>
        `<input data-f="${i}" data-k="${k}" value="${esc(v === undefined ? '' : String(v))}" spellcheck="false"${extra}>`;
      return (
        `<tr${bad.has(i) ? ' class="bad"' : ''}><td>${input('name', f.name)}</td>` +
        `<td class="mono small">${f.part === 'm' ? 'data' : 'resp'} ${f.offset}${len > 1 ? `–${f.offset + len - 1}` : ''}</td>` +
        `<td><select data-f="${i}" data-k="type">${types.map((t) => `<option${t === f.type ? ' selected' : ''}>${esc(t)}</option>`).join('')}</select></td>` +
        `<td>${input('divisor', f.divisor, ' type="number" step="any" title="Divisor (&gt;1) or factor (negative)"')}</td>` +
        `<td>${input('values', f.values, ' placeholder="0=off;1=on"')}</td>` +
        `<td>${input('unit', f.unit)}</td><td>${input('comment', f.comment)}</td>` +
        `<td><button type="button" class="small" data-action="as-remove" data-f="${i}" aria-label="Remove field">×</button></td></tr>`
      );
    })
    .join('');
  return `<table class="as-fields"><thead><tr><th>Name</th><th>Bytes</th><th>Type</th><th>Divisor</th><th>Values</th><th>Unit</th><th>Comment</th><th></th></tr></thead><tbody>${rows}</tbody></table>`;
}

/** Values of each field per sample, newest first (ASS-2). */
export function renderDraftSamples(d: Draft, e: Entry, max = 100): string {
  if (!d.fields.length) {
    return `<table><thead><tr><th>Time</th><th>Data</th>${e.kind === 'master-slave' ? '<th>Response</th>' : ''}</tr></thead><tbody>${e.history
      .slice(-max)
      .reverse()
      .map((s) => `<tr><td class="mono">${timestamp(s.t)}</td><td class="mono">${esc(s.master)}</td>${e.kind === 'master-slave' ? `<td class="mono">${esc(s.slave)}</td>` : ''}</tr>`)
      .join('')}</tbody></table>`;
  }
  const rows = decodeSamples(d, e, max).reverse();
  const units = d.fields.map((f) => {
    try {
      return fieldDef(f).unit ?? '';
    } catch {
      return '';
    }
  });
  return `<table><thead><tr><th>Time</th>${d.fields.map((f, i) => `<th>${esc(f.name || '?')}${units[i] ? ` <span class="muted">${esc(units[i]!)}</span>` : ''}</th>`).join('')}</tr></thead><tbody>${rows
    .map((r) => `<tr><td class="mono">${timestamp(r.t)}</td>${r.values.map((v) => (v.error ? `<td class="err">${esc(v.error)}</td>` : `<td class="mono">${esc(v.text ?? '')}</td>`)).join('')}</tr>`)
    .join('')}</tbody></table>`;
}

export function renderIssues(issues: readonly Issue[], saved: 'saved' | 'changed' | 'new'): string {
  const state =
    saved === 'saved'
      ? '<div class="issue ok">Saved – used for decoding.</div>'
      : saved === 'changed'
        ? '<div class="issue warning">Unsaved changes.</div>'
        : '<div class="issue">New draft, not saved yet.</div>';
  const errors = issues.filter((i) => i.level === 'error').length;
  const list = issues.map((i) => `<div class="issue ${i.level}">${esc(i.message)}</div>`).join('');
  return state + (errors ? '' : issues.some((i) => i.level !== 'info') ? '' : '<div class="issue ok">No problems found in the captured samples.</div>') + list;
}

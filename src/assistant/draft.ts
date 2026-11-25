// Definition drafts for unknown messages (M5, ASS-1..7).
//
// A draft describes one message (addresses, command, ID, direction) and fields
// at explicit byte positions. It is converted to an ebusd CSV row (gaps filled
// with IGN fields), so decoding, validation and the TypeSpec preview all use
// the same, verified code paths as definitions from ebusd-configuration.

import { telegramKind } from '../ebus/address.ts';
import { byteHex, hexToBytes } from '../ebus/hex.ts';
import { ADJ, REMAIN, hasFlag } from '../defs/datatypes.ts';
import { parseDefinitionFile, type MessageDef } from '../defs/definitions.ts';
import { createFields, decodeFields, readValue, type FieldDef } from '../defs/fields.ts';
import type { Entry, Sample } from '../store/telegram-store.ts';

export type Direction = 'r' | 'w' | 'u' | 'uw';
export type Part = 'm' | 's';

export interface DraftField {
  name: string;
  part: Part;
  /** Byte offset within the part data (after NN); for the master part including the ID bytes. */
  offset: number;
  /** ebusd type, e.g. "D2C", "UCH", "STR:5", "BI3". */
  type: string;
  /** Divisor (> 1) or factor (negative); ignored with a value list. */
  divisor?: number;
  /** Value list, e.g. "0=off;1=on". */
  values?: string;
  unit?: string;
  comment?: string;
}

export interface Draft {
  /** Message key of the entry the draft was created from. */
  key: string;
  name: string;
  circuit: string;
  /** Manufacturer (namespace of the TypeSpec file), e.g. "Vaillant". */
  manufacturer?: string;
  comment?: string;
  direction: Direction;
  /** Source address, only set if the message is specific to one master. */
  qq?: number;
  zz: number;
  pb: number;
  sb: number;
  /** ID bytes after PB SB. */
  id: number[];
  fields: DraftField[];
  /** Last change (ms since epoch). */
  updated: number;
}

const hex = (n: number) => byteHex(n);

/** Number of bytes a type occupies ("D2C" → 2, "STR:5" → 5, "BI3" → 1). */
export function typeLength(type: string): number {
  return fieldDef({ name: 'x', part: 's', offset: 0, type }).length;
}

/** Field definition for one draft field (throws on invalid type/divisor/values). */
export function fieldDef(f: Pick<DraftField, 'name' | 'part' | 'offset' | 'type'> & Partial<DraftField>): FieldDef {
  const dv = f.values?.trim() ? f.values.trim() : f.divisor && f.divisor !== 1 ? String(f.divisor) : '';
  const fields = createFields({ name: f.name || 'x', part: f.part, type: f.type, divisorValues: dv, unit: f.unit ?? '', comment: f.comment ?? '' }, false, false);
  if (fields.length !== 1) throw new Error(`invalid type "${f.type}"`);
  const def = fields[0]!;
  if (def.length === REMAIN) throw new Error('variable length ("*") is not supported in drafts');
  return def;
}

function firstBit(t: string): number {
  const m = /^BI([0-7])/i.exec(t);
  return m ? Number(m[1]) : -1;
}

/** Default circuit name for an address: from a definition file name or the device ident ("HMU00" → "hmu"). */
export function defaultCircuit(ident: string | undefined, target: number): string {
  if (target === 0xfe) return 'broadcast';
  if (!ident) return `dev${hex(target)}`;
  return ident.replace(/[^A-Za-z0-9_]/g, '').toLowerCase().replace(/0+$/, '') || `dev${hex(target)}`;
}

export interface DraftContext {
  /** Circuit name for a target address (e.g. from the loaded definition files). */
  circuit?: (address: number) => string | undefined;
  /** Manufacturer of the device at an address. */
  manufacturer?: (address: number) => string | undefined;
  now?: number;
}

/** Creates a draft for a captured message with prefilled addresses, command, ID and direction (ASS-1). */
export function createDraft(e: Entry, ctx: DraftContext = {}): Draft {
  const kind = telegramKind(e.target);
  const last = e.history.at(-1);
  let direction: Direction = 'u';
  if (kind === 'master-slave') direction = last && last.slave.length > 0 ? 'r' : 'w';
  const draft: Draft = {
    key: e.key,
    name: `Msg_${hex(e.pb)}${hex(e.sb)}${e.id ? `_${e.id}` : ''}`,
    circuit: ctx.circuit?.(e.target) ?? defaultCircuit(undefined, e.target),
    direction,
    zz: e.target,
    pb: e.pb,
    sb: e.sb,
    id: Array.from(hexToBytes(e.id)),
    fields: [],
    updated: ctx.now ?? Date.now(),
  };
  const mf = ctx.manufacturer?.(e.target);
  if (mf) draft.manufacturer = mf;
  return draft;
}

/** Part data of a sample as seen by the draft (master: ID bytes + payload). */
export function sampleData(e: Entry, s: Sample, part: Part): Uint8Array {
  return part === 's' ? hexToBytes(s.slave) : hexToBytes(e.id + s.master);
}

/** Moves bytes between the ID and the master data (ID length 0..master data length). */
export function setIdLength(d: Draft, e: Entry, length: number): Draft {
  const last = e.history.at(-1);
  const master = last ? sampleData(e, last, 'm') : new Uint8Array(d.id);
  const n = Math.max(0, Math.min(length, master.length));
  return { ...d, id: Array.from(master.subarray(0, n)), updated: Date.now() };
}

export function sortFields(fields: readonly DraftField[]): DraftField[] {
  return [...fields].sort((a, b) => (a.part === b.part ? 0 : a.part === 'm' ? -1 : 1) || a.offset - b.offset || firstBit(a.type) - firstBit(b.type));
}

const csvCell = (s: string) => (/[",]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);

/** CSV column groups [name, part, type, divisor/values, unit, comment] of one part (fields sorted), with IGN fields filling gaps from `start`. */
export function fieldGroups(fields: readonly DraftField[], part: Part, start: number): string[][] {
  const groups: string[][] = [];
  let pos = start;
  let lastByte = -1;
  for (const f of fields) {
    if (f.part !== part) continue;
    const len = typeLength(f.type);
    const isBit = firstBit(f.type) >= 0;
    if (isBit && f.offset === lastByte) {
      // another bit field in the same byte
    } else if (f.offset > pos) {
      groups.push(['', part, `IGN:${f.offset - pos}`, '', '', '']);
    }
    const dv = f.values?.trim() ? f.values.trim() : f.divisor && f.divisor !== 1 ? String(f.divisor) : '';
    groups.push([f.name, part, f.type, dv, f.unit ?? '', f.comment ?? '']);
    lastByte = f.offset;
    pos = Math.max(pos, f.offset + len);
  }
  return groups;
}

export const CSV_HEADER = 'type,circuit,level,name,comment,qq,zz,pbsb,id,*name,part,type,divisor/values,unit,comment';

/** The draft as one ebusd CSV line (without header). */
export function draftCsvLine(d: Draft): string {
  const fields = sortFields(d.fields);
  const groups = [...fieldGroups(fields, 'm', d.id.length), ...fieldGroups(fields, 's', 0)];
  const cols = [d.direction, d.circuit, '', d.name, d.comment ?? '', d.qq !== undefined ? hex(d.qq) : '', hex(d.zz), hex(d.pb) + hex(d.sb), d.id.map(hex).join(''), ...groups.flat()];
  return cols.map(csvCell).join(',');
}

/** CSV file with all drafts. */
export function draftsCsv(drafts: readonly Draft[]): string {
  return `${CSV_HEADER}\n${drafts.map(draftCsvLine).join('\n')}\n`;
}

/** Parses the draft into a message definition (throws on errors). */
export function draftDefinition(d: Draft): MessageDef {
  const parsed = parseDefinitionFile(draftsCsv([d]), 'drafts', {});
  const err = parsed.errors[0];
  if (err) throw new Error(err.message);
  return parsed.messages[0]!;
}

// ---------------------------------------------------------------------------
// Per-sample decoding and validation (ASS-2, ASS-6)

export interface FieldValue {
  text?: string;
  value?: number;
  error?: string;
}

/** Decodes every field of the draft in every sample: rows of [time, values per field]. */
export function decodeSamples(d: Draft, e: Entry, max = Infinity): Array<{ t: number; values: FieldValue[] }> {
  const defs = d.fields.map((f) => {
    try {
      return fieldDef(f);
    } catch {
      return undefined;
    }
  });
  const samples = e.history.slice(-max);
  return samples.map((s) => ({
    t: s.t,
    values: d.fields.map((f, i) => {
      const def = defs[i];
      if (!def) return { error: 'invalid field' };
      const data = sampleData(e, s, f.part);
      const r = readValue(def, data, f.offset, def.length);
      if ('error' in r) return { error: r.error };
      const out: FieldValue = { text: r.text };
      if (r.raw !== undefined) out.value = r.raw;
      return out;
    }),
  }));
}

export interface Issue {
  level: 'error' | 'warning' | 'info';
  /** Index of the field, if the issue concerns one. */
  field?: number;
  message: string;
}

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Checks the draft against all captured samples (ASS-6). */
export function validateDraft(d: Draft, e: Entry): Issue[] {
  const issues: Issue[] = [];
  if (!IDENT.test(d.name)) issues.push({ level: 'error', message: `Message name "${d.name}" must start with a letter and contain only letters, digits and _.` });
  if (!IDENT.test(d.circuit)) issues.push({ level: 'error', message: `Circuit "${d.circuit}" must start with a letter and contain only letters, digits and _.` });
  if (!d.fields.length) issues.push({ level: 'info', message: 'No fields yet: select bytes and add a field.' });
  const names = new Map<string, number>();
  const lengths: number[] = [];
  d.fields.forEach((f, i) => {
    let len = 0;
    try {
      const def = fieldDef(f);
      len = def.length;
      if (f.unit && def.type.kind === 'str') issues.push({ level: 'warning', field: i, message: `${f.name || `field ${i + 1}`}: a unit on a ${f.type} field is unusual.` });
      if ((f.divisor && f.divisor !== 1 || f.values) && hasFlag(def.type, ADJ) && def.type.kind === 'str') issues.push({ level: 'error', field: i, message: `${f.name}: divisor/values need a numeric type.` });
    } catch (err) {
      issues.push({ level: 'error', field: i, message: `${f.name || `field ${i + 1}`}: ${err instanceof Error ? err.message : String(err)}` });
    }
    lengths.push(len);
    if (!f.name) issues.push({ level: 'error', field: i, message: `Field ${i + 1} needs a name.` });
    else if (!IDENT.test(f.name)) issues.push({ level: 'error', field: i, message: `Field name "${f.name}" must start with a letter and contain only letters, digits and _.` });
    else if (names.has(f.name)) issues.push({ level: 'error', field: i, message: `Field name "${f.name}" is used twice.` });
    names.set(f.name, i);
    if (f.part === 'm' && f.offset < d.id.length) issues.push({ level: 'error', field: i, message: `${f.name}: starts inside the ID bytes (ID length ${d.id.length}).` });
    if (f.part === 's' && (d.direction === 'u' || d.direction === 'uw') && telegramKind(d.zz) !== 'master-slave') {
      issues.push({ level: 'error', field: i, message: `${f.name}: a broadcast has no response.` });
    }
  });
  // overlaps (bit fields may share a byte)
  for (let i = 0; i < d.fields.length; i++) {
    for (let j = i + 1; j < d.fields.length; j++) {
      const a = d.fields[i]!;
      const b = d.fields[j]!;
      if (a.part !== b.part) continue;
      const bitsShare = firstBit(a.type) >= 0 && firstBit(b.type) >= 0 && a.offset === b.offset && firstBit(a.type) !== firstBit(b.type);
      if (bitsShare) continue;
      if (a.offset < b.offset + (lengths[j] || 1) && b.offset < a.offset + (lengths[i] || 1)) {
        issues.push({ level: 'error', field: j, message: `${b.name || `field ${j + 1}`} overlaps ${a.name || `field ${i + 1}`}.` });
      }
    }
  }
  // values over all samples
  const rows = decodeSamples(d, e);
  d.fields.forEach((f, i) => {
    const errs = rows.map((r) => r.values[i]!).filter((v) => v.error);
    if (errs.length) {
      const kinds = [...new Set(errs.map((v) => v.error))].join(', ');
      issues.push({ level: errs.length === rows.length ? 'error' : 'warning', field: i, message: `${f.name || `field ${i + 1}`}: ${kinds} in ${errs.length} of ${rows.length} samples.` });
    }
    const empty = rows.filter((r) => r.values[i]!.text === '-').length;
    if (empty) issues.push({ level: 'info', field: i, message: `${f.name}: no value ("-") in ${empty} of ${rows.length} samples.` });
  });
  // the CSV form must decode like the single fields (catches bit field order issues)
  if (!issues.some((x) => x.level === 'error') && d.fields.length && rows.length) {
    try {
      const def = draftDefinition(d);
      const last = e.history.at(-1)!;
      const result = decodeFields(def.fields, sampleData(e, last, 'm'), e.kind === 'master-slave' ? sampleData(e, last, 's') : undefined, def.id.length);
      if (result.error) issues.push({ level: 'error', message: `As a whole, the definition does not decode: ${result.error}.` });
      else {
        const byName = new Map(result.fields.filter((x) => x.name).map((x) => [x.name, x.text]));
        d.fields.forEach((f, i) => {
          const single = rows.at(-1)!.values[i]!.text;
          if (single !== undefined && byName.get(f.name) !== single) {
            issues.push({ level: 'error', field: i, message: `${f.name}: decodes differently as part of the whole definition (${byName.get(f.name)} instead of ${single}); check the order of bit fields.` });
          }
        });
      }
    } catch (err) {
      issues.push({ level: 'error', message: err instanceof Error ? err.message : String(err) });
    }
  }
  const covered = new Set<string>();
  d.fields.forEach((f, i) => {
    for (let b = f.offset; b < f.offset + (lengths[i] || 1); b++) covered.add(`${f.part}${b}`);
  });
  const last = e.history.at(-1);
  if (last && d.fields.length) {
    const free = (part: Part, from: number) => {
      const n = sampleData(e, last, part).length;
      let c = 0;
      for (let b = from; b < n; b++) if (!covered.has(`${part}${b}`)) c++;
      return c;
    };
    const m = free('m', d.id.length);
    const s = e.kind === 'master-slave' ? free('s', 0) : 0;
    if (m + s) issues.push({ level: 'info', message: `${m + s} byte(s) not covered by a field (written as IGN).` });
  }
  return issues;
}

// ---------------------------------------------------------------------------
// Type suggestions (ASS-5)

/** Types offered in the assistant, by byte length. */
export const DRAFT_TYPES: Record<number, string[]> = {
  1: ['UCH', 'SCH', 'D1B', 'D1C', 'BCD', 'HEX', 'BI0', 'BI1', 'BI2', 'BI3', 'BI4', 'BI5', 'BI6', 'BI7', 'TTM', 'BDY', 'HDY'],
  2: ['UIN', 'SIN', 'D2B', 'D2C', 'FLT', 'UIR', 'SIR', 'FLR', 'BCD:2', 'PIN', 'HTM', 'BTM', 'VTM', 'MIN', 'TEM_P', 'HEX:2', 'STR:2'],
  3: ['U3N', 'S3N', 'U3R', 'S3R', 'BCD:3', 'HTI', 'BTI', 'VTI', 'HDA:3', 'BDA:3', 'HEX:3', 'STR:3'],
  4: ['ULG', 'SLG', 'EXP', 'ULR', 'SLR', 'EXR', 'BCD:4', 'HDA', 'BDA', 'DTM', 'HEX:4', 'STR:4'],
};

/** Types that fit a selection of `length` bytes. */
export function typesForLength(length: number): string[] {
  return DRAFT_TYPES[length] ?? (length > 0 ? [`HEX:${length}`, `STR:${length}`, `IGN:${length}`] : []);
}

const REVERSED = new Set(['UIR', 'SIR', 'FLR', 'U3R', 'S3R', 'ULR', 'SLR', 'EXR']);
const TEMP_LIKE = new Set(['D1C', 'D2B', 'D2C', 'FLT', 'EXP', 'SIN/10']);
/** Types Vaillant devices commonly use for measured values, most common first (also the tie-break order). */
const COMMON_ORDER = ['D2C', 'EXP', 'SIN/10', 'UIN/10', 'UCH', 'D1C', 'D2B', 'UIN', 'SIN'];
const COMMON = new Set(COMMON_ORDER.slice(0, 5));
const rank = (name: string) => {
  const i = COMMON_ORDER.indexOf(name);
  return i < 0 ? COMMON_ORDER.length : i;
};
const SUGGEST: Array<[type: string, divisor?: number]> = [
  ['UCH'], ['SCH'], ['D1C'], ['BCD'],
  ['UIN'], ['UIN', 10], ['SIN'], ['SIN', 10], ['D2B'], ['D2C'], ['FLT'], ['UIR'], ['SIR'], ['FLR'], ['HTM'], ['BCD:2'],
  ['HTI'], ['BTI'], ['U3N'],
  ['ULG'], ['SLG'], ['EXP'], ['EXR'], ['BDA'], ['HDA'],
];

export interface Suggestion {
  type: string;
  divisor?: number;
  length: number;
  score: number;
  /** Short reason, e.g. "35.0 … 37.5, changes smoothly". */
  reason: string;
  latest?: string;
}

function fmt(v: number): string {
  return String(Math.round(v * 1000) / 1000);
}

/**
 * Ranks the common types at a byte position by how plausible their values
 * are over all samples: valid in every sample, smooth changes, value ranges
 * typical for temperatures, strings of printable characters.
 */
export function suggestTypes(e: Entry, part: Part, offset: number, limit = 8): Suggestion[] {
  const datas = e.history.map((s) => sampleData(e, s, part));
  if (!datas.length) return [];
  const out: Suggestion[] = [];
  for (const [type, divisor] of SUGGEST) {
    let def: FieldDef;
    try {
      def = fieldDef({ name: 'x', part, offset, type, ...(divisor ? { divisor } : {}) });
    } catch {
      continue;
    }
    if (datas.some((d) => offset + def.length > d.length)) continue;
    const results = datas.map((d) => readValue(def, d, offset, def.length));
    if (results.some((r) => 'error' in r)) continue;
    const texts = results.map((r) => ('text' in r ? r.text : ''));
    const values = results.map((r) => ('raw' in r ? r.raw : undefined));
    const defined = values.filter((v): v is number => v !== undefined && Number.isFinite(v));
    const name = divisor ? `${type}/${divisor}` : type;
    const isTime = def.type.kind === 'dt';
    if (!isTime && !defined.length) continue;
    if (type.startsWith('EXP') || type === 'EXR') {
      if (defined.some((v) => Math.abs(v) > 1e6 || (v !== 0 && Math.abs(v) < 1e-3))) continue;
    }
    const distinct = new Set(texts).size;
    let score = distinct > 1 ? 3 : 1;
    const reasons: string[] = [];
    if (defined.length) {
      const lo = Math.min(...defined);
      const hi = Math.max(...defined);
      reasons.push(lo === hi ? `constant ${texts.at(-1)}` : `${fmt(lo)} … ${fmt(hi)}`);
      if (TEMP_LIKE.has(name)) {
        if (lo >= -40 && hi <= 130 && Math.max(Math.abs(lo), Math.abs(hi)) >= 1) {
          score += 3;
          reasons.push('temperature range');
        } else score -= 2;
      }
      if (distinct > 2) {
        let maxStep = 0;
        for (let i = 1; i < defined.length; i++) maxStep = Math.max(maxStep, Math.abs(defined[i]! - defined[i - 1]!));
        if (hi > lo && maxStep <= 0.35 * (hi - lo)) {
          score += 2;
          reasons.push('changes smoothly');
        } else if (hi > lo) score -= 1;
      }
      if (Math.max(Math.abs(lo), Math.abs(hi)) > 100000) score -= 2;
    } else if (isTime) {
      reasons.push(distinct > 1 ? `${texts[0]} … ${texts.at(-1)}` : `constant ${texts[0]}`);
      score += distinct > 1 ? 2 : 0;
      reasons.push('valid time/date in all samples');
    }
    if (REVERSED.has(type)) score -= 1;
    if (def.length > 1 && distinct === 1) score -= 1;
    if (COMMON.has(name) && distinct > 1) score += 1;
    // little-endian multi-byte value whose high byte is a constant zero/sign extension
    if (def.length === 2 && !REVERSED.has(type) && distinct > 1) {
      const highs = new Set(datas.map((d) => d[offset + 1]));
      if (highs.size === 1 && (highs.has(0x00) || highs.has(0xff))) {
        score += 1;
        reasons.push('high byte is a zero/sign extension');
      }
    }
    const s: Suggestion = { type, length: def.length, score, reason: reasons.join(', '), latest: texts.at(-1) ?? '' };
    if (divisor) s.divisor = divisor;
    out.push(s);
  }
  // printable strings of 3+ bytes
  const last = datas.at(-1)!;
  let n = 0;
  while (offset + n < last.length && last[offset + n]! >= 0x20 && last[offset + n]! < 0x7f) n++;
  if (n >= 3 && datas.every((d) => d.length >= offset + n)) {
    const text = String.fromCharCode(...last.subarray(offset, offset + n));
    out.push({ type: `STR:${n}`, length: n, score: /[A-Za-z]{2}/.test(text) ? 7 : 2, reason: `printable text "${text}"`, latest: text });
  }
  const nameOf = (x: Suggestion) => (x.divisor ? `${x.type}/${x.divisor}` : x.type);
  return out.sort((a, b) => b.score - a.score || rank(nameOf(a)) - rank(nameOf(b)) || a.length - b.length).slice(0, limit);
}

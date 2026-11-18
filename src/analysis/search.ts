// Search for a known value in captured telegrams (UNK-7): every byte offset
// of every message is decoded with the candidate types and compared.

import { hexToBytes } from '../ebus/hex.ts';
import type { Entry, Sample } from '../store/telegram-store.ts';
import { CANDIDATE_TYPES, decodeCandidate } from './candidates.ts';

export type ParsedQuery = { kind: 'number'; value: number; tolerance: number } | { kind: 'text'; text: string };

/**
 * Parses the search input. Numbers may use "," or "." and carry a unit
 * ("45,5 °C"); the default tolerance is half a unit of the last given digit.
 */
export function parseQuery(input: string, tolerance?: number): ParsedQuery | undefined {
  const text = input.trim();
  if (!text) return undefined;
  const m = /^(-?\d+(?:[.,](\d+))?)\s*[^\d\s]*$/.exec(text);
  if (m) {
    const value = Number(m[1]!.replace(',', '.'));
    const decimals = m[2]?.length ?? 0;
    return { kind: 'number', value, tolerance: tolerance ?? 0.5 * 10 ** -decimals };
  }
  return { kind: 'text', text };
}

export interface SearchHit {
  key: string;
  part: 'm' | 's';
  /** Offset within the part data (master: including the ID bytes). */
  offset: number;
  type: string;
  length: number;
  text: string;
  value?: number;
  /** |value - query| for numeric searches. */
  delta?: number;
  /** Time of the sample the hit was found in. */
  t: number;
  /** True if found in the latest payload. */
  latest: boolean;
}

export interface SearchOptions {
  /** Search all history samples instead of only the latest payload. */
  history?: boolean;
  /** Restrict to these entries (e.g. unknown messages only). */
  filter?: (e: Entry) => boolean;
  limit?: number;
}

function partData(e: Entry, s: Sample, part: 'm' | 's'): Uint8Array {
  if (part === 's') return hexToBytes(s.slave);
  return hexToBytes(e.id + s.master);
}

export function searchValue(entries: readonly Entry[], query: ParsedQuery, opts: SearchOptions = {}): SearchHit[] {
  const best = new Map<string, SearchHit>();
  const add = (hit: SearchHit) => {
    const k = `${hit.key}|${hit.part}|${hit.offset}|${hit.type}`;
    const old = best.get(k);
    if (!old || (hit.delta ?? 0) < (old.delta ?? 0) || (hit.delta === old.delta && hit.t > old.t)) best.set(k, hit);
  };
  for (const e of entries) {
    if (opts.filter && !opts.filter(e)) continue;
    const samples = opts.history ? e.history : e.history.slice(-1);
    const lastSample = e.history.at(-1);
    for (const s of samples) {
      for (const part of ['m', 's'] as const) {
        if (part === 's' && e.kind !== 'master-slave') continue;
        const data = partData(e, s, part);
        const start = part === 'm' ? e.id.length / 2 : 0;
        if (query.kind === 'text') {
          const str = Array.from(data, (b) => (b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : '\0')).join('').toLowerCase();
          const needle = query.text.toLowerCase();
          for (let pos = str.indexOf(needle, start); pos >= 0; pos = str.indexOf(needle, pos + 1)) {
            add({ key: e.key, part, offset: pos, type: `STR:${needle.length}`, length: needle.length, text: str.slice(pos, pos + needle.length), t: s.t, latest: s === lastSample });
          }
          continue;
        }
        for (let offset = start; offset < data.length; offset++) {
          for (const c of CANDIDATE_TYPES) {
            const v = decodeCandidate(c, data, offset);
            if (v?.value === undefined) continue;
            const delta = Math.abs(v.value - query.value);
            if (delta <= query.tolerance + 1e-9) {
              add({ key: e.key, part, offset, type: c.name, length: c.length, text: v.text, value: v.value, delta, t: s.t, latest: s === lastSample });
            }
          }
        }
      }
    }
  }
  return [...best.values()]
    .sort((a, b) => (a.delta ?? 0) - (b.delta ?? 0) || Number(b.latest) - Number(a.latest) || a.key.localeCompare(b.key) || a.offset - b.offset || a.length - b.length)
    .slice(0, opts.limit ?? 300);
}

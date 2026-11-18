// Time series of a byte range (with a candidate type) or of a decoded field,
// built from the payload history of a message (UNK-8, UNK-10).

import type { Decoded } from '../defs/repository.ts';
import { hexToBytes } from '../ebus/hex.ts';
import type { Entry, Sample } from '../store/telegram-store.ts';
import { candidateType, decodeCandidate } from './candidates.ts';

export type SeriesSource =
  | { kind: 'bytes'; key: string; part: 'm' | 's'; offset: number; type: string }
  | { kind: 'field'; key: string; field: string };

export interface Point {
  t: number;
  /** undefined = no value (gap). */
  v: number | undefined;
  text: string;
}

export interface SeriesData {
  id: string;
  label: string;
  unit?: string;
  points: Point[];
  /** Time until which the last value is known to hold (last seen). */
  end: number;
}

export function seriesId(s: SeriesSource): string {
  return s.kind === 'bytes' ? `b:${s.key}:${s.part}:${s.offset}:${s.type}` : `f:${s.key}:${s.field}`;
}

/** Builds the points of a series; `decodeSample` is needed for field series. */
export function buildSeries(
  e: Entry,
  source: SeriesSource,
  decodeSample?: (e: Entry, s: Sample) => Decoded | undefined,
  messageName?: string,
): SeriesData {
  const points: Point[] = [];
  let unit: string | undefined;
  let label: string;
  if (source.kind === 'bytes') {
    const c = candidateType(source.type);
    label = `${messageName ?? e.key} ${source.part === 'm' ? 'data' : 'response'}[${source.offset}] as ${source.type}`;
    for (const s of e.history) {
      const data = source.part === 'm' ? hexToBytes(e.id + s.master) : hexToBytes(s.slave);
      const v = c ? decodeCandidate(c, data, source.offset) : undefined;
      points.push({ t: s.t, v: v?.value, text: v?.text ?? '–' });
    }
  } else {
    label = `${messageName ?? e.key}.${source.field}`;
    for (const s of e.history) {
      const d = decodeSample?.(e, s);
      const f = d?.result.fields.find((x) => x.name === source.field);
      if (f?.unit) unit = f.unit;
      points.push({ t: s.t, v: f && !f.error && f.raw !== undefined ? f.raw : undefined, text: f?.text ?? '–' });
    }
  }
  const out: SeriesData = { id: seriesId(source), label, points, end: Math.max(e.lastSeen, points.at(-1)?.t ?? 0) };
  if (unit) out.unit = unit;
  return out;
}

/** Value of a series at time t (step function: last point at or before t). */
export function valueAt(s: SeriesData, t: number): Point | undefined {
  let found: Point | undefined;
  for (const p of s.points) {
    if (p.t <= t) found = p;
    else break;
  }
  return found && t <= s.end ? found : undefined;
}

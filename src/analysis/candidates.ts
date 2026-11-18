// Candidate data types for reverse engineering: decode a byte range of an
// unknown message as one of the common eBUS numeric types.

import { createField, readValue, type FieldDef } from '../defs/fields.ts';

export interface CandidateType {
  /** Display name, e.g. "D2C" or "UIN/10". */
  name: string;
  /** Number of bytes. */
  length: number;
  field: FieldDef;
}

const SPECS: Array<[type: string, divisor?: number]> = [
  ['UCH'],
  ['UCH', 10],
  ['SCH'],
  ['D1B'],
  ['D1C'],
  ['BCD'],
  ['UIN'],
  ['UIN', 10],
  ['UIN', 100],
  ['SIN'],
  ['SIN', 10],
  ['SIN', 100],
  ['UIR'],
  ['SIR'],
  ['D2B'],
  ['D2C'],
  ['FLT'],
  ['FLR'],
  ['ULG'],
  ['SLG'],
  ['EXP'],
  ['EXR'],
];

export const CANDIDATE_TYPES: readonly CandidateType[] = SPECS.map(([type, divisor]) => {
  const field = createField({ name: 'value', type, divisorValues: divisor ? String(divisor) : '' }, false, false);
  return { name: divisor ? `${type}/${divisor}` : type, length: field.length, field };
});

const BY_NAME = new Map(CANDIDATE_TYPES.map((c) => [c.name, c]));

export function candidateType(name: string): CandidateType | undefined {
  return BY_NAME.get(name);
}

export interface CandidateValue {
  text: string;
  /** Numeric value; undefined for replacement ("-") values. */
  value?: number;
}

/** Decodes `data` at `offset` with a candidate type; undefined if it does not fit or is invalid. */
export function decodeCandidate(c: CandidateType, data: Uint8Array, offset: number): CandidateValue | undefined {
  if (offset < 0 || offset + c.length > data.length) return undefined;
  const r = readValue(c.field, data, offset, c.length);
  if ('error' in r) return undefined;
  const out: CandidateValue = { text: r.text };
  if (r.raw !== undefined && Number.isFinite(r.raw)) out.value = r.raw;
  return out;
}

/** Candidates that fit at `offset`, with their decoded value. */
export function candidatesAt(data: Uint8Array, offset: number): Array<{ type: CandidateType; value: CandidateValue }> {
  const out: Array<{ type: CandidateType; value: CandidateValue }> = [];
  for (const type of CANDIDATE_TYPES) {
    const value = decodeCandidate(type, data, offset);
    if (value) out.push({ type, value });
  }
  return out;
}

// Field definitions and decoding of field lists, ported from ebusd
// (src/lib/ebus/data.cpp: DataField::create, SingleDataField, DataFieldSet).

import {
  ADJ,
  DAY,
  DAY_NAMES,
  IGN,
  MAX_LEN,
  REMAIN,
  deriveNumber,
  formatNumber,
  getDataType,
  hasFlag,
  readDateTime,
  readRawNumber,
  readString,
  readTem,
  type DataType,
  type ReadResult,
} from './datatypes.ts';

export type Part = 'm' | 's';

export interface FieldDef {
  name: string;
  part: Part;
  type: DataType;
  /** Length in bytes, or REMAIN for `:*`. */
  length: number;
  values?: Map<number, string>;
  /** Constant value (`=value`), verified when `verify` is set (`==value`). */
  constant?: string;
  verify?: boolean;
  unit?: string;
  comment?: string;
  /** Original type string from the definition, e.g. "UCH" or "IGN:3". */
  typeName: string;
  /** Original divisor/values column. */
  divisorValues?: string;
}

export interface FieldColumns {
  name: string;
  part?: string;
  type: string;
  divisorValues?: string;
  unit?: string;
  comment?: string;
}

/**
 * Creates a field definition (DataField::create + SingleDataField::create).
 * `isWrite` and `masterDestination` decide the default part like ebusd.
 */
export function createField(cols: FieldColumns, isWrite: boolean, masterDestination: boolean): FieldDef {
  const fields = createFields(cols, isWrite, masterDestination);
  if (fields.length !== 1) throw new Error(`expected a single type: "${cols.type}"`);
  return fields[0]!;
}

/**
 * Creates the field(s) of one field column group. A type list such as
 * `BI0;BI1;BI2` creates one field per type; only the first one carries the
 * name, unit and comment (like ebusd).
 */
export function createFields(cols: FieldColumns, isWrite: boolean, masterDestination: boolean): FieldDef[] {
  const types = cols.type.split(';').map((t) => t.trim());
  return types.map((type, i) =>
    createSingleField(
      i === 0 ? { ...cols, type } : { ...cols, name: '', type, unit: '', comment: '' },
      isWrite,
      masterDestination,
    ),
  );
}

function createSingleField(cols: FieldColumns, isWrite: boolean, masterDestination: boolean): FieldDef {
  const partStr = (cols.part ?? '').trim().toLowerCase();
  let part: Part;
  if (masterDestination || (isWrite && !partStr) || partStr === 'm') part = 'm';
  else if ((!isWrite && !partStr) || partStr === 's') part = 's';
  else throw new Error(`invalid part "${cols.part}"`);

  const typeStr = cols.type.trim();
  if (!typeStr) throw new Error('missing field type');

  let divisor = 0;
  let valuesStr = '';
  const dv = (cols.divisorValues ?? '').trim();
  if (dv.includes('=')) valuesStr = dv;
  else if (dv) {
    divisor = Number.parseInt(dv, 10);
    if (!Number.isFinite(divisor) || String(divisor) !== dv.replace(/^\+/, '')) throw new Error(`invalid divisor "${dv}"`);
  }

  let constant: string | undefined;
  let verify = false;
  let values: Map<number, string> | undefined;
  if (valuesStr) {
    const eq = valuesStr.indexOf('=');
    if (eq === 0) {
      verify = valuesStr[1] === '=';
      constant = valuesStr.slice(verify ? 2 : 1);
    } else {
      values = new Map();
      for (const token of valuesStr.split(';')) {
        const m = /^\s*(0x[0-9a-f]+|\d+)\s*=(.*)$/i.exec(token);
        if (!m) throw new Error(`invalid value list entry "${token}"`);
        values.set(Number(m[1]), m[2]!.trim());
      }
    }
  }

  // basetype[:len]
  let typeName = typeStr;
  let length = 0;
  const colon = typeStr.indexOf(':');
  if (colon >= 0) {
    typeName = typeStr.slice(0, colon);
    const lenStr = typeStr.slice(colon + 1);
    if (lenStr === '*') length = REMAIN;
    else {
      length = Number.parseInt(lenStr, 10);
      if (!(length >= 1 && length <= MAX_LEN)) throw new Error(`invalid length in "${typeStr}"`);
    }
  }
  const dataType = getDataType(typeName, length === REMAIN ? 0 : length);
  if (!dataType) throw new Error(`unknown field type "${typeStr}"`);

  // SingleDataField::create: byte count
  let bitCount = dataType.bits;
  let byteCount = Math.ceil(bitCount / 8);
  if (hasFlag(dataType, ADJ)) {
    if (bitCount % 8 !== 0) {
      if (length === 0) bitCount = 1;
      else if (length > 0 && length <= bitCount) bitCount = length;
      else throw new Error(`invalid length in "${typeStr}"`);
      byteCount = Math.ceil(bitCount / 8);
    } else if (length === 0) byteCount = 1;
    else if (length === REMAIN || length <= byteCount) byteCount = length;
    else throw new Error(`invalid length in "${typeStr}"`);
  }

  const field: FieldDef = {
    name: cols.name.trim(),
    part,
    type: dataType,
    length: byteCount,
    typeName: typeStr,
  };
  if (cols.unit?.trim()) field.unit = cols.unit.trim();
  if (cols.comment?.trim()) field.comment = cols.comment.trim();
  if (dv) field.divisorValues = dv;

  if (constant !== undefined) {
    field.constant = constant;
    field.verify = verify;
    return field;
  }
  if (dataType.kind === 'num') {
    const derived = deriveNumber(dataType, divisor, bitCount);
    field.type = derived;
    if (!values && hasFlag(derived, DAY)) {
      values = new Map(DAY_NAMES.map((d, i) => [derived.min + i, d]));
    }
    if (values) field.values = values;
    return field;
  }
  if (divisor !== 0 || values) throw new Error(`divisor/values not allowed for "${typeStr}"`);
  return field;
}

export function isIgnored(f: FieldDef): boolean {
  return hasFlag(f.type, IGN);
}

// ---------------------------------------------------------------------------
// Decoding

export interface DecodedField {
  name: string;
  part: Part;
  /** Byte offset within the part's data (after NN), including ID bytes for the master part. */
  offset: number;
  /** Number of bytes covered (bit fields share one byte). */
  length: number;
  /** Bit position and count for bit fields. */
  bits?: { first: number; count: number };
  text: string;
  /** Numeric value (raw number for value lists, scaled value otherwise). */
  raw?: number;
  unit?: string;
  comment?: string;
  ignored: boolean;
  constant: boolean;
  error?: string;
  def: FieldDef;
}

/** Reads one field's value from `data` at `offset` (the readSymbols part). */
export function readValue(f: FieldDef, data: Uint8Array, offset: number, length: number): ReadResult {
  const t = f.type;
  if (f.values && t.kind === 'num') {
    const raw = readRawNumber(t, data, offset, length);
    if ('error' in raw) return raw;
    const name = f.values.get(raw.value);
    if (name !== undefined) return { text: name, raw: raw.value };
    if (raw.value !== t.replacement) return { text: String(raw.value), raw: raw.value };
    return { text: '-' };
  }
  switch (t.kind) {
    case 'num': {
      const raw = readRawNumber(t, data, offset, length);
      if ('error' in raw) return raw;
      return formatNumber(t, raw.value);
    }
    case 'dt':
      return readDateTime(t, data, offset, length);
    case 'str':
      return readString(t, data, offset, length);
    case 'tem':
      return readTem(t, data, offset, f.part === 'm');
  }
}

function firstBitOf(f: FieldDef): number {
  return f.type.kind === 'num' ? f.type.firstBit : 0;
}

/** SingleDataField::hasFullByteOffset. Returns [result, new previousFirstBit]. */
function fullByteOffset(f: FieldDef, after: boolean, previousFirstBit: number): [boolean, number] {
  if (f.length > 1 || f.length === REMAIN) return [true, after ? -1 : previousFirstBit];
  const first = firstBitOf(f);
  const mod = f.type.bits % 8;
  const ret = mod === 0 || first === previousFirstBit || (after && first + mod >= 8);
  return [ret, after ? (ret ? -1 : first) : previousFirstBit];
}

export interface DecodeResult {
  fields: DecodedField[];
  /** Set when decoding stopped early (e.g. not enough data). */
  error?: string;
  /** Bytes after the last field that no field covers, per part. */
  extra?: { m: number; s: number };
}

/**
 * Decodes the fields of one part (DataFieldSet::read). `data` is the part's
 * data after NN; for the master part, decoding starts at `startOffset` (the ID
 * length).
 */
export function decodePart(
  fields: readonly FieldDef[],
  part: Part,
  data: Uint8Array,
  startOffset: number,
  out: DecodedField[],
): { error?: string; end: number } {
  let offset = startOffset;
  let previousFull = true;
  let previousFirstBit = -1;
  for (const f of fields) {
    if (f.part !== part) continue;
    if (!previousFull) {
      const [full] = fullByteOffset(f, false, previousFirstBit);
      if (!full) offset--;
    }
    const remainder = f.length === REMAIN && hasFlag(f.type, ADJ);
    if (offset + (remainder ? 1 : f.length) > data.length) {
      return { error: `not enough data for field "${f.name}"`, end: offset };
    }
    const length = remainder ? data.length - offset : f.length;
    const decoded: DecodedField = {
      name: f.name,
      part,
      offset,
      length,
      text: '',
      ignored: isIgnored(f),
      constant: f.constant !== undefined,
      def: f,
    };
    if (f.type.kind === 'num' && f.type.bits < 8) decoded.bits = { first: f.type.firstBit, count: f.type.bits };
    if (f.unit) decoded.unit = f.unit;
    if (f.comment) decoded.comment = f.comment;
    if (!decoded.ignored) {
      const r = readValue(f, data, offset, f.length === REMAIN ? REMAIN : f.length);
      if ('error' in r) {
        decoded.error = r.error;
        out.push(decoded);
        return { error: `field "${f.name}": ${r.error}`, end: offset + length };
      }
      decoded.text = r.text;
      if (r.raw !== undefined) decoded.raw = r.raw;
      if (f.constant !== undefined && f.verify && r.text.trim() !== f.constant) {
        decoded.error = `expected "${f.constant}"`;
        out.push(decoded);
        return { error: `field "${f.name}": constant mismatch`, end: offset + length };
      }
    }
    out.push(decoded);
    offset += length;
    previousFull = fullByteOffset(f, true, previousFirstBit)[0];
    previousFirstBit = fullByteOffset(f, true, previousFirstBit)[1];
  }
  return { end: offset };
}

/**
 * Decodes master data (after NN, starting after `idLength` ID bytes) and
 * slave data (after NN) with the given field list.
 */
export function decodeFields(
  fields: readonly FieldDef[],
  masterData: Uint8Array,
  slaveData: Uint8Array | undefined,
  idLength: number,
): DecodeResult {
  const out: DecodedField[] = [];
  const result: DecodeResult = { fields: out };
  const m = decodePart(fields, 'm', masterData, idLength, out);
  if (m.error) {
    result.error = m.error;
    return result;
  }
  let sEnd = 0;
  if (fields.some((f) => f.part === 's')) {
    const s = decodePart(fields, 's', slaveData ?? new Uint8Array(0), 0, out);
    if (s.error) {
      result.error = s.error;
      return result;
    }
    sEnd = s.end;
  }
  const extraM = masterData.length - m.end;
  const extraS = (slaveData?.length ?? 0) - sEnd;
  if (extraM > 0 || extraS > 0) result.extra = { m: Math.max(0, extraM), s: Math.max(0, extraS) };
  return result;
}

/** Joins decoded values like ebusd's plain output (`value;value`). */
export function ebusdText(fields: readonly DecodedField[]): string {
  return fields
    .filter((f) => !f.ignored)
    .map((f) => (f.constant ? '' : f.text))
    .join(';');
}

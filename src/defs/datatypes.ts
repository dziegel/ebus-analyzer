// eBUS data types as implemented by ebusd (src/lib/ebus/datatype.cpp), ported
// for decoding only. Output strings follow ebusd's plain (non-JSON) format so
// that results can be compared with ebusd directly.

export const ADJ = 0x01; // adjustable length, bit count is the maximum
export const BCD = 0x02; // binary representation is BCD
export const REV = 0x04; // reversed byte order (most significant byte first)
export const SIG = 0x08; // signed value
export const IGN = 0x10; // ignored during read
export const FIX = 0x20; // fixed width formatting
export const REQ = 0x40; // value may not be NULL (no replacement value)
export const HCD = 0x80; // hex digit coded (with BCD)
export const EXP = 0x100; // IEEE 754 binary32
export const DAY = 0x200; // forced value list of week days
export const SPE = 0x1000; // special marker (e.g. minutes since midnight)
export const REZ = 0x4000; // no tolerated secondary replacement value of zero (date)

/** Length marker for "remaining bytes" (`:*`). */
export const REMAIN = -1;
/** Maximum length of adjustable string types in bytes. */
export const MAX_LEN = 31;

interface BaseType {
  id: string;
  /** Number of bits (maximum for adjustable types). */
  bits: number;
  flags: number;
  replacement: number;
}

export interface NumberType extends BaseType {
  kind: 'num';
  min: number;
  max: number;
  /** Divisor (> 1), factor (< 0, as negative value) or 1. */
  divisor: number;
  /** Decimal places for divisors > 1. */
  precision: number;
  /** First bit for bit types (BI0..BI7). */
  firstBit: number;
}

export interface DateTimeType extends BaseType {
  kind: 'dt';
  hasDate: boolean;
  hasTime: boolean;
  /** Minutes per step for truncated time (TTM, TTH, TTQ). */
  resolution: number;
}

export interface StringType extends BaseType {
  kind: 'str';
  isHex: boolean;
}

/** TEM specific parameter number "GG-NNN" (ebusd contrib/tem.cpp). */
export interface TemType extends BaseType {
  kind: 'tem';
}

export type DataType = NumberType | DateTimeType | StringType | TemType;

export function hasFlag(t: DataType, flag: number): boolean {
  return (t.flags & flag) !== 0;
}

export function isAdjustable(t: DataType): boolean {
  return hasFlag(t, ADJ);
}

/** Number of decimal places ebusd uses for a divisor. */
export function precisionFor(divisor: number): number {
  let p = 0;
  if (divisor > 1) for (let exp = 1; exp < 1e9 && exp < divisor; exp *= 10) p++;
  return p;
}

function num(id: string, bits: number, flags: number, replacement: number, min: number, max: number, divisor: number): NumberType {
  return { kind: 'num', id, bits, flags, replacement, min, max, divisor, precision: precisionFor(divisor), firstBit: 0 };
}

function bit(id: string, bits: number, flags: number, firstBit: number): NumberType {
  return { kind: 'num', id, bits, flags, replacement: 0, min: 0, max: 2 ** bits - 1, divisor: 1, precision: 0, firstBit };
}

function dt(id: string, bits: number, flags: number, replacement: number, hasDate: boolean, hasTime: boolean, resolution: number): DateTimeType {
  return { kind: 'dt', id, bits, flags, replacement, hasDate, hasTime, resolution };
}

function str(id: string, flags: number, replacement: number, isHex = false): StringType {
  return { kind: 'str', id, bits: MAX_LEN * 8, flags, replacement, isHex };
}

const TYPES: DataType[] = [
  str('STR', ADJ, 0x20),
  num('PIN', 16, FIX | BCD | REV, 0xffff, 0, 0x9999, 1),
  num('UCH', 8, 0, 0xff, 0, 0xfe, 1),
  num('U1L', 8, REQ, 0, 0, 0xff, 1),
  str('IGN', IGN | ADJ, 0),
  str('NTS', ADJ, 0),
  str('HEX', ADJ, 0, true),
  dt('BDA', 32, BCD, 0xff, true, false, 0),
  dt('BDA:3', 24, BCD, 0xff, true, false, 0),
  dt('BDZ', 32, BCD | SPE, 0xff, true, false, 0),
  dt('HDA', 32, 0, 0xff, true, false, 0),
  dt('HDA:3', 24, 0, 0xff, true, false, 0),
  dt('DAY', 16, REZ, 0xff, true, false, 0),
  dt('DTM', 32, REQ, 0x100, true, true, 0),
  dt('BTI', 24, BCD | REV, 0xff, false, true, 0),
  dt('HTI', 24, 0, 0xff, false, true, 0),
  dt('VTI', 24, REV, 0x63, false, true, 0),
  dt('BTM', 16, BCD | REV, 0xff, false, true, 0),
  dt('HTM', 16, 0, 0xff, false, true, 0),
  dt('VTM', 16, REV, 0xff, false, true, 0),
  dt('MIN', 16, SPE, 0xff, false, true, 0),
  dt('TTM', 8, 0, 0x90, false, true, 10),
  dt('TTH', 6, 0, 0, false, true, 30),
  dt('TTQ', 7, 0, 0, false, true, 15),
  num('BDY', 8, DAY, 0x07, 0, 6, 1),
  num('HDY', 8, DAY, 0x00, 1, 7, 1),
  num('BCD', 8, BCD, 0xff, 0, 99, 1),
  num('BCD:2', 16, BCD, 0xffff, 0, 9999, 1),
  num('BCD:3', 24, BCD, 0xffffff, 0, 999999, 1),
  num('BCD:4', 32, BCD, 0xffffffff, 0, 99999999, 1),
  num('HCD', 32, HCD | BCD | REQ, 0, 0, 99999999, 1),
  num('HCD:1', 8, HCD | BCD | REQ, 0, 0, 99, 1),
  num('HCD:2', 16, HCD | BCD | REQ, 0, 0, 9999, 1),
  num('HCD:3', 24, HCD | BCD | REQ, 0, 0, 999999, 1),
  num('SCH', 8, SIG, 0x80, 0x81, 0x7f, 1),
  num('S1L', 8, SIG | REQ, 0, 0x80, 0x7f, 1),
  num('D1B', 8, SIG, 0x80, 0x81, 0x7f, 1),
  num('D1C', 8, 0, 0xff, 0x00, 0xc8, 2),
  num('D2B', 16, SIG, 0x8000, 0x8001, 0x7fff, 256),
  num('D2C', 16, SIG, 0x8000, 0x8001, 0x7fff, 16),
  num('FLT', 16, SIG, 0x8000, 0x8001, 0x7fff, 1000),
  num('FLR', 16, SIG | REV, 0x8000, 0x8001, 0x7fff, 1000),
  num('EXP', 32, SIG | EXP, 0x7fc00000, 0xfeffffff, 0x7effffff, 1),
  num('EXR', 32, SIG | EXP | REV, 0x7fc00000, 0xfeffffff, 0x7effffff, 1),
  num('UIN', 16, 0, 0xffff, 0, 0xfffe, 1),
  num('UIR', 16, REV, 0xffff, 0, 0xfffe, 1),
  num('U2L', 16, REQ, 0, 0, 0xffff, 1),
  num('U2B', 16, REQ | REV, 0, 0, 0xffff, 1),
  num('SIN', 16, SIG, 0x8000, 0x8001, 0x7fff, 1),
  num('SIR', 16, SIG | REV, 0x8000, 0x8001, 0x7fff, 1),
  num('S2L', 16, SIG | REQ, 0, 0x8000, 0x7fff, 1),
  num('S2B', 16, SIG | REQ | REV, 0, 0x8000, 0x7fff, 1),
  num('U3N', 24, 0, 0xffffff, 0, 0xfffffe, 1),
  num('U3R', 24, REV, 0xffffff, 0, 0xfffffe, 1),
  num('U3L', 24, REQ, 0, 0, 0xffffff, 1),
  num('U3B', 24, REQ | REV, 0, 0, 0xffffff, 1),
  num('S3N', 24, SIG, 0x800000, 0x800001, 0x7fffff, 1),
  num('S3R', 24, SIG | REV, 0x800000, 0x800001, 0x7fffff, 1),
  num('S3L', 24, SIG | REQ, 0, 0x800000, 0x7fffff, 1),
  num('S3B', 24, SIG | REQ | REV, 0, 0x800000, 0x7fffff, 1),
  num('ULG', 32, 0, 0xffffffff, 0, 0xfffffffe, 1),
  num('ULR', 32, REV, 0xffffffff, 0, 0xfffffffe, 1),
  num('U4L', 32, REQ, 0, 0, 0xffffffff, 1),
  num('U4B', 32, REQ | REV, 0, 0, 0xffffffff, 1),
  num('SLG', 32, SIG, 0x80000000, 0x80000001, 0x7fffffff, 1),
  num('SLR', 32, SIG | REV, 0x80000000, 0x80000001, 0x7fffffff, 1),
  num('S4L', 32, SIG | REQ, 0, 0x80000000, 0x7fffffff, 1),
  num('S4B', 32, SIG | REQ | REV, 0, 0x80000000, 0x7fffffff, 1),
  bit('BI0', 7, ADJ | REQ, 0),
  bit('BI1', 7, ADJ | REQ, 1),
  bit('BI2', 6, ADJ | REQ, 2),
  bit('BI3', 5, ADJ | REQ, 3),
  bit('BI4', 4, ADJ | REQ, 4),
  bit('BI5', 3, ADJ | REQ, 5),
  bit('BI6', 2, ADJ | REQ, 6),
  bit('BI7', 1, REQ, 7),
  { kind: 'tem', id: 'TEM_P', bits: 16, flags: 0, replacement: 0xffff },
];

const BY_ID = new Map<string, DataType>(TYPES.map((t) => [t.id, t]));

/** Aliases ebusd keeps for backwards compatibility (DUP flag). */
for (const [alias, target] of [['BDA:4', 'BDA'], ['HDA:4', 'HDA'], ['BCD:1', 'BCD'], ['HCD:4', 'HCD']] as const) {
  BY_ID.set(alias, BY_ID.get(target)!);
}

/**
 * Looks up a data type like ebusd's DataTypeList::get: "ID:len" is preferred
 * when registered, otherwise "ID" if it is adjustable or no length is given.
 */
export function getDataType(id: string, length = 0): DataType | undefined {
  const upper = id.toUpperCase();
  if (length > 0) {
    const exact = BY_ID.get(`${upper}:${length}`);
    if (exact) return exact;
  }
  const t = BY_ID.get(upper);
  if (!t) return undefined;
  if (length > 0 && !isAdjustable(t)) return undefined;
  return t;
}

/** Combines a field divisor with the type's divisor and/or sets the bit count (NumberDataType::derive). */
export function deriveNumber(t: NumberType, divisorIn: number, bitCount: number): NumberType {
  let divisor = divisorIn === 0 ? 1 : divisorIn;
  if (t.divisor !== 1) {
    if (divisor === 1) divisor = t.divisor;
    else if (divisor < 0) {
      if (t.divisor > 1) throw new Error(`factor not allowed for ${t.id}`);
      divisor *= -t.divisor;
    } else if (t.divisor < 0) {
      if (divisor > 1) throw new Error(`divisor not allowed for ${t.id}`);
      divisor *= -t.divisor;
    } else divisor *= t.divisor;
  }
  let bits = t.bits;
  if (bitCount > 0 && bitCount !== t.bits) {
    if (!hasFlag(t, ADJ) || t.bits >= 8) throw new Error(`invalid length for ${t.id}`);
    if (bitCount + t.firstBit > 8) throw new Error(`invalid length for ${t.id}`);
    bits = bitCount;
  }
  if (divisor === t.divisor && bits === t.bits) return t;
  return {
    ...t,
    bits,
    max: t.bits < 8 ? 2 ** bits - 1 : t.max,
    divisor,
    precision: t.bits < 8 ? 0 : precisionFor(divisor),
  };
}

// ---------------------------------------------------------------------------
// Number formatting like C++ iostreams

const f32 = Math.fround;

/** `std::fixed << setprecision(p)`: like toFixed, but ties round to even (printf semantics). */
export function fixed(x: number, p: number): string {
  const scaled = x * 10 ** p;
  if (Number.isFinite(scaled) && Math.abs(scaled) < 2 ** 52 && Number.isInteger(scaled * 2) && !Number.isInteger(scaled)) {
    const lower = Math.floor(scaled);
    const even = lower % 2 === 0 ? lower : lower + 1;
    const s = (Math.abs(even) / 10 ** p).toFixed(p);
    return (even < 0 || (even === 0 && x < 0) ? '-' : '') + s;
  }
  return x.toFixed(p);
}

/** Default iostream float output (`%g` with 6 significant digits). */
export function general(x: number, precision = 6): string {
  if (x === 0) return Object.is(x, -0) ? '-0' : '0';
  if (!Number.isFinite(x)) return String(x);
  const e = x.toExponential(precision - 1);
  const [mant, expStr] = e.split('e') as [string, string];
  const exp = Number(expStr);
  if (exp < -4 || exp >= precision) {
    const m = mant.includes('.') ? mant.replace(/0+$/, '').replace(/\.$/, '') : mant;
    const sign = exp < 0 ? '-' : '+';
    return `${m}e${sign}${String(Math.abs(exp)).padStart(2, '0')}`;
  }
  const s = x.toFixed(Math.max(0, precision - 1 - exp));
  return s.includes('.') ? s.replace(/0+$/, '').replace(/\.$/, '') : s;
}

function uintToFloat(value: number): number {
  const view = new DataView(new ArrayBuffer(4));
  view.setUint32(0, value >>> 0);
  return view.getFloat32(0);
}

// ---------------------------------------------------------------------------
// Reading

export type ReadResult = { text: string; raw?: number } | { error: string };

const pad2 = (n: number) => String(n).padStart(2, '0');
const DAY_NAMES = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
export { DAY_NAMES };

/** NumberDataType::readRawValue. */
export function readRawNumber(t: NumberType | TemType, data: Uint8Array, offset: number, length: number): { value: number } | { error: string } {
  if (offset + length > data.length) return { error: 'not enough data' };
  const rev = hasFlag(t, REV);
  let value = 0;
  let exp = 1;
  for (let i = 0; i < length; i++) {
    let symbol = data[offset + (rev ? length - 1 - i : i)]!;
    if (hasFlag(t, BCD)) {
      if (!hasFlag(t, REQ) && symbol === (t.replacement & 0xff)) return { value: t.replacement };
      if (!hasFlag(t, HCD)) {
        if ((symbol & 0xf0) > 0x90 || (symbol & 0x0f) > 0x09) return { error: 'invalid BCD' };
        symbol = (symbol >> 4) * 10 + (symbol & 0x0f);
      } else if (symbol > 0x63) {
        return { error: 'invalid HCD' };
      }
      value += symbol * exp;
      exp *= 100;
    } else {
      value += symbol * exp;
      exp *= 256;
    }
  }
  if (t.kind === 'num') {
    if (t.firstBit > 0) value = Math.floor(value / 2 ** t.firstBit);
    if (t.bits < 8) value &= (1 << t.bits) - 1;
  }
  return { value };
}

function checkRange(t: NumberType, value: number): { negative: boolean } | { error: string } {
  if (hasFlag(t, SIG)) {
    const negBit = 2 ** (t.bits - 1);
    const negative = value >= negBit;
    if (hasFlag(t, EXP)) {
      const fval = uintToFloat(value);
      if (!Number.isFinite(fval)) return { error: 'empty' };
      if (fval < uintToFloat(t.min) || fval > uintToFloat(t.max)) return { error: 'out of range' };
      return { negative };
    }
    if (t.min >= negBit) {
      if (negative && value < t.min) return { error: 'out of range' };
    } else if (negative || value < t.min) return { error: 'out of range' };
    if (t.max >= negBit) {
      if (!negative || value > t.max) return { error: 'out of range' };
    } else if (!negative && value > t.max) return { error: 'out of range' };
    return { negative };
  }
  if (value < t.min || value > t.max) return { error: 'out of range' };
  return { negative: false };
}

/** Numeric value as a float (NumberDataType::getFloatFromRawValue), or undefined if null/invalid. */
export function numberValue(t: NumberType, value: number): number | undefined {
  if (!hasFlag(t, REQ) && value === t.replacement) return undefined;
  const range = checkRange(t, value);
  if ('error' in range) return undefined;
  let signed: number;
  if (t.bits === 32) {
    if (hasFlag(t, EXP)) {
      let val = uintToFloat(value);
      if (!Number.isFinite(val)) return undefined;
      if (val !== 0) {
        if (t.divisor < 0) val = f32(val * -t.divisor);
        else if (t.divisor > 1) val = f32(val / t.divisor);
      }
      return val;
    }
    signed = range.negative ? value | 0 : value;
  } else {
    signed = range.negative ? value - 2 ** t.bits : value;
  }
  if (t.divisor < 0) return f32(f32(signed) * f32(-t.divisor));
  if (t.divisor <= 1) return signed;
  return f32(f32(signed) / f32(t.divisor));
}

/** NumberDataType::readFromRawValue: formats a raw value like ebusd. */
export function formatNumber(t: NumberType, value: number): ReadResult {
  const length = t.bits < 8 ? 1 : t.bits / 8;
  if (!hasFlag(t, REQ) && value === t.replacement) return { text: '-' };
  const range = checkRange(t, value);
  if ('error' in range) return range.error === 'empty' ? { text: '-' } : { error: range.error };
  let signed: number;
  if (t.bits === 32) {
    if (hasFlag(t, EXP)) {
      let val = uintToFloat(value);
      if (!Number.isFinite(val)) return { text: '-' };
      if (val !== 0) {
        if (t.divisor < 0) {
          val = f32(val * -t.divisor);
          if (!Number.isFinite(val)) return { error: 'out of range' };
        } else if (t.divisor > 1) val = f32(val / t.divisor);
      }
      let text: string;
      if (t.precision !== 0) text = fixed(val, t.precision + 6);
      else if (val === 0) text = fixed(val, 1);
      else text = general(val);
      return { text, raw: val };
    }
    if (!range.negative) {
      if (t.divisor < 0) {
        const v = f32(f32(value) * f32(-t.divisor));
        return { text: general(v), raw: v };
      }
      if (t.divisor <= 1) return { text: String(value), raw: value };
      const v = f32(f32(value) / f32(t.divisor));
      return { text: fixed(v, t.precision), raw: v };
    }
    signed = value | 0;
  } else {
    signed = range.negative ? value - 2 ** t.bits : value;
  }
  if (t.divisor < 0) {
    const v = f32(f32(signed) * f32(-t.divisor));
    return { text: fixed(v, 0), raw: v };
  }
  if (t.divisor <= 1) {
    if (hasFlag(t, FIX) && hasFlag(t, BCD)) return { text: String(signed).padStart(length * 2, '0'), raw: signed };
    return { text: String(signed), raw: signed };
  }
  const v = f32(f32(signed) / f32(t.divisor));
  return { text: fixed(v, t.precision), raw: v };
}

/** StringDataType::readSymbols. */
export function readString(t: StringType, data: Uint8Array, offset: number, length: number): ReadResult {
  let count = length;
  if (length === REMAIN && data.length > offset) count = data.length - offset;
  else if (length === REMAIN || offset + count > data.length) return { error: 'not enough data' };
  const rev = hasFlag(t, REV);
  let out = '';
  let terminated = false;
  for (let i = 0; i < count; i++) {
    let symbol = data[offset + (rev ? length - 1 - i : i)]!;
    if (t.isHex) {
      if (i > 0) out += ' ';
      out += symbol.toString(16).padStart(2, '0');
    } else if (symbol === 0) {
      terminated = true;
    } else if (!terminated) {
      if (symbol < 0x20) symbol = t.replacement;
      else if (symbol >= 0x7f) symbol = 0x3f; // '?' for non-printable
      if (symbol !== 0) out += String.fromCharCode(symbol);
    }
  }
  return { text: out };
}

/** DateTimeDataType::readSymbols. */
export function readDateTime(t: DateTimeType, data: Uint8Array, offset: number, lengthIn: number): ReadResult {
  const length = lengthIn;
  if (offset + length > data.length) return { error: 'not enough data' };
  const rev = hasFlag(t, REV);
  const bcd = hasFlag(t, BCD);
  const req = hasFlag(t, REQ);
  const type = (t.hasDate ? 2 : 0) | (t.hasTime ? 1 : 0);
  let out = '';
  let last = 0;
  let hour = 0;
  let minutes = 0;
  let count = length;
  let index = rev ? length - 1 : 0;
  const incr = rev ? -1 : 1;
  for (let i = 0; i < count; index += incr, i++) {
    if (length === 4 && i === 2 && t.hasDate && !t.hasTime) continue; // skip weekday
    let symbol = data[offset + index]!;
    if (bcd && (req || symbol !== t.replacement)) {
      if ((symbol & 0xf0) > 0x90 || (symbol & 0x0f) > 0x09) return { error: 'invalid BCD' };
      symbol = (symbol >> 4) * 10 + (symbol & 0x0f);
    }
    switch (type) {
      case 2: {
        // date only
        if (!req && (symbol === t.replacement || (!hasFlag(t, REZ) && symbol === 0))) {
          if (i + 1 !== length) {
            out += '-.';
            break;
          } else if (last === t.replacement || (!hasFlag(t, REZ) && last === 0)) {
            if (length === 2) out += '-.';
            out += '-';
            break;
          }
        }
        if (length === 2) {
          // days since 01.01.1900
          if (i === 0) break;
          out += mjdToDate(last + symbol * 256 + 15020);
          break;
        }
        if (i + 1 === length) out += String(2000 + symbol);
        else if (symbol < 1 || (i === 0 && symbol > 31) || (i === 1 && symbol > 12)) return { error: 'invalid date' };
        else out += `${pad2(symbol)}.`;
        break;
      }
      case 1: {
        // time only
        if (!req && symbol === t.replacement) {
          if (length === 1) {
            out += '-:-';
            break;
          }
          if (i > 0) out += ':';
          out += '-';
          break;
        }
        if (hasFlag(t, SPE)) {
          // minutes since midnight
          if (i === 0) {
            last = symbol;
            continue;
          }
          minutes = symbol * 256 + last;
          if (minutes > 24 * 60) return { error: 'invalid time' };
          const minutesHour = Math.floor(minutes / 60);
          out += pad2(minutesHour);
          symbol = minutes % 60;
        } else if (length === 1) {
          // truncated time
          if (t.bits < 8) symbol &= (1 << t.bits) - 1;
          if (i === 0) {
            symbol = Math.floor(symbol / (60 / t.resolution));
            index -= incr; // repeat for minutes
            count++;
          } else {
            symbol = (symbol % (60 / t.resolution)) * t.resolution;
          }
        }
        if (i === 0) {
          if (symbol > 24) return { error: 'invalid hour' };
          hour = symbol;
        } else if (symbol > 59 || (hour === 24 && symbol > 0)) {
          return { error: 'invalid time' };
        }
        if (i > 0) out += ':';
        out += pad2(symbol);
        break;
      }
      case 3: {
        // minutes since 01.01.2009
        if (length !== 4) return { error: 'invalid length' };
        minutes += symbol * 2 ** (8 * i);
        if (i < 3) break;
        out += mjdToDate(Math.floor(minutes / (24 * 60)) + 54832);
        const m = minutes % (24 * 60);
        out += ` ${pad2(Math.floor(m / 60))}:${pad2(m % 60)}`;
        break;
      }
    }
    last = symbol;
  }
  return { text: out };
}

function mjdToDate(mjd: number): string {
  let y = Math.trunc((mjd - 15078.2) / 365.25);
  let m = Math.trunc((mjd - 14956.1 - Math.trunc(y * 365.25)) / 30.6001);
  const d = mjd - 14956 - Math.trunc(y * 365.25) - Math.trunc(m * 30.6001);
  m--;
  if (m >= 13) {
    y++;
    m -= 12;
  }
  return `${pad2(d)}.${pad2(m)}.${y + 1900}`;
}

/** TemParamDataType::readSymbols ("GG-NNN"). */
export function readTem(t: TemType, data: Uint8Array, offset: number, isMaster: boolean): ReadResult {
  const raw = readRawNumber(t, data, offset, 2);
  if ('error' in raw) return raw;
  const value = raw.value;
  if (value === t.replacement) return { text: '-' };
  const grp = isMaster ? value & 0x1f : (value >> 7) & 0x1f;
  const no = isMaster ? (value >> 8) & 0x7f : value & 0x7f;
  return { text: `${pad2(grp)}-${String(no).padStart(3, '0')}`, raw: value };
}

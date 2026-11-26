// Parsers for responses of the ebusd TCP command interface.
// A response consists of one or more lines and is terminated by an empty line.

import { isMaster } from '../ebus/address.ts';

/** One line of `grab result [all]`: `QQZZPBSBNNDD.. / NNDD.. = count`. */
export interface GrabLine {
  masterHex: string;
  slaveHex?: string;
  /** Number of times ebusd has seen this message, if reported. */
  count?: number;
  /** Anything ebusd appended after the count (e.g. a message name), trimmed. */
  extra?: string;
}

const GRAB_LINE = /^([0-9a-f]{10,})(?:\s*\/\s*([0-9a-f]*))?\s*(?:=\s*(\d+))?\s*(.*)$/i;

/** Parses one grab result line; returns undefined for lines that are not telegrams. */
export function parseGrabLine(line: string): GrabLine | undefined {
  const m = GRAB_LINE.exec(line.trim());
  if (!m) return undefined;
  const [, master, slave, count, extra] = m;
  if (master!.length % 2 !== 0) return undefined;
  if (slave !== undefined && slave.length % 2 !== 0) return undefined;
  const result: GrabLine = { masterHex: master!.toLowerCase() };
  if (slave) result.slaveHex = slave.toLowerCase();
  if (count !== undefined) result.count = Number(count);
  const rest = extra?.replace(/^[:\s]+/, '').trim();
  if (rest) result.extra = rest;
  return result;
}

/** Parses all telegram lines of a grab result, ignoring anything else. */
export function parseGrabResult(lines: readonly string[]): GrabLine[] {
  const out: GrabLine[] = [];
  for (const line of lines) {
    const parsed = parseGrabLine(line);
    if (parsed) out.push(parsed);
  }
  return out;
}

/** One device from `scan result`: `08;Vaillant;HMU00;0308;0403`. */
export interface ScanDevice {
  address: number;
  manufacturer: string;
  deviceId: string;
  sw: string;
  hw: string;
  /** Further fields appended by ebusd (e.g. from scan messages). */
  extra: string[];
}

/** Parses `scan result`. Lines like "1 scan(s) still running" are ignored. */
export function parseScanResult(lines: readonly string[]): ScanDevice[] {
  const out: ScanDevice[] = [];
  for (const line of lines) {
    const parts = line.trim().split(';');
    if (parts.length < 5 || !/^[0-9a-f]{2}$/i.test(parts[0]!)) continue;
    out.push({
      address: parseInt(parts[0]!, 16),
      manufacturer: parts[1]!.trim(),
      deviceId: parts[2]!.trim(),
      sw: parts[3]!.trim(),
      hw: parts[4]!.trim(),
      extra: parts.slice(5).map((p) => p.trim()),
    });
  }
  return out;
}

/** Parses `info` (`key: value` lines) into a map. */
export function parseInfo(lines: readonly string[]): Map<string, string> {
  const info = new Map<string, string>();
  for (const line of lines) {
    const idx = line.indexOf(':');
    if (idx <= 0) continue;
    info.set(line.slice(0, idx).trim(), line.slice(idx + 1).trim());
  }
  return info;
}

/** True if the response is an ebusd error (`ERR: ...`). */
export function isError(lines: readonly string[]): boolean {
  return lines.length > 0 && lines[0]!.startsWith('ERR:');
}

/**
 * Splits a stream of text chunks into responses terminated by an empty line.
 * Feed chunks with `push`; complete responses are passed to the callback.
 */
export class ResponseSplitter {
  #partial = '';
  #lines: string[] = [];
  readonly #onResponse: (lines: string[]) => void;

  constructor(onResponse: (lines: string[]) => void) {
    this.#onResponse = onResponse;
  }

  push(chunk: string): void {
    const text = this.#partial + chunk;
    const parts = text.split('\n');
    this.#partial = parts.pop() ?? '';
    for (const raw of parts) {
      const line = raw.replace(/\r$/, '');
      if (line === '') {
        const lines = this.#lines;
        this.#lines = [];
        this.#onResponse(lines);
      } else {
        this.#lines.push(line);
      }
    }
  }

  reset(): void {
    this.#partial = '';
    this.#lines = [];
  }
}

/** One line of ebusd's decoding hints: a data type and its values at the possible offsets. */
export interface DecodeHint {
  type: string;
  values: Array<{
    /** Byte offset in the decoded part (master data incl. ID bytes, or slave data). */
    offset: number;
    hex: string;
    text: string;
  }>;
}

/** A telegram from `grab result decode` with ebusd's decoding hints (CON-5). */
export interface GrabDecodeEntry extends GrabLine {
  /** Which part ebusd decoded: the slave data if there is any, else the master data. */
  part: 'm' | 's';
  hints: DecodeHint[];
}

const HINT_LINE = /^\s+(\S+)\s+(.*)$/;
const HINT_VALUE = /([0-9a-f]+)=("[^"]*"|[^,]*)(?:, |$)/gi;

/**
 * Parses the answer to `grab result [all] decode`: each telegram line is
 * followed by lines like ` D2C   0160=1536.06, 6001=22.00` (type, then
 * hex=value for each offset where the type gives a valid value).
 */
export function parseGrabDecode(lines: readonly string[]): GrabDecodeEntry[] {
  const out: GrabDecodeEntry[] = [];
  let cur: GrabDecodeEntry | undefined;
  let data = '';
  for (const line of lines) {
    if (!line.trim()) continue;
    if (!/^\s/.test(line)) {
      const g = parseGrabLine(line);
      if (!g) {
        cur = undefined;
        continue;
      }
      const target = parseInt(g.masterHex.slice(2, 4), 16);
      const slaveData = g.slaveHex ? g.slaveHex.slice(2) : '';
      const toSlave = target !== 0xfe && !isMaster(target) && slaveData.length > 0;
      cur = { ...g, part: toSlave ? 's' : 'm', hints: [] };
      data = toSlave ? slaveData : g.masterHex.slice(10);
      out.push(cur);
      continue;
    }
    const m = cur && HINT_LINE.exec(line);
    if (!cur || !m) continue;
    const hint: DecodeHint = { type: m[1]!, values: [] };
    let from = 0;
    for (const v of m[2]!.matchAll(HINT_VALUE)) {
      const hex = v[1]!.toLowerCase();
      // values are listed by increasing offset; find the byte position of each
      let pos = data.indexOf(hex, from);
      while (pos >= 0 && pos % 2) pos = data.indexOf(hex, pos + 1);
      if (pos < 0) continue;
      from = pos + 2;
      const raw = v[2]!.trim();
      hint.values.push({ offset: pos / 2, hex, text: raw.startsWith('"') && raw.endsWith('"') ? raw.slice(1, -1) : raw });
    }
    if (hint.values.length) cur.hints.push(hint);
  }
  return out;
}

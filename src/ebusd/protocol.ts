// Parsers for responses of the ebusd TCP command interface.
// A response consists of one or more lines and is terminated by an empty line.

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

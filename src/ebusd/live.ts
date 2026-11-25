// Live test of definition drafts and telegrams against ebusd (M6: CON-7,
// CON-8, ASS-8). Builds the ebusd commands and interprets their answers;
// sending is done by the app through the bridge.
//
//   decode [-m] FIELDS HEX  ebusd decodes a captured payload with the draft's
//                           fields (no bus traffic)
//   define [-r] DEFINITION  adds the draft to ebusd until its next restart
//                           (needs ebusd --enabledefine)
//   find -c CIRCUIT NAME    the value ebusd decoded for the defined message
//   read -def DEFINITION    ebusd sends the read request and decodes the
//                           answer with the draft (needs --enabledefine)
//   hex ZZPBSBNNDD...       sends a telegram (needs --enablehex)

import { fieldGroups, sampleData, sortFields, fieldDef, type Draft, type Part } from '../assistant/draft.ts';
import { telegramKind } from '../ebus/address.ts';
import { byteHex, hexToBytes } from '../ebus/hex.ts';
import { createFields, readValue, type FieldDef } from '../defs/fields.ts';
import type { Entry, Sample } from '../store/telegram-store.ts';

/**
 * Splits a command line like ebusd does: at spaces, but a token starting with
 * ' or " continues up to the token ending with the same quote.
 */
export function splitArgs(line: string): string[] {
  const args: string[] = [];
  let quote = '';
  for (let token of line.split(' ')) {
    if (quote) {
      const prev = args.pop() ?? '';
      if (token.endsWith(quote)) {
        token = token.slice(0, -1);
        quote = '';
      }
      args.push(`${prev} ${token}`);
      continue;
    }
    if (!token) continue;
    if (token[0] === '"' || token[0] === "'") {
      quote = token[0];
      token = token.slice(1);
      if (token.length > 0 && token.endsWith(quote)) {
        token = token.slice(0, -1);
        quote = '';
      }
    }
    args.push(token);
  }
  return args;
}

/** Quotes an argument so that ebusd reads it as one (throws if that is impossible). */
export function quoteArg(s: string): string {
  if (/[\r\n]/.test(s)) throw new Error('line breaks cannot be sent to ebusd');
  if (s && !/\s/.test(s) && !/^['"]/.test(s)) return s;
  for (const q of ["'", '"']) {
    const quoted = `${q}${s}${q}`;
    const args = splitArgs(`x ${quoted}`);
    if (args.length === 2 && args[1] === s) return quoted;
  }
  throw new Error('the definition cannot be quoted for ebusd (contains both quote characters at word ends)');
}

const csvCell = (s: string) => (/[",]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);

/**
 * The draft as an ebusd definition line in ebusd's default column order
 * (type,circuit,name,comment,qq,zz,pbsb,id,fields...; no level column).
 * Comments are left out: they do not matter for a test and keep the line short.
 */
export function ebusdDefinition(d: Draft): string {
  const fields = sortFields(d.fields);
  const groups = [...fieldGroups(fields, 'm', d.id.length), ...fieldGroups(fields, 's', 0)].map((g) => [g[0]!, g[1]!, g[2]!, g[3]!, g[4]!, '']);
  const cols = [d.direction, d.circuit, d.name, '', d.qq !== undefined ? byteHex(d.qq) : '', byteHex(d.zz), byteHex(d.pb) + byteHex(d.sb), d.id.map(byteHex).join(''), ...groups.flat()];
  return cols.map(csvCell).join(',');
}

export function defineCommand(d: Draft, replace = false): string {
  return `define ${replace ? '-r ' : ''}${quoteArg(ebusdDefinition(d))}`;
}

/** Why the draft cannot be read with `read -def`, or undefined. */
export function readProblem(d: Draft): string | undefined {
  if (telegramKind(d.zz) !== 'master-slave') return 'only messages to a slave have an answer to read';
  if (d.direction !== 'r') return 'only drafts with direction "r" (read) can be read from the bus';
  if (d.fields.some((f) => f.part === 'm')) return 'the draft has fields in the master data; make them part of the ID to read it';
  if (!d.fields.some((f) => f.part === 's')) return 'the draft has no fields in the response';
  return undefined;
}

export function readCommand(d: Draft): string {
  const problem = readProblem(d);
  if (problem) throw new Error(problem);
  return `read -def ${quoteArg(ebusdDefinition(d))}`;
}

export function findCommand(d: Draft): string {
  return `find -c ${quoteArg(d.circuit)} ${quoteArg(d.name)}`;
}

/** Value of the message in the answer to `find -c CIRCUIT NAME`. */
export function parseFind(lines: readonly string[], d: Draft): { value?: string; noData?: boolean; notFound?: boolean } {
  const prefix = `${d.circuit} ${d.name} = `.toLowerCase();
  const line = lines.find((l) => l.toLowerCase().startsWith(prefix));
  if (!line) return { notFound: true };
  const value = line.slice(prefix.length);
  return value === 'no data stored' ? { noData: true } : { value };
}

/** ebusd field list (type,divisor/values,unit,comment per field) of one part. */
export function ebusdFieldList(d: Draft, part: Part): string {
  return fieldGroups(sortFields(d.fields), part, 0)
    .map((g) => [g[2]!, g[3]!, g[4]!, ''].map(csvCell).join(','))
    .join(',');
}

export interface DecodeCheck {
  part: Part;
  command: string;
  /** ebusd's output as the app expects it (values of the non-ignored fields, ";"-separated). */
  expected: string;
  /** The app finds an invalid value: ebusd is expected to answer with an error. */
  error?: boolean;
}

/** `decode` commands for the parts of the draft that have fields, for one captured payload. */
export function decodeChecks(d: Draft, e: Entry, s: Sample): DecodeCheck[] {
  const out: DecodeCheck[] = [];
  for (const part of ['m', 's'] as const) {
    const fields = sortFields(d.fields).filter((f) => f.part === part);
    if (!fields.length) continue;
    const data = sampleData(e, s, part);
    if (!data.length) continue;
    let error = false;
    const texts = fields.map((f) => {
      const def = fieldDef(f);
      const r = readValue(def, data, f.offset, def.length);
      if ('error' in r) error = true;
      return 'error' in r ? `(${r.error})` : r.text;
    });
    const hex = Array.from(data, byteHex).join('');
    const check: DecodeCheck = { part, command: `decode ${part === 'm' ? '-m ' : ''}${quoteArg(ebusdFieldList(d, part))} ${hex}`, expected: texts.join(';') };
    if (error) check.error = true;
    out.push(check);
  }
  return out;
}

/** Parses an ebusd field list (as used by `decode`) into field definitions. */
export function parseFieldList(list: string, part: Part): FieldDef[] {
  const cells: string[] = [];
  let cur = '';
  let q = false;
  for (let i = 0; i < list.length; i++) {
    const c = list[i]!;
    if (q) {
      if (c === '"' && list[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (c === '"') q = false;
      else cur += c;
    } else if (c === '"') q = true;
    else if (c === ',') {
      cells.push(cur);
      cur = '';
    } else cur += c;
  }
  cells.push(cur);
  const fields: FieldDef[] = [];
  for (let i = 0; i < cells.length; i += 4) {
    if (!cells[i]) continue;
    fields.push(...createFields({ name: '', part, type: cells[i]!, divisorValues: cells[i + 1] ?? '', unit: cells[i + 2] ?? '', comment: cells[i + 3] ?? '' }, false, false));
  }
  return fields;
}

/** Normalizes and checks a telegram for `hex`: ZZ PB SB NN DD..., spaces allowed. */
export function parseHexTelegram(input: string): { hex: string; zz: number; pb: number; sb: number; data: Uint8Array } | { error: string } {
  const hex = input.replace(/[\s:]/g, '').toLowerCase();
  if (!/^([0-9a-f]{2})+$/.test(hex)) return { error: 'Enter hex bytes: ZZ PB SB NN DD…' };
  const bytes = hexToBytes(hex);
  if (bytes.length < 4) return { error: 'At least ZZ PB SB NN are needed.' };
  const nn = bytes[3]!;
  if (nn !== bytes.length - 4) return { error: `NN is ${nn}, but ${bytes.length - 4} data byte(s) follow.` };
  if (nn > 16) return { error: 'At most 16 data bytes.' };
  return { hex, zz: bytes[0]!, pb: bytes[1]!, sb: bytes[2]!, data: bytes.subarray(4) };
}

/** The telegram of a captured sample in `hex` form (ZZPBSBNNDD...). */
export function hexOfSample(e: Entry, s: Sample): string {
  const data = sampleData(e, s, 'm');
  return [e.target, e.pb, e.sb, data.length].map(byteHex).join('') + Array.from(data, byteHex).join('');
}

/** Explanation for an ebusd/bridge error line, if known. */
export function explainError(line: string, command: string): string | undefined {
  const verb = command.trim().split(/\s+/, 1)[0]?.toLowerCase();
  if (/blocked by bridge/.test(line)) return 'The bridge is read-only: start it with --allow-write to allow commands that send to the bus or change ebusd.';
  if (/command not enabled|option not enabled/.test(line)) {
    return verb === 'hex' ? 'ebusd was started without --enablehex.' : 'ebusd was started without --enabledefine.';
  }
  if (/no signal/.test(line)) return 'ebusd has no signal from the bus.';
  if (/duplicate entry/.test(line)) return 'ebusd already has a message with this command and ID (or name); define it again to replace that one until ebusd restarts.';
  if (/element not found/.test(line)) return 'ebusd does not know this message (define it first).';
  if (/ERR: (read timeout|SYN received|arbitration lost|no answer)/i.test(line)) return 'The device did not answer on the bus.';
  return undefined;
}

export const isError = (lines: readonly string[]) => lines.length > 0 && /^ERR:/.test(lines[0]!);

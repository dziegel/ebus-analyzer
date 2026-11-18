// Runs ebusd's own data type test vectors (src/lib/ebus/test/test_data.cpp)
// against the decoder. The vectors are read from an ebusd source checkout at
// runtime and are not part of this repository (ebusd is GPL-3.0):
//
//   git clone --depth 1 https://github.com/john30/ebusd ../ebusd
//   EBUSD_SRC=../ebusd npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { splitCsvLine } from '../src/defs/csv.ts';
import { createFields as createGroup, decodeFields, ebusdText, type FieldDef } from '../src/defs/fields.ts';
import { hexToBytes } from '../src/ebus/hex.ts';
import { isMaster } from '../src/ebus/address.ts';

const src = process.env.EBUSD_SRC;
const file = src ? join(src, 'src/lib/ebus/test/test_data.cpp') : '';

/** Unescapes a C++ string literal body. */
function unescape(s: string): string {
  return s.replace(/\\(.)/g, (_, c: string) => (c === 'n' ? '\n' : c === 't' ? '\t' : c));
}

interface Vector {
  def: string;
  expect: string;
  master: string;
  slave: string;
  flags: string;
  line: number;
}

function readVectors(path: string): Vector[] {
  const out: Vector[] = [];
  const lines = readFileSync(path, 'utf8').split('\n');
  const str = '"((?:[^"\\\\]|\\\\.)*)"';
  const re = new RegExp(`^\\s*\\{${str},\\s*${str},\\s*${str},\\s*${str},\\s*${str}`);
  lines.forEach((line, i) => {
    const m = re.exec(line);
    if (m) out.push({ def: unescape(m[1]!), expect: unescape(m[2]!), master: m[3]!, slave: m[4]!, flags: m[5]!, line: i + 1 });
  });
  return out;
}

function createFields(def: string, isWrite: boolean, masterDst: boolean): FieldDef[] {
  const cols = splitCsvLine(def);
  const fields: FieldDef[] = [];
  for (let i = 0; i < cols.length; i += 6) {
    const [name = '', part = '', type = '', divisorValues = '', unit = '', comment = ''] = cols.slice(i, i + 6);
    fields.push(...createGroup({ name, part, type, divisorValues, unit, comment }, isWrite, masterDst));
  }
  return fields;
}

test('ebusd data type test vectors', { skip: !file || !existsSync(file) ? 'set EBUSD_SRC to an ebusd checkout' : false }, () => {
  const vectors = readVectors(file);
  // Templates ('t' vectors) are not part of the generated CSV files; skip vectors using them.
  const templates = vectors.filter((v) => v.flags.includes('t')).map((v) => v.def.split(',')[0]!.toLowerCase());
  const usesTemplate = (def: string) =>
    splitCsvLine(def).some((c, i) => i % 6 === 2 && c.split(';').some((t) => templates.includes(t.split(':')[0]!.trim().toLowerCase())));
  assert.ok(vectors.length > 300, `only ${vectors.length} vectors found`);
  let checked = 0;
  let skipped = 0;
  const failures: string[] = [];
  for (const v of vectors) {
    const flags = v.flags.split(':')[0]!;
    // Skip output formats and features this decoder does not produce
    // (names/units/JSON/numeric output, templates, field index lookups).
    // Range checks ('-': extra range column) are not used by the generated CSV files either.
    if (/[tjvVnIiFN-]/.test(flags) || flags.includes('c') || flags.includes('R') || usesTemplate(v.def)) {
      skipped++;
      continue;
    }
    const failedRead = flags.includes('r');
    const isSet = flags.includes('s');
    let fields: FieldDef[];
    try {
      const target = parseInt(v.master.slice(2, 4), 16);
      fields = createFields(v.def, isSet, target === 0xfe || isMaster(target));
    } catch (err) {
      failures.push(`line ${v.line} "${v.def}": create failed: ${(err as Error).message}`);
      continue;
    }
    const master = hexToBytes(v.master).slice(5);
    const slave = v.slave ? hexToBytes(v.slave).slice(1) : new Uint8Array(0);
    const result = decodeFields(fields, master, slave, 0);
    checked++;
    if (failedRead) {
      if (!result.error) failures.push(`line ${v.line} "${v.def}" ${v.master} ${v.slave}: expected read error, got "${ebusdText(result.fields)}"`);
      continue;
    }
    if (result.error) {
      failures.push(`line ${v.line} "${v.def}" ${v.master} ${v.slave}: ${result.error}`);
      continue;
    }
    const text = ebusdText(result.fields);
    if (text.toLowerCase() !== v.expect.toLowerCase()) {
      failures.push(`line ${v.line} "${v.def}" ${v.master} ${v.slave}: got "${text}", expected "${v.expect}"`);
    }
  }
  console.log(`ebusd vectors: ${checked} checked, ${skipped} skipped, ${failures.length} failed`);
  assert.deepEqual(failures, []);
});

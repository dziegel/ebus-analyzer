// Tests with the real TypeSpec compiler and the @ebusd/ebus-typespec emitter,
// using the same in-memory host as the browser worker. Skipped when the npm
// packages are not installed. With EBUSD_CONFIG (a clone of
// john30/ebusd-configuration) and EBUS_CDN (a clone of eBUS/ebus.github.io),
// the complete ebusd-configuration is compiled and compared with the CDN.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseDefinitionFile, type MessageDef } from '../src/defs/definitions.ts';
import { defaultsFor } from '../src/defs/loader.ts';
import { writeTypeSpec } from '../src/tsp/writer.ts';
import type { LibraryBundle } from '../src/tsp/protocol.ts';

let compileProject: typeof import('../src/tsp/compile.ts').compileProject | undefined;
let libraries: LibraryBundle[] = [];
try {
  ({ compileProject } = await import('../src/tsp/compile.ts'));
  const { collectLibraries } = await import('../scripts/tsp-libs.mjs');
  libraries = collectLibraries().map((l: { name: string; files: Record<string, string>; js: Array<{ rel: string; abs: string }> }) => ({
    name: l.name,
    files: l.files,
    js: Object.fromEntries(l.js.map((j) => [j.rel, () => import(pathToFileURL(j.abs).href)])),
  }));
} catch (err) {
  compileProject = undefined;
  if (process.env.REQUIRE_TSP === '1') throw err;
}
const skip = compileProject ? false : 'TypeSpec packages not installed (npm install)';

const HEADER = 'type,circuit,level,name,comment,qq,zz,pbsb,id,*name,part,type,divisor/values,unit,comment';

/** Comparable form of a definition. */
function summary(d: MessageDef): string {
  const fields = d.fields.map((f) => `${f.name}|${f.part}|${f.typeName.toUpperCase()}|${f.divisorValues ?? ''}|${f.unit ?? ''}`).join(',');
  return `${d.type}${d.pollPriority || ''} ${d.circuit}.${d.name} ${[d.pb, d.sb, ...d.id].map((b) => b.toString(16).padStart(2, '0')).join('')} [${d.zz?.join(';') ?? ''}] ${d.level ?? ''} {${fields}}`;
}

function parseOutputs(csv: Record<string, string>) {
  return Object.entries(csv).map(([path, text]) => ({ path, parsed: parseDefinitionFile(text, path, defaultsFor(path)) }));
}

test('compiles a small project and reports diagnostics', { skip }, async () => {
  const main = [
    'import "@ebusd/ebus-typespec";',
    'using Ebus;',
    'using Ebus.Num;',
    'using Ebus.Str;',
    'namespace Vaillant;',
    '@zz(0x08)',
    'namespace Hmu {',
    '  /** current flow temperature */',
    '  @id(0xb5, 0x1a, 0x05, 0xff, 0x32, 0x20)',
    '  model FlowTemp {',
    '    @maxLength(3)',
    '    ign: IGN;',
    '    @unit("°C")',
    '    value: D2C;',
    '  }',
    '}',
  ].join('\n');
  const ok = await compileProject!({ files: { 'vaillant/08.hmu.tsp': main }, entry: 'vaillant/08.hmu.tsp' }, libraries);
  assert.deepEqual(ok.diagnostics.filter((d) => d.severity === 'error'), []);
  const outputs = parseOutputs(ok.csv);
  console.log('emitted:', Object.keys(ok.csv), `${ok.timeMs} ms`);
  assert.equal(outputs.length, 1);
  assert.deepEqual(outputs[0]!.parsed.errors, []);
  const flow = outputs[0]!.parsed.messages.find((m) => m.name === 'FlowTemp')!;
  assert.ok(flow, ok.csv[outputs[0]!.path]);
  assert.deepEqual(flow.id, [0x05, 0xff, 0x32, 0x20]);
  assert.deepEqual(flow.zz, [0x08]);
  assert.deepEqual(flow.fields.map((f) => f.typeName), ['IGN:3', 'D2C']);

  const bad = await compileProject!({ files: { 'main.tsp': `${main}\nmodel Broken { x: NoSuchType; }\n` }, entry: 'main.tsp' }, libraries);
  const err = bad.diagnostics.find((d) => d.severity === 'error');
  assert.ok(err, JSON.stringify(bad.diagnostics));
  assert.equal(err.file, 'main.tsp');
  assert.equal(err.line, 17);
});

test('TypeSpec written by the app compiles back to the same definitions', { skip }, async () => {
  const csv = [
    HEADER,
    'r,,,FlowTemp,current flow temperature,,,b51a,05ff3220,ign,,IGN:3,,,,value,,D2C,,°C,temperature',
    'w,,install,SetMode,,,,b509,0e0100,mode,,UCH,0=off;1=on;2=auto,,',
    'r,,,Mixed,,,,b509,0d0200,id,m,UCH,,,,v,,UIN,-10,,',
    'r,,,Bits,,,,b509,0d0300,a,,BI0,,,,b,,BI1,,,,c,,UCH,,,,d,,BI0:7,,,',
    'r,,,Times,,,,b509,0d0400,t,,HTM,,,,d,,BDA,,,,s,,STR:5,,,,x,,HEX:2,,,',
    'r5,,,Polled,,,,b509,0d0500,value,,UIN,10,bar,',
  ].join('\n');
  const source = parseDefinitionFile(csv, 'vaillant/08.hmu.csv', { zz: '08', circuit: 'hmu' });
  assert.deepEqual(source.errors, []);
  const tsp = writeTypeSpec(source.messages, { manufacturer: 'Vaillant' });
  const r = await compileProject!({ files: { 'vaillant/08.hmu.tsp': tsp }, entry: 'vaillant/08.hmu.tsp' }, libraries);
  assert.deepEqual(r.diagnostics.filter((d) => d.severity === 'error'), [], tsp);
  const back = parseOutputs(r.csv).flatMap((o) => o.parsed.messages);
  assert.deepEqual(back.map(summary).sort(), source.messages.map(summary).sort(), `${tsp}\n---\n${Object.values(r.csv).join('\n')}`);
});

const config = process.env.EBUSD_CONFIG;
const cdn = process.env.EBUS_CDN;
const fullSkip = skip || (!config || !existsSync(join(config, 'src/main.tsp')) ? 'set EBUSD_CONFIG to a clone of ebusd-configuration' : false);

function readTree(dir: string, root = dir, out: Record<string, string> = {}): Record<string, string> {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) readTree(p, root, out);
    else if (/\.(tsp|ya?ml)$/.test(name)) out[relative(root, p).split('\\').join('/')] = readFileSync(p, 'utf8');
  }
  return out;
}

test('compiles ebusd-configuration like the CDN', { skip: fullSkip, timeout: 600_000 }, async () => {
  const files = readTree(join(config!, 'src'));
  const r = await compileProject!({ files, entry: 'main.tsp' }, libraries);
  const errors = r.diagnostics.filter((d) => d.severity === 'error');
  const byCode = new Map<string, number>();
  for (const e of errors) byCode.set(`${e.code} (${e.file})`, (byCode.get(`${e.code} (${e.file})`) ?? 0) + 1);
  console.log(`ebusd-configuration: ${Object.keys(files).length} files, ${Object.keys(r.csv).length} CSV, ${errors.length} errors, ${r.diagnostics.length - errors.length} warnings, ${r.timeMs} ms`);
  console.log(`errors by code and file: ${JSON.stringify(Object.fromEntries(byCode))}`);
  // the newer emitter may report issues in some files; the device files must be emitted
  for (const p of ['vaillant/08.hmu.csv', 'vaillant/15.ctlv2.csv', 'broadcast.csv']) assert.ok(r.csv[p], `${p} not emitted`);
  // .inc files are only valid when loaded by their device file (!load)
  const outputs = parseOutputs(r.csv).filter((o) => o.path.endsWith('.csv'));
  assert.deepEqual(outputs.flatMap((o) => o.parsed.errors.map((e) => `${o.path}:${e.line} ${e.message}`)).slice(0, 5), []);
  // the compiled definitions decode the simulated traffic like the CDN files
  const { selectCompiled } = await import('../src/tsp/outputs.ts');
  const { DecodingService } = await import('../src/decoding.ts');
  const { TelegramStore } = await import('../src/store/telegram-store.ts');
  const { parseGrabResult, parseScanResult } = await import('../src/ebusd/protocol.ts');
  const { simulatedTelegrams } = await import('../tools/fake-ebusd.mjs');
  const { ebusdText } = await import('../src/defs/fields.ts');
  const devices = parseScanResult(['08;Vaillant;HMU00;0308;0403', '15;Vaillant;CTLV2;0507;1704', '76;Vaillant;VWZ00;0308;0403']);
  const selected = selectCompiled(r.csv, devices);
  console.log(`selected for the devices: ${selected.map((f) => f.path).join(', ')}`);
  const store = new TelegramStore();
  store.ingest(parseGrabResult(simulatedTelegrams(0).map((l: { m: string; s: string | null; c: number }) => `${l.m}${l.s ? ` / ${l.s}` : ''} = ${l.c}`)), { now: 1 });
  const svc = new DecodingService();
  svc.setFiles(selected);
  svc.setDevices(devices);
  svc.update(store.entries());
  const decoded = (key: string) => {
    const d = svc.get(key);
    return d ? `${d.def.circuit}.${d.def.name}=${ebusdText(d.result.fields)}` : 'unknown';
  };
  assert.equal(decoded('3108b51a05ff3220'), 'hmu.FlowTemp=35.00');
  assert.equal(decoded('1008b51101'), 'hmu.Status01=35.0;30.0;5.500;50.0;50.0;on');
  assert.equal(decoded('3115b524020000007300'), 'ctlv2.DisplayedOutsideTemp=5.5');
  if (cdn && existsSync(join(cdn, 'en/versions.json'))) {
    let same = 0;
    const differ: string[] = [];
    for (const o of outputs) {
      const ref = join(cdn, 'en', o.path);
      if (!existsSync(ref) || !o.path.endsWith('.csv')) continue;
      const refParsed = parseDefinitionFile(readFileSync(ref, 'utf8'), o.path, defaultsFor(o.path));
      const a = o.parsed.messages.map(summary).sort().join('\n');
      const b = refParsed.messages.map(summary).sort().join('\n');
      if (a === b) same++;
      else differ.push(`${o.path} (${o.parsed.messages.length} vs ${refParsed.messages.length} messages)`);
    }
    console.log(`compared with CDN: ${same} identical, ${differ.length} different${differ.length ? `: ${differ.slice(0, 10).join(', ')}` : ''}`);
    assert.ok(same > 0);
  }
  // German translations
  if (files['de.yaml']) {
    const de = await compileProject!({ files, entry: 'main.tsp', translations: 'de.yaml' }, libraries);
    const hmu = Object.entries(de.csv).find(([p]) => p.endsWith('vaillant/08.hmu.csv'));
    assert.ok(hmu && hmu[1] !== r.csv[hmu[0]], 'German output differs');
  }
});

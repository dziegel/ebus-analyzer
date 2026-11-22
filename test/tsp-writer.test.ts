import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parseDefinitionFile } from '../src/defs/definitions.ts';
import { identifier, pascalCase, suggestFileName, typeOf, writeTypeSpec } from '../src/tsp/writer.ts';
import { crc32, createZip } from '../src/util/zip.ts';
import { defaultEntry, readFileList, translationFile } from '../src/tsp/project.ts';

const HEADER = 'type,circuit,level,name,comment,qq,zz,pbsb,id,*name,part,type,divisor/values,unit,comment';

test('identifiers and types', () => {
  assert.equal(identifier('Wärme-Pumpe 2'), 'Waerme_Pumpe_2');
  assert.equal(identifier('2nd'), '_2nd');
  assert.equal(pascalCase('hmu'), 'Hmu');
  assert.deepEqual(typeOf('IGN:3'), { type: 'IGN', decorators: ['@maxLength(3)'] });
  assert.deepEqual(typeOf('STR:*'), { type: 'STR', decorators: ['@minLength(0)', '@maxLength(16)'] });
  assert.deepEqual(typeOf('HEX'), { type: 'HEX', decorators: [] });
  assert.deepEqual(typeOf('BI0:7'), { type: 'BI0_7', decorators: [] });
  assert.equal(typeOf('BI2:3').type, 'BI2');
  assert.deepEqual(typeOf('BCD:2'), { type: 'BCD2', decorators: [] });
  assert.deepEqual(typeOf('BDA:3'), { type: 'BDA3', decorators: [] });
  assert.deepEqual(typeOf('TEM_P'), { type: 'Contrib.TEM_P', decorators: [] });
});

test('writes TypeSpec from definitions', () => {
  const csv = [
    HEADER,
    'r,,,FlowTemp,current flow temperature,,,b51a,05ff3220,ign,,IGN:3,,,,value,,D2C,,°C,temperature',
    'w,,install,SetMode,,,,b509,0e0100,mode,,UCH,0=off;1=on;2=auto,,',
    'r,,,Mixed,,,,b509,0d0200,id,m,UCH,,,,v,,UIN,-10,,',
    'u,Broadcast,,Outside,,,fe,b516,01,value,,D2B,,°C,',
    'r,,,FlowTemp,duplicate name,,,b51a,05ff3221,value,,UCH,,,',
  ].join('\n');
  const f = parseDefinitionFile(csv, 'vaillant/08.hmu.csv', { zz: '08', circuit: 'hmu' });
  assert.deepEqual(f.errors, []);
  const tsp = writeTypeSpec(f.messages, { manufacturer: 'Vaillant' });
  assert.match(tsp, /^import "@ebusd\/ebus-typespec";\nusing Ebus;/);
  assert.match(tsp, /namespace Vaillant;/);
  assert.match(tsp, /@zz\(0x08\)\nnamespace Hmu \{/);
  assert.match(tsp, /\/\*\* current flow temperature \*\/\n  @id\(0xb5, 0x1a, 0x05, 0xff, 0x32, 0x20\)\n  model FlowTemp \{\n    @maxLength\(3\)\n    ign: IGN;\n\n    \/\*\* temperature \*\/\n    @unit\("°C"\)\n    value: D2C;\n  \}/);
  assert.match(tsp, /@write\n  @auth\("install"\)\n  model SetMode \{\n    @values\(Values_SetMode_mode\)\n    mode: UCH;/);
  assert.match(tsp, /enum Values_SetMode_mode \{\n    off: 0,\n    on: 1,\n    auto: 2,\n  \}/);
  // master field in a read message is @out, factor for negative divisors
  assert.match(tsp, /model Mixed \{\n    @out\n    id: UCH;\n\n    @factor\(10\)\n    v: UIN;/);
  // broadcast circuit: own namespace with its zz, passive, no @out for master data
  assert.match(tsp, /\nnamespace Broadcast \{\n  @id\(0xb5, 0x16, 0x01\)\n  @passive\n  @zz\(0xfe\)\n  model Outside \{\n    @unit\("°C"\)\n    value: D2B;/);
  assert.match(tsp, /renamed from FlowTemp \(r\)[^\n]*\n  model FlowTemp_1 \{/);
  assert.equal(suggestFileName(f.messages), '08.hmu.tsp');
});

test('zip archives can be read by unzip', () => {
  assert.equal(crc32(new TextEncoder().encode('hello')), 0x3610a686);
  const zip = createZip([['a.tsp', 'model A {}\n'], ['vaillant/08.hmu.csv', 'r,,,X\n']]);
  const dir = mkdtempSync(join(tmpdir(), 'zip-'));
  writeFileSync(join(dir, 'x.zip'), zip);
  try {
    const listing = execFileSync('python3', ['-c', 'import sys,zipfile;z=zipfile.ZipFile(sys.argv[1]);z.testzip();print("|".join(i.filename for i in z.infolist()));print(z.read("vaillant/08.hmu.csv").decode())', join(dir, 'x.zip')], { encoding: 'utf8' });
    assert.match(listing, /a\.tsp\|vaillant\/08\.hmu\.csv\nr,,,X/);
  } catch (err) {
    if ((err as { code?: string }).code === 'ENOENT') return; // python not available
    throw err;
  }
  assert.ok(readFileSync(join(dir, 'x.zip')).length > 0);
});

test('project helpers', async () => {
  const files = new Map([['vaillant/08.hmu.tsp', ''], ['main.tsp', ''], ['de.yaml', '']]);
  assert.equal(defaultEntry(files), 'main.tsp');
  assert.equal(defaultEntry(files, 'vaillant/08.hmu.tsp'), 'vaillant/08.hmu.tsp');
  assert.equal(defaultEntry(new Map([['b.tsp', ''], ['a.tsp', '']])), 'a.tsp');
  assert.equal(translationFile(files, 'de'), 'de.yaml');
  assert.equal(translationFile(files, 'en'), undefined);
  const mk = (path: string, text: string) => Object.assign(new File([text], path.split('/').pop()!), { webkitRelativePath: path });
  const p = await readFileList([mk('src/main.tsp', 'm'), mk('src/vaillant/a.tsp', 'a'), mk('src/node_modules/x.tsp', 'x'), mk('src/readme.md', 'r'), mk('src/.git/y.tsp', 'y')]);
  assert.equal(p.name, 'src');
  assert.deepEqual([...p.files.keys()], ['main.tsp', 'vaillant/a.tsp']);
});

test('broadcasts get @zz on each model', () => {
  const csv = `${HEADER}\nu,broadcast,,Info,,,fe,b516,08,text,,STR:5,,,`;
  const tsp = writeTypeSpec(parseDefinitionFile(csv, 'x.csv', {}).messages, { manufacturer: 'Vaillant' });
  assert.match(tsp, /\nnamespace Broadcast \{\n  @id\(0xb5, 0x16, 0x08\)\n  @passive\n  @zz\(0xfe\)\n  model Info/);
  assert.doesNotMatch(tsp, /^@zz/m);
});

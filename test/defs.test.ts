import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixed, general } from '../src/defs/datatypes.ts';
import { parseDefinitionFile } from '../src/defs/definitions.ts';
import { createFields, decodeFields, ebusdText } from '../src/defs/fields.ts';
import { DefinitionLoader, localFile, parseMapping, type Cache } from '../src/defs/loader.ts';
import { DefinitionSet, type LoadedFile, type MatchContext } from '../src/defs/repository.ts';
import { commonFiles, parseFilename, selectDeviceFile } from '../src/defs/select.ts';
import { evaluateCheck, parseCheck, splitConditions } from '../src/defs/conditions.ts';
import { parseTelegram } from '../src/ebus/telegram.ts';
import { hexToBytes } from '../src/ebus/hex.ts';
import { DecodingService } from '../src/decoding.ts';
import { TelegramStore } from '../src/store/telegram-store.ts';
import { parseGrabResult } from '../src/ebusd/protocol.ts';

const HEADER = 'type,circuit,level,name,comment,qq,zz,pbsb,id,*name,part,type,divisor/values,unit,comment';

function decode(def: string, master: string, slave = '', isWrite = false, masterDst = false): string {
  const cols = def.split(',');
  const fields = [];
  for (let i = 0; i < cols.length; i += 6) {
    const [name = '', part = '', type = '', divisorValues = '', unit = '', comment = ''] = cols.slice(i, i + 6);
    fields.push(...createFields({ name, part, type, divisorValues, unit, comment }, isWrite, masterDst));
  }
  const r = decodeFields(fields, hexToBytes(master), slave ? hexToBytes(slave) : undefined, 0);
  return r.error ? `ERR ${r.error}` : ebusdText(r.fields);
}

test('number formatting follows iostreams', () => {
  assert.equal(fixed(0.125, 2), '0.12'); // ties to even like printf
  assert.equal(fixed(0.375, 2), '0.38');
  assert.equal(fixed(35.0625, 2), '35.06');
  assert.equal(general(12345670), '1.23457e+07');
  assert.equal(general(0.5), '0.5');
  assert.equal(general(0.00001234), '1.234e-05');
});

test('decodes common types', () => {
  assert.equal(decode('t,,D2C', '', '3002'), '35.00');
  assert.equal(decode('t,,D1C', '', '46'), '35.0');
  assert.equal(decode('t,,D2B', '', '8005'), '5.500'); // divisor 256: 3 decimals
  assert.equal(decode('t,,UCH,10', '', '7b'), '12.3');
  assert.equal(decode('t,,UCH,-5', '', '0c'), '60');
  assert.equal(decode('t,,UCH', '', 'ff'), '-');
  assert.equal(decode('t,,UCH,0=off;1=on', '', '01'), 'on');
  assert.equal(decode('t,,UCH,0=off;1=on', '', '05'), '5');
  assert.equal(decode('t,,EXP', '', '0000b040'), '5.5');
  assert.equal(decode('t,,ULG', '', '40e20100'), '123456');
  assert.equal(decode('t,,BTI,,,,d,,BDA', '', '0030141811032' + '6'), '14:30:00;18.11.2026');
  assert.equal(decode('t,,TTM', '', '57'), '14:30');
  assert.equal(decode('t,,HTM', '', '0e1e'), '14:30');
  assert.equal(decode('t,,PIN', '', '0308'), '0308');
  assert.equal(decode('t,,STR:5', '', '484d553030'), 'HMU00');
  assert.equal(decode('t,,HEX:3', '', '0a0b0c'), '0a 0b 0c');
  assert.equal(decode('t,,IGN:2,,,,v,,UCH', '', 'ffff07'), '7');
  assert.equal(decode('t,,D1C', '', 'c9').startsWith('ERR'), true);
  assert.equal(decode('t,,UIN', '', '01').startsWith('ERR'), true); // not enough data
});

test('bit fields share bytes like ebusd', () => {
  assert.equal(decode('a,,BI0,,,,b,,BI1,,,,c,,BI7,,,,d,,UCH', '', '8305'), '1;1;1;5');
  assert.equal(decode('a,,BI0,,,,b,,BI0', '', '0100'), '1;0'); // same first bit: next byte
  assert.equal(decode('a,,BI4:3', '', '50'), '5');
});

test('parses definition files with defaults, conditions, loads and chains', () => {
  const csv = [
    HEADER,
    '*r,',
    '*[id_sw],scan,,,,SW',
    '*[mode],,,Mode,,value',
    'r,,,FlowTemp,flow temperature,,,b51a,05ff3220,ign,,IGN:3,,,,value,,D2C,,°C,temperature',
    '[id_sw>=200]r,,,NewFlow,,,,b509,0d0100,value,,UCH,,,',
    'w,,install,SetValue,,,,b509,0e0100,value,,UCH,,,',
    'u,Broadcast,,Outside,,,fe,b516,01,value,,D2B,,°C,',
    'r,,,Chained,,,,b509,24;25,a,,STR:2,,,,b,,STR:2,,,',
    '[mode=2]!load,extra.inc,,,',
    'r,,,Broken,,,,b5,01,value,,UCH,,,',
  ].join('\n');
  const f = parseDefinitionFile(csv, 'vaillant/08.hmu.csv', { zz: '08', circuit: 'hmu' });
  assert.deepEqual(f.errors.map((e) => e.line), [11]);
  assert.equal(f.messages.length, 5);
  const [flow, newFlow, set, outside, chained] = f.messages;
  assert.equal(flow!.circuit, 'hmu');
  assert.deepEqual(flow!.zz, [0x08]);
  assert.deepEqual(flow!.id, [0x05, 0xff, 0x32, 0x20]);
  assert.equal(flow!.fields[1]!.part, 's');
  assert.deepEqual(newFlow!.conditions, [{ name: 'id_sw', check: { op: '>=', values: [{ num: 200 }] } }]);
  assert.equal(set!.type, 'w');
  assert.equal(set!.level, 'install');
  assert.equal(set!.fields[0]!.part, 'm');
  assert.equal(outside!.circuit, 'Broadcast');
  assert.equal(outside!.fields[0]!.part, 'm'); // broadcast destination
  assert.deepEqual(chained!.chain, [[0x24], [0x25]]);
  assert.equal(f.conditions.length, 2);
  assert.equal(f.conditions[0]!.fileZz, 0x08);
  assert.deepEqual(f.loads[0]!.conditions[0]!.name, 'mode');
});

test('conditions', () => {
  const { refs, rest } = splitConditions("[a>=104][b='User Level';'Expert']r");
  assert.equal(rest, 'r');
  assert.equal(refs.length, 2);
  assert.equal(evaluateCheck(refs[0]!.check!, { num: 308, text: '0308' }), true);
  assert.equal(evaluateCheck(refs[1]!.check!, { text: 'expert' }), true);
  assert.equal(evaluateCheck(parseCheck('=1-5'), { num: 6, text: '6' }), false);
  assert.equal(evaluateCheck(parseCheck('<=140'), undefined), undefined);
});

test('file names and device file selection', () => {
  assert.deepEqual(parseFilename('08.hmu.HW5103.csv'), { zz: '08', ident: 'hmu', circuit: 'hmu', suffix: '', hw: 5103 });
  assert.deepEqual(parseFilename('26.vr_70.mc.4.csv'), { zz: '26', ident: 'vr_70', circuit: 'mc', suffix: '.4' });
  assert.equal(parseFilename('broadcast.csv'), undefined);
  const paths = ['broadcast.csv', 'vaillant/08.hmu.csv', 'vaillant/08.hmu.HW5103.csv', 'vaillant/08.bai.csv', 'vaillant/scan.csv', 'vaillant/_templates.csv', 'wolf/08.x.csv'];
  const hmu = { address: 8, manufacturer: 'Vaillant', deviceId: 'HMU00', sw: '0308', hw: '0403' };
  assert.equal(selectDeviceFile(hmu, paths), 'vaillant/08.hmu.csv');
  assert.equal(selectDeviceFile({ ...hmu, hw: '5103' }, paths), 'vaillant/08.hmu.HW5103.csv');
  assert.equal(selectDeviceFile({ ...hmu, deviceId: 'XYZ00' }, paths), undefined);
  assert.deepEqual(commonFiles(paths, ['Vaillant']), ['broadcast.csv', 'vaillant/scan.csv']);
});

function file(path: string, csv: string, defaults: { zz?: string; circuit?: string }, local = false): LoadedFile {
  const parsed = parseDefinitionFile(csv, path, defaults, { local });
  return { path, local, parsed, conditionScope: parsed.conditions };
}

const CTX: MatchContext = {
  scan: (a) => (a === 8 ? { address: 8, manufacturer: 'Vaillant', deviceId: 'HMU00', sw: '0308', hw: '0403' } : undefined),
  value: () => undefined,
};

test('matches telegrams by command, address, ID and conditions', () => {
  const hmu = file(
    'vaillant/08.hmu.csv',
    [
      HEADER,
      '*[id_sw],scan,,,,SW',
      'r,,,FlowTemp,,,,b51a,05ff3220,ign,,IGN:3,,,,value,,D2C,,°C,',
      '[id_sw<300]r,,,Old,,,,b509,0d01,value,,UCH,,,',
      '[id_sw>=300]r,,,New,,,,b509,0d01,value,,UCH,10,,',
      'r,,,Short,,,,b509,0d,value,,HEX:*,,,',
    ].join('\n'),
    { zz: '08', circuit: 'hmu' },
  );
  const set = new DefinitionSet([hmu]);
  const flow = set.decode(parseTelegram('3108b51a0405ff3220', '0500000030' + '02'), CTX)!;
  assert.equal(flow.def.name, 'FlowTemp');
  assert.equal(ebusdText(flow.result.fields), '35.00');
  assert.equal(flow.result.fields[1]!.offset, 3);

  const reg = set.decode(parseTelegram('1008b509020d01', '017b'), CTX)!;
  assert.equal(reg.def.name, 'New'); // id_sw = 308
  assert.equal(reg.condition, 'true');
  assert.equal(reg.alternatives, 1); // Short matches too, but has a shorter ID
  assert.equal(ebusdText(reg.result.fields), '12.3');

  assert.equal(set.decode(parseTelegram('1015b51a0405ff3220', '0500000030' + '02'), CTX), undefined); // wrong target

  const local = file('mine.csv', [HEADER, 'r,hmu,,Mine,,,08,b509,0d01,value,,UCH,,,'].join('\n'), {}, true);
  const withLocal = new DefinitionSet([hmu, local]);
  assert.equal(withLocal.decode(parseTelegram('1008b509020d01', '017b'), CTX)!.def.name, 'Mine');
});

test('decoding service resolves message conditions and chains', () => {
  const defs = file(
    'vaillant/08.bai.csv',
    [
      HEADER,
      '*[mode],,,Mode,,value',
      'r,,,Mode,,,,b509,0d0001,value,,UCH,,,',
      '[mode=1]r,,,ValueA,,,,b509,0d0002,value,,UCH,,,',
      '[mode=2]r,,,ValueB,,,,b509,0d0002,value,,UCH,,,',
      'r,,,Id,,,,b509,24;25,a,,STR:2,,,,b,,STR:2,,,',
    ].join('\n'),
    { zz: '08', circuit: 'bai' },
  );
  const store = new TelegramStore();
  store.ingest(parseGrabResult(['1008b509030d0002 / 0105', '1008b509030d0001 / 0102', '1008b5090124 / 024142']), { now: 1 });
  const svc = new DecodingService();
  svc.setFiles([defs]);
  svc.update(store.entries());
  assert.equal(svc.get('1008b5090d0002')!.def.name, 'ValueB');
  const part = svc.get('1008b50924')!;
  assert.deepEqual(part.chain, { index: 0, count: 2, complete: false });
  store.ingest(parseGrabResult(['1008b5090125 / 024344']), { now: 2 });
  svc.invalidate();
  svc.update(store.entries());
  const full = svc.get('1008b50924')!;
  assert.equal(full.chain!.complete, true);
  assert.equal(ebusdText(full.result.fields), 'AB;CD');
});

test('loader picks files, follows !load and falls back to the cache', async () => {
  const root = 'https://cdn.test/en/';
  const files: Record<string, string> = {
    [`${root}versions.json`]: JSON.stringify({ 'broadcast.csv': { hash: 'a' }, 'vaillant/08.hmu.csv': { hash: 'b' }, 'vaillant/x.inc': { hash: 'c' } }),
    'https://cdn.test/mapping.md': ' - [08.hmu.tsp](https://github.com/x/src/vaillant/08.hmu.tsp) &rarr; [en: 08.hmu.csv](en/vaillant/08.hmu.csv) / [de: 08.hmu.csv](de/vaillant/08.hmu.csv)\n - [x_inc.tsp](https://github.com/x/src/vaillant/x_inc.tsp) &rarr; inlined in/loaded by other file(s)',
    [`${root}broadcast.csv`]: `${HEADER}\nu,Broadcast,,Outside,,,fe,b516,01,value,,D2B,,°C,`,
    [`${root}vaillant/08.hmu.csv`]: `${HEADER}\n*[id_sw],scan,,,,SW\n[id_sw>=100]!load,x.inc,,,\nr,,,FlowTemp,,,,b51a,05ff3220,ign,,IGN:3,,,,value,,D2C,,°C,`,
    [`${root}vaillant/x.inc`]: `${HEADER}\nr,,,Extra,,,,b509,0d0102,value,,UCH,,,`,
  };
  let online = true;
  const fetched: string[] = [];
  const fetchText = async (url: string) => {
    fetched.push(url);
    if (!online) throw new Error('offline');
    const t = files[url];
    if (t === undefined) throw new Error(`404 ${url}`);
    return t;
  };
  const map = new Map<string, unknown>();
  const cache: Cache = { get: async (k) => map.get(k) as never, set: async (k, v) => void map.set(k, v) };
  const loader = new DefinitionLoader(cache, fetchText);
  const devices = [
    { address: 8, manufacturer: 'Vaillant', deviceId: 'HMU00', sw: '0308', hw: '0403' },
    { address: 0x15, manufacturer: 'Vaillant', deviceId: 'ABC', sw: '0100', hw: '0100' },
  ];
  const src = { baseUrl: 'https://cdn.test/', channel: '' as const, language: 'en' as const };
  const report = await loader.load(devices, src);
  assert.deepEqual(report.files.map((f) => f.path), ['vaillant/08.hmu.csv', 'vaillant/x.inc', 'broadcast.csv']);
  assert.equal(report.unmatched[0]!.deviceId, 'ABC');
  assert.equal(report.files[0]!.sourceUrl, 'https://github.com/x/src/vaillant/08.hmu.tsp');
  assert.equal(report.files[1]!.sourceUrl, 'https://github.com/x/src/vaillant/x_inc.tsp');
  const inc = report.files[1]!;
  assert.equal(inc.parsed.messages[0]!.circuit, 'hmu'); // defaults of the loading file
  assert.deepEqual(inc.parsed.messages[0]!.zz, [8]);
  assert.equal(inc.parsed.messages[0]!.conditions[0]!.name, 'id_sw');

  const set = new DefinitionSet(report.files);
  const ctx: MatchContext = { scan: (a) => devices.find((d) => d.address === a), value: () => undefined };
  assert.equal(set.decode(parseTelegram('1008b509030d0102', '0107'), ctx)!.def.name, 'Extra');

  // second load: unchanged hashes come from the cache
  fetched.length = 0;
  await loader.load(devices, src);
  assert.deepEqual(fetched, [`${root}versions.json`]);
  online = false;
  const offline = await loader.load(devices, src);
  assert.equal(offline.offline, true);
  assert.equal(offline.files.length, 3);
});

test('mapping.md and local files', () => {
  const m = parseMapping('[a.tsp](https://x/a.tsp) &rarr; [en: a.csv](en/v/15.a.csv) / [de: a.csv](de/v/15.a.csv)');
  assert.equal(m.get('v/15.a.csv'), 'https://x/a.tsp');
  const lf = localFile('15.test.csv', `${HEADER}\nr,,,Foo,,,,b509,0d0102,value,,UCH,,,`);
  assert.equal(lf.local, true);
  assert.equal(lf.parsed.messages[0]!.circuit, 'test');
  assert.deepEqual(lf.parsed.messages[0]!.zz, [0x15]);
  assert.equal(lf.parsed.messages[0]!.local, true);
});

// Live-test commands (M6). With EBUSD_BIN set to an ebusd binary, the commands
// are checked against a real ebusd (started without a bus, telegrams injected).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { connect } from 'node:net';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDraft, type Draft, type DraftField } from '../src/assistant/draft.ts';
import {
  decodeChecks,
  defineCommand,
  ebusdDefinition,
  ebusdFieldList,
  explainError,
  findCommand,
  hexOfSample,
  parseFieldList,
  parseFind,
  parseHexTelegram,
  quoteArg,
  readCommand,
  readProblem,
  splitArgs,
} from '../src/ebusd/live.ts';
import { readValue } from '../src/defs/fields.ts';
import { parseGrabResult } from '../src/ebusd/protocol.ts';
import { TelegramStore } from '../src/store/telegram-store.ts';

const T0 = 1_700_000_000_000;

function store(lines: string[]): TelegramStore {
  const s = new TelegramStore();
  lines.forEach((l, i) => s.ingest(parseGrabResult([`${l} = ${i + 1}`]), { now: T0 + i * 1000 }));
  return s;
}

const REGISTER = ['1008b509030d5501 / 0401600181', '1008b509030d5501 / 0401700105', '1008b509030d5501 / 0401f0ff01'];
const SETMODE = ['1008b5100900281e00ff000100ff'];
const BROADCAST = ['10feb5160301803f', '10feb51603010040'];
const IDENT = ['1015b5090124 / 05484d553030'];

/** The entry for a key, or the only entry of the store. */
const entry = (s: TelegramStore, key?: string) => (key ? s.get(key)! : s.entries()[0]!);

function draft(s: TelegramStore, key: string | undefined, fields: DraftField[], extra: Partial<Draft> = {}): Draft {
  return { ...createDraft(entry(s, key), { circuit: () => 'hmu', now: 1 }), name: 'Test', fields, ...extra };
}

test('splits and quotes command arguments like ebusd', () => {
  assert.deepEqual(splitArgs("define 'a b,c'"), ['define', 'a b,c']);
  assert.deepEqual(splitArgs('define  "a  b" x'), ['define', 'a  b', 'x']);
  assert.deepEqual(splitArgs("read -def 'x'"), ['read', '-def', 'x']);
  assert.equal(quoteArg('abc'), 'abc');
  assert.equal(quoteArg('a b'), "'a b'");
  assert.equal(quoteArg("it's a"), "'it's a'"); // inner quote does not end the argument
  assert.equal(quoteArg("a b'"), "'a b''"); // ebusd strips one quote at the end
  assert.equal(quoteArg("a' b"), `"a' b"`);
  assert.throws(() => quoteArg(`a' c" b`));
  assert.throws(() => quoteArg('a\nb'));
  for (const s of ['x', "it's  two", 'a,b;c=d °C', "'lead"]) assert.deepEqual(splitArgs(`cmd ${quoteArg(s)}`), ['cmd', s]);
});

test('builds ebusd definitions and commands for drafts (CON-8)', () => {
  const s = store(REGISTER);
  const d = draft(s, '1008b5090d5501', [
    { name: 'temp', part: 's', offset: 1, type: 'D2C', unit: '°C', comment: 'not sent' },
    { name: 'pump', part: 's', offset: 3, type: 'BI0', values: '0=off;1=on' },
  ], { comment: 'neither' });
  assert.equal(ebusdDefinition(d), 'r,hmu,Test,,,08,b509,0d5501,,s,IGN:1,,,,temp,s,D2C,,°C,,pump,s,BI0,0=off;1=on,,');
  assert.equal(defineCommand(d), `define ${ebusdDefinition(d)}`);
  assert.equal(defineCommand({ ...d, fields: [{ ...d.fields[0]!, unit: 'deg C' }] }, true), `define -r 'r,hmu,Test,,,08,b509,0d5501,,s,IGN:1,,,,temp,s,D2C,,deg C,'`);
  assert.equal(readCommand(d), `read -def ${ebusdDefinition(d)}`);
  assert.equal(findCommand(d), 'find -c hmu Test');
  assert.deepEqual(parseFind(['hmu Test = 22.00;on'], d), { value: '22.00;on' });
  assert.deepEqual(parseFind(['hmu Test = no data stored'], d), { noData: true });
  assert.deepEqual(parseFind(['ERR: element not found'], d), { notFound: true });
  const checks = decodeChecks(d, s.get('1008b5090d5501')!, s.get('1008b5090d5501')!.history[0]!);
  assert.deepEqual(checks, [{ part: 's', command: `decode IGN:1,,,,D2C,,°C,,BI0,0=off;1=on,, 01600181`, expected: '22.00;on' }]);
  // field lists parse back (used by the fake ebusd)
  const fl = parseFieldList(ebusdFieldList(d, 's'), 's');
  assert.deepEqual(fl.map((f) => f.typeName), ['IGN:1', 'D2C', 'BI0']);
  assert.equal((readValue(fl[1]!, new Uint8Array([1, 0x60, 1, 0x81]), 1, 2) as { text: string }).text, '22.00');
  // reading needs a read draft to a slave without master fields
  assert.equal(readProblem(d), undefined);
  assert.match(readProblem({ ...d, direction: 'w' })!, /only drafts with direction "r"/);
  assert.match(readProblem({ ...d, fields: [...d.fields, { name: 'x', part: 'm', offset: 3, type: 'UCH' }] })!, /master data/);
  const bc = draft(store(BROADCAST), '10feb51601', [{ name: 'out', part: 'm', offset: 1, type: 'D2B' }]);
  assert.match(readProblem(bc)!, /slave/);
  assert.deepEqual(decodeChecks(bc, store(BROADCAST).get('10feb51601')!, store(BROADCAST).get('10feb51601')!.history[0]!).map((c) => [c.command, c.expected]), [
    ['decode -m IGN:1,,,,D2B,,, 01803f', '63.500'],
  ]);
});

test('checks hex telegrams (CON-7)', () => {
  assert.deepEqual(parseHexTelegram('08 b5 09 03 0d 55 01'), { hex: '08b509030d5501', zz: 8, pb: 0xb5, sb: 9, data: new Uint8Array([0x0d, 0x55, 0x01]) });
  assert.match((parseHexTelegram('08b5090d5501') as { error: string }).error, /NN is 13, but 2 data byte/);
  assert.match((parseHexTelegram('08b5') as { error: string }).error, /At least/);
  assert.match((parseHexTelegram('xy') as { error: string }).error, /hex bytes/);
  const s = store(REGISTER);
  assert.equal(hexOfSample(s.get('1008b5090d5501')!, s.get('1008b5090d5501')!.history[0]!), '08b509030d5501');
  assert.match(explainError('ERR: command "hex" blocked by bridge (start bridge with --allow-write)', 'hex 08')!, /--allow-write/);
  assert.match(explainError('ERR: command not enabled', 'hex 08')!, /--enablehex/);
  assert.match(explainError('ERR: option not enabled', 'read -def x')!, /--enabledefine/);
});

// ---------------------------------------------------------------------------
// Against a real ebusd

const bin = process.env.EBUSD_BIN;
const skip = bin ? false : 'EBUSD_BIN not set';
const PORT = 18889;
let ebusd: ChildProcess | undefined;

before(async () => {
  if (!bin) return;
  const cfg = mkdtempSync(join(tmpdir(), 'ebusd-cfg-'));
  ebusd = spawn(bin, ['-f', '-d', '127.0.0.1:9', '-n', '-c', cfg, '--scanconfig=none', '--enablehex', '--enabledefine', '-p', String(PORT)], { stdio: 'ignore' });
  for (let i = 0; i < 50; i++) {
    try {
      await command('info');
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  throw new Error('ebusd did not start');
});

after(() => ebusd?.kill());

/** Sends commands over one connection; answers end with an empty line. */
function command(...cmds: string[]): Promise<string[][]> {
  return new Promise((resolve, reject) => {
    const sock = connect(PORT, '127.0.0.1');
    const answers: string[][] = [];
    let buf = '';
    sock.setEncoding('utf8');
    sock.on('error', reject);
    sock.on('connect', () => sock.write(cmds[0] + '\n'));
    sock.on('data', (d) => {
      buf += d;
      let p;
      while ((p = buf.indexOf('\n\n')) >= 0) {
        answers.push(buf.slice(0, p).split('\n'));
        buf = buf.slice(p + 2);
        if (answers.length === cmds.length) {
          sock.end();
          resolve(answers);
        } else sock.write(cmds[answers.length] + '\n');
      }
    });
  });
}

test('ebusd decodes drafts like the app (ASS-8)', { skip }, async () => {
  const cases: Array<[string[], string | undefined, DraftField[]]> = [
    [REGISTER, '1008b5090d5501', [
      { name: 'temp', part: 's', offset: 1, type: 'D2C', unit: '°C' },
      { name: 'pump', part: 's', offset: 3, type: 'BI0', values: '0=off;1=on' },
      { name: 'burner', part: 's', offset: 3, type: 'BI2' },
    ]],
    [REGISTER, '1008b5090d5501', [{ name: 'a', part: 's', offset: 0, type: 'UCH' }, { name: 'b', part: 's', offset: 1, type: 'UIN', divisor: 10 }, { name: 'c', part: 's', offset: 3, type: 'SCH', divisor: -2 }]],
    [REGISTER, '1008b5090d5501', [{ name: 'x', part: 's', offset: 2, type: 'HTM' }, { name: 'y', part: 's', offset: 0, type: 'D1C' }]],
    [SETMODE, undefined, [
      { name: 'mode', part: 'm', offset: 0, type: 'UCH', values: '0=auto;1=day;2=night' },
      { name: 'flow', part: 'm', offset: 1, type: 'D1C' },
      { name: 'hwc', part: 'm', offset: 2, type: 'D1C' },
      { name: 'dis', part: 'm', offset: 6, type: 'BI0' },
      { name: 'rel', part: 'm', offset: 6, type: 'BI1' },
    ]],
    [BROADCAST, '10feb51601', [{ name: 'out', part: 'm', offset: 1, type: 'D2B', unit: '°C' }]],
    [IDENT, '1015b50924', [{ name: 'id', part: 's', offset: 0, type: 'STR:3' }, { name: 'ver', part: 's', offset: 3, type: 'HEX:2' }]],
  ];
  for (const [lines, key, fields] of cases) {
    const s = store(lines);
    const e = entry(s, key);
    const d = draft(s, key, fields);
    if (!key) d.id = [];
    for (const sample of e.history) {
      for (const c of decodeChecks(d, e, sample)) {
        const [answer] = await command(c.command);
        if (c.error) assert.match(answer![0]!, /^ERR: /, `${c.command}: ${c.expected}`);
        else assert.equal(answer!.join('\n'), c.expected, c.command);
      }
    }
  }
});

test('ebusd accepts drafts via define and decodes their telegrams (CON-8)', { skip }, async () => {
  const s = store(REGISTER);
  const d = draft(s, '1008b5090d5501', [
    { name: 'temp', part: 's', offset: 1, type: 'D2C', unit: 'deg C' },
    { name: 'pump', part: 's', offset: 3, type: 'BI0', values: '0=off;1=on' },
  ], { name: 'Live', comment: "it's a test" });
  const e = s.get('1008b5090d5501')!;
  const [def, before, inj, found, dup, replaced, read] = await command(
    defineCommand(d),
    findCommand(d),
    `inject 1008b509030d5501/04${e.history[0]!.slave}`,
    findCommand(d),
    defineCommand(d),
    defineCommand(d, true),
    readCommand({ ...d, name: 'Live2' }),
  );
  assert.deepEqual(def, ['done']);
  assert.deepEqual(parseFind(before!, d), { noData: true });
  assert.deepEqual(inj, ['done']);
  assert.deepEqual(parseFind(found!, d), { value: decodeChecks(d, e, e.history[0]!)[0]!.expected });
  assert.match(dup![0]!, /duplicate entry/);
  assert.match(explainError(dup![0]!, 'define')!, /already has a message/);
  assert.deepEqual(replaced, ['done']);
  // without a bus the read request fails after ebusd accepted the definition
  assert.match(read![0]!, /^ERR: no signal/);
  assert.match(explainError(read![0]!, 'read -def')!, /no signal/);
});

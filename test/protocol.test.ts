import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ResponseSplitter,
  isError,
  parseGrabLine,
  parseGrabResult,
  parseInfo,
  parseScanResult,
} from '../src/ebusd/protocol.ts';

test('parses master-slave grab line with count', () => {
  assert.deepEqual(parseGrabLine('1008b507010a / 03828202 = 1'), {
    masterHex: '1008b507010a',
    slaveHex: '03828202',
    count: 1,
  });
});

test('parses broadcast grab line without slave part', () => {
  assert.deepEqual(parseGrabLine('10feb5160800122014170311 = 23'), {
    masterHex: '10feb5160800122014170311',
    count: 23,
  });
});

test('keeps text that ebusd appends after the count', () => {
  assert.deepEqual(parseGrabLine('1008b5110100 / 09d90113000008000100 = 6: hmu Status01'), {
    masterHex: '1008b5110100',
    slaveHex: '09d90113000008000100',
    count: 6,
    extra: 'hmu Status01',
  });
});

test('ignores lines that are not telegrams', () => {
  assert.equal(parseGrabLine('ERR: element not found'), undefined);
  assert.equal(parseGrabLine(''), undefined);
  assert.equal(parseGrabLine('1008b5070 / 00'), undefined); // odd length
  assert.deepEqual(parseGrabResult(['done', '1008b507010a / 03828202 = 1']).length, 1);
});

test('parses scan result and skips status lines', () => {
  const devices = parseScanResult([
    '1 scan(s) still running',
    '08;Vaillant;HMU00;0308;0403',
    '76;Vaillant;VWZ00;0308;0403;extra',
  ]);
  assert.equal(devices.length, 2);
  assert.deepEqual(devices[0], { address: 0x08, manufacturer: 'Vaillant', deviceId: 'HMU00', sw: '0308', hw: '0403', extra: [] });
  assert.deepEqual(devices[1]!.extra, ['extra']);
});

test('parses info', () => {
  const info = parseInfo(['version: ebusd 25.1.p', 'signal: acquired', 'address 08: slave']);
  assert.equal(info.get('version'), 'ebusd 25.1.p');
  assert.equal(info.get('address 08'), 'slave');
});

test('detects errors', () => {
  assert.equal(isError(['ERR: command not enabled']), true);
  assert.equal(isError(['done']), false);
  assert.equal(isError([]), false);
});

test('splits responses at empty lines across chunks', () => {
  const responses: string[][] = [];
  const s = new ResponseSplitter((lines) => responses.push(lines));
  s.push('line1\r\nli');
  s.push('ne2\n\n');
  s.push('\n'); // empty response
  s.push('x\n');
  assert.deepEqual(responses, [['line1', 'line2'], []]);
  s.push('\n');
  assert.deepEqual(responses.at(-1), ['x']);
});

test('parses ebusd decoding hints (grab result decode, CON-5)', async () => {
  const { parseGrabDecode } = await import('../src/ebusd/protocol.ts');
  // real ebusd output (shortened)
  const answer = [
    '1008b509030d5501 / 0401600181 = 1',
    ' BCD:4 01600181=81016001',
    ' D2C   0160=1536.06, 6001=22.00, 0181=-2031.94',
    ' DAY   0160="17.04.1967", 6001="19.12.1900", 0181="03.06.1990"',
    ' HEX:4 01600181="01 60 01 81"',
    ' UCH   01=1, 60=96, 01=1, 81=129',
    '10f1b5050427000000 = 3',
    ' UCH   27=39, 00=0, 00=0, 00=0',
    ' TTM   27="06:30"',
  ];
  const [reg, mm] = parseGrabDecode(answer);
  assert.equal(reg!.masterHex, '1008b509030d5501');
  assert.equal(reg!.part, 's');
  assert.deepEqual(reg!.hints.find((h) => h.type === 'D2C')!.values, [
    { offset: 0, hex: '0160', text: '1536.06' },
    { offset: 1, hex: '6001', text: '22.00' },
    { offset: 2, hex: '0181', text: '-2031.94' },
  ]);
  assert.deepEqual(reg!.hints.find((h) => h.type === 'UCH')!.values.map((v) => v.offset), [0, 1, 2, 3]);
  assert.equal(reg!.hints.find((h) => h.type === 'HEX:4')!.values[0]!.text, '01 60 01 81');
  // master-master: the master data (incl. ID) is decoded
  assert.equal(mm!.part, 'm');
  assert.equal(mm!.count, 3);
  assert.deepEqual(mm!.hints.find((h) => h.type === 'UCH')!.values.map((v) => v.offset), [0, 1, 2, 3]);
  assert.equal(mm!.hints.find((h) => h.type === 'TTM')!.values[0]!.text, '06:30');
});

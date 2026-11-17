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

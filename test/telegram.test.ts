import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isMaster, isSlave, slaveOfMaster, telegramKind } from '../src/ebus/address.ts';
import { masterHex, messageKey, parseTelegram, payloadHex, slaveHex } from '../src/ebus/telegram.ts';

test('classifies addresses', () => {
  for (const m of [0x00, 0x10, 0x31, 0x71, 0xff, 0x03, 0xf7]) assert.equal(isMaster(m), true, m.toString(16));
  for (const s of [0x08, 0x15, 0x26, 0x76, 0x50]) assert.equal(isSlave(s), true, s.toString(16));
  assert.equal(isSlave(0xfe), false);
  assert.equal(slaveOfMaster(0x03), 0x08);
  assert.equal(slaveOfMaster(0x08), undefined);
  assert.equal(telegramKind(0xfe), 'broadcast');
  assert.equal(telegramKind(0x10), 'master-master');
  assert.equal(telegramKind(0x08), 'master-slave');
});

test('parses a master-slave telegram and round-trips its hex', () => {
  const t = parseTelegram('1008b509030d0f00', '0412345678');
  assert.equal(t.source, 0x10);
  assert.equal(t.target, 0x08);
  assert.equal(t.pb, 0xb5);
  assert.equal(t.sb, 0x09);
  assert.deepEqual([...t.masterData], [0x0d, 0x0f, 0x00]);
  assert.deepEqual([...t.slaveData!], [0x12, 0x34, 0x56, 0x78]);
  assert.equal(t.kind, 'master-slave');
  assert.equal(t.lengthMismatch, undefined);
  assert.equal(masterHex(t), '1008b509030d0f00');
  assert.equal(slaveHex(t), '0412345678');
});

test('flags length mismatches', () => {
  assert.equal(parseTelegram('1008b509050d0f00').lengthMismatch, true);
  assert.equal(parseTelegram('1008b509030d0f00', '05aabb').lengthMismatch, true);
});

test('rejects invalid telegrams', () => {
  assert.throws(() => parseTelegram('1008b5'));
  assert.throws(() => parseTelegram('zz08b50900'));
});

test('master-slave key includes the request data as ID', () => {
  const t = parseTelegram('1008b509030d0f00', '0412345678');
  assert.equal(messageKey(t), '1008b5090d0f00');
  assert.deepEqual(payloadHex(t), { master: '', slave: '12345678' });
});

test('broadcast key includes only the first data byte', () => {
  const a = parseTelegram('10feb516080012201417031125');
  const b = parseTelegram('10feb516080013201417031125');
  assert.equal(messageKey(a), '10feb51600');
  assert.equal(messageKey(a), messageKey(b));
  assert.equal(payloadHex(a).master, '12201417031125');
});

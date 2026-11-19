import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TelegramStore } from '../src/store/telegram-store.ts';
import { parseGrabResult, parseScanResult } from '../src/ebusd/protocol.ts';
import { applyView, involves, participantKey, participants } from '../src/ui/view.ts';

function store(): TelegramStore {
  const s = new TelegramStore();
  s.ingest(
    parseGrabResult([
      '1008b5110101 / 07493c0007646401 = 4', // 10 (CTLV2 master) -> 08 HMU
      '3115b524060200000073' + '00 / 08000000000000b040 = 2', // 31 (ebusd) -> 15 CTLV2
      '10feb516080012201417031125 = 9', // broadcast from 10
      '3108b51a0405ff3220 / 050000003002 = 5', // 31 -> 08
      '7176b5040100 / 0101 = 1', // 71 -> 76 VWZ (71 is VWZ's master)
    ]),
    { now: 1 },
  );
  return s;
}

const DEVICES = parseScanResult(['08;Vaillant;HMU00;0308;0403', '15;Vaillant;CTLV2;0507;1704', '76;Vaillant;VWZ00;0308;0403']);

test('master and slave address form one participant', () => {
  assert.equal(participantKey(0x10), 0x15);
  assert.equal(participantKey(0x15), 0x15);
  assert.equal(participantKey(0x31), 0x36);
  assert.equal(participantKey(0x08), 0x08);
  assert.equal(participantKey(0x03), 0x08);
});

test('participants: scanned devices first, then other addresses', () => {
  const parts = participants(store().entries(), DEVICES);
  assert.deepEqual(
    parts.map((p) => [p.key.toString(16), p.device?.deviceId ?? '-', p.addresses.map((a) => a.toString(16)).join('/'), p.messages]),
    [
      ['8', 'HMU00', '8', 2],
      ['15', 'CTLV2', '10/15', 3],
      ['76', 'VWZ00', '71/76', 1],
      ['36', '-', '31', 2],
    ],
  );
});

test('filter shows telegrams from/to the participant only', () => {
  const all = store().entries();
  const keys = (participant?: number) => applyView(all, { filter: 'all', sort: 'address', search: '', ...(participant !== undefined ? { participant } : {}) }).map((e) => e.key);
  assert.deepEqual(keys(0x15).sort(), ['1008b51101', '10feb51600', '3115b524020000007300'].sort());
  assert.deepEqual(keys(0x08).sort(), ['1008b51101', '3108b51a05ff3220'].sort());
  assert.deepEqual(keys(0x36).sort(), ['3108b51a05ff3220', '3115b524020000007300'].sort());
  assert.equal(keys().length, 5);
  // broadcasts are not "to" every participant
  assert.equal(all.filter((e) => involves(e, 0x08)).some((e) => e.target === 0xfe), false);
});

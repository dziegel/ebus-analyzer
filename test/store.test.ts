import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TelegramStore } from '../src/store/telegram-store.ts';
import { parseGrabResult } from '../src/ebusd/protocol.ts';
import { applyView } from '../src/ui/view.ts';
import { varyingBytes } from '../src/ui/format.ts';

const T0 = 1_700_000_000_000;

test('adds new messages flagged as new', () => {
  const store = new TelegramStore();
  const stats = store.ingest(parseGrabResult(['1008b509030d0f00 / 0412345678 = 3', '10feb516080012201417031125 = 1']), { now: T0 });
  assert.deepEqual(stats, { added: 2, changed: 0, invalid: 0 });
  const e = store.get('1008b5090d0f00')!;
  assert.equal(e.isNew, true);
  assert.equal(e.count, 3);
  assert.equal(e.known, undefined);
  assert.equal(e.history.length, 1);
});

test('tracks counts, interval, payload changes and known flag', () => {
  const store = new TelegramStore();
  const unknownMasters = new Set(['1008b509030d0f00']);
  store.ingest(parseGrabResult(['1008b509030d0f00 / 0412345678 = 3']), { now: T0, unknownMasters });
  // same payload, count +2 over 20 s -> interval 10 s, no history entry
  let stats = store.ingest(parseGrabResult(['1008b509030d0f00 / 0412345678 = 5']), { now: T0 + 20_000, unknownMasters });
  let e = store.get('1008b5090d0f00')!;
  assert.equal(stats.changed, 0);
  assert.equal(e.count, 5);
  assert.equal(e.intervalMs, 10_000);
  assert.equal(e.history.length, 1);
  assert.equal(e.known, false);
  // changed payload
  stats = store.ingest(parseGrabResult(['1008b509030d0f00 / 0412345699 = 6']), { now: T0 + 30_000, unknownMasters: new Set() });
  e = store.get('1008b5090d0f00')!;
  assert.equal(stats.changed, 1);
  assert.equal(e.history.length, 2);
  assert.equal(e.lastChanged, T0 + 30_000);
  assert.equal(e.lastSlaveHex, '0412345699');
  assert.equal(e.known, true);
  assert.deepEqual([...varyingBytes(e.history.map((s) => s.slave))], [3]);
});

test('counts occurrences per key when the broadcast payload changes', () => {
  const store = new TelegramStore();
  store.ingest(parseGrabResult(['10feb516080012201417031125 = 10']), { now: T0 });
  store.ingest(parseGrabResult(['10feb516080017201417031125 = 11']), { now: T0 + 5_000 });
  store.ingest(parseGrabResult(['10feb516080022201417031125 = 13']), { now: T0 + 15_000 });
  const e = store.get('10feb51600')!;
  assert.equal(e.count, 13);
  assert.equal(e.history.length, 3);
  assert.equal(Math.round(e.intervalMs!), 5_000);
});

test('counts invalid lines', () => {
  const store = new TelegramStore();
  const stats = store.ingest([{ masterHex: '1008b5' }]);
  assert.equal(stats.invalid, 1);
  assert.equal(store.size, 0);
});

test('mark seen and save/load round trip', () => {
  const store = new TelegramStore();
  store.ingest(parseGrabResult(['1008b509030d0f00 / 0412345678 = 3', '1008b509030d1000 / 0100 = 1']), { now: T0 });
  store.markSeen('1008b5090d0f00');
  assert.equal(store.get('1008b5090d0f00')!.isNew, false);
  assert.equal(store.get('1008b5090d1000')!.isNew, true);
  const copy = new TelegramStore();
  copy.load(JSON.parse(JSON.stringify(store)));
  assert.equal(copy.size, 2);
  assert.equal(copy.get('1008b5090d0f00')!.isNew, false);
  store.markAllSeen();
  assert.equal(store.entries().every((e) => !e.isNew), true);
  assert.throws(() => copy.load({ version: 99 }));
});

test('view filters, searches and sorts with new entries first', () => {
  const store = new TelegramStore();
  store.ingest(
    parseGrabResult([
      '1008b509030d0f00 / 0412345678 = 3',
      '1008b509030d1000 / 0100 = 10',
      '10feb516080012201417031125 = 50',
    ]),
    { now: T0, unknownMasters: new Set(['1008b509030d1000']) },
  );
  store.markSeen('10feb51600');
  const all = store.entries();

  const byCount = applyView(all, { filter: 'all', sort: 'count', search: '' });
  assert.deepEqual(byCount.map((e) => e.key), ['1008b5090d1000', '1008b5090d0f00', '10feb51600']);

  assert.deepEqual(
    applyView(all, { filter: 'unknown', sort: 'count', search: '' }).map((e) => e.key),
    ['1008b5090d1000'],
  );
  assert.deepEqual(
    applyView(all, { filter: 'new', sort: 'address', search: '' }).map((e) => e.key),
    ['1008b5090d0f00', '1008b5090d1000'],
  );
  assert.deepEqual(
    applyView(all, { filter: 'all', sort: 'count', search: 'b5 16' }).map((e) => e.key),
    ['10feb51600'],
  );
  const named = applyView(all, { filter: 'all', sort: 'count', search: 'hmu00' }, (a) => (a === 0x08 ? 'HMU00' : undefined));
  assert.equal(named.length, 2);
});

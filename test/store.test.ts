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
  const named = applyView(all, { filter: 'all', sort: 'count', search: 'hmu00' }, { deviceName: (a) => (a === 0x08 ? 'HMU00' : undefined) });
  assert.equal(named.length, 2);
});

test('counts received and missed telegrams from poll to poll (Q5, UNK-13)', async () => {
  const { coverage } = await import('../src/store/telegram-store.ts');
  const s = new TelegramStore();
  const poll = (lines: string[], t: number) => s.ingest(parseGrabResult(lines), { now: T0 + t });
  const seen = (key: string) => [s.get(key)!.seenCount ?? 0, s.get(key)!.missedCount ?? 0];
  // ebusd has been running for a long time: the start value of the counter does not count
  poll(['1008b5090101 / 0101 = 250000'], 0);
  assert.deepEqual(seen('1008b50901'), [0, 0]);
  poll(['1008b5090101 / 0102 = 250003'], 5000); // jump by 3: one received, two missed
  assert.deepEqual(seen('1008b50901'), [1, 2]);
  poll(['1008b5090101 / 0103 = 250004'], 10000);
  poll(['1008b5090101 / 0103 = 250004'], 15000); // nothing new
  assert.deepEqual(seen('1008b50901'), [2, 2]);
  assert.equal(coverage(s.get('1008b50901')!), undefined); // too few to judge
  poll(['1008b5090101 / 0104 = 250005'], 20000);
  assert.equal(coverage(s.get('1008b50901')!), 3 / 5);
  // a gap in the polling (computer in standby): the jump is not counted
  poll(['1008b5090101 / 0105 = 251000'], 3_600_000);
  assert.deepEqual(seen('1008b50901'), [3, 2]);
  assert.equal(s.get('1008b50901')!.count, 251000);
  poll(['1008b5090101 / 0106 = 251001'], 3_605_000);
  assert.deepEqual(seen('1008b50901'), [4, 2]);
  // ebusd restarted (counter lower): nothing counted
  poll(['1008b5090101 / 0107 = 3'], 3_610_000);
  assert.deepEqual(seen('1008b50901'), [4, 2]);
  // two ebusd lines for one message key: both changed lines are received
  poll(['10feb5160301803f = 1', '10feb51603010040 = 1'], 0);
  poll(['10feb5160301803f = 2', '10feb51603010040 = 3'], 5000);
  assert.deepEqual(seen('10feb51601'), [2, 1]);
  // counts of the earlier version (which included polling gaps) are dropped on load
  const old = new TelegramStore();
  old.load({ version: 1, entries: [{ ...s.get('1008b50901')!, occurred: 460334, observed: 7 }] });
  assert.equal('occurred' in old.get('1008b50901')!, false);
});

test('ignores stale lines ebusd keeps for the same telegram', () => {
  // ebusd can list one telegram twice in `grab result all`: grabbed under its
  // definition's key and, from before the definition was loaded, under a key
  // for unknown messages. That old line keeps its payload and counter forever.
  const s = new TelegramStore();
  const stale = 'f108b509055402005b0d / 0802015b0dfd17f343 = 1000'; // 486.187 W, from hours ago
  const poll = (current: string, count: number, t: number) =>
    s.ingest(parseGrabResult([stale, `f108b509055402005b0d / 0802015b0d${current} = ${count}`]), { now: T0 + t });
  poll('4d20aa44', 5000, 0); // 1361 W
  poll('4d20aa44', 5003, 5000);
  poll('bce0aa44', 5005, 10000);
  poll('e180aa44', 5008, 15000);
  const e = s.get('f108b5095402005b0d')!;
  assert.deepEqual(e.history.map((x) => x.slave), ['02015b0d4d20aa44', '02015b0dbce0aa44', '02015b0de180aa44']);
  assert.equal(e.lastSlaveHex, '0802015b0de180aa44');
  assert.deepEqual([e.seenCount, e.missedCount], [3, 5]);
  // the stale line alone (e.g. listed first) does not create history either
  const s2 = new TelegramStore();
  s2.ingest(parseGrabResult([stale, 'f108b509055402005b0d / 0802015b0d4d20aa44 = 5000']), { now: T0 });
  assert.deepEqual(s2.get('f108b5095402005b0d')!.history.map((x) => x.slave), ['02015b0d4d20aa44']);
});

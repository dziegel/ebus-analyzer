import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bitPattern, byteStats, heatLevel } from '../src/analysis/bytes.ts';
import { candidateType, candidatesAt, decodeCandidate } from '../src/analysis/candidates.ts';
import { parseQuery, searchValue } from '../src/analysis/search.ts';
import { buildSeries, seriesId, valueAt } from '../src/analysis/series.ts';
import { AnnotationStore, parseTags } from '../src/store/annotations.ts';
import { TelegramStore } from '../src/store/telegram-store.ts';
import { parseGrabResult } from '../src/ebusd/protocol.ts';
import { hexToBytes } from '../src/ebus/hex.ts';
import { applyView } from '../src/ui/view.ts';

const T0 = 1_700_000_000_000;

/** Store with one unknown register whose 2nd/3rd response bytes carry 35.0, 35.5, 36.0 °C as D2C. */
function sampleStore(): TelegramStore {
  const store = new TelegramStore();
  const d2c = (v: number) => {
    const raw = Math.round(v * 16);
    return (raw & 0xff).toString(16).padStart(2, '0') + (raw >> 8).toString(16).padStart(2, '0');
  };
  [35, 35.5, 36].forEach((v, i) => {
    store.ingest(parseGrabResult([`1008b509030d5501 / 0401${d2c(v)}81 = ${i + 1}`, '1015b5090124 / 0548 4d55 3030'.replace(/ /g, '') + ` = ${i + 1}`]), { now: T0 + i * 10_000 });
  });
  return store;
}

test('byte statistics over the history', () => {
  const e = sampleStore().get('1008b5090d5501')!;
  const stats = byteStats(e.history, 's');
  assert.equal(stats.length, 4);
  assert.deepEqual([stats[0]!.distinct, stats[0]!.changes], [1, 0]); // constant 01
  assert.equal(stats[1]!.distinct, 3);
  assert.equal(stats[1]!.changes, 2);
  assert.equal(stats[1]!.min, 0x30);
  assert.equal(stats[1]!.max, 0x40);
  assert.equal(heatLevel(stats[0]!), 0);
  assert.equal(heatLevel(stats[1]!), 4);
  assert.equal(bitPattern(0x05), '·····x·x');
  // master part with ID prefix: indexes match field offsets
  const m = byteStats(e.history, 'm', hexToBytes(e.id));
  assert.equal(m.length, 3);
  assert.equal(m[0]!.latest, 0x0d);
});

test('candidate types decode at an offset', () => {
  const data = hexToBytes('0130028100');
  assert.equal(decodeCandidate(candidateType('D2C')!, data, 1)!.text, '35.00');
  assert.equal(decodeCandidate(candidateType('UCH')!, data, 3)!.value, 0x81);
  assert.equal(decodeCandidate(candidateType('SCH')!, data, 3)!.value, -127);
  assert.equal(decodeCandidate(candidateType('ULG')!, data, 3), undefined); // does not fit
  const all = candidatesAt(data, 1).map((c) => c.type.name);
  assert.ok(all.includes('UIN/10') && all.includes('EXP'));
});

test('value search finds a temperature and a text', () => {
  const store = sampleStore();
  const q = parseQuery('36,0 °C')!;
  assert.deepEqual(q, { kind: 'number', value: 36, tolerance: 0.05 });
  const hits = searchValue(store.entries(), q);
  const d2c = hits.find((h) => h.type === 'D2C')!;
  assert.deepEqual([d2c.key, d2c.part, d2c.offset, d2c.text, d2c.latest], ['1008b5090d5501', 's', 1, '36.00', true]);
  // 35.5 is only in an older payload
  assert.equal(searchValue(store.entries(), parseQuery('35.5')!).some((h) => h.type === 'D2C'), false);
  const old = searchValue(store.entries(), parseQuery('35.5')!, { history: true }).find((h) => h.type === 'D2C')!;
  assert.equal(old.latest, false);
  assert.equal(old.t, T0 + 10_000);
  const text = searchValue(store.entries(), parseQuery('hmu')!);
  assert.deepEqual(text.map((h) => [h.key, h.part, h.offset, h.type, h.text]), [['1015b50924', 's', 0, 'STR:3', 'hmu']]);
  // filter
  assert.equal(searchValue(store.entries(), parseQuery('hmu')!, { filter: (e) => e.target !== 0x15 }).length, 0);
});

test('series from a byte candidate', () => {
  const store = sampleStore();
  const e = store.get('1008b5090d5501')!;
  const src = { kind: 'bytes', key: e.key, part: 's', offset: 1, type: 'D2C' } as const;
  const s = buildSeries(e, src, undefined, 'reg');
  assert.equal(s.id, seriesId(src));
  assert.deepEqual(s.points.map((p) => p.v), [35, 35.5, 36]);
  assert.equal(valueAt(s, T0 + 15_000)!.v, 35.5);
  assert.equal(valueAt(s, T0 - 1), undefined);
  assert.match(s.label, /response\[1\] as D2C/);
});

test('annotations: notes, tags, ignored filter and search', () => {
  const store = sampleStore();
  const a = new AnnotationStore();
  a.set('1008b5090d5501', { note: ' flow temperature? ', tags: parseTags('heating, #hc1 heating') });
  assert.deepEqual(a.get('1008b5090d5501'), { note: 'flow temperature?', tags: ['heating', 'hc1'] });
  a.set('1015b50924', { ignored: true });
  const all = store.entries();
  const view = (filter: 'all' | 'ignored', search = '') => applyView(all, { filter, sort: 'address', search }, { annotations: a }).map((e) => e.key);
  assert.deepEqual(view('all'), ['1008b5090d5501']);
  assert.deepEqual(view('ignored'), ['1015b50924']);
  assert.deepEqual(view('all', '#hc1'), ['1008b5090d5501']);
  assert.deepEqual(a.tags(), ['hc1', 'heating']);
  a.set('1015b50924', { ignored: false });
  assert.equal(a.get('1015b50924'), undefined);
  const copy = new AnnotationStore();
  copy.load(JSON.parse(JSON.stringify(a)));
  assert.equal(copy.get('1008b5090d5501')!.note, 'flow temperature?');
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseQuery, valueFilter } from '../src/analysis/search.ts';
import { DecodingService } from '../src/decoding.ts';
import { parseDefinitionFile } from '../src/defs/definitions.ts';
import { parseGrabResult } from '../src/ebusd/protocol.ts';
import { TelegramStore } from '../src/store/telegram-store.ts';
import { applyView } from '../src/ui/view.ts';

const HEADER = 'type,circuit,level,name,comment,qq,zz,pbsb,id,*name,part,type,divisor/values,unit,comment';
const T0 = 1_700_000_000_000;

function setup() {
  const store = new TelegramStore();
  store.ingest(
    parseGrabResult([
      '1008b509030d5501 / 040168' + '0081 = 1', // unknown: response[1..2] = 0x0068 → D2C 6.5
      '1008b509030d0100 / 010e = 1', // known: UCH with divisor 4 → 3.5 (not a candidate type)
      '1008b509030d0200 / 0102 = 1', // known: value list 2=heating
      '10feb5160301 8006 = 1'.replace(' 8006', '8006'), // broadcast: D2B 6.5
      '1015b5090124 / 05484d553030 = 1', // text HMU00
    ]),
    { now: T0 },
  );
  // the unknown register changes: 7.0 now, 6.5 only in the history
  store.ingest(parseGrabResult(['1008b509030d5501 / 0401700081 = 2']), { now: T0 + 10_000 });
  const parsed = parseDefinitionFile(
    [HEADER, 'r,,,Quarter,,,,b509,0d0100,value,,UCH,4,bar,', 'r,,,Mode,,,,b509,0d0200,mode,,UCH,0=off;1=on;2=heating,,'].join('\n'),
    'vaillant/08.hmu.csv',
    { zz: '08', circuit: 'hmu' },
  );
  const decoding = new DecodingService();
  decoding.setFiles([{ path: 'vaillant/08.hmu.csv', local: false, parsed, conditionScope: [] }]);
  decoding.update(store.entries());
  const fields = (e: Parameters<DecodingService['decodeSample']>[0], s: Parameters<DecodingService['decodeSample']>[1], latest: boolean) =>
    (latest ? decoding.get(e.key) : decoding.decodeSample(e, s))?.result.fields;
  return { store, fields };
}

const keys = (m: Map<string, unknown>) => [...m.keys()].sort();

test('filters messages whose decoding yields the value', () => {
  const { store, fields } = setup();
  const all = store.entries();
  // 6.5: broadcast as D2B now; the unknown register only had it earlier
  const now = valueFilter(all, parseQuery('6,5 °C')!, { fields });
  assert.deepEqual(keys(now), ['10feb51601']);
  const hist = valueFilter(all, parseQuery('6,5 °C')!, { fields, history: true, maxSamples: 100 });
  assert.deepEqual(keys(hist), ['1008b5090d5501', '10feb51601']);
  const old = hist.get('1008b5090d5501')!.find((h) => h.type === 'D2C')!;
  assert.deepEqual([old.part, old.offset, old.length, old.text, old.latest, old.t], ['s', 1, 2, '6.50', false, T0]);
  // 7.0 in the latest payload of the unknown register
  assert.ok(keys(valueFilter(all, parseQuery('7.0')!, { fields })).includes('1008b5090d5501'));
});

test('decoded fields: own divisors and value list texts', () => {
  const { store, fields } = setup();
  const all = store.entries();
  const quarter = valueFilter(all, parseQuery('3.5')!, { fields });
  const best = quarter.get('1008b5090d0100')![0]!;
  assert.deepEqual([best.field, best.text, best.part, best.offset], ['value', '3.5', 's', 0]);
  // without definitions, 3.5 is not found in that message
  assert.equal(valueFilter(all, parseQuery('3.5')!).has('1008b5090d0100'), false);
  // text: value list name and raw text in the data
  assert.deepEqual(keys(valueFilter(all, parseQuery('heating')!, { fields })), ['1008b5090d0200']);
  assert.deepEqual(keys(valueFilter(all, parseQuery('hmu')!, { fields })), ['1015b50924']);
});

test('tolerance and combination with the list view', () => {
  const { store, fields } = setup();
  const all = store.entries();
  assert.equal(valueFilter(all, parseQuery('6.4')!, { fields }).has('10feb51601'), false);
  assert.equal(valueFilter(all, parseQuery('6.4', 0.15)!, { fields }).has('10feb51601'), true);
  const valueMatches = valueFilter(all, parseQuery('heating')!, { fields });
  const shown = applyView(all, { filter: 'all', sort: 'address', search: '' }, { valueMatches }).map((e) => e.key);
  assert.deepEqual(shown, ['1008b5090d0200']);
  const none = applyView(all, { filter: 'all', sort: 'address', search: '', participant: 0x76 }, { valueMatches });
  assert.equal(none.length, 0);
});

test('NFR-8: 1000 messages are filtered within 0.5 s', () => {
  const store = new TelegramStore();
  const lines: string[] = [];
  for (let i = 0; i < 1000; i++) {
    const id = (i & 0xffff).toString(16).padStart(4, '0');
    let resp = '';
    for (let b = 0; b < 12; b++) resp += ((i * 7 + b * 13) & 0xff).toString(16).padStart(2, '0');
    lines.push(`1008b509030d${id} / 0c${resp} = 1`);
  }
  store.ingest(parseGrabResult(lines), { now: T0 });
  const all = store.entries();
  assert.equal(all.length, 1000);
  const start = performance.now();
  const m = valueFilter(all, parseQuery('45.5')!);
  const ms = performance.now() - start;
  console.log(`value filter: ${all.length} messages, ${m.size} matches, ${ms.toFixed(0)} ms`);
  assert.ok(ms < 500, `took ${ms} ms`);
});

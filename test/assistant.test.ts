import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createDraft,
  decodeSamples,
  draftCsvLine,
  draftDefinition,
  setIdLength,
  suggestTypes,
  typeLength,
  typesForLength,
  validateDraft,
  type Draft,
} from '../src/assistant/draft.ts';
import { DraftStore } from '../src/assistant/store.ts';
import { DefinitionSet, type MatchContext } from '../src/defs/repository.ts';
import { ebusdText } from '../src/defs/fields.ts';
import { parseGrabResult } from '../src/ebusd/protocol.ts';
import { parseTelegram } from '../src/ebus/telegram.ts';
import { TelegramStore } from '../src/store/telegram-store.ts';

const T0 = 1_700_000_000_000;
const d2c = (v: number) => {
  const raw = Math.round(v * 16) & 0xffff;
  return (raw & 0xff).toString(16).padStart(2, '0') + (raw >> 8).toString(16).padStart(2, '0');
};

/** Unknown register: response 01 <D2C outside temp> 81 <status bits>; broadcast with text. */
function capture(): TelegramStore {
  const store = new TelegramStore();
  [5.5, 6, 6.5, 7, 6.5].forEach((v, i) => {
    store.ingest(parseGrabResult([`1008b509030d5501 / 0501${d2c(v)}81${i % 2 ? '05' : '01'} = ${i + 1}`]), { now: T0 + i * 10_000 });
  });
  store.ingest(parseGrabResult(['1015b5090124 / 05484d553030 = 1', '10feb5160301' + d2c(6.5) + ' = 1']), { now: T0 });
  return store;
}

test('creates a draft with addresses, command, ID and direction (ASS-1)', () => {
  const store = capture();
  const reg = createDraft(store.get('1008b5090d5501')!, { circuit: (a) => (a === 8 ? 'hmu' : undefined), manufacturer: () => 'Vaillant', now: 1 });
  assert.deepEqual(
    { ...reg, fields: reg.fields.length },
    { key: '1008b5090d5501', name: 'Msg_b509_0d5501', circuit: 'hmu', manufacturer: 'Vaillant', direction: 'r', zz: 8, pb: 0xb5, sb: 0x09, id: [0x0d, 0x55, 0x01], fields: 0, updated: 1 },
  );
  const bc = createDraft(store.get('10feb51601')!);
  assert.equal(bc.direction, 'u');
  assert.equal(bc.circuit, 'broadcast');
  assert.deepEqual(bc.id, [0x01]);
  // ID length can be changed
  const shorter = setIdLength(reg, store.get('1008b5090d5501')!, 1);
  assert.deepEqual(shorter.id, [0x0d]);
  assert.equal(typeLength('D2C'), 2);
  assert.equal(typeLength('STR:5'), 5);
  assert.equal(typeLength('BI3'), 1);
  assert.ok(typesForLength(2).includes('D2C'));
  assert.deepEqual(typesForLength(7), ['HEX:7', 'STR:7', 'IGN:7']);
});

function draftWithFields(store: TelegramStore): Draft {
  const d = createDraft(store.get('1008b5090d5501')!, { circuit: () => 'hmu' });
  d.name = 'OutsideTempCopy';
  d.fields = [
    { name: 'temp', part: 's', offset: 1, type: 'D2C', unit: '°C', comment: 'outside temperature' },
    { name: 'pump', part: 's', offset: 4, type: 'BI0', values: '0=off;1=on' },
    { name: 'burner', part: 's', offset: 4, type: 'BI2' },
  ];
  return d;
}

test('converts to a CSV line with gaps filled and decodes like the single fields (ASS-2)', () => {
  const store = capture();
  const e = store.get('1008b5090d5501')!;
  const d = draftWithFields(store);
  assert.equal(
    draftCsvLine(d),
    'r,hmu,,OutsideTempCopy,,,08,b509,0d5501,,s,IGN:1,,,,temp,s,D2C,,°C,outside temperature,,s,IGN:1,,,,pump,s,BI0,0=off;1=on,,,burner,s,BI2,,,',
  );
  const def = draftDefinition(d);
  assert.equal(def.fields.length, 5);
  const rows = decodeSamples(d, e);
  assert.deepEqual(rows.map((r) => r.values.map((v) => v.text).join('|')), ['5.50|on|0', '6.00|on|1', '6.50|on|0', '7.00|on|1', '6.50|on|0']);
  assert.deepEqual(validateDraft(d, e).filter((i) => i.level !== 'info'), []);
  // decoding through the definition set gives the same values
  const set = new DefinitionSet([{ path: 'drafts', local: true, parsed: { path: 'drafts', messages: [def], conditions: [], loads: [], errors: [] }, conditionScope: [] }]);
  const ctx: MatchContext = { scan: () => undefined, value: () => undefined };
  const decoded = set.decode(parseTelegram(e.lastMasterHex, e.lastSlaveHex), ctx)!;
  assert.equal(ebusdText(decoded.result.fields), '6.50;on;0');
});

test('validation reports overlaps, names, invalid values and ID conflicts (ASS-6)', () => {
  const store = capture();
  const e = store.get('1008b5090d5501')!;
  const d = draftWithFields(store);
  d.fields.push({ name: 'temp', part: 's', offset: 2, type: 'UCH' }); // duplicate name + overlap
  d.fields.push({ name: 'inid', part: 'm', offset: 1, type: 'UCH' });
  d.fields.push({ name: '2nd', part: 's', offset: 9, type: 'UCH' });
  const msgs = validateDraft(d, e).map((i) => `${i.level}: ${i.message}`);
  assert.ok(msgs.some((m) => /used twice/.test(m)), msgs.join('\n'));
  assert.ok(msgs.some((m) => /temp overlaps temp/.test(m)), msgs.join('\n'));
  assert.ok(msgs.some((m) => /inid: starts inside the ID/.test(m)), msgs.join('\n'));
  assert.ok(msgs.some((m) => /"2nd" must start with a letter/.test(m)), msgs.join('\n'));
  assert.ok(msgs.some((m) => /^error: 2nd: not enough data in 5 of 5 samples/.test(m)), msgs.join('\n'));
  // 0x81 is not a valid hour
  const d1c = { ...draftWithFields(store), fields: [{ name: 'x', part: 's' as const, offset: 3, type: 'HTM' }] };
  assert.ok(validateDraft(d1c, e).some((i) => i.level === 'error' && /invalid hour/.test(i.message)));
});

test('suggests plausible types (ASS-5)', () => {
  const store = capture();
  const e = store.get('1008b5090d5501')!;
  const s = suggestTypes(e, 's', 1);
  assert.equal(s[0]!.type, 'D2C', JSON.stringify(s.slice(0, 3)));
  assert.match(s[0]!.reason, /5\.5 … 7, temperature range, changes smoothly, high byte is a zero\/sign extension/);
  const text = suggestTypes(store.get('1015b50924')!, 's', 0);
  assert.equal(text[0]!.type, 'STR:5');
  assert.equal(text[0]!.latest, 'HMU00');
});

test('draft store: decoding file and TypeSpec files (ASS-7)', () => {
  const store = capture();
  const drafts = new DraftStore();
  drafts.save({ ...draftWithFields(store), manufacturer: 'Vaillant' });
  drafts.save({ ...createDraft(store.get('1015b50924')!, { circuit: () => 'ctlv2' }), name: 'Ident', fields: [{ name: 'id', part: 's', offset: 0, type: 'STR:5' }] });
  drafts.save({ ...createDraft(store.get('10feb51601')!), name: 'Empty' }); // no fields: not used for decoding
  const file = drafts.definitionFile()!;
  assert.equal(file.local, true);
  assert.deepEqual(file.parsed.messages.map((m) => m.name).sort(), ['Ident', 'OutsideTempCopy']);
  const tsp = drafts.typeSpecFiles();
  assert.deepEqual([...tsp.keys()].sort(), ['assistant/08.hmu.tsp', 'assistant/15.ctlv2.tsp']);
  assert.match(tsp.get('assistant/08.hmu.tsp')!, /^\/\/ Generated by the EBus Analyzer[\s\S]*namespace Vaillant;[\s\S]*@zz\(0x08\)\nnamespace Hmu \{[\s\S]*model OutsideTempCopy \{/);
  const copy = new DraftStore();
  copy.load(JSON.parse(JSON.stringify(drafts)));
  assert.equal(copy.size, 3);
});

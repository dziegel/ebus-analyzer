// Checks the decoder against the real definition files of the ebusd CDN.
// Needs a local clone of https://github.com/eBUS/ebus.github.io:
//
//   git clone --depth 1 https://github.com/eBUS/ebus.github.io ../ebus.github.io
//   EBUS_CDN=../ebus.github.io npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DefinitionLoader, type Cache } from '../src/defs/loader.ts';
import { DecodingService } from '../src/decoding.ts';
import { ebusdText } from '../src/defs/fields.ts';
import { TelegramStore } from '../src/store/telegram-store.ts';
import { parseGrabResult, parseScanResult } from '../src/ebusd/protocol.ts';
import { simulatedTelegrams } from '../tools/fake-ebusd.mjs';

const cdn = process.env.EBUS_CDN;
const skip = !cdn || !existsSync(join(cdn, 'en/versions.json')) ? 'set EBUS_CDN to a clone of eBUS/ebus.github.io' : false;

const DEVICES = parseScanResult(['08;Vaillant;HMU00;0308;0403', '15;Vaillant;CTLV2;0507;1704', '76;Vaillant;VWZ00;0308;0403']);

async function load(language: 'en' | 'de') {
  const fetchText = async (url: string) => readFileSync(join(cdn!, url.replace('https://ebus.github.io/', '')), 'utf8');
  const map = new Map<string, unknown>();
  const cache: Cache = { get: async (k) => map.get(k) as never, set: async (k, v) => void map.set(k, v) };
  return new DefinitionLoader(cache, fetchText).load(DEVICES, { baseUrl: 'https://ebus.github.io/', channel: '', language });
}

test('loads and parses the definitions for a Vaillant heat pump', { skip }, async () => {
  for (const language of ['en', 'de'] as const) {
    const report = await load(language);
    assert.deepEqual(report.errors, []);
    assert.deepEqual(report.unmatched, []);
    const paths = report.files.map((f) => f.path);
    for (const p of ['vaillant/08.hmu.csv', 'vaillant/15.ctlv2.csv', 'vaillant/76.vwz.csv', 'broadcast.csv', 'vaillant/scan.csv']) {
      assert.ok(paths.includes(p), `${p} missing in ${paths.join(', ')}`);
    }
    assert.ok(report.files.every((f) => f.parsed.errors.length === 0));
    assert.ok(report.files.find((f) => f.path === 'vaillant/08.hmu.csv')!.sourceUrl?.endsWith('/src/vaillant/08.hmu.tsp'));
  }
});

test('decodes the simulated traffic with the real definitions', { skip }, async () => {
  const report = await load('en');
  const store = new TelegramStore();
  const lines = simulatedTelegrams(0).map((l: { m: string; s: string | null; c: number }) => `${l.m}${l.s ? ` / ${l.s}` : ''} = ${l.c}`);
  store.ingest(parseGrabResult(lines), { now: 1 });
  const svc = new DecodingService();
  svc.setFiles(report.files);
  svc.setDevices(DEVICES);
  svc.update(store.entries());
  const result = (key: string) => {
    const d = svc.get(key);
    return d ? `${d.def.circuit}.${d.def.name}=${ebusdText(d.result.fields)}` : 'unknown';
  };
  assert.equal(result('10feb51600'), 'Broadcast.Vdatetime=14:30:00;18.11.2026');
  assert.equal(result('10feb51601'), 'Broadcast.Outsidetemp=5.500');
  assert.equal(result('3108b51a05ff3220'), 'hmu.FlowTemp=35.00');
  assert.equal(result('1008b51101'), 'hmu.Status01=35.0;30.0;5.500;50.0;50.0;on');
  assert.equal(result('3115b524020000007300'), 'ctlv2.DisplayedOutsideTemp=5.5');
  assert.equal(result('1008b5090d5501'), 'unknown');
});

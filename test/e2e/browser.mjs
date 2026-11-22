#!/usr/bin/env node
// End-to-end test in a headless browser (run in CI after `npm run build`):
// fake ebusd -> bridge -> app, definitions from the CDN, then TypeSpec view
// of a decoded message, add it to a project and compile it in the worker.
//
//   npm i --no-save playwright && npx playwright install chromium
//   node test/e2e/browser.mjs            (E2E_CDN=http://... to use a local CDN copy)

import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { chromium } from 'playwright';

const out = 'e2e-artifacts';
mkdirSync(out, { recursive: true });
const procs = [
  spawn(process.execPath, ['tools/fake-ebusd.mjs', '--port', '28888'], { stdio: 'inherit' }),
  spawn(process.execPath, ['bridge/ebusd-bridge.mjs', '--port', '28080', '--bind', '127.0.0.1', '--ebusd-port', '28888'], { stdio: 'inherit' }),
];
const step = (msg) => console.log(`[e2e] ${msg}`);
let failed = false;
const browser = await chromium.launch();
try {
  await sleep(800);
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  const settings = { pollIntervalMs: 2000 };
  if (process.env.E2E_CDN) settings.source = { baseUrl: process.env.E2E_CDN, channel: '', language: 'en' };
  await page.addInitScript((s) => localStorage.setItem('ebus-analyzer.settings', JSON.stringify(s)), settings);
  await page.goto('http://127.0.0.1:28080/');

  step('waiting for decoded telegrams (definitions from the CDN)');
  await page.waitForFunction(() => document.querySelector('tr[data-key="1008b51101"] .c-msg')?.textContent?.includes('hmu.Status01'), null, { timeout: 60_000 });
  step(`definitions: ${await page.textContent('.device.defs')}`);
  await page.screenshot({ path: `${out}/1-decoded.png` });

  step('TypeSpec view of hmu.Status01');
  await page.click('tr[data-key="1008b51101"]');
  await page.click('#detail [data-action="show-tsp"]');
  const tsp = await page.inputValue('#tsp-view-text');
  if (!tsp.includes('model Status01')) throw new Error(`unexpected TypeSpec:\n${tsp}`);
  await page.screenshot({ path: `${out}/2-typespec-view.png` });

  step('add to project and compile');
  await page.click('#tsp-view-add');
  await page.waitForSelector('#tsp[open]');
  await page.click('#tsp-run');
  await page.waitForFunction(() => /Compiled in|failed|not part of this build/.test(document.getElementById('tsp-status')?.textContent ?? ''), null, { timeout: 120_000 });
  const status = await page.textContent('#tsp-status');
  step(`compile status: ${status}`);
  await page.screenshot({ path: `${out}/3-compiled.png` });
  if (!/Compiled in .*1 CSV file, 0 errors/.test(status ?? '')) throw new Error(`compile did not succeed: ${status}`);

  step('compiled definition is used for decoding');
  await page.click('#tsp-close');
  await page.mouse.move(5, 5);
  try {
    await page.waitForFunction(() => document.querySelector('#detail')?.textContent?.includes('typespec:vaillant/08.hmu.csv'), null, { timeout: 10_000 });
  } catch (err) {
    await page.screenshot({ path: `${out}/4-failed.png` });
    step(`definitions chip: ${await page.textContent('.device.defs')}`);
    step(`detail: ${(await page.textContent('#detail'))?.replace(/\s+/g, ' ').slice(0, 600)}`);
    await page.click('#btn-defs');
    step(`definitions report: ${(await page.textContent('#defs-report'))?.replace(/\s+/g, ' ').slice(0, 800)}`);
    throw err;
  }
  await page.screenshot({ path: `${out}/4-decoded-with-compiled.png` });
  step('value filter (M7): enter the outside temperature shown in the list');
  await page.click('[data-action="close-detail"]').catch(() => {});
  const outside = (await page.textContent('tr[data-key="10feb51601"] .c-msg'))?.match(/value=([\d.]+)/)?.[1];
  if (!outside) throw new Error('outside temperature not found');
  await page.fill('#vf-value', `${Number(outside).toFixed(1).replace('.', ',')} °C`);
  await page.waitForFunction(() => /containing/.test(document.getElementById('counts')?.textContent ?? ''), null, { timeout: 5_000 });
  const keys = await page.$$eval('tr[data-key]', (r) => r.map((x) => x.dataset.key));
  step(`value filter ${outside}: ${keys.join(', ')}`);
  for (const k of ['10feb51601', '1008b5090d5501']) if (!keys.includes(k)) throw new Error(`value filter: ${k} missing`);
  await page.screenshot({ path: `${out}/5-value-filter.png` });
  await page.fill('#vf-value', '');

  step('definition assistant (M5): define the unknown register 0d5501');
  await page.click('tr[data-key="1008b5090d5501"]');
  await page.click('#detail [data-action="assistant"]');
  await page.waitForSelector('#assistant[open]');
  const head = await page.$$eval('#as-head [data-draft]', (els) => els.map((e) => `${e.dataset.draft}=${e.value}`).join(' '));
  step(`draft: ${head}`);
  if (!/circuit=hmu/.test(head) || !/idlen=3/.test(head)) throw new Error(`unexpected draft defaults: ${head}`);
  await page.click('#as-bytes [data-p="s"][data-i="1"]');
  step(`suggestions: ${(await page.$$eval('#as-selection tbody tr td:first-child', (r) => r.map((x) => x.textContent))).join(', ')}`);
  await page.click('#as-selection [data-action="as-add"][data-type="D2C"]');
  await page.fill('#as-fields input[data-k="name"]', 'Outside');
  await page.fill('#as-fields input[data-k="unit"]', '°C');
  const preview = await page.inputValue('#as-preview');
  if (!/model Msg_b509_0d5501 \{[\s\S]*Outside: D2C;/.test(preview)) throw new Error(`unexpected preview:\n${preview}`);
  await page.screenshot({ path: `${out}/6-assistant.png` });
  await page.click('#as-save');
  await page.click('#as-close');
  await page.mouse.move(5, 5);
  await page.waitForFunction(() => document.querySelector('tr[data-key="1008b5090d5501"] .c-msg')?.textContent?.includes('hmu.Msg_b509_0d5501'), null, { timeout: 10_000 });
  step(`decoded by the draft: ${await page.textContent('tr[data-key="1008b5090d5501"] .c-msg')}`);

  step('drafts into the TypeSpec project and compile');
  await page.click('#detail [data-action="assistant"]');
  await page.click('#as-project');
  await page.waitForSelector('#tsp[open]');
  await page.selectOption('#tsp-entry', 'assistant/08.hmu.tsp');
  await page.click('#tsp-run');
  await page.waitForFunction(() => /Compiled in|failed/.test(document.getElementById('tsp-status')?.textContent ?? ''), null, { timeout: 120_000 });
  const draftStatus = await page.textContent('#tsp-status');
  step(`compile status: ${draftStatus}`);
  await page.screenshot({ path: `${out}/7-draft-compiled.png` });
  if (!/Compiled in .*0 errors/.test(draftStatus ?? '')) throw new Error(`draft compile did not succeed: ${draftStatus}`);
  await page.click('#tsp-close');
  if (errors.length) throw new Error(`browser errors: ${errors.join('\n')}`);
  step('ok');
} catch (err) {
  failed = true;
  console.error('[e2e] FAILED:', err);
} finally {
  await browser.close();
  for (const p of procs) p.kill();
}
process.exit(failed ? 1 : 0);

// End-to-end: EbusdClient -> bridge (WebSocket) -> fake ebusd (TCP).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import type { Server } from 'node:net';
import { startFakeEbusd } from '../tools/fake-ebusd.mjs';
import { EbusdClient } from '../src/ebusd/client.ts';
import { parseGrabResult, parseScanResult } from '../src/ebusd/protocol.ts';

const EBUSD_PORT = 18888;
const BRIDGE_PORT = 18080;
let ebusd: Server;
let bridge: ChildProcess;

before(async () => {
  ebusd = await startFakeEbusd(EBUSD_PORT);
  bridge = spawn(
    process.execPath,
    ['bridge/ebusd-bridge.mjs', '--port', String(BRIDGE_PORT), '--bind', '127.0.0.1', '--ebusd-port', String(EBUSD_PORT)],
    { stdio: ['ignore', 'pipe', 'inherit'] },
  );
  await new Promise<void>((resolve) => bridge.stdout!.once('data', () => resolve()));
});

after(() => {
  bridge.kill();
  ebusd.close();
});

async function connectedClient(): Promise<EbusdClient> {
  const client = new EbusdClient({ commandTimeoutMs: 3000 });
  const ready = new Promise<void>((resolve) => client.onStateChange((s) => s === 'connected' && resolve()));
  client.connect(`ws://127.0.0.1:${BRIDGE_PORT}/ebusd`);
  await ready;
  return client;
}

test('relays commands and responses in order', async () => {
  const client = await connectedClient();
  try {
    const [info, scan, all] = await Promise.all([
      client.command('info'),
      client.command('scan result'),
      client.command('grab result all'),
    ]);
    assert.equal(info[0], 'version: ebusd 25.1.fake');
    assert.equal(parseScanResult(scan)[0]!.deviceId, 'HMU00');
    assert.ok(parseGrabResult(all).length >= 4);
  } finally {
    client.disconnect();
  }
});

test('blocks write commands unless --allow-write', async () => {
  const client = await connectedClient();
  try {
    const res = await client.command('hex 08b509030d0f00');
    assert.match(res[0]!, /^ERR: command "hex" blocked by bridge/);
    // connection still usable afterwards
    assert.equal((await client.command('info'))[0], 'version: ebusd 25.1.fake');
  } finally {
    client.disconnect();
  }
});

test('serves the web app', async () => {
  const res = await fetch(`http://127.0.0.1:${BRIDGE_PORT}/`);
  assert.equal(res.status, 200);
  assert.match(await res.text(), /EBus Analyzer/);
  const traversal = await fetch(`http://127.0.0.1:${BRIDGE_PORT}/..%2Fpackage.json`);
  assert.notEqual(traversal.status, 200);
});

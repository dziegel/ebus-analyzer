#!/usr/bin/env node
// Minimal stand-in for the ebusd TCP command port, for development and tests
// without a real heating system. Answers info, scan result, grab and
// grab result [all] with simulated Vaillant-like traffic that changes over time.
//
//   node tools/fake-ebusd.mjs [--port 8888]

import { createServer } from 'node:net';
import { pathToFileURL } from 'node:url';

const hex = (n, bytes = 1) => n.toString(16).padStart(bytes * 2, '0');
/** Little-endian hex of an integer. */
const le = (n, bytes) => Array.from({ length: bytes }, (_, i) => hex((n >> (8 * i)) & 0xff)).join('');
/** BCD byte. */
const bcd = (n) => hex(Math.floor(n / 10) * 16 + (n % 10));
/** IEEE 754 float, little-endian hex. */
const float = (v) => {
  const b = Buffer.alloc(4);
  b.writeFloatLE(v);
  return b.toString('hex');
};

/**
 * Builds the simulated telegram list for poll number `tick`. The known
 * messages follow real Vaillant definitions (08.hmu, 15.ctlv2, broadcast).
 */
export function simulatedTelegrams(tick) {
  const flow = 35 + 2 * Math.sin(tick / 3); // °C
  const outside = 5.5 + (tick % 4) * 0.5; // °C
  const sec = tick % 60;
  const lines = [
    // Broadcast.Vdatetime: BTI (ss mm hh) + BDA (dd mm weekday yy)
    { m: `10feb5160800${bcd(sec)}3014181103` + '26', s: null, c: 10 + tick, known: true },
    // Broadcast.Outsidetemp: D2B
    { m: `10feb5160301${le(Math.round(outside * 256), 2)}`, s: null, c: 3 + tick, known: true },
    // hmu.FlowTemp: IGN:3 + D2C
    { m: '3108b51a0405ff3220', s: `05000000${le(Math.round(flow * 16), 2)}`, c: 5 + tick, known: true },
    // hmu.Status01: D1C D1C D2B D1C D1C UCH
    { m: '1008b5110101', s: `07${hex(Math.round(flow * 2))}3c${le(Math.round(outside * 256), 2)}646401`, c: 4 + tick, known: true },
    // ctlv2.DisplayedOutsideTemp: IGN:4 + EXP
    { m: '3115b524060200000073' + '00', s: `0800000000${float(outside)}`, c: 2 + tick, known: true },
    // unknown: register that carries the outside temperature as D2C at response offset 1
    { m: '1008b509030d5501', s: `0401${le(Math.round(outside * 16), 2)}81`, c: 2 + tick, known: false },
  ];
  // a new message type shows up after a few polls
  if (tick >= 3) lines.push({ m: '10f1b5050427000000', s: null, c: tick - 2, known: false });
  return lines;
}

function format(lines) {
  return lines.map((l) => `${l.m}${l.s ? ` / ${l.s}` : ''} = ${l.c}`).join('\n');
}

export function startFakeEbusd(port = 8888, host = '127.0.0.1') {
  let tick = 0;
  const server = createServer((socket) => {
    socket.setEncoding('utf8');
    let buffer = '';
    socket.on('data', (chunk) => {
      buffer += chunk;
      let idx;
      while ((idx = buffer.indexOf('\n')) >= 0) {
        const cmd = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        socket.write(answer(cmd) + '\n\n');
      }
    });
    socket.on('error', () => {});
  });

  function answer(cmd) {
    switch (cmd) {
      case 'info':
        return 'version: ebusd 25.1.fake\nsignal: acquired\naddress 31: master #8, ebusd';
      case 'scan result':
        return '08;Vaillant;HMU00;0308;0403\n15;Vaillant;CTLV2;0507;1704\n76;Vaillant;VWZ00;0308;0403';
      case 'grab':
        return 'grab started';
      case 'grab result all':
        tick++;
        return format(simulatedTelegrams(tick));
      case 'grab result':
        return format(simulatedTelegrams(tick).filter((l) => !l.known));
      default:
        return 'ERR: command not found';
    }
  }

  return new Promise((resolve) => {
    server.listen(port, host, () => resolve(server));
  });
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const i = process.argv.indexOf('--port');
  const port = i >= 0 ? Number(process.argv[i + 1]) : 8888;
  startFakeEbusd(port).then(() => console.log(`[fake-ebusd] listening on 127.0.0.1:${port}`));
}

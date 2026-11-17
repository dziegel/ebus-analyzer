#!/usr/bin/env node
// Minimal stand-in for the ebusd TCP command port, for development and tests
// without a real heating system. Answers info, scan result, grab and
// grab result [all] with simulated Vaillant-like traffic that changes over time.
//
//   node tools/fake-ebusd.mjs [--port 8888]

import { createServer } from 'node:net';
import { pathToFileURL } from 'node:url';

const hex = (n, bytes = 1) => n.toString(16).padStart(bytes * 2, '0');

/** Builds the simulated telegram list for poll number `tick`. */
export function simulatedTelegrams(tick) {
  const flow = 350 + Math.round(20 * Math.sin(tick / 3)); // 35.0 °C ± 2, D2C-like /16 not needed
  const outside = (65 + (tick % 4)) & 0xff;
  const sec = tick % 60;
  const lines = [
    // known: date/time broadcast from the controller
    { m: `10feb5160800${hex(sec)}2014170311` + '25', s: null, c: 10 + tick, known: true },
    // known: HMU register read with slowly changing value
    { m: '1008b509030d0f00', s: `02${hex(flow & 0xff)}${hex(flow >> 8)}`, c: 5 + tick, known: true },
    // unknown: register with changing outside temperature byte
    { m: '1008b509030d5501', s: `03${hex(outside)}0001`, c: 2 + tick, known: false },
    // unknown: constant status message
    { m: '1076b5110101', s: '0909d90113000008000100', c: 1 + Math.floor(tick / 2), known: false },
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

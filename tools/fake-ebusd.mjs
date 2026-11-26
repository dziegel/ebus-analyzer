#!/usr/bin/env node
// Minimal stand-in for the ebusd TCP command port, for development and tests
// without a real heating system. Answers info, scan result, grab and
// grab result [all] with simulated Vaillant-like traffic that changes over time,
// and, like an ebusd started with --enablehex --enabledefine, the live-test
// commands decode, define, find, read -def and hex (decoded with the app's own
// decoder; the real ebusd is used for that in test/ebusd-live.test.ts).
//
//   node tools/fake-ebusd.mjs [--port 8888]

import { createServer } from 'node:net';
import { pathToFileURL } from 'node:url';
import { parseDefinitionFile } from '../src/defs/definitions.ts';
import { decodeFields, ebusdText } from '../src/defs/fields.ts';
import { hexToBytes } from '../src/ebus/hex.ts';
import { parseFieldList, splitArgs } from '../src/ebusd/live.ts';

/** ebusd's default columns for definitions given on the command line (no level). */
const DEF_HEADER = 'type,circuit,name,comment,qq,zz,pbsb,id,*name,part,type,divisor/values,unit,comment';

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
    // sent 3 times per poll: faster than the polling, so the app sees only a third (Q5)
    { m: `10feb5160800${bcd(sec)}3014181103` + '26', s: null, c: 10 + 3 * tick, known: true },
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

/** Parses a definition given to define / read -def. */
function parseDef(text) {
  const parsed = parseDefinitionFile(`${DEF_HEADER}\n${text}`, 'tcp', {});
  return parsed.errors.length || parsed.messages.length !== 1 ? undefined : parsed.messages[0];
}

/** The current simulated telegram for a definition, split into master data and slave data. */
function telegramFor(def, lines) {
  for (const l of lines) {
    const m = hexToBytes(l.m);
    const data = m.subarray(5);
    if (!def.zz?.includes(m[1]) || m[2] !== def.pb || m[3] !== def.sb) continue;
    if (!def.id.every((b, i) => data[i] === b)) continue;
    return { master: data, slave: l.s ? hexToBytes(l.s).subarray(1) : undefined };
  }
  return undefined;
}

function decodeText(fields, master, slave, idLength) {
  const r = decodeFields(fields, master, slave, idLength);
  return r.error ? undefined : ebusdText(r.fields);
}

export function startFakeEbusd(port = 8888, host = '127.0.0.1') {
  let tick = 0;
  /** Messages added with define, by "circuit name". */
  const defined = new Map();
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

  function live(cmd) {
    const args = splitArgs(cmd);
    const verb = args[0]?.toLowerCase();
    const lines = simulatedTelegrams(tick);
    if (verb === 'decode') {
      const master = args[1] === '-m';
      const [list, data] = args.slice(master ? 2 : 1);
      if (!list || !data) return 'usage: decode [-v|-V] [-m] [-n|-N] DEFINITION DD[DD]*';
      const fields = parseFieldList(list, master ? 'm' : 's');
      const bytes = hexToBytes(data);
      const text = master ? decodeText(fields, bytes, undefined, 0) : decodeText(fields, new Uint8Array(0), bytes, 0);
      return text ?? 'ERR: argument value out of valid range';
    }
    if (verb === 'define') {
      const replace = args[1] === '-r';
      const def = parseDef(args[replace ? 2 : 1] ?? '');
      if (!def) return 'ERR: invalid argument';
      const name = `${def.circuit} ${def.name}`.toLowerCase();
      const same = [...defined.entries()].find(([, d]) => d.zz?.join() === def.zz?.join() && d.pb === def.pb && d.sb === def.sb && d.id.join() === def.id.join());
      if ((defined.has(name) || same) && !replace) return 'ERR: duplicate entry';
      if (same) defined.delete(same[0]);
      defined.set(name, def);
      return 'done';
    }
    if (verb === 'find' && args[1] === '-c' && args.length === 4) {
      const def = defined.get(`${args[2]} ${args[3]}`.toLowerCase());
      if (!def) return 'ERR: element not found';
      const t = telegramFor(def, lines);
      const text = t && decodeText(def.fields, t.master, t.slave, def.id.length);
      return `${def.circuit} ${def.name} = ${text ?? 'no data stored'}`;
    }
    if (verb === 'read' && args[1] === '-def') {
      const def = parseDef(args[2] ?? '');
      if (!def) return 'ERR: bad definition';
      const t = telegramFor(def, lines);
      if (!t?.slave) return 'ERR: read timeout';
      const r = decodeFields(def.fields, t.master, t.slave, def.id.length);
      return r.error ? 'ERR: argument value out of valid range' : ebusdText(r.fields.filter((f) => f.part === 's'));
    }
    if (verb === 'hex') {
      const hex = (args[1] ?? '').toLowerCase();
      if (hex.startsWith('fe')) return 'done broadcast';
      const l = lines.find((x) => x.m.slice(2) === hex);
      return l?.s ? l.s : 'ERR: read timeout';
    }
    return undefined;
  }

  function answer(cmd) {
    const result = live(cmd);
    if (result !== undefined) return result;
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

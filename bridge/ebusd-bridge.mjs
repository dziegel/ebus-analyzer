#!/usr/bin/env node
// EBus Analyzer bridge: serves the web app and relays a WebSocket to the ebusd
// TCP command port. No dependencies; Node.js >= 18.
//
// Browsers cannot open raw TCP sockets, so each WebSocket connection on /ebusd
// gets its own TCP connection to ebusd. Text frames from the browser are sent
// to ebusd as command lines; everything ebusd sends back is relayed unchanged.
// The bridge does not interpret eBUS data. By default it only lets read-only
// commands through (see READ_ONLY_COMMANDS); start with --allow-write to lift
// that restriction.

import { createServer } from 'node:http';
import { connect } from 'node:net';
import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { resolve, join, extname, sep, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const READ_ONLY_COMMANDS = new Set([
  'info', 'state', 'grab', 'scan', 'find', 'listen', 'read', 'help', 'quit', 'encode', 'decode',
]);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
};

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

function parseArgs(argv) {
  const here = dirname(fileURLToPath(import.meta.url));
  const opts = {
    port: 8080,
    bind: '0.0.0.0',
    ebusdHost: '127.0.0.1',
    ebusdPort: 8888,
    web: resolve(here, '..', 'web'),
    allowWrite: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`missing value for ${arg}`);
      return v;
    };
    switch (arg) {
      case '--port': opts.port = Number(next()); break;
      case '--bind': opts.bind = next(); break;
      case '--ebusd-host': opts.ebusdHost = next(); break;
      case '--ebusd-port': opts.ebusdPort = Number(next()); break;
      case '--web': opts.web = resolve(next()); break;
      case '--allow-write': opts.allowWrite = true; break;
      case '-h':
      case '--help':
        console.log(`Usage: node bridge/ebusd-bridge.mjs [options]

  --port <n>          HTTP/WebSocket port (default 8080)
  --bind <addr>       address to listen on (default 0.0.0.0)
  --ebusd-host <h>    ebusd host (default 127.0.0.1)
  --ebusd-port <n>    ebusd TCP command port (default 8888)
  --web <dir>         directory with the web app (default ./web)
  --allow-write       also relay commands that can write to the bus
                      (write, hex, direct, define, ...)`);
        process.exit(0);
        break;
      default:
        throw new Error(`unknown option ${arg} (try --help)`);
    }
  }
  return opts;
}

// ---------------------------------------------------------------------------
// Static files

async function serveStatic(webRoot, req, res) {
  const url = new URL(req.url ?? '/', 'http://localhost');
  let path = decodeURIComponent(url.pathname);
  if (path.endsWith('/')) path += 'index.html';
  const file = resolve(join(webRoot, path));
  if (file !== webRoot && !file.startsWith(webRoot + sep)) {
    res.writeHead(403).end('forbidden');
    return;
  }
  try {
    const info = await stat(file);
    if (!info.isFile()) throw new Error('not a file');
    const body = await readFile(file);
    res.writeHead(200, {
      'content-type': MIME[extname(file)] ?? 'application/octet-stream',
      'cache-control': 'no-cache',
    });
    res.end(body);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
  }
}

// ---------------------------------------------------------------------------
// Minimal WebSocket server (RFC 6455): text/binary/close/ping, fragmentation.

function encodeFrame(opcode, payload) {
  const len = payload.length;
  let header;
  if (len < 126) {
    header = Buffer.from([0x80 | opcode, len]);
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([header, payload]);
}

class WsConnection {
  constructor(socket, onMessage, onClose) {
    this.socket = socket;
    this.onMessage = onMessage;
    this.onClose = onClose;
    this.buffer = Buffer.alloc(0);
    this.fragments = [];
    this.closed = false;
    socket.on('data', (chunk) => this.#receive(chunk));
    socket.on('close', () => this.#finish());
    socket.on('error', () => this.#finish());
  }

  sendText(text) {
    if (!this.closed) this.socket.write(encodeFrame(0x1, Buffer.from(text, 'utf8')));
  }

  close(code = 1000, reason = '') {
    if (this.closed) return;
    const payload = Buffer.alloc(2 + Buffer.byteLength(reason));
    payload.writeUInt16BE(code, 0);
    payload.write(reason, 2);
    this.socket.write(encodeFrame(0x8, payload));
    this.socket.end();
    this.#finish();
  }

  #finish() {
    if (this.closed) return;
    this.closed = true;
    this.onClose();
  }

  #receive(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    for (;;) {
      if (this.buffer.length < 2) return;
      const b0 = this.buffer[0];
      const b1 = this.buffer[1];
      const fin = (b0 & 0x80) !== 0;
      const opcode = b0 & 0x0f;
      const masked = (b1 & 0x80) !== 0;
      let len = b1 & 0x7f;
      let offset = 2;
      if (len === 126) {
        if (this.buffer.length < 4) return;
        len = this.buffer.readUInt16BE(2);
        offset = 4;
      } else if (len === 127) {
        if (this.buffer.length < 10) return;
        len = Number(this.buffer.readBigUInt64BE(2));
        offset = 10;
      }
      if (len > 1024 * 1024) {
        this.close(1009, 'message too big');
        return;
      }
      const maskLen = masked ? 4 : 0;
      if (this.buffer.length < offset + maskLen + len) return;
      const mask = masked ? this.buffer.subarray(offset, offset + 4) : null;
      const payload = Buffer.from(this.buffer.subarray(offset + maskLen, offset + maskLen + len));
      if (mask) for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
      this.buffer = this.buffer.subarray(offset + maskLen + len);

      switch (opcode) {
        case 0x0: // continuation
        case 0x1: // text
        case 0x2: // binary
          this.fragments.push(payload);
          if (fin) {
            const message = Buffer.concat(this.fragments).toString('utf8');
            this.fragments = [];
            this.onMessage(message);
          }
          break;
        case 0x8: // close
          this.close();
          return;
        case 0x9: // ping
          this.socket.write(encodeFrame(0xa, payload));
          break;
        case 0xa: // pong
          break;
        default:
          this.close(1002, 'unsupported opcode');
          return;
      }
    }
  }
}

function acceptWebSocket(req, socket) {
  const key = req.headers['sec-websocket-key'];
  if (!key || (req.headers.upgrade ?? '').toLowerCase() !== 'websocket') {
    socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
    return false;
  }
  const accept = createHash('sha1').update(key + WS_GUID).digest('base64');
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
  );
  return true;
}

// ---------------------------------------------------------------------------
// Relay

function commandVerb(line) {
  return line.trim().split(/\s+/, 1)[0]?.toLowerCase() ?? '';
}

function relay(opts, req, socket) {
  if (!acceptWebSocket(req, socket)) return;
  const peer = `${req.socket.remoteAddress}:${req.socket.remotePort}`;
  const tcp = connect({ host: opts.ebusdHost, port: opts.ebusdPort });
  tcp.setEncoding('utf8');
  let ws;

  ws = new WsConnection(
    socket,
    (message) => {
      for (const line of message.split(/\r?\n/)) {
        if (line.trim() === '') continue;
        const verb = commandVerb(line);
        if (!opts.allowWrite && !READ_ONLY_COMMANDS.has(verb)) {
          ws.sendText(`ERR: command "${verb}" blocked by bridge (start bridge with --allow-write)\n\n`);
          continue;
        }
        tcp.write(line + '\n');
      }
    },
    () => {
      tcp.destroy();
      console.log(`[bridge] ${peer} disconnected`);
    },
  );

  tcp.on('connect', () => console.log(`[bridge] ${peer} connected to ebusd ${opts.ebusdHost}:${opts.ebusdPort}`));
  tcp.on('data', (data) => ws.sendText(data));
  tcp.on('error', (err) => {
    console.error(`[bridge] ebusd connection error: ${err.message}`);
    ws.close(1011, 'ebusd unreachable');
  });
  tcp.on('close', () => ws.close(1001, 'ebusd closed connection'));
}

// ---------------------------------------------------------------------------

function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(err.message);
    process.exit(2);
  }

  const server = createServer((req, res) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405).end();
      return;
    }
    serveStatic(opts.web, req, res);
  });

  server.on('upgrade', (req, socket) => {
    const path = new URL(req.url ?? '/', 'http://localhost').pathname;
    if (path !== '/ebusd') {
      socket.end('HTTP/1.1 404 Not Found\r\n\r\n');
      return;
    }
    relay(opts, req, socket);
  });

  server.listen(opts.port, opts.bind, () => {
    console.log(`[bridge] web app:   http://${opts.bind === '0.0.0.0' ? 'localhost' : opts.bind}:${opts.port}/`);
    console.log(`[bridge] websocket: /ebusd -> ebusd ${opts.ebusdHost}:${opts.ebusdPort}`);
    console.log(`[bridge] write commands ${opts.allowWrite ? 'ENABLED' : 'blocked (read-only)'}`);
  });
}

main();

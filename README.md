# EBus Analyzer

Browser tool that simplifies reverse engineering of eBUS traffic using
[ebusd](https://github.com/john30/ebusd).

- Shows all telegrams ebusd sees, grouped by message, with frequency and history
- Highlights new and unknown telegrams and the bytes that change
- Planned: decoding with [ebusd-configuration](https://github.com/john30/ebusd-configuration)
  and reading/writing eBUS TypeSpec definitions

Status: milestone M1 (capture) in progress. See [docs/REQUIREMENTS.md](docs/REQUIREMENTS.md).

## How it works

```
Browser ──WebSocket──► bridge/ebusd-bridge.mjs ──TCP──► ebusd :8888 ──► eBUS
```

Browsers cannot open TCP connections, so a small bridge (Node.js, no
dependencies) relays a WebSocket to the ebusd command port and serves the web
app. The app polls `grab result all` and `grab result` to collect telegrams and
to tell known from unknown messages.

By default the bridge only relays read-only commands (`info`, `grab`, `scan`,
`read`, `find`, …). Commands that can write to the bus (`write`, `hex`,
`define`, …) are blocked unless the bridge is started with `--allow-write`.

## Quick start

Requirements: Node.js 22.18 or newer, a running ebusd.

```sh
git clone https://github.com/dziegel/ebus-analyzer.git
cd ebus-analyzer
npm install
npm run build
node bridge/ebusd-bridge.mjs --ebusd-host <ebusd-host>
```

Then open `http://<bridge-host>:8080/` in Chrome (PC or phone). The app
connects automatically when it is served by the bridge.

Bridge options (`--help`):

| Option | Default | Meaning |
|--------|---------|---------|
| `--port` | 8080 | HTTP/WebSocket port |
| `--bind` | 0.0.0.0 | Listen address (use 127.0.0.1 to keep it local) |
| `--ebusd-host` | 127.0.0.1 | ebusd host |
| `--ebusd-port` | 8888 | ebusd TCP command port |
| `--allow-write` | off | Also relay commands that write to the bus |

Telegram grabbing is started by the app (`grab`). It is enabled by default in
current ebusd versions.

## Without a heating system

`tools/fake-ebusd.mjs` simulates an ebusd with changing Vaillant-like traffic:

```sh
npm run build
node tools/fake-ebusd.mjs --port 8888 &
node bridge/ebusd-bridge.mjs
```

You can also import the text output of `ebusctl grab result all` (Import
button) or a capture exported from the app (JSON).

## Development

```sh
npm run watch      # compile TypeScript to web/dist on change
npm test           # unit tests + end-to-end test (client → bridge → fake ebusd)
npm run typecheck
```

The app is plain TypeScript and DOM without a framework or bundler; `tsc`
compiles `src/` to `web/dist/`. Tests run with Node's built-in test runner and
type stripping.

| Path | Content |
|------|---------|
| `src/ebus/` | eBUS addresses, telegram parsing, message keys |
| `src/ebusd/` | ebusd response parsers, WebSocket client with command queue and reconnect |
| `src/store/` | Telegram aggregation (counts, intervals, history), IndexedDB persistence |
| `src/ui/` | Filtering/sorting and HTML rendering |
| `bridge/` | WebSocket ↔ TCP bridge and static file server |
| `tools/` | Fake ebusd for development |

## License

Apache-2.0. Message definitions from ebusd-configuration (GPL-3.0) are loaded at
runtime and are not part of this repository.

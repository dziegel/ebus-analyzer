# EBus Analyzer

Browser tool that simplifies reverse engineering of eBUS traffic using
[ebusd](https://github.com/john30/ebusd).

- Shows all telegrams ebusd sees, grouped by message, with frequency and history
- Filters by bus participant: one button per device (and per other address seen)
- Filters by value: enter a value from the heat pump's display and see only the
  telegrams that contain it
- Highlights new and unknown telegrams and the bytes that change
- Decodes telegrams with the definitions from
  [ebusd-configuration](https://github.com/john30/ebusd-configuration)
- Analyses unknown telegrams: byte heat map, decoding as candidate types,
  value search, charts over time, notes and tags
- Reads, edits and compiles eBUS TypeSpec in the browser with the official
  TypeSpec compiler and ebus-typespec, and writes TypeSpec from definitions
- Definition assistant: turns an unknown telegram into a definition with type
  suggestions, checks it against all captured payloads and writes TypeSpec
- Planned: live test of drafts against ebusd (M6)

Status: milestones M1 (capture), M2 (decoding), M3 (analysis), M4 (TypeSpec), M5 (assistant) and M7 (value filter) done. See [docs/REQUIREMENTS.md](docs/REQUIREMENTS.md).

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

## Decoding

Once ebusd reports the devices on the bus (`scan result`), the app loads the
matching definition files the same way ebusd does: from
[ebus.github.io](https://ebus.github.io/), the CDN with the CSV files that
[ebus-typespec](https://github.com/john30/ebus-typespec) generates from the
TypeSpec sources of ebusd-configuration. One file is picked per device
(address, ident, SW/HW version), plus the common files (`broadcast.csv`,
`vaillant/scan.csv`, …) and `!load`ed include files.

- Files are cached in the browser; without network the cached versions are used.
- Release (current or `next`) and language (English/German) can be chosen in
  the *Definitions* dialog.
- Local CSV files can be added there; they take precedence over the CDN files.
- Conditions (`[id_sw>=104]`, `[Ehp_heatpumptype=5]`, …) are evaluated from the
  scan result and from decoded values of other captured messages.
- Chained messages (several IDs) are decoded once all parts have been captured.

The decoder is a port of ebusd's data types and field handling and is checked
against ebusd's own test vectors (see Development).

The detail panel can be made wider or narrower by dragging the separator
between the list and the panel (or with the arrow keys when it is focused);
double-click restores the default width. The width is remembered.

## Filtering by bus participant

Above the list, every bus participant is a button: the devices from ebusd's
scan result (address, manufacturer, device ID, SW/HW version) and, with a
dashed border, all other addresses seen in the traffic (e.g. ebusd itself).
The number on a button is the count of messages from/to that participant.

Pressing a button shows only telegrams from or to that participant; pressing
it again or pressing *All* shows everything. The filter combines with the
other filters and the search. Following the eBUS convention, a participant
comprises its slave address and the master address 5 below it, so the
controller at 15 also covers telegrams sent from 10. Broadcasts count only
for their sender.

## Filtering by value

Enter a value you can read on the heat pump's display in the value field next
to the search (`45,5`, `45.5 °C` or a text such as `HMU`). The list then shows
only the telegrams for which some decoding at some byte position yields this
value:

- the decoded fields of known messages (with their own divisors and value lists), and
- all common eBUS types (UCH, D1C, D2B, D2C, UIN/10, EXP, …) at every byte
  position of the data and the response, so unknown messages are found too.

Each remaining row shows where and how the value was found (e.g.
`= 6.00 as D2C in response[1..2]`) and highlights the bytes; the tooltip lists
further matches. Numbers match within half a unit of the last digit entered
(`45,5` → ±0.05); the `±` field sets another tolerance. With *history*, the
newest 100 older payloads per message are searched as well, so a value shown on
the display a moment ago is still found. The filter updates as new telegrams
arrive and combines with the other filters, the search and the participant
filter. Clearing the field shows all telegrams again.

## Analysing unknown messages

- **Byte analysis** (detail panel): every byte of a message as a cell, darker
  the more often it changes; `x` marks the bits that changed. Selecting a byte
  shows it decoded as the common eBUS types (UCH, D1C, D2C, UIN/10, EXP, …)
  with the range seen in the history.
- **Find value**: enter a value you know from the display (`35.5`, `45,5 °C`)
  or a text. All byte positions of all (unknown) messages are decoded with the
  candidate types and compared, optionally including older payloads.
- **Charts**: any candidate or decoded field can be charted over time. The
  charts share one time axis, so an unknown byte can be compared with a known
  value (e.g. the outside temperature) at a glance.
- **Notes, tags, ignore**: per message; included in search, export and import.
  Ignored messages are hidden unless the *Ignored* filter is selected.

The history keeps up to 1000 different payloads per message. Payloads are
collected by polling ebusd's grab result, so a value that changes and changes
back between two polls is missed (Q5 in the requirements).

## TypeSpec

The *TypeSpec* dialog works on a folder of `.tsp` files, e.g. the `src`
folder of a clone of [ebusd-configuration](https://github.com/john30/ebusd-configuration):

- **Open folder…** reads all `.tsp` and translation `.yaml` files (Chrome
  desktop: with write access; other browsers: read-only upload).
- Files can be edited; **Save to folder** writes changed files back,
  **Download sources** saves the project as ZIP.
- **Compile** runs the official TypeSpec compiler with the
  `@ebusd/ebus-typespec` CSV emitter in a web worker. Errors and warnings are
  listed with file and line; clicking one opens the file at that line.
  English or German (`de.yaml`) output can be chosen, **Download CSV** saves
  the emitted files.
- The compiled definitions take precedence over the CDN files for decoding.
  When the whole configuration (`main.tsp`) is compiled, files are picked per
  device like ebusd does; a single compiled file is always used.
- In the detail panel, **TypeSpec** shows any decoded definition as TypeSpec
  (following the conventions of ebusd-configuration) and can add it to the
  project as a starting point.

The compiler is bundled by `npm run build` (`web/dist/tsp-worker.js`, loaded
only when compiling). Without `npm install`, the app builds without it.

## Definition assistant

**Create definition** in the detail panel of a message opens the assistant
with a draft: target address, PB SB, ID bytes and direction (read, write,
passive) are taken from the telegram, the circuit from the device's
definition file or ident (e.g. `hmu`).

- Click a byte of the data or the response (shift-click to extend the
  selection). The assistant suggests types whose values are valid in every
  captured payload, ranked by plausibility (temperature range, smooth
  changes, little-endian high byte, printable text), e.g. `D2C 5.5 … 7`.
  **Add as field**, or pick any type for the selected length.
- Per field: name, type, divisor or factor, value list (`0=off;1=on`), unit
  and comment. Bit fields (`BI0` … `BI7`) can share a byte.
- The values of all fields are shown for every captured payload; the issue
  list reports invalid names, overlapping fields, fields inside the ID, and
  values that are invalid or missing in some payloads.
- The TypeSpec preview is updated while typing; the ebusd CSV line is shown
  below it.
- **Save draft** stores the draft in the browser (and in exports). Saved
  drafts without errors decode immediately and take precedence over all other
  definitions.
- **Save to TypeSpec project** writes all drafts into the folder `assistant/`
  of the TypeSpec project, one file per device and circuit named like in
  ebusd-configuration (`08.hmu.tsp`, `broadcast.tsp`), where they can be
  compiled, edited and saved to the folder.

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

Two optional test suites compare the decoder with reference data that is not
part of this repository (both are GPL-3.0 projects). CI runs them on every push:

```sh
git clone --depth 1 https://github.com/john30/ebusd ../ebusd
git clone --depth 1 https://github.com/eBUS/ebus.github.io ../ebus.github.io
EBUSD_SRC=../ebusd EBUS_CDN=../ebus.github.io npm test
```

- `EBUSD_SRC`: runs ebusd's data type test vectors (`test_data.cpp`) through the decoder.
- `EBUS_CDN`: loads the real definitions for a Vaillant heat pump and decodes
  the simulated traffic of `tools/fake-ebusd.mjs`.
- `EBUSD_CONFIG` (a clone of ebusd-configuration) with the npm packages
  installed: compiles the complete configuration and compares it with the CDN.

`test/e2e/browser.mjs` runs the whole chain in a headless browser (fake ebusd →
bridge → app → definitions from the CDN → TypeSpec compile in the worker →
value filter → definition assistant); CI
runs it and keeps the screenshots as artifact.

The app is plain TypeScript and DOM without a framework or bundler; `tsc`
compiles `src/` to `web/dist/`. Tests run with Node's built-in test runner and
type stripping.

| Path | Content |
|------|---------|
| `src/ebus/` | eBUS addresses, telegram parsing, message keys |
| `src/ebusd/` | ebusd response parsers, WebSocket client with command queue and reconnect |
| `src/defs/` | eBUS data types, CSV definition parser, conditions, file selection, CDN loader, telegram matching |
| `src/decoding.ts` | Decodes captured messages with the loaded definitions |
| `src/analysis/` | Byte statistics, candidate types, value search, time series |
| `src/assistant/` | Definition drafts: CSV conversion, validation, type suggestions, draft store |
| `src/tsp/` | TypeSpec: in-memory compiler host and worker, project I/O, TypeSpec writer |
| `scripts/` | Bundling of the TypeSpec compiler worker |
| `src/store/` | Telegram aggregation (counts, intervals, history), IndexedDB persistence |
| `src/ui/` | Filtering/sorting and HTML rendering |
| `bridge/` | WebSocket ↔ TCP bridge and static file server |
| `tools/` | Fake ebusd for development |

## License

GPL-3.0 (see [LICENSE](LICENSE)), the same license as
[ebusd](https://github.com/john30/ebusd) and
[ebusd-configuration](https://github.com/john30/ebusd-configuration).

The decoder in `src/defs/` is a TypeScript port that closely follows ebusd's
`datatype.cpp` and `data.cpp`. Message definitions are loaded at runtime from
[ebus.github.io](https://ebus.github.io/) and are not part of this repository.

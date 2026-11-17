# EBus Analyzer – Requirements

Status: Draft · Last updated: 2026-11-17

EBus Analyzer is a browser application that receives eBUS telegrams from
[ebusd](https://github.com/john30/ebusd), decodes them using the message
definitions from [ebusd-configuration](https://github.com/john30/ebusd-configuration),
and helps turn unknown telegrams into new eBUS TypeSpec definitions.
The first target system is a Vaillant heat pump.

Requirement IDs use the form `<AREA>-<n>`. Priority: **M** = must (MVP),
**S** = should, **C** = could.

---

## 1. Goals and scope

### 1.1 Goals

- Make reverse engineering of eBUS traffic fast and visual, without a local
  toolchain (Node.js, VS Code, command line).
- Reuse the community definitions from ebusd-configuration instead of
  maintaining a separate database.
- Produce TypeSpec output that can be contributed back to ebusd-configuration
  with minimal manual rework.

### 1.2 In scope

- Live capture of telegrams via ebusd
- Decoding with ebusd-configuration definitions
- Highlighting and analysis of unknown telegrams
- Reading and writing eBUS TypeSpec (`.tsp`) files
- An assistant that builds a TypeSpec definition from an unknown telegram
- Open-source project hosted on GitHub

### 1.3 Out of scope (for now)

- Direct access to eBUS hardware (adapters, serial ports) – ebusd does this
- Replacing ebusd or home-automation integrations (Home Assistant, MQTT dashboards)
- Automatically opening pull requests against ebusd-configuration

---

## 2. System context

```
┌──────────────────────────┐        ┌──────────────┐       ┌──────────┐
│ Browser (Chrome)         │        │ ebusd        │       │ eBUS     │
│  EBus Analyzer (SPA)     │◄──────►│  TCP  :8888  │◄─────►│ adapter  │
│                          │ bridge │  HTTP :8889  │       │ + bus    │
│                          │        └──────────────┘       └──────────┘
│                          │
│                          │  HTTPS  ┌──────────────────────────────────┐
│                          │◄───────►│ GitHub: john30/ebusd-configuration│
└──────────────────────────┘         └──────────────────────────────────┘
          ▲
          │ File System Access API
          ▼
   local .tsp / .csv / log files
```

Relevant ebusd interfaces:

- **TCP command port** (default 8888): line-based commands such as `grab`,
  `grab result [all|decode]`, `scan result`, `read`, `write`, `hex`, `define`,
  `info`. A response ends with an empty line.
- **HTTP JSON port** (`--httpport`): decoded values and message metadata as JSON.
- `hex` requires `--enablehex`; `define` and `read/write -def` require
  `--enabledefine`.

**Architecture constraint:** browsers cannot open raw TCP sockets. Access to
the TCP command port therefore needs a bridge (see ARCH-2 and open question Q1).

---

## 3. Architecture requirements

| ID | Prio | Requirement |
|----|------|-------------|
| ARCH-1 | M | The application is a static single-page app (HTML/JS/CSS) with no mandatory backend of its own. |
| ARCH-2 | M | Access to the ebusd TCP command port goes through a thin, documented bridge (e.g. WebSocket-to-TCP proxy such as websockify, or a minimal companion script). The bridge must not interpret eBUS data. |
| ARCH-3 | S | The app can also be served by ebusd itself (`--htmlpath`) so that the HTTP JSON port is same-origin. |
| ARCH-4 | M | Written in TypeScript; decoding and TypeSpec logic live in UI-independent modules with unit tests. |
| ARCH-5 | S | Deployable to GitHub Pages and runnable from a local file server. |
| ARCH-6 | M | All user data (captures, annotations, drafts) is stored locally in the browser (IndexedDB) and never sent anywhere except to ebusd and GitHub (read-only). |

---

## 4. Functional requirements

### 4.1 Connection to ebusd (CON)

| ID | Prio | Requirement |
|----|------|-------------|
| CON-1 | M | User configures host and port(s) of ebusd / the bridge; settings are persisted. |
| CON-2 | M | Connection status is always visible; the app reconnects automatically after interruptions. |
| CON-3 | M | The app continuously collects telegrams (master part, slave part, source/target address, PB SB, data, timestamp), e.g. by polling `grab result all`. |
| CON-4 | M | The app reads ebusd info and `scan result` (address, manufacturer, device ID, SW/HW version) to know which devices are on the bus. |
| CON-5 | S | The app shows ebusd's own decoding hints (`grab result decode`) next to a telegram. |
| CON-6 | S | Offline mode: import a previously saved capture or an ebusd log file and analyse it without a live connection. |
| CON-7 | C | Send a telegram via `hex` for testing. Every write-type telegram requires explicit user confirmation. |
| CON-8 | C | Send a draft definition to ebusd via `define` / `read -def` to test it live. |

### 4.2 Decoding (DEC)

| ID | Prio | Requirement |
|----|------|-------------|
| DEC-1 | M | Load message definitions from the ebusd-configuration GitHub repository; branch or tag is selectable; definitions are cached locally for offline use. |
| DEC-2 | M | Select the matching definition files per device based on the scan result (manufacturer, device ID such as `HMU00`, SW/HW version), the same way ebusd does. |
| DEC-3 | M | Match each telegram to a message by target address, PB SB and ID bytes; telegrams without a match are flagged as unknown. |
| DEC-4 | M | Decode all fields using the eBUS data types used in ebusd (e.g. UCH, SCH, D1B, D1C, D2B, D2C, DATA2b/c, BCD, HEX, STR, DTM, temperatures), including divisors, units and value lists. |
| DEC-5 | M | Show raw bytes and decoded values side by side; hovering a field highlights its bytes and vice versa. |
| DEC-6 | M | Local definitions (imported or created in the app) take precedence over repository definitions. |
| DEC-7 | S | Show which definition file and model produced a decoding, with a link to the source on GitHub. |

### 4.3 Unknown telegrams (UNK)

| ID | Prio | Requirement |
|----|------|-------------|
| UNK-1 | M | List all telegrams grouped by message key (QQ ZZ PB SB + ID bytes). |
| UNK-2 | M | New, previously unseen telegrams are clearly highlighted. |
| UNK-3 | M | Known (decoded) telegrams can be hidden with one click. |
| UNK-4 | M | Sort by frequency, last seen, interval and address. |
| UNK-5 | M | Per message key keep a history of payloads with timestamps. |
| UNK-6 | M | Show which bytes change over time (byte-level diff / heat map) and which stay constant. |
| UNK-7 | S | Search telegrams for a known value (e.g. "45.5 °C") across all plausible data types and byte positions, similar to `grab result decode`. |
| UNK-8 | S | Plot candidate byte ranges over time to correlate them with known events (e.g. compressor start). |
| UNK-9 | S | Users can annotate, tag or ignore message keys; annotations are persisted and exportable. |
| UNK-10 | C | Correlate unknown fields with decoded values of known messages. |

### 4.4 TypeSpec read/write (TSP)

| ID | Prio | Requirement |
|----|------|-------------|
| TSP-1 | M | Import `.tsp` files by selecting a local directory (File System Access API, fallback `webkitdirectory`), including referenced files such as `_templates.tsp` and i18n YAML files. |
| TSP-2 | M | Parse and compile eBUS TypeSpec in the browser using the TypeSpec compiler and the `@ebusd/ebus-typespec` library. |
| TSP-3 | M | Write `.tsp` files that follow the ebusd-configuration guidelines (`@zz`, `@id`, `@ext`, templates such as `Register<…>`, doc comments). |
| TSP-4 | M | Save back to the selected local directory or download as ZIP. |
| TSP-5 | S | Round-trip: reading and writing an unchanged file preserves comments and formatting where possible. |
| TSP-6 | S | Export ebusd CSV for direct use with a running ebusd (`--configpath`). |
| TSP-7 | S | Show compiler errors and warnings with file and line. |
| TSP-8 | C | Import existing ebusd CSV definitions. |

### 4.5 TypeSpec assistant (ASS)

| ID | Prio | Requirement |
|----|------|-------------|
| ASS-1 | M | From any unknown telegram, create a draft model with prefilled target address, PB SB, ID bytes and message direction (read, write, broadcast, passive). |
| ASS-2 | M | Byte-field editor: select a byte range, choose a data type and immediately see the decoded value for all captured samples of that message. |
| ASS-3 | M | Enter name, description, unit, divisor and value list per field. |
| ASS-4 | M | Live preview of the generated TypeSpec. |
| ASS-5 | S | Suggest plausible data types per byte range (e.g. values that fall into a temperature range across all samples). |
| ASS-6 | S | Validate the draft against all captured samples and report fields that decode to invalid or out-of-range values. |
| ASS-7 | S | Save drafts to the local TypeSpec project (TSP-4); drafts immediately take part in decoding (DEC-6). |
| ASS-8 | C | Test the draft live against ebusd (CON-8). |

### 4.6 User interface (UI)

| ID | Prio | Requirement |
|----|------|-------------|
| UI-1 | M | Runs in current Chrome on desktop and Android; layout adapts to phone screens. |
| UI-2 | M | Filter and full-text search over address, device, message name and hex data. |
| UI-3 | S | Light and dark theme. |
| UI-4 | S | UI language English; German as second language. |

---

## 5. Non-functional requirements

| ID | Prio | Requirement |
|----|------|-------------|
| NFR-1 | M | Handles the full bus load of a 2400 baud eBUS without dropping telegrams in the UI. |
| NFR-2 | M | Stores at least 100,000 telegrams locally; older data can be purged by the user. |
| NFR-3 | M | Initial load (without definitions) under 3 s on a mid-range phone. |
| NFR-4 | M | No telemetry; no data leaves the browser except requests to ebusd and read-only requests to GitHub. |
| NFR-5 | M | Writing to the bus is disabled by default and needs an explicit opt-in. |
| NFR-6 | S | Automated build, tests and deployment via GitHub Actions. |
| NFR-7 | S | Decoder output is verified against ebusd's own decoding for a reference set of telegrams. |

---

## 6. GitHub project

| ID | Prio | Requirement |
|----|------|-------------|
| GH-1 | M | Source code, issues and documentation live in this repository. |
| GH-2 | M | README describes setup of ebusd (required options, ports) and the bridge. |
| GH-3 | S | Releases are tagged and the app is published via GitHub Pages. |
| GH-4 | S | Contribution guide, including how to submit new definitions upstream to ebusd-configuration. |

---

## 7. Open questions and risks

| ID | Topic | Notes |
|----|-------|-------|
| Q1 | Bridge to the TCP port | websockify vs. own small script vs. MQTT over WebSocket. MQTT only carries decoded values, not raw unknown telegrams. |
| Q2 | HTTPS / mixed content | A page served over HTTPS (GitHub Pages) cannot connect to `ws://` or `http://` on the LAN. Options: serve the app locally or via ebusd `--htmlpath`, or run the bridge with TLS. Chrome's Private Network Access rules also apply. |
| Q3 | TypeSpec in the browser | Confirm that the TypeSpec compiler plus `@ebusd/ebus-typespec` can be bundled and run fully client-side (the TypeSpec playground suggests yes). |
| Q4 | Decoding source | Decode directly from compiled TypeSpec, or from the generated CSV that ebusd uses? CSV is simpler; TypeSpec avoids a second format. |
| Q5 | Capture method | Polling `grab result all` returns only the last payload per key; full history may need ebusd's raw/capture log output instead. |
| Q6 | License | The app is Apache-2.0. ebusd-configuration is GPL-3.0, so its definitions must be fetched at runtime and never bundled into the app or this repository. |

---

## 8. Milestones

1. **M1 – Capture:** connection via bridge, telegram list, offline import (CON-1…4, CON-6, UNK-1…4)
2. **M2 – Decode:** load ebusd-configuration, match and decode (DEC-1…6)
3. **M3 – Analyse:** history, byte diff, value search (UNK-5…9)
4. **M4 – TypeSpec I/O:** import, compile, export (TSP-1…7)
5. **M5 – Assistant:** draft models from unknown telegrams (ASS-1…7)
6. **M6 – Live test:** `define` / `hex` integration (CON-7, CON-8, ASS-8)

---

## References

- ebusd: https://github.com/john30/ebusd
- ebusd TCP client commands: https://github.com/john30/ebusd/wiki/3.1.-TCP-client-commands
- ebusd-configuration: https://github.com/john30/ebusd-configuration
- eBUS TypeSpec library: https://github.com/john30/ebus-typespec

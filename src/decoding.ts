// Decodes the captured messages with the loaded definitions and keeps the
// results for the UI. Message based conditions are resolved from the decoded
// values of other captured messages (two passes).

import type { ConditionValue } from './defs/conditions.ts';
import type { DecodedField } from './defs/fields.ts';
import { DefinitionSet, type Decoded, type LoadedFile, type MatchContext } from './defs/repository.ts';
import type { DeviceScan } from './defs/select.ts';
import { bytesToHex, hexToBytes } from './ebus/hex.ts';
import { parseTelegram, type Telegram } from './ebus/telegram.ts';
import { telegramKind } from './ebus/address.ts';
import type { Entry, Sample } from './store/telegram-store.ts';

export class DecodingService {
  #defs: DefinitionSet | undefined;
  #devices: readonly DeviceScan[] = [];
  #results = new Map<string, Decoded | undefined>();
  #values = new Map<string, Decoded>();
  #entries: readonly Entry[] = [];
  #dirty = true;

  get definitions(): DefinitionSet | undefined {
    return this.#defs;
  }

  setFiles(files: readonly LoadedFile[]): void {
    this.#defs = files.length ? new DefinitionSet(files) : undefined;
    this.#dirty = true;
  }

  setDevices(devices: readonly DeviceScan[]): void {
    this.#devices = devices;
    this.#dirty = true;
  }

  /** Marks the results as outdated (store changed). */
  invalidate(): void {
    this.#dirty = true;
  }

  /** Decodes all entries if anything changed since the last call. */
  update(entries: readonly Entry[]): void {
    if (!this.#dirty && entries === this.#entries) return;
    this.#entries = entries;
    this.#dirty = false;
    this.#results.clear();
    const defs = this.#defs;
    if (!defs) {
      this.#values.clear();
      return;
    }
    const ctx = this.#context();
    for (let pass = 0; pass < 2; pass++) {
      const values = new Map<string, Decoded>();
      for (const e of entries) {
        const t = entryTelegram(e);
        const d = t ? defs.decode(t, ctx, (target, pb, sb, id) => this.#chainPart(target, pb, sb, id)) : undefined;
        this.#results.set(e.key, d);
        if (d && !d.result.error && d.result.fields.length) {
          const k = valueKey(d.def.circuit, d.def.name);
          if (!values.has(k) || d.def.type === 'r' || d.def.type === 'u') values.set(k, d);
        }
      }
      this.#values = values;
    }
  }

  /** Decoding result for an entry (after `update`). */
  get(key: string): Decoded | undefined {
    return this.#results.get(key);
  }

  /** Decodes one history sample of an entry with the entry's definition. */
  decodeSample(e: Entry, s: Sample): Decoded | undefined {
    const defs = this.#defs;
    if (!defs) return undefined;
    const t = sampleTelegram(e, s);
    return t ? defs.decode(t, this.#context(), (target, pb, sb, id) => this.#chainPart(target, pb, sb, id)) : undefined;
  }

  #context(): MatchContext {
    return {
      scan: (address) => this.#devices.find((d) => d.address === address),
      value: (circuit, message, field) => fieldValue(this.#values.get(valueKey(circuit, message)), field),
    };
  }

  #chainPart(target: number, pb: number, sb: number, id: readonly number[]): Uint8Array | undefined {
    const idHex = bytesToHex(id);
    let best: Entry | undefined;
    for (const e of this.#entries) {
      if (e.target === target && e.pb === pb && e.sb === sb && e.id === idHex && e.lastSlaveHex) {
        if (!best || e.lastSeen > best.lastSeen) best = e;
      }
    }
    return best ? hexToBytes(best.lastSlaveHex).slice(1) : undefined;
  }
}

function valueKey(circuit: string, message: string): string {
  return `${circuit}.${message}`.toLowerCase();
}

function fieldValue(d: Decoded | undefined, field: string): ConditionValue | undefined {
  if (!d) return undefined;
  const f: DecodedField | undefined = d.result.fields.find((x) => x.name.toLowerCase() === field.toLowerCase());
  if (!f || f.error) return undefined;
  const v: ConditionValue = { text: f.text };
  if (f.raw !== undefined) v.num = f.raw;
  return v;
}

export function entryTelegram(e: Entry): Telegram | undefined {
  try {
    return parseTelegram(e.lastMasterHex, e.lastSlaveHex || undefined);
  } catch {
    return undefined;
  }
}

/** Rebuilds the telegram of a history sample (key bytes + sample payload). */
export function sampleTelegram(e: Entry, s: Sample): Telegram | undefined {
  try {
    const masterData = hexToBytes(e.id + s.master);
    const t: Telegram = {
      source: e.source,
      target: e.target,
      pb: e.pb,
      sb: e.sb,
      masterData,
      kind: telegramKind(e.target),
    };
    if (e.kind === 'master-slave') t.slaveData = hexToBytes(s.slave);
    return t;
  } catch {
    return undefined;
  }
}

// Index of loaded definitions and matching of telegrams (DEC-3).

import type { Telegram } from '../ebus/telegram.ts';
import { combine, evaluateCheck, type ConditionDef, type ConditionRef, type ConditionValue } from './conditions.ts';
import type { DefinitionFile, MessageDef } from './definitions.ts';
import { decodeFields, type DecodeResult } from './fields.ts';
import { parseVersion, type DeviceScan } from './select.ts';

export interface LoadedFile {
  /** Path relative to the language folder, e.g. "vaillant/08.hmu.csv", or the local file name. */
  path: string;
  local: boolean;
  /** Where the CSV was loaded from (remote files). */
  url?: string;
  /** TypeSpec source on GitHub, if known (DEC-7). */
  sourceUrl?: string;
  /** Device address this file was selected for. */
  device?: number;
  /** Path of the file that loaded this one via !load. */
  loadedBy?: string;
  parsed: DefinitionFile;
  /** Condition definitions visible to messages of this file. */
  conditionScope: ConditionDef[];
}

export interface MatchContext {
  /** Scan result of a device by address. */
  scan(address: number): DeviceScan | undefined;
  /** Decoded value of another message's field (for message based conditions). */
  value(circuit: string, message: string, field: string): ConditionValue | undefined;
}

export type ConditionState = 'none' | 'true' | 'unknown' | 'false';

export interface Decoded {
  def: MessageDef;
  file: LoadedFile;
  result: DecodeResult;
  condition: ConditionState;
  /** Number of other definitions that match this telegram as well. */
  alternatives: number;
  /** For chained messages: which part this telegram is and whether all parts were found. */
  chain?: { index: number; count: number; complete: boolean };
}

/** Looks up the latest slave data (after NN) of a chain part. */
export type ChainLookup = (target: number, pb: number, sb: number, id: readonly number[]) => Uint8Array | undefined;

function startsWith(data: Uint8Array, prefix: readonly number[]): boolean {
  if (data.length < prefix.length) return false;
  for (let i = 0; i < prefix.length; i++) if (data[i] !== prefix[i]) return false;
  return true;
}

const STATE_RANK: Record<ConditionState, number> = { true: 3, none: 2, unknown: 1, false: 0 };

export class DefinitionSet {
  readonly files: readonly LoadedFile[];
  readonly #byCommand = new Map<number, Array<{ def: MessageDef; file: LoadedFile; order: number }>>();
  readonly messageCount: number;

  constructor(files: readonly LoadedFile[]) {
    // local files first so that they take precedence (DEC-6)
    this.files = [...files].sort((a, b) => Number(b.local) - Number(a.local));
    let order = 0;
    let count = 0;
    for (const file of this.files) {
      for (const def of file.parsed.messages) {
        const key = (def.pb << 8) | def.sb;
        let list = this.#byCommand.get(key);
        if (!list) this.#byCommand.set(key, (list = []));
        list.push({ def, file, order: order++ });
        count++;
      }
    }
    this.messageCount = count;
  }

  /** All definitions structurally matching the telegram (command, addresses, ID). */
  candidates(t: Telegram): Array<{ def: MessageDef; file: LoadedFile; order: number }> {
    const list = this.#byCommand.get((t.pb << 8) | t.sb) ?? [];
    return list.filter(({ def }) => {
      if (def.qq !== undefined && def.qq !== t.source) return false;
      if (def.zz && !def.zz.includes(t.target)) return false;
      if (def.chain) return def.chain.some((id) => startsWith(t.masterData, id));
      return startsWith(t.masterData, def.id);
    });
  }

  /** Evaluates the conditions of a definition. */
  conditionState(def: MessageDef, file: LoadedFile, ctx: MatchContext): ConditionState {
    if (!def.conditions.length) return 'none';
    const r = combine(def.conditions.map((ref) => evaluateRef(ref, file, ctx)));
    return r === undefined ? 'unknown' : r ? 'true' : 'false';
  }

  /** Finds the best matching definition and decodes the telegram with it. */
  decode(t: Telegram, ctx: MatchContext, chainLookup?: ChainLookup): Decoded | undefined {
    const preferRead = t.kind === 'master-slave' && (t.slaveData?.length ?? 0) > 0;
    const ranked = this.candidates(t)
      .map((c) => ({ ...c, state: this.conditionState(c.def, c.file, ctx) }))
      .filter((c) => c.state !== 'false')
      .sort((a, b) => {
        const idLen = (c: typeof a) => (c.def.chain ? c.def.chain[0]!.length : c.def.id.length);
        const dir = (c: typeof a) => ((c.def.type === 'r' || c.def.type === 'u') === preferRead ? 1 : 0);
        return (
          Number(!!b.def.local) - Number(!!a.def.local) ||
          idLen(b) - idLen(a) ||
          STATE_RANK[b.state] - STATE_RANK[a.state] ||
          dir(b) - dir(a) ||
          a.order - b.order
        );
      });
    const best = ranked[0];
    if (!best) return undefined;
    const { def, file } = best;
    const decoded: Decoded = { def, file, result: { fields: [] }, condition: best.state, alternatives: ranked.length - 1 };

    if (def.chain) {
      const index = def.chain.findIndex((id) => startsWith(t.masterData, id));
      const parts = def.chain.map((id, i) => (i === index ? t.slaveData : chainLookup?.(t.target, t.pb, t.sb, id)));
      const complete = parts.every((p) => p !== undefined);
      decoded.chain = { index, count: def.chain.length, complete };
      if (complete) {
        const slave = new Uint8Array(parts.reduce((n, p) => n + p!.length, 0));
        let pos = 0;
        for (const p of parts) {
          slave.set(p!, pos);
          pos += p!.length;
        }
        decoded.result = decodeFields(def.fields, t.masterData, slave, def.chain[index]!.length);
      }
      return decoded;
    }
    decoded.result = decodeFields(def.fields, t.masterData, t.slaveData, def.id.length);
    return decoded;
  }
}

function evaluateRef(ref: ConditionRef, file: LoadedFile, ctx: MatchContext): boolean | undefined {
  // the last definition with that name in scope wins (own file after parent)
  const def = [...file.conditionScope].reverse().find((c) => c.name === ref.name);
  if (!def) return undefined;
  const check = ref.check ?? def.check;
  if (!check) return undefined;
  return evaluateCheck(check, conditionValue(def, ctx));
}

function conditionValue(def: ConditionDef, ctx: MatchContext): ConditionValue | undefined {
  if (def.circuit.toLowerCase() === 'scan' && !def.message) {
    const address = def.zz ?? def.fileZz;
    if (address === undefined) return undefined;
    const scan = ctx.scan(address);
    if (!scan) return undefined;
    switch (def.field.toUpperCase()) {
      case 'MF':
        return { text: scan.manufacturer };
      case 'ID':
        return { text: scan.deviceId };
      case 'SW':
        return { num: parseVersion(scan.sw), text: scan.sw };
      case 'HW':
        return { num: parseVersion(scan.hw), text: scan.hw };
      default:
        return undefined;
    }
  }
  return ctx.value(def.circuit || def.fileCircuit || '', def.message, def.field);
}

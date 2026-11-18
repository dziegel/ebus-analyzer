import type { TelegramKind } from '../ebus/address.ts';
import { bytesToHex } from '../ebus/hex.ts';
import { idLength, masterHex, messageKey, parseTelegram, payloadHex, slaveHex } from '../ebus/telegram.ts';
import type { GrabLine } from '../ebusd/protocol.ts';

/** One distinct payload of a message, with the time it was first observed. */
export interface Sample {
  t: number;
  /** Master data after the ID bytes (hex). */
  master: string;
  /** Slave data (hex), empty for broadcast / master-master. */
  slave: string;
}

/** Aggregated information about all telegrams sharing one message key. */
export interface Entry {
  key: string;
  source: number;
  target: number;
  pb: number;
  sb: number;
  /** ID bytes after PB SB that are part of the key (hex). */
  id: string;
  kind: TelegramKind;
  firstSeen: number;
  lastSeen: number;
  lastChanged: number;
  /** Total occurrences (from ebusd's counter when available). */
  count: number;
  /** Smoothed time between occurrences in ms, if it could be estimated. */
  intervalMs?: number;
  /** Whether ebusd has a definition for it; undefined if unknown (e.g. offline import). */
  known?: boolean;
  /** True until the user marks it as seen. */
  isNew: boolean;
  /** Latest full telegram in ebusd notation. */
  lastMasterHex: string;
  lastSlaveHex: string;
  /** Distinct payloads, oldest first, capped at HISTORY_LIMIT. */
  history: Sample[];
  /** Extra text ebusd appended to the grab line (e.g. message name). */
  info?: string;
  lengthMismatch?: boolean;
}

export const HISTORY_LIMIT = 1000;

export interface IngestOptions {
  /** Observation time (ms since epoch). */
  now?: number;
  /**
   * Master hex strings that ebusd reported as unknown (`grab result`). When
   * given, every ingested entry gets its `known` flag updated accordingly.
   */
  unknownMasters?: ReadonlySet<string>;
}

export interface IngestStats {
  added: number;
  changed: number;
  invalid: number;
}

interface SavedState {
  version: 1;
  entries: Entry[];
}

/** In-memory store of all observed message keys. */
export class TelegramStore {
  #entries = new Map<string, Entry>();
  /** Last total of ebusd's counters per message key (sum over all lines of that key). */
  #ebusdCounts = new Map<string, number>();
  #listeners = new Set<() => void>();

  get size(): number {
    return this.#entries.size;
  }

  entries(): Entry[] {
    return [...this.#entries.values()];
  }

  get(key: string): Entry | undefined {
    return this.#entries.get(key);
  }

  onChange(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /** Adds grab result lines to the store. */
  ingest(lines: readonly GrabLine[], opts: IngestOptions = {}): IngestStats {
    const now = opts.now ?? Date.now();
    const stats: IngestStats = { added: 0, changed: 0, invalid: 0 };

    // ebusd may report several lines for one of our keys (e.g. a broadcast
    // whose data changes), so occurrences are counted per key: the sum of
    // ebusd's counters over all lines of that key in this batch.
    const parsed = [];
    const countTotals = new Map<string, number>();
    for (const line of lines) {
      try {
        const telegram = parseTelegram(line.masterHex, line.slaveHex);
        const key = messageKey(telegram);
        parsed.push({ line, telegram, key });
        if (line.count !== undefined) countTotals.set(key, (countTotals.get(key) ?? 0) + line.count);
      } catch {
        stats.invalid++;
      }
    }
    const countsDone = new Set<string>();

    for (const { line, telegram, key } of parsed) {
      const payload = payloadHex(telegram);
      const fullMaster = masterHex(telegram);
      const known = opts.unknownMasters ? !opts.unknownMasters.has(fullMaster) : undefined;
      let entry = this.#entries.get(key);

      if (!entry) {
        entry = {
          key,
          source: telegram.source,
          target: telegram.target,
          pb: telegram.pb,
          sb: telegram.sb,
          id: bytesToHex(telegram.masterData.subarray(0, idLength(telegram))),
          kind: telegram.kind,
          firstSeen: now,
          lastSeen: now,
          lastChanged: now,
          count: countTotals.get(key) ?? 1,
          isNew: true,
          lastMasterHex: fullMaster,
          lastSlaveHex: slaveHex(telegram),
          history: [{ t: now, ...payload }],
        };
        if (known !== undefined) entry.known = known;
        if (line.extra) entry.info = line.extra;
        if (telegram.lengthMismatch) entry.lengthMismatch = true;
        this.#entries.set(key, entry);
        const total = countTotals.get(key);
        if (total !== undefined) this.#ebusdCounts.set(key, total);
        countsDone.add(key);
        stats.added++;
        continue;
      }

      const total = countTotals.get(key);
      if (countsDone.has(key)) {
        // occurrences of this key were already handled for this batch
      } else if (total !== undefined) {
        countsDone.add(key);
        const previous = this.#ebusdCounts.get(key);
        this.#ebusdCounts.set(key, total);
        const delta = previous === undefined ? 0 : total - previous;
        if (delta > 0) {
          const dt = now - entry.lastSeen;
          if (dt > 0) {
            const sample = dt / delta;
            entry.intervalMs = entry.intervalMs === undefined ? sample : entry.intervalMs * 0.7 + sample * 0.3;
          }
          entry.count += delta;
          entry.lastSeen = now;
        } else if (previous === undefined) {
          entry.lastSeen = now;
        }
      } else {
        entry.count++;
        entry.lastSeen = now;
      }

      const last = entry.history.at(-1);
      if (!last || last.master !== payload.master || last.slave !== payload.slave) {
        entry.history.push({ t: now, ...payload });
        if (entry.history.length > HISTORY_LIMIT) entry.history.splice(0, entry.history.length - HISTORY_LIMIT);
        entry.lastChanged = now;
        entry.lastSeen = now;
        stats.changed++;
      }
      entry.lastMasterHex = fullMaster;
      entry.lastSlaveHex = slaveHex(telegram);
      if (known !== undefined) entry.known = known;
      if (line.extra) entry.info = line.extra;
      if (telegram.lengthMismatch) entry.lengthMismatch = true;
    }

    if (stats.added || stats.changed || lines.length) this.#emit();
    return stats;
  }

  markSeen(key: string): void {
    const e = this.#entries.get(key);
    if (e?.isNew) {
      e.isNew = false;
      this.#emit();
    }
  }

  markAllSeen(): void {
    for (const e of this.#entries.values()) e.isNew = false;
    this.#emit();
  }

  clear(): void {
    this.#entries.clear();
    this.#ebusdCounts.clear();
    this.#emit();
  }

  toJSON(): SavedState {
    return { version: 1, entries: this.entries() };
  }

  /** Replaces the store content with a saved state. */
  load(state: unknown): void {
    const s = state as Partial<SavedState> | null;
    if (!s || s.version !== 1 || !Array.isArray(s.entries)) throw new Error('unsupported capture format');
    this.#entries.clear();
    this.#ebusdCounts.clear();
    for (const e of s.entries) {
      if (typeof e?.key === 'string' && Array.isArray(e.history)) this.#entries.set(e.key, e);
    }
    this.#emit();
  }

  #emit(): void {
    for (const l of this.#listeners) l();
  }
}

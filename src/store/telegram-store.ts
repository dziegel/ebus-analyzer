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
  /**
   * Coverage (Q5), counted from one poll to the next: telegrams the app
   * received, and telegrams it missed because ebusd's counter went up by more
   * than the app could see (ebusd keeps only the last telegram per message).
   * Jumps above MAX_COUNTED_JUMP (e.g. after the computer slept) are not
   * counted. Counting starts with the second poll after connecting, so the
   * counter's start value does not matter.
   */
  seenCount?: number;
  missedCount?: number;
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

/** Below this share of received telegrams, a message is flagged as faster than the polling (Q5). */
export const COVERAGE_WARN = 0.9;

/**
 * Larger counter jumps between two polls are not counted as missed telegrams:
 * they come from gaps in the polling (computer in standby, connection lost),
 * not from a message that is faster than the polling.
 */
export const MAX_COUNTED_JUMP = 100;

/** Share of the telegrams of a message that the app received, once at least `min` were counted. */
export function coverage(e: Entry, min = 5): number | undefined {
  const total = (e.seenCount ?? 0) + (e.missedCount ?? 0);
  if (total < min) return undefined;
  return (e.seenCount ?? 0) / total;
}

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
  /**
   * ebusd's counters of the lines of each message key in the last poll. A line
   * whose counter did not change brings no new telegram: ebusd can keep a stale
   * line for the same telegram (grabbed under another internal key, e.g. before
   * its definition was loaded), and its old payload must not enter the history.
   */
  #lineCounts = new Map<string, number[]>();
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
    const parsed: Array<{ line: GrabLine; telegram: ReturnType<typeof parseTelegram>; key: string; fresh: boolean }> = [];
    const countTotals = new Map<string, number>();
    const batchCounts = new Map<string, number[]>();
    for (const line of lines) {
      try {
        const telegram = parseTelegram(line.masterHex, line.slaveHex);
        const key = messageKey(telegram);
        parsed.push({ line, telegram, key, fresh: true });
        if (line.count !== undefined) {
          countTotals.set(key, (countTotals.get(key) ?? 0) + line.count);
          batchCounts.set(key, [...(batchCounts.get(key) ?? []), line.count]);
        }
      } catch {
        stats.invalid++;
      }
    }
    // which lines bring new telegrams: their counter changed since the last poll
    /** Lines per key whose counter changed: the telegrams this poll actually delivers. */
    const delivered = new Map<string, number>();
    for (const p of parsed) {
      if (p.line.count === undefined) continue;
      const before = this.#lineCounts.get(p.key);
      if (before) {
        p.fresh = !before.includes(p.line.count);
      } else {
        // first poll of this key: of several lines for the same telegram, only the
        // one ebusd counted most often is current (the others are stale copies)
        const same = parsed.filter((o) => o.key === p.key && o.line.masterHex === p.line.masterHex && o.line.count !== undefined);
        p.fresh = same.every((o) => o === p || o.line.count! < p.line.count! || (o.line.count === p.line.count && parsed.indexOf(o) > parsed.indexOf(p)));
      }
      if (p.fresh && before) delivered.set(p.key, (delivered.get(p.key) ?? 0) + 1);
    }
    for (const [key, counts] of batchCounts) this.#lineCounts.set(key, counts);
    const countsDone = new Set<string>();

    for (const { line, telegram, key, fresh } of parsed) {
      const payload = payloadHex(telegram);
      const fullMaster = masterHex(telegram);
      const known = opts.unknownMasters ? !opts.unknownMasters.has(fullMaster) : undefined;
      let entry = this.#entries.get(key);

      if (!entry && !fresh) continue;
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
          if (previous !== undefined && delta <= MAX_COUNTED_JUMP) {
            const got = Math.min(delta, Math.max(1, delivered.get(key) ?? 0));
            entry.seenCount = (entry.seenCount ?? 0) + got;
            entry.missedCount = (entry.missedCount ?? 0) + delta - got;
          }
        } else if (previous === undefined) {
          entry.lastSeen = now;
        }
      } else {
        entry.count++;
        entry.lastSeen = now;
      }

      // a stale line of ebusd brings no new telegram: keep its payload out
      if (fresh) {
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
      }
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
    this.#lineCounts.clear();
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
    this.#lineCounts.clear();
    for (const e of s.entries) {
      if (typeof e?.key !== 'string' || !Array.isArray(e.history)) continue;
      // counts of an earlier version that included polling gaps
      delete (e as Entry & { occurred?: number; observed?: number }).occurred;
      delete (e as Entry & { occurred?: number; observed?: number }).observed;
      this.#entries.set(e.key, e);
    }
    this.#emit();
  }

  #emit(): void {
    for (const l of this.#listeners) l();
  }
}

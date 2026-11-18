// Per-byte statistics over the payload history of a message (UNK-6).

import { hexToBytes } from '../ebus/hex.ts';
import type { Sample } from '../store/telegram-store.ts';

export interface ByteStat {
  /** Index within the part data (after NN; for the master part including the ID bytes). */
  index: number;
  /** Latest value, if the latest sample has this byte. */
  latest?: number;
  min: number;
  max: number;
  distinct: number;
  /** Number of changes between consecutive samples. */
  changes: number;
  /** Bits that changed at least once. */
  changedBits: number;
  /** Number of samples that contain this byte. */
  samples: number;
}

/**
 * Computes statistics per byte of one part. `prefix` is prepended to every
 * sample (the ID bytes for the master part) so that indexes match field offsets.
 */
export function byteStats(samples: readonly Sample[], part: 'm' | 's', prefix: Uint8Array = new Uint8Array(0)): ByteStat[] {
  const rows = samples.map((s) => {
    const payload = hexToBytes(part === 'm' ? s.master : s.slave);
    if (!prefix.length) return payload;
    const all = new Uint8Array(prefix.length + payload.length);
    all.set(prefix);
    all.set(payload, prefix.length);
    return all;
  });
  const width = rows.reduce((n, r) => Math.max(n, r.length), 0);
  const last = rows.at(-1);
  const stats: ByteStat[] = [];
  for (let i = 0; i < width; i++) {
    const seen = new Set<number>();
    let min = 255;
    let max = 0;
    let changes = 0;
    let changedBits = 0;
    let prev: number | undefined;
    let count = 0;
    for (const r of rows) {
      const v = r[i];
      if (v === undefined) {
        prev = undefined;
        continue;
      }
      count++;
      seen.add(v);
      min = Math.min(min, v);
      max = Math.max(max, v);
      if (prev !== undefined && prev !== v) {
        changes++;
        changedBits |= prev ^ v;
      }
      prev = v;
    }
    const stat: ByteStat = { index: i, min, max, distinct: seen.size, changes, changedBits, samples: count };
    const latest = last?.[i];
    if (latest !== undefined) stat.latest = latest;
    stats.push(stat);
  }
  return stats;
}

/** Heat level 0..4 for a byte: 0 = constant, 4 = changes in most samples. */
export function heatLevel(s: ByteStat): number {
  if (s.distinct <= 1) return 0;
  const rate = s.samples > 1 ? s.changes / (s.samples - 1) : 0;
  if (rate >= 0.75) return 4;
  if (rate >= 0.4) return 3;
  if (rate >= 0.15) return 2;
  return 1;
}

/** Changed bits as "b7..b0" string, e.g. "·····x·x". */
export function bitPattern(mask: number): string {
  let out = '';
  for (let b = 7; b >= 0; b--) out += mask & (1 << b) ? 'x' : '·';
  return out;
}

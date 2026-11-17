import type { Entry } from '../store/telegram-store.ts';
import { hex2 } from './format.ts';

export type FilterMode = 'all' | 'unknown' | 'new';
export type SortMode = 'count' | 'lastSeen' | 'firstSeen' | 'interval' | 'address';

export interface ViewState {
  filter: FilterMode;
  sort: SortMode;
  search: string;
}

/** Text the search box matches against: addresses, PB SB, ID, data, info, device names. */
function searchText(e: Entry, deviceName: (addr: number) => string | undefined): string {
  return [
    hex2(e.source),
    hex2(e.target),
    hex2(e.pb) + hex2(e.sb),
    `${hex2(e.pb)} ${hex2(e.sb)}`,
    e.id,
    e.lastMasterHex,
    e.lastSlaveHex,
    e.info ?? '',
    deviceName(e.source) ?? '',
    deviceName(e.target) ?? '',
    e.kind,
  ]
    .join(' ')
    .toLowerCase();
}

/** Applies filter, search and sort (UI-2, UNK-2..4). */
export function applyView(
  entries: readonly Entry[],
  view: ViewState,
  deviceName: (addr: number) => string | undefined = () => undefined,
): Entry[] {
  const terms = view.search.toLowerCase().split(/\s+/).filter(Boolean);
  const filtered = entries.filter((e) => {
    if (view.filter === 'unknown' && e.known === true) return false;
    if (view.filter === 'new' && !e.isNew) return false;
    if (terms.length) {
      const text = searchText(e, deviceName);
      if (!terms.every((t) => text.includes(t))) return false;
    }
    return true;
  });

  const byKey = (a: Entry, b: Entry) => a.key.localeCompare(b.key);
  const cmp: Record<SortMode, (a: Entry, b: Entry) => number> = {
    count: (a, b) => b.count - a.count || byKey(a, b),
    lastSeen: (a, b) => b.lastSeen - a.lastSeen || byKey(a, b),
    firstSeen: (a, b) => b.firstSeen - a.firstSeen || byKey(a, b),
    interval: (a, b) => (a.intervalMs ?? Infinity) - (b.intervalMs ?? Infinity) || byKey(a, b),
    address: byKey,
  };
  // New entries always float to the top so they are not missed.
  return filtered.sort((a, b) => Number(b.isNew) - Number(a.isNew) || cmp[view.sort](a, b));
}

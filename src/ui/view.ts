import type { Decoded } from '../defs/repository.ts';
import type { AnnotationStore } from '../store/annotations.ts';
import type { Entry } from '../store/telegram-store.ts';
import { hex2 } from './format.ts';

/** 'all' hides ignored messages; 'ignored' shows only those. */
export type FilterMode = 'all' | 'unknown' | 'new' | 'ignored';
export type SortMode = 'count' | 'lastSeen' | 'firstSeen' | 'interval' | 'address';

export interface ViewState {
  filter: FilterMode;
  sort: SortMode;
  search: string;
}

export interface ViewContext {
  deviceName?: (addr: number) => string | undefined;
  /** Decoding result of an entry, when definitions are loaded. */
  decoded?: (e: Entry) => Decoded | undefined;
  /** True when definitions are loaded: "known" then means "decoded by the app". */
  definitionsLoaded?: boolean;
  /** Notes, tags and ignored flags (UNK-9). */
  annotations?: AnnotationStore;
}

/** Whether a message is known: decoded by the loaded definitions, else ebusd's flag. */
export function isKnown(e: Entry, ctx: ViewContext): boolean | undefined {
  if (ctx.definitionsLoaded) return ctx.decoded?.(e) !== undefined;
  return e.known;
}

/** Text the search box matches against: addresses, PB SB, ID, data, info, device and message names. */
function searchText(e: Entry, ctx: ViewContext): string {
  const d = ctx.decoded?.(e);
  return [
    hex2(e.source),
    hex2(e.target),
    hex2(e.pb) + hex2(e.sb),
    `${hex2(e.pb)} ${hex2(e.sb)}`,
    e.id,
    e.lastMasterHex,
    e.lastSlaveHex,
    e.info ?? '',
    ctx.deviceName?.(e.source) ?? '',
    ctx.deviceName?.(e.target) ?? '',
    e.kind,
    d ? `${d.def.circuit}.${d.def.name} ${d.def.comment ?? ''}` : '',
    ctx.annotations?.searchText(e.key) ?? '',
  ]
    .join(' ')
    .toLowerCase();
}

/** Applies filter, search and sort (UI-2, UNK-2..4). */
export function applyView(entries: readonly Entry[], view: ViewState, ctx: ViewContext = {}): Entry[] {
  const terms = view.search.toLowerCase().split(/\s+/).filter(Boolean);
  const filtered = entries.filter((e) => {
    const ignored = ctx.annotations?.isIgnored(e.key) ?? false;
    if (ignored !== (view.filter === 'ignored')) return false;
    if (view.filter === 'unknown' && isKnown(e, ctx) === true) return false;
    if (view.filter === 'new' && !e.isNew) return false;
    if (terms.length) {
      const text = searchText(e, ctx);
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

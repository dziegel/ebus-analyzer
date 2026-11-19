import type { Decoded } from '../defs/repository.ts';
import { BROADCAST, isMaster } from '../ebus/address.ts';
import type { ScanDevice } from '../ebusd/protocol.ts';
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
  /** Show only telegrams from/to this bus participant (see participantKey). */
  participant?: number;
}

/**
 * Key of the participant an address belongs to: a master address belongs to
 * the participant with the slave address master + 5 (eBUS convention), so a
 * device is one participant with both of its addresses.
 */
export function participantKey(address: number): number {
  return isMaster(address) ? (address + 5) & 0xff : address;
}

/** True if the telegram is from or to the participant. */
export function involves(e: Entry, participant: number): boolean {
  return participantKey(e.source) === participant || (e.target !== BROADCAST && participantKey(e.target) === participant);
}

export interface Participant {
  /** participantKey, used as filter value. */
  key: number;
  /** Addresses seen in the traffic (master and/or slave). */
  addresses: number[];
  device?: ScanDevice;
  /** Number of messages from/to this participant. */
  messages: number;
}

/** Bus participants: the scanned devices plus all other addresses seen in the traffic. */
export function participants(entries: readonly Entry[], devices: readonly ScanDevice[]): Participant[] {
  const map = new Map<number, Participant>();
  const get = (key: number) => {
    let p = map.get(key);
    if (!p) map.set(key, (p = { key, addresses: [], messages: 0 }));
    return p;
  };
  for (const d of devices) get(participantKey(d.address)).device = d;
  for (const e of entries) {
    for (const a of [e.source, e.target]) {
      if (a === BROADCAST) continue;
      const p = get(participantKey(a));
      if (!p.addresses.includes(a)) p.addresses.push(a);
    }
  }
  for (const p of map.values()) {
    p.addresses.sort((a, b) => a - b);
    p.messages = entries.filter((e) => involves(e, p.key)).length;
  }
  // scanned devices first (by address), then the others
  return [...map.values()].sort((a, b) => Number(!!b.device) - Number(!!a.device) || a.key - b.key);
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
    if (view.participant !== undefined && !involves(e, view.participant)) return false;
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

// Loads message definitions for the devices on the bus from the ebusd CDN
// (https://ebus.github.io/, generated from ebusd-configuration), with a local
// cache for offline use (DEC-1, DEC-2, DEC-7).

import { parseDefinitionFile, type FileDefaults } from './definitions.ts';
import type { LoadedFile } from './repository.ts';
import { commonFiles, parseFilename, selectDeviceFile, type DeviceScan } from './select.ts';
import type { ConditionDef, ConditionRef } from './conditions.ts';

export interface SourceSettings {
  /** Base URL of the CDN, e.g. "https://ebus.github.io/". */
  baseUrl: string;
  /** "" for the released definitions, "next/" for the upcoming ones. */
  channel: '' | 'next/';
  language: 'en' | 'de';
}

export const DEFAULT_SOURCE: SourceSettings = { baseUrl: 'https://ebus.github.io/', channel: '', language: 'en' };

/** Minimal key-value cache (IndexedDB in the app, a Map in tests). */
export interface Cache {
  get<T>(key: string): Promise<T | undefined>;
  set(key: string, value: unknown): Promise<void>;
}

interface CachedFile {
  hash: string;
  text: string;
}

export interface LoadReport {
  files: LoadedFile[];
  /** Devices for which no definition file was found. */
  unmatched: DeviceScan[];
  errors: string[];
  /** True if (some) files came from the cache because the network failed. */
  offline: boolean;
}

export type FetchText = (url: string) => Promise<string>;

const defaultFetch: FetchText = async (url) => {
  const res = await fetch(url, { cache: 'no-cache' });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url}`);
  return res.text();
};

export function languageRoot(src: SourceSettings): string {
  const base = src.baseUrl.endsWith('/') ? src.baseUrl : `${src.baseUrl}/`;
  return `${base}${src.channel}${src.language}/`;
}

/** Parses mapping.md of the CDN: CSV path (relative to the language folder) or inlined file name → TypeSpec URL. */
export function parseMapping(md: string): Map<string, string> {
  const map = new Map<string, string>();
  const re = /\[([^\]]+\.tsp)\]\((https:\/\/[^)]+)\)\s*&rarr;\s*(?:\[[a-z]+: [^\]]+\]\((?:[a-z]+)\/([^)]+)\)|inlined)/g;
  for (const m of md.matchAll(re)) {
    const [, tspName, url, csvPath] = m;
    if (csvPath) map.set(csvPath, url!);
    else map.set(tspName!.replace(/_inc\.tsp$/, '.inc'), url!);
  }
  return map;
}

export class DefinitionLoader {
  readonly #fetch: FetchText;
  readonly #cache: Cache;

  constructor(cache: Cache, fetchText: FetchText = defaultFetch) {
    this.#cache = cache;
    this.#fetch = fetchText;
  }

  /** Loads device and common files for the given devices. */
  async load(devices: readonly DeviceScan[], src: SourceSettings): Promise<LoadReport> {
    const root = languageRoot(src);
    const report: LoadReport = { files: [], unmatched: [], errors: [], offline: false };

    // versions.json: list of all files with hashes
    let versions: Record<string, { hash: string }>;
    const versionsKey = `defs:${root}versions.json`;
    try {
      versions = JSON.parse(await this.#fetch(`${root}versions.json`)) as Record<string, { hash: string }>;
      await this.#cache.set(versionsKey, versions);
    } catch (err) {
      const cached = await this.#cache.get<Record<string, { hash: string }>>(versionsKey);
      if (!cached) throw new Error(`cannot load file list: ${err instanceof Error ? err.message : String(err)}`);
      versions = cached;
      report.offline = true;
      report.errors.push(`using cached file list (${err instanceof Error ? err.message : String(err)})`);
    }
    const paths = Object.keys(versions);

    // mapping.md: links to the TypeSpec sources (optional)
    let mapping = new Map<string, string>();
    const mappingUrl = `${src.baseUrl.replace(/\/?$/, '/')}${src.channel}mapping.md`;
    try {
      mapping = parseMapping(await this.#cachedText(mappingUrl, fnv1a(JSON.stringify(versions)), report));
    } catch {
      // links are optional
    }

    const wanted = new Map<string, number | undefined>();
    for (const d of devices) {
      const file = selectDeviceFile(d, paths);
      if (file) wanted.set(file, d.address);
      else report.unmatched.push(d);
    }
    const manufacturers = [...new Set(devices.map((d) => d.manufacturer))];
    for (const f of commonFiles(paths, manufacturers)) if (!wanted.has(f)) wanted.set(f, undefined);

    for (const [path, device] of wanted) {
      try {
        const file = await this.#loadFile(root, path, versions[path]?.hash ?? '', report, mapping);
        if (device !== undefined) file.device = device;
        report.files.push(file);
        // !load directives (e.g. product specific .inc files)
        for (const load of file.parsed.loads) {
          const dir = path.includes('/') ? path.slice(0, path.lastIndexOf('/') + 1) : '';
          const incPath = dir + load.file;
          try {
            const inc = await this.#loadFile(root, incPath, versions[incPath]?.hash ?? '', report, mapping, {
              defaults: defaultsFor(path),
              conditions: load.conditions,
              parentScope: file.conditionScope,
            });
            inc.loadedBy = path;
            if (device !== undefined) inc.device = device;
            report.files.push(inc);
          } catch (err) {
            report.errors.push(`${incPath}: ${err instanceof Error ? err.message : String(err)}`);
          }
        }
      } catch (err) {
        report.errors.push(`${path}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    for (const f of report.files) {
      for (const e of f.parsed.errors.slice(0, 5)) report.errors.push(`${f.path}:${e.line}: ${e.message}`);
    }
    return report;
  }

  async #cachedText(url: string, hash: string, report: LoadReport): Promise<string> {
    const key = `defs:${url}`;
    const cached = await this.#cache.get<CachedFile>(key);
    if (cached && hash && cached.hash === hash) return cached.text;
    try {
      const text = await this.#fetch(url);
      await this.#cache.set(key, { hash, text } satisfies CachedFile);
      return text;
    } catch (err) {
      if (cached) {
        report.offline = true;
        return cached.text;
      }
      throw err;
    }
  }

  async #loadFile(
    root: string,
    path: string,
    hash: string,
    report: LoadReport,
    mapping: Map<string, string>,
    inc?: { defaults: FileDefaults; conditions: ConditionRef[]; parentScope: ConditionDef[] },
  ): Promise<LoadedFile> {
    const url = root + path;
    const text = await this.#cachedText(url, hash, report);
    const parsed = parseDefinitionFile(text, path, inc?.defaults ?? defaultsFor(path), inc ? { inheritedConditions: inc.conditions } : {});
    const file: LoadedFile = {
      path,
      local: false,
      url,
      parsed,
      conditionScope: [...(inc?.parentScope ?? []), ...parsed.conditions],
    };
    const source = mapping.get(path) ?? mapping.get(path.slice(path.lastIndexOf('/') + 1));
    if (source) file.sourceUrl = source;
    return file;
  }
}

/** FNV-1a hash as hex, used as cache key for derived files. */
export function fnv1a(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

/** Defaults (target address, circuit) derived from a file path. */
export function defaultsFor(path: string): FileDefaults {
  const info = parseFilename(path.slice(path.lastIndexOf('/') + 1));
  return info ? { zz: info.zz, circuit: info.circuit } : {};
}

/** Parses a definition file the user loaded from disk (DEC-6). */
export function localFile(name: string, text: string): LoadedFile {
  const parsed = parseDefinitionFile(text, name, defaultsFor(name), { local: true });
  return { path: name, local: true, parsed, conditionScope: parsed.conditions };
}

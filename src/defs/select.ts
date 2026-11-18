// Selection of definition files per device, ported from ebusd
// (src/ebusd/scan.cpp: ScanHelper::loadScanConfigFile and
// src/lib/ebus/message.cpp: MessageMap::extractDefaultsFromFilename).

export interface FilenameInfo {
  /** Target address (two hex digits). */
  zz: string;
  /** Device identifier part, e.g. "hmu". */
  ident: string;
  circuit: string;
  suffix: string;
  sw?: number;
  hw?: number;
}

/**
 * Extracts defaults from a file name without directory:
 * `ZZ.[ID.][*.][CIRCUIT.[?.]][*.][HW????.][*.][SW????.][*.]csv`.
 * Returns undefined if the name does not follow the "ZZ." scheme.
 */
export function parseFilename(filename: string): FilenameInfo | undefined {
  let remain = filename;
  if (remain.length > 4 && remain.toLowerCase().endsWith('.csv')) remain = remain.slice(0, -3); // keep trailing "."
  else if (remain.length > 4 && remain.toLowerCase().endsWith('.inc')) remain = remain.slice(0, -3);
  if (remain.indexOf('.') !== 2) return undefined;
  const zz = remain.slice(0, 2);
  if (!/^[0-9a-f]{2}$/i.test(zz)) return undefined;
  remain = remain.slice(2);
  const info: FilenameInfo = { zz: zz.toLowerCase(), ident: '', circuit: '', suffix: '' };
  const version = (marker: string): number | undefined => {
    if (remain.length <= 1) return undefined;
    const pos = remain.lastIndexOf(marker);
    if (pos < 0 || remain.indexOf('.', pos + 1) !== pos + 7) return undefined;
    const digits = remain.slice(pos + 3, pos + 7);
    if (!/^\d{4}$/.test(digits)) return undefined;
    remain = remain.slice(0, pos) + remain.slice(pos + 7);
    return Number(digits);
  };
  const sw = version('.SW');
  if (sw !== undefined) info.sw = sw;
  const hw = version('.HW');
  if (hw !== undefined) info.hw = hw;
  if (remain.length > 1) {
    let pos = remain.indexOf('.', 1);
    if (pos >= 1 && pos <= 6) {
      info.ident = info.circuit = remain.slice(1, pos);
      remain = remain.slice(pos);
      pos = remain.indexOf('.', 1);
      if (pos >= 0 && (pos > 2 || remain[1]! < '0' || remain[1]! > '9')) {
        info.circuit = remain.slice(1, pos);
        remain = remain.slice(pos);
        pos = remain.indexOf('.', 1);
      }
      if (pos === 2 && remain[1]! >= '0' && remain[1]! <= '9') info.suffix = remain.slice(0, 2);
    }
  }
  return info;
}

/** Normalizes a device ident from the scan result like ebusd ("HMU00" → "hmu00"). */
export function normalizeIdent(ident: string): string {
  return ident.replace(/[^A-Za-z0-9_]/g, '').toLowerCase();
}

/** Parses a version from the scan result ("0308" → 308); hex digits fall back like ebusd. */
export function parseVersion(v: string): number {
  return /^\d+$/.test(v) ? Number(v) : parseInt(v, 16) || 0;
}

export interface DeviceScan {
  address: number;
  manufacturer: string;
  deviceId: string;
  sw: string;
  hw: string;
}

/**
 * Picks the best matching file for a device from a list of paths
 * (e.g. "vaillant/08.hmu.csv"). Returns undefined if none matches.
 */
export function selectDeviceFile(device: DeviceScan, paths: readonly string[]): string | undefined {
  const dir = device.manufacturer.toLowerCase();
  const addr = device.address.toString(16).padStart(2, '0');
  const ident = normalizeIdent(device.deviceId);
  const sw = parseVersion(device.sw);
  const hw = parseVersion(device.hw);
  let best: string | undefined;
  let bestMatch = 0;
  for (const path of paths) {
    const slash = path.lastIndexOf('/');
    if (path.slice(0, slash) !== dir) continue;
    const filename = path.slice(slash + 1);
    if (!filename.toLowerCase().endsWith('.csv') || !filename.startsWith(`${addr}.`)) continue;
    const info = parseFilename(filename);
    if (!info || parseInt(info.zz, 16) !== device.address) continue;
    if ((info.sw !== undefined && info.sw !== sw) || (info.hw !== undefined && info.hw !== hw)) continue;
    let match = 1;
    if (info.ident) {
      let remain = ident;
      let matches = false;
      while (remain.length > 0 && remain.length >= info.ident.length) {
        if (info.ident === remain) {
          matches = true;
          break;
        }
        if (!/\d$/.test(remain)) break;
        remain = remain.slice(0, -1);
      }
      if (!matches) continue;
      match += remain.length;
    }
    if (match > bestMatch || (match === bestMatch && best !== undefined && path.length > best.length)) {
      bestMatch = match;
      best = path;
    }
  }
  return best;
}

/**
 * Common files loaded in addition to the device files: definitions in the
 * root and in the manufacturer directories that do not follow the "ZZ."
 * scheme (e.g. broadcast.csv, vaillant/scan.csv).
 */
export function commonFiles(paths: readonly string[], manufacturers: readonly string[]): string[] {
  const dirs = new Set(['', ...manufacturers.map((m) => m.toLowerCase())]);
  return paths.filter((p) => {
    const slash = p.lastIndexOf('/');
    const dir = slash < 0 ? '' : p.slice(0, slash);
    const name = p.slice(slash + 1);
    return dirs.has(dir) && name.toLowerCase().endsWith('.csv') && !name.startsWith('_') && !/^[0-9a-f]{2}\./i.test(name);
  });
}

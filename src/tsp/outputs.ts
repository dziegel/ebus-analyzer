// Turns compiled CSV files into definition files for decoding. Like files
// from the CDN, device files are picked per device (otherwise e.g. 08.bai.csv
// and 08.hmu.csv would both apply to address 08), and !load directives pull
// in the emitted .inc files.

import { parseDefinitionFile } from '../defs/definitions.ts';
import { defaultsFor } from '../defs/loader.ts';
import type { LoadedFile } from '../defs/repository.ts';
import { commonFiles, selectDeviceFile, type DeviceScan } from '../defs/select.ts';

export const COMPILED_PREFIX = 'typespec:';

/**
 * Picks the compiled files to decode with. `userFiles` are always used and
 * come first (e.g. all outputs when a single own file was compiled); all other
 * files are selected per device like ebusd does. Note that the emitter names
 * output files after the namespace and file name (drafts/08.hmu.tsp with
 * namespace Vaillant becomes vaillant/08.hmu.csv).
 */
export function selectCompiled(csv: Record<string, string>, devices: readonly DeviceScan[], userFiles: ReadonlySet<string> = new Set()): LoadedFile[] {
  const paths = Object.keys(csv).filter((p) => p.endsWith('.csv'));
  const user = paths.filter((p) => userFiles.has(p));
  let selected: string[];
  if (!devices.length) selected = paths;
  else {
    const chosen = new Set<string>(user);
    for (const d of devices) {
      const f = selectDeviceFile(d, paths);
      if (f) chosen.add(f);
    }
    for (const f of commonFiles(paths, devices.map((d) => d.manufacturer))) chosen.add(f);
    selected = paths.filter((p) => chosen.has(p));
  }
  selected.sort((a, b) => Number(userFiles.has(b)) - Number(userFiles.has(a)));
  const out: LoadedFile[] = [];
  for (const path of selected) {
    const parsed = parseDefinitionFile(csv[path]!, `${COMPILED_PREFIX}${path}`, defaultsFor(path), { local: true });
    const file: LoadedFile = { path: `${COMPILED_PREFIX}${path}`, local: true, parsed, conditionScope: parsed.conditions };
    out.push(file);
    const dir = path.includes('/') ? path.slice(0, path.lastIndexOf('/') + 1) : '';
    for (const load of parsed.loads) {
      const incPath = dir + load.file;
      const text = csv[incPath];
      if (text === undefined) continue;
      const inc = parseDefinitionFile(text, `${COMPILED_PREFIX}${incPath}`, defaultsFor(path), { local: true, inheritedConditions: load.conditions });
      out.push({ path: `${COMPILED_PREFIX}${incPath}`, local: true, parsed: inc, conditionScope: [...file.conditionScope, ...inc.conditions], loadedBy: file.path });
    }
  }
  return out;
}


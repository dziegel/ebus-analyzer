// Collects the TypeSpec libraries needed in the browser: their package.json,
// all .tsp files and the JS modules the compiler loads at runtime (those
// imported from .tsp files plus the package's main entry).

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const LIBRARIES = ['@typespec/compiler', '@ebusd/ebus-typespec'];

/** Finds the root directory of an installed package. */
export function packageRoot(name) {
  const entry = fileURLToPath(import.meta.resolve(name));
  let dir = dirname(entry);
  for (;;) {
    const pkg = join(dir, 'package.json');
    if (existsSync(pkg)) {
      try {
        if (JSON.parse(readFileSync(pkg, 'utf8')).name === name) return { root: dir, entry };
      } catch {
        // keep searching
      }
    }
    const parent = dirname(dir);
    if (parent === dir) throw new Error(`package root of ${name} not found`);
    dir = parent;
  }
}

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name.startsWith('.')) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (name.endsWith('.tsp')) out.push(p);
  }
  return out;
}

const toPosix = (p) => p.split(sep).join('/');

/**
 * Returns [{ name, root, files: {rel: text}, js: [{ rel, abs }] }].
 */
export function collectLibraries(names = LIBRARIES) {
  return names.map((name) => {
    const { root, entry } = packageRoot(name);
    const files = { 'package.json': readFileSync(join(root, 'package.json'), 'utf8') };
    const js = new Map();
    js.set(toPosix(relative(root, entry)), entry);
    for (const file of walk(root)) {
      const text = readFileSync(file, 'utf8');
      files[toPosix(relative(root, file))] = text;
      for (const m of text.matchAll(/^\s*import\s+"(\.{1,2}\/[^"]+\.js)"\s*;/gm)) {
        const abs = resolve(dirname(file), m[1]);
        if (existsSync(abs)) js.set(toPosix(relative(root, abs)), abs);
      }
    }
    return { name, root, files, js: [...js].map(([rel, abs]) => ({ rel, abs })) };
  });
}

// Compiles an eBUS TypeSpec project in memory with the official TypeSpec
// compiler and the @ebusd/ebus-typespec CSV emitter. Used by the browser
// worker (bundled with esbuild) and by the Node tests. The in-memory host
// follows the TypeSpec playground's browser host.

import {
  compile,
  createSourceFile,
  getSourceFileKindFromExt,
  getSourceLocation,
  resolvePath,
  type CompilerHost,
  type CompilerOptions,
  type Diagnostic,
} from '@typespec/compiler';
import type { CompileRequest, CompileResult, LibraryBundle, TspDiagnostic } from './protocol.ts';

export type { LibraryBundle };

export const EMITTER = '@ebusd/ebus-typespec';
const ROOT = '/test';
const PROJECT = `${ROOT}/project`;
const OUT = `${ROOT}/out`;

function notFound(path: string, code = 'ENOENT'): Error {
  const e = new Error(`File ${path} not found.`);
  (e as Error & { code: string }).code = code;
  return e;
}

export function createMemoryHost(
  libraries: readonly LibraryBundle[],
  files: Record<string, string>,
): { host: CompilerHost; outputs: Map<string, string> } {
  const fs = new Map<string, string>();
  const js = new Map<string, () => Promise<unknown>>();
  const outputs = new Map<string, string>();
  const dependencies: Record<string, string> = {};
  for (const lib of libraries) {
    const base = `${ROOT}/node_modules/${lib.name}`;
    for (const [rel, text] of Object.entries(lib.files)) fs.set(`${base}/${rel}`, text);
    for (const [rel, load] of Object.entries(lib.js)) {
      fs.set(`${base}/${rel}`, '');
      js.set(`${base}/${rel}`, load);
    }
    try {
      dependencies[lib.name] = (JSON.parse(lib.files['package.json'] ?? '{}') as { version?: string }).version ?? '*';
    } catch {
      dependencies[lib.name] = '*';
    }
  }
  fs.set(`${ROOT}/package.json`, JSON.stringify({ name: 'ebus-analyzer-project', dependencies }));
  for (const [rel, text] of Object.entries(files)) fs.set(`${PROJECT}/${rel.replace(/^\/+/, '')}`, text);

  const norm = (p: string) => resolvePath(ROOT, p);
  const host: CompilerHost = {
    async readUrl(url: string) {
      const text = fs.get(url);
      if (text === undefined) throw notFound(url);
      return createSourceFile(text, url);
    },
    async readFile(path: string) {
      const p = norm(path);
      const text = fs.get(p);
      if (text === undefined) throw notFound(p);
      return createSourceFile(text, p);
    },
    async writeFile(path: string, content: string) {
      const p = norm(path);
      fs.set(p, content);
      outputs.set(p, content);
    },
    async readDir(path: string) {
      const p = norm(path);
      const names = new Set<string>();
      for (const key of fs.keys()) {
        if (!key.startsWith(`${p}/`)) continue;
        const rest = key.slice(p.length + 1);
        names.add(rest.includes('/') ? rest.slice(0, rest.indexOf('/')) : rest);
      }
      return [...names];
    },
    async rm(path: string) {
      const p = norm(path);
      for (const key of [...fs.keys()]) if (key === p || key.startsWith(`${p}/`)) fs.delete(key);
    },
    getLibDirs() {
      return [`${ROOT}/node_modules/@typespec/compiler/lib/std`];
    },
    getExecutionRoot() {
      return `${ROOT}/node_modules/@typespec/compiler`;
    },
    async getJsImport(path: string) {
      const load = js.get(norm(path));
      if (!load) throw notFound(path, 'MODULE_NOT_FOUND');
      return (await load()) as Record<string, unknown>;
    },
    async stat(path: string) {
      const p = norm(path);
      if (fs.has(p)) return { isDirectory: () => false, isFile: () => true };
      for (const key of fs.keys()) {
        if (key.startsWith(`${p}/`)) return { isDirectory: () => true, isFile: () => false };
      }
      throw notFound(p);
    },
    async realpath(path: string) {
      return path;
    },
    getSourceFileKind: getSourceFileKindFromExt,
    logSink: { log: () => {} },
    async mkdirp(path: string) {
      return path;
    },
    fileURLToPath(url: string) {
      return url.replace(/^inmemory:\/?/, '');
    },
    pathToFileURL(path: string) {
      return `inmemory:/${norm(path)}`;
    },
  };
  return { host, outputs };
}

function convertDiagnostic(d: Diagnostic): TspDiagnostic {
  const out: TspDiagnostic = {
    severity: d.severity === 'error' ? 'error' : 'warning',
    code: String(d.code),
    message: d.message,
  };
  try {
    const loc = getSourceLocation(d.target as Parameters<typeof getSourceLocation>[0]);
    if (loc) {
      const pos = loc.file.getLineAndCharacterOfPosition(loc.pos);
      const path = loc.file.path;
      out.file = path.startsWith(`${PROJECT}/`) ? path.slice(PROJECT.length + 1) : path;
      out.line = pos.line + 1;
      out.column = pos.character + 1;
    }
  } catch {
    // no location
  }
  return out;
}

/** Compiles the project and returns the emitted CSV files and diagnostics. */
export async function compileProject(req: Omit<CompileRequest, 'id'>, libraries: readonly LibraryBundle[]): Promise<CompileResult> {
  const { host, outputs } = createMemoryHost(libraries, req.files);
  const emitterOptions: Record<string, unknown> = { 'emitter-output-dir': OUT };
  if (req.translations) emitterOptions.translations = `${PROJECT}/${req.translations}`;
  const options: CompilerOptions = {
    outputDir: OUT,
    additionalImports: [EMITTER],
    options: { [EMITTER]: emitterOptions },
  };
  if (req.emit !== false) options.emit = [EMITTER];
  else options.noEmit = true;
  const start = Date.now();
  const program = await compile(host, `${PROJECT}/${req.entry}`, options);
  const csv: Record<string, string> = {};
  for (const [path, text] of outputs) {
    if (path.startsWith(`${OUT}/`)) csv[path.slice(OUT.length + 1)] = text;
  }
  const compilerPkg = libraries.find((l) => l.name === '@typespec/compiler')?.files['package.json'];
  const result: CompileResult = {
    csv,
    diagnostics: program.diagnostics.map(convertDiagnostic),
    timeMs: Date.now() - start,
  };
  try {
    const v = (JSON.parse(compilerPkg ?? '{}') as { version?: string }).version;
    if (v) result.compilerVersion = v;
  } catch {
    // ignore
  }
  return result;
}

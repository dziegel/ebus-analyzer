// A TypeSpec project in the browser: files read from a local folder (File
// System Access API, fallback: <input webkitdirectory>), kept in memory and
// IndexedDB, written back to the folder on request (TSP-1, TSP-4).

/** Files that belong to a project. */
export const PROJECT_FILE = /\.(tsp|ya?ml)$/i;
const MAX_FILE_SIZE = 4 * 1024 * 1024;

export interface ProjectData {
  name: string;
  files: Map<string, string>;
  /** Paths changed or created in the app since loading. */
  changed: Set<string>;
}

interface PermissionHandle {
  queryPermission?(opts: { mode: 'read' | 'readwrite' }): Promise<PermissionState>;
  requestPermission?(opts: { mode: 'read' | 'readwrite' }): Promise<PermissionState>;
}

type DirHandle = FileSystemDirectoryHandle & PermissionHandle & {
  values(): AsyncIterable<FileSystemDirectoryHandle | FileSystemFileHandle>;
};

/** True if the browser can open folders with write access (Chrome desktop). */
export function canPickDirectory(): boolean {
  return typeof (globalThis as { showDirectoryPicker?: unknown }).showDirectoryPicker === 'function';
}

export async function pickDirectory(): Promise<FileSystemDirectoryHandle> {
  const pick = (globalThis as unknown as { showDirectoryPicker(opts?: { mode?: string }): Promise<FileSystemDirectoryHandle> }).showDirectoryPicker;
  return pick({ mode: 'readwrite' });
}

/** Reads all project files below a directory handle. */
export async function readDirectory(handle: FileSystemDirectoryHandle, prefix = ''): Promise<Map<string, string>> {
  const files = new Map<string, string>();
  for await (const entry of (handle as DirHandle).values()) {
    if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
    const path = prefix + entry.name;
    if (entry.kind === 'directory') {
      for (const [p, t] of await readDirectory(entry as FileSystemDirectoryHandle, `${path}/`)) files.set(p, t);
    } else if (PROJECT_FILE.test(entry.name)) {
      const file = await (entry as FileSystemFileHandle).getFile();
      if (file.size <= MAX_FILE_SIZE) files.set(path, await file.text());
    }
  }
  return files;
}

/** Reads project files from an <input type="file" webkitdirectory multiple> selection. */
export async function readFileList(list: FileList | readonly File[]): Promise<{ name: string; files: Map<string, string> }> {
  const files = new Map<string, string>();
  let name = 'project';
  for (const f of Array.from(list)) {
    const rel = (f as File & { webkitRelativePath?: string }).webkitRelativePath || f.name;
    const parts = rel.split('/');
    if (parts.length > 1) name = parts[0]!;
    const path = parts.length > 1 ? parts.slice(1).join('/') : rel;
    if (path.split('/').some((p) => p.startsWith('.') || p === 'node_modules')) continue;
    if (!PROJECT_FILE.test(path) || f.size > MAX_FILE_SIZE) continue;
    files.set(path, await f.text());
  }
  return { name, files };
}

/** Asks for write permission on a directory handle (needs a user gesture). */
export async function ensureWritable(handle: FileSystemDirectoryHandle): Promise<boolean> {
  const h = handle as DirHandle;
  if ((await h.queryPermission?.({ mode: 'readwrite' })) === 'granted') return true;
  return (await h.requestPermission?.({ mode: 'readwrite' })) === 'granted';
}

/** Writes files into the directory, creating sub directories as needed. */
export async function writeFiles(handle: FileSystemDirectoryHandle, files: Iterable<[string, string]>): Promise<number> {
  let n = 0;
  for (const [path, text] of files) {
    const parts = path.split('/');
    let dir = handle;
    for (const p of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(p, { create: true });
    const fh = await dir.getFileHandle(parts.at(-1)!, { create: true });
    const w = await fh.createWritable();
    await w.write(text);
    await w.close();
    n++;
  }
  return n;
}

/** Picks the compile entry: main.tsp if present, else the given or first .tsp file. */
export function defaultEntry(files: ReadonlyMap<string, string>, preferred?: string): string | undefined {
  if (preferred && files.has(preferred)) return preferred;
  if (files.has('main.tsp')) return 'main.tsp';
  return [...files.keys()].filter((p) => p.endsWith('.tsp')).sort()[0];
}

/** Translation file for a language (e.g. "de.yaml"), if the project has one. */
export function translationFile(files: ReadonlyMap<string, string>, language: string): string | undefined {
  for (const name of [`${language}.yaml`, `${language}.yml`]) if (files.has(name)) return name;
  return undefined;
}

/** Serializable form for IndexedDB. */
export function toStored(p: ProjectData): { name: string; files: Array<[string, string]>; changed: string[] } {
  return { name: p.name, files: [...p.files], changed: [...p.changed] };
}

export function fromStored(s: unknown): ProjectData | undefined {
  const v = s as { name?: string; files?: Array<[string, string]>; changed?: string[] } | undefined;
  if (!v || !Array.isArray(v.files)) return undefined;
  return { name: v.name ?? 'project', files: new Map(v.files), changed: new Set(v.changed ?? []) };
}

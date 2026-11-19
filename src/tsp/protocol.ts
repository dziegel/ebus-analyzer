// Messages between the app and the TypeSpec compiler worker.

export interface CompileRequest {
  id: number;
  /** Project files by path relative to the project root (e.g. "vaillant/08.hmu.tsp", "de.yaml"). */
  files: Record<string, string>;
  /** Entry file relative to the project root (e.g. "main.tsp"). */
  entry: string;
  /** Translation file relative to the project root (e.g. "de.yaml"), if any. */
  translations?: string;
  /** Run the CSV emitter (default true). */
  emit?: boolean;
}

export interface TspDiagnostic {
  severity: 'error' | 'warning';
  code: string;
  message: string;
  /** File relative to the project root; library files keep their virtual path. */
  file?: string;
  /** 1-based line and column. */
  line?: number;
  column?: number;
}

export interface CompileResult {
  /** Emitted CSV files by path relative to the output directory (e.g. "vaillant/08.hmu.csv"). */
  csv: Record<string, string>;
  diagnostics: TspDiagnostic[];
  timeMs: number;
  compilerVersion?: string;
}

export type CompileResponse = ({ id: number; ok: true } & CompileResult) | { id: number; ok: false; error: string };

/** A TypeSpec library made available in the compiler's virtual file system. */
export interface LibraryBundle {
  /** Package name, e.g. "@ebusd/ebus-typespec". */
  name: string;
  /** Text files (package.json, *.tsp) by path relative to the package root. */
  files: Record<string, string>;
  /** JS modules by path relative to the package root. */
  js: Record<string, () => Promise<unknown>>;
}

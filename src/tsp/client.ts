// App side of the TypeSpec compiler worker (web/dist/tsp-worker.js). The
// worker is only loaded when a project is compiled for the first time.

import type { CompileRequest, CompileResponse, CompileResult } from './protocol.ts';

export const WORKER_URL = 'dist/tsp-worker.js';

export class TspCompiler {
  #worker: Worker | undefined;
  #nextId = 1;
  #pending = new Map<number, { resolve: (r: CompileResult) => void; reject: (e: Error) => void }>();
  #available: Promise<boolean> | undefined;

  /** Whether the worker bundle exists (it is only built when the npm packages are installed). */
  available(): Promise<boolean> {
    this.#available ??= fetch(WORKER_URL, { method: 'HEAD', cache: 'no-cache' })
      .then((r) => r.ok)
      .catch(() => false);
    return this.#available;
  }

  compile(req: Omit<CompileRequest, 'id'>): Promise<CompileResult> {
    const worker = this.#ensureWorker();
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      worker.postMessage({ ...req, id } satisfies CompileRequest);
    });
  }

  /** Stops the worker (frees its memory); it is restarted on the next compile. */
  terminate(): void {
    this.#worker?.terminate();
    this.#worker = undefined;
    for (const p of this.#pending.values()) p.reject(new Error('compiler stopped'));
    this.#pending.clear();
  }

  #ensureWorker(): Worker {
    if (this.#worker) return this.#worker;
    const worker = new Worker(WORKER_URL, { type: 'module' });
    worker.onmessage = (ev: MessageEvent<CompileResponse>) => {
      const msg = ev.data;
      const p = this.#pending.get(msg.id);
      if (!p) return;
      this.#pending.delete(msg.id);
      if (msg.ok) {
        const { id: _id, ok: _ok, ...result } = msg;
        p.resolve(result);
      } else p.reject(new Error(msg.error));
    };
    worker.onerror = (ev) => {
      const err = new Error(ev.message || 'TypeSpec compiler failed to load');
      for (const p of this.#pending.values()) p.reject(err);
      this.#pending.clear();
      this.#worker = undefined;
    };
    this.#worker = worker;
    return worker;
  }
}

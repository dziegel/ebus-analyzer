import { ResponseSplitter } from './protocol.ts';

export type ConnectionState = 'disconnected' | 'connecting' | 'connected' | 'reconnecting';

interface Pending {
  command: string;
  resolve: (lines: string[]) => void;
  reject: (err: Error) => void;
  timer?: ReturnType<typeof setTimeout>;
}

export interface ClientOptions {
  /** Timeout per command in ms. */
  commandTimeoutMs?: number;
  /** Maximum delay between reconnect attempts in ms. */
  maxReconnectDelayMs?: number;
  /** Factory for the WebSocket, replaceable in tests. */
  createSocket?: (url: string) => WebSocket;
}

/**
 * Client for the ebusd TCP command interface, reached through the bridge's
 * WebSocket. Commands are sent one at a time; each response ends with an
 * empty line. Reconnects automatically until `disconnect()` is called.
 */
export class EbusdClient {
  #url = '';
  #socket: WebSocket | undefined;
  #state: ConnectionState = 'disconnected';
  #queue: Pending[] = [];
  #active: Pending | undefined;
  #wanted = false;
  #reconnectDelay = 1000;
  #reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  #stateListeners = new Set<(state: ConnectionState, detail?: string) => void>();
  #splitter = new ResponseSplitter((lines) => this.#onResponse(lines));
  readonly #opts: Required<Omit<ClientOptions, 'createSocket'>> & Pick<ClientOptions, 'createSocket'>;

  constructor(opts: ClientOptions = {}) {
    this.#opts = {
      commandTimeoutMs: opts.commandTimeoutMs ?? 15000,
      maxReconnectDelayMs: opts.maxReconnectDelayMs ?? 30000,
      createSocket: opts.createSocket,
    };
  }

  get state(): ConnectionState {
    return this.#state;
  }

  get url(): string {
    return this.#url;
  }

  onStateChange(listener: (state: ConnectionState, detail?: string) => void): () => void {
    this.#stateListeners.add(listener);
    return () => this.#stateListeners.delete(listener);
  }

  connect(url: string): void {
    this.#url = url;
    this.#wanted = true;
    this.#reconnectDelay = 1000;
    clearTimeout(this.#reconnectTimer);
    this.#open('connecting');
  }

  disconnect(): void {
    this.#wanted = false;
    clearTimeout(this.#reconnectTimer);
    this.#socket?.close();
    this.#socket = undefined;
    this.#failAll(new Error('disconnected'));
    this.#setState('disconnected');
  }

  /** Sends a command and resolves with the response lines (without the terminating empty line). */
  command(command: string): Promise<string[]> {
    if (/[\r\n]/.test(command)) return Promise.reject(new Error('command must be a single line'));
    return new Promise((resolve, reject) => {
      this.#queue.push({ command, resolve, reject });
      this.#pump();
    });
  }

  #open(state: ConnectionState): void {
    this.#setState(state);
    this.#splitter.reset();
    let socket: WebSocket;
    try {
      socket = this.#opts.createSocket ? this.#opts.createSocket(this.#url) : new WebSocket(this.#url);
    } catch (err) {
      this.#scheduleReconnect(err instanceof Error ? err.message : String(err));
      return;
    }
    this.#socket = socket;
    socket.onopen = () => {
      if (this.#socket !== socket) return;
      this.#reconnectDelay = 1000;
      this.#setState('connected');
      this.#pump();
    };
    socket.onmessage = (ev: MessageEvent) => {
      if (this.#socket !== socket) return;
      this.#splitter.push(typeof ev.data === 'string' ? ev.data : '');
    };
    socket.onclose = (ev: CloseEvent) => {
      if (this.#socket !== socket) return;
      this.#socket = undefined;
      this.#failAll(new Error('connection closed'));
      if (this.#wanted) this.#scheduleReconnect(ev.reason || `closed (${ev.code})`);
      else this.#setState('disconnected');
    };
  }

  #scheduleReconnect(detail: string): void {
    this.#setState('reconnecting', detail);
    clearTimeout(this.#reconnectTimer);
    this.#reconnectTimer = setTimeout(() => {
      if (this.#wanted) this.#open('reconnecting');
    }, this.#reconnectDelay);
    this.#reconnectDelay = Math.min(this.#reconnectDelay * 2, this.#opts.maxReconnectDelayMs);
  }

  #pump(): void {
    if (this.#active || this.#state !== 'connected' || !this.#socket) return;
    const next = this.#queue.shift();
    if (!next) return;
    this.#active = next;
    next.timer = setTimeout(() => {
      if (this.#active !== next) return;
      next.reject(new Error(`timeout: ${next.command}`));
      // The connection state is unknown now (late response would be
      // attributed to the next command), so start over.
      this.#active = undefined;
      this.#socket?.close();
    }, this.#opts.commandTimeoutMs);
    this.#socket.send(next.command);
  }

  #onResponse(lines: string[]): void {
    const active = this.#active;
    if (!active) return; // unsolicited output (e.g. listen mode) is ignored for now
    clearTimeout(active.timer);
    this.#active = undefined;
    active.resolve(lines);
    this.#pump();
  }

  #failAll(err: Error): void {
    const all = this.#active ? [this.#active, ...this.#queue] : [...this.#queue];
    this.#active = undefined;
    this.#queue = [];
    for (const p of all) {
      clearTimeout(p.timer);
      p.reject(err);
    }
  }

  #setState(state: ConnectionState, detail?: string): void {
    this.#state = state;
    for (const l of this.#stateListeners) l(state, detail);
  }
}

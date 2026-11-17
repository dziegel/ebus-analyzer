import type { EbusdClient } from './ebusd/client.ts';
import {
  isError,
  parseGrabResult,
  parseInfo,
  parseScanResult,
  type ScanDevice,
} from './ebusd/protocol.ts';
import type { TelegramStore } from './store/telegram-store.ts';

export interface CaptureStatus {
  ebusdVersion?: string;
  devices: ScanDevice[];
  lastPoll?: number;
  lastError?: string;
  polling: boolean;
}

/**
 * Polls ebusd for grabbed telegrams while connected (CON-3, CON-4) and feeds
 * them into the store. `grab result` (unknown only) is used to flag known vs.
 * unknown messages.
 */
export class Capture {
  readonly status: CaptureStatus = { devices: [], polling: false };
  #client: EbusdClient;
  #store: TelegramStore;
  #intervalMs: number;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #generation = 0;
  #listeners = new Set<() => void>();

  constructor(client: EbusdClient, store: TelegramStore, intervalMs: number) {
    this.#client = client;
    this.#store = store;
    this.#intervalMs = intervalMs;
    client.onStateChange((state) => {
      if (state === 'connected') void this.#start();
      else this.#stop();
    });
  }

  set intervalMs(ms: number) {
    this.#intervalMs = ms;
  }

  onChange(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /** Re-reads the device list from ebusd. */
  async refreshDevices(): Promise<void> {
    const lines = await this.#client.command('scan result');
    if (!isError(lines)) this.status.devices = parseScanResult(lines);
    this.#emit();
  }

  async #start(): Promise<void> {
    const generation = ++this.#generation;
    this.status.polling = true;
    this.status.lastError = undefined;
    this.#emit();
    try {
      const info = parseInfo(await this.#client.command('info'));
      this.status.ebusdVersion = info.get('version');
      await this.refreshDevices();
      const grab = await this.#client.command('grab');
      if (isError(grab)) this.status.lastError = grab.join(' ');
    } catch (err) {
      this.#fail(err);
    }
    if (generation === this.#generation) await this.#poll(generation);
  }

  #stop(): void {
    this.#generation++;
    clearTimeout(this.#timer);
    if (this.status.polling) {
      this.status.polling = false;
      this.#emit();
    }
  }

  async #poll(generation: number): Promise<void> {
    try {
      const all = await this.#client.command('grab result all');
      const unknown = await this.#client.command('grab result');
      if (generation !== this.#generation) return;
      if (isError(all)) {
        this.status.lastError = all.join(' ');
      } else {
        const unknownMasters = isError(unknown)
          ? undefined
          : new Set(parseGrabResult(unknown).map((l) => l.masterHex));
        this.#store.ingest(parseGrabResult(all), unknownMasters ? { unknownMasters } : {});
        this.status.lastPoll = Date.now();
        this.status.lastError = undefined;
      }
    } catch (err) {
      if (generation !== this.#generation) return;
      this.#fail(err);
    }
    this.#emit();
    if (generation === this.#generation) {
      this.#timer = setTimeout(() => void this.#poll(generation), this.#intervalMs);
    }
  }

  #fail(err: unknown): void {
    this.status.lastError = err instanceof Error ? err.message : String(err);
    this.#emit();
  }

  #emit(): void {
    for (const l of this.#listeners) l();
  }
}

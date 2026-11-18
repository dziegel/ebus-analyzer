import { DEFAULT_SOURCE, type SourceSettings } from './defs/loader.ts';

export interface Settings {
  /** WebSocket URL of the bridge. */
  bridgeUrl: string;
  /** Interval between grab polls in ms. */
  pollIntervalMs: number;
  /** Where message definitions are loaded from. */
  source: SourceSettings;
}

const STORAGE_KEY = 'ebus-analyzer.settings';

/** Default bridge URL: same host when served by the bridge, else localhost. */
export function defaultBridgeUrl(loc: Pick<Location, 'protocol' | 'host'> = location): string {
  if (loc.protocol === 'http:' || loc.protocol === 'https:') {
    const proto = loc.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${proto}//${loc.host}/ebusd`;
  }
  return 'ws://localhost:8080/ebusd';
}

function parseSource(raw: unknown): SourceSettings {
  const s = (raw ?? {}) as Partial<SourceSettings>;
  return {
    baseUrl: typeof s.baseUrl === 'string' && /^https?:\/\//.test(s.baseUrl) ? s.baseUrl : DEFAULT_SOURCE.baseUrl,
    channel: s.channel === 'next/' ? 'next/' : '',
    language: s.language === 'de' ? 'de' : 'en',
  };
}

export function loadSettings(): Settings {
  const defaults: Settings = { bridgeUrl: defaultBridgeUrl(), pollIntervalMs: 5000, source: { ...DEFAULT_SOURCE } };
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return defaults;
    const parsed = JSON.parse(raw) as Partial<Settings>;
    return {
      bridgeUrl: typeof parsed.bridgeUrl === 'string' && parsed.bridgeUrl ? parsed.bridgeUrl : defaults.bridgeUrl,
      pollIntervalMs:
        typeof parsed.pollIntervalMs === 'number' && parsed.pollIntervalMs >= 1000
          ? parsed.pollIntervalMs
          : defaults.pollIntervalMs,
      source: parseSource(parsed.source),
    };
  } catch {
    return defaults;
  }
}

export function saveSettings(settings: Settings): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // storage unavailable (private mode); settings stay in memory
  }
}

export interface Settings {
  /** WebSocket URL of the bridge. */
  bridgeUrl: string;
  /** Interval between grab polls in ms. */
  pollIntervalMs: number;
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

export function loadSettings(): Settings {
  const defaults: Settings = { bridgeUrl: defaultBridgeUrl(), pollIntervalMs: 5000 };
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

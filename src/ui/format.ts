import { byteHex } from '../ebus/hex.ts';

const ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

/** Escapes text for use in HTML content and attribute values. */
export function esc(text: string | number | undefined): string {
  return String(text ?? '').replace(/[&<>"']/g, (c) => ESCAPES[c]!);
}

export function hex2(n: number): string {
  return byteHex(n);
}

/** "12 s", "3 min", "2 h", "4 d" ago. */
export function ago(t: number | undefined, now = Date.now()): string {
  if (t === undefined) return '–';
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 60) return `${s} s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h} h`;
  return `${Math.round(h / 24)} d`;
}

/** Duration in ms as "8 s", "2.5 min", "1 h". */
export function duration(ms: number | undefined): string {
  if (ms === undefined) return '–';
  const s = ms / 1000;
  if (s < 90) return `${Math.round(s)} s`;
  const m = s / 60;
  if (m < 90) return `${m < 10 ? m.toFixed(1) : Math.round(m)} min`;
  return `${(m / 60).toFixed(1)} h`;
}

export function timestamp(t: number): string {
  const d = new Date(t);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

export function dateTime(t: number): string {
  const d = new Date(t);
  return `${d.toLocaleDateString()} ${timestamp(t)}`;
}

/** Splits a hex string into byte strings. */
export function hexBytes(hex: string): string[] {
  const out: string[] = [];
  for (let i = 0; i + 1 < hex.length; i += 2) out.push(hex.slice(i, i + 2));
  return out;
}

/**
 * Indices of bytes that differ in at least one pair of samples. Samples of
 * different lengths count every byte beyond the shortest as varying.
 */
export function varyingBytes(samples: readonly string[]): Set<number> {
  const varying = new Set<number>();
  const first = samples[0];
  if (first === undefined) return varying;
  const firstBytes = hexBytes(first);
  for (const s of samples) {
    const bytes = hexBytes(s);
    const len = Math.max(bytes.length, firstBytes.length);
    for (let i = 0; i < len; i++) if (bytes[i] !== firstBytes[i]) varying.add(i);
  }
  return varying;
}

/** Renders hex bytes as spans; bytes in `mark` get the given class. */
export function bytesHtml(hex: string, mark?: ReadonlySet<number>, markClass = 'var', hit?: ReadonlySet<number>): string {
  if (!hex) return '<span class="none">–</span>';
  return hexBytes(hex)
    .map((b, i) => `<span class="b${mark?.has(i) ? ` ${markClass}` : ''}${hit?.has(i) ? ' hit' : ''}">${b}</span>`)
    .join('');
}

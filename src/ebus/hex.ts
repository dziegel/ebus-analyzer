/** Parses a hex string (with or without spaces) into bytes. Throws on invalid input. */
export function hexToBytes(hex: string): Uint8Array {
  const clean = hex.replace(/\s+/g, '').toLowerCase();
  if (clean.length % 2 !== 0 || !/^[0-9a-f]*$/.test(clean)) {
    throw new Error(`invalid hex string: "${hex}"`);
  }
  const bytes = new Uint8Array(clean.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

/** Formats bytes as lowercase hex, optionally separated. */
export function bytesToHex(bytes: ArrayLike<number>, separator = ''): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join(separator);
}

/** Formats a single byte as two hex digits. */
export function byteHex(b: number): string {
  return b.toString(16).padStart(2, '0');
}

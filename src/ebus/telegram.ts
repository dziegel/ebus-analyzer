import { telegramKind, type TelegramKind } from './address.ts';
import { bytesToHex, byteHex, hexToBytes } from './hex.ts';

/** One eBUS telegram as seen on the bus (without SYN, CRC and ACK bytes). */
export interface Telegram {
  /** Source (QQ) address. */
  source: number;
  /** Target (ZZ) address. */
  target: number;
  /** Primary command byte (PB). */
  pb: number;
  /** Secondary command byte (SB). */
  sb: number;
  /** Master data bytes (after NN). */
  masterData: Uint8Array;
  /** Slave data bytes (after the slave's NN), only for master-slave telegrams. */
  slaveData?: Uint8Array;
  kind: TelegramKind;
  /** Set when the NN length byte does not match the actual data length. */
  lengthMismatch?: boolean;
}

/**
 * Parses a telegram from the hex notation used by ebusd (`grab result`):
 * master part `QQZZPBSBNNDD..` and optional slave part `NNDD..`.
 */
export function parseTelegram(masterHex: string, slaveHex?: string): Telegram {
  const master = hexToBytes(masterHex);
  if (master.length < 5) throw new Error(`master part too short: "${masterHex}"`);
  const nn = master[4]!;
  const masterData = master.slice(5);
  const target = master[1]!;
  const telegram: Telegram = {
    source: master[0]!,
    target,
    pb: master[2]!,
    sb: master[3]!,
    masterData,
    kind: telegramKind(target),
  };
  let mismatch = nn !== masterData.length;
  if (slaveHex !== undefined && slaveHex.trim() !== '') {
    const slave = hexToBytes(slaveHex);
    if (slave.length < 1) throw new Error(`slave part too short: "${slaveHex}"`);
    telegram.slaveData = slave.slice(1);
    if (slave[0] !== telegram.slaveData.length) mismatch = true;
  }
  if (mismatch) telegram.lengthMismatch = true;
  return telegram;
}

/** Master part in ebusd hex notation (QQZZPBSBNNDD..). */
export function masterHex(t: Telegram): string {
  return bytesToHex([t.source, t.target, t.pb, t.sb, t.masterData.length]) + bytesToHex(t.masterData);
}

/** Slave part in ebusd hex notation (NNDD..), or empty string. */
export function slaveHex(t: Telegram): string {
  return t.slaveData ? byteHex(t.slaveData.length) + bytesToHex(t.slaveData) : '';
}

/**
 * Number of master data bytes that identify a message (part of the key).
 *
 * Heuristic, to be replaced by definition-based matching (DEC-3):
 * - master-slave: the request is the message ID, so all master data bytes
 *   count (capped at 6), e.g. Vaillant `b509 0d xxxx` registers.
 * - broadcast / master-master: data usually carries values, so only the first
 *   data byte (often a sub-command) is part of the key.
 */
export function idLength(t: Telegram): number {
  if (t.kind === 'master-slave') return Math.min(t.masterData.length, 6);
  return Math.min(t.masterData.length, 1);
}

/** Stable key that groups telegrams of the same message: `QQZZPBSB[ID..]`. */
export function messageKey(t: Telegram): string {
  return (
    bytesToHex([t.source, t.target, t.pb, t.sb]) + bytesToHex(t.masterData.subarray(0, idLength(t)))
  );
}

/** Payload bytes that may vary between samples of one message key. */
export function payloadHex(t: Telegram): { master: string; slave: string } {
  return {
    master: bytesToHex(t.masterData.subarray(idLength(t))),
    slave: t.slaveData ? bytesToHex(t.slaveData) : '',
  };
}

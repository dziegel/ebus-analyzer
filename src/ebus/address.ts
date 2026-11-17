/** eBUS broadcast address. */
export const BROADCAST = 0xfe;

/** Nibble values allowed in master addresses (both nibbles). */
const MASTER_NIBBLES = new Set([0x0, 0x1, 0x3, 0x7, 0xf]);

/** True if the address is one of the 25 eBUS master addresses. */
export function isMaster(address: number): boolean {
  return MASTER_NIBBLES.has(address >> 4) && MASTER_NIBBLES.has(address & 0x0f);
}

/** True if the address is a valid slave address (not master, not broadcast, not SYN/ESC). */
export function isSlave(address: number): boolean {
  return !isMaster(address) && address !== BROADCAST && address !== 0xaa && address !== 0xa9;
}

/** The slave address belonging to a master (master + 5), or undefined if not a master. */
export function slaveOfMaster(master: number): number | undefined {
  return isMaster(master) ? (master + 5) & 0xff : undefined;
}

export type TelegramKind = 'broadcast' | 'master-master' | 'master-slave';

/** Classifies a telegram by its target address. */
export function telegramKind(target: number): TelegramKind {
  if (target === BROADCAST) return 'broadcast';
  if (isMaster(target)) return 'master-master';
  return 'master-slave';
}

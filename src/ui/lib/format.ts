/**
 * Exact base-unit → decimal-string formatting for the UI.
 *
 * `Number(bigint) / 10n` loses precision above 2^53 and float division can
 * round balances; every displayed amount goes through this bigint-only path
 * instead. Mirrors the backend's `parseTransferAmount` in reverse.
 */

/** Formats a base-unit amount (wei/lamports/stroops/token base units) as a
 *  human-readable decimal string, truncating (never rounding) the fraction. */
export function baseToDecimal(
  base: bigint,
  decimals: number,
  maxFractionDigits = 6,
): string {
  const negative = base < 0n;
  const abs = negative ? -base : base;
  const pow = 10n ** BigInt(Math.max(0, decimals));
  const whole = abs / pow;
  const frac =
    decimals > 0
      ? (abs % pow).toString().padStart(decimals, '0').slice(0, maxFractionDigits)
      : '';
  const fracTrimmed = frac.replace(/0+$/, '');
  return `${negative ? '-' : ''}${whole.toString()}${fracTrimmed ? '.' + fracTrimmed : ''}`;
}

/** Decimal places per chain's native unit. */
export function nativeDecimalsFor(chain: string): number {
  switch (chain) {
    case 'evm':
      return 18;
    case 'solana':
      return 9;
    case 'stellar':
      return 7;
    default:
      return 0;
  }
}

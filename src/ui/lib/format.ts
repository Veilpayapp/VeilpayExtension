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

/**
 * Exact decimal-string → base-unit parsing for the UI.
 *
 * Truncates (never rounds) the fraction beyond `decimals` and returns 0n for
 * malformed input, mirroring `baseToDecimal` in reverse. The background
 * re-parses and validates every amount it is sent, so a UI-side 0n only means
 * "the form is not ready yet".
 */
export function decimalToBase(decimal: string, decimals: number): bigint {
  const dot = decimal.indexOf('.');
  const whole = dot === -1 ? decimal : decimal.slice(0, dot);
  const frac = dot === -1 ? '' : decimal.slice(dot + 1);
  const truncated = frac.slice(0, decimals).padEnd(decimals, '0');
  const scale = 10n ** BigInt(decimals);
  try {
    return BigInt(whole || '0') * scale + BigInt(truncated || '0');
  } catch {
    return 0n;
  }
}

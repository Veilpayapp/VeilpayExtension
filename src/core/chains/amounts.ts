/**
 * Pure decimal <-> base-unit conversion shared by the send flow. Kept separate
 * from any chain/RPC code so it can be unit-tested without a network, and so
 * the background and (potentially) the UI UI both scale amounts identically.
 *
 * All math is BigInt — never float, so `0.001` cannot lose precision.
 */

/** Upper bound mirroring the protocol's NativeAmount guard. */
export const MaxUint256 = 2n ** 256n - 1n;

/**
 * Converts a human-readable decimal string ("0.5") to base units of a token
 * with `decimals` decimal places (wei / lamports / stroops / ERC20 / SPL base
 * units). Fractional digits beyond `decimals` are truncated toward zero, like
 * other wallets. Throws RangeError when the scaled value exceeds uint256.
 */
export function decimalAmountToBaseUnits(decimal: string, decimals: number): bigint {
  // Shape-check first: BigInt('-5') happily produces a negative, and anything
  // the wire encoders do with a negative or malformed amount is silently wrong
  // (sign display says one thing, the signed bytes say another).
  if (!/^\d+(\.\d+)?$/.test(decimal)) {
    throw new RangeError('Amount must be a non-negative decimal string.');
  }
  const dot = decimal.indexOf('.');
  const whole = dot === -1 ? decimal : decimal.slice(0, dot);
  const frac = dot === -1 ? '' : decimal.slice(dot + 1);
  const truncatedFrac = frac.slice(0, decimals).padEnd(decimals, '0');
  const scale = 10n ** BigInt(decimals);
  const base = BigInt(whole || '0') * scale + BigInt(truncatedFrac || '0');
  if (base > MaxUint256) {
    throw new RangeError('Amount exceeds the representable range.');
  }
  return base;
}

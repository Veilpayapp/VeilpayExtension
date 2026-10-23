/**
 * Shamir's Secret Sharing over GF(256).
 *
 * Splits a secret (e.g., a BIP-39 mnemonic) into N shares, where any T
 * (threshold) shares can reconstruct it. Uses the AES irreducible polynomial
 * x^8 + x^4 + x^3 + x^2 + 1 (0x11d) for GF(256) arithmetic.
 *
 * Usage:
 *   const shares = splitSecret(mnemonicBytes, 3, 2);  // 2-of-3
 *   const recovered = combineShares(shares, 2);        // any 2 shares
 *   new TextDecoder().decode(recovered) === mnemonic    // true
 *
 * Each share is a hex-encoded string: "{x}:{hex(y0y1...yn)}".
 */

// ---------------------------------------------------------------------------
// GF(256) arithmetic
// ---------------------------------------------------------------------------

/** Precomputed log table for GF(256). */
const LOG: number[] = new Array(256);
/** Precomputed anti-log (exponential) table for GF(256). */
const EXP: number[] = new Array(256);

function initGf256(): void {
  let x = 1;
  for (let i = 0; i < 255; i += 1) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x >= 0x100) x ^= 0x11d;
  }
  EXP[255] = EXP[0] = 1;
  LOG[0] = 0;
}
initGf256();

function gfMul(a: number, b: number): number {
  if (a === 0 || b === 0) return 0;
  const result = EXP[(LOG[a]! + LOG[b]!) % 255];
  return result === undefined ? 0 : result;
}

function gfDiv(a: number, b: number): number {
  if (b === 0) throw new Error('Division by zero in GF(256).');
  if (a === 0) return 0;
  const result = EXP[(LOG[a]! - LOG[b]! + 255) % 255];
  return result === undefined ? 0 : result;
}

// ---------------------------------------------------------------------------
// Polynomial operations
// ---------------------------------------------------------------------------

/**
 * Evaluates a polynomial at point x using Horner's method.
 * coefficients[0] is the constant term (the secret byte).
 */
function evalPoly(coefficients: number[], x: number): number {
  let result = coefficients[coefficients.length - 1] ?? 0;
  for (let i = coefficients.length - 2; i >= 0; i -= 1) {
    result = gfMul(result, x) ^ (coefficients[i] ?? 0);
  }
  return result;
}

/**
 * Draws a single uniform byte from a CSPRNG.
 *
 * `Math.random()` is predictable and is never acceptable for key material; these
 * coefficients protect a secret's threshold guarantee, so they must come from
 * `crypto.getRandomValues` (256 equally-likely outcomes, rejection-free here
 * because 256 divides 256 exactly).
 */
function randomByte(): number {
  return crypto.getRandomValues(new Uint8Array(1))[0]!;
}

/**
 * Generates a random polynomial of degree (threshold - 1) with the given
 * constant term (the secret byte). Returns coefficients[0..threshold-1].
 */
function randomPoly(secretByte: number, threshold: number): number[] {
  const coeffs: number[] = new Array(threshold);
  coeffs[0] = secretByte;
  for (let i = 1; i < threshold; i += 1) {
    coeffs[i] = randomByte();
  }
  return coeffs;
}

// ---------------------------------------------------------------------------
// Lagrange interpolation
// ---------------------------------------------------------------------------

/**
 * Computes the Lagrange basis polynomial at x=0 for index j.
 * xValues[j] is the evaluation point of share j.
 * Returns the coefficient L_j(0) for share j.
 */
function lagrangeCoefficient(xValues: number[], j: number): number {
  let result = 1;
  const xj = xValues[j]!;
  for (let m = 0; m < xValues.length; m += 1) {
    if (m === j) continue;
    const xm = xValues[m]!;
    // (0 - xm) / (xj - xm) = xm / (xm - xj) in GF(256)
    result = gfMul(result, gfDiv(xm, xm ^ xj));
  }
  return result;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Splits a secret into N shares, where any T (threshold) can reconstruct.
 *
 * @param secret - The raw bytes of the secret (e.g., UTF-8 encoded mnemonic).
 * @param shares - Total number of shares to create (N).
 * @param threshold - Minimum shares required for reconstruction (T).
 * @returns Array of share strings, each formatted as "{x}:{hex(y0y1...yn)}".
 */
export function splitSecret(
  secret: Uint8Array,
  shares: number,
  threshold: number,
): string[] {
  if (secret.length === 0) {
    throw new Error('Secret must not be empty.');
  }
  if (threshold < 2) {
    throw new Error('Threshold must be at least 2.');
  }
  if (threshold > shares) {
    throw new Error('Threshold cannot exceed the number of shares.');
  }
  if (shares > 255) {
    throw new Error('Maximum 255 shares.');
  }

  // Generate one random polynomial per byte of the secret.
  const polynomials: number[][] = [];
  for (let j = 0; j < secret.length; j += 1) {
    polynomials.push(randomPoly(secret[j]!, threshold));
  }

  // Evaluate each polynomial at all share x-values.
  const result: string[] = [];
  for (let i = 1; i <= shares; i += 1) {
    const yValues: number[] = new Array(secret.length);
    for (let j = 0; j < secret.length; j += 1) {
      yValues[j] = evalPoly(polynomials[j]!, i);
    }
    result.push(`${i}:${bytesToHex(new Uint8Array(yValues))}`);
  }
  return result;
}

/**
 * Reconstructs the secret from T or more shares.
 *
 * @param shareStrings - Array of share strings, each formatted as "{x}:{hex}".
 * @param threshold - The threshold T (must match the number of shares provided).
 * @returns The reconstructed secret bytes.
 */
export function combineShares(
  shareStrings: string[],
  threshold: number,
): Uint8Array {
  if (shareStrings.length < threshold) {
    throw new Error(
      `Need at least ${threshold} shares, got ${shareStrings.length}.`,
    );
  }

  // Parse the shares.
  const xValues: number[] = [];
  const yMatrices: number[][] = [];

  for (const s of shareStrings) {
    const parts = s.split(':');
    if (parts.length < 2) {
      throw new Error(`Invalid share format: "${s}".`);
    }
    const x = Number.parseInt(parts[0]!, 10);
    if (x < 1 || x > 255) {
      throw new Error(`Invalid share x-value: ${x}.`);
    }
    const yHex = parts.slice(1).join(':');
    const yBytes = hexToBytes(yHex);
    xValues.push(x);

    const yRow: number[] = [];
    for (const byte of yBytes) {
      yRow.push(byte);
    }
    yMatrices.push(yRow);
  }

  // Verify all shares have the same length.
  const secretLen = yMatrices[0]!.length;
  for (const row of yMatrices) {
    if (row.length !== secretLen) {
      throw new Error('All shares must have the same byte length.');
    }
  }

  // Duplicate x-values make the Lagrange denominators zero — catch it with a
  // clear message instead of surfacing "Division by zero in GF(256)".
  const usedX = xValues.slice(0, threshold);
  if (new Set(usedX).size !== usedX.length) {
    throw new Error('Duplicate share x-values: each share may only be used once.');
  }
  const usedY = yMatrices.slice(0, threshold);

  // Compute Lagrange coefficients for each share.
  const coeffs: number[] = new Array(threshold);
  for (let i = 0; i < threshold; i += 1) {
    coeffs[i] = lagrangeCoefficient(usedX, i);
  }

  // Reconstruct each byte of the secret.
  const secret = new Uint8Array(secretLen);
  for (let j = 0; j < secretLen; j += 1) {
    let value = 0;
    for (let i = 0; i < threshold; i += 1) {
      value ^= gfMul(usedY[i]![j]!, coeffs[i]!);
    }
    secret[j] = value;
  }

  return secret;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function bytesToHex(bytes: Uint8Array): string {
  let out = '';
  for (const b of bytes) {
    out += b.toString(16).padStart(2, '0');
  }
  return out;
}

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.replace(/\s+/g, '');
  if (clean.length % 2 !== 0) {
    throw new Error(`Odd-length hex string: ${hex}`);
  }
  // Reject anything that is not exact hex pairs: parseInt('zz', 16) is NaN
  // (which becomes a silent 0 byte) and parseInt('1g', 16) is 1 — either way a
  // typo'd share would reconstruct a silently WRONG secret instead of erroring.
  if (!/^([0-9a-fA-F]{2})*$/.test(clean)) {
    throw new Error('Share contains characters that are not hexadecimal.');
  }
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i += 1) {
    out[i] = Number.parseInt(clean.substring(i * 2, i * 2 + 2), 16);
  }
  return out;
}
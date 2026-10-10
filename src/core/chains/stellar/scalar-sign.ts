/**
 * Raw-scalar Ed25519 primitives — for keys that are NOT seed-derived.
 *
 * Standard Ed25519 "private keys" (every Stellar account) are 32-byte seeds:
 * the public key is clamp(SHA-512(seed)[0..32])·B — a one-way hash. Additive
 * key derivations (stealth one-time keys) cannot exist in the seed model, so
 * this module works with CANONICAL RAW SCALARS (0 < s < L) directly:
 *
 *   public point  P = s·B          (scalarPublicKey)
 *   signature     RFC 8032 equation over the explicit scalar (signWithScalar)
 *
 * The signatures are standard 64-byte Ed25519 signatures that verify with any
 * Ed25519 implementation (Horizon included): the verifier checks
 * [S]B = R + [H(R,A,M)]A with A = s·B — exact algebra, no clamping.
 *
 * Standalone by design (no imports from transaction.ts) so both the Stellar
 * transaction builder and the privacy layer can use it without cycles.
 */
import { ed25519 } from '@noble/curves/ed25519';
import { sha512 } from '@noble/hashes/sha2';

/** ed25519 group order L. */
export const ED25519_ORDER = ed25519.CURVE.n;

/** Big-endian bytes → bigint. */
export function bytesToBigInt(bytes: Uint8Array): bigint {
  let value = 0n;
  for (const byte of bytes) value = (value << 8n) | BigInt(byte);
  return value;
}

/** LITTLE-endian bytes → bigint — Ed25519's integer-from-octets convention. */
export function bytesToBigIntLE(bytes: Uint8Array): bigint {
  let value = 0n;
  for (let i = bytes.length - 1; i >= 0; i -= 1) value = (value << 8n) | BigInt(bytes[i]!);
  return value;
}

/** bigint → fixed 32-byte big-endian (canonical, values must be < 2^256). */
export function bigIntToBytes32(value: bigint): Uint8Array {
  const out = new Uint8Array(32);
  let v = value;
  for (let i = 31; i >= 0; i -= 1) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return out;
}

/**
 * bigint → fixed 32-byte LITTLE-endian — the wire encoding of an Ed25519
 * signature's S component (RFC 8032: scalars in signatures are little-endian,
 * unlike everything else on the wire).
 */
export function bigIntToBytes32LE(value: bigint): Uint8Array {
  const out = new Uint8Array(32);
  let v = value;
  for (let i = 0; i < 32; i += 1) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return out;
}

function concatBytes(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

function concat3(a: Uint8Array, b: Uint8Array, c: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length + c.length);
  out.set(a, 0);
  out.set(b, a.length);
  out.set(c, a.length + b.length);
  return out;
}

/**
 * The public point of a raw scalar: P = s·B.
 *
 * NOT ed25519.getPublicKey — that treats the input as a seed (SHA-512 +
 * clamp), producing a different point. Direct multiplication is the point.
 */
export function scalarPublicKey(scalar: Uint8Array): Uint8Array {
  return ed25519.ExtendedPoint.BASE.multiply(bytesToBigInt(scalar) % ED25519_ORDER).toRawBytes();
}

/**
 * Signs a message with a raw scalar — the RFC 8032 Ed25519 equation over an
 * EXPLICIT scalar, because an additively-derived key has no seed, so
 * ed25519.sign (seed model) cannot sign for it.
 *
 *   r = H(scalarBytes || message) mod L          (deterministic nonce)
 *   R = r·B
 *   k = H(R_bytes || A_bytes || message) mod L
 *   S = (r + k·s) mod L
 *   signature = R_bytes || S_bytes (S LITTLE-endian, per RFC 8032)
 *
 * The scalar never leaves this function.
 */
export function signWithScalar(message: Uint8Array, scalar: Uint8Array): Uint8Array {
  const s = bytesToBigInt(scalar) % ED25519_ORDER;
  if (s === 0n) {
    throw new Error('Cannot sign with a zero scalar.');
  }
  const scalarBytes = bigIntToBytes32(s);
  const A = ed25519.ExtendedPoint.BASE.multiply(s);
  // RFC 8032: every integer-from-octets conversion is LITTLE-endian — the
  // nonce and the challenge hash are both read LE (noble: modN_LE).
  let r = bytesToBigIntLE(sha512(concatBytes(scalarBytes, message))) % ED25519_ORDER;
  if (r === 0n) r = 1n; // hygiene: a zero nonce leaks the scalar in S
  const R = ed25519.ExtendedPoint.BASE.multiply(r);
  const k = bytesToBigIntLE(sha512(concat3(R.toRawBytes(), A.toRawBytes(), message))) % ED25519_ORDER;
  const S = (r + k * s) % ED25519_ORDER;
  const out = new Uint8Array(64);
  out.set(R.toRawBytes(), 0);
  out.set(bigIntToBytes32LE(S), 32);
  return out;
}

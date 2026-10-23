/**
 * Stealth address cryptography (S6 foundation).
 *
 * Implements the spec's §5.1 scheme over secp256k1:
 *
 *   payer:   ephemeral e ← random, S = ECDH(e, viewPub)
 *            oneTimeAddr = spendPub + H(S)·G
 *            publish ephemeralPub on-chain (announcement)
 *   receiver: S = ECDH(viewPriv, ephemeralPub)   — same shared secret
 *            spendKey = spendPriv + H(S)
 *            oneTimeAddr = spendKey·G             — matches the payer's
 *
 * Every payment to the same provider lands on a distinct address (VAP-09), so
 * the provider's revenue is not aggregatable on-chain.
 *
 * Availability (spec §3D): EVM Sepolia and Stellar testnet. This module is
 * chain-agnostic — it produces an address point; callers map it to a chain
 * address (e.g. keccak for EVM).
 */
import { secp256k1 } from '@noble/curves/secp256k1';
import { keccak_256 } from '@noble/hashes/sha3';
import { bytesToHex } from '@noble/hashes/utils';

/** A provider's published meta-address (spend + view keypairs). */
export interface StealthMeta {
  /** Provider spend private key (32 bytes). */
  spendPriv: Uint8Array;
  /** Provider spend public key (compressed, 33 bytes). */
  spendPub: Uint8Array;
  /** Provider view private key (32 bytes). */
  viewPriv: Uint8Array;
  /** Provider view public key (compressed, 33 bytes). */
  viewPub: Uint8Array;
}

/** The payer side of a stealth payment. */
export interface StealthPayment {
  /** Ephemeral private scalar e (32 bytes). Zeroized by the caller after use. */
  ephemeralPriv: Uint8Array;
  /** Ephemeral public point E = e·G — the on-chain announcement. */
  ephemeralPub: Uint8Array;
  /** One-time recipient address as an uncompressed SEC1 point (65 bytes). */
  address: Uint8Array;
}

/** Hash-to-scalar: keccak256(data) reduced mod the curve order, never 0. */
export function hashToScalar(data: Uint8Array): bigint {
  let value = BigInt(`0x${bytesToHex(keccak_256(data))}`) % secp256k1.CURVE.n;
  if (value === 0n) value = 1n;
  return value;
}

function randomScalar(): Uint8Array {
  // Rejection sampling rather than mod-reduction: uniform in [1, n), no
  // modulo bias. Only ever used for ephemeral, never-persisted scalars, so
  // the tighter distribution changes no existing address.
  for (;;) {
    const bytes = crypto.getRandomValues(new Uint8Array(32));
    const value = bytesToBigInt(bytes);
    if (value >= 1n && value < secp256k1.CURVE.n) return bigIntToBytes(value);
  }
}

function bytesToBigInt(bytes: Uint8Array): bigint {
  let value = 0n;
  for (const byte of bytes) value = (value << 8n) | BigInt(byte);
  return value;
}

function bigIntToBytes(value: bigint): Uint8Array {
  const out = new Uint8Array(32);
  let v = value;
  for (let i = 31; i >= 0; i -= 1) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return out;
}

/** Generates a provider meta-address (spend + view keypairs). */
export function generateStealthMeta(): StealthMeta {
  const spendPriv = randomScalar();
  const viewPriv = randomScalar();
  return {
    spendPriv,
    spendPub: secp256k1.getPublicKey(spendPriv, true),
    viewPriv,
    viewPub: secp256k1.getPublicKey(viewPriv, true),
  };
}

/**
 * Derives a one-time payment address for a provider's meta-address.
 *
 * `ephemeralPriv` is optional for testing; production callers omit it and a
 * fresh random scalar is used per payment.
 */
export function deriveStealthAddress(
  spendPub: Uint8Array,
  viewPub: Uint8Array,
  ephemeralPriv: Uint8Array = randomScalar(),
): StealthPayment {
  const S = secp256k1.getSharedSecret(ephemeralPriv, viewPub);
  const hS = hashToScalar(S);
  const oneTime = secp256k1.ProjectivePoint.fromHex(spendPub).add(
    secp256k1.ProjectivePoint.BASE.multiply(hS),
  );
  return {
    ephemeralPriv,
    ephemeralPub: secp256k1.getPublicKey(ephemeralPriv, true),
    address: oneTime.toRawBytes(false),
  };
}

/**
 * Receiver side: recovers the spend key for a one-time address from the
 * announcement `ephemeralPub` and the provider's secrets. The derived key's
 * public point equals the payer's `address` (verified by tests).
 */
export function recoverStealthSpendKey(
  ephemeralPub: Uint8Array,
  viewPriv: Uint8Array,
  spendPriv: Uint8Array,
): Uint8Array {
  const S = secp256k1.getSharedSecret(viewPriv, ephemeralPub);
  const hS = hashToScalar(S);
  return bigIntToBytes((hS + bytesToBigInt(spendPriv)) % secp256k1.CURVE.n);
}

/** Maps a stealth address point to its EVM address (EIP-55 via lowercase keccak). */
export function stealthAddressToEvm(address: Uint8Array): string {
  const hashed = keccak_256(address.slice(1));
  return `0x${bytesToHex(hashed.slice(-20))}`;
}

/** Serializes a meta-address for publishing (e.g. in an x402 challenge). */
export function metaAddressToHex(meta: Pick<StealthMeta, 'spendPub' | 'viewPub'>): string {
  return JSON.stringify({
    spendPub: bytesToHex(meta.spendPub),
    viewPub: bytesToHex(meta.viewPub),
  });
}

/** Parses a serialized meta-address. */
export function metaAddressFromHex(serialized: string): {
  spendPub: Uint8Array;
  viewPub: Uint8Array;
} {
  const parsed = JSON.parse(serialized) as { spendPub: string; viewPub: string };
  return {
    spendPub: Uint8Array.from(parsed.spendPub.match(/.{2}/g)?.map((h) => Number.parseInt(h, 16)) ?? []),
    viewPub: Uint8Array.from(parsed.viewPub.match(/.{2}/g)?.map((h) => Number.parseInt(h, 16)) ?? []),
  };
}

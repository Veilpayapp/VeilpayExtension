/**
 * Stellar-native stealth payments (pXLM) — one-time addresses on ed25519.
 *
 * Scheme (mirrors §5.1 of the Veilpay spec, translated from secp256k1 to the
 * curve Stellar actually uses):
 *
 *   payer:    e ← random scalar mod L
 *             E = e·B                          (32-byte announcement)
 *             S = e·viewPub                    (point ECDH)
 *             oneTimePub = spendPub + H(S)·B   (point addition)
 *             oneTimeAddress = strkey(oneTimePub)
 *             E rides in the transaction's MEMO_HASH (exactly 32 bytes)
 *
 *   receiver: S = viewPriv·E                   (same shared point)
 *             hS = H(S) mod L
 *             oneTimePriv = spendPriv + hS mod L
 *             oneTimePub  = oneTimePriv·B      (matches the payer's point)
 *
 * Every payment lands on a DISTINCT address (VAP-09), so payments to the
 * same recipient are not linkable on-chain. The announcement (MEMO_HASH) is
 * required to recover the funds — the receiver scans recent transactions for
 * hash memos and tests each against their view key (the Monero model).
 *
 * KEY MODEL — ed25519 raw scalars, not seeds. Standard ed25519 "private
 * keys" (used by every Stellar account) are 32-byte seeds: the public key is
 * clamp(SHA-512(seed)[0..32])·B, a one-way hash — no scalar arithmetic on
 * seeds can produce point addition, so an additive stealth scheme is
 * impossible in the seed model. The stealth keys here are therefore CANONICAL
 * RAW SCALARS (0 < s < L): public points come from s·B directly, and the
 * one-time key SIGNS with the raw-scalar Ed25519 equation (see
 * signWithScalar) — a standard, RFC-8032-verifiable signature whose public
 * key is exactly s·B. Stellar only ever sees the public point and a valid
 * signature; it never learns the key model.
 *
 * Key custody: the spend/view scalars are derived deterministically from the
 * vault seed at SLIP-10 paths m/8888'/0' and m/8888'/1', so restoring the
 * phrase restores stealth funds. The one-time private key is only ever
 * derived inside the vault callback and zeroized after use.
 */
import { ed25519 } from '@noble/curves/ed25519';
import { sha256 } from '@noble/hashes/sha256';
import { hmac } from '@noble/hashes/hmac';
import { sha512 } from '@noble/hashes/sha2';
import { encodeStellarAddress } from '@/core/chains/stellar/transaction';
import {
  bigIntToBytes32,
  bytesToBigInt,
  ED25519_ORDER,
  scalarPublicKey,
} from '@/core/chains/stellar/scalar-sign';
import { mnemonicToSeed } from '@/core/vault/key-derivation';

/** ed25519 group order L. */
const L = ED25519_ORDER;

export { signWithScalar } from '@/core/chains/stellar/scalar-sign';
export { scalarPublicKey as stealthPublicKey } from '@/core/chains/stellar/scalar-sign';

/** Recipient-side stealth secrets (32-byte canonical scalars). Never crosses the bus. */
export interface StealthKeys {
  spendPriv: Uint8Array;
  viewPriv: Uint8Array;
}

/** The published meta-address: two ed25519 public points (32 bytes each). */
export interface StealthMeta {
  spendPub: Uint8Array;
  viewPub: Uint8Array;
}

/** The account-data key the meta-address is published under. */
export const STEALTH_DATA_KEY = 'vpstealth';

/** Reduces 32 bytes to a canonical nonzero scalar mod L. */
function scalarFromBytes(bytes: Uint8Array): bigint {
  const value = bytesToBigInt(bytes) % L;
  return value === 0n ? 1n : value;
}

/** Hash-to-scalar: sha256(data) reduced mod L, never zero. */
export function hashToScalar(data: Uint8Array): bigint {
  return scalarFromBytes(sha256(data));
}

function randomScalar(): Uint8Array {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let value = bytesToBigInt(bytes) % L;
  if (value === 0n) value = 1n;
  return bigIntToBytes32(value);
}

/**
 * Derives the stealth spend/view scalars from the vault mnemonic.
 *
 * SLIP-10 ed25519 (the same machinery the Stellar accounts use) at
 * dedicated hardened paths m/8888'/0' (spend) and m/8888'/1' (view) —
 * disjoint from every payment path, so a stealth key can never collide with
 * an account key and restoring the phrase restores stealth funds.
 *
 * The SLIP-10 output is reduced to a CANONICAL scalar (mod L, nonzero):
 * ~6% of raw 32-byte derivations exceed L, and the scheme's point arithmetic
 * requires canonical scalars (the seed model would hash+clamp instead, which
 * cannot support additive derivation at all).
 */
export function deriveStealthKeys(mnemonic: string): StealthKeys {
  const seed = mnemonicToSeed(mnemonic);
  try {
    return {
      spendPriv: bigIntToBytes32(scalarFromBytes(deriveSlip10Hardened(seed, 0))),
      viewPriv: bigIntToBytes32(scalarFromBytes(deriveSlip10Hardened(seed, 1))),
    };
  } finally {
    seed.fill(0);
  }
}

/** SLIP-10 ed25519 master key from a BIP-39 seed. */
function slip10Master(seed: Uint8Array): { key: Uint8Array; chainCode: Uint8Array } {
  const I = hmac(sha512, new TextEncoder().encode('ed25519 seed'), seed);
  return { key: I.slice(0, 32), chainCode: I.slice(32) };
}

/** One hardened SLIP-10 ed25519 child (ed25519 is hardened-only). */
function deriveSlip10Hardened(seed: Uint8Array, index: number): Uint8Array {
  const node = slip10Master(seed);
  const data = new Uint8Array(37);
  data[0] = 0x00;
  data.set(node.key, 1);
  new DataView(data.buffer).setUint32(33, index | 0x80000000, false);
  const I = hmac(sha512, node.chainCode, data);
  return I.slice(0, 32);
}

/** The meta-address (public points) for a wallet's stealth scalars. */
export function stealthMetaFromKeys(keys: StealthKeys): StealthMeta {
  return {
    spendPub: scalarPublicKey(keys.spendPriv),
    viewPub: scalarPublicKey(keys.viewPriv),
  };
}

/** A payer-side derived private payment. */
export interface DerivedStealthPayment {
  /** Ephemeral scalar e (zeroize after building the transaction). */
  ephemeralPriv: Uint8Array;
  /** E = e·B — the 32-byte MEMO_HASH announcement. */
  ephemeralPub: Uint8Array;
  /** The one-time recipient address (G... strkey) — the payment target. */
  oneTimeAddress: string;
}

/**
 * Derives a fresh one-time payment address for a recipient's meta-address.
 *
 * `ephemeralPriv` is injectable for tests; production callers omit it and a
 * fresh random scalar is used, so every payment lands on a distinct address.
 */
export function deriveStealthPayment(
  meta: StealthMeta,
  ephemeralPriv: Uint8Array = randomScalar(),
): DerivedStealthPayment {
  const e = bytesToBigInt(ephemeralPriv) % L;
  const ephemeralPub = ed25519.ExtendedPoint.BASE.multiply(e).toRawBytes();
  // S = e·viewPub — a point only the payer and the recipient can compute.
  const S = ed25519.ExtendedPoint.fromHex(meta.viewPub).multiply(e);
  const hS = hashToScalar(S.toRawBytes());
  const spendPoint = ed25519.ExtendedPoint.fromHex(meta.spendPub);
  const oneTimePub = spendPoint.add(ed25519.ExtendedPoint.BASE.multiply(hS));
  return {
    ephemeralPriv,
    ephemeralPub,
    oneTimeAddress: encodeStellarAddress(oneTimePub.toRawBytes()),
  };
}

/**
 * Receiver side: recovers the one-time scalar from an announcement.
 * The scalar's public point equals the payer's one-time address (verified by
 * tests); the caller uses it to claim the funds and zeroizes it after.
 */
export function recoverStealthPrivateKey(
  ephemeralPub: Uint8Array,
  viewPriv: Uint8Array,
  spendPriv: Uint8Array,
): Uint8Array {
  // viewPriv is a canonical scalar (< L) by construction — multiply directly.
  const S = ed25519.ExtendedPoint.fromHex(ephemeralPub).multiply(bytesToBigInt(viewPriv));
  const hS = hashToScalar(S.toRawBytes());
  const oneTimePriv = (bytesToBigInt(spendPriv) + hS) % L;
  return bigIntToBytes32(oneTimePriv);
}

/** The one-time address that corresponds to a recovered scalar. */
export function addressForPrivateKey(privateKey: Uint8Array): string {
  return encodeStellarAddress(scalarPublicKey(privateKey));
}

/** Serializes the meta-address for the manage_data value (64 bytes). */
export function encodeMetaValue(meta: StealthMeta): Uint8Array {
  const out = new Uint8Array(64);
  out.set(meta.spendPub, 0);
  out.set(meta.viewPub, 32);
  return out;
}

/** Parses a manage_data value back into a meta-address. */
export function decodeMetaValue(value: Uint8Array): StealthMeta {
  if (value.length !== 64) {
    throw new Error(`A stealth meta-address is 64 bytes, got ${value.length}.`);
  }
  return { spendPub: value.slice(0, 32), viewPub: value.slice(32) };
}

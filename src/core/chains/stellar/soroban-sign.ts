/**
 * Soroban transaction signing for Stellar Private Payments (SPP).
 *
 * The SPP web SDK hands a wallet three signing callbacks (its Rust signer
 * invokes them over the JS boundary, SEP-0043-shaped):
 *
 *   signMessage(message)       → Ed25519 signature over the raw UTF-8 bytes;
 *                                the SDK derives the pool's privacy keys from
 *                                it (KDF domain string included by the SDK).
 *   signAuthEntry(preimageB64) → base64 XDR of a
 *                                HashIdPreimage::SorobanAuthorization; the
 *                                wallet signs sha256(preimage XDR) and returns
 *                                the base64 64-byte signature.
 *   signTransaction(txXdrB64)  → unsigned v1 TransactionEnvelope (auth entries
 *                                already embedded in the operations); the
 *                                wallet appends its DecoratedSignature and
 *                                returns the signed envelope.
 *
 * All three sign with the vault's ordinary Stellar account key (a 32-byte
 * Ed25519 seed), so no new key material exists anywhere.
 */

import { ed25519 } from '@noble/curves/ed25519';
import { sha256 } from '@noble/hashes/sha256';
import { encodeStellarAddress } from '@/core/chains/stellar/transaction';

/** EnvelopeType tag for a v1 Transaction envelope (ENVELOPE_TYPE_TX = 2). */
const ENVELOPE_TYPE_TX = 2;

/**
 * Byte length of one DecoratedSignature:
 *   hint (opaque[4], fixed) + signature (opaque<64>, 4-byte length + 64 bytes).
 */
const DECORATED_SIGNATURE_BYTES = 72;

// ---------------------------------------------------------------------------
// Base64 helpers (browser/service-worker safe, no Buffer)
// ---------------------------------------------------------------------------

/** Encodes bytes as standard base64. */
export function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 1) {
    binary += String.fromCharCode(bytes[i]!);
  }
  return btoa(binary);
}

/** Decodes standard base64; rejects garbage by throwing. */
export function base64ToBytes(text: string): Uint8Array {
  const binary = atob(text);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    out[i] = binary.charCodeAt(i);
  }
  return out;
}

// ---------------------------------------------------------------------------
// XDR primitives
// ---------------------------------------------------------------------------

function xdrUint32(value: number): Uint8Array {
  return new Uint8Array([
    (value >>> 24) & 0xff,
    (value >>> 16) & 0xff,
    (value >>> 8) & 0xff,
    value & 0xff,
  ]);
}

/** Reads a big-endian uint32 at `offset` (bounds-checked by the caller). */
function readUint32(bytes: Uint8Array, offset: number): number {
  return (
    ((bytes[offset]! << 24) >>> 0) +
    (bytes[offset + 1]! << 16) +
    (bytes[offset + 2]! << 8) +
    bytes[offset + 3]!
  );
}

function concat(arrays: Uint8Array[]): Uint8Array {
  const total = arrays.reduce((n, a) => n + a.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const a of arrays) {
    out.set(a, offset);
    offset += a.length;
  }
  return out;
}

/**
 * Splits a v1 envelope body (after the 4-byte type tag) into
 * `{ tx, signatureCount }` by locating the trailing signature vector.
 *
 * The vector is `uint32 count || count × 72 bytes`, so the count field for the
 * TRUE count sits at `body.length − 4 − 72·count`. Candidate counts are scanned
 * from the end and validated against their own position; for well-formed
 * envelopes the true count always validates, and a false positive requires
 * signature bytes that coincidentally encode a matching count (~2⁻³² per
 * candidate). The unsigned envelopes the SPP SDK produces carry zero
 * signatures (the auth entry signatures live inside the operation), for which
 * the trailing bytes are the Transaction's `ext v=0` plus an empty vector.
 */
function splitEnvelopeBody(body: Uint8Array): { tx: Uint8Array; signatureCount: number } {
  let best = -1;
  const maxCount = Math.floor((body.length - 4) / DECORATED_SIGNATURE_BYTES);
  for (let count = 0; count <= maxCount; count += 1) {
    const position = body.length - 4 - DECORATED_SIGNATURE_BYTES * count;
    if (position < 0) break;
    if (readUint32(body, position) === count) {
      best = count; // keep scanning: the largest valid count wins
    }
  }
  if (best < 0) {
    throw new Error('Could not locate the signature vector in the transaction envelope.');
  }
  const txEnd = body.length - 4 - DECORATED_SIGNATURE_BYTES * best;
  if (txEnd <= 0) {
    throw new Error('Transaction envelope has no transaction body.');
  }
  return { tx: body.subarray(0, txEnd), signatureCount: best };
}

// ---------------------------------------------------------------------------
// SPP wallet-signing operations
// ---------------------------------------------------------------------------

/**
 * `signAuthEntry` — signs the SHA-256 of a Soroban authorization preimage.
 *
 * The preimage bytes are the XDR of `HashIdPreimage::SorobanAuthorization`
 * (networkId || nonce || expiration || invocation); the SDK patches the
 * signature into the auth entry's address credentials itself.
 *
 * @returns the base64 64-byte Ed25519 signature.
 */
export function signSorobanAuthPreimage(preimageB64: string, seed: Uint8Array): string {
  if (seed.length !== 32) {
    throw new Error(`Stellar private key must be 32 bytes, got ${seed.length}.`);
  }
  const preimage = base64ToBytes(preimageB64);
  if (preimage.length === 0) {
    throw new Error('The auth entry preimage is empty.');
  }
  const signature = ed25519.sign(sha256(preimage), seed);
  return bytesToBase64(signature);
}

/**
 * `signTransaction` — appends the wallet's DecoratedSignature to an unsigned
 * v1 TransactionEnvelope and returns the signed envelope.
 *
 * The signature is over the standard Stellar signature payload:
 *   sha256(networkId || uint32(ENVELOPE_TYPE_TX) || transaction XDR)
 * — the same pre-image the classic payment path signs, so a transaction is
 * bound to the network whose passphrase is passed in.
 *
 * @param envelopeB64 - base64 XDR of the unsigned v1 envelope.
 * @param seed - the 32-byte Ed25519 seed of the signing Stellar account.
 * @param networkPassphrase - the network the transaction will be submitted to.
 * @returns base64 XDR of the signed envelope.
 */
export function signSorobanTransactionEnvelope(
  envelopeB64: string,
  seed: Uint8Array,
  networkPassphrase: string,
): string {
  if (seed.length !== 32) {
    throw new Error(`Stellar private key must be 32 bytes, got ${seed.length}.`);
  }
  const envelope = base64ToBytes(envelopeB64);
  if (envelope.length < 8) {
    throw new Error('Transaction envelope is too short.');
  }
  const type = readUint32(envelope, 0);
  if (type !== ENVELOPE_TYPE_TX) {
    throw new Error(`Expected a v1 transaction envelope (type 2), got type ${type}.`);
  }
  const { tx, signatureCount } = splitEnvelopeBody(envelope.subarray(4));

  const networkId = sha256(new TextEncoder().encode(networkPassphrase));
  const signatureBase = concat([networkId, xdrUint32(ENVELOPE_TYPE_TX), tx]);
  const txHash = sha256(signatureBase);

  const signature = ed25519.sign(txHash, seed);
  const publicKey = ed25519.getPublicKey(seed);
  const hint = publicKey.subarray(28, 32);

  // DecoratedSignature = hint (opaque[4]) || signature (opaque<64>).
  const decorated = concat([hint, xdrUint32(signature.length), signature]);
  const newCount = xdrUint32(signatureCount + 1);
  const priorSignatures = envelope.subarray(
    4 + tx.length + 4,
    4 + tx.length + 4 + DECORATED_SIGNATURE_BYTES * signatureCount,
  );

  const signedEnvelope = concat([
    xdrUint32(ENVELOPE_TYPE_TX),
    tx,
    newCount,
    priorSignatures,
    decorated,
  ]);
  return bytesToBase64(signedEnvelope);
}

/**
 * `signMessage` — the SEP-53-style wallet signature the SDK derives the
 * pool's privacy keys from.
 *
 * A Stellar wallet signing an arbitrary message prefixes it with
 * `Stellar Signed Message:\n`, hashes the whole payload with SHA-256, and
 * Ed25519-signs the digest — the same construction SEP-53 specifies. The SDK
 * verifies the signature against the account's own key before trusting it
 * (the signature IS the note secret), so a different construction yields
 * "the key-derivation signature was not made by the note owner's key".
 *
 * @returns the base64 64-byte Ed25519 signature.
 */
const SEP53_MESSAGE_PREFIX = 'Stellar Signed Message:\n';

export function signSppMessage(message: string, seed: Uint8Array): string {
  if (seed.length !== 32) {
    throw new Error(`Stellar private key must be 32 bytes, got ${seed.length}.`);
  }
  const payload = new TextEncoder().encode(SEP53_MESSAGE_PREFIX + message);
  const signature = ed25519.sign(sha256(payload), seed);
  return bytesToBase64(signature);
}

/** The G... strkey address for a 32-byte Ed25519 seed. */
export function seedStellarAddress(seed: Uint8Array): string {
  return encodeStellarAddress(ed25519.getPublicKey(seed));
}

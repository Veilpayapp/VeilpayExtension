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
 * EnvelopeType tag for the Soroban authorization arm of a `HashIdPreimage`
 * (ENVELOPE_TYPE_SOROBAN_AUTHORIZATION = 5).
 */
const ENVELOPE_TYPE_SOROBAN_AUTHORIZATION = 5;

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
 * bytes in the *transaction* body that coincidentally encode a matching
 * count at exactly the right offset.
 *
 * HONESTY OF THE SAFETY ARGUMENT: that coincidence is not 2⁻³² for the
 * zero-signature case — the candidate position then lies inside attacker-
 * influenceable transaction bytes, not signature bytes, so a crafted
 * envelope CAN steer the split. Safety therefore does NOT rest on this
 * heuristic alone; it rests on the layers around it: (1) only the trusted,
 * vendored SPP SDK ever supplies envelopes (the internal control plane's
 * sender checks keep every other context out), (2) the source-account pin in
 * `signSorobanTransactionEnvelope` refuses envelopes not paid for by this
 * wallet, and (3) a mis-split produces a mangled envelope the network
 * rejects (fail-closed, no valid transaction signed for an attacker-chosen
 * body that the wallet did not already control).
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
 * SECURITY GATE (see `assertAuthPreimageBoundToNetwork`): unlike a
 * transaction, a preimage's network binding is INSIDE the signed payload,
 * so the caller must pin it explicitly — the background does, before
 * calling this.
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

/** Upper bound on an acceptable auth-entry preimage (XDR of one invocation). */
const MAX_AUTH_PREIMAGE_BYTES = 8192;

/**
 * SECURITY GATE for the SPP signer bridge's auth-entry arm: the preimage a
 * wallet signs must be a `HashIdPreimage::SorobanAuthorization` bound to the
 * pool's network.
 *
 * A preimage embeds its `networkId` (sha256 of the passphrase) INSIDE the
 * signed bytes — unlike `signSorobanTransactionEnvelope`, where the passphrase
 * is a separate argument. Without this gate, a handover of arbitrary base64
 * would make the wallet's key a signing oracle for Soroban authorizations on
 * ANY network (a mainnet-networkId preimage would authorize attacker-chosen
 * contract invocations as this wallet on mainnet, while every other arm of
 * the signer bridge is pinned to the pool's testnet).
 *
 * Layout checked: uint32 discriminant = 5 (ENVELOPE_TYPE_SOROBAN_AUTHORIZATION)
 * followed by the 32-byte networkId hash. The invocation body that follows is
 * not parsed — the discriminant plus the network pin already confine the
 * oracle to pool-legitimate, pool-network preimages, and a malformed body
 * simply yields a signature the network rejects.
 *
 * @throws a display-safe error when the preimage is not a Soroban
 *   authorization preimage for `networkPassphrase`'s network.
 */
export function assertAuthPreimageBoundToNetwork(
  preimageB64: string,
  networkPassphrase: string,
): void {
  const preimage = base64ToBytes(preimageB64);
  if (preimage.length < 36 || preimage.length > MAX_AUTH_PREIMAGE_BYTES) {
    throw new Error('The authorization preimage has an invalid length.');
  }
  const type = readUint32(preimage, 0);
  if (type !== ENVELOPE_TYPE_SOROBAN_AUTHORIZATION) {
    throw new Error(
      `Expected a Soroban authorization preimage (type 5), got type ${type}.`,
    );
  }
  const expectedNetworkId = sha256(new TextEncoder().encode(networkPassphrase));
  if (!bytesEqual(preimage.subarray(4, 36), expectedNetworkId)) {
    throw new Error('The authorization entry targets a different network than the pool.');
  }
}

/**
 * Parses the ed25519 public key of a v1 envelope's `sourceAccount`.
 *
 * Layout after the 4-byte envelope type tag: `MuxedAccount` — a uint32
 * discriminant (0 = `KEY_ED25519`, 32-byte key; 1 = `MUXED_ED25519`, 8-byte
 * id then the 32-byte key). Anything else is rejected.
 */
export function envelopeSourceAccountKey(envelopeB64: string): Uint8Array {
  const envelope = base64ToBytes(envelopeB64);
  if (envelope.length < 8) {
    throw new Error('Transaction envelope is too short.');
  }
  const type = readUint32(envelope, 0);
  if (type !== ENVELOPE_TYPE_TX) {
    throw new Error(`Expected a v1 transaction envelope (type 2), got type ${type}.`);
  }
  const accountType = readUint32(envelope, 4);
  if (accountType === 0) {
    if (envelope.length < 40) {
      throw new Error('Transaction envelope is too short for an ed25519 source account.');
    }
    return envelope.subarray(8, 40);
  }
  if (accountType === 1) {
    if (envelope.length < 48) {
      throw new Error('Transaction envelope is too short for a muxed source account.');
    }
    return envelope.subarray(16, 48);
  }
  throw new Error(`Unsupported transaction source account type ${accountType}.`);
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

/**
 * SECURITY GATE for the SPP signer bridge: the envelope a wallet signs on
 * the SDK's behalf must be PAID FOR by that wallet's own account.
 *
 * The only legitimate caller of `signSorobanTransactionEnvelope` through the
 * control plane is the vendored SPP SDK (which always sources its envelopes
 * from the bound wallet), but a compromised or buggy SDK could otherwise
 * hand over an arbitrary transaction — e.g. a classic PAYMENT out of the
 * wallet — and have it signed as if it were a pool operation. The background
 * calls this before signing; cosigning foreign transactions (legitimate
 * Stellar behavior) stays available to callers that hold the key directly.
 *
 * @throws a display-safe error when the envelope's source account does not
 *   match the `seed`'s public key.
 */
export function assertEnvelopeSourcedFrom(envelopeB64: string, seed: Uint8Array): void {
  if (seed.length !== 32) {
    throw new Error(`Stellar private key must be 32 bytes, got ${seed.length}.`);
  }
  if (!bytesEqual(envelopeSourceAccountKey(envelopeB64), ed25519.getPublicKey(seed))) {
    throw new Error('The pool transaction is not sourced from this wallet\u2019s account.');
  }
}

/**
 * `signTransaction` — appends the wallet's DecoratedSignature to a v1
 * TransactionEnvelope and returns the signed envelope.
 *
 * The signature is over the standard Stellar signature payload:
 *   sha256(networkId || uint32(ENVELOPE_TYPE_TX) || transaction XDR)
 * — the same pre-image the classic payment path signs, so a transaction is
 * bound to the network whose passphrase is passed in. This is a general
 * Stellar signer (cosigning is fine); the wallet-trust policy — "only
 * envelopes sourced from this account" — is `assertEnvelopeSourcedFrom`,
 * applied by the background at the control-plane boundary.
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

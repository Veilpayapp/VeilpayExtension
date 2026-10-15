/**
 * Stellar Soroban wallet-signing primitives for SPP (Stellar Private Payments).
 *
 * Implements the three SEP-0043-style callbacks the SPP web SDK requires:
 *   - signMessage(message)        → ed25519 signature over the raw UTF-8 bytes
 *   - signTransaction(txXdrB64)   → append a DecoratedSignature to a v1 envelope
 *   - signAuthEntry(preimageB64)  → ed25519 signature over sha256(preimage XDR)
 *
 * The private key is a 32-byte ed25519 SEED (the vault's model): ed25519.sign
 * hashes internally, exactly like the wallet's classic Stellar path.
 */

import { base32 } from '@scure/base';
import { ed25519 } from '@noble/curves/ed25519';
import { sha256 } from '@noble/hashes/sha256';

/** EnvelopeType tag for a v1 Transaction envelope (ENVELOPE_TYPE_TX = 2). */
const ENVELOPE_TYPE_TX = 2;

// ---------------------------------------------------------------------------
// Base64 / hex helpers (browser-safe, no Buffer)
// ---------------------------------------------------------------------------

export function bytesToBase64(bytes) {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 1) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

export function base64ToBytes(text) {
  const binary = atob(text);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    out[i] = binary.charCodeAt(i);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Stellar strkey (G...) helpers
// ---------------------------------------------------------------------------

function crc16Xmodem(bytes) {
  let crc = 0x0000;
  for (const byte of bytes) {
    crc ^= byte << 8;
    for (let i = 0; i < 8; i += 1) {
      crc = (crc & 0x8000) !== 0 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
    }
  }
  return crc & 0xffff;
}

/** Encodes a raw 32-byte ed25519 public key as a Stellar strkey (G...). */
export function encodeStellarAddress(publicKey) {
  const payload = new Uint8Array(1 + publicKey.length);
  payload[0] = 6 << 3; // version byte for an ed25519 account id
  payload.set(publicKey, 1);
  const checksum = crc16Xmodem(payload);
  const framed = new Uint8Array(payload.length + 2);
  framed.set(payload);
  framed[payload.length] = checksum & 0xff;
  framed[payload.length + 1] = (checksum >> 8) & 0xff;
  return base32.encode(framed);
}

/** Decodes a Stellar strkey (G...) back to its raw 32-byte public key. */
export function decodeStellarAddress(address) {
  const normalized = address.toUpperCase();
  const decoded = base32.decode(normalized);
  if (decoded.length !== 35) {
    throw new Error(`Invalid Stellar address length: ${decoded.length} bytes.`);
  }
  if (decoded[0] !== 6 << 3) {
    throw new Error(`Unexpected Stellar address version byte: ${decoded[0]}.`);
  }
  return decoded.subarray(1, 33);
}

// ---------------------------------------------------------------------------
// XDR primitives
// ---------------------------------------------------------------------------

function xdrUint32(value) {
  return new Uint8Array([
    (value >>> 24) & 0xff,
    (value >>> 16) & 0xff,
    (value >>> 8) & 0xff,
    value & 0xff,
  ]);
}

function readUint32(bytes, offset) {
  return (
    ((bytes[offset] << 24) >>> 0) +
    (bytes[offset + 1] << 16) +
    (bytes[offset + 2] << 8) +
    bytes[offset + 3]
  );
}

function concat(arrays) {
  const total = arrays.reduce((n, a) => n + a.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const a of arrays) {
    out.set(a, offset);
    offset += a.length;
  }
  return out;
}

/** sha256(networkPassphrase) — the Stellar network id. */
export function stellarNetworkId(networkPassphrase) {
  return sha256(new TextEncoder().encode(networkPassphrase));
}

/**
 * Signature pre-image for a v1 transaction:
 *   networkId || uint32(ENVELOPE_TYPE_TX) || transaction XDR
 * (TransactionSignaturePayload with a tagged transaction.)
 */
function transactionSignatureBase(networkId, txXdr) {
  return concat([networkId, xdrUint32(ENVELOPE_TYPE_TX), txXdr]);
}

// ---------------------------------------------------------------------------
// DecoratedSignature vector parsing
// ---------------------------------------------------------------------------

/**
 * Byte length of one DecoratedSignature:
 *   hint (opaque[4], fixed) + signature (opaque<64>, 4-byte length + 64 bytes).
 */
const DECORATED_SIGNATURE_BYTES = 72;

/**
 * Splits a v1 envelope body (after the 4-byte type tag) into
 * { tx, signatureCount } by locating the trailing signature vector.
 *
 * The vector is `uint32 count || count * 72 bytes`. The count field sits at
 * `body.length - 4 - 72 * count` for the true count; candidate counts are
 * scanned from the end and validated against their own position, which is
 * unambiguous for well-formed envelopes (a false positive requires signature
 * bytes that coincidentally encode a matching count).
 */
function splitEnvelopeBody(body) {
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
    throw new Error('Could not locate the signature vector in the envelope.');
  }
  const txEnd = body.length - 4 - DECORATED_SIGNATURE_BYTES * best;
  if (txEnd <= 0) {
    throw new Error('Envelope has no transaction body.');
  }
  return { tx: body.subarray(0, txEnd), signatureCount: best };
}

// ---------------------------------------------------------------------------
// SPP wallet-signing operations
// ---------------------------------------------------------------------------

/**
 * `signAuthEntry` — the SDK hands over the base64 XDR of the
 * HashIdPreimage::SorobanAuthorization and expects the base64 64-byte
 * ed25519 signature over sha256(preimage bytes).
 */
export function signSorobanAuthPreimage(preimageB64, seed) {
  const preimage = base64ToBytes(preimageB64);
  const digest = sha256(preimage);
  const signature = ed25519.sign(digest, seed);
  return bytesToBase64(signature);
}

/**
 * `signTransaction` — the SDK hands over the base64 XDR of the unsigned v1
 * envelope (auth signatures already embedded in the operations) and expects
 * the same envelope back with the wallet's DecoratedSignature appended.
 */
export function signSorobanTransactionEnvelope(envelopeB64, seed, networkPassphrase) {
  const envelope = base64ToBytes(envelopeB64);
  if (envelope.length < 8) {
    throw new Error('Transaction envelope is too short.');
  }
  const type = readUint32(envelope, 0);
  if (type !== ENVELOPE_TYPE_TX) {
    throw new Error(`Expected a v1 transaction envelope (type 2), got type ${type}.`);
  }
  const { tx, signatureCount } = splitEnvelopeBody(envelope.subarray(4));

  const networkId = stellarNetworkId(networkPassphrase);
  const txHash = sha256(transactionSignatureBase(networkId, tx));

  const signature = ed25519.sign(txHash, seed);
  const publicKey = ed25519.getPublicKey(seed);
  const hint = publicKey.subarray(28, 32);

  const decorated = concat([hint, xdrUint32(signature.length), signature]);
  const newCount = xdrUint32(signatureCount + 1);
  const trailing = envelope.subarray(
    4 + tx.length + 4,
    4 + tx.length + 4 + DECORATED_SIGNATURE_BYTES * signatureCount,
  );

  return bytesToBase64(concat([xdrUint32(ENVELOPE_TYPE_TX), tx, newCount, trailing, decorated]));
}

/**
 * `signMessage` — the SDK derives its privacy keys from the wallet's
 * Ed25519 signature over a SEP-53-style payload:
 * sha256("Stellar Signed Message:\n" + message). Returns base64 (64 bytes).
 */
export function signSppMessage(message, seed) {
  const payload = new TextEncoder().encode(`Stellar Signed Message:\n${message}`);
  const signature = ed25519.sign(sha256(payload), seed);
  return bytesToBase64(signature);
}

/** Public key + G... address for a seed. */
export function stellarKeyInfo(seed) {
  const publicKey = ed25519.getPublicKey(seed);
  return { publicKey, address: encodeStellarAddress(publicKey) };
}

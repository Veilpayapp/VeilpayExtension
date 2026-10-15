import { describe, expect, it } from 'vitest';
import { ed25519 } from '@noble/curves/ed25519';
import { sha256 } from '@noble/hashes/sha256';
import { encodeStellarAddress, signStellarPayment } from '@/core/chains/stellar/transaction';
import {
  base64ToBytes,
  bytesToBase64,
  seedStellarAddress,
  signSorobanAuthPreimage,
  signSppMessage,
  signSorobanTransactionEnvelope,
} from '@/core/chains/stellar/soroban-sign';

/**
 * One DecoratedSignature on the wire: hint (opaque[4]) + signature
 * (opaque<64> = uint32 length + 64 bytes).
 */
const DECORATED_SIG_BYTES = 72;

const TESTNET_PASSPHRASE = 'Test SDF Network ; September 2015';
const PRIVATE_KEY = new Uint8Array(32).fill(0x01);
const PUBLIC_KEY = ed25519.getPublicKey(PRIVATE_KEY);
const FROM_ADDRESS = encodeStellarAddress(PUBLIC_KEY);
const DEST_ADDRESS = encodeStellarAddress(new Uint8Array(32).fill(0x0b));

/** Builds the classic payment fixture the envelope tests operate on. */
function signedClassicEnvelope(): string {
  return signStellarPayment(
    {
      from: FROM_ADDRESS,
      to: DEST_ADDRESS,
      amount: 100_000_000n,
      sequence: 120n,
      fee: 100,
    },
    PRIVATE_KEY,
  ).raw;
}

/**
 * Strips the DecoratedSignature vector from a signed envelope, producing the
 * unsigned form the SPP SDK hands a wallet: [uint32 2][tx][uint32 0].
 */
function stripSignatures(envelopeB64: string): string {
  const envelope = base64ToBytes(envelopeB64);
  const txEnd = envelope.length - 4 - DECORATED_SIG_BYTES; // exactly one sig
  const tx = envelope.slice(4, txEnd);
  const unsigned = new Uint8Array(4 + tx.length + 4);
  unsigned.set(envelope.slice(0, 4));
  unsigned.set(tx, 4);
  // trailing uint32 0 = empty signature vector
  return bytesToBase64(unsigned);
}

/** Decodes an envelope into { type, tx, signatureCount, signatureBytes }. */
function parseEnvelope(envelopeB64: string): {
  type: number;
  tx: Uint8Array;
  signatureCount: number;
} {
  const envelope = base64ToBytes(envelopeB64);
  const type =
    ((envelope[0]! << 24) >>> 0) + (envelope[1]! << 16) + (envelope[2]! << 8) + envelope[3]!;
  const tail = envelope.length - 4;
  let signatureCount = -1;
  for (let count = 0; count <= Math.floor((tail - 4) / DECORATED_SIG_BYTES); count += 1) {
    const position = envelope.length - 4 - DECORATED_SIG_BYTES * count;
    const value =
      ((envelope[position]! << 24) >>> 0) +
      (envelope[position + 1]! << 16) +
      (envelope[position + 2]! << 8) +
      envelope[position + 3]!;
    if (value === count) signatureCount = count;
  }
  if (signatureCount < 0) throw new Error('test: no valid signature vector boundary');
  const txEnd = envelope.length - 4 - DECORATED_SIG_BYTES * signatureCount;
  return { type, tx: envelope.slice(4, txEnd), signatureCount };
}

describe('Soroban transaction signing (SPP)', () => {
  it('signs an unsigned envelope exactly like the classic builder', () => {
    // The strongest equivalence available: the SPP path must produce the
    // byte-identical envelope the classic (testnet-proven) payment builder
    // produces for the same transaction and key.
    const reference = signedClassicEnvelope();
    const unsigned = stripSignatures(reference);
    const signed = signSorobanTransactionEnvelope(unsigned, PRIVATE_KEY, TESTNET_PASSPHRASE);
    expect(signed).toBe(reference);
  });

  it('appends a signature without disturbing an existing one', () => {
    const reference = signedClassicEnvelope();
    // Treat the SIGNED envelope as an envelope that already carries one
    // signature (a cosigner's), then add ours: the transaction body must be
    // untouched and the count must grow to 2.
    const twice = signSorobanTransactionEnvelope(reference, PRIVATE_KEY, TESTNET_PASSPHRASE);

    const first = parseEnvelope(reference);
    const second = parseEnvelope(twice);
    expect(second.signatureCount).toBe(first.signatureCount + 1);
    expect(second.tx).toEqual(first.tx);
  });

  it('signs over the network-bound pre-image (sha256 of networkId || tag || tx)', () => {
    const reference = signedClassicEnvelope();
    const unsigned = stripSignatures(reference);
    const signed = base64ToBytes(signSorobanTransactionEnvelope(unsigned, PRIVATE_KEY, TESTNET_PASSPHRASE));

    const parsed = parseEnvelope(bytesToBase64(signed));
    const networkId = sha256(new TextEncoder().encode(TESTNET_PASSPHRASE));
    const tag = new Uint8Array([0, 0, 0, 2]);
    const payload = new Uint8Array(networkId.length + tag.length + parsed.tx.length);
    payload.set(networkId);
    payload.set(tag, networkId.length);
    payload.set(parsed.tx, networkId.length + tag.length);
    const expectedHash = sha256(payload);

    // The appended signature sits at the very end of the envelope.
    const signature = signed.slice(signed.length - 64);
    expect(ed25519.verify(signature, expectedHash, PUBLIC_KEY)).toBe(true);
  });

  it('rejects a different network passphrase (signature binds to the network)', () => {
    const unsigned = stripSignatures(signedClassicEnvelope());
    const mainnet = signSorobanTransactionEnvelope(
      unsigned,
      PRIVATE_KEY,
      'Public Global Stellar Network ; September 2015',
    );
    const testnet = signSorobanTransactionEnvelope(unsigned, PRIVATE_KEY, TESTNET_PASSPHRASE);
    expect(mainnet).not.toBe(testnet);
  });

  it('rejects a non-v1 envelope', () => {
    const bad = bytesToBase64(new Uint8Array([0, 0, 0, 3, ...new Uint8Array(64)]));
    expect(() => signSorobanTransactionEnvelope(bad, PRIVATE_KEY, TESTNET_PASSPHRASE)).toThrow(
      /v1 transaction envelope/,
    );
  });

  it('rejects malformed or truncated envelopes', () => {
    expect(() =>
      signSorobanTransactionEnvelope(bytesToBase64(new Uint8Array(4)), PRIVATE_KEY, TESTNET_PASSPHRASE),
    ).toThrow(/too short/);
    // A body of random bytes has no valid signature-vector boundary.
    const noise = new Uint8Array(60).fill(0x5a);
    expect(() =>
      signSorobanTransactionEnvelope(
        bytesToBase64(new Uint8Array([0, 0, 0, 2, ...noise])),
        PRIVATE_KEY,
        TESTNET_PASSPHRASE,
      ),
    ).toThrow();
  });

  it('requires a 32-byte seed', () => {
    const unsigned = stripSignatures(signedClassicEnvelope());
    expect(() =>
      signSorobanTransactionEnvelope(unsigned, new Uint8Array(31), TESTNET_PASSPHRASE),
    ).toThrow(/32 bytes/);
  });
});

describe('Soroban auth preimage signing (SPP)', () => {
  it('signs sha256(preimage) with Ed25519 and returns base64', () => {
    // The preimage is arbitrary XDR bytes as far as the signer is concerned —
    // it signs the SHA-256 of exactly what it was handed.
    const preimage = new Uint8Array(33).fill(0x42);
    const expected = ed25519.sign(sha256(preimage), PRIVATE_KEY);
    const result = signSorobanAuthPreimage(bytesToBase64(preimage), PRIVATE_KEY);
    expect(result).toBe(bytesToBase64(expected));
    expect(base64ToBytes(result)).toHaveLength(64);
  });

  it('rejects an empty preimage and a wrong-size seed', () => {
    expect(() => signSorobanAuthPreimage(bytesToBase64(new Uint8Array(0)), PRIVATE_KEY)).toThrow(
      /empty/,
    );
    expect(() =>
      signSorobanAuthPreimage(bytesToBase64(new Uint8Array(8)), new Uint8Array(16)),
    ).toThrow(/32 bytes/);
  });
});

describe('SPP key-derivation message signing', () => {
  it('signs the SEP-53 payload (prefix + message, SHA-256, Ed25519)', () => {
    // SEP-53: the wallet signs sha256("Stellar Signed Message:\n" || message).
    // The SDK verifies this against the account's key before deriving the
    // note secret, so the construction must match exactly.
    const message = 'Privacy Pool Key Derivation [v2] (Veilpay)';
    const payload = new TextEncoder().encode(`Stellar Signed Message:\n${message}`);
    const expected = ed25519.sign(sha256(payload), PRIVATE_KEY);
    expect(signSppMessage(message, PRIVATE_KEY)).toBe(bytesToBase64(expected));
    expect(base64ToBytes(signSppMessage(message, PRIVATE_KEY))).toHaveLength(64);
  });

  it('verifies against the account public key (owner check)', () => {
    const message = 'Privacy Pool Key Derivation [v2] (Veilpay)';
    const signature = base64ToBytes(signSppMessage(message, PRIVATE_KEY));
    const payload = new TextEncoder().encode(`Stellar Signed Message:\n${message}`);
    expect(ed25519.verify(signature, sha256(payload), PUBLIC_KEY)).toBe(true);
  });

  it('requires a 32-byte seed', () => {
    expect(() => signSppMessage('m', new Uint8Array(8))).toThrow(/32 bytes/);
  });
});

describe('seed → address helper', () => {
  it('derives the G… address for a seed', () => {
    expect(seedStellarAddress(PRIVATE_KEY)).toBe(FROM_ADDRESS);
  });
});

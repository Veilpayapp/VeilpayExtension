import { describe, expect, it } from 'vitest';
import { ed25519 } from '@noble/curves/ed25519';
import { sha256 } from '@noble/hashes/sha256';
import { encodeStellarAddress, signStellarPayment } from '@/core/chains/stellar/transaction';
import {
  assertAuthPreimageBoundToNetwork,
  assertEnvelopeSourcedFrom,
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

// ---------------------------------------------------------------------------
// Edge-case coverage appended for the SPP integration review.
// ---------------------------------------------------------------------------

/** A second key that cosigns envelopes in the multi-signature tests. */
const COSIGNER_KEY = new Uint8Array(32).fill(0x02);

/** Every wrong-size seed the entry points must reject. */
const BAD_SEEDS: ReadonlyArray<{ label: string; seed: Uint8Array }> = [
  { label: 'empty', seed: new Uint8Array(0) },
  { label: '31-byte (one short)', seed: new Uint8Array(31) },
  { label: '33-byte (one long)', seed: new Uint8Array(33) },
];

describe('base64 helpers', () => {
  it('round-trips every length 0…16', () => {
    for (let length = 0; length <= 16; length += 1) {
      const bytes = new Uint8Array(length);
      for (let index = 0; index < length; index += 1) {
        bytes[index] = (index * 37 + 11) & 0xff;
      }
      const encoded = bytesToBase64(bytes);
      expect(encoded).toMatch(/^[A-Za-z0-9+/]*={0,2}$/);
      expect(base64ToBytes(encoded)).toEqual(bytes);
    }
  });

  it('maps empty input to empty output in both directions', () => {
    expect(bytesToBase64(new Uint8Array(0))).toBe('');
    expect(base64ToBytes('')).toEqual(new Uint8Array(0));
  });

  it('rejects invalid base64 by throwing', () => {
    // atob is the decoder; anything it refuses must surface as a throw, not
    // as silently-wrong bytes.
    expect(() => base64ToBytes('a!b')).toThrow();
    expect(() => base64ToBytes('not base64')).toThrow();
    expect(() => base64ToBytes('====')).toThrow();
  });
});

describe('seed length validation (every signing entry point)', () => {
  it.each(BAD_SEEDS)('signSorobanTransactionEnvelope rejects a $label seed', ({ seed }) => {
    expect(() =>
      signSorobanTransactionEnvelope(
        stripSignatures(signedClassicEnvelope()),
        seed,
        TESTNET_PASSPHRASE,
      ),
    ).toThrow(/32 bytes/);
  });

  it.each(BAD_SEEDS)('signSorobanAuthPreimage rejects a $label seed', ({ seed }) => {
    expect(() =>
      signSorobanAuthPreimage(bytesToBase64(new Uint8Array(16).fill(0x42)), seed),
    ).toThrow(/32 bytes/);
  });

  it.each(BAD_SEEDS)('signSppMessage rejects a $label seed', ({ seed }) => {
    expect(() => signSppMessage('message', seed)).toThrow(/32 bytes/);
  });
});

describe('SEP-53 message prefix bytes', () => {
  const PREFIX = 'Stellar Signed Message:\n';

  it('the payload is exactly prefix || message: 24 prefix bytes, no NUL, no length framing', () => {
    const prefixBytes = new TextEncoder().encode(PREFIX);
    expect(prefixBytes).toHaveLength(24);
    expect(prefixBytes[23]).toBe(0x0a); // the "\n"
    // No NUL terminator and no uint32 length: the payload is raw
    // concatenation, exactly as SEP-53 specifies.
    expect(prefixBytes.includes(0)).toBe(false);

    const message = 'Privacy Pool Key Derivation [v2] (Veilpay)';
    const messageBytes = new TextEncoder().encode(message);
    const payload = new Uint8Array(prefixBytes.length + messageBytes.length);
    payload.set(prefixBytes);
    payload.set(messageBytes, prefixBytes.length);

    expect(signSppMessage(message, PRIVATE_KEY)).toBe(
      bytesToBase64(ed25519.sign(sha256(payload), PRIVATE_KEY)),
    );
  });

  it('signs the bare prefix when the message is empty (boundary case)', () => {
    const payload = new TextEncoder().encode(PREFIX);
    expect(signSppMessage('', PRIVATE_KEY)).toBe(
      bytesToBase64(ed25519.sign(sha256(payload), PRIVATE_KEY)),
    );
  });
});

describe('signature-vector boundary scan (splitEnvelopeBody)', () => {
  it('finds and preserves TWO pre-existing cosigner signatures verbatim', () => {
    // Chain a third signature onto an envelope that already carries two:
    // the scan must locate count=2 (not stop at a smaller valid count), keep
    // the transaction bytes untouched, and reproduce the prior signatures
    // byte-for-byte.
    const one = signedClassicEnvelope(); // 1 signature (ours)
    const two = signSorobanTransactionEnvelope(one, COSIGNER_KEY, TESTNET_PASSPHRASE); // 2
    const three = signSorobanTransactionEnvelope(two, PRIVATE_KEY, TESTNET_PASSPHRASE); // 3

    const parsedTwo = parseEnvelope(two);
    const parsedThree = parseEnvelope(three);
    expect(parsedTwo.signatureCount).toBe(2);
    expect(parsedThree.signatureCount).toBe(3);
    expect(parsedThree.tx).toEqual(parsedTwo.tx);

    // The prior signature region survives verbatim: appending a signature
    // may never disturb or reorder the ones already present.
    const twoBytes = base64ToBytes(two);
    const threeBytes = base64ToBytes(three);
    const sigsTwo = twoBytes.subarray(4 + parsedTwo.tx.length + 4);
    const sigsThree = threeBytes.subarray(4 + parsedThree.tx.length + 4);
    expect(sigsThree.subarray(0, sigsTwo.length)).toEqual(sigsTwo);
  });

  it('characterizes a count false-positive: crafted tx bytes mis-split a zero-signature envelope', () => {
    // A zero-signature envelope is [tag 2][tx][count 0]. The boundary scan
    // keeps the LARGEST count whose candidate position reads back as that
    // count, so tx bytes that encode 1 at exactly len−4−72 hijack the split:
    // the last 72 tx bytes get treated as a pre-existing signature. Pin that
    // behavior deliberately. In the real flow this is unreachable — unsigned
    // envelopes come from the vendored SDK — and the corruption is not a
    // funds risk: the wallet signs the truncated tx it split out, so the
    // network rejects the envelope's signature against its content.
    const tx = new Uint8Array(80);
    tx.set([0, 0, 0, 1], 8); // lands on the count=1 candidate position
    const envelope = new Uint8Array([0, 0, 0, 2, ...tx, 0, 0, 0, 0]);
    const signed = signSorobanTransactionEnvelope(
      bytesToBase64(envelope),
      PRIVATE_KEY,
      TESTNET_PASSPHRASE,
    );

    const parsed = parseEnvelope(signed);
    expect(parsed.signatureCount).toBe(2); // count 0 → "1 pre-existing" + ours
    expect(parsed.tx).toHaveLength(8); // the truncated tx the wallet signed

    // Internally consistent: the appended signature verifies over the tx the
    // wallet actually split out.
    const networkId = sha256(new TextEncoder().encode(TESTNET_PASSPHRASE));
    const preimage = new Uint8Array(networkId.length + 4 + parsed.tx.length);
    preimage.set(networkId);
    preimage.set([0, 0, 0, 2], networkId.length);
    preimage.set(parsed.tx, networkId.length + 4);
    const signature = base64ToBytes(signed).slice(-64);
    expect(ed25519.verify(signature, sha256(preimage), PUBLIC_KEY)).toBe(true);
  });
});

describe('decorated signature framing', () => {
  it('appends a signature carrying the account hint and a 64-byte length field', () => {
    const unsigned = stripSignatures(signedClassicEnvelope());
    const signed = base64ToBytes(
      signSorobanTransactionEnvelope(unsigned, PRIVATE_KEY, TESTNET_PASSPHRASE),
    );

    // Trailing DecoratedSignature: hint(4) || uint32 64 || signature(64).
    // The hint is the LAST 4 bytes of the signing account's public key — what
    // lets the network attribute the signature without a full key.
    const tail = signed.subarray(signed.length - 72);
    expect(Array.from(tail.subarray(0, 4))).toEqual(Array.from(PUBLIC_KEY.subarray(28, 32)));
    const length =
      ((tail[4]! << 24) >>> 0) + (tail[5]! << 16) + (tail[6]! << 8) + tail[7]!;
    expect(length).toBe(64);
  });
});

// ---------------------------------------------------------------------------
// strkey framing, verified with an encoder written out in full here so a bug
// in the source's base32/CRC16 helpers cannot self-confirm.
// ---------------------------------------------------------------------------

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function handRolledBase32(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32_ALPHABET[(value >>> (bits - 5)) & 31]!;
      bits -= 5;
    }
  }
  if (bits > 0) {
    out += BASE32_ALPHABET[(value << (5 - bits)) & 31]!;
  }
  return out;
}

function handRolledBase32Decode(text: string): Uint8Array {
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const char of text) {
    const index = BASE32_ALPHABET.indexOf(char);
    if (index < 0) throw new Error(`bad base32 char: ${char}`);
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return new Uint8Array(out);
}

function handRolledCrc16Xmodem(bytes: Uint8Array): number {
  let crc = 0;
  for (const byte of bytes) {
    crc ^= byte << 8;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc & 0x8000) !== 0 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
    }
  }
  return crc & 0xffff;
}

/** Encodes a 32-byte ed25519 public key as a G… strkey, test-side. */
function handRolledStrkey(publicKey: Uint8Array): string {
  const payload = new Uint8Array(33);
  payload[0] = 6 << 3; // ed25519 account-id version byte → the G prefix
  payload.set(publicKey, 1);
  const crc = handRolledCrc16Xmodem(payload);
  const framed = new Uint8Array(35);
  framed.set(payload);
  framed[33] = crc & 0xff; // little-endian
  framed[34] = (crc >> 8) & 0xff;
  return handRolledBase32(framed);
}

describe('seedStellarAddress (strkey framing, independent encoder)', () => {
  it('matches a hand-rolled base32 + CRC16-XModem encoding of the public key', () => {
    const seed = new Uint8Array(32).fill(0x07);
    expect(seedStellarAddress(seed)).toBe(handRolledStrkey(ed25519.getPublicKey(seed)));
  });

  it('is deterministic and seed-sensitive', () => {
    expect(seedStellarAddress(PRIVATE_KEY)).toBe(seedStellarAddress(PRIVATE_KEY));
    expect(seedStellarAddress(new Uint8Array(32).fill(0x02))).not.toBe(
      seedStellarAddress(new Uint8Array(32).fill(0x03)),
    );
  });

  it('emits 56-char G… strkeys whose checksum verifies', () => {
    for (const seed of [new Uint8Array(32).fill(1), new Uint8Array(32).fill(0xab)]) {
      const address = seedStellarAddress(seed);
      expect(address).toMatch(/^G[A-Z2-7]{55}$/);

      const decoded = handRolledBase32Decode(address);
      expect(decoded).toHaveLength(35);
      expect(decoded[0]).toBe(6 << 3);
      const crc = handRolledCrc16Xmodem(decoded.subarray(0, 33));
      expect(decoded[33]).toBe(crc & 0xff);
      expect(decoded[34]).toBe((crc >> 8) & 0xff);
    }
  });
});

describe('assertEnvelopeSourcedFrom (the signer trust gate)', () => {
  it('accepts an unsigned envelope sourced from the seed account', () => {
    const unsigned = stripSignatures(signedClassicEnvelope());
    expect(() => assertEnvelopeSourcedFrom(unsigned, PRIVATE_KEY)).not.toThrow();
  });

  it('accepts a signed envelope sourced from the seed account', () => {
    const signed = signedClassicEnvelope();
    expect(() => assertEnvelopeSourcedFrom(signed, PRIVATE_KEY)).not.toThrow();
  });

  it('rejects an envelope sourced from a different account', () => {
    // Same structure, but the source-account key bytes are not ours.
    const envelope = base64ToBytes(stripSignatures(signedClassicEnvelope()));
    envelope[8] = envelope[8]! ^ 0xff;
    envelope[9] = envelope[9]! ^ 0xff;
    const foreign = bytesToBase64(envelope);
    expect(() => assertEnvelopeSourcedFrom(foreign, PRIVATE_KEY)).toThrow(
      /not sourced from this wallet/,
    );
  });

  it('rejects an envelope whose source-account type is unsupported', () => {
    const envelope = base64ToBytes(stripSignatures(signedClassicEnvelope()));
    // Corrupt the MuxedAccount discriminant (offset 4) to an undefined type.
    writeUint32BE(envelope, 4, 2);
    const bad = bytesToBase64(envelope);
    expect(() => assertEnvelopeSourcedFrom(bad, PRIVATE_KEY)).toThrow(
      /Unsupported transaction source account type/,
    );
  });

  it('parses a muxed source account (skip the 8-byte id, compare the key)', () => {
    // Rebuild the envelope with a MUXED_ED25519 source: tag 1, 8-byte id,
    // then the same 32-byte key. The gate must still accept it.
    const plain = base64ToBytes(stripSignatures(signedClassicEnvelope()));
    const muxed = new Uint8Array(plain.length + 8);
    muxed.set(plain.subarray(0, 4), 0); // envelope type tag
    muxed[4] = 0;
    muxed[5] = 0;
    muxed[6] = 0;
    muxed[7] = 1; // MUXED_ED25519
    muxed.set(new Uint8Array(8), 8); // the mux id
    muxed.set(plain.subarray(8), 16); // key + rest of the transaction
    expect(() => assertEnvelopeSourcedFrom(bytesToBase64(muxed), PRIVATE_KEY)).not.toThrow();
  });

  it('rejects a wrong-length seed with a clean error', () => {
    const unsigned = stripSignatures(signedClassicEnvelope());
    expect(() => assertEnvelopeSourcedFrom(unsigned, new Uint8Array(31))).toThrow(
      /must be 32 bytes/,
    );
  });
});

describe('assertAuthPreimageBoundToNetwork (the auth-entry trust gate)', () => {
  /**
   * Builds a `HashIdPreimage::SorobanAuthorization`-shaped buffer:
   * uint32(5) discriminant || 32-byte networkId || invocation body.
   */
  function sorobanPreimage(
    passphrase: string,
    body: Uint8Array = new Uint8Array(64).fill(0x7a),
  ): string {
    const networkId = sha256(new TextEncoder().encode(passphrase));
    const preimage = new Uint8Array(4 + 32 + body.length);
    writeUint32BE(preimage, 0, 5);
    preimage.set(networkId, 4);
    preimage.set(body, 36);
    return bytesToBase64(preimage);
  }

  it('accepts a Soroban authorization preimage for the pool network', () => {
    expect(() =>
      assertAuthPreimageBoundToNetwork(sorobanPreimage(TESTNET_PASSPHRASE), TESTNET_PASSPHRASE),
    ).not.toThrow();
  });

  it('rejects a preimage bound to a different network (the mainnet oracle)', () => {
    // The exact attack the gate exists for: a preimage whose embedded
    // networkId is MAINNET's, handed to the testnet-pinned signer bridge.
    const mainnetPreimage = sorobanPreimage('Public Global Stellar Network ; September 2015');
    expect(() => assertAuthPreimageBoundToNetwork(mainnetPreimage, TESTNET_PASSPHRASE)).toThrow(
      /different network than the pool/,
    );
  });

  it('rejects a non-Soroban-authorization HashIdPreimage arm', () => {
    // E.g. a HashIdPreimageOperation (discriminant 2) — signable payloads of
    // a different kind must not slip through the auth-entry arm.
    const preimage = base64ToBytes(sorobanPreimage(TESTNET_PASSPHRASE));
    writeUint32BE(preimage, 0, 2);
    expect(() =>
      assertAuthPreimageBoundToNetwork(bytesToBase64(preimage), TESTNET_PASSPHRASE),
    ).toThrow(/Expected a Soroban authorization preimage/);
  });

  it('rejects a truncated preimage (no room for the networkId)', () => {
    const short = bytesToBase64(new Uint8Array(20).fill(1));
    expect(() => assertAuthPreimageBoundToNetwork(short, TESTNET_PASSPHRASE)).toThrow(
      /invalid length/,
    );
  });

  it('rejects an oversized preimage', () => {
    const oversized = sorobanPreimage(
      TESTNET_PASSPHRASE,
      new Uint8Array(16 * 1024).fill(0x42),
    );
    expect(() => assertAuthPreimageBoundToNetwork(oversized, TESTNET_PASSPHRASE)).toThrow(
      /invalid length/,
    );
  });

  it('rejects garbage base64', () => {
    expect(() => assertAuthPreimageBoundToNetwork('not!!base64', TESTNET_PASSPHRASE)).toThrow();
  });
});

/** Writes a big-endian uint32 at `offset` (test helper). */
function writeUint32BE(bytes: Uint8Array, offset: number, value: number): void {
  bytes[offset] = (value >>> 24) & 0xff;
  bytes[offset + 1] = (value >>> 16) & 0xff;
  bytes[offset + 2] = (value >>> 8) & 0xff;
  bytes[offset + 3] = value & 0xff;
}

import { describe, expect, it } from 'vitest';
import { ed25519 } from '@noble/curves/ed25519';
import {
  addressForPrivateKey,
  decodeMetaValue,
  deriveStealthKeys,
  deriveStealthPayment,
  encodeMetaValue,
  hashToScalar,
  recoverStealthPrivateKey,
  signWithScalar,
  stealthMetaFromKeys,
  stealthPublicKey,
  STEALTH_DATA_KEY,
} from '@/core/privacy/stellar-stealth';
import { deriveAccount } from '@/core/vault/key-derivation';

/** Standard BIP-39 test vector (12 words, valid checksum). */
const MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

/** Scalar 1, for a deterministic payer ephemeral in tests. */
const EPHEMERAL_ONE = Uint8Array.from({ length: 32 }, (_, i) => (i === 31 ? 1 : 0));

describe('Stellar stealth keys', () => {
  it('derives 32-byte spend/view scalars deterministically from the mnemonic', () => {
    const a = deriveStealthKeys(MNEMONIC);
    const b = deriveStealthKeys(MNEMONIC);
    expect(a.spendPriv).toHaveLength(32);
    expect(a.viewPriv).toHaveLength(32);
    expect(a.spendPriv).toEqual(b.spendPriv);
    expect(a.viewPriv).toEqual(b.viewPriv);
  });

  it('derives different keys for a different mnemonic (restore = identity)', () => {
    const other =
      'legal winner thank year wave sausage worth useful legal winner thank yellow';
    const a = deriveStealthKeys(MNEMONIC);
    const b = deriveStealthKeys(other);
    expect(a.spendPriv).not.toEqual(b.spendPriv);
    expect(a.viewPriv).not.toEqual(b.viewPriv);
  });

  it('keeps stealth keys disjoint from the payment account key', () => {
    // The stealth paths (m/8888'/0' and m/8888'/1') must never collide with
    // the SLIP-10 Stellar payment path — a colliding key would leak the
    // account's signing key as a stealth scanning key.
    const account = deriveAccount(MNEMONIC, 'stellar', 0);
    const stealth = deriveStealthKeys(MNEMONIC);
    expect(stealth.spendPriv).not.toEqual(account.privateKey);
    expect(stealth.viewPriv).not.toEqual(account.privateKey);
    expect(stealthPublicKey(stealth.spendPriv)).not.toEqual(account.publicKey);
  });

  it('spend and view keys are distinct canonical scalars', () => {
    const keys = deriveStealthKeys(MNEMONIC);
    expect(keys.spendPriv).not.toEqual(keys.viewPriv);
    // Canonical: 0 < s < L, so the raw point multiply is well-defined.
    const L = ed25519.CURVE.n;
    const scalar = BigInt(
      '0x' + Array.from(keys.spendPriv).map((b) => b.toString(16).padStart(2, '0')).join(''),
    );
    expect(scalar).toBeGreaterThan(0n);
    expect(scalar).toBeLessThan(L);
  });
});

describe('Stellar stealth meta-address', () => {
  it('meta public points are raw scalar multiples (NOT seed-derived)', () => {
    const keys = deriveStealthKeys(MNEMONIC);
    const meta = stealthMetaFromKeys(keys);
    expect(meta.spendPub).toEqual(stealthPublicKey(keys.spendPriv));
    expect(meta.viewPub).toEqual(stealthPublicKey(keys.viewPriv));
    expect(meta.spendPub).toHaveLength(32);
    expect(meta.viewPub).toHaveLength(32);
    // Regression: the seed model (ed25519.getPublicKey) hashes the input, so
    // it produces DIFFERENT points — the bug that broke recovery.
    expect(meta.spendPub).not.toEqual(ed25519.getPublicKey(keys.spendPriv));
  });

  it('encodes to 64 bytes and round-trips', () => {
    const keys = deriveStealthKeys(MNEMONIC);
    const meta = stealthMetaFromKeys(keys);
    const encoded = encodeMetaValue(meta);
    expect(encoded).toHaveLength(64);
    expect(decodeMetaValue(encoded)).toEqual(meta);
  });

  it('rejects a malformed manage_data value', () => {
    expect(() => decodeMetaValue(new Uint8Array(63))).toThrow('64 bytes');
  });

  it('publishes under the documented data key', () => {
    expect(STEALTH_DATA_KEY).toBe('vpstealth');
    expect(STEALTH_DATA_KEY.length).toBeLessThanOrEqual(64);
  });
});

describe('Stellar stealth payment derivation', () => {
  it('derives a deterministic one-time address for a fixed ephemeral', () => {
    const keys = deriveStealthKeys(MNEMONIC);
    const meta = stealthMetaFromKeys(keys);
    const a = deriveStealthPayment(meta, EPHEMERAL_ONE);
    const b = deriveStealthPayment(meta, EPHEMERAL_ONE);
    expect(a.oneTimeAddress).toEqual(b.oneTimeAddress);
    expect(a.ephemeralPub).toEqual(b.ephemeralPub);
  });

  it('produces a distinct one-time address per payment (VAP-09)', () => {
    const keys = deriveStealthKeys(MNEMONIC);
    const meta = stealthMetaFromKeys(keys);
    const first = deriveStealthPayment(meta);
    const second = deriveStealthPayment(meta);
    expect(first.oneTimeAddress).not.toEqual(second.oneTimeAddress);
    expect(first.ephemeralPub).not.toEqual(second.ephemeralPub);
  });

  it('the announcement is a canonical 32-byte ed25519 point', () => {
    const keys = deriveStealthKeys(MNEMONIC);
    const meta = stealthMetaFromKeys(keys);
    const payment = deriveStealthPayment(meta, EPHEMERAL_ONE);
    expect(payment.ephemeralPub).toHaveLength(32);
    // E = e·B: for e = 1 the announcement must be the base point itself.
    expect(payment.ephemeralPub).toEqual(ed25519.ExtendedPoint.BASE.toRawBytes());
  });

  it('the one-time address is a valid Stellar strkey (G…)', () => {
    const keys = deriveStealthKeys(MNEMONIC);
    const meta = stealthMetaFromKeys(keys);
    const payment = deriveStealthPayment(meta, EPHEMERAL_ONE);
    expect(payment.oneTimeAddress).toMatch(/^G[A-Z2-7]{55}$/);
  });

  it('payments to different recipients never share a one-time address', () => {
    const recipientA = stealthMetaFromKeys(deriveStealthKeys(MNEMONIC));
    const recipientB = stealthMetaFromKeys(deriveStealthKeys(
      'legal winner thank year wave sausage worth useful legal winner thank yellow',
    ));
    const toA = deriveStealthPayment(recipientA, EPHEMERAL_ONE);
    const toB = deriveStealthPayment(recipientB, EPHEMERAL_ONE);
    expect(toA.oneTimeAddress).not.toEqual(toB.oneTimeAddress);
  });
});

describe('Stellar stealth recovery (the round trip that must hold)', () => {
  it('the receiver recovers the exact one-time scalar from the announcement', () => {
    const keys = deriveStealthKeys(MNEMONIC);
    const meta = stealthMetaFromKeys(keys);
    const payment = deriveStealthPayment(meta, EPHEMERAL_ONE);

    const recovered = recoverStealthPrivateKey(
      payment.ephemeralPub,
      keys.viewPriv,
      keys.spendPriv,
    );
    // The recovered scalar's public point must equal the payer's one-time
    // address — otherwise the funds are unrecoverable.
    expect(addressForPrivateKey(recovered)).toBe(payment.oneTimeAddress);
  });

  it('recovery works for random ephemerals, not just the test scalar', () => {
    const keys = deriveStealthKeys(MNEMONIC);
    const meta = stealthMetaFromKeys(keys);
    for (let i = 0; i < 8; i += 1) {
      const payment = deriveStealthPayment(meta);
      const recovered = recoverStealthPrivateKey(
        payment.ephemeralPub,
        keys.viewPriv,
        keys.spendPriv,
      );
      expect(addressForPrivateKey(recovered)).toBe(payment.oneTimeAddress);
    }
  });

  it('a different wallet cannot recover the payment (ECDH secrecy)', () => {
    const recipientKeys = deriveStealthKeys(MNEMONIC);
    const meta = stealthMetaFromKeys(recipientKeys);
    const payment = deriveStealthPayment(meta, EPHEMERAL_ONE);

    const attackerKeys = deriveStealthKeys(
      'legal winner thank year wave sausage worth useful legal winner thank yellow',
    );
    const wrongKey = recoverStealthPrivateKey(
      payment.ephemeralPub,
      attackerKeys.viewPriv,
      attackerKeys.spendPriv,
    );
    expect(addressForPrivateKey(wrongKey)).not.toBe(payment.oneTimeAddress);
  });

  it('an announcement from a different payer scheme does not recover the address', () => {
    const keys = deriveStealthKeys(MNEMONIC);
    // 32 bytes of a non-point memo (invalid encoding) must not produce the
    // payment address — the scan treats it as noise.
    const bogusAnnouncement = new Uint8Array(32).fill(0xff);
    expect(() =>
      recoverStealthPrivateKey(bogusAnnouncement, keys.viewPriv, keys.spendPriv),
    ).toThrow();
  });
});

describe('raw-scalar Ed25519 signing (the claim path)', () => {
  it('signWithScalar produces a signature a standard verifier accepts', () => {
    // The critical proof: noble's ordinary ed25519.verify accepts the
    // raw-scalar signature against the raw-scalar public point. Horizon runs
    // exactly this verification.
    const keys = deriveStealthKeys(MNEMONIC);
    const meta = stealthMetaFromKeys(keys);
    const payment = deriveStealthPayment(meta, EPHEMERAL_ONE);
    const recovered = recoverStealthPrivateKey(
      payment.ephemeralPub,
      keys.viewPriv,
      keys.spendPriv,
    );

    const message = new Uint8Array(32).fill(0x42);
    const signature = signWithScalar(message, recovered);
    expect(signature).toHaveLength(64);
    // The public point of the recovered scalar IS the one-time address.
    const oneTimePub = stealthPublicKey(recovered);
    expect(ed25519.verify(signature, message, oneTimePub)).toBe(true);
    // And the strkey form is the address the funds landed on.
    expect(addressForPrivateKey(recovered)).toBe(payment.oneTimeAddress);
  });

  it('signWithScalar is deterministic and rejects a zero scalar', () => {
    const keys = deriveStealthKeys(MNEMONIC);
    const message = new Uint8Array([1, 2, 3]);
    expect(signWithScalar(message, keys.spendPriv)).toEqual(
      signWithScalar(message, keys.spendPriv),
    );
    expect(() => signWithScalar(message, new Uint8Array(32))).toThrow('zero');
  });

  it('a signature does not verify against a different public point', () => {
    const keys = deriveStealthKeys(MNEMONIC);
    const message = new Uint8Array([9, 9, 9]);
    const signature = signWithScalar(message, keys.spendPriv);
    expect(ed25519.verify(signature, message, stealthPublicKey(keys.viewPriv))).toBe(false);
  });
});

describe('hashToScalar', () => {
  it('is deterministic and nonzero', () => {
    const input = new Uint8Array([1, 2, 3]);
    expect(hashToScalar(input)).toBe(hashToScalar(input));
    expect(hashToScalar(input)).toBeGreaterThan(0n);
    expect(hashToScalar(input)).toBeLessThan(ed25519.CURVE.n);
  });

  it('reduces values larger than the group order', () => {
    const large = new Uint8Array(32).fill(0xff);
    expect(hashToScalar(large)).toBeLessThan(ed25519.CURVE.n);
  });
});

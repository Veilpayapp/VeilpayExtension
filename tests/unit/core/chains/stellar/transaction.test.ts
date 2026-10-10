import { describe, expect, it } from 'vitest';
import { ed25519 } from '@noble/curves/ed25519';
import { sha256 } from '@noble/hashes/sha256';
import {
  decodeStellarAddress,
  encodeStellarAddress,
  signStellarAccountMerge,
  signStellarAccountMergeWithScalar,
  signStellarChangeTrust,
  signStellarCreateAccount,
  signStellarManageData,
  signStellarPayment,
  STELLAR_TRUSTLINE_NO_LIMIT,
} from '@/core/chains/stellar/transaction';

// Known test keys (ed25519, 32 bytes).
const SOURCE_PUBKEY = new Uint8Array(32).fill(0x0a);
const DEST_PUBKEY = new Uint8Array(32).fill(0x0b);
const PRIVATE_KEY = new Uint8Array(32).fill(0x01);

const SOURCE_ADDRESS = encodeStellarAddress(SOURCE_PUBKEY);
const DEST_ADDRESS = encodeStellarAddress(DEST_PUBKEY);

describe('Stellar transfer serialization', () => {
  it('encodes a valid strkey address (G...)', () => {
    expect(SOURCE_ADDRESS.startsWith('G')).toBe(true);
    expect(DEST_ADDRESS.startsWith('G')).toBe(true);
    // Strkey is base32, so only A-Z and 2-7 characters.
    expect(SOURCE_ADDRESS).toMatch(/^G[A-Z2-7]{55}$/);
  });

  it('signs a payment and returns a valid base64 envelope', () => {
    const result = signStellarPayment({
      from: SOURCE_ADDRESS,
      to: DEST_ADDRESS,
      amount: 100_000_000n, // 10 XLM in stroops
      sequence: 120n,
      fee: 100,
    }, PRIVATE_KEY);

    // Valid base64
    expect(() => atob(result.raw)).not.toThrow();
    expect(result.from).toBe(SOURCE_ADDRESS);
    expect(result.signingHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('signs over the canonical network signature base (regression: tx_bad_auth)', () => {
    // Stellar's signing hash is sha256(networkId || taggedTransaction), NOT
    // sha256(txXdr). Signing the bare transaction hash makes Horizon reject the
    // signature with tx_bad_auth even though the XDR is valid.
    //
    // Use a `from` derived from the SAME key that signs (as the background
    // does), so the signature must validate against the source public key.
    const publicKey = ed25519.getPublicKey(PRIVATE_KEY);
    const fromAddress = encodeStellarAddress(publicKey);
    const result = signStellarPayment({
      from: fromAddress,
      to: DEST_ADDRESS,
      amount: 100_000_000n,
      sequence: 120n,
      fee: 100,
    }, PRIVATE_KEY);

    // Envelope layout: [uint32 2 (envelope disc)][txXdr]
    //   [uint32 1 (sig count)][hint 4][opaque: uint32 64 + 64 bytes]
    const envelope = new Uint8Array(atob(result.raw).split('').map((c) => c.charCodeAt(0)));
    const txLen = envelope.length - 4 - (4 + 4 + 4 + 64);
    const txXdr = envelope.slice(4, 4 + txLen);
    const sig = envelope.slice(4 + txLen + 12, 4 + txLen + 12 + 64);
    const signingHashBytes = Uint8Array.from(
      result.signingHash.match(/.{2}/g)!.map((h) => parseInt(h, 16)),
    );

    // 1) The embedded signature verifies against the reported signing hash and
    //    the signing key's public key — i.e. it is a valid Stellar auth.
    expect(ed25519.verify(sig, signingHashBytes, publicKey)).toBe(true);
    // 2) The signing hash includes the network-ID prefix: it is NOT the bare
    //    SHA-256 of the transaction XDR (the pre-fix bug that caused tx_bad_auth).
    const bareTxHash = Array.from(sha256(txXdr)).map((b) => b.toString(16).padStart(2, '0')).join('');
    expect(result.signingHash).not.toBe(bareTxHash);
    // 3) The canonical form is reproducible: signing the same inputs twice
    //    yields the same network hash (checked already by the determinism test).
  });

  it('produces a deterministic output for the same inputs', () => {
    const a = signStellarPayment({
      from: SOURCE_ADDRESS,
      to: DEST_ADDRESS,
      amount: 100_000_000n,
      sequence: 120n,
      fee: 100,
    }, PRIVATE_KEY);

    const b = signStellarPayment({
      from: SOURCE_ADDRESS,
      to: DEST_ADDRESS,
      amount: 100_000_000n,
      sequence: 120n,
      fee: 100,
    }, PRIVATE_KEY);

    expect(a.raw).toBe(b.raw);
    expect(a.signingHash).toBe(b.signingHash);
  });

  it('changes the output when the sequence number changes', () => {
    const a = signStellarPayment({
      from: SOURCE_ADDRESS,
      to: DEST_ADDRESS,
      amount: 100_000_000n,
      sequence: 120n,
      fee: 100,
    }, PRIVATE_KEY);

    const b = signStellarPayment({
      from: SOURCE_ADDRESS,
      to: DEST_ADDRESS,
      amount: 100_000_000n,
      sequence: 121n,
      fee: 100,
    }, PRIVATE_KEY);

    expect(a.raw).not.toBe(b.raw);
  });

  it('XDR envelope has the expected structure', () => {
    const result = signStellarPayment({
      from: SOURCE_ADDRESS,
      to: DEST_ADDRESS,
      amount: 100_000_000n,
      sequence: 120n,
      fee: 100,
    }, PRIVATE_KEY);

    const raw = Uint8Array.from(atob(result.raw), (c) => c.charCodeAt(0));

    // The envelope opens with the union discriminant ENVELOPE_TYPE_TX = 2
    // (Horizon cannot decode a bare TransactionV1Envelope body).
    expect(raw.slice(0, 4)).toEqual(new Uint8Array([0, 0, 0, 2]));

    // Then Transaction.sourceAccount (MuxedAccount, KEY_TYPE_ED25519 = 0:
    // uint32 discriminant + 32 bytes).
    expect(raw.slice(4, 8)).toEqual(new Uint8Array(4));
    for (let i = 8; i < 40; i += 1) {
      expect(raw[i]).toBe(0x0a);
    }

    // fee uint32 = 100 follows the source account.
    expect(raw.slice(40, 44)).toEqual(new Uint8Array([0, 0, 0, 100]));

    // seqNum int64 = 121 follows the fee (big-endian): the builder bumps
    // Horizon's current sequence (120) by 1, which Horizon requires.
    expect(raw.slice(44, 52)).toEqual(new Uint8Array([0, 0, 0, 0, 0, 0, 0, 121]));

    // Modern Preconditions union: PRECOND_NONE = uint32 0 (4 bytes).
    expect(raw.slice(52, 56)).toEqual(new Uint8Array(4));

    // Memo: MEMO_NONE = uint32 0.
    expect(raw.slice(56, 60)).toEqual(new Uint8Array(4));

    // Operations array: count (1), then Operation begins with a null
    // MuxedAccount* pointer — an XDR optional pointer is FOUR bytes (0), not
    // one — then the PAYMENT discriminant (=1).
    expect(raw.slice(60, 64)).toEqual(new Uint8Array([0, 0, 0, 1])); // ops count = 1
    expect(raw.slice(64, 68)).toEqual(new Uint8Array(4)); // sourceAccount* = null
    expect(raw.slice(68, 72)).toEqual(new Uint8Array([0, 0, 0, 1])); // PAYMENT

    // Destination AccountID: ED25519 discriminant (4 zero bytes) then 32 bytes
    // of 0x0b. indexOf finds the first byte of the contiguous key run.
    const destPos = raw.indexOf(0x0b);
    expect(destPos).toBeGreaterThan(0);
    expect(raw.slice(destPos - 4, destPos)).toEqual(new Uint8Array(4));
    expect(raw.slice(destPos, destPos + 32)).toEqual(new Uint8Array(32).fill(0x0b));

    // Ends with a 64-byte ed25519 signature.
    const sigStart = raw.length - 64;
    expect(sigStart).toBeGreaterThan(100);
    expect(raw.length).toBe(sigStart + 64);
  });

  it('encodes a 1 XLM payment as 10000000 stroops (int64), not a decimal string', () => {
    // 1 XLM = 10^7 stroops. The protocol wire format is an int64 stroop amount,
    // NOT the "1.0000000" decimal string stellar-sdk's Operation.payment uses.
    const result = signStellarPayment({
      from: SOURCE_ADDRESS,
      to: DEST_ADDRESS,
      amount: 10_000_000n, // 1 XLM
      sequence: 120n,
      fee: 100,
    }, PRIVATE_KEY);

    const raw = Uint8Array.from(atob(result.raw), (c) => c.charCodeAt(0));
    // For a native asset, the amount int64 sits at bytes 112-120 (after the
    // destination AccountID at 72-108 and the 4-byte native Asset union at
    // 108-112). Assert the exact stroop value, big-endian.
    expect(raw.slice(112, 120)).toEqual(new Uint8Array([0, 0, 0, 0, 0, 0x98, 0x96, 0x80]));
  });

  it('rejects an invalid private key length', () => {
    expect(() => signStellarPayment({
      from: SOURCE_ADDRESS,
      to: DEST_ADDRESS,
      amount: 100n,
      sequence: 1n,
      fee: 100,
    }, new Uint8Array(16))).toThrow('32 bytes');
  });

  it('rejects an invalid destination address', () => {
    expect(() => signStellarPayment({
      from: SOURCE_ADDRESS,
      to: 'NOT_A_VALID_ADDRESS',
      amount: 100n,
      sequence: 1n,
      fee: 100,
    }, PRIVATE_KEY)).toThrow();
  });

  it('encodes a short issued asset code as credit_alphanum4 (type 1)', () => {
    const issuer = encodeStellarAddress(new Uint8Array(32).fill(0x0c));
    const result = signStellarPayment({
      from: SOURCE_ADDRESS,
      to: DEST_ADDRESS,
      amount: 1_000_000n,
      asset: { type: 'issued', code: 'USDC', issuer },
      sequence: 120n,
      fee: 100,
    }, PRIVATE_KEY);

    expect(() => atob(result.raw)).not.toThrow();
    expect(result.from).toBe(SOURCE_ADDRESS);

    const raw = Uint8Array.from(atob(result.raw), (c) => c.charCodeAt(0));
    // Asset union sits right after the destination AccountID key. In the native
    // case destination key is an ED25519 AccountID: disc (72-76) + 32-byte key
    // (76-108), so the Asset union starts at 108.
    expect(raw.slice(108, 112)).toEqual(new Uint8Array([0, 0, 0, 1])); // ASSET_TYPE_CREDIT_ALPHANUM4
    // 4-byte asset code "USDC" follows the type discriminant.
    expect(raw.slice(112, 116)).toEqual(new Uint8Array([0x55, 0x53, 0x44, 0x43]));
    // Issuer AccountID = ED25519 discriminant (4 zero bytes) + 32-byte key.
    expect(raw.slice(116, 120)).toEqual(new Uint8Array(4));
    expect(raw.slice(120, 152)).toEqual(new Uint8Array(32).fill(0x0c));
  });

  it('encodes a 12-char code as credit_alphanum12 (type 2)', () => {
    const issuer = encodeStellarAddress(new Uint8Array(32).fill(0x0d));
    const result = signStellarPayment({
      from: SOURCE_ADDRESS,
      to: DEST_ADDRESS,
      amount: 1_000_000n,
      asset: { type: 'issued', code: 'SPECIALTOKEN', issuer },
      sequence: 120n,
      fee: 100,
    }, PRIVATE_KEY);

    const raw = Uint8Array.from(atob(result.raw), (c) => c.charCodeAt(0));
    expect(raw.slice(108, 112)).toEqual(new Uint8Array([0, 0, 0, 2])); // ASSET_TYPE_CREDIT_ALPHANUM12
    // 12-byte code (NUL-padded) follows the type discriminant.
    const code = Uint8Array.from('SPECIALTOKEN', (c) => c.charCodeAt(0));
    expect(raw.slice(112, 124)).toEqual(code);
    expect(raw.slice(124, 128)).toEqual(new Uint8Array(4)); // issuer ED25519 disc
    expect(raw.slice(128, 160)).toEqual(new Uint8Array(32).fill(0x0d));
  });
});

describe('Stellar MEMO_TEXT encoding', () => {
  /** Decodes an envelope into its transaction XDR and signature parts. */
  function splitEnvelope(raw: string): { txXdr: Uint8Array; sig: Uint8Array } {
    const envelope = Uint8Array.from(atob(raw), (c) => c.charCodeAt(0));
    // [uint32 disc][txXdr][uint32 sigCount][hint 4][opaque: uint32 64 + 64 bytes]
    const sigCountStart = envelope.length - (4 + 4 + 4 + 64);
    const txXdr = envelope.slice(4, sigCountStart);
    const sig = envelope.slice(sigCountStart + 12, sigCountStart + 12 + 64);
    return { txXdr, sig };
  }

  it('encodes MEMO_NONE when no memo is given (byte-compatible with history)', () => {
    const result = signStellarPayment({
      from: SOURCE_ADDRESS,
      to: DEST_ADDRESS,
      amount: 100n,
      sequence: 120n,
      fee: 100,
    }, PRIVATE_KEY);

    const raw = Uint8Array.from(atob(result.raw), (c) => c.charCodeAt(0));
    // Memo field sits after source(36) + fee(4) + seq(8) + preconditions(4).
    expect(raw.slice(52, 56)).toEqual(new Uint8Array(4)); // PRECOND_NONE
    expect(raw.slice(56, 60)).toEqual(new Uint8Array([0, 0, 0, 0])); // MEMO_NONE
    expect(raw.slice(60, 64)).toEqual(new Uint8Array([0, 0, 0, 1])); // ops count right after
  });

  it('treats an empty or whitespace-only memo as MEMO_NONE', () => {
    for (const memo of ['', '   ']) {
      const result = signStellarPayment({
        from: SOURCE_ADDRESS,
        to: DEST_ADDRESS,
        amount: 100n,
        sequence: 120n,
        fee: 100,
        memo,
      }, PRIVATE_KEY);

      const raw = Uint8Array.from(atob(result.raw), (c) => c.charCodeAt(0));
      expect(raw.slice(56, 60)).toEqual(new Uint8Array([0, 0, 0, 0])); // MEMO_NONE
      expect(raw.slice(60, 64)).toEqual(new Uint8Array([0, 0, 0, 1])); // ops count unshifted
    }
  });

  it('encodes MEMO_TEXT with length prefix and 4-byte alignment padding', () => {
    const result = signStellarPayment({
      from: SOURCE_ADDRESS,
      to: DEST_ADDRESS,
      amount: 100n,
      sequence: 120n,
      fee: 100,
      memo: 'order-123', // 9 bytes → padded to 12
    }, PRIVATE_KEY);

    const raw = Uint8Array.from(atob(result.raw), (c) => c.charCodeAt(0));
    // MEMO_TEXT discriminant = 1 at the memo position (56).
    expect(raw.slice(56, 60)).toEqual(new Uint8Array([0, 0, 0, 1]));
    // uint32 byte length = 9.
    expect(raw.slice(60, 64)).toEqual(new Uint8Array([0, 0, 0, 9]));
    // The 9 text bytes follow…
    const text = Uint8Array.from('order-123', (c) => c.charCodeAt(0));
    expect(raw.slice(64, 73)).toEqual(text);
    // …zero-padded to a 4-byte boundary (3 pad bytes).
    expect(raw.slice(73, 76)).toEqual(new Uint8Array(3));
    // The operations array count follows at the aligned offset.
    expect(raw.slice(76, 80)).toEqual(new Uint8Array([0, 0, 0, 1]));
    // No padding needed when the memo is already 4-byte aligned.
    const aligned = signStellarPayment({
      from: SOURCE_ADDRESS,
      to: DEST_ADDRESS,
      amount: 100n,
      sequence: 120n,
      fee: 100,
      memo: 'memo1234', // 8 bytes → no padding
    }, PRIVATE_KEY);
    const rawAligned = Uint8Array.from(atob(aligned.raw), (c) => c.charCodeAt(0));
    expect(rawAligned.slice(60, 64)).toEqual(new Uint8Array([0, 0, 0, 8]));
    expect(rawAligned.slice(64, 72)).toEqual(Uint8Array.from('memo1234', (c) => c.charCodeAt(0)));
    expect(rawAligned.slice(72, 76)).toEqual(new Uint8Array([0, 0, 0, 1])); // ops count at 72
  });

  it('signs over the memo: the signature verifies and the hash changes', () => {
    const publicKey = ed25519.getPublicKey(PRIVATE_KEY);
    const fromAddress = encodeStellarAddress(publicKey);

    const withMemo = signStellarPayment({
      from: fromAddress,
      to: DEST_ADDRESS,
      amount: 100n,
      sequence: 120n,
      fee: 100,
      memo: 'order-123',
    }, PRIVATE_KEY);
    const withoutMemo = signStellarPayment({
      from: fromAddress,
      to: DEST_ADDRESS,
      amount: 100n,
      sequence: 120n,
      fee: 100,
    }, PRIVATE_KEY);

    // Different network hash → the memo is covered by the signature base.
    expect(withMemo.signingHash).not.toBe(withoutMemo.signingHash);

    // The signature over the memo-bearing transaction still verifies.
    const { sig } = splitEnvelope(withMemo.raw);
    const signingHashBytes = Uint8Array.from(
      withMemo.signingHash.match(/.{2}/g)!.map((h) => parseInt(h, 16)),
    );
    expect(ed25519.verify(sig, signingHashBytes, publicKey)).toBe(true);
  });

  it('rejects a memo over 28 bytes (multibyte counts as bytes, not chars)', () => {
    // 29 ASCII bytes.
    expect(() => signStellarPayment({
      from: SOURCE_ADDRESS,
      to: DEST_ADDRESS,
      amount: 100n,
      sequence: 1n,
      fee: 100,
      memo: 'x'.repeat(29),
    }, PRIVATE_KEY)).toThrow('28');
    // 15 characters but 30 UTF-8 bytes — the schema's char cap alone would
    // let this through; the builder must enforce the byte cap.
    expect(() => signStellarPayment({
      from: SOURCE_ADDRESS,
      to: DEST_ADDRESS,
      amount: 100n,
      sequence: 1n,
      fee: 100,
      memo: 'ä'.repeat(15),
    }, PRIVATE_KEY)).toThrow('28');
  });

  it('accepts a memo at exactly 28 bytes', () => {
    const result = signStellarPayment({
      from: SOURCE_ADDRESS,
      to: DEST_ADDRESS,
      amount: 100n,
      sequence: 120n,
      fee: 100,
      memo: 'x'.repeat(28),
    }, PRIVATE_KEY);

    const raw = Uint8Array.from(atob(result.raw), (c) => c.charCodeAt(0));
    expect(raw.slice(56, 60)).toEqual(new Uint8Array([0, 0, 0, 1])); // MEMO_TEXT
    expect(raw.slice(60, 64)).toEqual(new Uint8Array([0, 0, 0, 28]));
  });

  it('is deterministic for the same memo and changes with it', () => {
    const base = {
      from: SOURCE_ADDRESS,
      to: DEST_ADDRESS,
      amount: 100n,
      sequence: 120n,
      fee: 100,
    };
    const a = signStellarPayment({ ...base, memo: 'one' }, PRIVATE_KEY);
    const b = signStellarPayment({ ...base, memo: 'one' }, PRIVATE_KEY);
    const c = signStellarPayment({ ...base, memo: 'two' }, PRIVATE_KEY);
    expect(a.raw).toBe(b.raw);
    expect(a.raw).not.toBe(c.raw);
  });
});

describe('Stellar change-trust serialization (add-token trustline)', () => {
  /** Extracts the raw 64-byte signature from a v1 envelope. */
  function extractSig(raw: string): Uint8Array {
    const envelope = Uint8Array.from(atob(raw), (c) => c.charCodeAt(0));
    // Trailing layout: [uint32 sig count][hint 4][uint32 len 64][64 bytes]
    return envelope.slice(envelope.length - 64);
  }

  it('signs a trustline envelope whose signature verifies', () => {
    const publicKey = ed25519.getPublicKey(PRIVATE_KEY);
    const fromAddress = encodeStellarAddress(publicKey);

    const result = signStellarChangeTrust(
      {
        from: fromAddress,
        asset: { type: 'issued', code: 'USDC', issuer: DEST_ADDRESS },
        limit: STELLAR_TRUSTLINE_NO_LIMIT,
        sequence: 120n,
        fee: 100,
      },
      PRIVATE_KEY,
    );

    expect(() => atob(result.raw)).not.toThrow();
    expect(result.from).toBe(fromAddress);
    expect(result.signingHash).toMatch(/^[0-9a-f]{64}$/);

    // The embedded signature verifies against the signing hash.
    const sig = extractSig(result.raw);
    const signingHashBytes = Uint8Array.from(
      result.signingHash.match(/.{2}/g)!.map((h) => parseInt(h, 16)),
    );
    expect(ed25519.verify(sig, signingHashBytes, publicKey)).toBe(true);
  });

  it('encodes the CHANGE_TRUST operation with the asset and limit', () => {
    const result = signStellarChangeTrust(
      {
        from: SOURCE_ADDRESS,
        asset: { type: 'issued', code: 'USDC', issuer: DEST_ADDRESS },
        limit: STELLAR_TRUSTLINE_NO_LIMIT,
        sequence: 120n,
        fee: 100,
      },
      PRIVATE_KEY,
    );

    const raw = Uint8Array.from(atob(result.raw), (c) => c.charCodeAt(0));
    // Envelope layout: [uint32 2 (envelope disc)] then the Transaction XDR:
    // [pubkey 36][fee 4][seq 8][precond 4][memo 4][ops…][ext 4].
    // Operations: uint32 count=1, then each op: [source ptr 4][body…].
    // Body: uint32 type 6 (CHANGE_TRUST) + Asset + int64 limit.
    const opsStart = 4 + 36 + 4 + 8 + 4 + 4; // envelope disc + up to and incl. memo
    expect(raw.slice(opsStart, opsStart + 4)).toEqual(new Uint8Array([0, 0, 0, 1])); // 1 op
    const opStart = opsStart + 4;
    expect(raw.slice(opStart, opStart + 4)).toEqual(new Uint8Array([0, 0, 0, 0])); // null source
    const bodyStart = opStart + 4;
    expect(raw.slice(bodyStart, bodyStart + 4)).toEqual(new Uint8Array([0, 0, 0, 6])); // CHANGE_TRUST = 6
    // Asset: CREDIT_ALPHANUM4 (1) + code[4] "USDC" + pubkey(0+32).
    const assetStart = bodyStart + 4;
    expect(raw.slice(assetStart, assetStart + 4)).toEqual(new Uint8Array([0, 0, 0, 1]));
    expect(new TextDecoder().decode(raw.slice(assetStart + 4, assetStart + 8))).toBe('USDC');
    // Limit: 2^63-1 as int64 big-endian = 0x7fffffffffffffff.
    const limitStart = assetStart + 4 + 4 + 36;
    expect(Array.from(raw.slice(limitStart, limitStart + 8))).toEqual([
      0x7f, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff,
    ]);
  });

  it('rejects a native trustline (nothing to trust)', () => {
    expect(() =>
      signStellarChangeTrust(
        {
          from: SOURCE_ADDRESS,
          asset: { type: 'native' },
          limit: STELLAR_TRUSTLINE_NO_LIMIT,
          sequence: 1n,
          fee: 100,
        },
        PRIVATE_KEY,
      ),
    ).toThrow('issued asset');
  });

  it('binds the trustline to the selected network passphrase', () => {
    const base = {
      from: SOURCE_ADDRESS,
      asset: { type: 'issued' as const, code: 'USDC', issuer: DEST_ADDRESS },
      limit: STELLAR_TRUSTLINE_NO_LIMIT,
      sequence: 120n,
      fee: 100,
    };
    const testnet = signStellarChangeTrust(
      { ...base, networkPassphrase: 'Test SDF Network ; September 2015' },
      PRIVATE_KEY,
    );
    const mainnet = signStellarChangeTrust(
      { ...base, networkPassphrase: 'Public Global Stellar Network ; September 2015' },
      PRIVATE_KEY,
    );

    // A different passphrase produces a different signing hash — the
    // trustline is network-bound, exactly like a payment.
    expect(testnet.signingHash).not.toBe(mainnet.signingHash);
  });
});

describe('Stellar create-account serialization (privacy payment)', () => {
  /** A 32-byte stealth announcement for MEMO_HASH. */
  const ANNOUNCEMENT = Uint8Array.from({ length: 32 }, (_, i) => (i % 7) + 1);

  function build() {
    return signStellarCreateAccount(
      {
        from: SOURCE_ADDRESS,
        to: DEST_ADDRESS,
        startingBalance: 5_000_000n, // 0.5 XLM (base reserve)
        sequence: 120n,
        fee: 100,
        memoHash: ANNOUNCEMENT,
      },
      PRIVATE_KEY,
    );
  }

  it('signs an envelope whose signature verifies', () => {
    const result = build();
    expect(() => atob(result.raw)).not.toThrow();
    expect(result.from).toBe(SOURCE_ADDRESS);

    const envelope = Uint8Array.from(atob(result.raw), (c) => c.charCodeAt(0));
    const sig = envelope.slice(envelope.length - 64);
    const signingHashBytes = Uint8Array.from(
      result.signingHash.match(/.{2}/g)!.map((h) => parseInt(h, 16)),
    );
    expect(
      ed25519.verify(sig, signingHashBytes, ed25519.getPublicKey(PRIVATE_KEY)),
    ).toBe(true);
  });

  it('carries the announcement as a fixed MEMO_HASH (union 2, no length prefix)', () => {
    const raw = Uint8Array.from(atob(build().raw), (c) => c.charCodeAt(0));
    // [envelope disc 4][source 36][fee 4][seq 8][precond 4] = 56
    // MEMO_HASH: [uint32 2][32 raw bytes] — exactly 36 bytes, no opaque length.
    expect(raw.slice(56, 60)).toEqual(new Uint8Array([0, 0, 0, 2])); // MEMO_HASH
    expect(raw.slice(60, 92)).toEqual(ANNOUNCEMENT);
    // Ops count follows immediately at 92 — proving no length prefix shifted it.
    expect(raw.slice(92, 96)).toEqual(new Uint8Array([0, 0, 0, 1]));
  });

  it('encodes CREATE_ACCOUNT = 0 with the destination and starting balance', () => {
    const raw = Uint8Array.from(atob(build().raw), (c) => c.charCodeAt(0));
    // Op: [source ptr 4][type 4][dest pubkey 36][int64 balance 8]
    const opStart = 96;
    expect(raw.slice(opStart, opStart + 4)).toEqual(new Uint8Array([0, 0, 0, 0])); // null source
    expect(raw.slice(opStart + 4, opStart + 8)).toEqual(new Uint8Array([0, 0, 0, 0])); // CREATE_ACCOUNT
    expect(raw.slice(opStart + 8, opStart + 12)).toEqual(new Uint8Array([0, 0, 0, 0])); // KEY_TYPE_ED25519
    expect(raw.slice(opStart + 12, opStart + 44)).toEqual(DEST_PUBKEY);
    expect(Array.from(raw.slice(opStart + 44, opStart + 52))).toEqual([
      0, 0, 0, 0, 0, 0x4c, 0x4b, 0x40,
    ]); // 5_000_000
  });

  it('rejects a non-32-byte announcement', () => {
    expect(() =>
      signStellarCreateAccount(
        {
          from: SOURCE_ADDRESS,
          to: DEST_ADDRESS,
          startingBalance: 5_000_000n,
          sequence: 120n,
          fee: 100,
          memoHash: new Uint8Array(31),
        },
        PRIVATE_KEY,
      ),
    ).toThrow('32 bytes');
  });
});

describe('Stellar manage-data serialization (stealth meta publish)', () => {
  /** spendPub || viewPub — the 64-byte meta-address value. */
  const META_VALUE = Uint8Array.from({ length: 64 }, (_, i) => (i % 11) + 2);

  function build() {
    return signStellarManageData(
      {
        from: SOURCE_ADDRESS,
        name: 'vpstealth',
        value: META_VALUE,
        sequence: 120n,
        fee: 100,
      },
      PRIVATE_KEY,
    );
  }

  it('encodes MANAGE_DATA = 10 (regression: 11 is BUMP_SEQUENCE)', () => {
    const raw = Uint8Array.from(atob(build().raw), (c) => c.charCodeAt(0));
    // [envelope 4][source 36][fee 4][seq 8][precond 4][MEMO_NONE 4] = 60
    // [op count 4] = 64, then op: [source ptr 4][type 4] = 72.
    expect(raw.slice(60, 64)).toEqual(new Uint8Array([0, 0, 0, 1])); // 1 op
    expect(raw.slice(64, 68)).toEqual(new Uint8Array([0, 0, 0, 0])); // null source
    expect(raw.slice(68, 72)).toEqual(new Uint8Array([0, 0, 0, 10])); // MANAGE_DATA = 10
  });

  it('encodes the 9-byte name XDR-aligned and the 64-byte value as a non-null pointer', () => {
    const raw = Uint8Array.from(atob(build().raw), (c) => c.charCodeAt(0));
    // name: string<64> = [uint32 len 9][9 bytes][3 pad] = 16 bytes at 72..88
    expect(raw.slice(72, 76)).toEqual(new Uint8Array([0, 0, 0, 9]));
    expect(new TextDecoder().decode(raw.slice(76, 85))).toBe('vpstealth');
    expect(raw.slice(85, 88)).toEqual(new Uint8Array(3)); // XDR alignment
    // value: DataValue* = [uint32 1 (non-null)][opaque: uint32 64 + 64 bytes]
    expect(raw.slice(88, 92)).toEqual(new Uint8Array([0, 0, 0, 1]));
    expect(raw.slice(92, 96)).toEqual(new Uint8Array([0, 0, 0, 64]));
    expect(raw.slice(96, 160)).toEqual(META_VALUE);
  });

  it('a null value encodes as the null pointer (delete)', () => {
    const raw = Uint8Array.from(
      atob(
        signStellarManageData(
          { from: SOURCE_ADDRESS, name: 'vpstealth', value: null, sequence: 120n, fee: 100 },
          PRIVATE_KEY,
        ).raw,
      ),
      (c) => c.charCodeAt(0),
    );
    expect(raw.slice(88, 92)).toEqual(new Uint8Array([0, 0, 0, 0])); // DataValue* = null
  });

  it('rejects oversized names and values', () => {
    expect(() =>
      signStellarManageData(
        { from: SOURCE_ADDRESS, name: 'x'.repeat(65), value: META_VALUE, sequence: 1n, fee: 100 },
        PRIVATE_KEY,
      ),
    ).toThrow('64');
    expect(() =>
      signStellarManageData(
        { from: SOURCE_ADDRESS, name: 'vpstealth', value: new Uint8Array(65), sequence: 1n, fee: 100 },
        PRIVATE_KEY,
      ),
    ).toThrow('64');
  });
});

describe('Stellar account-merge serialization (privacy claim sweep)', () => {
  function build() {
    return signStellarAccountMerge(
      { from: SOURCE_ADDRESS, to: DEST_ADDRESS, sequence: 120n, fee: 100 },
      PRIVATE_KEY,
    );
  }

  it('encodes ACCOUNT_MERGE = 8 with the destination key', () => {
    const raw = Uint8Array.from(atob(build().raw), (c) => c.charCodeAt(0));
    // [envelope 4][source 36][fee 4][seq 8][precond 4][MEMO_NONE 4] = 60
    // [op count 4][source ptr 4] → type at 68.
    expect(raw.slice(60, 64)).toEqual(new Uint8Array([0, 0, 0, 1])); // 1 op
    expect(raw.slice(64, 68)).toEqual(new Uint8Array([0, 0, 0, 0])); // null source
    expect(raw.slice(68, 72)).toEqual(new Uint8Array([0, 0, 0, 8])); // ACCOUNT_MERGE = 8
    // Body: just the AccountID destination.
    expect(raw.slice(72, 76)).toEqual(new Uint8Array([0, 0, 0, 0])); // KEY_TYPE_ED25519
    expect(raw.slice(76, 108)).toEqual(DEST_PUBKEY);
  });

  it('signs a seed-key merge envelope that verifies against the signer key', () => {
    // The signer's public key must be the merged source account.
    const signerPub = ed25519.getPublicKey(PRIVATE_KEY);
    const from = encodeStellarAddress(signerPub);
    const result = signStellarAccountMerge(
      { from, to: DEST_ADDRESS, sequence: 120n, fee: 100 },
      PRIVATE_KEY,
    );
    expect(result.from).toBe(from);
    const envelope = Uint8Array.from(atob(result.raw), (c) => c.charCodeAt(0));
    const sig = envelope.slice(envelope.length - 64);
    const signingHashBytes = Uint8Array.from(
      result.signingHash.match(/.{2}/g)!.map((h) => parseInt(h, 16)),
    );
    expect(ed25519.verify(sig, signingHashBytes, signerPub)).toBe(true);
  });

  it('signs a raw-scalar merge (the one-time claim path) that standard Ed25519 accepts', () => {
    // The real claim: the source is a stealth one-time address and the key
    // is an additive scalar — no seed exists. The signature must still be a
    // plain Ed25519 signature over the network hash.
    const oneTimeScalar = Uint8Array.from({ length: 32 }, (_, i) => (i % 5) + 1);
    const oneTimePub = ed25519.ExtendedPoint.BASE.multiply(
      BigInt('0x' + Array.from(oneTimeScalar).map((b) => b.toString(16).padStart(2, '0')).join('')),
    ).toRawBytes();
    const oneTimeAddress = encodeStellarAddress(oneTimePub);

    const result = signStellarAccountMergeWithScalar(
      { from: oneTimeAddress, to: DEST_ADDRESS, sequence: 5_000n, fee: 100 },
      oneTimeScalar,
    );
    expect(result.from).toBe(oneTimeAddress);

    const envelope = Uint8Array.from(atob(result.raw), (c) => c.charCodeAt(0));
    const sig = envelope.slice(envelope.length - 64);
    const signingHashBytes = Uint8Array.from(
      result.signingHash.match(/.{2}/g)!.map((h) => parseInt(h, 16)),
    );
    // Standard verification — exactly what Horizon runs.
    expect(ed25519.verify(sig, signingHashBytes, oneTimePub)).toBe(true);
  });

  it('the source address decodes back to the source pubkey', () => {
    // The one-time claim path relies on from = the one-time address.
    expect(decodeStellarAddress(SOURCE_ADDRESS)).toEqual(SOURCE_PUBKEY);
    expect(encodeStellarAddress(decodeStellarAddress(DEST_ADDRESS))).toBe(DEST_ADDRESS);
  });
});
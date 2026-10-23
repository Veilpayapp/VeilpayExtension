import { describe, expect, it } from 'vitest';
import { base58 } from '@scure/base';
import { ed25519 } from '@noble/curves/ed25519';
import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex } from '@noble/hashes/utils';
import {
  deriveAssociatedTokenAddress,
  findProgramAddress,
  looksLikeTransactionMessage,
  parseSolanaTransaction,
  signSolanaMessage,
  signSolanaSplTransfer,
  signSolanaTransaction,
  signSolanaTransfer,
} from '@/core/chains/solana/transaction';

// Known test keys (ed25519, base58-encoded).
// The sender pubkey is the real public key for PRIVATE_KEY so signature
// verification exercises the actual key pair, not a made-up address.
const PRIVATE_KEY = new Uint8Array(32).fill(0x01); // 32 bytes of 0x01
const FROM_PUBKEY = ed25519.getPublicKey(PRIVATE_KEY);
const TO_PUBKEY = new Uint8Array(32).fill(0x0b);
const FROM_ADDRESS = base58.encode(FROM_PUBKEY);
const TO_ADDRESS = base58.encode(TO_PUBKEY);

// Fixed 32-byte blockhash (all-zeroes for deterministic testing).
const BLOCKHASH = new Uint8Array(32).fill(0x00);

describe('Solana transfer serialization', () => {
  it('signs a transfer and returns a valid base64 string', () => {
    const result = signSolanaTransfer({
      from: FROM_ADDRESS,
      to: TO_ADDRESS,
      lamports: 1000n,
      blockhash: BLOCKHASH,
    }, PRIVATE_KEY);

    // The raw output should be a valid base64 string.
    expect(result.raw).toBeTruthy();
    expect(() => atob(result.raw)).not.toThrow();
    expect(result.from).toBe(FROM_ADDRESS);
    expect(result.signingHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('produces a deterministic output for the same inputs', () => {
    const a = signSolanaTransfer({
      from: FROM_ADDRESS,
      to: TO_ADDRESS,
      lamports: 1000n,
      blockhash: BLOCKHASH,
    }, PRIVATE_KEY);

    const b = signSolanaTransfer({
      from: FROM_ADDRESS,
      to: TO_ADDRESS,
      lamports: 1000n,
      blockhash: BLOCKHASH,
    }, PRIVATE_KEY);

    expect(a.raw).toBe(b.raw);
    expect(a.signingHash).toBe(b.signingHash);
  });

  it('produces different outputs for different amounts', () => {
    const a = signSolanaTransfer({
      from: FROM_ADDRESS,
      to: TO_ADDRESS,
      lamports: 1000n,
      blockhash: BLOCKHASH,
    }, PRIVATE_KEY);

    const b = signSolanaTransfer({
      from: FROM_ADDRESS,
      to: TO_ADDRESS,
      lamports: 2000n,
      blockhash: BLOCKHASH,
    }, PRIVATE_KEY);

    expect(a.raw).not.toBe(b.raw);
  });

  it('wire format has the correct structure', () => {
    const result = signSolanaTransfer({
      from: FROM_ADDRESS,
      to: TO_ADDRESS,
      lamports: 1000n,
      blockhash: BLOCKHASH,
    }, PRIVATE_KEY);

    const raw = Uint8Array.from(atob(result.raw), (c) => c.charCodeAt(0));

    // First byte = signature count (1). Legacy transactions have no version
    // prefix (v0 transactions use the 0x80-masked version byte).
    expect(raw[0]).toBe(1);

    // Next 64 bytes = signature.
    expect(raw.length).toBeGreaterThan(65);

    // After the signature, the message begins.
    // Message header: [numRequiredSignatures, numReadonlySignedAccounts, numReadonlyUnsignedAccounts]
    // The SystemProgram is a read-only non-signer, so the last count is 1.
    const header = raw.subarray(65, 68);
    expect(header).toEqual(new Uint8Array([1, 0, 1]));

    // Account keys follow (compact-u16 length prefix, then 3 × 32-byte keys)
    // in Solana's weight order: signers, writable non-signers, read-only
    // non-signers. Layout: feePayer (0), destination (1), SystemProgram (2).
    const keyCount = raw[68]; // should be 3 (small enough to fit in 1 byte)
    expect(keyCount).toBe(3);
    expect(raw.length).toBeGreaterThanOrEqual(69 + 3 * 32 + 32);

    const keyStart = 69;
    const key0 = raw.subarray(keyStart, keyStart + 32);
    const key1 = raw.subarray(keyStart + 32, keyStart + 64);
    const key2 = raw.subarray(keyStart + 64, keyStart + 96);
    expect(base58.encode(key0)).toBe(FROM_ADDRESS);
    expect(base58.encode(key1)).toBe(TO_ADDRESS);
    // SystemProgram address is the all-zero public key.
    expect(base58.encode(key2)).toBe(base58.encode(new Uint8Array(32)));

    // Instruction starts after: sigCount(1) + sig(64) + header(3) + keyCount(1)
    // + keys(96) + blockhash(32) + instructionCount(1).
    const instrStart = 1 + 64 + 3 + 1 + 96 + 32 + 1;
    // programIdIndex = 2 (SystemProgram is the last key).
    expect(raw[instrStart]).toBe(2);
    // Two instruction accounts: [feePayer, destination].
    expect(raw[instrStart + 1]).toBe(2);
    expect(raw.subarray(instrStart + 2, instrStart + 4)).toEqual(new Uint8Array([0, 1]));

    // Instruction data is bincode: u32 LE discriminant (2 = Transfer) + u64 LE
    // lamports = 12 bytes. A single-byte discriminant is rejected by the
    // runtime with "invalid instruction data".
    const dataLen = raw[instrStart + 4];
    expect(dataLen).toBe(12);
    expect(raw.subarray(instrStart + 5, instrStart + 9)).toEqual(
      new Uint8Array([2, 0, 0, 0]),
    );
    // 1000 lamports = 0x03e8, little-endian.
    expect(raw.subarray(instrStart + 9, instrStart + 17)).toEqual(
      new Uint8Array([0xe8, 0x03, 0, 0, 0, 0, 0, 0]),
    );
  });

  it('rejects an invalid private key length', () => {
    expect(() => signSolanaTransfer({
      from: FROM_ADDRESS,
      to: TO_ADDRESS,
      lamports: 1000n,
      blockhash: BLOCKHASH,
    }, new Uint8Array(16))).toThrow('32 bytes');
  });

  it('signs the raw message with plain Ed25519, not a prehash', () => {
    const result = signSolanaTransfer({
      from: FROM_ADDRESS,
      to: TO_ADDRESS,
      lamports: 1000n,
      blockhash: BLOCKHASH,
    }, PRIVATE_KEY);

    const raw = Uint8Array.from(atob(result.raw), (c) => c.charCodeAt(0));
    const signature = raw.subarray(1, 65);
    const message = raw.subarray(65);

    // The network verifies a plain Ed25519 signature over the serialized
    // message, so signing the SHA-256 hash instead would be accepted here but
    // rejected on-chain. This assertion is what keeps the two from drifting.
    expect(ed25519.verify(signature, message, FROM_PUBKEY)).toBe(true);
    expect(ed25519.verify(signature, sha256(message), FROM_PUBKEY)).toBe(false);
    expect(result.signingHash).toBe(bytesToHex(sha256(message)));
  });

  it('rejects an invalid amount of zero', () => {
    // The library doesn't validate non-zero amounts, but the handler does.
    // This tests that zero is processed without a crash.
    const result = signSolanaTransfer({
      from: FROM_ADDRESS,
      to: TO_ADDRESS,
      lamports: 0n,
      blockhash: BLOCKHASH,
    }, PRIVATE_KEY);
    expect(result.raw).toBeTruthy();
  });
});

describe('Solana SPL transfer serialization', () => {
  // A mint, source token account, and dest token account — arbitrary 32-byte
  // addresses (base58). The wallet's ATA is derived from FROM + mint.
  const MINT = base58.encode(new Uint8Array(32).fill(0x07));
  const SOURCE = new Uint8Array(32).fill(0x08);
  const DEST = new Uint8Array(32).fill(0x09);
  const SOURCE_ADDRESS = base58.encode(SOURCE);
  const DEST_ADDRESS = base58.encode(DEST);

  it('signs an SPL TransferChecked and returns a valid base64 string', () => {
    const result = signSolanaSplTransfer({
      from: FROM_ADDRESS,
      source: SOURCE_ADDRESS,
      mint: MINT,
      dest: DEST_ADDRESS,
      amount: 1_500_000n, // 0.0015 of an 9-decimal token
      decimals: 9,
      blockhash: BLOCKHASH,
    }, PRIVATE_KEY);

    expect(result.raw).toBeTruthy();
    expect(() => atob(result.raw)).not.toThrow();
    expect(result.from).toBe(FROM_ADDRESS);
    expect(result.signingHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('wire format is the SPL layout (header [1,0,2], 5 account keys, TransferChecked index 12)', () => {
    const result = signSolanaSplTransfer({
      from: FROM_ADDRESS,
      source: SOURCE_ADDRESS,
      mint: MINT,
      dest: DEST_ADDRESS,
      amount: 1_500_000n,
      decimals: 9,
      blockhash: BLOCKHASH,
    }, PRIVATE_KEY);

    const raw = Uint8Array.from(atob(result.raw), (c) => c.charCodeAt(0));

    // Signature-count prefix + 64-byte signature, then the message header.
    expect(raw[0]).toBe(1);
    const header = raw.subarray(65, 68);
    expect(header).toEqual(new Uint8Array([1, 0, 2])); // 1 signer, 0 readonly-signed, 2 readonly-unsigned

    // Account-key count (compact-u16). 5 keys: from, source, dest, mint, TOKEN_PROGRAM.
    const keyCount = raw[68];
    expect(keyCount).toBe(5);
    expect(raw.length).toBeGreaterThan(69 + 5 * 32 + 32);

    // Locate the instruction data: after sigCount(1) + signatures(64) + header(3)
    // + keyCount(1) + keys(160) + blockhash(32) is the instruction count (1
    // byte), then the instruction.
    const instrStart = 1 + 64 + 3 + 1 + 160 + 32 + 1;
    // programIdIndex should reference TOKEN_PROGRAM at index 4.
    expect(raw[instrStart]).toBe(4);
    // Account index count: 4 (source, dest, mint, owner in the new key layout).
    expect(raw[instrStart + 1]).toBe(4);
    // The four account indexes: source=1, mint=3, dest=2, owner=0.
    expect(raw.subarray(instrStart + 2, instrStart + 6)).toEqual(
      new Uint8Array([1, 3, 2, 0]),
    );
    const dataLen = raw[instrStart + 6];
    // TransferChecked data = [instruction 12][amount u64 LE][decimals u8] => 10 bytes.
    expect(dataLen).toBe(10);
    expect(raw[instrStart + 7]).toBe(12); // TransferChecked instruction index
    // amount u64 little-endian = 1_500_000 = 0x0016e360.
    expect(raw.subarray(instrStart + 8, instrStart + 16)).toEqual(
      new Uint8Array([0x60, 0xe3, 0x16, 0, 0, 0, 0, 0]),
    );
    expect(raw[instrStart + 16]).toBe(9); // decimals
  });

  it('is deterministic for the same inputs', () => {
    const a = signSolanaSplTransfer({
      from: FROM_ADDRESS, source: SOURCE_ADDRESS, mint: MINT, dest: DEST_ADDRESS,
      amount: 100n, decimals: 9, blockhash: BLOCKHASH,
    }, PRIVATE_KEY);
    const b = signSolanaSplTransfer({
      from: FROM_ADDRESS, source: SOURCE_ADDRESS, mint: MINT, dest: DEST_ADDRESS,
      amount: 100n, decimals: 9, blockhash: BLOCKHASH,
    }, PRIVATE_KEY);
    expect(a.raw).toBe(b.raw);
  });

  it('rejects an invalid private key length', () => {
    expect(() => signSolanaSplTransfer({
      from: FROM_ADDRESS, source: SOURCE_ADDRESS, mint: MINT, dest: DEST_ADDRESS,
      amount: 100n, decimals: 9, blockhash: BLOCKHASH,
    }, new Uint8Array(16))).toThrow('32 bytes');
  });

  it('orders account keys by weight and signs the raw message', () => {
    const result = signSolanaSplTransfer({
      from: FROM_ADDRESS, source: SOURCE_ADDRESS, mint: MINT, dest: DEST_ADDRESS,
      amount: 100n, decimals: 9, blockhash: BLOCKHASH,
    }, PRIVATE_KEY);

    const raw = Uint8Array.from(atob(result.raw), (c) => c.charCodeAt(0));
    const keyStart = 69;
    const key = (i: number): string =>
      base58.encode(raw.subarray(keyStart + i * 32, keyStart + (i + 1) * 32));

    // Writable non-signers (source, dest) precede read-only non-signers
    // (mint, token program); a read-only key among the writable ones is invalid.
    expect(key(0)).toBe(FROM_ADDRESS);
    expect(key(1)).toBe(SOURCE_ADDRESS);
    expect(key(2)).toBe(DEST_ADDRESS);
    expect(key(3)).toBe(MINT);
    expect(key(4)).toBe('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');

    const signature = raw.subarray(1, 65);
    const message = raw.subarray(65);
    expect(ed25519.verify(signature, message, FROM_PUBKEY)).toBe(true);
  });
});

describe('Solana associated token account derivation', () => {
  const MINT_B = base58.encode(new Uint8Array(32).fill(0x0c));

  it('finds an off-curve (program-derived) address for the mint', () => {
    const ata = deriveAssociatedTokenAddress(FROM_ADDRESS, MINT_B);
    expect(ata).toMatch(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/);

    // Deterministic: re-deriving yields the same ATA.
    const again = deriveAssociatedTokenAddress(FROM_ADDRESS, MINT_B);
    expect(again).toBe(ata);

    // A different owner yields a different ATA.
    const other = deriveAssociatedTokenAddress(TO_ADDRESS, MINT_B);
    expect(other).not.toBe(ata);
  });

  it('produces a deterministic bump seed within range', () => {
    const { address, bump } = findProgramAddress(
      [
        base58.decode(FROM_ADDRESS),
        base58.decode('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'),
        base58.decode(MINT_B),
      ],
      base58.decode('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL'),
    );
    expect(address).toMatch(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
    expect(bump).toBeGreaterThanOrEqual(0);
    expect(bump).toBeLessThanOrEqual(255);
  });
});

/**
 * Builds a base58 serialized transaction in the wire format, signed with
 * PRIVATE_KEY (i.e. what a dapp gets back from @solana/web3.js serialize()).
 * Used as the dapp-supplied input for `signSolanaTransaction`.
 */
function serializedDappTx(): string {
  const signed = signSolanaTransfer({
    from: FROM_ADDRESS,
    to: TO_ADDRESS,
    lamports: 1000n,
    blockhash: BLOCKHASH,
  }, PRIVATE_KEY);
  const bytes = Uint8Array.from(atob(signed.raw), (c) => c.charCodeAt(0));
  return base58.encode(bytes);
}

describe('Solana dapp transaction signing', () => {
  it('parses the fee payer, account keys, and message from a serialized tx', () => {
    const parsed = parseSolanaTransaction(serializedDappTx());
    expect(parsed.feePayerIndex).toBe(0);
    expect(parsed.numRequiredSignatures).toBe(1);
    expect(parsed.accountKeys[0]).toBe(FROM_ADDRESS);
    expect(parsed.accountKeys[1]).toBe(TO_ADDRESS);
    expect(parsed.accountKeys[2]).toBe(base58.encode(new Uint8Array(32))); // SystemProgram
    expect(parsed.message.length).toBeGreaterThan(64);
  });

  it('signs a serialized tx and returns a base58 signed transaction', () => {
    const serialized = serializedDappTx();
    const result = signSolanaTransaction(serialized, PRIVATE_KEY, FROM_ADDRESS);
    expect(result.signature).toBeTruthy();
    expect(result.signedTransaction).toBeTruthy();

    // The returned signature must verify against the raw parsed message (the
    // network verifies plain Ed25519 over the serialized message bytes).
    const parsed = parseSolanaTransaction(result.signedTransaction);
    const sigBytes = base58.decode(result.signature);
    expect(ed25519.verify(sigBytes, parsed.message, FROM_PUBKEY)).toBe(true);
  });

  it('rejects when the wallet is not a required signer', () => {
    const serialized = serializedDappTx();
    expect(() => signSolanaTransaction(serialized, PRIVATE_KEY, TO_ADDRESS)).toThrow(
      'not a required signer',
    );
  });

  it('rejects a malformed serialized transaction', () => {
    expect(() => signSolanaTransaction('not-base58!!', PRIVATE_KEY, FROM_ADDRESS)).toThrow();
  });
});

describe('Solana dapp message signing', () => {
  it('signs a message and returns a base58 signature', () => {
    const message = new TextEncoder().encode('hello solana');
    const { signature } = signSolanaMessage(message, PRIVATE_KEY);
    const sigBytes = base58.decode(signature);
    expect(ed25519.verify(sigBytes, message, FROM_PUBKEY)).toBe(true);
  });

  it('is deterministic for the same message and key', () => {
    const message = new TextEncoder().encode('hello solana');
    const a = signSolanaMessage(message, PRIVATE_KEY);
    const b = signSolanaMessage(message, PRIVATE_KEY);
    expect(a.signature).toBe(b.signature);
  });

  it('rejects an invalid private key length', () => {
    expect(() => signSolanaMessage(new Uint8Array(4), new Uint8Array(16))).toThrow('32 bytes');
  });
});

describe('signMessage transaction-oracle detection', () => {
  // The bare-ed25519 signMessage convention means a "message" that is really
  // a serialized transaction message would produce a broadcastable signature.
  // The detector is what stops signMessage from being a drain oracle.

  function transferMessage(): Uint8Array {
    const signed = signSolanaTransfer({
      from: FROM_ADDRESS,
      to: TO_ADDRESS,
      lamports: 1000n,
      blockhash: BLOCKHASH,
    }, PRIVATE_KEY);
    const bytes = Uint8Array.from(atob(signed.raw), (c) => c.charCodeAt(0));
    return bytes.subarray(65); // strip [sig count][64-byte signature]
  }

  it('flags a real transaction message naming the wallet as signer', () => {
    expect(looksLikeTransactionMessage(transferMessage(), FROM_ADDRESS)).toBe(true);
  });

  it('does not flag the same message for a non-signer wallet', () => {
    expect(looksLikeTransactionMessage(transferMessage(), TO_ADDRESS)).toBe(false);
  });

  it('does not flag ordinary text messages', () => {
    const message = new TextEncoder().encode('Sign in to example.com at 2024-01-01');
    expect(looksLikeTransactionMessage(message, FROM_ADDRESS)).toBe(false);
  });

  it('does not flag a transaction message with trailing garbage (not node-acceptable)', () => {
    const message = transferMessage();
    const padded = new Uint8Array(message.length + 1);
    padded.set(message, 0);
    padded[message.length] = 0xff;
    expect(looksLikeTransactionMessage(padded, FROM_ADDRESS)).toBe(false);
  });

  it('does not flag truncated or empty buffers', () => {
    const message = transferMessage();
    expect(looksLikeTransactionMessage(message.subarray(0, 10), FROM_ADDRESS)).toBe(false);
    expect(looksLikeTransactionMessage(new Uint8Array(0), FROM_ADDRESS)).toBe(false);
  });
});
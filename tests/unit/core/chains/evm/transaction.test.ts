import { describe, expect, it } from 'vitest';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils';
import { keccak_256 } from '@noble/hashes/sha3';
import { secp256k1 } from '@noble/curves/secp256k1';
import { encodeList, type RlpItem } from '@/core/chains/evm/rlp';
import {
  EVM_CHAIN_ID,
  signPersonalMessage,
  signTransaction,
  type UnsignedEvmTransaction,
} from '@/core/chains/evm/transaction';

/**
 * Known-vector tests for EIP-1559 signing.
 *
 * The anchor is the hardhat default account #0 — a widely published
 * key/address pair — so "the signer is who we think it is" is checked against
 * an external fact rather than against our own derivation:
 *
 *   private key : 0xac0974...f2ff80
 *   address     : 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266
 *
 * The RLP serialization vector is derived from the yellow-paper encoding rules
 * but verified against the actual production code's output. The signature
 * verification (recovery) is independent of both the RLP encoding and the
 * signing code — it uses @noble/curves directly.
 */

const HARDHAT_KEY = hexToBytes(
  'ac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
);
const HARDHAT_ADDRESS = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';

const TX: UnsignedEvmTransaction = {
  chainId: 11155111, // Sepolia
  nonce: 0n,
  maxPriorityFeePerGas: 1_000_000_000n,
  maxFeePerGas: 30_000_000_000n,
  gasLimit: 21_000n,
  to: '0x1111111111111111111111111111111111111111',
  value: 1_000_000_000_000_000_000n, // 1 ETH
};

describe('EIP-1559 transaction signing', () => {
  it('signs to the known external address (hardhat account #0)', () => {
    const signed = signTransaction(TX, HARDHAT_KEY);
    expect(signed.from).toBe(HARDHAT_ADDRESS);
  });

  it('is deterministic: same inputs produce the same signed transaction', () => {
    const a = signTransaction(TX, HARDHAT_KEY);
    const b = signTransaction(TX, HARDHAT_KEY);
    expect(a.raw).toBe(b.raw);
    expect(a.signingHash).toBe(b.signingHash);
  });

  it('signature is cryptographically valid (independent secp256k1.verify)', () => {
    const signed = signTransaction(TX, HARDHAT_KEY);
    const digest = hexToBytes(signed.signingHash);

    const { r, s } = extractSignature(signed.raw.replace(/^0x/, ''));
    const publicKey = secp256k1.getPublicKey(HARDHAT_KEY, true);

    const sig = new secp256k1.Signature(r, s);
    expect(secp256k1.verify(sig, digest, publicKey)).toBe(true);
  });

  it('produces a transaction a real node accepts (spec sighash → ecrecover → signer)', () => {
    // The definitive non-circular check: decode the broadcast envelope, rebuild
    // the signing preimage EXACTLY as a node does (0x02 || rlp(first 9 fields),
    // no signature fields), recover the signer from yParity/r/s, and compare to
    // the externally-known address. The old code hashed 12 fields (three zeroed
    // signature slots appended); this test fails against that preimage because
    // recovery over the wrong digest yields a different address.
    const signed = signTransaction(TX, HARDHAT_KEY);
    const bytes = hexToBytes(signed.raw.replace(/^0x/, ''));
    const envelope = decodeRlpItem(bytes, 1);
    if (!Array.isArray(envelope.item)) throw new Error('Envelope must be an RLP list.');
    const fields = envelope.item;
    expect(fields).toHaveLength(12); // 9 unsigned fields + yParity + r + s

    const digest = keccak_256(
      new Uint8Array([0x02, ...encodeList(fields.slice(0, 9))]),
    );
    // A node's sighash must equal the digest the signer used.
    expect(bytesToHex(digest)).toBe(signed.signingHash);

    const yParity = bigintOf(fields[9]!);
    const r = bigintOf(fields[10]!);
    const s = bigintOf(fields[11]!);
    const sig = new secp256k1.Signature(r, s).addRecoveryBit(Number(yParity));
    const recovered = sig.recoverPublicKey(digest);
    const addressBytes = keccak_256(recovered.toRawBytes(false).slice(1)).slice(-20);
    expect(`0x${bytesToHex(addressBytes)}`).toBe(HARDHAT_ADDRESS.toLowerCase());
  });

  it('rejects a malformed private key', () => {
    expect(() => signTransaction(TX, new Uint8Array(31))).toThrow(/32 bytes/);
  });

  it('exports the Sepolia chain id used across the transfer path', () => {
    expect(EVM_CHAIN_ID).toBe(11155111);
  });

  it('broadcast hex is a well-formed 0x02 type-2 envelope', () => {
    const signed = signTransaction(TX, HARDHAT_KEY);
    expect(signed.raw.startsWith('0x02')).toBe(true);
    expect(signed.raw).toMatch(/^0x[0-9a-f]+$/);
    expect(signed.raw.length).toBeGreaterThan(200);
  });

  it('includes calldata in the envelope when provided', () => {
    const data = hexToBytes('1234567890abcdef');
    const withData = signTransaction({ ...TX, data }, HARDHAT_KEY);
    const withoutData = signTransaction(TX, HARDHAT_KEY);
    // The data field is RLP-encoded between value and the access list, so the
    // signed raw tx must differ when calldata is present.
    expect(withData.raw).not.toBe(withoutData.raw);
    expect(withData.from).toBe(HARDHAT_ADDRESS);
  });
});

describe('personal_sign (EIP-191)', () => {
  it('signs to the known external address', () => {
    const { from } = signPersonalMessage(new TextEncoder().encode('hello'), HARDHAT_KEY);
    expect(from).toBe(HARDHAT_ADDRESS);
  });

  it('returns a well-formed 65-byte r||s||v signature with v ∈ {27, 28}', () => {
    const { signature } = signPersonalMessage(new TextEncoder().encode('hello'), HARDHAT_KEY);
    expect(signature.startsWith('0x')).toBe(true);
    expect(signature.length).toBe(2 + 65 * 2); // 65 bytes = r(32) + s(32) + v(1)
    const v = Number.parseInt(signature.slice(-2), 16);
    expect(v === 27 || v === 28).toBe(true);
  });

  it('is deterministic: same message produces the same signature', () => {
    const a = signPersonalMessage(new TextEncoder().encode('hello'), HARDHAT_KEY);
    const b = signPersonalMessage(new TextEncoder().encode('hello'), HARDHAT_KEY);
    expect(a.signature).toBe(b.signature);
  });

  it('signature verifies against the signer key (independent secp256k1.verify)', () => {
    const message = new TextEncoder().encode('Veilpay test message');
    const { signature, from } = signPersonalMessage(message, HARDHAT_KEY);
    expect(from).toBe(HARDHAT_ADDRESS);

    // EIP-191 digest: keccak256("\x19Ethereum Signed Message:\n" + len + msg).
    const prefix = `\x19Ethereum Signed Message:\n${message.length}`;
    const encodedPrefix = new TextEncoder().encode(prefix);
    const digestInput = new Uint8Array(encodedPrefix.length + message.length);
    digestInput.set(encodedPrefix, 0);
    digestInput.set(message, encodedPrefix.length);
    const digest = keccak_256(digestInput);

    const r = hexToBytes(signature.slice(2, 66));
    const s = hexToBytes(signature.slice(66, 130));
    const sig = secp256k1.Signature.fromCompact(new Uint8Array([...r, ...s]));
    const publicKey = secp256k1.getPublicKey(HARDHAT_KEY, true);
    expect(secp256k1.verify(sig, digest, publicKey)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Minimal RLP decoder for the round-trip node-verification tests. The encoder
// under test is trusted (independently verified); what these tests exercise
// is FIELD SELECTION — which items make up the signing preimage — and that a
// node recovering over the spec digest gets the intended signer back.
// ---------------------------------------------------------------------------

function decodeRlpItem(
  data: Uint8Array,
  offset: number,
): { item: RlpItem; next: number } {
  const prefix = data[offset];
  if (prefix === undefined) throw new Error('RLP: unexpected end of input.');

  if (prefix < 0x80) {
    return { item: data.subarray(offset, offset + 1), next: offset + 1 };
  }
  if (prefix <= 0xb7) {
    const len = prefix - 0x80;
    return { item: data.subarray(offset + 1, offset + 1 + len), next: offset + 1 + len };
  }
  if (prefix <= 0xbf) {
    const lenLen = prefix - 0xb7;
    let len = 0;
    for (let j = 0; j < lenLen; j += 1) len = (len << 8) | (data[offset + 1 + j] ?? 0);
    return {
      item: data.subarray(offset + 1 + lenLen, offset + 1 + lenLen + len),
      next: offset + 1 + lenLen + len,
    };
  }

  // Lists: 0xc0–0xf7 short, 0xf8+ long.
  let payloadStart: number;
  let payloadLen: number;
  if (prefix <= 0xf7) {
    payloadLen = prefix - 0xc0;
    payloadStart = offset + 1;
  } else {
    const lenLen = prefix - 0xf7;
    payloadLen = 0;
    for (let j = 0; j < lenLen; j += 1) payloadLen = (payloadLen << 8) | (data[offset + 1 + j] ?? 0);
    payloadStart = offset + 1 + lenLen;
  }
  const items: RlpItem[] = [];
  let cursor = payloadStart;
  const end = payloadStart + payloadLen;
  while (cursor < end) {
    const decoded = decodeRlpItem(data, cursor);
    items.push(decoded.item);
    cursor = decoded.next;
  }
  return { item: items, next: end };
}

function bigintOf(item: RlpItem): bigint {
  if (Array.isArray(item)) throw new Error('RLP: expected a byte string, got a list.');
  let value = 0n;
  for (const byte of item) value = (value << 8n) | BigInt(byte);
  return value;
}

/** Decodes a signed 0x02 envelope and returns its signature triplet. */
function extractSignature(rawHex: string): { yParity: bigint; r: bigint; s: bigint } {
  const bytes = hexToBytes(rawHex);
  const envelope = decodeRlpItem(bytes, 1);
  if (!Array.isArray(envelope.item) || envelope.item.length !== 12) {
    throw new Error('Expected a 12-field EIP-1559 envelope.');
  }
  return {
    yParity: bigintOf(envelope.item[9]!),
    r: bigintOf(envelope.item[10]!),
    s: bigintOf(envelope.item[11]!),
  };
}
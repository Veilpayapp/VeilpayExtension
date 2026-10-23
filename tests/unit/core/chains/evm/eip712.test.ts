import { describe, expect, it } from 'vitest';
import { bytesToHex } from '@noble/hashes/utils';
import { keccak_256 } from '@noble/hashes/sha3';
import { secp256k1 } from '@noble/curves/secp256k1';
import { hashTypedData, signTypedData } from '@/core/chains/evm/eip712';

/**
 * Canonical example from EIP-712. The digest below is the one published in the
 * spec, so this pins the whole pipeline (type encoding, domain separator,
 * struct hashing) against a known answer rather than our own output.
 */
const MAIL = {
  types: {
    Person: [
      { name: 'name', type: 'string' },
      { name: 'wallet', type: 'address' },
    ],
    Mail: [
      { name: 'from', type: 'Person' },
      { name: 'to', type: 'Person' },
      { name: 'contents', type: 'string' },
    ],
  },
  primaryType: 'Mail',
  domain: {
    name: 'Ether Mail',
    version: '1',
    chainId: 1,
    verifyingContract: '0xCcCCccccCCCCcCCCCCCcCcCccCcCCCcCcccccccC',
  },
  message: {
    from: { name: 'Cow', wallet: '0xCD2a3d9F938E13CD947Ec05AbC7FE734Df8DD826' },
    to: { name: 'Bob', wallet: '0xbBbBBBBbbBBBbbbBbbBbbbbBBbBbbbbBbBbbBBbB' },
    contents: 'Hello, Bob!',
  },
};

/** Hardhat account #0 — the key used in the EIP-712 spec appendix. */
const PRIVATE_KEY = hexToBytes(
  'ac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
);
const SIGNER = '0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266';

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i += 1) {
    out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

describe('EIP-712 typed data', () => {
  it('hashes the spec example to the published digest', () => {
    expect(bytesToHex(hashTypedData(MAIL))).toBe(
      'be609aee343fb3c4b28e1df9e632fca64fcfaede20f02e86244efddf30957bd2',
    );
  });

  it('derives the EIP712Domain type from the fields the dapp supplied', () => {
    // Omitting chainId / verifyingContract must change the separator, exactly
    // as a contract that defines a shorter domain would expect.
    const withoutChainId = {
      ...MAIL,
      domain: { name: 'Ether Mail', version: '1' },
    };
    expect(bytesToHex(hashTypedData(withoutChainId))).not.toBe(
      bytesToHex(hashTypedData(MAIL)),
    );
  });

  it('signs typed data that recovers to the signer address', () => {
    const { signature, from, digest } = signTypedData(MAIL, PRIVATE_KEY);

    expect(signature).toMatch(/^0x[0-9a-fA-F]{130}$/);
    // `from` is EIP-55 checksummed, so compare case-insensitively.
    expect(from.toLowerCase()).toBe(SIGNER);
    expect(digest).toBe(
      '0xbe609aee343fb3c4b28e1df9e632fca64fcfaede20f02e86244efddf30957bd2',
    );

    const v = Number.parseInt(signature.slice(130, 132), 16);
    expect([27, 28]).toContain(v);

    const compact = hexToBytes(signature.slice(2, 130));
    const recovered = secp256k1.Signature.fromCompact(compact)
      .addRecoveryBit(v - 27)
      .recoverPublicKey(hexToBytes(digest.slice(2)));

    const address = `0x${bytesToHex(keccak_256(recovered.toRawBytes(false).slice(1))).slice(-40)}`;
    expect(address.toLowerCase()).toBe(SIGNER);
  });

  it('rejects an unknown primary type', () => {
    expect(() => hashTypedData({ ...MAIL, primaryType: 'Nope' })).toThrow(/unknown type/);
  });

  it('encodes a bytes32 domain salt RAW (left-aligned), not keccak-hashed', () => {
    // Independent spec reconstruction: for a domain of { name, salt }, the
    // separator is keccak256(typeHash || keccak256(name) || saltRaw32). The
    // buggy behavior hashed the salt; this manual build does not.
    const salt = `0x${'aa'.repeat(32)}`;
    const data = {
      types: {
        Mail: [{ name: 'contents', type: 'string' }],
      },
      primaryType: 'Mail',
      domain: { name: 'X', salt },
      message: { contents: 'hi' },
    };

    const typeHash = keccak_256(new TextEncoder().encode('EIP712Domain(string name,bytes32 salt)'));
    const nameHash = keccak_256(new TextEncoder().encode('X'));
    const saltRaw = hexToBytes(salt.slice(2));
    const manualSeparator = keccak_256(
      new Uint8Array([...typeHash, ...nameHash, ...saltRaw]),
    );

    // Library path: hashStruct('EIP712Domain', …) is internal, so compare full
    // digests — rebuild the full digest with the manual separator and the
    // library's message struct hash via a second call... Instead, assert the
    // separator indirectly: a salt change must change the digest, and the
    // digest must equal the manual two-stage reconstruction.
    const messageTypeHash = keccak_256(new TextEncoder().encode('Mail(string contents)'));
    const contentsHash = keccak_256(new TextEncoder().encode('hi'));
    const manualMessageHash = keccak_256(
      new Uint8Array([...messageTypeHash, ...contentsHash]),
    );
    const manualDigest = keccak_256(
      new Uint8Array([0x19, 0x01, ...manualSeparator, ...manualMessageHash]),
    );

    expect(bytesToHex(hashTypedData(data))).toBe(bytesToHex(manualDigest));
  });

  it('changes the digest when the salt changes', () => {
    const base = {
      types: { Mail: [{ name: 'contents', type: 'string' }] },
      primaryType: 'Mail',
      domain: { salt: `0x${'aa'.repeat(32)}` },
      message: { contents: 'hi' },
    };
    const other = {
      ...base,
      domain: { salt: `0x${'bb'.repeat(32)}` },
    };
    expect(bytesToHex(hashTypedData(base))).not.toBe(bytesToHex(hashTypedData(other)));
  });

  it('rejects a bytes32 field whose value is not exactly 32 bytes', () => {
    const data = {
      types: { Mail: [{ name: 'contents', type: 'string' }] },
      primaryType: 'Mail',
      domain: { salt: '0x1234' },
      message: { contents: 'hi' },
    };
    expect(() => hashTypedData(data)).toThrow(/exactly 32 bytes/);
  });

  it('rejects a message missing a declared field instead of encoding a zero', () => {
    const data = {
      types: {
        Mail: [
          { name: 'contents', type: 'string' },
          { name: 'flag', type: 'bool' },
        ],
      },
      primaryType: 'Mail',
      domain: { name: 'X' },
      message: { contents: 'hi' }, // flag omitted
    };
    expect(() => hashTypedData(data)).toThrow(/missing field "flag"/);
  });

  it('rejects out-of-range integer widths (uint8: 300)', () => {
    const data = {
      types: { Mail: [{ name: 'count', type: 'uint8' }] },
      primaryType: 'Mail',
      domain: { name: 'X' },
      message: { count: 300 },
    };
    expect(() => hashTypedData(data)).toThrow(/out of range/);
  });
});

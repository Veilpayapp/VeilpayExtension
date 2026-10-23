import { keccak_256 } from '@noble/hashes/sha3';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils';
import { secp256k1 } from '@noble/curves/secp256k1';
import { encodeInteger, encodeList, type RlpItem } from './rlp';

/**
 * EIP-1559 (type 0x02) transaction construction and signing.
 *
 * A 1559 transaction is a typed envelope: the byte `0x02`, then the RLP list
 *
 *   [chainId, nonce, maxPriorityFeePerGas, maxFeePerGas, gasLimit, to, value,
 *    data, accessList, yParity, r, s]
 *
 * To sign, the NINE unsigned fields alone are hashed:
 * keccak-256(0x02 || rlp([chainId, nonce, maxPriorityFeePerGas, maxFeePerGas,
 * gasLimit, to, value, data, accessList])) — the signature fields are NOT
 * part of the digest at all (that zeroed-signature-fields pattern is EIP-155
 * legacy transactions; applying it to a type-2 envelope yields a digest no
 * node accepts, so every such transaction is rejected as an invalid sender).
 * The resulting `r`, `s`, and `yParity` (recovery parity) are then appended
 * to form the full 12-field broadcast envelope.
 *
 * Everything here is pure: it takes the unsigned fields and a raw private key,
 * and returns the signed, broadcast-ready hex string. It never touches storage,
 * the vault, or the network. The caller (the background worker) is responsible
 * for scoping the private key's lifetime to this call.
 *
 * `data` is optional and empty for a plain value transfer. A contract
 * interaction (token transfer, dapp call) passes the hex calldata through.
 */

/** Sepolia, the only EVM testnet this build ships. */
export const EVM_CHAIN_ID = 11155111;

export interface UnsignedEvmTransaction {
  chainId: number;
  /** Sender nonce, from `eth_getTransactionCount`. */
  nonce: bigint;
  /** EIP-1559 tip to the validator, in wei. */
  maxPriorityFeePerGas: bigint;
  /** Absolute per-gas cap (base + tip), in wei. */
  maxFeePerGas: bigint;
  /** Gas the transaction may consume. */
  gasLimit: bigint;
  /** Recipient. Checksummed; validated by the caller. */
  to: string;
  /** Native value to send, in wei. */
  value: bigint;
  /** Contract calldata. Empty (default) for a plain value transfer. */
  data?: Uint8Array;
}

/** A fully signed, broadcast-ready serialized EIP-1559 transaction (0x02…). */
export interface SignedEvmTransaction {
  /** The exact hex string to pass to `eth_sendRawTransaction`. */
  raw: string;
  /** The message digest that was signed, for diagnostics and verification. */
  signingHash: string;
  /** Recovered sender's EVM address (EIP-55 checksummed). */
  from: string;
}

function bytesFromHexStrict(hex: string): Uint8Array {
  const clean = hex.replace(/^0x/, '');
  if (clean.length % 2 !== 0) {
    throw new Error(`Odd-length hex string: ${hex}`);
  }
  return hexToBytes(clean);
}

/** The RLP item for the recipient: 20 bytes, or empty for a contract deploy. */
function toItem(address: string): RlpItem {
  const bytes = bytesFromHexStrict(address);
  if (bytes.length !== 20) {
    throw new Error(`EVM address must be 20 bytes, got ${bytes.length}.`);
  }
  return bytes;
}

function accessListItem(): RlpItem {
  // No access list for plain transfers; encodes as the empty list.
  return [];
}

/**
 * Builds the RLP payload for a signed or unsigned 1559 transaction.
 *
 * When `signature` is omitted the payload is exactly the NINE unsigned fields
 * — that list, type-prefixed and hashed, IS the EIP-1559 signing digest, and
 * it must match byte-for-byte what a node re-derives from the broadcast
 * envelope's first nine fields. When `signature` is provided, yParity/r/s are
 * appended to form the 12-field broadcast envelope.
 */
function serializeEnvelope(
  tx: UnsignedEvmTransaction,
  signature?: { yParity: number; r: bigint; s: bigint },
): Uint8Array {
  const fields: RlpItem[] = [
    encodeInteger(BigInt(tx.chainId)),
    encodeInteger(tx.nonce),
    encodeInteger(tx.maxPriorityFeePerGas),
    encodeInteger(tx.maxFeePerGas),
    encodeInteger(tx.gasLimit),
    toItem(tx.to),
    encodeInteger(tx.value),
    tx.data ?? new Uint8Array(0),
    accessListItem(),
  ];

  if (signature !== undefined) {
    fields.push(
      encodeInteger(BigInt(signature.yParity)),
      encodeInteger(signature.r),
      encodeInteger(signature.s),
    );
  }

  // The 0x02 type byte prefixes the RLP list of the payload.
  const payload = encodeList(fields);
  const envelope = new Uint8Array(1 + payload.length);
  envelope[0] = 0x02;
  envelope.set(payload, 1);
  return envelope;
}

/**
 * Computes the message digest to sign: keccak-256 of the unsigned envelope.
 *
 * Exported so tests can assert against the published EIP-1559 example vector.
 */
export function signingDigest(tx: UnsignedEvmTransaction): Uint8Array {
  return keccak_256(serializeEnvelope(tx));
}

/**
 * Signs an unsigned transaction with a raw 32-byte secp256k1 private key and
 * returns the full signed raw transaction plus the derived sender address.
 *
 * The caller (background handler) compares the returned `from` against the
 * address it derived via `vault.withAccount`, which is an independent check that
 * the intended key signed the intended payload.
 */
export function signTransaction(
  tx: UnsignedEvmTransaction,
  privateKey: Uint8Array,
): SignedEvmTransaction {
  if (privateKey.length !== 32) {
    throw new Error(`Private key must be 32 bytes, got ${privateKey.length}.`);
  }

  const digest = signingDigest(tx);

  // noble normalizes to low-s by default and its `.recovery` bit is already
  // consistent with the returned `s`, so it can be used directly as yParity.
  const signature = secp256k1.sign(digest, privateKey);
  const { r, s } = signature;
  const yParity = signature.recovery;

  const signed = serializeEnvelope(tx, { yParity, r, s });

  return {
    raw: `0x${bytesToHex(signed)}`,
    signingHash: bytesToHex(digest),
    from: deriveAddress(privateKey),
  };
}

/**
 * Derives the EIP-55 checksummed address from a raw private key.
 *
 * This mirrors `key-derivation.ts`'s `evmAddressFrom` but on bytes we already
 * hold here, so `signTransaction` can independently confirm the signer without
 * importing a cross-module dependency into the hot path.
 */
function deriveAddress(privateKey: Uint8Array): string {
  const publicKey = secp256k1.getPublicKey(privateKey, false);
  const hashed = keccak_256(publicKey.slice(1));
  return toChecksumAddress(hashed.slice(-20));
}

function toChecksumAddress(lowercaseHex20: Uint8Array): string {
  const body = bytesToHex(lowercaseHex20).toLowerCase();
  const hash = bytesToHex(keccak_256(new TextEncoder().encode(body)));
  let out = '0x';
  for (let i = 0; i < body.length; i += 1) {
    const nibble = Number.parseInt(hash.charAt(i), 16);
    const char = body.charAt(i);
    out += nibble >= 8 ? char.toUpperCase() : char;
  }
  return out;
}

/**
 * EIP-191 personal_sign signature.
 *
 * The message is prefixed `"\x19Ethereum Signed Message:\n" + len(message)`,
 * hashed with keccak-256, and signed with secp256k1. The wallet returns the
 * compact signature `r || s || v` where `v` is 27 or 28 (Ethereum's
 * convention), matching what MetaMask and other wallets return for
 * `personal_sign`.
 */
export function signPersonalMessage(
  message: Uint8Array,
  privateKey: Uint8Array,
): { signature: string; from: string } {
  if (privateKey.length !== 32) {
    throw new Error(`Private key must be 32 bytes, got ${privateKey.length}.`);
  }

  const prefix = `\x19Ethereum Signed Message:\n${message.length}`;
  const encoded = new TextEncoder().encode(prefix);
  const digest = keccak_256(
    (() => {
      const out = new Uint8Array(encoded.length + message.length);
      out.set(encoded, 0);
      out.set(message, encoded.length);
      return out;
    })(),
  );

  const signature = secp256k1.sign(digest, privateKey);
  const { r, s } = signature;
  // `recovery` is 0 or 1; Ethereum's personal_sign `v` is 27 or 28.
  const v = signature.recovery + 27;

  const rHex = r.toString(16).padStart(64, '0');
  const sHex = s.toString(16).padStart(64, '0');
  const vHex = v.toString(16).padStart(2, '0');

  return {
    signature: `0x${rHex}${sHex}${vHex}`,
    from: deriveAddress(privateKey),
  };
}

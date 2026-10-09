import { keccak_256 } from '@noble/hashes/sha3';
import { bytesToHex } from '@noble/hashes/utils';

/**
 * Minimal ERC-20 encoding/decoding — enough to read `decimals()`/`balanceOf()`
 * over `eth_call` and to build `transfer(address,uint256)` calldata. No ABI
 * codec is needed: every selector is fixed-width right-aligned 32-byte words
 * (uint256/address), so we hand-encode and hand-decode.
 *
 * Everything here is pure. The call itself is issued by `EvmService` via its
 * JSON-RPC `call` helper.
 */

/** First 4 bytes of keccak-256 of a function signature, e.g. "decimals()". */
function selector(sig: string): Uint8Array {
  return keccak_256(new TextEncoder().encode(sig)).slice(0, 4);
}

/** Encode a bigint as a 32-byte big-endian word. */
function encodeUint256(value: bigint): Uint8Array {
  const out = new Uint8Array(32);
  let v = value;
  for (let i = 31; i >= 0; i -= 1) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  if (v !== 0n) {
    throw new Error(`Value exceeds uint256: ${value}`);
  }
  return out;
}

/** Encode an EVM address (0x hex) as a left-padded 32-byte word. */
function encodeAddress(address: string): Uint8Array {
  const clean = address.replace(/^0x/, '');
  if (!/^[0-9a-fA-F]{40}$/.test(clean)) {
    throw new Error(`Invalid EVM address: ${address}`);
  }
  const out = new Uint8Array(32);
  for (let i = 0; i < 20; i += 1) {
    out[12 + i] = Number.parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

/**
 * Decodes the return value of a `decimals()` call: a single uint8 stored as a
 * right-aligned 32-byte word. Throws if it is out of a sane token-decimals
 * range (ERC-20 allows 0..255, but 0/over-18 are unusual — we keep a guard).
 */
export function decodeDecimals(hex: string): number {
  const value = decodeUint256(hex);
  if (value > 255n) {
    throw new Error(`ERC-20 decimals() out of range: ${value}`);
  }
  return Number(value);
}

/** Decodes the return value of a `balanceOf()` call: a uint256. */
export function decodeUint256(hex: string): bigint {
  const clean = hex.replace(/^0x/, '');
  // Reject a hex that isn't a full word boundary or is malformed.
  if (clean.length === 0 || clean.length % 2 !== 0 || !/^[0-9a-fA-F]+$/.test(clean)) {
    throw new Error(`Invalid eth_call result: ${hex}`);
  }
  let value = 0n;
  for (let i = 0; i < clean.length; i += 1) {
    value = (value << 4n) | BigInt(Number.parseInt(clean[i]!, 16));
  }
  return value;
}

/** Calldata for `decimals()`: just the 4-byte selector. */
export const erc20DecimalsCalldata = (): string => `0x${bytesToHex(selector('decimals()'))}`;

/** Calldata for `symbol()`: just the 4-byte selector. */
export const erc20SymbolCalldata = (): string => `0x${bytesToHex(selector('symbol()'))}`;

/** Calldata for `name()`: just the 4-byte selector. */
export const erc20NameCalldata = (): string => `0x${bytesToHex(selector('name()'))}`;

/** Calldata for `balanceOf(address)`: selector + padded owner. */
export function erc20BalanceOfCalldata(owner: string): string {
  const body = selector('balanceOf(address)');
  const calldata = new Uint8Array(4 + 32);
  calldata.set(body);
  calldata.set(encodeAddress(owner), 4);
  return `0x${bytesToHex(calldata)}`;
}

/** Calldata for `transfer(address,uint256)`: selector + to + amount. */
export function erc20TransferCalldata(to: string, amount: bigint): Uint8Array {
  const body = selector('transfer(address,uint256)');
  const calldata = new Uint8Array(4 + 32 + 32);
  calldata.set(body);
  calldata.set(encodeAddress(to), 4);
  calldata.set(encodeUint256(amount), 36);
  return calldata;
}

/** Decodes a big-endian uint256 from raw bytes (an ABI word). */
function decodeUint256Word(bytes: Uint8Array): bigint {
  let value = 0n;
  for (const byte of bytes) value = (value << 8n) | BigInt(byte);
  return value;
}

/**
 * Decodes an ABI-encoded `string` return value (`symbol()` / `name()`).
 *
 * Layout: `offset` word (always 32 — the string data starts right after it),
 * a `length` word, then the UTF-8 bytes padded to a 32-byte boundary. Some
 * nodes return non-standard tokens whose symbol is `bytes32` instead; that
 * fails the offset check and is surfaced as an error the caller can fall
 * back from.
 */
export function decodeAbiString(hex: string): string {
  const clean = hex.replace(/^0x/, '');
  if (clean.length === 0 || clean.length % 2 !== 0 || !/^[0-9a-fA-F]+$/.test(clean)) {
    throw new Error(`Invalid eth_call string result: ${hex}`);
  }
  const bytes = new Uint8Array(clean.length / 2);
  for (let i = 0; i < bytes.length; i += 1) {
    bytes[i] = Number.parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  if (bytes.length < 64) {
    throw new Error(`ABI string return is shorter than two words: ${hex}`);
  }
  const offset = decodeUint256Word(bytes.subarray(0, 32));
  const length = decodeUint256Word(bytes.subarray(32, 64));
  if (offset !== 32n) {
    throw new Error(`ABI string offset is ${offset}, expected 32 (bytes32-style symbol?).`);
  }
  if (length > BigInt(bytes.length - 64) || length > 4096n) {
    throw new Error(`ABI string length ${length} exceeds the returned data.`);
  }
  // Trim trailing NUL padding to the 32-byte boundary.
  return new TextDecoder().decode(bytes.subarray(64, 64 + Number(length)));
}

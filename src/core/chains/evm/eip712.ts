import { keccak_256 } from '@noble/hashes/sha3';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils';
import { secp256k1 } from '@noble/curves/secp256k1';

/**
 * EIP-712 typed structured data hashing and signing.
 *
 * Dapps use `eth_signTypedData_v4` for logins, permits, and order signing. The
 * digest is defined as:
 *
 *   keccak256(0x19 || 0x01 || domainSeparator || hashStruct(primaryType, message))
 *
 * where `hashStruct(t, data) = keccak256(typeHash(t) || encodeData(t, data))`.
 * Getting this wrong produces a signature that recovers to the right address but
 * is rejected by the verifying contract, so the encoding below follows the spec
 * literally rather than approximating it.
 *
 * Everything here is pure; the private key is scoped by the caller.
 */

export interface TypedDataField {
  name: string;
  type: string;
}

export interface TypedData {
  /** Type definitions, including the primary type and its dependencies. */
  types: Record<string, TypedDataField[]>;
  primaryType: string;
  domain?: Record<string, unknown>;
  message?: Record<string, unknown>;
}

/** Atomic (non-struct) EIP-712 types. */
const ATOMIC_TYPE = /^(bytes\d*|uint\d*|int\d*|bool|address|string|function)$/;

function isArrayType(type: string): boolean {
  return type.endsWith(']');
}

function baseTypeOf(type: string): string {
  return type.replace(/(\[\d*\])+$/, '');
}

function isAtomic(type: string): boolean {
  return !isArrayType(type) && ATOMIC_TYPE.test(type);
}

function concatBytes(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

function utf8(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

/** Interprets a `bytes`/`bytesN` value: hex when 0x-prefixed, else UTF-8 text. */
function bytesValue(value: unknown, type: string): Uint8Array {
  if (typeof value !== 'string') {
    throw new Error(`EIP-712: expected a hex string for ${type}.`);
  }
  if (!value.startsWith('0x')) {
    return utf8(value);
  }
  const clean = value.slice(2);
  if (clean.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(clean)) {
    throw new Error(`EIP-712: invalid hex for ${type}.`);
  }
  return hexToBytes(clean);
}

/** Coerces a JSON scalar to a bigint (numbers, decimal strings, hex strings). */
function toBigInt(value: unknown, type: string): bigint {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'boolean') return value ? 1n : 0n;
  if (typeof value === 'number') {
    if (!Number.isInteger(value)) {
      throw new Error(`EIP-712: ${type} must be an integer.`);
    }
    return BigInt(value);
  }
  if (typeof value === 'string') {
    const text = value.trim();
    if (/^-?0x[0-9a-fA-F]+$/.test(text)) return BigInt(text);
    if (/^-?\d+$/.test(text)) return BigInt(text);
  }
  throw new Error(`EIP-712: ${type} must be a number or numeric string.`);
}

/** 32-byte big-endian two's-complement word for an integer value. */
function integerWord(value: bigint, type: string): Uint8Array {
  const out = new Uint8Array(32);
  let v = value;
  if (v < 0n) v = (1n << 256n) + v;
  for (let i = 31; i >= 0; i -= 1) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  if (v !== 0n) {
    throw new Error(`EIP-712: value overflows 256 bits for ${type}.`);
  }
  return out;
}

/** Left-padded 32-byte word for a 20-byte address. */
function addressWord(value: unknown): Uint8Array {
  if (typeof value !== 'string') {
    throw new Error('EIP-712: address must be a hex string.');
  }
  const clean = value.replace(/^0x/, '');
  if (!/^[0-9a-fA-F]{40}$/.test(clean)) {
    throw new Error(`EIP-712: invalid address "${value}".`);
  }
  const out = new Uint8Array(32);
  out.set(hexToBytes(clean), 12);
  return out;
}

/**
 * The `EIP712Domain` field list, derived from which keys the dapp supplied, in
 * the spec's canonical order. Including a field the dapp omitted (or omitting
 * one it supplied) changes the separator and breaks verification.
 */
const DOMAIN_FIELDS: ReadonlyArray<readonly [string, string]> = [
  ['name', 'string'],
  ['version', 'string'],
  ['chainId', 'uint256'],
  ['verifyingContract', 'address'],
  ['salt', 'bytes32'],
];

function domainType(domain: Record<string, unknown>): TypedDataField[] {
  return DOMAIN_FIELDS.filter(([name]) => domain[name] !== undefined).map(([name, type]) => ({
    name,
    type,
  }));
}

/** All type names reachable from `primaryType`, including itself. */
function dependenciesOf(
  primaryType: string,
  types: Record<string, TypedDataField[]>,
): Set<string> {
  const found = new Set<string>();
  const visit = (name: string): void => {
    if (found.has(name)) return;
    const fields = types[name];
    if (fields === undefined) return;
    found.add(name);
    for (const field of fields) {
      const base = baseTypeOf(field.type);
      if (!isAtomic(base)) visit(base);
    }
  };
  visit(primaryType);
  return found;
}

/** `encodeType(t)`: the primary type's encoding followed by its dependencies. */
export function encodeType(
  primaryType: string,
  types: Record<string, TypedDataField[]>,
): string {
  const deps = dependenciesOf(primaryType, types);
  deps.delete(primaryType);
  const ordered = [primaryType, ...[...deps].sort()];
  return ordered
    .map((name) => {
      const fields = types[name] ?? [];
      return `${name}(${fields.map((f) => `${f.type} ${f.name}`).join(',')})`;
    })
    .join('');
}

function typeHash(type: string, types: Record<string, TypedDataField[]>): Uint8Array {
  return keccak_256(utf8(encodeType(type, types)));
}

/** `hashStruct(t, data)`: keccak256 of the type hash and the encoded fields. */
export function hashStruct(
  type: string,
  data: Record<string, unknown>,
  types: Record<string, TypedDataField[]>,
): Uint8Array {
  const fields = types[type];
  if (fields === undefined) {
    throw new Error(`EIP-712: unknown type "${type}".`);
  }
  const encoded = fields.map((field) => {
    // A declared field missing from the message must not silently encode as a
    // zero value — that signs something other than what the dapp displayed.
    if (data[field.name] === undefined) {
      throw new Error(`EIP-712: missing field "${field.name}" for ${type}.`);
    }
    return encodeField(field.type, data[field.name], types);
  });
  return keccak_256(concatBytes([typeHash(type, types), ...encoded]));
}

function encodeField(
  type: string,
  value: unknown,
  types: Record<string, TypedDataField[]>,
): Uint8Array {
  if (isArrayType(type)) {
    if (!Array.isArray(value)) {
      throw new Error(`EIP-712: expected an array for ${type}.`);
    }
    const elementType = type.replace(/\[\d*\]$/, '');
    const encoded = value.map((item) => encodeField(elementType, item, types));
    return keccak_256(concatBytes(encoded));
  }

  if (type === 'string') {
    if (typeof value !== 'string') {
      throw new Error('EIP-712: expected a string.');
    }
    return keccak_256(utf8(value));
  }

  if (type === 'bytes') {
    // Dynamic bytes: hashed.
    return keccak_256(bytesValue(value, type));
  }

  const bytesN = /^bytes(\d+)$/.exec(type);
  if (bytesN !== null) {
    // Fixed-size bytesN is ATOMIC under EIP-712: the value, left-aligned in a
    // zero-padded 32-byte word, UNHASHED. Hashing it (the previous behavior)
    // produces a digest no verifying contract accepts — and it silently
    // corrupted the `salt: bytes32` domain field.
    const width = Number(bytesN[1]);
    if (width < 1 || width > 32) {
      throw new Error(`EIP-712: invalid width for ${type}.`);
    }
    const raw = bytesValue(value, type);
    if (raw.length !== width) {
      throw new Error(`EIP-712: ${type} expects exactly ${width} bytes, got ${raw.length}.`);
    }
    const out = new Uint8Array(32);
    out.set(raw, 0);
    return out;
  }

  if (type === 'bool') {
    if (typeof value !== 'boolean') {
      throw new Error(`EIP-712: expected a boolean, got ${typeof value}.`);
    }
    return integerWord(value ? 1n : 0n, type);
  }

  if (type === 'address') {
    return addressWord(value);
  }

  const intMatch = /^(u?)int(\d*)$/.exec(type);
  if (intMatch !== null) {
    const signed = intMatch[1] === '';
    const width = intMatch[2] === '' ? 256 : Number(intMatch[2]);
    if (width < 8 || width > 256 || width % 8 !== 0) {
      throw new Error(`EIP-712: invalid integer width for ${type}.`);
    }
    const num = toBigInt(value, type);
    // Width-bound the value: uint8: 300 must throw, not silently encode 300.
    if (signed) {
      const min = -(1n << BigInt(width - 1));
      const max = (1n << BigInt(width - 1)) - 1n;
      if (num < min || num > max) throw new Error(`EIP-712: value out of range for ${type}.`);
    } else {
      if (num < 0n || num >= 1n << BigInt(width)) {
        throw new Error(`EIP-712: value out of range for ${type}.`);
      }
    }
    return integerWord(num, type);
  }

  // Any remaining type must be a declared struct reference.
  if (types[type] === undefined) {
    throw new Error(`EIP-712: unknown type "${type}".`);
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`EIP-712: expected an object for ${type}.`);
  }
  return hashStruct(type, value as Record<string, unknown>, types);
}

/** The digest the dapp expects to be signed. */
export function hashTypedData(typedData: TypedData): Uint8Array {
  if (typeof typedData !== 'object' || typedData === null) {
    throw new Error('EIP-712: typed data must be an object.');
  }
  const { primaryType } = typedData;
  if (typeof primaryType !== 'string' || primaryType.length === 0) {
    throw new Error('EIP-712: primaryType is required.');
  }

  const domain = typedData.domain ?? {};
  const message = typedData.message ?? {};

  const types: Record<string, TypedDataField[]> = {
    ...typedData.types,
    EIP712Domain: domainType(domain),
  };

  if (types[primaryType] === undefined) {
    throw new Error(`EIP-712: unknown type "${primaryType}".`);
  }

  const domainSeparator = hashStruct('EIP712Domain', domain, types);
  const messageHash = hashStruct(primaryType, message, types);

  return keccak_256(concatBytes([new Uint8Array([0x19, 0x01]), domainSeparator, messageHash]));
}

/**
 * Signs EIP-712 typed data, returning the 65-byte `r || s || v` signature (v is
 * 27 or 28) in the exact shape `eth_signTypedData_v4` resolves with.
 */
export function signTypedData(
  typedData: TypedData,
  privateKey: Uint8Array,
): { signature: string; from: string; digest: string } {
  if (privateKey.length !== 32) {
    throw new Error(`Private key must be 32 bytes, got ${privateKey.length}.`);
  }

  const digest = hashTypedData(typedData);
  const signature = secp256k1.sign(digest, privateKey);
  const { r, s } = signature;
  const v = signature.recovery + 27;

  return {
    signature: `0x${r.toString(16).padStart(64, '0')}${s.toString(16).padStart(64, '0')}${v
      .toString(16)
      .padStart(2, '0')}`,
    from: deriveAddress(privateKey),
    digest: `0x${bytesToHex(digest)}`,
  };
}

/** EIP-55 checksummed address for a raw private key. */
function deriveAddress(privateKey: Uint8Array): string {
  const publicKey = secp256k1.getPublicKey(privateKey, false);
  const hashed = keccak_256(publicKey.slice(1));
  const body = bytesToHex(hashed.slice(-20)).toLowerCase();
  const hash = bytesToHex(keccak_256(utf8(body)));
  let out = '0x';
  for (let i = 0; i < body.length; i += 1) {
    const nibble = Number.parseInt(hash.charAt(i), 16);
    out += nibble >= 8 ? body.charAt(i).toUpperCase() : body.charAt(i);
  }
  return out;
}

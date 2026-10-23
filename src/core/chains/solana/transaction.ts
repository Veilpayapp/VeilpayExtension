/**
 * Solana SystemProgram transfer — build, sign, and serialize without
 * @solana/web3.js.
 *
 * Solana transactions use a compact wire format:
 *   [signatures] + message
 *
 * The message:
 *   [header: 3 bytes] + [account keys: compact-u16 prefixed] +
 *   [recent blockhash: 32 bytes] + [instructions: compact-u16 prefixed]
 *
 * Each instruction:
 *   [programIdIndex: 1 byte] + [account indices: compact-u16 prefixed] +
 *   [data: compact-u16 prefixed]
 *
 * Everything here is pure; the caller fetches the recent blockhash from the
 * RPC and provides the raw private key from the vault.
 */

import { base58 } from '@scure/base';
import { ed25519 } from '@noble/curves/ed25519';
import { sha256 } from '@noble/hashes/sha256';

/** Base58-encoded 32-byte public key. */
export interface SolanaAddress {
  address: string;
  /** Raw bytes for the wire format. */
  pubkey: Uint8Array;
}

/** An unsigned Solana transfer. */
export interface UnsignedSolanaTransfer {
  /** Base58-encoded sender. */
  from: string;
  /** Base58-encoded recipient. */
  to: string;
  /** Amount in lamports (10^-9 SOL). */
  lamports: bigint;
  /** 32-byte recent blockhash from RPC. */
  blockhash: Uint8Array;
}

/** An unsigned Solana SPL token transfer (TransferChecked). */
export interface UnsignedSolanaSplTransfer {
  /** Base58-encoded sender (also the token owner / authority). */
  from: string;
  /** Sender's SPL token account that holds the balance. */
  source: string;
  /** SPL mint for this token. */
  mint: string;
  /** Recipient's SPL token account. */
  dest: string;
  /** Amount in raw token units (10^-decimals). */
  amount: bigint;
  /** The token's decimals (from the mint), re-encoded into the wire data. */
  decimals: number;
  /** 32-byte recent blockhash from RPC. */
  blockhash: Uint8Array;
}

/** A fully signed, broadcast-ready Solana transaction. */
export interface SignedSolanaTransaction {
  /** Base64-encoded transaction for `sendTransaction` RPC. */
  raw: string;
  /** The message hash that was signed (for diagnostics). */
  signingHash: string;
  /** Recovered sender address. */
  from: string;
}

// The SystemProgram ID is the all-zero pubkey (32 bytes).
const SYSTEM_PROGRAM: Uint8Array = new Uint8Array(32);

/** SPL Token program ID: TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA. */
const TOKEN_PROGRAM: Uint8Array = base58.decode('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');

/** SPL Associated Token Account program ID. */
const ASSOCIATED_TOKEN_PROGRAM: Uint8Array = base58.decode(
  'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL',
);

// ---------------------------------------------------------------------------
// Compact-u16 encoding (Solana's multi-byte length prefix)
// ---------------------------------------------------------------------------

function encodeCompactU16(value: number): Uint8Array {
  if (value < 0 || value > 0x1fffff || !Number.isInteger(value)) {
    throw new RangeError(`Compact-u16 value out of range: ${value}`);
  }
  if (value <= 0x7f) {
    return new Uint8Array([value]);
  }
  if (value <= 0x3fff) {
    return new Uint8Array([(value & 0x7f) | 0x80, value >> 7]);
  }
  return new Uint8Array([
    (value & 0x7f) | 0x80,
    ((value >> 7) & 0x7f) | 0x80,
    value >> 14,
  ]);
}

// ---------------------------------------------------------------------------
// Address parsing
// ---------------------------------------------------------------------------

function parseAddress(address: string): Uint8Array {
  const bytes = base58.decode(address);
  if (bytes.length !== 32) {
    throw new Error(`Solana address must be 32 bytes, got ${bytes.length}.`);
  }
  return bytes;
}

// ---------------------------------------------------------------------------
// Transaction message building
// ---------------------------------------------------------------------------

/**
 * Builds the unsigned Solana transaction message.
 *
 * The message format is:
 *   [numRequiredSignatures: 1] [numReadonlySignedAccounts: 1]
 *   [numReadonlyUnsignedAccounts: 1]
 *   [compact-u16 accountKeyCount] [accountKeys...]
 *   [recentBlockhash: 32 bytes]
 *   [compact-u16 instructionCount] [instructions...]
 */
function buildMessage(
  fromPubkey: Uint8Array,
  toPubkey: Uint8Array,
  lamports: bigint,
  blockhash: Uint8Array,
): Uint8Array {
  // Account keys MUST be ordered by weight: writable signers, read-only
  // signers, writable non-signers, read-only non-signers. The SystemProgram is
  // a read-only non-signer, so it goes last, and the header must count it as
  // read-only unsigned. Marking a program writable (or ordering it before a
  // writable account) makes the node reject the transaction outright.
  const header = new Uint8Array([1, 0, 1]); // 1 signer, 0 readonly-signed, 1 readonly-unsigned

  // Account keys: feePayer (signer), destination (writable), SystemProgram (read-only)
  const accountKeys = [fromPubkey, toPubkey, SYSTEM_PROGRAM];
  const accountKeysLen = encodeCompactU16(accountKeys.length);
  const accountKeysFlat = concat(accountKeys);

  // Instruction: SystemProgram.transfer
  // programIdIndex = 2 (SystemProgram is the last key)
  // accounts = [0, 1] (feePayer at 0, destination at 1)
  //
  // The SystemProgram instruction data is bincode-serialized, so the enum
  // discriminant is a little-endian u32 (4 bytes), not a single byte:
  //   [02 00 00 00][lamports as u64 LE]  => 12 bytes total.
  // Emitting `[02][lamports]` (9 bytes) is rejected by the runtime with
  // "invalid instruction data".
  const lamportsLE = toLE64(lamports);
  const instructionData = new Uint8Array([2, 0, 0, 0, ...lamportsLE]);
  const instruction = encodeInstruction(2, [0, 1], instructionData);

  const instructionsLen = encodeCompactU16(1);

  // Assemble the message
  const parts = [
    header,
    accountKeysLen,
    accountKeysFlat,
    blockhash,
    instructionsLen,
    instruction,
  ];

  return concat(parts);
}

function encodeInstruction(
  programIdIndex: number,
  accountIndices: number[],
  data: Uint8Array,
): Uint8Array {
  const indicesPrefix = encodeCompactU16(accountIndices.length);
  const indicesFlat = new Uint8Array(accountIndices.length);
  for (let i = 0; i < accountIndices.length; i += 1) {
    indicesFlat[i] = accountIndices[i] ?? 0;
  }
  const dataPrefix = encodeCompactU16(data.length);

  return concat([
    new Uint8Array([programIdIndex]),
    indicesPrefix,
    indicesFlat,
    dataPrefix,
    data,
  ]);
}

/**
 * Signs a Solana transfer and returns the broadcast-ready base64 string.
 *
 * Signing uses ed25519 on the SHA-256 hash of the message, per the Solana
 * specification. The 64-byte signature is prepended to the message.
 */
export function signSolanaTransfer(
  tx: UnsignedSolanaTransfer,
  privateKey: Uint8Array,
): SignedSolanaTransaction {
  if (privateKey.length !== 32) {
    throw new Error(`Solana private key must be 32 bytes, got ${privateKey.length}.`);
  }

  const fromPubkey = parseAddress(tx.from);
  const toPubkey = parseAddress(tx.to);

  const message = buildMessage(fromPubkey, toPubkey, tx.lamports, tx.blockhash);
  const messageHash = sha256(message);
  // Solana signs the raw serialized message with plain Ed25519 (the network
  // verifies `ed25519.verify(message, ...)`; `sha256` is only kept as a
  // diagnostic id, never as the signed payload).
  const signature = ed25519.sign(message, privateKey);

  // Solana legacy wire format: [compact-u16 signature count][signatures...][message]
  // For a single signature: [1][64-byte signature][message]. Legacy transactions
  // carry no version prefix (that is `0x80`-masked v0); `@solana/web3.js`
  // serializes them exactly this way.
  const sigCount = new Uint8Array([1]);
  const raw = concat([sigCount, signature, message]);

  const from = base58.encode(fromPubkey);

  return {
    raw: btoa(String.fromCharCode(...raw)),
    signingHash: bytesToHex(messageHash),
    from,
  };
}

/**
 * Builds an unsigned SPL `TransferChecked` message.
 *
 * Account-key layout (in wire order):
 *   0  feePayer (from, signer + writable)
 *   1  source token account (writable, holds the balance)
 *   2  mint (read-only)
 *   3  dest token account (writable)
 *   4  SPL Token program (read-only)
 *
 * Message header [numRequired, readonlySigned, readonlyUnsigned] = [1, 0, 2]
 * (only `from` signs; mint and the token program are read-only and unsigned).
 *
 * Instruction `TransferChecked` (index 12) with data:
 *   [amount u64 LE][decimals u8]
 * and account indexes [source, mint, dest, owner].
 */
function buildSplMessage(
  fromPubkey: Uint8Array,
  sourcePubkey: Uint8Array,
  mintPubkey: Uint8Array,
  destPubkey: Uint8Array,
  amount: bigint,
  decimals: number,
  blockhash: Uint8Array,
): Uint8Array {
  const header = new Uint8Array([1, 0, 2]);

  // Keys must follow the weight ordering (see `buildMessage`): the writable
  // non-signers (source, dest) come before the read-only non-signers (mint,
  // token program). Putting the read-only mint between the writable accounts
  // is invalid and the node rejects the transaction.
  //   0 feePayer (signer, writable)
  //   1 source token account (writable)
  //   2 dest token account (writable)
  //   3 mint (read-only)
  //   4 SPL Token program (read-only)
  const accountKeys = [fromPubkey, sourcePubkey, destPubkey, mintPubkey, TOKEN_PROGRAM];
  const accountKeysLen = encodeCompactU16(accountKeys.length);
  const accountKeysFlat = concat(accountKeys);

  const amountLE = toLE64(amount);
  // SPL Token uses a single-byte instruction tag (12 = TransferChecked), then
  // the amount as u64 LE and the decimals byte => 10 bytes. This differs from
  // the SystemProgram, whose bincode discriminant is a u32; both encodings are
  // what their respective programs parse.
  const instructionData = new Uint8Array([12, ...amountLE, decimals & 0xff]);
  // TransferChecked accounts, in the instruction's own order:
  //   [source, mint, dest, owner] = [1, 3, 2, 0]
  const instruction = encodeInstruction(4, [1, 3, 2, 0], instructionData);

  const instructionsLen = encodeCompactU16(1);

  return concat([
    header,
    accountKeysLen,
    accountKeysFlat,
    blockhash,
    instructionsLen,
    instruction,
  ]);
}

/**
 * Signs an SPL token transfer and returns the broadcast-ready base64 string.
 * `source` and `dest` are the token accounts; `from` is the owner/authority and
 * fee payer. Reuses the same envelope layout as the native transfer.
 */
export function signSolanaSplTransfer(
  tx: UnsignedSolanaSplTransfer,
  privateKey: Uint8Array,
): SignedSolanaTransaction {
  if (privateKey.length !== 32) {
    throw new Error(`Solana private key must be 32 bytes, got ${privateKey.length}.`);
  }

  const fromPubkey = parseAddress(tx.from);
  const sourcePubkey = parseAddress(tx.source);
  const mintPubkey = parseAddress(tx.mint);
  const destPubkey = parseAddress(tx.dest);

  const message = buildSplMessage(
    fromPubkey,
    sourcePubkey,
    mintPubkey,
    destPubkey,
    tx.amount,
    tx.decimals,
    tx.blockhash,
  );
  const messageHash = sha256(message);
  // Plain Ed25519 over the raw message, matching the native path.
  const signature = ed25519.sign(message, privateKey);

  const sigCount = new Uint8Array([1]);
  const raw = concat([sigCount, signature, message]);

  const from = base58.encode(fromPubkey);

  return {
    raw: btoa(String.fromCharCode(...raw)),
    signingHash: bytesToHex(messageHash),
    from,
  };
}

/**
 * Finds a program-derived address (PDA) for the given seeds + program id,
 * following Solana's canonical scheme: hash `["ProgramDerivedAddress", seeds,
 * bump, programId]` and, if that lands on the ed25519 curve, decrement the
 * bump seed until it is off-curve. Returns the base58 address.
 */
export function findProgramAddress(seeds: Uint8Array[], programId: Uint8Array): {
  address: string;
  bump: number;
} {
  const prefix = new TextEncoder().encode('ProgramDerivedAddress');
  for (let bump = 255; bump >= 0; bump -= 1) {
    const parts: Uint8Array[] = [prefix, ...seeds, new Uint8Array([bump]), programId];
    const candidate = sha256(concat(parts));
    if (!isOnCurve(candidate)) {
      return { address: base58.encode(candidate), bump };
    }
  }
  throw new Error('Unable to find a valid off-curve PDA.');
}

/** True when the 32-byte value is a valid point on the ed25519 curve. */
function isOnCurve(bytes: Uint8Array): boolean {
  try {
    ed25519.ExtendedPoint.fromHex(bytes);
    return true;
  } catch {
    return false;
  }
}

/**
 * Derives the canonical associated token account (ATA) for an owner + mint:
 * the PDA of the ATA program with seeds [owner, TOKEN_PROGRAM, mint]. When the
 * recipient has never received this token, the ATA must be created with an
 * `initializeAccount` instruction before a transfer can credit it.
 */
export function deriveAssociatedTokenAddress(owner: string, mint: string): string {
  const ownerPubkey = parseAddress(owner);
  const mintPubkey = parseAddress(mint);
  const { address } = findProgramAddress(
    [ownerPubkey, TOKEN_PROGRAM, mintPubkey],
    ASSOCIATED_TOKEN_PROGRAM,
  );
  return address;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function toLE64(value: bigint): Uint8Array {
  // Fail closed: a negative amount would otherwise encode as a huge two's-
  // complement u64 (~1.8e19), and ≥ 2^64 would silently lose its high bits —
  // in both cases the wire bytes would not match the approved amount.
  if (value < 0n || value > 0xffffffffffffffffn) {
    throw new RangeError(`Lamport amount out of u64 range: ${value}.`);
  }
  const out = new Uint8Array(8);
  for (let i = 0; i < 8; i += 1) {
    out[i] = Number(value & 0xffn);
    value >>= 8n;
  }
  return out;
}

/**
 * Reads a compact-u16 value at `offset`, returning the value and the number of
 * bytes consumed (1–3). Throws when the input ends mid-prefix.
 */
function decodeCompactU16(data: Uint8Array, offset: number): { value: number; consumed: number } {
  const first = data[offset];
  if (first === undefined) {
    throw new Error('Solana transaction: truncated compact-u16.');
  }
  if ((first & 0x80) === 0) {
    return { value: first, consumed: 1 };
  }
  const second = data[offset + 1];
  if (second === undefined) {
    throw new Error('Solana transaction: truncated compact-u16.');
  }
  if ((second & 0x80) === 0) {
    return { value: ((first & 0x7f) << 7) | second, consumed: 2 };
  }
  const third = data[offset + 2];
  if (third === undefined) {
    throw new Error('Solana transaction: truncated compact-u16.');
  }
  return { value: ((first & 0x7f) << 14) | ((second & 0x7f) << 7) | third, consumed: 3 };
}

/**
 * Parses a base58-encoded serialized Solana transaction into its signatures and
 * message, per the wire format:
 *   [compact-u16 signature count] [64-byte signatures...] [message]
 *
 * The message's header tells us how many of the leading account keys are
 * required signers; the wallet's signature slot is the position of its pubkey
 * among those signers.
 */
export function parseSolanaTransaction(serialized: string): {
  message: Uint8Array;
  /** Base58-encoded account keys, in wire order. */
  accountKeys: string[];
  /** Number of required signatures (from the message header). */
  numRequiredSignatures: number;
  /** The account-key index the wallet must sign as (fee payer is index 0). */
  feePayerIndex: number;
} {
  const bytes = base58.decode(serialized);

  const sigCount = decodeCompactU16(bytes, 0);
  const signaturesStart = sigCount.consumed;
  const signaturesEnd = signaturesStart + sigCount.value * 64;
  if (bytes.length < signaturesEnd + 3) {
    throw new Error('Solana transaction: missing message after signatures.');
  }
  const message = bytes.subarray(signaturesEnd);

  const numRequiredSignatures = message[0];
  if (numRequiredSignatures === undefined || numRequiredSignatures < 1) {
    throw new Error('Solana transaction: invalid required-signature header.');
  }
  // Message header is [numRequired][readonlySigned][readonlyUnsigned].
  const keyCount = decodeCompactU16(message, 3);
  const accountKeys: string[] = [];
  let offset = 3 + keyCount.consumed;
  for (let i = 0; i < keyCount.value; i += 1) {
    const key = message.subarray(offset, offset + 32);
    if (key.length !== 32) {
      throw new Error('Solana transaction: truncated account key.');
    }
    accountKeys.push(base58.encode(key));
    offset += 32;
  }
  // The fee payer is the first account key (Solana convention).
  const feePayerIndex = 0;

  return {
    message,
    accountKeys,
    numRequiredSignatures,
    feePayerIndex,
  };
}

/**
 * Signs a dapp-supplied serialized Solana transaction (base58) with the wallet
 * key, inserting the signature into the fee payer's slot.
 *
 * Returns the signature (base58) and the fully re-serialized transaction
 * (base58), ready to broadcast. Throws if the wallet key is not one of the
 * required signers.
 */
export function signSolanaTransaction(
  serialized: string,
  privateKey: Uint8Array,
  address: string,
): { signature: string; signedTransaction: string } {
  if (privateKey.length !== 32) {
    throw new Error(`Solana private key must be 32 bytes, got ${privateKey.length}.`);
  }

  const parsed = parseSolanaTransaction(serialized);
  const signerIndex = parsed.accountKeys.indexOf(address);
  if (signerIndex === -1 || signerIndex >= parsed.numRequiredSignatures) {
    throw new Error('Solana transaction: wallet is not a required signer.');
  }

  const signature = ed25519.sign(parsed.message, privateKey);

  // Rebuild the wire format: [count prefix][signatures with ours inserted at
  // `signerIndex`][message]. Existing signatures are preserved; only the slot
  // for the wallet's account key is overwritten.
  const bytes = base58.decode(serialized);
  const sigCount = decodeCompactU16(bytes, 0);
  const sigsStart = sigCount.consumed;
  const existingSigs = bytes.subarray(sigsStart, sigsStart + sigCount.value * 64);

  const out = new Uint8Array(sigCount.consumed + sigCount.value * 64 + parsed.message.length);
  out.set(bytes.subarray(0, sigsStart), 0); // count prefix
  out.set(existingSigs.subarray(0, signerIndex * 64), sigsStart);
  out.set(signature, sigsStart + signerIndex * 64);
  out.set(
    existingSigs.subarray((signerIndex + 1) * 64),
    sigsStart + (signerIndex + 1) * 64,
  );
  out.set(parsed.message, sigsStart + sigCount.value * 64);

  return {
    signature: base58.encode(signature),
    signedTransaction: base58.encode(out),
  };
}

/**
 * Signs a raw message (already decoded from base58 by the caller) per Phantom's
 * `signMessage` convention: a bare ed25519 signature over the message bytes
 * (no domain separator). Returns the base58 signature.
 *
 * BECAUSE there is no domain separator, a signature over bytes that ARE a
 * serialized transaction message is a valid transaction signature — callers
 * must run `looksLikeTransactionMessage` first and refuse those, or this is a
 * transaction-signing oracle behind a benign "sign message" prompt.
 */
export function signSolanaMessage(
  message: Uint8Array,
  privateKey: Uint8Array,
): { signature: string } {
  if (privateKey.length !== 32) {
    throw new Error(`Solana private key must be 32 bytes, got ${privateKey.length}.`);
  }
  const signature = ed25519.sign(message, privateKey);
  return { signature: base58.encode(signature) };
}

/**
 * Whether `message` parses as a structurally complete Solana transaction
 * message (legacy or v0) that names `walletAddress` as a required signer.
 *
 * This is the anti-oracle check for `signMessage`: a bare ed25519 signature
 * over a well-formed transaction message is a broadcastable transaction
 * signature, so such payloads must never reach `signSolanaMessage`. Strict
 * whole-buffer parsing is what makes the check safe — a malformed message
 * yields a transaction no node accepts, so it has no oracle value and is
 * treated as an ordinary message (returns false).
 */
export function looksLikeTransactionMessage(
  message: Uint8Array,
  walletAddress: string,
): boolean {
  // Versioned-message marker up front so the v0 lookup table tail is parsed
  // only when the buffer actually claims to be versioned.
  const versioned = (message[0] ?? 0) >= 0x80;
  try {
    // Versioned messages open with 0x80 | version (only v0 exists today).
    let offset = versioned ? 1 : 0;
    // Header: [numRequiredSignatures][readonlySigned][readonlyUnsigned].
    const numRequiredSignatures = message[offset];
    if (numRequiredSignatures === undefined || numRequiredSignatures < 1) return false;
    offset += 3;

    const keyCount = decodeCompactU16(message, offset);
    offset += keyCount.consumed;
    if (numRequiredSignatures > keyCount.value) return false;
    const keyBytes: Uint8Array[] = [];
    for (let i = 0; i < keyCount.value; i += 1) {
      const key = message.subarray(offset, offset + 32);
      if (key.length !== 32) return false;
      keyBytes.push(key);
      offset += 32;
    }

    // Recent blockhash.
    if (message.length < offset + 32) return false;
    offset += 32;

    // Instructions.
    const ixCount = decodeCompactU16(message, offset);
    offset += ixCount.consumed;
    for (let i = 0; i < ixCount.value; i += 1) {
      // programIdIndex
      if (offset >= message.length) return false;
      offset += 1;
      const accounts = decodeCompactU16(message, offset);
      offset += accounts.consumed + accounts.value;
      const data = decodeCompactU16(message, offset);
      offset += data.consumed + data.value;
      if (offset > message.length) return false;
    }

    // v0 address-table lookups follow the instructions.
    if (versioned) {
      const lookupCount = decodeCompactU16(message, offset);
      offset += lookupCount.consumed;
      for (let i = 0; i < lookupCount.value; i += 1) {
        if (message.length < offset + 32) return false;
        offset += 32;
        const writable = decodeCompactU16(message, offset);
        offset += writable.consumed + writable.value;
        const readonly = decodeCompactU16(message, offset);
        offset += readonly.consumed + readonly.value;
        if (offset > message.length) return false;
      }
    }

    // A well-formed message consumes the buffer exactly.
    if (offset !== message.length) return false;

    // The oracle only matters if OUR key would sign it.
    const walletKey = base58.decode(walletAddress);
    for (let i = 0; i < numRequiredSignatures; i += 1) {
      const key = keyBytes[i];
      if (key !== undefined && key.length === walletKey.length && key.every((b, j) => b === walletKey[j])) {
        return true;
      }
    }
    return false;
  } catch {
    return false;
  }
}

function concat(arrays: Uint8Array[]): Uint8Array {
  const total = arrays.reduce((n, a) => n + a.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const a of arrays) {
    out.set(a, offset);
    offset += a.length;
  }
  return out;
}

function bytesToHex(bytes: Uint8Array): string {
  let out = '';
  for (const b of bytes) {
    out += b.toString(16).padStart(2, '0');
  }
  return out;
}
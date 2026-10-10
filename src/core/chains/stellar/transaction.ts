/**
 * Stellar payment operation — build, sign, and serialize without
 * @stellar/stellar-sdk.
 *
 * Uses raw XDR encoding for a native (XLM) or issued-asset payment, with an
 * optional MEMO_TEXT (≤ 28 bytes) and no time bounds. The caller provides the
 * account sequence number from Horizon and the raw private key from the vault.
 */

import { base32 } from '@scure/base';
import { ed25519 } from '@noble/curves/ed25519';
import { sha256 } from '@noble/hashes/sha256';
import { signWithScalar } from '@/core/chains/stellar/scalar-sign';

/**
 * A Stellar asset to pay in — native XLM or an issued token.
 * Issued assets are identified on-chain by an asset code (1–12 ASCII chars)
 * and the issuer's strkey address. Stellar scales every asset's amount the
 * same way as XLM: the smallest unit is 10^-7 of the whole token.
 */
export interface StellarAssetXdr {
  type: 'native' | 'issued';
  /** Asset code (1–12 chars) for issued assets. */
  code?: string;
  /** Issuer strkey (G...) for issued assets. */
  issuer?: string;
}

/** A fully signed, broadcast-ready Stellar transaction. */
export interface SignedStellarTransaction {
  /** Base64-encoded TransactionEnvelope XDR for Horizon's /transactions. */
  raw: string;
  /** SHA-256 hash of the Transaction XDR (the network transaction hash). */
  signingHash: string;
  /** Recovered sender address. */
  from: string;
}

/** The Stellar public testnet network passphrase. */
export const STELLAR_TESTNET_PASSPHRASE = 'Test SDF Network ; September 2015';

/**
 * Computes a Stellar network ID, i.e. `sha256(networkPassphrase)` over the raw
 * passphrase bytes. Used to build the signature base so signatures bind to the
 * intended network (testnet vs future mainnet).
 */
function stellarNetworkId(passphrase: string): Uint8Array {
  return sha256(new TextEncoder().encode(passphrase));
}

/**
 * Builds the canonical signing pre-image for a transaction: the network ID
 * followed by the tagged transaction, as defined by Stellar's
 * `TransactionSignaturePayload`. The ed25519 signature is over the SHA-256 of
 * exactly these bytes, so omitting the network prefix produces an invalid
 * signature (`tx_bad_auth`) on live networks.
 */
function stellarSignatureBase(networkId: Uint8Array, txXdr: Uint8Array): Uint8Array {
  const ENVELOPE_TYPE_TX = 2;
  return concat([networkId, xdrUint32(ENVELOPE_TYPE_TX), txXdr]);
}

/** An unsigned Stellar payment. */
export interface UnsignedStellarPayment {
  /** Stellar address (G...) of the sender. */
  from: string;
  /** Stellar address (G...) of the recipient. */
  to: string;
  /** Amount in the asset's smallest unit (stroops, 10^-7 of the whole token). */
  amount: bigint;
  /** Asset to pay in. Defaults to native XLM. */
  asset?: StellarAssetXdr;
  /** Account sequence number from Horizon. */
  sequence: bigint;
  /** Base fee in stroops (typically 100). */
  fee: number;
  /**
   * Optional MEMO_TEXT, UTF-8 encoded. Stellar caps memos at 28 bytes;
   * longer input is rejected (never silently truncated, since memos are
   * load-bearing for exchanges and custodial services).
   */
  memo?: string | undefined;
  /** Network passphrase. Defaults to the Stellar testnet passphrase. */
  networkPassphrase?: string;
}

/**
 * Decodes a Stellar strkey (G... address) to its raw 32-byte ed25519 public key.
 *
 * Format: base32(version byte + payload + CRC16-XModem LE checksum)
 * Version 6 << 3 = 0x30 yields the G... account ID prefix.
 */
/** Decodes a Stellar strkey (G...) back to its raw 32-byte public key. */
export function decodeStellarAddress(address: string): Uint8Array {
  // @scure/base's base32 is uppercase-only (RFC 4648); Stellar strkeys are
  // canonical uppercase, so normalize defensively before decoding.
  const normalized = address.toUpperCase();
  const decoded = base32.decode(normalized);
  if (decoded.length !== 35) {
    // 1 version byte + 32 payload bytes + 2 checksum bytes
    throw new Error(`Invalid Stellar address length: ${decoded.length} bytes.`);
  }
  const version = decoded[0];
  if (version !== 6 << 3) {
    throw new Error(`Unexpected Stellar address version byte: ${version}.`);
  }
  // Return the raw 32-byte public key (skip version, skip 2-byte checksum).
  return decoded.subarray(1, 33);
}

/**
 * Encodes the raw 32-byte ed25519 public key as a Stellar strkey (G... address).
 * Matches the implementation in vault/key-derivation.ts.
 */
export function encodeStellarAddress(publicKey: Uint8Array): string {
  const payload = new Uint8Array(1 + publicKey.length);
  payload[0] = 6 << 3;
  payload.set(publicKey, 1);

  const checksum = crc16Xmodem(payload);
  const framed = new Uint8Array(payload.length + 2);
  framed.set(payload);
  framed[payload.length] = checksum & 0xff;
  framed[payload.length + 1] = (checksum >> 8) & 0xff;

  return base32.encode(framed);
}

// ---------------------------------------------------------------------------
// XDR encoding helpers
// ---------------------------------------------------------------------------

function xdrUint32(value: number): Uint8Array {
  return new Uint8Array([
    (value >>> 24) & 0xff,
    (value >>> 16) & 0xff,
    (value >>> 8) & 0xff,
    value & 0xff,
  ]);
}

function xdrUint64(value: bigint): Uint8Array {
  const out = new Uint8Array(8);
  for (let i = 7; i >= 0; i -= 1) {
    out[i] = Number(value & 0xffn);
    value >>= 8n;
  }
  return out;
}

function xdrInt64(value: bigint): Uint8Array {
  // For non-negative amounts, int64 and uint64 encoding are identical.
  return xdrUint64(value);
}

/** Encode an opaque<max> = uint32 length + bytes. */
function xdrOpaque(bytes: Uint8Array): Uint8Array {
  return concat([xdrUint32(bytes.length), bytes]);
}

/**
 * Encodes an XDR `string<max>`: uint32 byte length + bytes, zero-padded to a
 * 4-byte boundary (XDR alignment). `xdrOpaque` alone is fine for fields whose
 * length is already a multiple of 4 (e.g. 64-byte signatures); variable-length
 * text must be padded or every following field shifts and the envelope fails
 * to decode.
 */
function xdrString(bytes: Uint8Array): Uint8Array {
  const padding = (4 - (bytes.length % 4)) % 4;
  return concat([xdrUint32(bytes.length), bytes, new Uint8Array(padding)]);
}

/** A memo in its wire forms: none, text, or a 32-byte hash. */
export type StellarMemo =
  | { kind: 'none' }
  | { kind: 'text'; text: string }
  | { kind: 'hash'; bytes: Uint8Array };

/**
 * Encodes the Memo union.
 *
 *   union switch (MemoType type) {
 *     case MEMO_NONE: void;          // 0
 *     case MEMO_TEXT: string<28>;    // 1
 *     case MEMO_HASH: Hash;          // 2  — fixed opaque[32], no length prefix
 *     ...
 *   }
 *
 * Empty/whitespace-only text collapses to MEMO_NONE so a blank memo field
 * never changes the transaction. Text over 28 UTF-8 bytes throws: memos are
 * load-bearing for exchanges, so truncating silently is worse than failing.
 * A hash memo must be exactly 32 bytes (it carries e.g. a stealth ephemeral
 * public key).
 */
function xdrMemoInput(memo: StellarMemo): Uint8Array {
  if (memo.kind === 'none') return xdrUint32(0);
  if (memo.kind === 'hash') {
    if (memo.bytes.length !== 32) {
      throw new Error(`MEMO_HASH must be exactly 32 bytes, got ${memo.bytes.length}.`);
    }
    return concat([xdrUint32(2), memo.bytes]); // MEMO_HASH
  }
  const text = memo.text.trim();
  if (text.length === 0) return xdrUint32(0); // MEMO_NONE
  const bytes = new TextEncoder().encode(text);
  if (bytes.length > 28) {
    throw new Error(
      `Stellar memo is ${bytes.length} bytes; the on-chain maximum is 28.`,
    );
  }
  return concat([xdrUint32(1), xdrString(bytes)]); // MEMO_TEXT
}

/** Encode a variable-length array = uint32 count + elements. */
function xdrArray(elements: Uint8Array[]): Uint8Array {
  return concat([xdrUint32(elements.length), ...elements]);
}

/**
 * Encode the modern `Preconditions` union with nothing set (PRECOND_NONE = 0).
 *
 * Protocol 19+ restructured the transaction header: the legacy `TimeBounds*`
 * optional pointer became a `Preconditions` union whose discriminant is a
 * uint32. Horizon's decoder reads `operations` as an array whose length field
 * follows preconditions — encoding the old 1-byte pointer shifts every
 * subsequent field and the envelope fails with "could not decode". "No
 * constraints" is a single uint32 discriminant 0 (no body).
 */
function xdrPreconditionsNone(): Uint8Array {
  return xdrUint32(0); // PRECOND_NONE = 0
}

// ---------------------------------------------------------------------------
// XDR encoding for Stellar native payment
// ---------------------------------------------------------------------------

/**
 * Encodes a PublicKey union (PUBLIC_KEY_TYPE_ED25519).
 * XDR: uint32 discriminant (0) + uint256 (32 bytes).
 */
function xdrPublicKey(raw: Uint8Array): Uint8Array {
  return concat([xdrUint32(0), raw]); // PUBLIC_KEY_TYPE_ED25519 = 0
}

/** ASCII asset code padded with NUL bytes to the fixed XDR length. */
function xdrAssetCode(code: string, length: number): Uint8Array {
  const out = new Uint8Array(length);
  for (let i = 0; i < code.length; i += 1) {
    out[i] = code.charCodeAt(i) & 0xff;
  }
  return out;
}

/**
 * Encodes an Asset union.
 * XDR:
 *   union Asset switch (AssetType type) {
 *     case ASSET_TYPE_NATIVE: void;
 *     case ASSET_TYPE_CREDIT_ALPHANUM4: AlphaNum4;
 *     case ASSET_TYPE_CREDIT_ALPHANUM12: AlphaNum12;
 *   };
 * AssetType: ASSET_TYPE_NATIVE=0, CREDIT_ALPHANUM4=1, CREDIT_ALPHANUM12=2.
 * AlphaNum4 { opaque assetCode[4]; AccountID issuer; }
 * AlphaNum12 { opaque assetCode[12]; AccountID issuer; }
 */
function xdrAsset(asset: StellarAssetXdr): Uint8Array {
  if (asset.type === 'native' || asset.code === undefined || asset.issuer === undefined) {
    return xdrUint32(0); // ASSET_TYPE_NATIVE
  }
  const issuer = decodeStellarAddress(asset.issuer);
  if (asset.code.length <= 4) {
    return concat([
      xdrUint32(1), // ASSET_TYPE_CREDIT_ALPHANUM4
      xdrAssetCode(asset.code, 4),
      xdrPublicKey(issuer),
    ]);
  }
  return concat([
    xdrUint32(2), // ASSET_TYPE_CREDIT_ALPHANUM12
    xdrAssetCode(asset.code, 12),
    xdrPublicKey(issuer),
  ]);
}

/**
 * Encodes a PaymentOp struct.
 * XDR: AccountID destination + Asset asset + int64 amount.
 */
function xdrPaymentOp(destPubkey: Uint8Array, amount: bigint, asset: StellarAssetXdr): Uint8Array {
  // AccountID = PublicKey = PUBLIC_KEY_TYPE_ED25519 (0) + 32 bytes
  const destination = xdrPublicKey(destPubkey);
  // Asset — native XLM by default, or the requested issued token.
  const assetXdr = xdrAsset(asset);
  // Amount = int64
  const amountXdr = xdrInt64(amount);
  return concat([destination, assetXdr, amountXdr]);
}

/**
 * Encodes an Operation struct (PAYMENT).
 *
 * XDR:
 *   struct Operation {
 *     MuxedAccount* sourceAccount;  // optional pointer, u32; 0 = null
 *     union switch (OperationType) { case PAYMENT: PaymentOp paymentOp; ... } body;
 *   }
 *
 * XDR optional pointers are FOUR bytes, not one: the discriminant 0 (null) /
 * 1 (present) is a uint32. Using a single byte shifts the whole operation and
 * Horizon rejects the envelope as undecodable.
 */
function xdrPaymentOperation(
  destPubkey: Uint8Array,
  amount: bigint,
  asset: StellarAssetXdr,
): Uint8Array {
  const nullSourcePointer = xdrUint32(0); // MuxedAccount* = null
  const body = concat([xdrUint32(1), xdrPaymentOp(destPubkey, amount, asset)]); // PAYMENT = 1
  return concat([nullSourcePointer, body]);
}

/**
 * Encodes a Transaction XDR struct for an arbitrary list of prebuilt
 * operations (shared by the payment, change-trust, create-account, and
 * manage-data builders).
 */
function xdrTransactionOps(
  sourcePubkey: Uint8Array,
  fee: number,
  seqNum: bigint,
  memo: StellarMemo,
  operations: Uint8Array[],
): Uint8Array {
  // sourceAccount: AccountID = PUBLIC_KEY_TYPE_ED25519 + 32 bytes
  const sourceAccount = xdrPublicKey(sourcePubkey);
  // fee: uint32
  const feeXdr = xdrUint32(fee);
  // seqNum: uint64
  const seqNumXdr = xdrUint64(seqNum);
  // preconditions: modern `Preconditions` union, PRECOND_NONE (no constraints).
  const preconditions = xdrPreconditionsNone();
  // memo: none, text, or hash
  const memoXdr = xdrMemoInput(memo);
  // ext: v=0
  const ext = xdrUint32(0);

  return concat([
    sourceAccount,
    feeXdr,
    seqNumXdr,
    preconditions,
    memoXdr,
    xdrArray(operations),
    ext,
  ]);
}

/**
 * Encodes a CHANGE_TRUST operation.
 *
 * XDR:
 *   struct ChangeTrustOp {
 *     Asset line;    // the asset to trust (issued, never native)
 *     int64 limit;   // max units to hold; INT64_MAX means "no limit"
 *   }
 *   Operation { sourceAccount=null, body = union { case CHANGE_TRUST: ... } }
 *   OperationType: CHANGE_TRUST = 6.
 */
function xdrChangeTrustOperation(asset: StellarAssetXdr, limit: bigint): Uint8Array {
  const nullSourcePointer = xdrUint32(0); // MuxedAccount* = null
  const body = concat([xdrUint32(6), xdrAsset(asset), xdrInt64(limit)]); // CHANGE_TRUST = 6
  return concat([nullSourcePointer, body]);
}

/**
 * Encodes a CREATE_ACCOUNT operation.
 *
 * XDR:
 *   struct CreateAccountOp {
 *     AccountID destination;  // the new account's public key
 *     int64 startingBalance;  // XLM it starts with (>= base reserve)
 *   }
 *   OperationType: CREATE_ACCOUNT = 0.
 */
function xdrCreateAccountOperation(destPubkey: Uint8Array, startingBalance: bigint): Uint8Array {
  const nullSourcePointer = xdrUint32(0); // MuxedAccount* = null
  const body = concat([xdrUint32(0), xdrPublicKey(destPubkey), xdrInt64(startingBalance)]);
  return concat([nullSourcePointer, body]);
}

/**
 * Encodes a MANAGE_DATA operation (set a name/value pair on the source
 * account; a null value deletes the entry).
 *
 * XDR:
 *   struct ManageDataOp {
 *     string64 dataName;
 *     DataValue* dataValue;   // pointer: uint32 0 (null) or 1 + opaque<64>
 *   }
 *   OperationType: MANAGE_DATA = 10.
 */
function xdrManageDataOperation(name: string, value: Uint8Array | null): Uint8Array {
  const nameBytes = new TextEncoder().encode(name);
  if (nameBytes.length > 64) {
    throw new Error(`manage_data name is ${nameBytes.length} bytes; the maximum is 64.`);
  }
  if (value !== null && value.length > 64) {
    throw new Error(`manage_data value is ${value.length} bytes; the maximum is 64.`);
  }
  const nullSourcePointer = xdrUint32(0); // MuxedAccount* = null
  const valueXdr = value === null ? xdrUint32(0) : concat([xdrUint32(1), xdrOpaque(value)]);
  const body = concat([xdrUint32(10), xdrString(nameBytes), valueXdr]); // MANAGE_DATA = 10
  return concat([nullSourcePointer, body]);
}

/**
 * Encodes an ACCOUNT_MERGE operation — sweeps the SOURCE account's entire
 * balance (including its base reserve) into the destination and deletes the
 * source account. Used by the privacy layer to claim stealth one-time
 * accounts cleanly, leaving no dust behind.
 *
 * XDR:
 *   union switch (OperationType type) {
 *     case ACCOUNT_MERGE: AccountID destination;   // = 8
 *   }
 * The source account is the transaction's source account, so the operation
 * body is only the destination public key.
 */
function xdrAccountMergeOperation(destPubkey: Uint8Array): Uint8Array {
  const nullSourcePointer = xdrUint32(0); // MuxedAccount* = null
  const body = concat([xdrUint32(8), xdrPublicKey(destPubkey)]); // ACCOUNT_MERGE = 8
  return concat([nullSourcePointer, body]);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Shared build-sign-serialize core: produces a signed TransactionEnvelope
 * for a set of operations from one source account. `sign` computes the
 * 64-byte Ed25519 signature over the network transaction hash; the
 * seed-based wrapper below is the default, and the privacy layer supplies
 * the raw-scalar variant for one-time keys.
 */
function signStellarEnvelopeWithSigner(
  from: string,
  fee: number,
  sequence: bigint,
  memo: StellarMemo,
  operations: Uint8Array[],
  networkPassphrase: string | undefined,
  sign: (txHash: Uint8Array) => Uint8Array,
): SignedStellarTransaction {
  const sourcePubkey = decodeStellarAddress(from);

  // Stellar requires a transaction's seqNum to be the account's CURRENT
  // sequence + 1 (Horizon advances the account's sequence to the tx seqNum
  // once it is included). `sequence` is Horizon's current value, so bump it.
  const seqNum = sequence + 1n;

  const txXdr = xdrTransactionOps(sourcePubkey, fee, seqNum, memo, operations);

  // The network transaction hash is the SHA-256 of the Stellar signature
  // pre-image: `networkId || taggedTransaction`, where networkId binds the
  // transaction to the network's passphrase. Signing only sha256(txXdr)
  // (without the network prefix) makes a signature Horizon always rejects with
  // tx_bad_auth, even though the XDR itself is valid.
  const networkId = stellarNetworkId(networkPassphrase ?? STELLAR_TESTNET_PASSPHRASE);
  const txHash = sha256(stellarSignatureBase(networkId, txXdr));

  // Sign the hash
  const signature = sign(txHash);

  // Build the DecoratedSignature:
  // hint = last 4 bytes of the public key
  const hint = sourcePubkey.subarray(28, 32);
  // signature = opaque<64> = uint32 length + 64 bytes
  const sigXdr = xdrOpaque(signature);
  const decoratedSignature = concat([hint, sigXdr]);

  // Build the TransactionEnvelope (discriminant 2 = TX v1):
  const ENVELOPE_TYPE_TX = 2;
  const envelope = concat([xdrUint32(ENVELOPE_TYPE_TX), txXdr, xdrArray([decoratedSignature])]);

  const fromAddress = encodeStellarAddress(sourcePubkey);

  return {
    raw: btoa(String.fromCharCode(...envelope)),
    signingHash: bytesToHex(txHash),
    from: fromAddress,
  };
}

/**
 * Builds, signs, and serializes a TransactionEnvelope (seed-key signing:
 * `privateKey` is a standard ed25519 seed whose public key must equal `from`).
 */
function signStellarEnvelope(
  from: string,
  fee: number,
  sequence: bigint,
  memo: StellarMemo,
  operations: Uint8Array[],
  networkPassphrase: string | undefined,
  privateKey: Uint8Array,
): SignedStellarTransaction {
  if (privateKey.length !== 32) {
    throw new Error(
      `Stellar private key must be 32 bytes, got ${privateKey.length}.`,
    );
  }
  return signStellarEnvelopeWithSigner(
    from,
    fee,
    sequence,
    memo,
    operations,
    networkPassphrase,
    (txHash) => ed25519.sign(txHash, privateKey),
  );
}

/**
 * Builds, signs, and serializes a Stellar payment transaction.
 *
 * Defaults to a native XLM payment; pass `tx.asset` with `type: 'issued'` to
 * send a specific issued token (asset code + issuer).
 *
 * @param tx - The unsigned payment parameters.
 * @param privateKey - 32-byte ed25519 private key (from vault).
 * @returns The signed transaction envelope as base64 XDR.
 */
export function signStellarPayment(
  tx: UnsignedStellarPayment,
  privateKey: Uint8Array,
): SignedStellarTransaction {
  const destPubkey = decodeStellarAddress(tx.to);
  const asset: StellarAssetXdr = tx.asset ?? { type: 'native' };
  return signStellarEnvelope(
    tx.from,
    tx.fee,
    tx.sequence,
    tx.memo === undefined || tx.memo.trim().length === 0
      ? { kind: 'none' }
      : { kind: 'text', text: tx.memo },
    [xdrPaymentOperation(destPubkey, tx.amount, asset)],
    tx.networkPassphrase,
    privateKey,
  );
}

/** An unsigned Stellar change-trust (trustline) transaction. */
export interface UnsignedStellarChangeTrust {
  /** Stellar address (G...) of the account adding the trustline. */
  from: string;
  /** The issued asset to trust — native is rejected (nothing to trust). */
  asset: StellarAssetXdr;
  /**
   * Trust limit in the asset's smallest unit. INT64_MAX (2^63-1) is the
   * canonical "no limit" value most wallets use.
   */
  limit: bigint;
  /** Account sequence number from Horizon. */
  sequence: bigint;
  /** Base fee in stroops. */
  fee: number;
  /** Network passphrase. Defaults to the Stellar testnet passphrase. */
  networkPassphrase?: string;
}

/** The canonical "no limit" trustline value: 2^63 - 1 stroops-equivalent. */
export const STELLAR_TRUSTLINE_NO_LIMIT = 2n ** 63n - 1n;

/**
 * Builds, signs, and serializes a CHANGE_TRUST transaction — the Stellar
 * equivalent of MetaMask's "add token": the account accepts holding the
 * issued asset, after which payments in it succeed.
 */
export function signStellarChangeTrust(
  tx: UnsignedStellarChangeTrust,
  privateKey: Uint8Array,
): SignedStellarTransaction {
  if (tx.asset.type === 'native' || tx.asset.code === undefined || tx.asset.issuer === undefined) {
    throw new Error('A trustline requires an issued asset (code + issuer), not native XLM.');
  }
  return signStellarEnvelope(
    tx.from,
    tx.fee,
    tx.sequence,
    { kind: 'none' },
    [xdrChangeTrustOperation(tx.asset, tx.limit)],
    tx.networkPassphrase,
    privateKey,
  );
}

/** An unsigned Stellar create-account transaction. */
export interface UnsignedStellarCreateAccount {
  /** Sender (and fee payer) — the funded source account. */
  from: string;
  /** The new account's public key (as a G... strkey). */
  to: string;
  /** Starting balance in stroops; must be ≥ the network base reserve. */
  startingBalance: bigint;
  /** Source account sequence from Horizon. */
  sequence: bigint;
  /** Base fee in stroops. */
  fee: number;
  /**
   * Optional 32-byte hash memo. The privacy send path carries the stealth
   * ephemeral public key here — exactly 32 bytes, exactly what MEMO_HASH is.
   */
  memoHash?: Uint8Array;
  /** Network passphrase. Defaults to the Stellar testnet passphrase. */
  networkPassphrase?: string;
}

/**
 * Builds, signs, and serializes a CREATE_ACCOUNT transaction — used both to
 * fund ordinary accounts and to pay a stealth one-time address (which is, by
 * construction, never previously funded).
 */
export function signStellarCreateAccount(
  tx: UnsignedStellarCreateAccount,
  privateKey: Uint8Array,
): SignedStellarTransaction {
  const destPubkey = decodeStellarAddress(tx.to);
  return signStellarEnvelope(
    tx.from,
    tx.fee,
    tx.sequence,
    tx.memoHash === undefined ? { kind: 'none' } : { kind: 'hash', bytes: tx.memoHash },
    [xdrCreateAccountOperation(destPubkey, tx.startingBalance)],
    tx.networkPassphrase,
    privateKey,
  );
}

/** An unsigned Stellar manage-data transaction. */
export interface UnsignedStellarManageData {
  /** The account the data entry is written to (also the fee payer). */
  from: string;
  /** Data name (≤ 64 bytes). */
  name: string;
  /** Data value (≤ 64 bytes); null deletes the entry. */
  value: Uint8Array | null;
  /** Source account sequence from Horizon. */
  sequence: bigint;
  /** Base fee in stroops. */
  fee: number;
  /** Network passphrase. Defaults to the Stellar testnet passphrase. */
  networkPassphrase?: string;
}

/**
 * Builds, signs, and serializes a MANAGE_DATA transaction — used to publish
 * the account's stealth meta-address (spendPub || viewPub, 64 bytes) so any
 * Veilpay payer can derive private one-time addresses for it.
 */
export function signStellarManageData(
  tx: UnsignedStellarManageData,
  privateKey: Uint8Array,
): SignedStellarTransaction {
  return signStellarEnvelope(
    tx.from,
    tx.fee,
    tx.sequence,
    { kind: 'none' },
    [xdrManageDataOperation(tx.name, tx.value)],
    tx.networkPassphrase,
    privateKey,
  );
}

/** An unsigned Stellar account-merge (sweep) transaction. */
export interface UnsignedStellarAccountMerge {
  /**
   * The account being merged away — the transaction source and fee payer.
   * In the privacy flow this is a stealth one-time address.
   */
  from: string;
  /** The beneficiary who receives the swept balance. */
  to: string;
  /** The source account's current sequence from Horizon. */
  sequence: bigint;
  /** Base fee in stroops, paid from the swept balance. */
  fee: number;
  /** Network passphrase. Defaults to the Stellar testnet passphrase. */
  networkPassphrase?: string;
}

/**
 * Builds, signs, and serializes an ACCOUNT_MERGE transaction — sweeps the
 * source account's ENTIRE balance (including its base reserve) into the
 * destination and deletes the source. Used to claim stealth one-time
 * accounts without leaving an unclaimable dust address behind.
 */
export function signStellarAccountMerge(
  tx: UnsignedStellarAccountMerge,
  privateKey: Uint8Array,
): SignedStellarTransaction {
  const destPubkey = decodeStellarAddress(tx.to);
  return signStellarEnvelope(
    tx.from,
    tx.fee,
    tx.sequence,
    { kind: 'none' },
    [xdrAccountMergeOperation(destPubkey)],
    tx.networkPassphrase,
    privateKey,
  );
}

/**
 * Raw-scalar variant of {@link signStellarAccountMerge} — signs with a
 * stealth one-time key, which is an additive derivation with NO seed, so
 * ed25519.sign (seed model) cannot sign for it. The signature is a standard
 * Ed25519 signature over the explicit scalar (see privacy/stellar-stealth's
 * signWithScalar); it verifies against the one-time address exactly like a
 * seed-derived key's signature would.
 */
export function signStellarAccountMergeWithScalar(
  tx: UnsignedStellarAccountMerge,
  oneTimeScalar: Uint8Array,
): SignedStellarTransaction {
  const destPubkey = decodeStellarAddress(tx.to);
  return signStellarEnvelopeWithSigner(
    tx.from,
    tx.fee,
    tx.sequence,
    { kind: 'none' },
    [xdrAccountMergeOperation(destPubkey)],
    tx.networkPassphrase,
    (txHash) => signWithScalar(txHash, oneTimeScalar),
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function crc16Xmodem(bytes: Uint8Array): number {
  let crc = 0x0000;
  for (const byte of bytes) {
    crc ^= byte << 8;
    for (let i = 0; i < 8; i += 1) {
      crc = (crc & 0x8000) !== 0 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
    }
  }
  return crc & 0xffff;
}

function bytesToHex(bytes: Uint8Array): string {
  let out = '';
  for (const b of bytes) {
    out += b.toString(16).padStart(2, '0');
  }
  return out;
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
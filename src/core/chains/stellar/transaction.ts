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
function decodeStellarAddress(address: string): Uint8Array {
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

/**
 * Encodes the Memo union.
 *
 *   union switch (MemoType type) {
 *     case MEMO_NONE: void;          // 0
 *     case MEMO_TEXT: string<28>;    // 1
 *     ...
 *   }
 *
 * Empty/whitespace-only input collapses to MEMO_NONE so a blank memo field
 * never changes the transaction. Input over 28 UTF-8 bytes throws: memos are
 * load-bearing for exchanges, so truncating silently is worse than failing.
 */
function xdrMemo(memo: string | undefined): Uint8Array {
  const text = memo?.trim() ?? '';
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
 * Encodes a Transaction XDR struct for a payment.
 */
function xdrTransaction(
  sourcePubkey: Uint8Array,
  fee: number,
  seqNum: bigint,
  destPubkey: Uint8Array,
  amount: bigint,
  asset: StellarAssetXdr,
  memo: string | undefined,
): Uint8Array {
  // sourceAccount: AccountID = PUBLIC_KEY_TYPE_ED25519 + 32 bytes
  const sourceAccount = xdrPublicKey(sourcePubkey);
  // fee: uint32
  const feeXdr = xdrUint32(fee);
  // seqNum: uint64
  const seqNumXdr = xdrUint64(seqNum);
  // preconditions: modern `Preconditions` union, PRECOND_NONE (no constraints).
  const preconditions = xdrPreconditionsNone();
  // memo: MEMO_NONE or MEMO_TEXT
  const memoXdr = xdrMemo(memo);
  // operations: Operation[] = [payment operation]
  const operations = xdrArray([xdrPaymentOperation(destPubkey, amount, asset)]);
  // ext: v=0
  const ext = xdrUint32(0);

  return concat([
    sourceAccount,
    feeXdr,
    seqNumXdr,
    preconditions,
    memoXdr,
    operations,
    ext,
  ]);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Builds, signs, and serializes a Stellar payment transaction.
 *
 * Defaults to a native XLM payment; pass `tx.asset` with `type: 'issued'` to
 * send a specific testnet token (asset code + issuer).
 *
 * @param tx - The unsigned payment parameters.
 * @param privateKey - 32-byte ed25519 private key (from vault).
 * @returns The signed transaction envelope as base64 XDR.
 */
export function signStellarPayment(
  tx: UnsignedStellarPayment,
  privateKey: Uint8Array,
): SignedStellarTransaction {
  if (privateKey.length !== 32) {
    throw new Error(
      `Stellar private key must be 32 bytes, got ${privateKey.length}.`,
    );
  }

  const sourcePubkey = decodeStellarAddress(tx.from);
  const destPubkey = decodeStellarAddress(tx.to);

  const asset: StellarAssetXdr = tx.asset ?? { type: 'native' };

  // Stellar requires a transaction's seqNum to be the account's CURRENT
  // sequence + 1 (Horizon advances the account's sequence to the tx seqNum
  // once it is included). `tx.sequence` is Horizon's current value, so bump it.
  const seqNum = tx.sequence + 1n;

  // Build the Transaction XDR
  const txXdr = xdrTransaction(
    sourcePubkey,
    tx.fee,
    seqNum,
    destPubkey,
    tx.amount,
    asset,
    tx.memo,
  );

  // The network transaction hash is the SHA-256 of the Stellar signature
  // pre-image: `networkId || taggedTransaction`, where networkId binds the
  // transaction to the network's passphrase. Signing only sha256(txXdr)
  // (without the network prefix) makes a signature Horizon always rejects with
  // tx_bad_auth, even though the XDR itself is valid.
  const networkId = stellarNetworkId(tx.networkPassphrase ?? STELLAR_TESTNET_PASSPHRASE);
  const txHash = sha256(stellarSignatureBase(networkId, txXdr));

  // Sign the hash
  const signature = ed25519.sign(txHash, privateKey);

  // Build the DecoratedSignature:
  // hint = last 4 bytes of the public key
  const hint = sourcePubkey.subarray(28, 32);
  // signature = opaque<64> = uint32 length + 64 bytes
  const sigXdr = xdrOpaque(signature);
  const decoratedSignature = concat([hint, sigXdr]);

  // Build the TransactionEnvelope:
  //   union TransactionEnvelope switch (EnvelopeType type) {
  //     case ENVELOPE_TYPE_TX_V0: TransactionV0Envelope v0;
  //     case ENVELOPE_TYPE_TX: TransactionV1Envelope v1;
  //     case ENVELOPE_TYPE_TX_FEE_BUMP: FeeBumpTransactionEnvelope feeBump;
  //   };
  // The envelope body is preceded by the union discriminant (2 = TX v1).
  // Omitting it misaligns the whole struct and Horizon cannot decode it.
  const ENVELOPE_TYPE_TX = 2;
  const envelope = concat([xdrUint32(ENVELOPE_TYPE_TX), txXdr, xdrArray([decoratedSignature])]);

  // Compute the from address
  const from = encodeStellarAddress(sourcePubkey);

  return {
    raw: btoa(String.fromCharCode(...envelope)),
    signingHash: bytesToHex(txHash),
    from,
  };
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
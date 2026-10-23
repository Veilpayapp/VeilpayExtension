/**
 * Persisted record contracts for the versioned IndexedDB stores.
 *
 * These are the domain shapes stored in `storage.ts`'s v2 object stores. They
 * are deliberately pure data — no behavior. The canonical encrypted wallet
 * payload stays in the `vault` store (`VaultRecord`); mnemonics, private keys,
 * and PINs never appear in any typed store.
 *
 * SECURITY DEBT (Phase 3 blocker): `PrivacyCommitmentRecord.secret` is a note
 * preimage persisted in PLAINTEXT — a raw IndexedDB/profile dump would expose
 * every unspent note's spending credential. No code writes this store yet
 * (scaffolding only). Before any writer ships: encrypt the record with a
 * vault-derived key, or derive note secrets on demand and persist only the
 * public commitment.
 */

import type { EncryptedBlob } from './crypto';

/** The single encrypted wallet record. `blob` is ciphertext only. */
export interface VaultRecord {
  id: 'primary';
  blob: EncryptedBlob;
  createdAt: number;
  updatedAt: number;
}

/** A validated transaction observed or produced by this wallet. */
export interface TransactionRecord {
  id: string;
  hash: string;
  chain: string;
  address: string;
  from: string;
  to: string;
  amount: string;
  network: string;
  status: 'confirmed' | 'pending' | 'failed';
  timestamp: string;
  type: string;
  raw?: unknown;
}

/** An agent-payment channel (x402). Monetary fields are decimal strings. */
export interface X402ChannelRecord {
  id: string;
  channelId: string;
  service: string;
  limit: string;
  spent: string;
  expiration: number;
  isActive: boolean;
}

/** A dapp/agent session with a bounded lifetime. */
export interface SessionRecord {
  id: string;
  sessionId: string;
  createdAt: number;
  lastActivityAt: number;
  expiresAt: number;
  userAddress: string;
  metadata?: unknown;
}

/** A privacy commitment (Phase 3 scaffolding — NO LIVE WRITER).
 *
 *  WARNING: `secret` is the note's spending preimage and would be stored in
 *  plaintext — see the module-level SECURITY DEBT note. This shape must not
 *  gain a writer until the field is encrypted or eliminated. */
export interface PrivacyCommitmentRecord {
  id: string;
  commitmentId: string;
  nullifier: string;
  secret: string;
  amount: string;
  token: string;
  status: string;
}

/** Append-only audit entry. `entryHash` is a keccak-256 chain. */
export interface AuditLedgerRecord {
  id: string;
  sequence: number;
  timestamp: number;
  operationType: string;
  sanitizedPayload: unknown;
  previousHash: string | null;
  entryHash: string;
}

export type { EncryptedBlob };
/**
 * Audit ledger repository — typed, validated access to the `auditLedger`
 * store (keyPath `sequence`, indexes `timestamp` + `operationType`).
 *
 * The ledger is append-only and hash-chained. This repository owns storage and
 * shape validation; the hash chain is computed by the domain module
 * (`src/core/vap/audit.ts`, `computeEntryHash`), which composes `tail()` and
 * `putAuditEntry`. The repo rejects overwriting an existing sequence.
 */

import { openStorageDatabase } from '@/core/vault/storage';
import { AuditLedgerRecordSchema } from '@/core/vault/storage-schemas';
import type { AuditLedgerRecord } from '@/core/vault/storage-types';

function parse(row: unknown): AuditLedgerRecord {
  return AuditLedgerRecordSchema.parse(row) as AuditLedgerRecord;
}

/**
 * Highest-sequence entry, or undefined on an empty ledger.
 *
 * The store's primary key IS `sequence`, so a `prev` cursor's first row is the
 * tail — O(1) reads instead of materializing the whole ledger on every audit
 * append (appendAudit calls this once per write, so getAll made the ledger
 * quadratically slower as it grew). The returned row is still schema-validated;
 * whole-ledger validation remains `verifyAuditChain`'s job.
 */
export async function tail(): Promise<AuditLedgerRecord | undefined> {
  const db = await openStorageDatabase();
  const cursor = await db.transaction('auditLedger', 'readonly').store.openCursor(null, 'prev');
  return cursor === null ? undefined : parse(cursor.value);
}

/** Persists a fully-formed audit record after validating shape and rejecting an
 *  existing sequence (the ledger is append-only). */
export async function putAuditEntry(record: AuditLedgerRecord): Promise<void> {
  const parsed = parse(record);
  if (parsed.entryHash === '') {
    throw new Error('Audit entryHash must not be empty.');
  }
  const db = await openStorageDatabase();
  const existing = await db.get('auditLedger', parsed.sequence);
  if (existing !== undefined) {
    throw new Error(`Audit sequence ${parsed.sequence} already exists.`);
  }
  await db.put('auditLedger', parsed);
}

export async function getAuditEntry(sequence: number): Promise<AuditLedgerRecord | undefined> {
  const row = await (await openStorageDatabase()).get('auditLedger', sequence);
  return row === undefined ? undefined : parse(row);
}

/** Oldest-first list of all entries (validates shape, not the hash chain). */
export async function readAuditEntries(): Promise<AuditLedgerRecord[]> {
  const rows = await (await openStorageDatabase()).getAll('auditLedger');
  return rows.map(parse).sort((a, b) => a.sequence - b.sequence);
}
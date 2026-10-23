/**
 * Privacy commitments repository — typed access to the `privacyCommitments`
 * store (keyPath `commitmentId`, index `status`).
 *
 * SECURITY: this store is Phase-3 scaffolding with NO LIVE WRITER, and its
 * `secret` field would persist a note's spending preimage in PLAINTEXT. Do
 * not add a writer without first encrypting the record with a vault-derived
 * key (or deriving note secrets on demand and storing only the commitment).
 * See the SECURITY DEBT note in `storage-types.ts`.
 */

import { openStorageDatabase } from '@/core/vault/storage';
import { PrivacyCommitmentRecordSchema } from '@/core/vault/storage-schemas';
import type { PrivacyCommitmentRecord } from '@/core/vault/storage-types';

function parse(row: unknown): PrivacyCommitmentRecord {
  return PrivacyCommitmentRecordSchema.parse(row) as PrivacyCommitmentRecord;
}

export async function putCommitment(record: PrivacyCommitmentRecord): Promise<void> {
  const parsed = parse(record);
  await (await openStorageDatabase()).put('privacyCommitments', parsed);
}

export async function getCommitment(
  commitmentId: string,
): Promise<PrivacyCommitmentRecord | undefined> {
  const row = await (await openStorageDatabase()).get('privacyCommitments', commitmentId);
  return row === undefined ? undefined : parse(row);
}

export async function listCommitmentsByStatus(status: string): Promise<PrivacyCommitmentRecord[]> {
  const rows = await (await openStorageDatabase()).getAllFromIndex(
    'privacyCommitments',
    'status',
    status,
  );
  return rows.map(parse);
}

export async function deleteCommitment(commitmentId: string): Promise<void> {
  await (await openStorageDatabase()).delete('privacyCommitments', commitmentId);
}
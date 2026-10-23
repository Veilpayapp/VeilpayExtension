import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import type { EncryptedBlob } from './crypto';
import type {
  AuditLedgerRecord,
  PrivacyCommitmentRecord,
  SessionRecord,
  TransactionRecord,
  VaultRecord,
  X402ChannelRecord,
} from './storage-types';

/**
 * Encrypted-at-rest storage for the vault.
 *
 * `chrome.storage.local` is deliberately not used for secrets: it is readable by
 * anything with the extension's context and has no size headroom for future
 * note/commitment data. The vault's key material lives here only as ciphertext,
 * so a raw database dump yields nothing without the passphrase. (Exception to
 * audit before Phase 3: the dormant `privacyCommitments` scaffolding has a
 * plaintext `secret` field — see SECURITY DEBT in storage-types.ts. No writer
 * exists today.)
 */

const DB_NAME = 'veilpay';
export const DB_VERSION = 2;
export const DB_OPEN_TIMEOUT_MS = 6_000;

export type {
  AuditLedgerRecord,
  PrivacyCommitmentRecord,
  SessionRecord,
  TransactionRecord,
  VaultRecord,
  X402ChannelRecord,
  EncryptedBlob,
};

export interface VeilpaySchema extends DBSchema {
  vault: {
    key: string;
    value: VaultRecord;
  };
  meta: {
    key: string;
    value: { key: string; value: unknown };
  };
  walletData: {
    key: string;
    value: { id: string; value: unknown };
  };
  transactions: {
    key: string;
    value: TransactionRecord;
    indexes: {
      from: string;
      to: string;
      network: string;
      timestamp: string;
    };
  };
  x402Channels: {
    key: string;
    value: X402ChannelRecord;
    indexes: { service: string; expiration: number };
  };
  sessions: {
    key: string;
    value: SessionRecord;
  };
  privacyCommitments: {
    key: string;
    value: PrivacyCommitmentRecord;
    indexes: { status: string };
  };
  auditLedger: {
    key: number;
    value: AuditLedgerRecord;
    indexes: { timestamp: number; operationType: string };
  };
}

let dbPromise: Promise<IDBPDatabase<VeilpaySchema>> | null = null;

function db(): Promise<IDBPDatabase<VeilpaySchema>> {
  dbPromise ??= openDatabase().catch((cause: unknown) => {
    dbPromise = null;
    throw cause;
  });
  return dbPromise;
}

function openDatabase(): Promise<IDBPDatabase<VeilpaySchema>> {
  let opened: IDBPDatabase<VeilpaySchema> | null = null;
  const opening = openDB<VeilpaySchema>(DB_NAME, DB_VERSION, {
    upgrade(database, oldVersion) {
      // Preserve the original stores for existing v1 installations.
      if (!database.objectStoreNames.contains('vault')) {
        database.createObjectStore('vault', { keyPath: 'id' });
      }
      if (!database.objectStoreNames.contains('meta')) {
        database.createObjectStore('meta', { keyPath: 'key' });
      }

      if (oldVersion < 2) {
        if (!database.objectStoreNames.contains('walletData')) {
          database.createObjectStore('walletData', { keyPath: 'id' });
        }
        if (!database.objectStoreNames.contains('transactions')) {
          const store = database.createObjectStore('transactions', { keyPath: 'hash' });
          store.createIndex('from', 'from');
          store.createIndex('to', 'to');
          store.createIndex('network', 'network');
          store.createIndex('timestamp', 'timestamp');
        }
        if (!database.objectStoreNames.contains('x402Channels')) {
          const store = database.createObjectStore('x402Channels', { keyPath: 'channelId' });
          store.createIndex('service', 'service');
          store.createIndex('expiration', 'expiration');
        }
        if (!database.objectStoreNames.contains('sessions')) {
          database.createObjectStore('sessions', { keyPath: 'sessionId' });
        }
        if (!database.objectStoreNames.contains('privacyCommitments')) {
          const store = database.createObjectStore('privacyCommitments', { keyPath: 'commitmentId' });
          store.createIndex('status', 'status');
        }
        if (!database.objectStoreNames.contains('auditLedger')) {
          const store = database.createObjectStore('auditLedger', { keyPath: 'sequence' });
          store.createIndex('timestamp', 'timestamp');
          store.createIndex('operationType', 'operationType');
        }
      }
    },
    blocked() {
      console.warn('[veilpay] IndexedDB upgrade is blocked by another context.');
    },
    blocking() {
      opened?.close();
    },
    terminated() {
      opened = null;
    },
  });

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(
        new Error(
          'Veilpay storage is busy (a stale connection may be blocking an upgrade). Retry, or Reload the extension.',
        ),
      );
    }, DB_OPEN_TIMEOUT_MS);
  });

  return Promise.race([opening, timeout]).then(
    (database) => {
      if (timer !== undefined) clearTimeout(timer);
      opened = database;
      return database;
    },
    (cause) => {
      if (timer !== undefined) clearTimeout(timer);
      // If a blocked open resolves later, close it rather than leaking a handle.
      void opening.then((database) => database.close()).catch(() => undefined);
      throw cause;
    },
  );
}


export async function readVault(): Promise<VaultRecord | undefined> {
  return (await db()).get('vault', 'primary');
}

export async function writeVault(blob: EncryptedBlob): Promise<void> {
  const now = Date.now();
  const existing = await readVault();
  await (await db()).put('vault', {
    id: 'primary',
    blob,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  });
}

export async function vaultExists(): Promise<boolean> {
  return (await readVault()) !== undefined;
}

/** Destructive. Clears the vault and all application data stores. */
export async function destroyVault(): Promise<void> {
  const database = await db();
  const names = [
    'vault',
    'meta',
    'walletData',
    'transactions',
    'x402Channels',
    'sessions',
    'privacyCommitments',
    'auditLedger',
  ] as const;
  const transaction = database.transaction(names, 'readwrite');
  await Promise.all(names.map((name) => transaction.objectStore(name).clear()));
  await transaction.done;
}

export async function readMeta<T>(key: string): Promise<T | undefined> {
  const row = await (await db()).get('meta', key);
  return row?.value as T | undefined;
}

export async function writeMeta(key: string, value: unknown): Promise<void> {
  await (await db()).put('meta', { key, value });
}

/** Test seam: drops the cached connection so a fresh fake-indexeddb can bind. */
export function resetConnectionForTests(): void {
  dbPromise = null;
}

export function openStorageDatabase(): Promise<IDBPDatabase<VeilpaySchema>> {
  return db();
}

/** Exposes the schema version for migration diagnostics and tests. */
export function storageSchemaVersion(): number {
  return DB_VERSION;
}

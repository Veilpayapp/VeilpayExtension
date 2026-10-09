import * as bip39 from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english';
import { DecryptionFailed, open, seal, wipe } from './crypto';
import { destroyVault, readVault, vaultExists, writeVault } from './storage';
import {
  deriveAccount,
  deriveAllChains,
  toAccountAddress,
  type AccountAddress,
  type Chain,
  type DerivedAccount,
} from './key-derivation';
import { MAX_IDLE_MS, MIN_IDLE_MS, SessionService } from './session';
import { notifyLockListeners } from './lock-hooks';

/**
 * Vault lifecycle, session state, and account derivation.
 *
 * The decrypted mnemonic is held in this module's closure while unlocked and
 * is additionally mirrored into `chrome.storage.session` — Chrome's
 * in-memory, trusted-contexts-only store, wiped when the browser closes and
 * unreadable from content scripts. Without that mirror, an MV3
 * service-worker eviction (which Chrome performs ~30s after the popup
 * closes) relocks the wallet seconds into a 15-minute idle window, and the
 * window the user was promised never actually exists. The mirror preserves
 * the ORIGINAL session timestamps, so an eviction grants no extra unlock
 * time; it only prevents losing time the user already had.
 *
 * `SessionService` is the single authority on whether the session has expired.
 * This module does not keep a second deadline, because two clocks for one
 * decision is how a wallet ends up believing it is locked while still holding a
 * usable key.
 */

export type VaultState = 'uninitialized' | 'locked' | 'unlocked';

/** Idle window before an automatic relock. */
export const DEFAULT_IDLE_MS = 15 * 60 * 1000;
const MIN_PASSPHRASE_LENGTH = 10;

let mnemonicBytes: Uint8Array | null = null;
let sessionService: SessionService | null = null;
let idleMs = DEFAULT_IDLE_MS;
/** One restore attempt per module instance (per service-worker wake). */
let restoreAttempted = false;
let restoreInFlight: Promise<void> | null = null;

const SESSION_STORE_KEY = 'vault:session';

interface PersistedSession {
  mnemonic: string;
  startedAt: number;
  lastActivityAt: number;
  idleMs: number;
}

/**
 * `chrome.storage.session` accessor, or null outside the extension's
 * service worker (tests, non-Chrome hosts). storage.session is in-memory,
 * never touches disk, is cleared on browser exit, and is only readable from
 * trusted extension contexts — the closest thing to this module's closure
 * that survives an MV3 worker eviction.
 */
function sessionStore(): {
  get(key: string): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(key: string): Promise<void>;
} | null {
  const store = globalThis.chrome?.storage?.session;
  if (
    typeof store?.get !== 'function' ||
    typeof store?.set !== 'function' ||
    typeof store?.remove !== 'function'
  ) {
    return null;
  }
  return store as unknown as {
    get(key: string): Promise<Record<string, unknown>>;
    set(items: Record<string, unknown>): Promise<void>;
    remove(key: string): Promise<void>;
  };
}

function isPersistedSession(value: unknown): value is PersistedSession {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.mnemonic === 'string' &&
    candidate.mnemonic.length > 0 &&
    typeof candidate.startedAt === 'number' &&
    typeof candidate.lastActivityAt === 'number' &&
    typeof candidate.idleMs === 'number'
  );
}

/** Reads the live session's timestamps for the persistence snapshot. */
function sessionTimestamps(): { startedAt: number; lastActivityAt: number } | null {
  if (sessionService === null) return null;
  return {
    startedAt: sessionService.sessionStartedAt,
    lastActivityAt: sessionService.sessionLastActivityAt,
  };
}

/** Mirrors the live session into storage.session (best effort, non-fatal). */
function persistSession(): void {
  const timestamps = sessionTimestamps();
  if (sessionService === null || mnemonicBytes === null || timestamps === null) return;
  const store = sessionStore();
  if (store === null) return;
  const snapshot: PersistedSession = {
    mnemonic: new TextDecoder().decode(mnemonicBytes),
    startedAt: timestamps.startedAt,
    lastActivityAt: timestamps.lastActivityAt,
    idleMs,
  };
  void store.set({ [SESSION_STORE_KEY]: snapshot }).catch(() => undefined);
}

/** Best-effort mirror removal; stale rows also fail restore validation. */
function clearPersistedSession(): void {
  const store = sessionStore();
  if (store === null) return;
  void store.remove(SESSION_STORE_KEY).catch(() => undefined);
}

/**
 * Restores a persisted session after a service-worker eviction.
 *
 * Runs once per module instance (per worker wake), before any caller sees
 * state. The restored SessionService keeps the original timestamps, so the
 * idle window continues where it left off; an already-expired (or malformed,
 * or vault-less) row is discarded instead of revived.
 */
async function ensureSessionRestored(): Promise<void> {
  if (restoreAttempted && restoreInFlight === null) return;
  if (restoreInFlight !== null) return restoreInFlight;
  restoreAttempted = true;
  restoreInFlight = (async () => {
    if (mnemonicBytes !== null) return; // already unlocked in this instance
    const store = sessionStore();
    if (store === null) return;
    try {
      const stored = await store.get(SESSION_STORE_KEY);
      const entry = stored?.[SESSION_STORE_KEY];
      if (!isPersistedSession(entry)) {
        if (entry !== undefined) {
          await store.remove(SESSION_STORE_KEY).catch(() => undefined);
        }
        return;
      }
      // Reconstruct with the ORIGINAL timestamps; if the window has already
      // elapsed, SessionService reports inactive and the vault stays locked.
      const restored = new SessionService(entry.idleMs, Date.now(), {
        startedAt: entry.startedAt,
        lastActivityAt: entry.lastActivityAt,
      });
      if (!restored.isActive()) {
        await store.remove(SESSION_STORE_KEY).catch(() => undefined);
        return;
      }
      if (!(await vaultExists())) {
        // The vault was reset while a session row lingered — drop the row.
        await store.remove(SESSION_STORE_KEY).catch(() => undefined);
        return;
      }
      mnemonicBytes = new TextEncoder().encode(entry.mnemonic);
      sessionService = restored;
      idleMs = entry.idleMs;
    } catch {
      // Unreadable storage — treat as no persisted session.
    } finally {
      restoreInFlight = null;
    }
  })();
  return restoreInFlight;
}

export class WeakPassphrase extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WeakPassphrase';
  }
}

export class VaultLocked extends Error {
  constructor() {
    super('The wallet is locked.');
    this.name = 'VaultLocked';
  }
}

export class VaultAlreadyExists extends Error {
  constructor() {
    super('A vault already exists. Reset it before creating a new one.');
    this.name = 'VaultAlreadyExists';
  }
}

/**
 * Rejects passphrases that are trivially weak.
 *
 * Length dominates strength for a PBKDF2-stretched secret, so this checks length
 * and basic variety rather than imposing a rigid character-class matrix that
 * pushes people toward predictable substitutions.
 */
export function assertPassphraseAcceptable(passphrase: string): void {
  if (passphrase.length < MIN_PASSPHRASE_LENGTH) {
    throw new WeakPassphrase(
      `Use at least ${MIN_PASSPHRASE_LENGTH} characters. Longer is better than complex.`,
    );
  }
  if (/^(.)\1*$/.test(passphrase)) {
    throw new WeakPassphrase('That passphrase is a single repeated character.');
  }
  if (new Set(passphrase).size < 5) {
    throw new WeakPassphrase('That passphrase uses too few distinct characters.');
  }
}

export function generateMnemonic(strength: 128 | 256 = 256): string {
  return bip39.generateMnemonic(wordlist, strength);
}

export function validateMnemonic(mnemonic: string): boolean {
  return bip39.validateMnemonic(mnemonic.trim().replace(/\s+/g, ' '), wordlist);
}

/** Relocks if the session has expired. Safe to call on any code path. */
function enforceExpiry(): void {
  if (sessionService !== null && !sessionService.isActive()) {
    lock();
  }
}

export async function getState(): Promise<VaultState> {
  await ensureSessionRestored();
  enforceExpiry();
  if (mnemonicBytes !== null) return 'unlocked';
  return (await vaultExists()) ? 'locked' : 'uninitialized';
}

export function unlockedUntil(): number | null {
  enforceExpiry();
  if (sessionService === null) return null;
  return Date.now() + sessionService.timeRemaining();
}

function beginSession(bytes: Uint8Array): void {
  mnemonicBytes = bytes;
  sessionService = new SessionService(idleMs);
  persistSession();
}

/** Creates the vault and leaves it unlocked. */
export async function create(mnemonic: string, passphrase: string): Promise<void> {
  if (await vaultExists()) {
    throw new VaultAlreadyExists();
  }
  assertPassphraseAcceptable(passphrase);

  const normalized = mnemonic.trim().replace(/\s+/g, ' ');
  if (!validateMnemonic(normalized)) {
    throw new Error('That recovery phrase is not valid BIP-39.');
  }

  const bytes = new TextEncoder().encode(normalized);
  try {
    await writeVault(await seal(passphrase, bytes));
    beginSession(bytes.slice());
  } finally {
    wipe(bytes);
  }
}

export async function unlock(passphrase: string): Promise<void> {
  const record = await readVault();
  if (record === undefined) {
    throw new Error('No vault to unlock.');
  }
  // Propagates DecryptionFailed, which is uniform for wrong passphrase and
  // tampered ciphertext alike.
  beginSession(await open(passphrase, record.blob));
}

export function lock(): void {
  const wasUnlocked = mnemonicBytes !== null;
  if (mnemonicBytes !== null) {
    wipe(mnemonicBytes);
    mnemonicBytes = null;
  }
  sessionService?.stop();
  sessionService = null;
  clearPersistedSession();
  if (wasUnlocked) notifyLockListeners();
}

/**
 * Extends the idle window. Call on genuine user interaction only.
 *
 * Agent-initiated work deliberately does not call this: an autonomous payment
 * loop must not be able to hold the wallet open indefinitely.
 */
export function touch(): void {
  enforceExpiry();
  sessionService?.recordActivity();
  persistSession();
}

export function setIdleTimeout(ms: number): void {
  if (!Number.isFinite(ms) || ms < MIN_IDLE_MS || ms > MAX_IDLE_MS) {
    throw new RangeError('Idle timeout must be between 5 and 60 minutes.');
  }
  idleMs = ms;
  sessionService?.setIdleTimeout(ms);
  persistSession();
}

/**
 * Whether a human interacted recently.
 *
 * The agent-payment layer uses this to require fresh confirmation for
 * higher-value operations instead of treating "unlocked" as "supervised".
 */
export function hasRecentActivity(withinMs = 60_000): boolean {
  enforceExpiry();
  return sessionService?.hasRecentActivity(withinMs) ?? false;
}

/**
 * Runs `fn` against the decrypted mnemonic without handing it to the caller.
 *
 * Signing and address derivation go through here so the secret's lifetime stays
 * bounded by a single call and cannot be captured by a caller holding a
 * reference.
 */
export async function withMnemonic<T>(fn: (mnemonic: string) => Promise<T>): Promise<T> {
  return withMnemonicInternal(fn, true);
}

async function withMnemonicInternal<T>(
  fn: (mnemonic: string) => Promise<T>,
  recordActivity: boolean,
): Promise<T> {
  // A freshly-woken service worker has an empty closure; the persisted
  // session must be revived before "locked" can be reported, or a valid
  // 15-minute session would break on the first message after an eviction.
  await ensureSessionRestored();
  enforceExpiry();
  if (mnemonicBytes === null) {
    throw new VaultLocked();
  }
  if (recordActivity) touch();
  return fn(new TextDecoder().decode(mnemonicBytes));
}

/**
 * Derives an account and immediately discards its private key.
 *
 * This is the only derivation entry point exposed to callers outside the
 * background worker, because returning a `DerivedAccount` would put key
 * material in the caller's hands.
 */
export async function getAccountAddress(
  chain: Chain,
  index = 0,
): Promise<AccountAddress> {
  return withMnemonic(async (mnemonic) => {
    const account = deriveAccount(mnemonic, chain, index);
    try {
      return toAccountAddress(account);
    } finally {
      wipe(account.privateKey);
    }
  });
}

/** One address per chain at the same account index. */
export async function getAllAccountAddresses(index = 0): Promise<AccountAddress[]> {
  return withMnemonic(async (mnemonic) => {
    const accounts = deriveAllChains(mnemonic, index);
    try {
      return accounts.map(toAccountAddress);
    } finally {
      for (const account of accounts) wipe(account.privateKey);
    }
  });
}

/**
 * Derives an account, hands it to `fn`, then zeroizes the private key.
 *
 * Signing must use this rather than `getAccountAddress`, and must not retain the
 * account past the callback.
 */
export async function withAccount<T>(
  chain: Chain,
  index: number,
  fn: (account: DerivedAccount) => Promise<T>,
): Promise<T> {
  return withMnemonicInternal(async (mnemonic) => {
    const account = deriveAccount(mnemonic, chain, index);
    try {
      return await fn(account);
    } finally {
      wipe(account.privateKey);
    }
  }, false);
}

/** Destructive: wipes the encrypted vault. Requires a confirmed reset flow. */
export async function reset(): Promise<void> {
  lock();
  await destroyVault();
}

/** Test seam: drops session state without touching stored ciphertext. */
export function resetSessionForTests(): void {
  lock();
  idleMs = DEFAULT_IDLE_MS;
}

export { DecryptionFailed };
export type { AccountAddress, Chain, DerivedAccount };

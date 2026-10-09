import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Service-worker eviction survival for the unlocked vault session.
 *
 * MV3 kills the background worker ~30s after the popup closes. Before the
 * chrome.storage.session mirror, every eviction wiped the in-memory mnemonic
 * and the wallet relocked seconds into its promised 15-minute idle window.
 * These tests re-import the vault module (a fresh closure = a revived
 * worker) and prove the session continues, expires honestly, and never
 * leaks extra unlock time.
 */

const PHRASE =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const PASSPHRASE = 'correct-horse-battery-staple';
const SESSION_KEY = 'vault:session';

type SessionMap = Record<string, unknown>;

/** In-memory stand-in for chrome.storage.session contents. */
let sessionStorage: SessionMap = {};

/**
 * The setup stub installs vi.fn()s for storage.session; retyping them here
 * avoids fighting Chrome's overloaded signatures while keeping the same
 * call shapes the vault uses (single key / object / remove).
 */
function stubSessionStore(): void {
  const get = chrome.storage.session.get as unknown as ReturnType<typeof vi.fn>;
  const set = chrome.storage.session.set as unknown as ReturnType<typeof vi.fn>;
  const remove = chrome.storage.session.remove as unknown as ReturnType<typeof vi.fn>;

  get.mockImplementation(async (keys?: string | string[] | null) => {
    if (keys === undefined || keys === null) return { ...sessionStorage };
    const list = Array.isArray(keys) ? keys : [keys];
    const out: SessionMap = {};
    for (const k of list) {
      if (typeof k === 'string' && k in sessionStorage) out[k] = sessionStorage[k];
    }
    return out;
  });
  set.mockImplementation(async (items: SessionMap) => {
    Object.assign(sessionStorage, items);
  });
  remove.mockImplementation(async (keys: string | string[]) => {
    for (const k of Array.isArray(keys) ? keys : [keys]) delete sessionStorage[k];
  });
}

beforeEach(async () => {
  vi.resetModules();
  sessionStorage = {};
  stubSessionStore();

  // Fresh module graph: the vault, and a clean vault store per test.
  const vault = await import('@/core/vault');
  vault.resetSessionForTests();
  await vault.reset();
});

describe('vault session survives service-worker eviction', () => {
  it('restores the unlocked session (and the usable mnemonic) after re-import', async () => {
    const vaultA = await import('@/core/vault');
    await vaultA.create(PHRASE, PASSPHRASE);
    expect(await vaultA.getState()).toBe('unlocked');

    const before = await vaultA.getAllAccountAddresses(0);

    // The mirror was written on unlock.
    const snapshot = sessionStorage[SESSION_KEY] as { mnemonic: string };
    expect(snapshot?.mnemonic).toBe(PHRASE);

    // Simulate the eviction: brand-new module closure, same browser session.
    vi.resetModules();
    const vaultB = await import('@/core/vault');

    expect(await vaultB.getState()).toBe('unlocked');
    // The mnemonic is actually usable in the revived instance — same
    // addresses as before the eviction.
    expect(await vaultB.getAllAccountAddresses(0)).toEqual(before);
  });

  it('restores with the ORIGINAL timestamps — no extra unlock time', async () => {
    // A session that started 10 minutes ago with a 15-minute window has
    // 5 minutes left, not 15.
    const vaultA = await import('@/core/vault');
    await vaultA.create(PHRASE, PASSPHRASE);
    const snapshot = sessionStorage[SESSION_KEY] as {
      startedAt: number;
      lastActivityAt: number;
    };
    // Age the persisted session by 10 minutes.
    snapshot.startedAt = Date.now() - 10 * 60 * 1000;
    snapshot.lastActivityAt = Date.now() - 10 * 60 * 1000;
    sessionStorage[SESSION_KEY] = snapshot;

    vi.resetModules();
    const vaultB = await import('@/core/vault');
    expect(await vaultB.getState()).toBe('unlocked');

    const remaining = vaultB.unlockedUntil()! - Date.now();
    expect(remaining).toBeGreaterThan(4 * 60 * 1000);
    expect(remaining).toBeLessThanOrEqual(5 * 60 * 1000 + 1000);
  });

  it('does not restore an expired session and drops the stale row', async () => {
    const vaultA = await import('@/core/vault');
    await vaultA.create(PHRASE, PASSPHRASE);
    const snapshot = sessionStorage[SESSION_KEY] as {
      startedAt: number;
      lastActivityAt: number;
    };
    // 20 minutes of idleness with a 15-minute window: expired.
    snapshot.lastActivityAt = Date.now() - 20 * 60 * 1000;
    snapshot.startedAt = Date.now() - 20 * 60 * 1000;
    sessionStorage[SESSION_KEY] = snapshot;

    vi.resetModules();
    const vaultB = await import('@/core/vault');

    expect(await vaultB.getState()).toBe('locked');
    await expect(vaultB.getAllAccountAddresses(0)).rejects.toThrow(
      (await import('@/core/vault')).VaultLocked,
    );
    // The stale row was removed, so later wakes stay locked.
    expect(SESSION_KEY in sessionStorage).toBe(false);
  });

  it('lock() removes the persisted session — nothing survives an explicit lock', async () => {
    const vaultA = await import('@/core/vault');
    await vaultA.create(PHRASE, PASSPHRASE);
    expect(SESSION_KEY in sessionStorage).toBe(true);

    vaultA.lock();

    expect(SESSION_KEY in sessionStorage).toBe(false);
    vi.resetModules();
    const vaultB = await import('@/core/vault');
    expect(await vaultB.getState()).toBe('locked');
  });

  it('a malformed persisted row is ignored (never crashes the worker wake)', async () => {
    const vaultA = await import('@/core/vault');
    await vaultA.create(PHRASE, PASSPHRASE);
    sessionStorage[SESSION_KEY] = { garbage: true };

    vi.resetModules();
    const vaultB = await import('@/core/vault');
    expect(await vaultB.getState()).toBe('locked');
    expect(SESSION_KEY in sessionStorage).toBe(false);
  });
});

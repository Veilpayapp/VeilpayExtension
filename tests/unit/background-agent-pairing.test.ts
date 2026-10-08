import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Regression test for the reported failure: "Could not connect — This relay
 * (…) does not recognize that code."
 *
 * A hosted relay keeps wallets and pairing codes in memory, so a restart
 * (free-tier sleep, a deploy) wipes them. The Settings panel asks the
 * background for the code to display; before the fix, that request failed with
 * 401 and the panel kept showing a dead code — the exact code the user then
 * typed into the AI client. The handler must detect `wallet_unknown`,
 * re-register with the relay, and answer with the fresh code.
 *
 * These drive the REAL background module through its message listener, against
 * a fake relay, so the healing logic is exercised where it lives.
 */

type MessageListener = (
  message: unknown,
  sender: chrome.runtime.MessageSender,
  sendResponse: (response: unknown) => void
) => boolean;

const BASE = 'https://relay.example';
const EXT_ORIGIN = 'chrome-extension://veilpay-test';
const SENDER = { url: `${EXT_ORIGIN}/options.html` } as chrome.runtime.MessageSender;
const REQUEST_ID = '11111111-1111-1111-1111-111111111111';

let listener: MessageListener | undefined;
let store: Map<string, unknown>;

/** A minimal Response: the handler only reads ok, status, and json(). */
function res(status: number, body: unknown): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as unknown as Response;
}

function header(init: { headers?: unknown } | undefined, name: string): string | undefined {
  const headers = init?.headers;
  if (typeof headers !== 'object' || headers === null) return undefined;
  const value = (headers as Record<string, string>)[name];
  return typeof value === 'string' ? value : undefined;
}

/**
 * The fake relay. `wipe()` simulates the free-tier restart that dropped every
 * wallet; otherwise it answers /wallet/pairing-code and /wallet/register like
 * the real one, including the wallet_unknown vs bad_secret distinction.
 */
function makeRelay() {
  const wallets = new Map<string, { secret: string; code: string; expiresAt: number }>();
  let issued = 0;
  const register = () => {
    issued += 1;
    const walletId = `wallet-${issued}`;
    const entry = { secret: `secret-${issued}`, code: `C0DE-000${issued}`, expiresAt: 2_000_000_000_000 };
    wallets.set(walletId, entry);
    return { walletId, secret: entry.secret, pairing: { code: entry.code, expiresAt: entry.expiresAt } };
  };
  const fetchImpl = vi.fn(async (input: unknown, init?: { headers?: unknown }): Promise<Response> => {
    const url = String(input);
    if (url === `${BASE}/wallet/pairing-code`) {
      const walletId = header(init, 'x-veilpay-wallet');
      const wallet = wallets.get(walletId ?? '');
      if (wallet === undefined) {
        return res(401, { ok: false, error: 'Unknown wallet or bad secret.', code: 'wallet_unknown' });
      }
      if (wallet.secret !== header(init, 'x-veilpay-secret')) {
        return res(401, { ok: false, error: 'Unknown wallet or bad secret.', code: 'bad_secret' });
      }
      return res(200, { ok: true, code: wallet.code, expiresAt: wallet.expiresAt });
    }
    if (url === `${BASE}/wallet/register`) {
      return res(200, register());
    }
    if (url.endsWith('/next')) {
      // Park the poll loop: its long-poll must never resolve mid-test, or the
      // poller's own recovery would race the handler under test.
      return new Promise<Response>(() => undefined);
    }
    throw new Error(`unexpected fetch: ${url}`);
  });
  return { fetchImpl, wipe: () => wallets.clear(), register };
}

let relay: ReturnType<typeof makeRelay>;

/** Seeds the stored bridge config — the wallet the extension believes it has. */
function seedConfig(walletId: string, secret: string): void {
  store.set('agent:bridge', {
    mode: 'relay',
    baseUrl: BASE,
    token: secret,
    walletId,
    pairedAt: Date.now(),
  });
}

/** The same chrome surface the global stub provides, with working storage. */
function makeChrome() {
  return {
    runtime: {
      id: 'veilpay-test',
      sendMessage: vi.fn(),
      getURL: (path: string) => `${EXT_ORIGIN}/${path}`,
      onMessage: { addListener: vi.fn((fn: MessageListener) => (listener = fn)) },
      onInstalled: { addListener: vi.fn() },
      onStartup: { addListener: vi.fn() },
      openOptionsPage: vi.fn(),
    },
    storage: {
      local: {
        get: vi.fn(async (key: string) => (store.has(key) ? { [key]: store.get(key) } : {})),
        set: vi.fn(async (payload: Record<string, unknown>) => {
          for (const [key, value] of Object.entries(payload)) store.set(key, value);
        }),
        remove: vi.fn(async (key: string) => {
          store.delete(key);
        }),
      },
      session: {
        get: vi.fn(async () => ({})),
        set: vi.fn(async () => undefined),
        remove: vi.fn(async () => undefined),
      },
    },
    action: { openPopup: vi.fn(async () => undefined) },
    alarms: { create: vi.fn(), onAlarm: { addListener: vi.fn() } },
    offscreen: {
      createDocument: vi.fn(async () => undefined),
      closeDocument: vi.fn(async () => undefined),
      Reason: { WORKERS: 'WORKERS' },
    },
    contextMenus: {
      removeAll: vi.fn(),
      create: vi.fn(),
      onClicked: { addListener: vi.fn() },
    },
  };
}

function request(kind: string, payload: unknown): Promise<Record<string, unknown>> {
  const bound = listener;
  if (bound === undefined) throw new Error('background listener was not registered');
  return new Promise((resolve) => {
    bound(
      { id: REQUEST_ID, v: 1, source: 'options', kind, payload },
      SENDER,
      (response) => resolve(response as Record<string, unknown>)
    );
  });
}

async function loadBackground(): Promise<void> {
  await import('@/background/index');
}

beforeEach(() => {
  store = new Map();
  listener = undefined;
  relay = makeRelay();
  vi.stubGlobal('fetch', relay.fetchImpl);
  globalThis.chrome = makeChrome() as unknown as typeof chrome;
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe('agent.relay.pairing-code self-healing', () => {
  it('re-registers and returns the fresh code when the relay forgot the wallet', async () => {
    await loadBackground();
    seedConfig('wallet-gone', 'secret-gone');

    const response = await request('agent.relay.pairing-code', {});

    expect(response.ok).toBe(true);
    const data = response.data as { pairingCode: string; pairingCodeExpiresAt: number };
    // The fresh registration's code — not an error, and not the dead code.
    expect(data.pairingCode).toBe('C0DE-0001');
    expect(data.pairingCodeExpiresAt).toBe(2_000_000_000_000);

    // The stored config was replaced with the re-registered wallet.
    const saved = store.get('agent:bridge') as Record<string, unknown>;
    expect(saved.walletId).toBe('wallet-1');
    expect(saved.token).toBe('secret-1');
  });

  it('keeps answering the live code once the wallet is known again', async () => {
    await loadBackground();
    const { walletId, secret, pairing } = relay.register();
    seedConfig(walletId, secret);

    const response = await request('agent.relay.pairing-code', {});

    expect(response.ok).toBe(true);
    const data = response.data as { pairingCode: string };
    expect(data.pairingCode).toBe(pairing.code);
    // A known wallet must not be silently re-registered.
    expect(relay.fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('does not re-register on a bad secret — a mismatch must not replace a wallet', async () => {
    await loadBackground();
    const { walletId } = relay.register();
    seedConfig(walletId, 'wrong-secret');

    const response = await request('agent.relay.pairing-code', {});

    expect(response.ok).toBe(false);
    const error = response.error as { message: string };
    expect(error.message).toBe('The relay refused a pairing code (HTTP 401).');
    const calls = relay.fetchImpl.mock.calls.map(([input]) => String(input));
    expect(calls).toEqual([`${BASE}/wallet/pairing-code`]);
  });

  it('respects the recovery cooldown for automatic refreshes but a manual click bypasses it', async () => {
    await loadBackground();
    seedConfig('wallet-gone-1', 'secret-gone-1');

    // First ask heals (no cooldown has been set yet).
    const first = await request('agent.relay.pairing-code', {});
    expect(first.ok).toBe(true);
    expect((first.data as { pairingCode: string }).pairingCode).toBe('C0DE-0001');

    // The relay restarts again, immediately: the background recovery cooldown
    // (30 s) is still active, so the panel's automatic refresh is told the
    // relay restarted instead of silently keeping a dead code on screen.
    relay.wipe();
    const second = await request('agent.relay.pairing-code', {});
    expect(second.ok).toBe(false);
    expect((second.error as { message: string }).message).toContain('restarted');

    // A human clicked the button: manual bypasses the cooldown and heals now.
    const third = await request('agent.relay.pairing-code', { manual: true });
    expect(third.ok).toBe(true);
    expect((third.data as { pairingCode: string }).pairingCode).toBe('C0DE-0002');
    const saved = store.get('agent:bridge') as Record<string, unknown>;
    expect(saved.walletId).toBe('wallet-2');
  });
});

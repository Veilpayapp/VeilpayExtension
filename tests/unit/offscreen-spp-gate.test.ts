import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The offscreen document's spp:exec gate, driven through the REAL offscreen
 * listener (`src/offscreen/index.ts`).
 *
 * The SPP host submits pool transactions directly, bypassing the request
 * bus's validation, preflight, and audit — by design, because the bus cannot
 * host the SDK. The ONLY legitimate driver is the background service worker;
 * these tests prove the registered listener accepts it and rejects every
 * other extension context (popup page, content script).
 */

type Listener = (
  message: unknown,
  sender: chrome.runtime.MessageSender,
  sendResponse: (response: unknown) => void,
) => boolean | undefined;

let registeredListener: Listener | undefined;

beforeEach(() => {
  registeredListener = undefined;
  vi.mocked(chrome.runtime.onMessage.addListener).mockImplementation((listener) => {
    // The offscreen module registers exactly one runtime.onMessage listener.
    registeredListener = listener as Listener;
  });
  // The offscreen document reads the worker URL from its PACKAGED manifest
  // (offscreen documents have no chrome.runtime.getManifest); stub the
  // resource fetch so the module resolves the test manifest's worker.
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({
      ok: true,
      json: async () => ({
        manifest_version: 3,
        background: { service_worker: 'service-worker-loader.js', type: 'module' },
      }),
    })),
  );
  vi.resetModules();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** The URL of the background service worker in the test manifest. */
function workerUrl(): string {
  const background = chrome.runtime.getManifest().background;
  if (background === undefined || !('service_worker' in background)) {
    throw new Error('test manifest lacks a service worker entry');
  }
  return chrome.runtime.getURL(background.service_worker);
}

/** The sender Chrome stamps for the background service worker. */
function workerSender(): chrome.runtime.MessageSender {
  return { id: chrome.runtime.id, url: workerUrl() };
}

function popupSender(): chrome.runtime.MessageSender {
  return { id: chrome.runtime.id, url: chrome.runtime.getURL('popup.html') };
}

function contentScriptSender(): chrome.runtime.MessageSender {
  return {
    id: chrome.runtime.id,
    url: 'https://evil.example.com/page.html',
    tab: { id: 42 } as chrome.tabs.Tab,
  };
}

function execRequest(): unknown {
  return {
    channel: 'veilpay:internal',
    kind: 'spp:exec',
    id: 'exec-1',
    op: 'status',
    payload: { address: 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF' },
  };
}

function send(message: unknown, sender: chrome.runtime.MessageSender): Promise<unknown> {
  return new Promise((resolve) => {
    registeredListener?.(message, sender, resolve);
  });
}

describe('offscreen spp:exec gate', () => {
  it('accepts the background worker and EXECUTES the op (fails only at SDK load in jsdom)', async () => {
    await import('@/offscreen/index');

    const response = await send(execRequest(), workerSender());
    // The gate passed: the op ran and failed where jsdom must fail it — the
    // SPP SDK URL import — NOT at the trust boundary. This distinguishes a
    // gate-accepted execution from a gate rejection.
    expect(response).toMatchObject({ ok: false });
    const message = (response as { message?: unknown }).message;
    expect(typeof message).toBe('string');
    expect(message).not.toContain('untrusted sender');
  });

  it('rejects an spp:exec from a popup page without executing it', async () => {
    await import('@/offscreen/index');

    const response = await send(execRequest(), popupSender());
    expect(response).toEqual({ ok: false, message: 'Rejected: untrusted sender.' });
  });

  it('rejects an spp:exec from a content-script sender without executing it', async () => {
    await import('@/offscreen/index');

    const response = await send(execRequest(), contentScriptSender());
    expect(response).toEqual({ ok: false, message: 'Rejected: untrusted sender.' });
  });

  it('rejects an spp:exec from a foreign extension id', async () => {
    await import('@/offscreen/index');

    const response = await send(execRequest(), {
      id: 'some-other-extension',
      url: workerUrl(),
    });
    expect(response).toEqual({ ok: false, message: 'Rejected: untrusted sender.' });
  });

  it('ignores non-spp:exec messages entirely (returns false, no response)', async () => {
    await import('@/offscreen/index');

    let responded = false;
    const keepsOpen = registeredListener?.(
      { channel: 'veilpay:internal', kind: 'spp:ping', id: 'ping-1' },
      workerSender(),
      () => {
        responded = true;
      },
    );
    expect(keepsOpen).toBe(false);
    expect(responded).toBe(false);
  });
});

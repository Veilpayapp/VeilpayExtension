import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The background's internal-channel gate (`veilpay:internal`), driven through
 * the REAL service-worker message listener.
 *
 * The internal channel carries the SPP signing callbacks (`spp:sign`), whose
 * `signTransaction` arm signs wallet-sourced Soroban envelopes with no
 * approval surface, and the keepalive pings. The ONLY legitimate speaker is
 * the offscreen document — these tests prove the registered listener answers
 * it and rejects every other extension context (popup page, content script),
 * so a compromised UI page cannot reach the signer bridge.
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
    // The background registers exactly one runtime.onMessage listener; keep
    // the latest registered one (same pattern as background-message.test.ts).
    registeredListener = listener as Listener;
  });
  vi.resetModules();
});

/** The sender Chrome stamps for the offscreen document's own messages. */
function offscreenSender(): chrome.runtime.MessageSender {
  return { id: chrome.runtime.id, url: chrome.runtime.getURL('offscreen.html') };
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

function send(message: unknown, sender: chrome.runtime.MessageSender): Promise<unknown> {
  return new Promise((resolve) => {
    const keepsOpen = registeredListener?.(message, sender, resolve);
    if (keepsOpen !== true) {
      // The listener only answers synchronously on synchronous rejection
      // paths; the promise above already resolved in that case.
      expect(keepsOpen).toBe(false);
    }
  });
}

describe('background internal-channel gate', () => {
  it('answers a keepalive ping from the offscreen document', async () => {
    await import('@/background/index');

    const response = await send(
      { channel: 'veilpay:internal', kind: 'spp:ping', id: 'ping-1' },
      offscreenSender(),
    );
    expect(response).toEqual({ ok: true });
  });

  it('rejects an spp:sign request from a popup page (the signer bridge is offscreen-only)', async () => {
    await import('@/background/index');

    const response = await send(
      {
        channel: 'veilpay:internal',
        kind: 'spp:sign',
        id: 'sign-1',
        op: 'signMessage',
        address: 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF',
        message: 'Privacy Pool Key Derivation [v2] (Veilpay)',
      },
      popupSender(),
    );
    // Rejected before the vault is even consulted — no signature oracle for
    // a compromised UI page.
    expect(response).toEqual({ ok: false });
  });

  it('rejects internal messages from a content-script sender', async () => {
    await import('@/background/index');

    const response = await send(
      { channel: 'veilpay:internal', kind: 'spp:ping', id: 'ping-2' },
      contentScriptSender(),
    );
    expect(response).toEqual({ ok: false });
  });

  it('rejects internal messages from a foreign extension id', async () => {
    await import('@/background/index');

    const response = await send(
      { channel: 'veilpay:internal', kind: 'spp:ping', id: 'ping-3' },
      { id: 'some-other-extension', url: chrome.runtime.getURL('offscreen.html') },
    );
    expect(response).toEqual({ ok: false });
  });
});

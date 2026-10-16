import { describe, expect, it } from 'vitest';
import {
  INTERNAL_CHANNEL,
  isBackgroundWorkerSender,
  isExtensionPageSender,
  isOffscreenDocumentSender,
  isSppExecRequest,
  isSppPing,
  isSppSignRequest,
  type SppExecOp,
  type SppExecRequest,
  type SppSignOp,
  type SppSignRequest,
} from '@/core/spp/internal-protocol';

/**
 * The internal control-plane guards are the ONLY thing standing between
 * `chrome.runtime.onMessage` traffic and the offscreen SPP host / the
 * background's vault signer. They run before any handler, so their reject
 * cases are the security boundary: a malformed or foreign message must never
 * reach the executor.
 */

const EXEC_OPS = ['status', 'register', 'deposit', 'transfer', 'withdraw', 'sync'] as const;
const SIGN_OPS = ['signMessage', 'signTransaction', 'signAuthEntry'] as const;

function validExec(op: SppExecOp = 'status'): SppExecRequest {
  return {
    channel: INTERNAL_CHANNEL,
    kind: 'spp:exec',
    id: 'exec-1',
    op,
    payload: { address: 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF' },
  };
}

function validSign(op: SppSignOp = 'signMessage'): SppSignRequest {
  return {
    channel: INTERNAL_CHANNEL,
    kind: 'spp:sign',
    id: 'sign-1',
    op,
    address: 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF',
    message: 'Privacy Pool Key Derivation [v2] (Veilpay)',
  };
}

function validPing() {
  return { channel: INTERNAL_CHANNEL, kind: 'spp:ping', id: 'ping-1' };
}

/** Every non-object input a message listener can receive. */
const NON_OBJECTS = [
  ['null', null],
  ['undefined', undefined],
  ['a string', 'spp:exec'],
  ['a number', 42],
  ['a boolean', true],
  ['an array', [1, 2, 3]],
] as const;

describe('isSppExecRequest', () => {
  it.each(EXEC_OPS)('accepts a well-formed exec request (op=%s)', (op) => {
    expect(isSppExecRequest(validExec(op))).toBe(true);
  });

  it('accepts a payload carrying extra fields the guard does not model', () => {
    // The guard is structural: extra fields (amountStroops, to, …) are for
    // the executor to validate, not the guard.
    const request = { ...validExec('transfer'), payload: { address: 'G…', to: 'G…', extra: 1 } };
    expect(isSppExecRequest(request)).toBe(true);
  });

  it.each([
    ['a foreign channel', { ...validExec(), channel: 'veilpay:bus' }],
    ['a missing channel', { ...validExec(), channel: undefined }],
    ['a wrong kind', { ...validExec(), kind: 'spp:sign' }],
    ['a missing kind', { ...validExec(), kind: undefined }],
    ['a non-string id', { ...validExec(), id: 7 }],
    ['a missing id', { ...validExec(), id: undefined }],
    ['a non-string op', { ...validExec(), op: 5 }],
    ['a missing op', { ...validExec(), op: undefined }],
    ['a string payload', { ...validExec(), payload: 'G…' }],
    ['a null payload', { ...validExec(), payload: null }],
    ['a missing payload', { ...validExec(), payload: undefined }],
    ['a sign request', validSign()],
  ])('rejects %s', (_label, value) => {
    expect(isSppExecRequest(value)).toBe(false);
  });

  it.each(NON_OBJECTS)('rejects non-object input (%s)', (_label, value) => {
    expect(isSppExecRequest(value)).toBe(false);
  });
});

describe('isSppSignRequest', () => {
  it.each(SIGN_OPS)('accepts a well-formed sign request (op=%s)', (op) => {
    expect(isSppSignRequest(validSign(op))).toBe(true);
  });

  it('accepts a sign request with no body fields (the guard only checks the envelope)', () => {
    // message/xdr/preimage are validated by the signing handler; a request
    // carrying only the routing fields still passes the guard.
    const { message: _message, ...envelopeOnly } = validSign();
    expect(isSppSignRequest(envelopeOnly)).toBe(true);
  });

  it.each([
    ['a foreign channel', { ...validSign(), channel: 'veilpay:bus' }],
    ['a missing channel', { ...validSign(), channel: undefined }],
    ['a wrong kind', { ...validSign(), kind: 'spp:exec' }],
    ['a missing kind', { ...validSign(), kind: undefined }],
    ['a non-string id', { ...validSign(), id: 7 }],
    ['a missing id', { ...validSign(), id: undefined }],
    ['a non-string op', { ...validSign(), op: 5 }],
    ['a missing op', { ...validSign(), op: undefined }],
    ['a non-string address', { ...validSign(), address: 42 }],
    ['a missing address', { ...validSign(), address: undefined }],
    ['an exec request', validExec()],
  ])('rejects %s', (_label, value) => {
    expect(isSppSignRequest(value)).toBe(false);
  });

  it.each(NON_OBJECTS)('rejects non-object input (%s)', (_label, value) => {
    expect(isSppSignRequest(value)).toBe(false);
  });
});

describe('isSppPing', () => {
  it('accepts a well-formed keepalive ping', () => {
    expect(isSppPing(validPing())).toBe(true);
  });

  it('accepts a ping without an id — the guard only checks channel and kind', () => {
    // Documented loose edge: the host's keepalive pings always carry an id,
    // but the guard would wave through one that does not. Harmless (a ping
    // triggers no work), pinned here so any tightening is deliberate.
    expect(isSppPing({ channel: INTERNAL_CHANNEL, kind: 'spp:ping' })).toBe(true);
  });

  it.each([
    ['a foreign channel', { ...validPing(), channel: 'veilpay:bus' }],
    ['a missing channel', { ...validPing(), channel: undefined }],
    ['a wrong kind', { ...validPing(), kind: 'spp:exec' }],
    ['a missing kind', { ...validPing(), kind: undefined }],
    ['an exec request', validExec()],
    ['a sign request', validSign()],
  ])('rejects %s', (_label, value) => {
    expect(isSppPing(value)).toBe(false);
  });

  it.each(NON_OBJECTS)('rejects non-object input (%s)', (_label, value) => {
    expect(isSppPing(value)).toBe(false);
  });
});

describe('guard mutual exclusion', () => {
  it('the three kinds never cross-accept each other', () => {
    const exec = validExec();
    const sign = validSign();
    const ping = validPing();
    expect(isSppExecRequest(exec)).toBe(true);
    expect(isSppExecRequest(sign)).toBe(false);
    expect(isSppExecRequest(ping)).toBe(false);
    expect(isSppSignRequest(sign)).toBe(true);
    expect(isSppSignRequest(exec)).toBe(false);
    expect(isSppSignRequest(ping)).toBe(false);
  });
});

describe('isExtensionPageSender', () => {
  /** The sender our own extension pages produce: no tab, same extension id. */
  function extensionPageSender(): chrome.runtime.MessageSender {
    return { id: chrome.runtime.id };
  }

  it('accepts a sender from this extension without a tab', () => {
    expect(isExtensionPageSender(extensionPageSender())).toBe(true);
  });

  it('rejects a content-script sender (tab set, same extension)', () => {
    const sender: chrome.runtime.MessageSender = {
      ...extensionPageSender(),
      tab: { id: 42 } as chrome.tabs.Tab,
    };
    expect(isExtensionPageSender(sender)).toBe(false);
  });

  it('rejects a foreign extension id', () => {
    const sender: chrome.runtime.MessageSender = { id: 'some-other-extension' };
    expect(isExtensionPageSender(sender)).toBe(false);
  });
});

describe('isOffscreenDocumentSender', () => {
  /** The sender Chrome stamps for the offscreen document's own messages. */
  function offscreenSender(): chrome.runtime.MessageSender {
    return { id: chrome.runtime.id, url: chrome.runtime.getURL('offscreen.html') };
  }

  it('accepts the offscreen document itself', () => {
    expect(isOffscreenDocumentSender(offscreenSender())).toBe(true);
  });

  it('rejects a popup page (same extension, different document)', () => {
    const sender: chrome.runtime.MessageSender = {
      id: chrome.runtime.id,
      url: chrome.runtime.getURL('popup.html'),
    };
    // A popup IS a legitimate extension page — but it must not reach the
    // signing callbacks, so the page-level guard accepts while the strict
    // one rejects.
    expect(isExtensionPageSender(sender)).toBe(true);
    expect(isOffscreenDocumentSender(sender)).toBe(false);
  });

  it('rejects a sender without a url', () => {
    const sender: chrome.runtime.MessageSender = { id: chrome.runtime.id };
    expect(isOffscreenDocumentSender(sender)).toBe(false);
  });

  it('rejects a foreign extension id even with the offscreen url', () => {
    const sender: chrome.runtime.MessageSender = {
      id: 'some-other-extension',
      url: chrome.runtime.getURL('offscreen.html'),
    };
    expect(isOffscreenDocumentSender(sender)).toBe(false);
  });
});

describe('isBackgroundWorkerSender', () => {
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

  it('accepts the background service worker itself', () => {
    expect(isBackgroundWorkerSender(workerSender(), workerUrl())).toBe(true);
  });

  it('rejects a popup page (same extension, different document)', () => {
    const sender: chrome.runtime.MessageSender = {
      id: chrome.runtime.id,
      url: chrome.runtime.getURL('popup.html'),
    };
    expect(isBackgroundWorkerSender(sender, workerUrl())).toBe(false);
  });

  it('rejects the offscreen document', () => {
    expect(
      isBackgroundWorkerSender(
        { id: chrome.runtime.id, url: chrome.runtime.getURL('offscreen.html') },
        workerUrl(),
      ),
    ).toBe(false);
  });

  it('rejects a sender without a url', () => {
    const sender: chrome.runtime.MessageSender = { id: chrome.runtime.id };
    expect(isBackgroundWorkerSender(sender, workerUrl())).toBe(false);
  });

  it('rejects a foreign extension id even with the worker url', () => {
    const sender: chrome.runtime.MessageSender = {
      id: 'some-other-extension',
      url: workerUrl(),
    };
    expect(isBackgroundWorkerSender(sender, workerUrl())).toBe(false);
  });

  it('fails closed when the expected worker URL is unknown', () => {
    // The offscreen document resolves the URL from its packaged manifest; a
    // failed load (null) must reject EVERY sender rather than none.
    expect(isBackgroundWorkerSender(workerSender(), null)).toBe(false);
    expect(isBackgroundWorkerSender(workerSender(), undefined)).toBe(false);
    expect(isBackgroundWorkerSender(workerSender(), '')).toBe(false);
  });
});

import { beforeEach, vi } from 'vitest';
import 'fake-indexeddb/auto';
import { webcrypto } from 'node:crypto';

/**
 * Test environment shims.
 *
 * jsdom provides neither WebCrypto's subtle API nor the chrome namespace, and
 * IndexedDB comes from fake-indexeddb. Real WebCrypto is used rather than a mock
 * so the vault tests exercise actual AES-GCM and PBKDF2 rather than asserting
 * against a stub that could pass while the real path is broken.
 */

if (globalThis.crypto?.subtle === undefined) {
  Object.defineProperty(globalThis, 'crypto', {
    value: webcrypto,
    configurable: true,
  });
}

interface AlarmStub {
  create: ReturnType<typeof vi.fn>;
  onAlarm: { addListener: ReturnType<typeof vi.fn> };
}

function makeChromeStub() {
  return {
    runtime: {
      id: 'veilpay-test',
      sendMessage: vi.fn(),
      getURL: (path: string) => `chrome-extension://veilpay-test/${path}`,
      getManifest: () =>
        ({
          manifest_version: 3,
          name: 'Veilpay',
          version: '0.0.1',
          background: { service_worker: 'service-worker-loader.js', type: 'module' },
        }) as unknown as chrome.runtime.ManifestV3,
      onMessage: { addListener: vi.fn() },
      onInstalled: { addListener: vi.fn() },
      onStartup: { addListener: vi.fn() },
      openOptionsPage: vi.fn(),
    },
    storage: {
      local: {
        get: vi.fn(async () => ({})),
        set: vi.fn(async () => undefined),
        remove: vi.fn(async () => undefined),
      },
      session: {
        get: vi.fn(async () => ({})),
        set: vi.fn(async () => undefined),
        remove: vi.fn(async () => undefined),
      },
    },
    action: {
      openPopup: vi.fn(async () => undefined),
    },
    alarms: {
      create: vi.fn(),
      onAlarm: { addListener: vi.fn() },
    } satisfies AlarmStub,
    offscreen: {
      createDocument: vi.fn(async () => undefined),
      closeDocument: vi.fn(async () => undefined),
      Reason: { WORKERS: 'WORKERS' },
    },
    contextMenus: {
      removeAll: vi.fn(async () => undefined),
      create: vi.fn(),
      onClicked: { addListener: vi.fn() },
    },
  };
}

beforeEach(() => {
  // @types/chrome declares the full namespace; the stub only covers the surface
  // these tests touch, so the assertion is deliberate.
  globalThis.chrome = makeChromeStub() as unknown as typeof chrome;
});

import { afterEach, describe, expect, it, vi } from 'vitest';
import { SPP_IDLE_ALARM } from '@/core/spp/bridge';

/**
 * The bridge is the background's window onto the offscreen SPP host: it owns
 * the offscreen document lifecycle, the idle-close policy, and the error-code
 * mapping of host responses. The chrome stub from tests/setup.ts already
 * provides offscreen/alarms/runtime as vi.fn()s, so every behavior below is
 * driven through real calls, not re-implementation.
 *
 * The module keeps its activity bookkeeping in module-level state, so tests
 * that care about the initial value re-import a FRESH instance via
 * vi.resetModules().
 */

/** The channel marker the host and background share (mirrors internal-protocol). */
const INTERNAL_CHANNEL = 'veilpay:internal';

async function freshBridge() {
  vi.resetModules();
  return await import('@/core/spp/bridge');
}

describe('SPP activity bookkeeping', () => {
  it('reports unused before any activity, used after', async () => {
    const bridge = await freshBridge();
    expect(bridge.sppEverUsed()).toBe(false);
    bridge.noteSppActivity();
    expect(bridge.sppEverUsed()).toBe(true);
  });
});

describe('closeIdleSppHost decision table', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('never closes a host that has never been used', async () => {
    const bridge = await freshBridge();
    await bridge.closeIdleSppHost();
    expect(chrome.offscreen.closeDocument).not.toHaveBeenCalled();
    expect(bridge.sppEverUsed()).toBe(false);
  });

  it('keeps the host alive while activity is recent', async () => {
    const bridge = await freshBridge();
    bridge.noteSppActivity();
    await bridge.closeIdleSppHost();
    expect(chrome.offscreen.closeDocument).not.toHaveBeenCalled();
    expect(bridge.sppEverUsed()).toBe(true);
  });

  it('closes the document once idle past the deadline, exactly once', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    const bridge = await freshBridge();
    bridge.noteSppActivity();

    // 10 minutes is the idle deadline; 11 is safely past it.
    vi.setSystemTime(new Date('2026-01-01T00:11:00Z'));
    await bridge.closeIdleSppHost();
    expect(chrome.offscreen.closeDocument).toHaveBeenCalledTimes(1);

    // The sweep resets the bookkeeping: a second sweep is a no-op (the
    // "never used" branch), not a second close call.
    expect(bridge.sppEverUsed()).toBe(false);
    await bridge.closeIdleSppHost();
    expect(chrome.offscreen.closeDocument).toHaveBeenCalledTimes(1);
  });

  it('still closes when the offscreen close call itself rejects', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    const bridge = await freshBridge();
    bridge.noteSppActivity();
    vi.setSystemTime(new Date('2026-01-01T00:11:00Z'));
    vi.mocked(chrome.offscreen.closeDocument)
      .mockRejectedValueOnce(new Error('no document') as never);

    // The close failure is swallowed (the document may already be gone), but
    // the activity bookkeeping is still reset.
    await expect(bridge.closeIdleSppHost()).resolves.toBeUndefined();
    expect(chrome.offscreen.closeDocument).toHaveBeenCalledTimes(1);
    expect(bridge.sppEverUsed()).toBe(false);
  });
});

describe('ensureSppOffscreenDocument', () => {
  it('creates the document with the WORKERS reason and a privacy justification', async () => {
    const bridge = await freshBridge();
    await bridge.ensureSppOffscreenDocument();
    expect(chrome.offscreen.createDocument).toHaveBeenCalledWith(
      expect.objectContaining({
        url: 'offscreen.html',
        reasons: ['WORKERS'],
        justification: expect.stringContaining('Stellar Private Payments'),
      }),
    );
  });

  it('tolerates the "already created" error as success', async () => {
    // The background cannot query whether the offscreen document exists, so
    // creation races are resolved by treating this specific message as
    // "already up".
    vi.mocked(chrome.offscreen.createDocument).mockRejectedValueOnce(
      new Error('Only a single offscreen document may be created.') as never,
    );
    const bridge = await freshBridge();
    await expect(bridge.ensureSppOffscreenDocument()).resolves.toBeUndefined();
    expect(chrome.offscreen.createDocument).toHaveBeenCalledTimes(1);
  });

  it('escalates any other creation failure to an INTERNAL protocol error', async () => {
    vi.mocked(chrome.offscreen.createDocument).mockRejectedValueOnce(
      new Error('offscreen exploded') as never,
    );
    const bridge = await freshBridge();
    await expect(bridge.ensureSppOffscreenDocument()).rejects.toMatchObject({
      code: 'INTERNAL',
      message: expect.stringContaining('offscreen exploded'),
    });
  });

  it('does not swallow a non-Error rejection reason', async () => {
    // The error path stringifies the cause; a non-Error must not crash it.
    vi.mocked(chrome.offscreen.createDocument).mockRejectedValueOnce('plain string' as never);
    const bridge = await freshBridge();
    await expect(bridge.ensureSppOffscreenDocument()).rejects.toMatchObject({
      code: 'INTERNAL',
      message: expect.stringContaining('plain string'),
    });
  });
});

describe('ensureSppIdleAlarm', () => {
  it('arms a periodic alarm under the SPP name', async () => {
    const bridge = await freshBridge();
    bridge.ensureSppIdleAlarm();
    expect(chrome.alarms.create).toHaveBeenCalledWith(
      SPP_IDLE_ALARM,
      expect.objectContaining({ periodInMinutes: 1 }),
    );
  });
});

describe('runSppOp', () => {
  it('ensures the host, forwards the op on the internal channel, returns the result', async () => {
    const bridge = await freshBridge();
    vi.mocked(chrome.runtime.sendMessage).mockResolvedValueOnce(
      { ok: true, result: { balanceStroops: '7' } } as never,
    );

    const result = await bridge.runSppOp('status', {
      address: 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF',
    });

    expect(result).toEqual({ balanceStroops: '7' });
    expect(chrome.offscreen.createDocument).toHaveBeenCalledTimes(1);
    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: INTERNAL_CHANNEL,
        kind: 'spp:exec',
        op: 'status',
        payload: { address: 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF' },
      }),
    );
    // A successful round trip counts as activity for the idle closer.
    expect(bridge.sppEverUsed()).toBe(true);
  });

  it('maps a VAULT_LOCKED host answer to the protocol VAULT_LOCKED error', async () => {
    const bridge = await freshBridge();
    vi.mocked(chrome.runtime.sendMessage).mockResolvedValueOnce(
      { ok: false, code: 'VAULT_LOCKED', message: 'Unlock the wallet.' } as never,
    );

    await expect(
      bridge.runSppOp('deposit', { address: 'G…', amountStroops: '100' }),
    ).rejects.toMatchObject({ code: 'VAULT_LOCKED', message: 'Unlock the wallet.' });
  });

  it('maps a generic host failure to TX_REJECTED with the host message', async () => {
    const bridge = await freshBridge();
    vi.mocked(chrome.runtime.sendMessage).mockResolvedValueOnce(
      { ok: false, message: 'The pool rejected the operation: no notes.' } as never,
    );

    await expect(bridge.runSppOp('withdraw', { address: 'G…', amountStroops: '1' })).rejects.toMatchObject(
      { code: 'TX_REJECTED', message: 'The pool rejected the operation: no notes.' },
    );
  });

  it('reports INTERNAL when the host does not answer at all', async () => {
    const bridge = await freshBridge();
    vi.mocked(chrome.runtime.sendMessage).mockResolvedValueOnce(undefined as never);

    await expect(bridge.runSppOp('sync', { address: 'G…' })).rejects.toMatchObject({
      code: 'INTERNAL',
      message: expect.stringContaining('did not answer'),
    });
  });

  it('reports INTERNAL when the host answers with a non-response shape', async () => {
    const bridge = await freshBridge();
    vi.mocked(chrome.runtime.sendMessage).mockResolvedValueOnce('garbage' as never);

    await expect(bridge.runSppOp('sync', { address: 'G…' })).rejects.toMatchObject({
      code: 'INTERNAL',
      message: expect.stringContaining('did not answer'),
    });
  });

  it('still records activity when the op fails (the host was touched)', async () => {
    const bridge = await freshBridge();
    vi.mocked(chrome.runtime.sendMessage).mockResolvedValueOnce(
      { ok: false, message: 'boom' } as never,
    );

    await expect(bridge.runSppOp('status', { address: 'G…' })).rejects.toThrow();
    expect(bridge.sppEverUsed()).toBe(true);
  });
});

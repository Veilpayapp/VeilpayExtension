import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SPP_CONTRACT_CONFIG, SPP_POOL_CONTRACT_ID } from '@/core/spp/deployment';
import type { SppExecOp } from '@/core/spp/internal-protocol';
import type { stub as Stub } from '@tests/fixtures/spp-sdk-stub';

/**
 * The offscreen SPP host (`src/core/spp/host.ts`) — the module that boots the
 * vendored privacy-pool SDK and executes pool operations on the background's
 * behalf.
 *
 * The host loads the SDK by URL at runtime, which can never be aliased or
 * bundled. These tests point `chrome.runtime.getURL('spp/js/index.js')` at the
 * controllable fixture `tests/fixtures/spp-sdk-stub.ts` instead, so the host's
 * REAL bootstrap, signer bridge, sync-retry, keepalive, and op-routing code
 * runs against a recording stub. The module keeps its runtime singletons at
 * module level, so every test re-imports a fresh instance.
 */

const INTERNAL_CHANNEL = 'veilpay:internal';

/** A registered-looking Stellar address (strkey shape only; contents random). */
const ADDRESS = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF';
const OTHER_ADDRESS = 'GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBNOUI';

/** Root-relative path of the SDK stand-in (resolved by the module runner). */
const STUB_MODULE = '/tests/fixtures/spp-sdk-stub.ts';

type HostModule = typeof import('@/core/spp/host');

interface Fixture {
  host: HostModule;
  stub: typeof Stub;
}

async function freshHost(): Promise<Fixture> {
  vi.resetModules();
  const stubModule = await import('@tests/fixtures/spp-sdk-stub');
  const host = await import('@/core/spp/host');
  return { host, stub: stubModule.stub };
}

/** Points the host's SDK import and circuit-lock fetch at the fixture. */
function installSdkUrlRouting(): void {
  // The setup shim's getURL is a plain function; replace it for this test so
  // the host's dynamic import resolves to the stub fixture.
  (chrome.runtime.getURL as (path: string) => string) = (path: string) => {
    if (path === 'spp/js/index.js') return STUB_MODULE;
    return `chrome-extension://veilpay-test/${path}`;
  };
  // The circuit lock is a package file; hand the host a lock-shaped body.
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({ ok: true, json: async () => ({ version: 1, circuits: {} }) })),
  );
}

/** A healthy default stub state for the pools/registry surface. */
function healthyPool(stub: typeof Stub): void {
  stub.pools = [{ contractId: SPP_POOL_CONTRACT_ID, ledger: 123 }];
  stub.balance = 1_500_000_000n;
}

beforeEach(() => {
  installSdkUrlRouting();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('bootstrap wiring (ensureRuntime)', () => {
  it('builds the client from the pinned deployment and binds the account', async () => {
    const { host, stub } = await freshHost();
    healthyPool(stub);

    const status = (await host.executeSppOp('status', { address: ADDRESS })) as Record<
      string,
      unknown
    >;

    // The wasm init, storage, bootnode check and client all ran — once.
    expect(stub.initCalls).toBe(1);
    expect(stub.storageOpenCalls).toBe(1);
    expect(stub.bootnodeRequiredCalls).toBe(1);
    expect(stub.clientNewCalls).toBe(1);
    expect(stub.backgroundSyncCalls).toBe(1);

    // The client is pinned to OUR deployment: rpc, circuits URL, contract
    // config, and the network passphrase binding the account.
    expect(stub.clientOptions).toMatchObject({
      rpcUrl: SPP_CONTRACT_CONFIG.rpcUrl,
      circuitsBaseUrl: 'chrome-extension://veilpay-test/spp/dist/circuits/',
      contractConfig: SPP_CONTRACT_CONFIG,
    });
    expect(stub.accountOptions).toMatchObject({
      networkPassphrase: SPP_CONTRACT_CONFIG.networkPassphrase,
      userAddress: ADDRESS,
    });

    // The pool is the deployment's single pool, the keys were derived, and
    // the first sync ran before the reads.
    expect(stub.requestedPoolContract).toBe(SPP_POOL_CONTRACT_ID);
    expect(stub.deriveCalls).toBe(1);
    expect(stub.syncCalls).toBe(1);

    expect(status).toMatchObject({
      poolContractId: SPP_POOL_CONTRACT_ID,
      assetSymbol: 'pXLM',
      balanceStroops: '1500000000',
      bootnodeRequired: false,
      syncedLedger: 123,
    });
    expect(typeof status['readAt']).toBe('number');
  });

  it('reuses the runtime across ops and rebinds the account per address', async () => {
    const { host, stub } = await freshHost();
    healthyPool(stub);

    await host.executeSppOp('status', { address: ADDRESS });
    await host.executeSppOp('status', { address: OTHER_ADDRESS });

    // One document runtime; the account (and its signer binding) follows the
    // address, privacy keys re-derived for the new wallet.
    expect(stub.clientNewCalls).toBe(1);
    expect(stub.storageOpenCalls).toBe(1);
    expect(stub.deriveCalls).toBe(2);
    expect(stub.accountOptions?.userAddress).toBe(OTHER_ADDRESS);
    expect(await stub.capturedSigner!.getPublicKey()).toBe(OTHER_ADDRESS);
  });

  it('does not cache a failed bootstrap: the next op retries from scratch', async () => {
    const { host, stub } = await freshHost();
    healthyPool(stub);

    // The client build fails AFTER the storage worker started — the worker
    // holds the OPFS database lock, so it is deliberately KEPT (opening a
    // second one would fail every later attempt), while the client and
    // account are reset for the retry.
    stub.clientNewError = new Error('client build failed');
    await expect(host.executeSppOp('status', { address: ADDRESS })).rejects.toThrow(
      'client build failed',
    );

    stub.clientNewError = null;
    await expect(host.executeSppOp('status', { address: ADDRESS })).resolves.toBeDefined();
    expect(stub.storageOpenCalls).toBe(1);
    expect(stub.clientNewCalls).toBe(2);
  });

  it('fails with the aged-out message when the bootnode is required', async () => {
    const { host, stub } = await freshHost();
    stub.bootnodeRequired = true;

    await expect(host.executeSppOp('status', { address: ADDRESS })).rejects.toThrow(
      /aged out of the public RPC/,
    );
  });

  it('rejects an op without an address before touching the runtime', async () => {
    const { host, stub } = await freshHost();
    await expect(host.executeSppOp('status', { address: '' })).rejects.toThrow(
      /missing the wallet address/,
    );
    expect(stub.initCalls).toBe(0);
  });
});

describe('registered semantics (the registry-entry detector)', () => {
  it('reports registered only when the on-chain entry matches the derived keys', async () => {
    const { host, stub } = await freshHost();
    healthyPool(stub);

    stub.lookupEntry = {
      noteKey: '0XA1', // different case than the derived key: still a match
      encryptionKey: '0xB2',
    };
    const matched = (await host.executeSppOp('status', { address: ADDRESS })) as {
      registered: boolean;
    };
    expect(matched.registered).toBe(true);

    // An entry that does NOT match (e.g. an older derivation, or a restored
    // wallet on a fresh device) must not read as registered — transfers would
    // route to keys this wallet cannot read.
    stub.lookupEntry = { noteKey: '0xDEAD', encryptionKey: '0xBEEF' };
    const mismatched = (await host.executeSppOp('status', { address: ADDRESS })) as {
      registered: boolean;
    };
    expect(mismatched.registered).toBe(false);
  });

  it('register waits for the local index to reflect the entry', async () => {
    vi.useFakeTimers();
    const { host, stub } = await freshHost();
    healthyPool(stub);

    stub.lookupEntry = undefined;
    const registered = host.executeSppOp('register', { address: ADDRESS });

    // The registration tx is done; the entry is not in the local index yet.
    // waitForRegistration polls every 2s — nothing is registered yet.
    await vi.advanceTimersByTimeAsync(2_000);
    expect(stub.syncCalls).toBeGreaterThan(1);

    stub.lookupEntry = { noteKey: '0xA1', encryptionKey: '0xB2' };
    await vi.advanceTimersByTimeAsync(2_000);

    await expect(registered).resolves.toMatchObject({ txHash: 'register-hash-1' });
  });
});

describe('money-op argument validation', () => {
  it.each([
    ['a decimal string', '12.5'],
    ['a negative number', '-1'],
    ['scientific notation', '1e3'],
    ['a hex literal', '0x10'],
    ['a zero amount', '0'],
    ['an empty string', ''],
    ['a missing amount', undefined],
  ])('rejects %s for deposit with a clean error', async (_label, amountStroops) => {
    const { host, stub } = await freshHost();
    healthyPool(stub);

    const payload =
      amountStroops === undefined
        ? { address: ADDRESS }
        : { address: ADDRESS, amountStroops };
    await expect(host.executeSppOp('deposit', payload)).rejects.toThrow(
      /deposit amount must be/,
    );
    // The pool was never touched.
    expect(stub.depositCalls).toHaveLength(0);
  });

  it('rejects the same malformed amounts for transfer and withdraw', async () => {
    const { host, stub } = await freshHost();
    healthyPool(stub);

    await expect(
      host.executeSppOp('transfer', {
        address: ADDRESS,
        to: OTHER_ADDRESS,
        amountStroops: '12.5',
      }),
    ).rejects.toThrow(/transfer amount must be/);
    await expect(
      host.executeSppOp('withdraw', { address: ADDRESS, amountStroops: '-5' }),
    ).rejects.toThrow(/withdraw amount must be/);
    expect(stub.transferCalls).toHaveLength(0);
    expect(stub.withdrawCalls).toHaveLength(0);
  });

  it('rejects a private transfer without a recipient', async () => {
    const { host, stub } = await freshHost();
    healthyPool(stub);

    await expect(
      host.executeSppOp('transfer', { address: ADDRESS, amountStroops: '100' }),
    ).rejects.toThrow(/needs a recipient address/);
    await expect(
      host.executeSppOp('transfer', { address: ADDRESS, to: '', amountStroops: '100' }),
    ).rejects.toThrow(/needs a recipient address/);
    expect(stub.transferCalls).toHaveLength(0);
  });

  it('routes deposit/transfer/withdraw to the pool with bigint amounts', async () => {
    const { host, stub } = await freshHost();
    healthyPool(stub);

    await expect(
      host.executeSppOp('deposit', { address: ADDRESS, amountStroops: '25000000' }),
    ).resolves.toEqual({ txHash: 'deposit-hash', amountStroops: '25000000' });
    await expect(
      host.executeSppOp('transfer', {
        address: ADDRESS,
        to: OTHER_ADDRESS,
        amountStroops: '5000000',
      }),
    ).resolves.toEqual({ txHash: 'transfer-hash', amountStroops: '5000000' });
    await expect(
      host.executeSppOp('withdraw', { address: ADDRESS, amountStroops: '30000000' }),
    ).resolves.toEqual({ txHash: 'withdraw-hash', amountStroops: '30000000' });

    expect(stub.depositCalls).toEqual([25_000_000n]);
    expect(stub.transferCalls).toEqual([{ recipient: OTHER_ADDRESS, amount: 5_000_000n }]);
    expect(stub.withdrawCalls).toEqual([30_000_000n]);
    // Transfer and withdraw sync first (spendable-notes visibility).
    expect(stub.syncCalls).toBeGreaterThanOrEqual(2);
  });

  it('surfaces the pool rejection message when the op fails on-chain', async () => {
    const { host, stub } = await freshHost();
    healthyPool(stub);

    stub.poolResults.deposit = { status: 'error', hashes: [], message: 'insufficient XLM' };
    await expect(
      host.executeSppOp('deposit', { address: ADDRESS, amountStroops: '1' }),
    ).rejects.toThrow('The pool rejected the operation: insufficient XLM');

    // "Succeeded" but no hash: refuse to report a receipt without one.
    stub.poolResults.deposit = { status: 'ok', hashes: [] };
    await expect(
      host.executeSppOp('deposit', { address: ADDRESS, amountStroops: '1' }),
    ).rejects.toThrow(/reported no transaction hash/);
  });

  it('refuses an unknown operation', async () => {
    const { host, stub } = await freshHost();
    healthyPool(stub);

    await expect(
      host.executeSppOp('bogus' as SppExecOp, { address: ADDRESS }),
    ).rejects.toThrow(/Unknown SPP operation/);
  });
});

describe('sync retry (transient RPC gaps)', () => {
  it('retries a failing sync and succeeds on a later attempt', async () => {
    vi.useFakeTimers();
    const { host, stub } = await freshHost();
    healthyPool(stub);

    let failures = 2;
    stub.syncImpl = async () => {
      if (failures > 0) {
        failures -= 1;
        throw new Error('rpc sync gap');
      }
    };

    const op = host.executeSppOp('sync', { address: ADDRESS });
    // Two 1.5s backoffs between the three attempts.
    await vi.advanceTimersByTimeAsync(1_500);
    await vi.advanceTimersByTimeAsync(1_500);

    await expect(op).resolves.toEqual({ ok: true });
    expect(stub.syncCalls).toBe(3);
  });

  it('gives up after the bounded attempts and throws the last error', async () => {
    vi.useFakeTimers();
    const { host, stub } = await freshHost();
    healthyPool(stub);

    stub.syncImpl = async () => {
      throw new Error('index unavailable');
    };

    const op = host.executeSppOp('sync', { address: ADDRESS });
    const expectation = expect(op).rejects.toThrow('index unavailable');
    await vi.advanceTimersByTimeAsync(5_000);
    await expectation;
    expect(stub.syncCalls).toBe(3);
  });
});

describe('signer bridge (keys never leave the background)', () => {
  it('round-trips signMessage to the background with the protocol envelope', async () => {
    const { host, stub } = await freshHost();
    healthyPool(stub);
    await host.executeSppOp('status', { address: ADDRESS });

    vi.mocked(chrome.runtime.sendMessage).mockImplementationOnce(
      () =>
        Promise.resolve({
          ok: true,
          result: 'c2lnbmF0dXJl',
        }) as never,
    );

    const signer = stub.capturedSigner!;
    await expect(signer.signMessage('Privacy Pool Key Derivation [v2] (Veilpay)')).resolves.toEqual(
      { signedMessage: 'c2lnbmF0dXJl', signerAddress: ADDRESS },
    );

    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: INTERNAL_CHANNEL,
        kind: 'spp:sign',
        op: 'signMessage',
        address: ADDRESS,
        message: 'Privacy Pool Key Derivation [v2] (Veilpay)',
      }),
    );
  });

  it('passes the network passphrase through for signTransaction', async () => {
    const { host, stub } = await freshHost();
    healthyPool(stub);
    await host.executeSppOp('status', { address: ADDRESS });

    const calls: unknown[] = [];
    vi.mocked(chrome.runtime.sendMessage).mockImplementation((message: unknown) => {
      calls.push(message);
      return Promise.resolve({ ok: true, result: 'signed-xdr' }) as never;
    });
    const signer = stub.capturedSigner!;

    // Default passphrase = the pool's network passphrase…
    await signer.signTransaction('xdr-1', {});
    // …and an explicit one wins.
    await signer.signTransaction('xdr-2', { networkPassphrase: 'Standalone Network ; February 2017' });

    expect(calls[0]).toMatchObject({
      kind: 'spp:sign',
      op: 'signTransaction',
      xdr: 'xdr-1',
      networkPassphrase: SPP_CONTRACT_CONFIG.networkPassphrase,
    });
    expect(calls[1]).toMatchObject({
      op: 'signTransaction',
      xdr: 'xdr-2',
      networkPassphrase: 'Standalone Network ; February 2017',
    });
  });

  it('carries the background error code and message on a refused signature', async () => {
    const { host, stub } = await freshHost();
    healthyPool(stub);
    await host.executeSppOp('status', { address: ADDRESS });

    vi.mocked(chrome.runtime.sendMessage).mockImplementationOnce(
      () =>
        Promise.resolve({
          ok: false,
          code: 'VAULT_LOCKED',
          message: 'Unlock the wallet.',
        }) as never,
    );

    const signer = stub.capturedSigner!;
    const failure = signer.signAuthEntry('preimage-b64');
    await expect(failure).rejects.toMatchObject({
      message: 'Unlock the wallet.',
      code: 'VAULT_LOCKED',
    });
  });

  it('fails loudly when the background does not answer a signing call', async () => {
    const { host, stub } = await freshHost();
    healthyPool(stub);
    await host.executeSppOp('status', { address: ADDRESS });

    vi.mocked(chrome.runtime.sendMessage).mockImplementationOnce(
      () => Promise.resolve(undefined) as never,
    );

    const signer = stub.capturedSigner!;
    await expect(signer.signMessage('m')).rejects.toThrow(/did not answer/);
  });
});

describe('service-worker keepalive', () => {
  /** Counts the spp:ping messages sent so far. */
  function pingCount(): number {
    return vi
      .mocked(chrome.runtime.sendMessage)
      .mock.calls.filter((args) => {
        const message = args[0] as { channel?: string; kind?: string } | undefined;
        return message?.channel === INTERNAL_CHANNEL && message?.kind === 'spp:ping';
      }).length;
  }

  it('pings while an op runs and stops when it settles', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    const { host, stub } = await freshHost();
    healthyPool(stub);
    // The ping's sendMessage must return a promise for `.catch` to exist.
    vi.mocked(chrome.runtime.sendMessage).mockImplementation(
      () => Promise.resolve({ ok: true }) as never,
    );

    let release!: () => void;
    const held = new Promise<{ status: string; hashes: string[] }>((resolve) => {
      release = () => resolve({ status: 'ok', hashes: ['deposit-hash'] });
    });
    stub.depositImpl = () => held;

    const op = host.executeSppOp('deposit', { address: ADDRESS, amountStroops: '100' });
    // Bootstrap happens on microtasks; give it a tick without advancing time.
    await vi.advanceTimersByTimeAsync(0);

    // A ping every 20s while the proof runs.
    await vi.advanceTimersByTimeAsync(20_000);
    expect(pingCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(pingCount()).toBe(2);

    // The op settles → the keepalive stops with it.
    release();
    await expect(op).resolves.toEqual({ txHash: 'deposit-hash', amountStroops: '100' });
    const settled = pingCount();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(pingCount()).toBe(settled);
  });

  it('caps the keepalive: a never-settling op cannot ping forever', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    const { host, stub } = await freshHost();
    healthyPool(stub);
    vi.mocked(chrome.runtime.sendMessage).mockImplementation(
      () => Promise.resolve({ ok: true }) as never,
    );

    // Never settles: the deposit promise is simply never resolved.
    stub.depositImpl = () => new Promise(() => {});

    const op = host.executeSppOp('deposit', { address: ADDRESS, amountStroops: '100' });
    await vi.advanceTimersByTimeAsync(0);

    // Far past the 15-minute cap.
    await vi.advanceTimersByTimeAsync(20 * 60_000);
    const capped = pingCount();
    // Ticks land at 20s..880s before the 15-minute guard clears the timer:
    // 44 pings, then silence.
    expect(capped).toBe(44);

    await vi.advanceTimersByTimeAsync(20 * 60_000);
    expect(pingCount()).toBe(capped);

    // The op is still pending (never settles) — leave nothing dangling that
    // could fail the test run; the timer cap is the assertion.
    void op;
  });
});

describe('op serialization (one op at a time, in arrival order)', () => {
  it('runs a queued op only after the in-flight one settles', async () => {
    const { host, stub } = await freshHost();
    healthyPool(stub);

    let releaseDeposit!: () => void;
    const held = new Promise<{ status: string; hashes: string[] }>((resolve) => {
      releaseDeposit = () => resolve({ status: 'ok', hashes: ['deposit-hash'] });
    });
    stub.depositImpl = () => held;

    const deposit = host.executeSppOp('deposit', { address: ADDRESS, amountStroops: '100' });
    await vi.waitFor(() => {
      expect(stub.depositCalls).toHaveLength(1);
    });

    // A status read queued behind the deposit must not start: its sync (the
    // first thing the status op does after bootstrap) must not have run.
    const status = host.executeSppOp('status', { address: ADDRESS });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(stub.syncCalls).toBe(0);

    releaseDeposit();
    await expect(deposit).resolves.toEqual({ txHash: 'deposit-hash', amountStroops: '100' });

    // Now the queued status ran — and only once.
    const result = (await status) as { balanceStroops: string };
    expect(result.balanceStroops).toBe('1500000000');
    expect(stub.syncCalls).toBe(1);
  });

  it('a failed op does not poison the queue for the next one', async () => {
    const { host, stub } = await freshHost();
    healthyPool(stub);

    stub.poolResults.deposit = { status: 'error', hashes: [], message: 'no notes' };
    await expect(
      host.executeSppOp('deposit', { address: ADDRESS, amountStroops: '1' }),
    ).rejects.toThrow(/no notes/);

    // The next op runs normally despite the previous failure.
    const status = (await host.executeSppOp('status', { address: ADDRESS })) as {
      balanceStroops: string;
    };
    expect(status.balanceStroops).toBe('1500000000');
  });
});

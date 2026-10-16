/**
 * A controllable stand-in for the vendored SPP SDK module.
 *
 * `src/core/spp/host.ts` loads the real SDK by URL
 * (`chrome.runtime.getURL('spp/js/index.js')`) because the SDK derives its
 * worker/WASM URLs from its own module location — it can never be bundled or
 * aliased. Host tests point `chrome.runtime.getURL` at THIS file instead, so
 * the host's dynamic `import()` resolves here and every SDK surface it
 * touches becomes a recording, reconfigurable stub: the tests then drive the
 * host's real bootstrap, signer bridge, sync-retry, and op-routing code.
 *
 * All state lives on the exported `stub` object; re-import after
 * `vi.resetModules()` for a fresh one.
 */

/** What `Client.account()` hands back per call. */
interface StubAccount {
  userAddress: string;
  derivePrivacyKeys(): Promise<{ notePublicKey: string; encryptionPublicKey: string }>;
  privacyKeys(): Promise<{ notePublicKey: string; encryptionPublicKey: string }>;
  isRegistered(): Promise<boolean>;
  registerPublicKeys(): Promise<string>;
  pool(options: { poolContract: string }): Promise<StubPool>;
}

interface StubPool {
  balance(): Promise<bigint>;
  notes(): Promise<Array<{ id: string; amount: string; spent: boolean; leafIndex: number }>>;
  deposit(amount: bigint): Promise<{ status: string; hashes: string[]; message?: string }>;
  transfer(recipient: string, amount: bigint): Promise<{ status: string; hashes: string[]; message?: string }>;
  withdraw(amount: bigint, recipient?: string | null): Promise<{ status: string; hashes: string[]; message?: string }>;
}

/** Settable pool-op implementations (default: the recorded results below). */
type PoolExecuteResult = { status: string; hashes: string[]; message?: string };
type DepositImpl = (amount: bigint) => Promise<PoolExecuteResult>;

/** The signer the host hands to `client.account()` (captured for tests). */
type CapturedSigner = {
  getPublicKey(): Promise<string>;
  signMessage(message: string): Promise<{ signedMessage: string; signerAddress: string }>;
  signTransaction(
    xdr: string,
    opts: { networkPassphrase?: string },
  ): Promise<{ signedTxXdr: string; signerAddress: string }>;
  signAuthEntry(preimage: string): Promise<{ signedAuthEntry: string; signerAddress: string }>;
};

export const stub = {
  // ---- init / storage / bootnode -------------------------------------
  initCalls: 0,
  storageOpenCalls: 0,
  storageOpenError: null as Error | null,
  bootnodeRequired: false,
  bootnodeRequiredCalls: 0,

  // ---- client construction --------------------------------------------
  clientNewCalls: 0,
  clientNewError: null as Error | null,
  clientOptions: null as
    | {
        rpcUrl: string;
        circuitsBaseUrl: string;
        contractConfig: unknown;
      }
    | null,
  backgroundSyncCalls: 0,
  accountOptions: null as { networkPassphrase: string; userAddress?: string } | null,
  capturedSigner: null as CapturedSigner | null,

  // ---- per-op behavior --------------------------------------------------
  syncCalls: 0,
  syncImpl: (async () => {}) as () => Promise<void>,
  balance: 0n,
  pools: [] as Array<{ contractId: string; ledger: number }>,
  privacyKeys: { notePublicKey: '0xA1', encryptionPublicKey: '0xB2' },
  lookupEntry: undefined as { noteKey: string; encryptionKey: string } | undefined,
  deriveCalls: 0,
  registerResult: 'register-hash-1',
  requestedPoolContract: null as string | null,
  depositCalls: [] as bigint[],
  transferCalls: [] as Array<{ recipient: string; amount: bigint }>,
  withdrawCalls: [] as bigint[],
  /** When set, `pool.deposit` delegates here (used to hold an op open). */
  depositImpl: null as DepositImpl | null,
  poolResults: {
    deposit: { status: 'ok', hashes: ['deposit-hash'] },
    transfer: { status: 'ok', hashes: ['transfer-hash'] },
    withdraw: { status: 'ok', hashes: ['withdraw-hash'] },
  } as {
    deposit: PoolExecuteResult;
    transfer: PoolExecuteResult;
    withdraw: PoolExecuteResult;
  },
};

function buildPool(): StubPool {
  return {
    async balance() {
      return stub.balance;
    },
    async notes() {
      return [];
    },
    async deposit(amount: bigint) {
      stub.depositCalls.push(amount);
      if (stub.depositImpl !== null) return stub.depositImpl(amount);
      return stub.poolResults.deposit;
    },
    async transfer(recipient: string, amount: bigint) {
      stub.transferCalls.push({ recipient, amount });
      return stub.poolResults.transfer;
    },
    async withdraw(amount: bigint) {
      stub.withdrawCalls.push(amount);
      return stub.poolResults.withdraw;
    },
  };
}

function buildAccount(address: string): StubAccount {
  return {
    userAddress: address,
    async derivePrivacyKeys() {
      stub.deriveCalls += 1;
      return stub.privacyKeys;
    },
    async privacyKeys() {
      return stub.privacyKeys;
    },
    async isRegistered() {
      return stub.lookupEntry !== undefined;
    },
    async registerPublicKeys() {
      return stub.registerResult;
    },
    async pool(options: { poolContract: string }) {
      stub.requestedPoolContract = options.poolContract;
      return buildPool();
    },
  };
}

/** The SDK's wasm-bindgen `init`. */
export default async function init(): Promise<void> {
  stub.initCalls += 1;
}

export const Storage = {
  async open(): Promise<{ fork: () => unknown; call: () => Promise<unknown> }> {
    stub.storageOpenCalls += 1;
    if (stub.storageOpenError !== null) throw stub.storageOpenError;
    return { fork: () => ({ call: async () => undefined }), call: async () => undefined };
  },
};

export async function bootnodeRequired(): Promise<boolean> {
  stub.bootnodeRequiredCalls += 1;
  return stub.bootnodeRequired;
}

export const Client = {
  new: async (options: {
    rpcUrl: string;
    circuitsBaseUrl: string;
    contractConfig: unknown;
  }): Promise<{
    backgroundSync(): Promise<void>;
    stopBackgroundSync(): void;
    sync(): Promise<void>;
    allContractsData(): Promise<{ pools: Array<{ contractId: string; ledger: number }> }>;
    recipientLookup(address: string): Promise<{
      entry: { noteKey: string; encryptionKey: string } | undefined;
    }>;
    account(
      options: { networkPassphrase: string; userAddress?: string },
      signer: CapturedSigner,
    ): Promise<StubAccount>;
  }> => {
    stub.clientNewCalls += 1;
    if (stub.clientNewError !== null) throw stub.clientNewError;
    stub.clientOptions = options;
    return {
      async backgroundSync() {
        stub.backgroundSyncCalls += 1;
      },
      stopBackgroundSync() {},
      async sync() {
        stub.syncCalls += 1;
        await stub.syncImpl();
      },
      async allContractsData() {
        return { pools: stub.pools };
      },
      async recipientLookup() {
        return { entry: stub.lookupEntry };
      },
      async account(options, signer) {
        stub.accountOptions = options;
        stub.capturedSigner = signer;
        return buildAccount(options.userAddress ?? 'unknown-address');
      },
    };
  },
};

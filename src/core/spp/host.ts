/**
 * SPP runtime host — runs in the offscreen document.
 *
 * The Stellar Private Payments SDK needs OPFS (its SQLite storage), Web
 * Workers (storage + prover), and WASM — none of which exist in the MV3
 * service worker. The offscreen document is the only privileged context that
 * has all three, so the SDK lives here and the background drives it over the
 * internal control plane (`spp:exec`).
 *
 * Key handling: the SDK's three signing callbacks (`signMessage`,
 * `signAuthEntry`, `signTransaction`) are bridged back to the background
 * (`spp:sign`), where they are answered inside `vault.withAccount`. The
 * private key therefore never exists outside the service worker — the
 * offscreen document only ever sees public XDR.
 *
 * The SDK itself and its circuit artifacts are static files copied into the
 * package under `dist/spp/` (see `scripts/copy-spp-assets.mjs`); they are
 * imported by URL, never bundled, because the SDK derives its worker and WASM
 * URLs from its own module location.
 */

import {
  SPP_ASSET_SYMBOL,
  SPP_CONTRACT_CONFIG,
  SPP_NETWORK_PASSPHRASE,
  SPP_POOL_CONTRACT_ID,
  SPP_RPC_URL,
} from '@/core/spp/deployment';
import {
  INTERNAL_CHANNEL,
  type SppExecOp,
  type SppSignResponse,
} from '@/core/spp/internal-protocol';

// ---------------------------------------------------------------------------
// Structural surface of the vendored SDK (built from the SPP repo; the entry
// is imported by URL at runtime, so these types are ours, not the package's).
// ---------------------------------------------------------------------------

/** The signer object the SDK calls back into (SEP-0043-shaped). */
interface SdkSigner {
  getPublicKey(): Promise<string>;
  signMessage(message: string): Promise<{ signedMessage: string; signerAddress: string }>;
  signTransaction(
    xdr: string,
    opts: { networkPassphrase?: string },
  ): Promise<{ signedTxXdr: string; signerAddress: string }>;
  signAuthEntry(preimage: string): Promise<{ signedAuthEntry: string; signerAddress: string }>;
}

interface SdkStorage {
  fork(): SdkStorage;
  call(request: unknown, timeoutMs?: number): Promise<unknown>;
}

interface SdkPoolInfo {
  contractId: string;
  ledger: number;
}

/** Locally derived note + encryption public keys (0x hex strings). */
interface SdkUserPublicKeys {
  notePublicKey: string;
  encryptionPublicKey: string;
}

/**
 * The registry entry for an address, when one exists.
 *
 * NOTE: the SDK's `PublicKeyEntry` names these `noteKey`/`encryptionKey` —
 * deliberately different from `UserPublicKeys`' `notePublicKey`/
 * `encryptionPublicKey` (the derived keys). Comparing an entry against
 * derived keys must translate between the two name sets.
 */
interface SdkRecipientEntry {
  noteKey: string;
  encryptionKey: string;
}

interface SdkAccount {
  readonly userAddress: string;
  /** Derives and persists privacy keys (idempotent; needs the signer). */
  derivePrivacyKeys(): Promise<SdkUserPublicKeys>;
  /** Locally derived keys; throws when none are stored yet. */
  privacyKeys(): Promise<SdkUserPublicKeys>;
  isRegistered(): Promise<boolean>;
  registerPublicKeys(): Promise<string>;
  pool(options: { poolContract: string }): Promise<SdkPool>;
}

interface SdkPool {
  balance(): Promise<bigint>;
  notes(): Promise<Array<{ id: string; amount: string; spent: boolean; leafIndex: number }>>;
  deposit(amount: bigint): Promise<SdkPoolExecuteResult>;
  transfer(recipient: string, amount: bigint): Promise<SdkPoolExecuteResult>;
  withdraw(amount: bigint, recipient?: string | null): Promise<SdkPoolExecuteResult>;
}

interface SdkPoolExecuteResult {
  status: string;
  hashes: string[];
  message?: string;
}

interface SdkClient {
  backgroundSync(): Promise<void>;
  stopBackgroundSync(): void;
  sync(): Promise<void>;
  allContractsData(): Promise<{ pools: SdkPoolInfo[] }>;
  recipientLookup(address: string): Promise<{ entry?: SdkRecipientEntry }>;
  account(
    options: { networkPassphrase: string; userAddress?: string; signerAddress?: string },
    signer: SdkSigner,
  ): Promise<SdkAccount>;
}

interface SdkModule {
  default: () => Promise<void>;
  Storage: { open(options?: { workerUrl?: string }): Promise<SdkStorage> };
  bootnodeRequired(
    rpcUrl: string,
    storage: SdkStorage,
    options: { contractConfig: unknown },
  ): Promise<boolean>;
  /**
   * A plain object whose `new` method builds the client (not a class, so a
   * construct signature would be wrong — it is a callable PROPERTY).
   */
  Client: {
    new: (options: {
      rpcUrl: string;
      storage?: SdkStorage;
      contractConfig: unknown;
      circuitsBaseUrl: string;
      circuitLock: unknown;
      bootnodeUrl?: string;
    }) => Promise<SdkClient>;
  };
}

// ---------------------------------------------------------------------------
// Runtime bootstrap (lazy — nothing loads until the first SPP op)
// ---------------------------------------------------------------------------

let sdkModule: SdkModule | null = null;
let storage: SdkStorage | null = null;
let client: SdkClient | null = null;
let bootnodeRequired: boolean | null = null;
let accountAddress: string | null = null;
let account: SdkAccount | null = null;
let pool: SdkPool | null = null;
let bootstrapPromise: Promise<void> | null = null;

/**
 * Drops the half-built parts of a failed bootstrap so the next exec retries.
 *
 * The storage worker and WASM module are deliberately KEPT: the worker holds
 * the OPFS database lock, and spawning a second one would fail every later
 * attempt with "another tab is using this app's local database". They are
 * singletons for the document's lifetime, reusable across client rebuilds.
 */
function resetRuntime(): void {
  client = null;
  bootnodeRequired = null;
  accountAddress = null;
  account = null;
  pool = null;
  bootstrapPromise = null;
}

/** Idempotently imports the SDK module and initializes WASM. */
async function ensureSdkModule(): Promise<SdkModule> {
  if (sdkModule !== null) return sdkModule;
  const url = chrome.runtime.getURL('spp/js/index.js');
  const mod = (await import(/* @vite-ignore */ url)) as SdkModule;
  await mod.default();
  sdkModule = mod;
  return mod;
}

/**
 * Loads the pinned circuit lock (circuits.json) from the static package
 * copy. The lock fingerprints every circuit artifact the prover may fetch,
 * so a swapped or corrupted file fails its hash check instead of producing
 * proofs the pool rejects.
 */
async function loadCircuitLock(): Promise<unknown> {
  const response = await fetch(chrome.runtime.getURL('spp/circuits.json'));
  if (!response.ok) {
    throw new Error('The circuit lock file is missing from the package.');
  }
  return response.json();
}

/** Bootstraps the whole runtime: storage, client, sync, account, pool. */
async function ensureRuntime(address: string): Promise<void> {
  if (bootstrapPromise !== null) {
    await bootstrapPromise;
    if (client !== null && accountAddress === address) return;
  }
  bootstrapPromise = (async () => {
    const mod = await ensureSdkModule();

    if (storage === null) {
      storage = await mod.Storage.open();
    }

    if (bootnodeRequired === null) {
      bootnodeRequired = await mod.bootnodeRequired(SPP_RPC_URL, storage, {
        contractConfig: SPP_CONTRACT_CONFIG,
      });
      if (bootnodeRequired) {
        throw new Error(
          'The privacy pool history has aged out of the public RPC. A newer pool deployment is required — update the wallet.',
        );
      }
    }

    if (client === null) {
      client = await mod.Client.new({
        rpcUrl: SPP_RPC_URL,
        storage,
        contractConfig: SPP_CONTRACT_CONFIG,
        circuitsBaseUrl: chrome.runtime.getURL('spp/dist/circuits/'),
        circuitLock: await loadCircuitLock(),
      });
      await client.backgroundSync();
    }

    if (account === null || accountAddress !== address) {
      account = await client.account(
        { networkPassphrase: SPP_NETWORK_PASSPHRASE, userAddress: address },
        createBackgroundSigner(),
      );
      accountAddress = address;
      pool = null;
      // Derive (or confirm) the privacy keys. Idempotent, but the FIRST run
      // for a wallet needs the vault-signed derivation message, and pool ops
      // fail with a cryptic "no privacy keys" without this.
      await account.derivePrivacyKeys();
    }

    if (pool === null) {
      pool = await account.pool({ poolContract: SPP_POOL_CONTRACT_ID });
    }
  })();

  try {
    await bootstrapPromise;
  } catch (cause) {
    // A failed bootstrap must not cache a half-built runtime.
    resetRuntime();
    throw cause;
  }
}

// ---------------------------------------------------------------------------
// Signer bridge: offscreen → background (keys never leave the service worker)
// ---------------------------------------------------------------------------

/**
 * The signer handed to the SDK. Each callback round-trips to the background,
 * which signs inside `vault.withAccount` with the wallet's Stellar account 0
 * key and returns the base64 signature / signed envelope.
 */
function createBackgroundSigner(): SdkSigner {
  const call = async (
    op: 'signMessage' | 'signTransaction' | 'signAuthEntry',
    body: { message?: string; xdr?: string; preimage?: string; networkPassphrase?: string },
  ): Promise<string> => {
    const address = accountAddress;
    if (address === null) throw new Error('The SPP account session is not bound yet.');
    const response = (await chrome.runtime.sendMessage({
      channel: INTERNAL_CHANNEL,
      kind: 'spp:sign',
      id: crypto.randomUUID(),
      op,
      address,
      ...body,
    })) as SppSignResponse | undefined;
    if (response === undefined || typeof response !== 'object') {
      throw new Error('The background did not answer the signing request.');
    }
    if (!response.ok) {
      // Carry the protocol error code (e.g. VAULT_LOCKED) so the failure
      // surfaces with its real meaning instead of a generic message.
      throw Object.assign(new Error(response.message), { code: response.code });
    }
    return response.result;
  };

  return {
    async getPublicKey() {
      const address = accountAddress;
      if (address === null) throw new Error('The SPP account session is not bound yet.');
      return address;
    },
    async signMessage(message) {
      const address = accountAddress!;
      return { signedMessage: await call('signMessage', { message }), signerAddress: address };
    },
    async signTransaction(xdr, opts = {}) {
      const address = accountAddress!;
      return {
        signedTxXdr: await call('signTransaction', {
          xdr,
          networkPassphrase: opts.networkPassphrase ?? SPP_NETWORK_PASSPHRASE,
        }),
        signerAddress: address,
      };
    },
    async signAuthEntry(preimage) {
      const address = accountAddress!;
      return {
        signedAuthEntry: await call('signAuthEntry', { preimage }),
        signerAddress: address,
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Keepalive: hold the service worker (and the unlocked vault) through long ops
// ---------------------------------------------------------------------------

/**
 * Groth16 proving takes seconds to minutes with no background traffic in
 * between — long enough for MV3 to evict the service worker, which locks the
 * vault and kills the in-flight op at the next signing callback. A ping every
 * 20 s keeps the worker (and the unlocked session) alive while an op runs.
 */
const KEEPALIVE_INTERVAL_MS = 20_000;

function startKeepalive(): () => void {
  const timer = setInterval(() => {
    void chrome.runtime
      .sendMessage({ channel: INTERNAL_CHANNEL, kind: 'spp:ping', id: crypto.randomUUID() })
      .catch(() => undefined);
  }, KEEPALIVE_INTERVAL_MS);
  return () => clearInterval(timer);
}

// ---------------------------------------------------------------------------
// Operation execution (background → offscreen)
// ---------------------------------------------------------------------------

/** Pulls the single transaction hash out of a PoolExecuteResult. */
function requireTxHash(result: SdkPoolExecuteResult): string {
  if (result.status !== 'ok') {
    const detail = result.message ?? `status ${result.status}`;
    throw new Error(`The pool rejected the operation: ${detail}`);
  }
  const hash = result.hashes[0];
  if (hash === undefined || hash.length === 0) {
    throw new Error('The pool operation succeeded but reported no transaction hash.');
  }
  return hash;
}

/**
 * Compares a registry entry against this wallet's derived keys.
 *
 * Both sides are 0x-prefixed hex from the same Rust crypto layer, so a plain
 * comparison would do; the case-normalization only guards against a future
 * format drift on either side.
 */
function entryMatchesKeys(entry: SdkRecipientEntry, keys: SdkUserPublicKeys): boolean {
  return (
    entry.noteKey.toLowerCase() === keys.notePublicKey.toLowerCase() &&
    entry.encryptionKey.toLowerCase() === keys.encryptionPublicKey.toLowerCase()
  );
}

/**
 * Waits until the local registry index reflects this wallet's entry.
 *
 * Best-effort with a bounded budget: on-chain the registration already
 * succeeded, so a timeout is not an error — the background indexer fills the
 * entry shortly and `status` will pick it up.
 */
async function waitForRegistration(
  client: SdkClient,
  account: SdkAccount,
  address: string,
): Promise<void> {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      await client.sync();
      const keys = await account.privacyKeys();
      const lookup = await client.recipientLookup(address);
      if (lookup.entry !== undefined && entryMatchesKeys(lookup.entry, keys)) {
        return;
      }
    } catch {
      // A transient sync/read failure just shortens the wait; retry.
    }
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
}

/** Executes one SPP op on behalf of the background. Throws on failure. */
export async function executeSppOp(
  op: SppExecOp,
  payload: { address: string; amountStroops?: string; to?: string },
): Promise<unknown> {
  if (typeof payload.address !== 'string' || payload.address.length === 0) {
    throw new Error('The SPP operation is missing the wallet address.');
  }

  const stopKeepalive = startKeepalive();
  try {
    await ensureRuntime(payload.address);

    switch (op) {
      case 'status': {
        if (pool === null || account === null || client === null) {
          throw new Error('The SPP runtime is not ready.');
        }
        // Catch the local index up first: balances and the registry entry are
        // only as fresh as the last ingested event, and a status read right
        // after a money op must reflect it.
        await client.sync();
        const [balance, contracts, keys, lookup] = await Promise.all([
          pool.balance(),
          client.allContractsData(),
          account.privacyKeys(),
          client.recipientLookup(payload.address),
        ]);
        const poolInfo = contracts.pools.find((p) => p.contractId === SPP_POOL_CONTRACT_ID);
        // "Registered" means the on-chain entry matches THIS wallet's derived
        // keys — an entry left by an older key derivation (a derivation-format
        // change, or a restored wallet on a fresh device) would route
        // transfers to keys this wallet cannot read.
        const registered = lookup.entry !== undefined && entryMatchesKeys(lookup.entry, keys);
        return {
          poolContractId: SPP_POOL_CONTRACT_ID,
          assetSymbol: SPP_ASSET_SYMBOL,
          balanceStroops: balance.toString(),
          registered,
          bootnodeRequired: bootnodeRequired === true,
          syncedLedger: poolInfo?.ledger ?? 0,
          readAt: Date.now(),
        };
      }
      case 'sync': {
        if (client === null) throw new Error('The SPP runtime is not ready.');
        await client.sync();
        return { ok: true };
      }
      case 'register': {
        if (account === null || client === null) throw new Error('The SPP runtime is not ready.');
        const txHash = await account.registerPublicKeys();
        // The on-chain entry exists now, but the LOCAL registry index only
        // fills when the indexer ingests the event (seconds on testnet).
        // Wait for it so "registered" is true when this op returns — the
        // whole point of registering is receiving transfers right after.
        await waitForRegistration(client, account, payload.address);
        return { txHash: String(txHash) };
      }
      case 'deposit': {
        if (pool === null) throw new Error('The SPP runtime is not ready.');
        const amount = BigInt(payload.amountStroops ?? '');
        if (amount <= 0n) throw new Error('The deposit amount must be positive.');
        const result = await pool.deposit(amount);
        return { txHash: requireTxHash(result), amountStroops: amount.toString() };
      }
      case 'transfer': {
        if (pool === null || client === null) throw new Error('The SPP runtime is not ready.');
        // Spending notes requires the just-created ones to be indexed: sync
        // first, or a transfer immediately after a deposit reports "no
        // spendable notes" even though the funds are there.
        await client.sync();
        const amount = BigInt(payload.amountStroops ?? '');
        if (amount <= 0n) throw new Error('The transfer amount must be positive.');
        const to = payload.to;
        if (typeof to !== 'string' || to.length === 0) {
          throw new Error('A private transfer needs a recipient address.');
        }
        const result = await pool.transfer(to, amount);
        return { txHash: requireTxHash(result), amountStroops: amount.toString() };
      }
      case 'withdraw': {
        if (pool === null || client === null) throw new Error('The SPP runtime is not ready.');
        // Same as transfer: the notes being spent must be locally visible.
        await client.sync();
        const amount = BigInt(payload.amountStroops ?? '');
        if (amount <= 0n) throw new Error('The withdraw amount must be positive.');
        const result = await pool.withdraw(amount);
        return { txHash: requireTxHash(result), amountStroops: amount.toString() };
      }
      default:
        throw new Error(`Unknown SPP operation: ${String(op)}`);
    }
  } finally {
    stopKeepalive();
  }
}

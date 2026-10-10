import { create } from 'zustand';
import { createClient } from '@/core/messaging/client';
import type {
  ChainId,
  CustomToken,
  MessageSource,
  NetworkSummary,
  StellarAssetInput,
  TokenInputType,
  VaultState,
  ZkCapability,
} from '@/core/messaging/protocol';
import type { IndexerTx } from '@/core/chains/indexer-service';
import type { X402Challenge } from '@/core/x402/types';
import type { GrantCaps } from '@/core/vap/grant';

/**
 * UI-side wallet state.
 *
 * Holds only what a surface can safely see: vault state, addresses, balances,
 * and the measured ZK capability. No key material crosses into this store,
 * because everything it knows is one `chrome.runtime.sendMessage` away from a
 * page context if a surface is ever compromised.
 *
 * Actions map one-to-one onto request kinds the background implements. The
 * lifecycle actions return a boolean rather than throwing, so a caller can keep
 * the user on the current screen and show `error` without a try/catch at every
 * call site. A freshly generated recovery phrase is the one value returned to
 * the caller instead of being stored — see `generateMnemonic`.
 */

export interface AccountView {
  chain: ChainId;
  index: number;
  address: string;
  path: string;
}

/** Keyed `chain:address`, since one address is only meaningful for its chain. */
export type BalanceKey = `${ChainId}:${string}`;

export function balanceKey(chain: ChainId, address: string): BalanceKey {
  return `${chain}:${address}`;
}

export interface SecurityStatus {
  pinEnabled: boolean;
  webauthnEnabled: boolean;
}

export interface PendingConnection {
  origin: string;
  requestedAccounts: { chain: string; address: string }[];
  createdAt: number;
}

/** Pending dapp transaction/signature request awaiting a human decision. */
export interface PendingApproval {
  id: string;
  kind: 'tx' | 'sign';
  origin: string;
  address: string;
  to?: string;
  value?: string;
  data?: string;
  message?: string;
  /** Display symbol for `value`; absent means ETH. */
  symbol?: string;
  /** Decimals for `value`; absent means 18. */
  decimals?: number;
  createdAt: number;
}

/** Pending x402 payment request awaiting a human decision. */
export interface PendingX402Payment {
  id: string;
  origin: string;
  /** The challenge issued by the server's 402 response. */
  challenge: X402Challenge;
  createdAt: number;
}

/** Pending VAP grant request awaiting a human decision. */
export interface PendingGrantRequest {
  id: string;
  origin: string;
  /** The caps the page asked for; shown verbatim in the approval overlay. */
  requestedCaps: GrantCaps;
  /** Requested lifetime in seconds. */
  expiresInSeconds: number;
  createdAt: number;
}

interface WalletState {
  vaultState: VaultState;
  unlockedUntil: number | null;
  accounts: AccountView[];
  accountIndex: number;
  /**
   * Index into `accounts` of the network the dashboard is showing. Lifted
   * into the store (not Dashboard-local state) so navigating to
   * send/receive and back keeps the user's selected network — local state
   * reset to EVM on every remount.
   */
  selectedAccountIdx: number;
  /** Native units (wei / lamports / stroops). Absent until fetched. */
  balances: Partial<Record<BalanceKey, bigint>>;
  zkCapability: ZkCapability | null;
  securityStatus: SecurityStatus | null;
  isLoading: boolean;
  /** Display-safe message from the protocol layer. */
  error: string | null;
  /** Pending dapp connection request (set by background, consumed by popup). */
  pendingConnection: PendingConnection | null;
  /** Pending dapp transaction/signature request (set by background, shown by UI). */
  pendingApproval: PendingApproval | null;
  /** Pending x402 payment request (set by background, shown by UI). */
  pendingX402Payment: PendingX402Payment | null;
  /** Pending VAP grant request (set by background, shown by UI). */
  pendingGrantRequest: PendingGrantRequest | null;
  /** Pending WalletConnect session proposal awaiting approval. */
  pendingWcProposal: {
    id: number;
    name: string;
    url: string;
    requiredNamespaces: Record<string, { chains: string[]; methods: string[]; events: string[] }>;
    optionalNamespaces?: Record<string, { chains: string[]; methods: string[]; events: string[] }>;
    expiry: number;
    createdAt: number;
  } | null;
  /** Active WalletConnect sessions. */
  wcSessions: Array<{
    topic: string;
    name: string;
    url: string;
    accounts: string[];
    createdAt: number;
    expiry: string;
  }>;
  /** Pending WalletConnect request awaiting approval. */
  pendingWcRequest: {
    topic: string;
    requestId: number;
    chainId: string;
    method: string;
    hint: string;
    createdAt: number;
  } | null;
  /** Every selectable network (presets + the user's custom RPCs). */
  networks: NetworkSummary[];
  /** The selected network id per chain (from the background's persisted selection). */
  selectedNetworks: Partial<Record<ChainId, string>>;
  /** Registered custom tokens (MetaMask-style add-token registry). */
  customTokens: CustomToken[];
  /** Base-unit token balances, keyed by token registry id. */
  tokenBalances: Partial<Record<string, bigint>>;
}

interface WalletActions {
  /** Reads vault state and the cached ZK capability. Safe while locked. */
  refresh(): Promise<void>;
  loadAccounts(): Promise<void>;
  loadBalance(chain: ChainId, address: string): Promise<void>;
  loadAllBalances(): Promise<void>;
  /** Requests testnet funds for a chain address via the background faucet. */
  requestFaucet(chain: ChainId, address: string): Promise<{
    ok: boolean;
    txHash?: string;
    faucetUrl?: string;
    error?: string;
  }>;
  /**
   * Loads transaction history for one address through the background, which
   * owns the fetch (the SW has host permissions; the popup does not, so a
   * direct fetch from popup.html fails CORS). Falls back to the local cache
   * when the indexer is unreachable.
   */
  loadHistory(chain: ChainId, address: string, limit?: number): Promise<{
    transactions: IndexerTx[];
    nextCursor: string | null;
    source: 'remote' | 'cache';
  }>;
  /**
   * A new phrase for the user to write down, or null if the request failed.
   *
   * Returned to the caller and never placed in the store: a recovery phrase
   * parked in observable state is one devtools session away from being read.
   * The caller must not persist it either — hand it straight to `createVault`.
   */
  generateMnemonic(strength?: 128 | 256): Promise<string | null>;
  createVault(mnemonic: string, passphrase: string): Promise<boolean>;
  unlock(passphrase: string): Promise<boolean>;
  /** Destructive: wipes the encrypted vault on this device. */
  reset(): Promise<boolean>;
  lock(): Promise<void>;
  setAccountIndex(index: number): void;
  /** Selects which account/network card the dashboard shows. */
  setSelectedAccountIdx(index: number): void;
  clearError(): void;
  /** Fetch a fee estimate for a transfer. Throws on failure. */
  estimateTransfer(
    chain: ChainId,
    index: number,
    to: string,
    amount: string,
    asset?: StellarAssetInput,
    token?: TokenInputType,
  ): Promise<{
    feeNative: string;
    gasLimit: string;
    assetCode?: string;
    decimals: number;
    spendableBalance: string;
    symbol?: string;
  }>;
  /** Export a private key for a chain account. Security-sensitive. */
  exportKey(chain: ChainId, index: number): Promise<{ privateKey: string; address: string }>;
  /** Build, sign, and broadcast a transfer. Returns the tx hash. Throws on failure. */
  sendTransfer(
    chain: ChainId,
    index: number,
    to: string,
    amount: string,
    asset?: StellarAssetInput,
    token?: TokenInputType,
    /** Optional Stellar MEMO_TEXT (≤ 28 bytes). */
    memo?: string,
    /** Optional Stellar privacy payment (one-time stealth address). */
    isPrivate?: boolean,
  ): Promise<{ hash: string; decimals: number; to: string; private?: boolean }>;
  /** Security settings for the setup flow. Safe while locked. */
  loadSecurityStatus(): Promise<void>;
  setupSecurityPin(pin: string): Promise<boolean>;
  verifySecurityPin(pin: string): Promise<boolean>;
  setupSecurityWebAuthn(): Promise<boolean>;
  /** Reads the current pending dapp connection request, if any. */
  loadPendingConnection(): Promise<void>;
  /** Approves (grants) or denies the pending dapp connection. */
  resolvePendingConnection(
    origin: string,
    addresses: string[],
    action: 'approve' | 'deny',
  ): Promise<boolean>;
  /** Reads the current pending dapp transaction/signature request, if any. */
  loadPendingApproval(): Promise<void>;
  /** Approves or denies the pending dapp transaction/signature request. */
  resolvePendingApproval(id: string, action: 'approve' | 'deny'): Promise<boolean>;
  /** Reads the current pending x402 payment request, if any. */
  loadPendingX402(): Promise<void>;
  /** Approves or denies the pending x402 payment request. */
  resolvePendingX402(id: string, action: 'approve' | 'deny'): Promise<boolean>;
  /** Reads the current pending VAP grant request, if any. */
  loadPendingGrantRequest(): Promise<void>;
  /**
   * Approves or denies the pending VAP grant request.
   * `pin` is required on approve when the wallet has a PIN configured; `webauthn`
   * must be true when WebAuthn is the configured confirmation method (VAP-01).
   */
  resolvePendingGrantRequest(
    id: string,
    action: 'approve' | 'deny',
    pin?: string,
    webauthn?: boolean,
  ): Promise<boolean>;
  /** Starts a WebAuthn ceremony; returns the credential id and hex challenge. */
  requestWebAuthnChallenge(): Promise<{ credentialId: string; challenge: string } | null>;
  /** WalletConnect: pair with a dapp URI. */
  wcPair(uri: string): Promise<boolean>;
  /** WalletConnect: load pending proposal. */
  loadWcProposal(): Promise<void>;
  /** WalletConnect: approve a proposal. */
  wcApproveProposal(proposalId: number, accounts: string[]): Promise<boolean>;
  /** WalletConnect: reject a proposal. */
  wcRejectProposal(proposalId: number): Promise<boolean>;
  /** WalletConnect: list sessions. */
  loadWcSessions(): Promise<void>;
  /** WalletConnect: disconnect a session. */
  wcDisconnect(topic: string): Promise<boolean>;
  /** WalletConnect: load pending request. */
  loadWcRequest(): Promise<void>;
  /** WalletConnect: resolve pending request (approve or deny). */
  wcResolveRequest(action: 'approve' | 'deny'): Promise<boolean>;
  /** Networks: load every selectable network and the per-chain selection. */
  loadNetworks(): Promise<void>;
  /** Networks: persist the selected network for a chain. Returns false when the id is invalid. */
  selectNetwork(chain: ChainId, networkId: string): Promise<boolean>;
  /** Networks: register a custom RPC endpoint. False on a duplicate name. */
  addCustomNetwork(input: {
    chain: ChainId;
    name: string;
    rpcUrl: string;
    chainId?: number;
    explorerUrl?: string;
  }): Promise<boolean>;
  /** Networks: remove a custom RPC by name. */
  removeCustomNetwork(name: string): Promise<boolean>;
  /** Tokens: load the registry (and refresh balances for loaded accounts). */
  loadTokens(): Promise<void>;
  /** Tokens: register one. Returns the token plus any trustline hash. Throws on failure. */
  addToken(input: {
    chain: ChainId;
    contract?: string;
    code?: string;
    issuer?: string;
    symbol?: string;
    createTrustline?: boolean;
  }): Promise<{ token: CustomToken; trustlineHash?: string }>;
  /** Tokens: remove one by registry id. */
  removeToken(id: string): Promise<boolean>;
  /** Tokens: refresh balances for every registered token of one address. */
  loadTokenBalances(chain: ChainId, address: string): Promise<void>;
  /** Privacy: the recipient's published stealth meta-address, or null. */
  fetchStealthMeta(address: string): Promise<{ spendPub: string; viewPub: string } | null>;
  /** Privacy: publish this wallet's meta-address (manage_data `vpstealth`). */
  publishStealthMeta(): Promise<{ txHash: string; alreadyPublished: boolean }>;
  /** Privacy: scan recent announcements for claimable one-time payments. */
  scanStealthPayments(): Promise<
    Array<{ txHash: string; oneTimeAddress: string; amountStroops: string; createdAt: string }>
  >;
  /** Privacy: sweep a found one-time payment into the wallet's Stellar account. */
  claimStealthPayment(txHash: string): Promise<{ txHash: string }>;
}

const send = createClient('popup' as MessageSource);
let refreshInFlight: Promise<void> | null = null;

/**
 * `chrome.storage.session` accessor for UI prefs (which chain card the
 * dashboard shows). Survives popup close/reopen within a browser session —
 * the fix for "switch network, close, reopen: back on EVM" — and is null
 * outside Chrome (tests, non-extension hosts) where the in-memory default
 * applies.
 */
const UI_SELECTION_KEY = 'ui:selectedAccountIdx';
const sessionStore = globalThis.chrome?.storage?.session;

async function persistSelectedAccountIdx(index: number): Promise<void> {
  try {
    await sessionStore?.set({ [UI_SELECTION_KEY]: index });
  } catch {
    // Non-fatal: an unpersisted selection only resets on the next popup open.
  }
}

async function restoreSelectedAccountIdx(): Promise<number | null> {
  try {
    const stored = await sessionStore?.get(UI_SELECTION_KEY);
    const value = stored?.[UI_SELECTION_KEY];
    return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null;
  } catch {
    return null;
  }
}

function messageFor(cause: unknown, fallback: string): string {
  return cause instanceof Error ? cause.message : fallback;
}

/**
 * Reads vault status (required) and the ZK capability (cosmetic).
 *
 * The ZK probe result only drives a footer badge; a slow or failing
 * `zk.capability` read must never block the wallet from rendering. vault.status
 * is load-bearing and its failure rejects the whole refresh.
 */
async function readStatus(): Promise<
  [{ state: VaultState; unlockedUntil: number | null }, ZkCapability | null]
> {
  const status = await send('vault.status', {});
  let zk: ZkCapability | null = null;
  try {
    // Normalize a malformed/absent response to null — the store contract is
    // `ZkCapability | null`, and `undefined` would crash the ZkResult card.
    zk = (await send('zk.capability', {})) ?? null;
  } catch {
    // Cosmetic read; keep boot moving.
  }
  return [status, zk];
}

export const useWallet = create<WalletState & WalletActions>((set, get) => ({
  vaultState: 'uninitialized',
  unlockedUntil: null,
  accounts: [],
  accountIndex: 0,
  selectedAccountIdx: 0,
  balances: {},
  zkCapability: null,
  securityStatus: null,
  pendingConnection: null,
  pendingApproval: null,
  pendingX402Payment: null,
  pendingGrantRequest: null,
  pendingWcProposal: null,
  wcSessions: [],
  pendingWcRequest: null,
  networks: [],
  selectedNetworks: {},
  customTokens: [],
  tokenBalances: {},
  isLoading: false,
  error: null,

  refresh: async () => {
    if (refreshInFlight !== null) return refreshInFlight;
    refreshInFlight = (async () => {
      set({ isLoading: true, error: null });
      try {
        const [status, zk] = await readStatus();
        set({
          vaultState: status.state,
          unlockedUntil: status.unlockedUntil,
          zkCapability: zk,
        });
        // Restore the persisted dashboard selection once per surface boot,
        // then load the network list + selection so every label is live.
        const restored = await restoreSelectedAccountIdx();
        if (restored !== null && get().selectedAccountIdx !== restored) {
          set({ selectedAccountIdx: restored });
        }
        await get().loadNetworks();
        await get().loadTokens();
      } catch (firstError) {
        // Chrome can be slow to wake a cold service worker; the first status
        // read occasionally times out before the SW registers. Retry once
        // silently before surfacing an error so a slow cold start self-heals.
        try {
          await new Promise((resolve) => setTimeout(resolve, 600));
          const [status, zk] = await readStatus();
          set({
            error: null,
            vaultState: status.state,
            unlockedUntil: status.unlockedUntil,
            zkCapability: zk,
          });
        } catch {
          set({ error: messageFor(firstError, 'Could not read wallet status.') });
        }
      } finally {
        set({ isLoading: false });
        refreshInFlight = null;
      }
    })();
    return refreshInFlight;
  },

  loadAccounts: async () => {
    set({ isLoading: true, error: null });
    try {
      const accounts = await send('accounts.list', { accountIndex: get().accountIndex });
      // Coalesce so the store invariant `accounts: AccountView[]` holds even if
      // a malformed/absent response comes back — otherwise consumers reading
      // `accounts.length` crash on `undefined`.
      set({ accounts: Array.isArray(accounts) ? accounts : [] });
    } catch (cause) {
      // A locked vault arrives here as VAULT_LOCKED; surface it and clear stale
      // addresses rather than leaving the previous account list on screen.
      set({ accounts: [], error: messageFor(cause, 'Could not load accounts.') });
    } finally {
      set({ isLoading: false });
    }
  },

  loadBalance: async (chain, address) => {
    set({ error: null });
    try {
      const result = await send('account.balance', { chain, address });
      set({
        balances: {
          ...get().balances,
          [balanceKey(chain, address)]: BigInt(result.balance),
        },
      });
    } catch (cause) {
      set({ error: messageFor(cause, 'Could not fetch balance.') });
    }
  },

  loadAllBalances: async () => {
    const { accounts } = get();
    if (accounts.length === 0) return;

    set({ isLoading: true, error: null });
    // One slow or down RPC must not hide the chains that did answer, so failures
    // are collected per account instead of rejecting the whole batch.
    const settled = await Promise.allSettled(
      accounts.map(async (account) => ({
        key: balanceKey(account.chain, account.address),
        balance: BigInt((await send('account.balance', account)).balance),
      })),
    );

    const balances = { ...get().balances };
    let failures = 0;
    for (const outcome of settled) {
      if (outcome.status === 'fulfilled') {
        balances[outcome.value.key] = outcome.value.balance;
      } else {
        failures += 1;
      }
    }

    set({
      balances,
      isLoading: false,
      error:
        failures === 0
          ? null
          : `${failures} of ${settled.length} balances could not be fetched.`,
    });
  },

  requestFaucet: async (chain, address) => {
    set({ error: null });
    try {
      return await send('faucet.request', { chain, address });
    } catch (cause) {
      const error = messageFor(cause, 'Could not request testnet funds.');
      set({ error });
      return { ok: false, error };
    }
  },

  loadHistory: async (chain, address, limit = 20) => {
    try {
      const history = await send('indexer.history', { chain, address, limit });
      // Coalesce so the store contract always holds, even for a malformed/
      // absent response — consumers read `.transactions` right away.
      return {
        transactions: Array.isArray(history?.transactions) ? history.transactions : [],
        nextCursor: history?.nextCursor ?? null,
        source: history?.source ?? ('cache' as const),
      };
    } catch (cause) {
      const msg = messageFor(cause, 'Could not load transaction history.');
      set({ error: msg });
      return { transactions: [], nextCursor: null, source: 'cache' as const };
    }
  },

  generateMnemonic: async (strength = 256) => {
    set({ isLoading: true, error: null });
    try {
      return (await send('mnemonic.generate', { strength })).mnemonic;
    } catch (cause) {
      set({ error: messageFor(cause, 'Could not generate a recovery phrase.') });
      return null;
    } finally {
      set({ isLoading: false });
    }
  },

  createVault: async (mnemonic, passphrase) => {
    set({ isLoading: true, error: null });
    try {
      const { state } = await send('vault.create', { mnemonic, passphrase });
      // Creation leaves the vault unlocked; addresses are loaded by the caller
      // so onboarding controls when the first derivation happens.
      set({ vaultState: state });
      return true;
    } catch (cause) {
      set({ error: messageFor(cause, 'Could not create the wallet.') });
      return false;
    } finally {
      set({ isLoading: false });
    }
  },

  unlock: async (passphrase) => {
    set({ isLoading: true, error: null });
    try {
      const { state, unlockedUntil } = await send('vault.unlock', { passphrase });
      set({ vaultState: state, unlockedUntil });
      return true;
    } catch (cause) {
      set({ error: messageFor(cause, 'Could not unlock the wallet.') });
      return false;
    } finally {
      set({ isLoading: false });
    }
  },

  reset: async () => {
    set({ isLoading: true, error: null });
    try {
      const { state } = await send('vault.reset', { confirmation: 'DELETE' });
      set({ vaultState: state, unlockedUntil: null, accounts: [], balances: {} });
      return true;
    } catch (cause) {
      set({ error: messageFor(cause, 'Could not reset the wallet.') });
      return false;
    } finally {
      set({ isLoading: false });
    }
  },

  lock: async () => {
    set({ isLoading: true, error: null });
    try {
      const { state } = await send('session.lock', {});
      // Addresses and balances are dropped on lock: leaving them rendered would
      // imply a live session that no longer exists.
      set({
        vaultState: state,
        unlockedUntil: null,
        accounts: [],
        balances: {},
        selectedAccountIdx: 0,
      });
    } catch (cause) {
      set({ error: messageFor(cause, 'Could not lock the wallet.') });
    } finally {
      set({ isLoading: false });
    }
  },

  setAccountIndex: (index) => {
    if (!Number.isInteger(index) || index < 0) return;
    set({ accountIndex: index, accounts: [], balances: {}, selectedAccountIdx: 0 });
  },

  setSelectedAccountIdx: (index) => {
    // Clamp instead of ignoring: the accounts list length is known to the
    // store, so an out-of-range request can safely fall back to 0.
    const max = get().accounts.length - 1;
    let value: number;
    if (!Number.isInteger(index) || index < 0 || max < 0) {
      value = 0;
    } else {
      value = Math.min(index, max);
    }
    set({ selectedAccountIdx: value });
    // Persist so reopening the popup (a fresh store instance) shows the same
    // network card the user chose — the "back to EVM testnet" bug.
    void persistSelectedAccountIdx(value);
  },

  estimateTransfer: async (chain, index, to, amount, asset, token) => {
    set({ error: null });
    try {
      const payload: {
        chain: ChainId;
        index: number;
        to: string;
        amount: string;
        asset?: StellarAssetInput;
        token?: TokenInputType;
      } = { chain, index, to, amount };
      if (asset !== undefined) payload.asset = asset;
      if (token !== undefined) payload.token = token;
      return await send('tx.estimate', payload);
    } catch (cause) {
      set({ error: messageFor(cause, 'Could not estimate the transfer fee.') });
      throw cause;
    }
  },

  sendTransfer: async (chain, index, to, amount, asset, token, memo, isPrivate) => {
    set({ error: null });
    try {
      const payload: {
        chain: ChainId;
        index: number;
        to: string;
        amount: string;
        asset?: StellarAssetInput;
        token?: TokenInputType;
        memo?: string;
        private?: boolean;
      } = { chain, index, to, amount };
      if (asset !== undefined) payload.asset = asset;
      if (token !== undefined) payload.token = token;
      if (memo !== undefined && memo.trim().length > 0) payload.memo = memo.trim();
      if (isPrivate === true) payload.private = true;
      const result = await send('tx.transfer', payload);
      return {
        hash: result.hash,
        decimals: result.decimals,
        to: result.to,
        ...(result.private === true ? { private: true } : {}),
      };
    } catch (cause) {
      set({ error: messageFor(cause, 'Could not send the transfer.') });
      throw cause;
    }
  },

  exportKey: async (chain, index) => {
    set({ error: null });
    try {
      return await send('account.exportKey', { chain, index });
    } catch (cause) {
      set({ error: messageFor(cause, 'Could not export the key.') });
      throw cause;
    }
  },

  loadSecurityStatus: async () => {
    set({ error: null });
    try {
      const status = await send('security.status', {});
      set({ securityStatus: status });
    } catch (cause) {
      set({ error: messageFor(cause, 'Could not read security settings.') });
    }
  },

  setupSecurityPin: async (pin) => {
    set({ isLoading: true, error: null });
    try {
      const { ok } = await send('security.pin.setup', { pin });
      return ok;
    } catch (cause) {
      set({ error: messageFor(cause, 'Could not set up a PIN.') });
      return false;
    } finally {
      set({ isLoading: false });
    }
  },

  verifySecurityPin: async (pin) => {
    set({ error: null });
    try {
      const { ok } = await send('security.pin.verify', { pin });
      return ok;
    } catch (cause) {
      set({ error: messageFor(cause, 'Could not verify the PIN.') });
      return false;
    }
  },

  setupSecurityWebAuthn: async () => {
    set({ isLoading: true, error: null });
    try {
      const { ok } = await send('security.webauthn.setup', {});
      return ok;
    } catch (cause) {
      set({ error: messageFor(cause, 'Could not register a passkey.') });
      return false;
    } finally {
      set({ isLoading: false });
    }
  },

  loadPendingConnection: async () => {
    try {
      const pending = await send('permissions.pending', {});
      // Coalesce so the store invariant is `null | PendingConnection`, never
      // `undefined` — a malformed/absent response would otherwise crash the UI.
      set({ pendingConnection: pending ?? null });
    } catch {
      // A pending request is optional; a read failure is not fatal and must not
      // flip the global error state (it races the boot-time `refresh`).
      set({ pendingConnection: null });
    }
  },

  resolvePendingConnection: async (origin, addresses, action) => {
    set({ isLoading: true, error: null });
    try {
      const { ok } = await send('permissions.connection', { origin, addresses, action });
      if (ok) set({ pendingConnection: null });
      return ok;
    } catch (cause) {
      set({ error: messageFor(cause, 'Could not resolve the connection request.') });
      return false;
    } finally {
      set({ isLoading: false });
    }
  },

  loadPendingApproval: async () => {
    try {
      const pending = await send('tx.pending', {});
      // Coalesce so the store invariant is `null | PendingApproval`.
      set({ pendingApproval: pending ?? null });
    } catch {
      // Optional read; a failure must not pollute the global error state.
      set({ pendingApproval: null });
    }
  },

  resolvePendingApproval: async (id, action) => {
    set({ isLoading: true, error: null });
    try {
      const { ok } = await send('tx.resolve', { id, action });
      if (ok) set({ pendingApproval: null });
      return ok;
    } catch (cause) {
      set({ error: messageFor(cause, 'Could not resolve the approval request.') });
      return false;
    } finally {
      set({ isLoading: false });
    }
  },

  loadPendingX402: async () => {
    try {
      const pending = await send('x402.pending', {});
      // Coalesce so the store invariant is `null | PendingX402Payment`.
      set({ pendingX402Payment: pending ?? null });
    } catch {
      // Optional read; a failure must not pollute the global error state.
      set({ pendingX402Payment: null });
    }
  },

  resolvePendingX402: async (id, action) => {
    set({ isLoading: true, error: null });
    try {
      const { ok } = await send('x402.resolve', { id, action });
      if (ok) set({ pendingX402Payment: null });
      return ok;
    } catch (cause) {
      set({ error: messageFor(cause, 'Could not resolve the payment request.') });
      return false;
    } finally {
      set({ isLoading: false });
    }
  },

  loadPendingGrantRequest: async () => {
    try {
      const pending = await send('vap.grant.pending', {});
      // Coalesce so the store invariant is `null | PendingGrantRequest`.
      set({ pendingGrantRequest: pending ?? null });
    } catch {
      // Optional read; a failure must not pollute the global error state.
      set({ pendingGrantRequest: null });
    }
  },

  resolvePendingGrantRequest: async (id, action, pin, webauthn) => {
    set({ isLoading: true, error: null });
    try {
      const { ok } = await send('vap.grant.resolve', { id, action, pin, webauthn });
      if (ok) set({ pendingGrantRequest: null });
      return ok;
    } catch (cause) {
      set({ error: messageFor(cause, 'Could not resolve the grant request.') });
      return false;
    } finally {
      set({ isLoading: false });
    }
  },

  requestWebAuthnChallenge: async () => {
    set({ error: null });
    try {
      return await send('security.webauthn.challenge', {});
    } catch (cause) {
      set({ error: messageFor(cause, 'Could not start passkey confirmation.') });
      return null;
    }
  },

  clearError: () => set({ error: null }),

  // ---- WalletConnect -----------------------------------------------------

  wcPair: async (uri) => {
    set({ isLoading: true, error: null });
    try {
      await send('wc.pair', { uri });
      return true;
    } catch (cause) {
      set({ error: messageFor(cause, 'Could not start the WalletConnect pairing.') });
      return false;
    } finally {
      set({ isLoading: false });
    }
  },

  loadWcProposal: async () => {
    try {
      const pending = await send('wc.proposal.pending', {});
      set({ pendingWcProposal: pending ?? null });
    } catch {
      // Optional read; never pollute the global error state.
      set({ pendingWcProposal: null });
    }
  },

  wcApproveProposal: async (proposalId, accounts) => {
    set({ isLoading: true, error: null });
    try {
      const { ok } = await send('wc.proposal.approve', { proposalId, accounts });
      if (ok) {
        set({ pendingWcProposal: null });
        await get().loadWcSessions();
      }
      return ok;
    } catch (cause) {
      set({ error: messageFor(cause, 'Could not approve the WalletConnect request.') });
      return false;
    } finally {
      set({ isLoading: false });
    }
  },

  wcRejectProposal: async (proposalId) => {
    set({ isLoading: true, error: null });
    try {
      const { ok } = await send('wc.proposal.reject', { proposalId });
      if (ok) set({ pendingWcProposal: null });
      return ok;
    } catch (cause) {
      set({ error: messageFor(cause, 'Could not reject the WalletConnect request.') });
      return false;
    } finally {
      set({ isLoading: false });
    }
  },

  loadWcSessions: async () => {
    try {
      const sessions = await send('wc.session.list', {});
      set({ wcSessions: Array.isArray(sessions) ? sessions : [] });
    } catch {
      // Optional read; never pollute the global error state.
      set({ wcSessions: [] });
    }
  },

  wcDisconnect: async (topic) => {
    set({ isLoading: true, error: null });
    try {
      const { ok } = await send('wc.session.disconnect', { topic });
      if (ok) await get().loadWcSessions();
      return ok;
    } catch (cause) {
      set({ error: messageFor(cause, 'Could not disconnect the session.') });
      return false;
    } finally {
      set({ isLoading: false });
    }
  },

  loadWcRequest: async () => {
    try {
      const pending = await send('wc.request.pending', {});
      set({ pendingWcRequest: pending ?? null });
    } catch {
      // Optional read; never pollute the global error state.
      set({ pendingWcRequest: null });
    }
  },

  wcResolveRequest: async (action) => {
    set({ isLoading: true, error: null });
    try {
      const { ok } = await send('wc.request.resolve', { action });
      if (ok) set({ pendingWcRequest: null });
      return ok;
    } catch (cause) {
      set({ error: messageFor(cause, 'Could not resolve the WalletConnect request.') });
      return false;
    } finally {
      set({ isLoading: false });
    }
  },

  // ---- Networks -----------------------------------------------------------

  loadNetworks: async () => {
    try {
      const [networks, selected] = await Promise.all([
        send('networks.list', {}),
        send('networks.selected', {}),
      ]);
      set({
        networks: Array.isArray(networks) ? networks : [],
        selectedNetworks:
          typeof selected === 'object' && selected !== null ? selected : {},
      });
    } catch {
      // The network list is cosmetic-but-load-bearing for labels; a failure
      // keeps the previous list (labels fall back to the chain name) and must
      // not block the boot status read that runs alongside it.
    }
  },

  selectNetwork: async (chain, networkId) => {
    set({ isLoading: true, error: null });
    try {
      const { ok } = await send('networks.select', { chain, networkId });
      if (ok) {
        set({ selectedNetworks: { ...get().selectedNetworks, [chain]: networkId } });
        // Balances and history are network-scoped; reload them so the
        // dashboard reflects the new network immediately.
        await get().loadAllBalances();
      }
      return ok;
    } catch (cause) {
      set({ error: messageFor(cause, 'Could not switch the network.') });
      return false;
    } finally {
      set({ isLoading: false });
    }
  },

  addCustomNetwork: async (input) => {
    set({ isLoading: true, error: null });
    try {
      const { ok } = await send('networks.custom.add', input);
      if (ok) await get().loadNetworks();
      return ok;
    } catch (cause) {
      set({ error: messageFor(cause, 'Could not add the custom network.') });
      return false;
    } finally {
      set({ isLoading: false });
    }
  },

  removeCustomNetwork: async (name) => {
    set({ isLoading: true, error: null });
    try {
      const { ok } = await send('networks.custom.remove', { name });
      if (ok) await get().loadNetworks();
      return ok;
    } catch (cause) {
      set({ error: messageFor(cause, 'Could not remove the custom network.') });
      return false;
    } finally {
      set({ isLoading: false });
    }
  },

  // ---- Custom tokens -------------------------------------------------------

  loadTokens: async () => {
    try {
      const tokens = await send('tokens.list', {});
      set({ customTokens: Array.isArray(tokens) ? tokens : [] });
      // Balances are per-address: refresh for every account already loaded.
      const { accounts } = get();
      await Promise.all(
        accounts.map((account) => get().loadTokenBalances(account.chain, account.address)),
      );
    } catch {
      // Optional read; keep the previous list rather than blocking boot.
    }
  },

  addToken: async (input) => {
    set({ isLoading: true, error: null });
    try {
      const result = await send('tokens.add', input);
      await get().loadTokens();
      return result;
    } catch (cause) {
      set({ error: messageFor(cause, 'Could not add the token.') });
      throw cause;
    } finally {
      set({ isLoading: false });
    }
  },

  removeToken: async (id) => {
    set({ isLoading: true, error: null });
    try {
      const { ok } = await send('tokens.remove', { id });
      if (ok) {
        const tokenBalances = { ...get().tokenBalances };
        delete tokenBalances[id];
        set({ customTokens: get().customTokens.filter((t) => t.id !== id), tokenBalances });
      }
      return ok;
    } catch (cause) {
      set({ error: messageFor(cause, 'Could not remove the token.') });
      return false;
    } finally {
      set({ isLoading: false });
    }
  },

  loadTokenBalances: async (chain, address) => {
    try {
      const balances = await send('tokens.balances', { chain, address });
      if (!Array.isArray(balances)) return;
      const next = { ...get().tokenBalances };
      for (const entry of balances) {
        try {
          next[entry.id] = BigInt(entry.balance);
        } catch {
          next[entry.id] = 0n;
        }
      }
      set({ tokenBalances: next });
    } catch {
      // Optional read; failures leave the previous balances rendered.
    }
  },

  fetchStealthMeta: async (address) => {
    try {
      return await send('stellar.stealth.meta', { address });
    } catch {
      // A failed lookup behaves exactly like "not published": the UI keeps
      // the send flow usable and only disables the private toggle.
      return null;
    }
  },

  publishStealthMeta: async () => {
    set({ isLoading: true, error: null });
    try {
      return await send('stellar.stealth.publish', {});
    } catch (cause) {
      set({ error: messageFor(cause, 'Could not publish the privacy meta-address.') });
      throw cause;
    } finally {
      set({ isLoading: false });
    }
  },

  scanStealthPayments: async () => {
    try {
      const found = await send('stellar.stealth.scan', {});
      return Array.isArray(found) ? found : [];
    } catch (cause) {
      set({ error: messageFor(cause, 'Could not scan for private payments.') });
      throw cause;
    }
  },

  claimStealthPayment: async (txHash) => {
    set({ isLoading: true, error: null });
    try {
      return await send('stellar.stealth.claim', { txHash });
    } catch (cause) {
      set({ error: messageFor(cause, 'Could not claim the private payment.') });
      throw cause;
    } finally {
      set({ isLoading: false });
    }
  },
}));

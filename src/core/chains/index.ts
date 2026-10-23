import type { Chain } from '@/core/vault/key-derivation';
import {
  decodeAbiString,
  erc20BalanceOfCalldata,
  erc20DecimalsCalldata,
  erc20NameCalldata,
  erc20SymbolCalldata,
  decodeDecimals,
  decodeUint256,
} from './evm/erc20';

/**
 * Chain service abstraction — thin HTTP wrappers around each chain's RPC.
 *
 * Design:
 *  - No heavy SDKs (ethers.js, @solana/web3.js, @stellar/js-sdk). Each is
 *    300–500 KB minified; we can't afford that footprint in an extension.
 *  - HTTP-only. No WebSocket subscriptions or persistent connections.
 *  - Public RPCs only. The extension ships with fallbacks (Infura, Alchemy,
 *    Solana mainnet RPC, Stellar Horizon); users can override.
 *  - RPC errors are propagated as-is. The caller (message router, UI) decides
 *    whether to retry, fall back, or show an error.
 */

export interface ChainService {
  /** Chain this service serves. */
  readonly chain: Chain;

  /** Get the balance of an address in the chain's native unit (wei, lamports, stroops). */
  getBalance(address: string): Promise<bigint>;

  /** Whether the address exists on-chain (funded). Stellar: 404 means unfunded. */
  isFunded?(address: string): Promise<boolean>;

  /**
   * Estimate gas or compute units for a transaction.
   * For EVM, returns gas in units; for Solana, returns the fee in lamports.
   * For Stellar, returns the fee in stroops.
   */
  estimateGas(tx: unknown): Promise<bigint>;

  /**
   * Send a signed transaction and return its hash or ID.
   * The transaction must be fully signed by the caller.
   */
  sendTransaction(signedTx: unknown): Promise<string>;

  /**
   * Get the account's current sequence/nonce.
   * EVM returns the transaction nonce; Stellar returns the ledger sequence.
   * Solana has no per-account sequence and returns 0.
   */
  getSequence(address: string): Promise<bigint>;

  /**
   * Read-only JSON-RPC passthrough for dapps (EVM only). The method allowlist
   * is enforced by the caller, never here.
   */
  rpcCall?(method: string, params: unknown[]): Promise<unknown>;

  /**
   * Optional live base-fee read. Implemented by Stellar so the wallet
   * auto-adjusts to network congestion; other chains fall back to `estimateGas`.
   */
  getBaseFee?(): Promise<bigint>;

  /** EVM: decimal places of an ERC20 contract (from `decimals()`). */
  erc20Decimals?(contract: string): Promise<number>;
  /** EVM: raw (base-unit) balance of an ERC20 for an owner. */
  erc20BalanceOf?(contract: string, owner: string): Promise<bigint>;
  /** EVM: build `transfer(address,uint256)` calldata for an ERC20. */
  erc20TransferData?(to: string, amount: bigint): Uint8Array;
  /** EVM: the ERC20's `symbol()` (metadata for the custom-token list). */
  erc20Symbol?(contract: string): Promise<string>;
  /** EVM: the ERC20's `name()` (metadata for the custom-token list). */
  erc20Name?(contract: string): Promise<string>;

  /** Solana: decimal places of an SPL mint (from the mint account data). */
  mintDecimals?(mint: string): Promise<number>;
  /** Solana: raw (base-unit) SPL token balance for an owner + mint. */
  tokenBalance?(owner: string, mint: string): Promise<bigint>;
  /** Solana: the owner's SPL token account address for a mint (or null). */
  tokenAccount?(owner: string, mint: string): Promise<string | null>;

  /** Stellar: raw (stroop) balance of an issued asset. */
  getAssetBalance?(address: string, code: string, issuer: string): Promise<bigint>;
  /** Stellar: the account's manage_data entries (base64 values decoded). */
  getAccountDataEntries?(address: string): Promise<Record<string, Uint8Array>>;
  /** Stellar: recent MEMO_HASH transactions — the stealth scan surface. */
  listRecentHashMemoTransactions?(
    limit?: number,
    /** Pages to walk (200 records each) — widens the scan window on busy networks. */
    pages?: number,
  ): Promise<Array<{ txHash: string; memoBytes: Uint8Array; createdAt: string }>>;
  /** Stellar: one transaction's 32-byte hash memo, by transaction hash. */
  getTransactionMemo?(txHash: string): Promise<Uint8Array | null>;
  /** Stellar: the network's live base reserve in stroops. */
  getBaseReserve?(): Promise<bigint>;
}

/**
 * Only testnet endpoints are wired.
 *
 * The manifest ships testnet-only and `host_permissions` lists exactly these
 * origins. Adding a mainnet entry here without a matching permission would fail
 * at runtime with an opaque CORS error, and adding the permission would widen
 * the extension's reach past what the security model allows. Mainnet is a
 * deliberate later decision, not an omission.
 */
export const TESTNET_ENDPOINTS: Record<Chain, string> = {
  evm: 'https://ethereum-sepolia-rpc.publicnode.com',
  solana: 'https://api.devnet.solana.com',
  stellar: 'https://horizon-testnet.stellar.org',
};

/** Thin HTTP wrapper for EVM JSON-RPC. */
export function createEvmService(rpcUrl: string = TESTNET_ENDPOINTS.evm): ChainService {
  return new EvmService(rpcUrl);
}

/** Thin HTTP wrapper for Solana RPC. */
export function createSolanaService(
  rpcUrl: string = TESTNET_ENDPOINTS.solana,
): ChainService {
  return new SolanaService(rpcUrl);
}

/**
 * Thin HTTP wrapper for Stellar Horizon.
 * Accepts a single URL or an ordered list (custom mirror first, official as
 * fallback). Defaults to the official testnet endpoint.
 */
export function createStellarService(
  horizonUrlOrEndpoints: string | string[] = TESTNET_ENDPOINTS.stellar,
): ChainService {
  const endpoints =
    typeof horizonUrlOrEndpoints === 'string'
      ? horizonUrlOrEndpoints.length > 0
        ? [horizonUrlOrEndpoints]
        : []
      : horizonUrlOrEndpoints;
  return new StellarService(endpoints);
}

/** Dispatches to the right service for a chain.
 * Stellar accepts an endpoint list (custom mirror first, official fallback);
 * EVM and Solana take a single RPC URL and keep their own internal fallbacks.
 */
export function createChainService(
  chain: Chain,
  rpcUrlOrEndpoints?: string | string[],
): ChainService {
  switch (chain) {
    case 'evm': {
      const url = typeof rpcUrlOrEndpoints === 'string' ? rpcUrlOrEndpoints : rpcUrlOrEndpoints?.[0];
      return createEvmService(url);
    }
    case 'solana': {
      const url = typeof rpcUrlOrEndpoints === 'string' ? rpcUrlOrEndpoints : rpcUrlOrEndpoints?.[0];
      return createSolanaService(url ?? TESTNET_ENDPOINTS.solana);
    }
    case 'stellar':
      return createStellarService(rpcUrlOrEndpoints);
  }
}

// ---------------------------------------------------------------------------
// EVM
// ---------------------------------------------------------------------------

class EvmService implements ChainService {
  readonly chain = 'evm';

  /** Public RPC fallbacks for balance/nonce/send so a rate-limited node does
   *  not brick the wallet. Mirrors SEPOLIA_FEE_ENDPOINTS. */
  private static ENDPOINTS = [
    'https://ethereum-sepolia-rpc.publicnode.com',
    'https://sepolia.gateway.tenderly.co',
    'https://1rpc.io/sepolia',
  ];
  private endpointIndex = 0;

  constructor(private rpcUrl?: string) {}

  async getBalance(address: string): Promise<bigint> {
    const response = await this.call('eth_getBalance', [address, 'latest']);
    if (typeof response !== 'string') {
      throw new Error(`eth_getBalance returned non-string: ${typeof response}`);
    }
    return BigInt(response);
  }

  async estimateGas(tx: unknown): Promise<bigint> {
    const response = await this.call('eth_estimateGas', [tx]);
    if (typeof response !== 'string') {
      throw new Error(`eth_estimateGas returned non-string: ${typeof response}`);
    }
    return BigInt(response);
  }

  async sendTransaction(signedTx: unknown): Promise<string> {
    if (typeof signedTx !== 'string') {
      throw new Error('EVM transaction must be a serialized hex string.');
    }
    const response = await this.call('eth_sendRawTransaction', [signedTx]);
    if (typeof response !== 'string') {
      throw new Error(`eth_sendRawTransaction returned non-string: ${typeof response}`);
    }
    return response;
  }

  async getSequence(address: string): Promise<bigint> {
    // 'pending', not 'latest': a second send issued while the first is still
    // in the mempool must reuse the NEXT nonce, or it fails as a duplicate.
    const response = await this.call('eth_getTransactionCount', [address, 'pending']);
    if (typeof response !== 'string') {
      throw new Error(`eth_getTransactionCount returned non-string: ${typeof response}`);
    }
    return BigInt(response);
  }

  /** Reads ERC20 `decimals()` for a contract via `eth_call`. */
  async erc20Decimals(contract: string): Promise<number> {
    const result = await this.ethCall(contract, erc20DecimalsCalldata());
    return decodeDecimals(result);
  }

  /** Reads ERC20 `symbol()` for a contract via `eth_call`. */
  async erc20Symbol(contract: string): Promise<string> {
    const result = await this.ethCall(contract, erc20SymbolCalldata());
    return decodeAbiString(result);
  }

  /** Reads ERC20 `name()` for a contract via `eth_call`. */
  async erc20Name(contract: string): Promise<string> {
    const result = await this.ethCall(contract, erc20NameCalldata());
    return decodeAbiString(result);
  }

  /** Reads ERC20 `balanceOf(owner)` for a contract via `eth_call`. */
  async erc20BalanceOf(contract: string, owner: string): Promise<bigint> {
    const result = await this.ethCall(contract, erc20BalanceOfCalldata(owner));
    return decodeUint256(result);
  }

  /**
   * Read-only JSON-RPC passthrough for the injected provider. Thin wrapper over
   * `call`, which already applies endpoint fallback and error surfacing; the
   * method allowlist lives in the background handler.
   */
  async rpcCall(method: string, params: unknown[]): Promise<unknown> {
    return this.call(method, params);
  }

  /** Runs a read-only `eth_call` against a contract and returns the raw hex result. */
  private async ethCall(to: string, data: string): Promise<string> {
    const result = await this.call('eth_call', [
      { to, data },
      'latest',
    ]);
    if (typeof result !== 'string') {
      throw new Error(`eth_call returned non-string: ${typeof result}`);
    }
    return result;
  }

  private async call(method: string, params: unknown[]): Promise<unknown> {
    const endpoints =
      this.rpcUrl !== undefined && this.rpcUrl.length > 0
        ? [this.rpcUrl]
        : EvmService.ENDPOINTS;

    let lastError: Error | null = null;
    for (let i = 0; i < endpoints.length; i += 1) {
      const idx = (this.endpointIndex + i) % endpoints.length;
      const url = endpoints[idx];
      if (url === undefined || url.length === 0) continue;
      try {
        // Bounded wait: a hung endpoint must fail over to the next one rather
        // than hang the send/sign flow forever (same pattern as RpcFeeSource).
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 15_000);
        let response: Response;
        try {
          response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
            signal: controller.signal,
          });
        } finally {
          clearTimeout(timer);
        }

        if (!response.ok) {
          throw new Error(`EVM RPC ${method} failed: HTTP ${response.status}`);
        }

        const data = (await response.json()) as unknown;
        if (typeof data !== 'object' || data === null) {
          throw new Error(`EVM RPC ${method} returned a non-object response.`);
        }

        // RPC error responses are valid JSON-RPC even without `result`.
        const err = (data as { error?: unknown }).error;
        if (err !== undefined && err !== null) {
          const message =
            typeof err === 'object' && err !== null && 'message' in err
              ? String((err as { message: unknown }).message)
              : JSON.stringify(err);
          throw new Error(`EVM RPC ${method} error: ${message}`);
        }

        if (!('result' in data)) {
          throw new Error(`EVM RPC ${method} returned no result.`);
        }
        this.endpointIndex = idx;
        return (data as unknown as { result: unknown }).result;
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        // Try the next endpoint.
      }
    }
    throw lastError ?? new Error(`EVM RPC ${method} failed on all endpoints.`);
  }
}

// ---------------------------------------------------------------------------
// Solana
// ---------------------------------------------------------------------------

/** Normalizes a Solana `getAccountInfo.data` field into a Uint8Array.
 *  Solana returns base64 either as a bare string content or as a
 *  `[content, "base64"]` pair depending on the request encoding. */
function decodeBase64AccountData(data: unknown): Uint8Array {
  let content: string | undefined;
  if (typeof data === 'string') {
    content = data;
  } else if (Array.isArray(data) && typeof data[0] === 'string') {
    content = data[0];
  }
  if (content === undefined) {
    throw new Error('Solana account has no base64 data.');
  }
  const clean = content.replace(/\s+/g, '');
  if (clean === '') return new Uint8Array(0);
  if (typeof atob === 'function') {
    const binary = atob(clean);
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) {
      out[i] = binary.charCodeAt(i);
    }
    return out;
  }
  // Node fallback (tests run without a browser `atob`).
  return Buffer.from(clean, 'base64');
}

class SolanaService implements ChainService {
  readonly chain = 'solana';

  constructor(private rpcUrl: string) {}

  async getBalance(address: string): Promise<bigint> {
    const response = (await this.call('getBalance', [address])) as unknown;
    if (typeof response !== 'object' || response === null || !('value' in response)) {
      throw new Error(`getBalance returned unexpected shape: ${JSON.stringify(response)}`);
    }
    const value = (response as unknown as { value: unknown }).value;
    if (typeof value !== 'number') {
      throw new Error(`getBalance value is not a number: ${typeof value}`);
    }
    return BigInt(value);
  }

  async estimateGas(): Promise<bigint> {
    // Solana doesn't pre-estimate; we return a fixed fee for now.
    // A real implementation would fetch current network fees via getFeeForMessage.
    return BigInt(5000); // 5000 lamports
  }

  async sendTransaction(signedTx: unknown): Promise<string> {
    if (typeof signedTx !== 'string') {
      throw new Error('Solana transaction must be a base64 string.');
    }
    // `encoding` is REQUIRED: `sendTransaction` defaults to base58, so a base64
    // payload sent without it fails deserialization on the node.
    const response = await this.call('sendTransaction', [
      signedTx,
      { encoding: 'base64', preflightCommitment: 'confirmed' },
    ]);
    if (typeof response !== 'string') {
      throw new Error(`sendTransaction returned non-string: ${typeof response}`);
    }
    return response;
  }

  async getSequence(address: string): Promise<bigint> {
    const response = (await this.call('getAccountInfo', [address])) as unknown;
    if (typeof response !== 'object' || response === null || !('value' in response)) {
      throw new Error(
        `getAccountInfo returned unexpected shape: ${JSON.stringify(response)}`,
      );
    }
    const value = (response as unknown as { value: unknown }).value;
    if (
      typeof value !== 'object' ||
      value === null ||
      !('lamports' in value) ||
      !('owner' in value)
    ) {
      throw new Error(
        `getAccountInfo value has unexpected shape: ${JSON.stringify(value)}`,
      );
    }
    // Solana accounts don't have a sequence number like Stellar.
    // This is a placeholder; real use might return the account's owner/authority.
    return BigInt(0);
  }

  /**
   * Reads the `decimals` field of an SPL token mint: the single byte at offset
   * 44 (0x2c) of the mint's account `data`. Returns the base-64 `data` payload
   * after validation so callers can also parse raw balances when needed.
   */
  async mintDecimals(mint: string): Promise<number> {
    const raw = await this.getAccountInfoData(mint);
    const data = decodeBase64AccountData(raw);
    if (data.length <= 44) {
      throw new Error(`SPL mint account data too short: ${data.length} bytes.`);
    }
    return data[44] ?? 0;
  }

  /**
   * Returns the SPL token balance (raw base units, as a bigint) held by `owner`
   * for `mint`, by reading the owner's token account via `getTokenAccountsByOwner`
   * (config-based) and summing the `tokenAmount.amount` fields that match `mint`.
   * Returns 0n when the owner has no account for that mint.
   */
  async tokenBalance(owner: string, mint: string): Promise<bigint> {
    const response = await this.call('getTokenAccountsByOwner', [
      owner,
      { mint },
      { encoding: 'jsonParsed' },
    ]);
    if (typeof response !== 'object' || response === null || !('value' in response)) {
      throw new Error(
        `getTokenAccountsByOwner returned unexpected shape: ${JSON.stringify(response)}`,
      );
    }
    const value = (response as { value: unknown }).value;
    if (!Array.isArray(value)) {
      throw new Error('getTokenAccountsByOwner value is not an array.');
    }
    let total = 0n;
    for (const entry of value) {
      if (typeof entry !== 'object' || entry === null) continue;
      const info = (entry as { account?: unknown }).account;
      if (typeof info !== 'object' || info === null) continue;
      const data = (info as { data?: unknown }).data;
      if (typeof data !== 'object' || data === null) continue;
      const parsed = (data as { parsed?: unknown }).parsed;
      if (typeof parsed !== 'object' || parsed === null) continue;
      const tokenAmount = (parsed as { info?: { tokenAmount?: { amount?: string } } }).info
        ?.tokenAmount;
      const amountStr = tokenAmount?.amount;
      if (amountStr === undefined) continue;
      try {
        total += BigInt(amountStr);
      } catch {
        // Ignore malformed amounts rather than failing the whole read.
      }
    }
    return total;
  }

  /** The base58 address of the owner's token account for `mint` (or null when none exists). */
  async tokenAccount(owner: string, mint: string): Promise<string | null> {
    const response = await this.call('getTokenAccountsByOwner', [
      owner,
      { mint },
      { encoding: 'jsonParsed' },
    ]);
    if (typeof response !== 'object' || response === null || !('value' in response)) {
      throw new Error(
        `getTokenAccountsByOwner returned unexpected shape: ${JSON.stringify(response)}`,
      );
    }
    const value = (response as { value: unknown }).value;
    if (!Array.isArray(value)) {
      throw new Error('getTokenAccountsByOwner value is not an array.');
    }
    const first = value[0];
    if (typeof first !== 'object' || first === null) return null;
    const pubkey = (first as { pubkey?: string }).pubkey;
    return typeof pubkey === 'string' && pubkey.length > 0 ? pubkey : null;
  }

  /** Raw `getAccountInfo` `data` field for an address (throws if absent). */
  private async getAccountInfoData(address: string): Promise<unknown> {
    const response = await this.call('getAccountInfo', [
      address,
      { encoding: 'base64' },
    ]);
    if (typeof response !== 'object' || response === null || !('value' in response)) {
      throw new Error(
        `getAccountInfo returned unexpected shape: ${JSON.stringify(response)}`,
      );
    }
    const value = (response as { value: unknown }).value;
    if (typeof value !== 'object' || value === null || !('data' in value)) {
      return null;
    }
    return (value as { data?: unknown }).data;
  }

  private async call(method: string, params: unknown[]): Promise<unknown> {
    // Bounded wait: a hung endpoint must not hang the send/sign flow forever.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15_000);
    let response: Response;
    try {
      response = await fetch(this.rpcUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method,
          params,
        }),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      throw new Error(`Solana RPC ${method} failed: HTTP ${response.status}`);
    }

    const data = (await response.json()) as unknown;
    if (
      typeof data !== 'object' ||
      data === null ||
      !('result' in data) ||
      !('jsonrpc' in data)
    ) {
      throw new Error(`Solana RPC ${method} returned invalid JSON-RPC: ${JSON.stringify(data)}`);
    }

    if ('error' in data && data.error !== null) {
      const err = data.error;
      const message =
        typeof err === 'object' && err !== null && 'message' in err
          ? String(err.message)
          : JSON.stringify(err);
      throw new Error(`Solana RPC ${method} error: ${message}`);
    }

    return (data as unknown as { result: unknown }).result;
  }
}

// ---------------------------------------------------------------------------
// Stellar
// ---------------------------------------------------------------------------

/**
 * Parses a Horizon decimal balance string ("9999.9999900") into stroops
 * (10^7 per whole XLM) using exact integer string math — no floating point.
 * Horizon reports exactly 7 decimal places; any longer fraction is truncated.
 */
function decimalToStroops(decimal: string): bigint {
  const negative = decimal.startsWith('-');
  const abs = negative ? decimal.slice(1) : decimal;
  const parts = abs.split('.');
  const wholeRaw = parts[0] ?? '';
  const fracRaw = parts[1] ?? '';
  const whole = wholeRaw === '' ? '0' : wholeRaw;
  // Pad to 7dp on the right, then truncate anything beyond 7dp.
  const frac7 = (fracRaw + '0000000').slice(0, 7);
  const value = BigInt(whole) * 10_000_000n + BigInt(frac7);
  return negative ? -value : value;
}

class StellarService implements ChainService {
  readonly chain = 'stellar';

  /** Official testnet Horizon endpoint (the pre-network-selection default). */
  private static DEFAULT_ENDPOINT = 'https://horizon-testnet.stellar.org';
  private endpointIndex = 0;

  /**
   * @param endpoints - Ordered Horizon endpoints for the SELECTED network.
   *   When none are given the official testnet endpoint is used (the
   *   historical default). Endpoints are used exactly as provided — a mainnet
   *   selection never silently falls back to a testnet node, because showing
   *   testnet state as mainnet (or vice versa) is worse than an honest
   *   read failure. Rotation still applies WITHIN the provided list.
   */
  constructor(private endpoints: string[] = [StellarService.DEFAULT_ENDPOINT]) {
    const deduped: string[] = [];
    for (const e of endpoints) {
      if (e.length > 0 && !deduped.includes(e)) deduped.push(e);
    }
    this.endpoints = deduped.length > 0 ? deduped : [StellarService.DEFAULT_ENDPOINT];
  }

  async isFunded(address: string): Promise<boolean> {
    return (await this.fetchAccount(address)) !== 'notFunded';
  }

  /**
   * Horizon returns HTTP 404 for an address that has never been funded —
   * Stellar accounts only exist on-chain once created. A 404 is therefore the
   * "fresh empty account" case, not an error.
   */
  private async fetchAccount(address: string): Promise<
    { balances: unknown[]; sequence: string; data?: Record<string, unknown> } | 'notFunded'
  > {
    const result = await this.horizonFetch(`/accounts/${address}`);

    // A 404 from the official endpoint is authoritative: the account has never
    // been funded (Stellar accounts only exist once created). A 404 from a
    // custom mirror only means "unknown to this mirror"; `horizonFetch` treats
    // that as a failed endpoint and rotates to the official one instead.
    if (result === 'notFound') {
      return 'notFunded';
    }
    const response = result;
    if (!response.ok) {
      throw new Error(`Horizon /accounts/${address} failed: HTTP ${response.status}`);
    }

    const data = (await response.json()) as unknown;
    if (typeof data !== 'object' || data === null) {
      throw new Error(`Horizon account returned unexpected shape: ${JSON.stringify(data)}`);
    }
    const record = data as { balances?: unknown; sequence?: unknown; data?: unknown };
    if (record.balances !== undefined && !Array.isArray(record.balances)) {
      throw new Error(`Horizon account returned unexpected shape: ${JSON.stringify(data)}`);
    }
    if (record.sequence !== undefined && typeof record.sequence !== 'string') {
      throw new Error(`Horizon sequence is not a string: ${typeof record.sequence}`);
    }
    return {
      balances: (record.balances as unknown[]) ?? [],
      sequence: (record.sequence as string) ?? '0',
      ...(typeof record.data === 'object' && record.data !== null
        ? { data: record.data as Record<string, unknown> }
        : {}),
    };
  }

  /**
   * The account's `manage_data` entries, with Horizon's base64 values decoded
   * to raw bytes. Used by the privacy layer to read a recipient's published
   * stealth meta-address.
   */
  async getAccountDataEntries(address: string): Promise<Record<string, Uint8Array>> {
    const account = await this.fetchAccount(address);
    if (account === 'notFunded' || account.data === undefined) return {};
    const out: Record<string, Uint8Array> = {};
    for (const [key, entry] of Object.entries(account.data)) {
      if (typeof entry !== 'object' || entry === null) continue;
      const value = (entry as { value?: unknown }).value;
      if (typeof value !== 'string') continue;
      try {
        out[key] = decodeBase64AccountData(value);
      } catch {
        // A malformed entry is skipped, never fatal to the whole read.
      }
    }
    return out;
  }

  /**
   * Recent transactions carrying a MEMO_HASH, newest first — the stealth
   * receiver's scan surface. Each result pairs the transaction hash with the
   * decoded 32-byte memo (the payer's ephemeral public key announcement).
   *
   * Pages through up to `pages` Horizon pages (200 records each) using the
   * cursor API: on a busy network a single page passes in seconds, and a
   * one-page window would make private payments effectively unscannable.
   * Pagination stops early on an empty page or a hard read failure — a
   * best-effort window beats a failed scan.
   */
  async listRecentHashMemoTransactions(
    limit = 200,
    pages = 5,
  ): Promise<Array<{ txHash: string; memoBytes: Uint8Array; createdAt: string }>> {
    const pageSize = Math.min(Math.max(limit, 1), 200);
    const maxPages = Math.max(1, Math.min(pages, 25));
    const out: Array<{ txHash: string; memoBytes: Uint8Array; createdAt: string }> = [];
    let cursor = '';

    for (let page = 0; page < maxPages; page += 1) {
      const query =
        `order=desc&limit=${pageSize}&include_failed=false` +
        (cursor.length > 0 ? `&cursor=${encodeURIComponent(cursor)}` : '');
      const result = await this.horizonFetch(`/transactions?${query}`);
      if (result === 'notFound') break;
      const response = result;
      if (!response.ok) {
        // The first page failing is a real error; later pages failing just
        // narrows the window (best-effort pagination).
        if (page === 0) {
          throw new Error(`Horizon /transactions failed: HTTP ${response.status}`);
        }
        break;
      }
      const body = (await response.json()) as unknown;
      const records =
        typeof body === 'object' && body !== null && Array.isArray((body as { _embedded?: { records?: unknown } })._embedded?.records)
          ? ((body as { _embedded: { records: unknown[] } })._embedded.records)
          : [];
      if (records.length === 0) break;
      let sawValid = false;
      for (const record of records) {
        if (typeof record !== 'object' || record === null) continue;
        const r = record as {
          hash?: unknown;
          memo?: unknown;
          memo_type?: unknown;
          created_at?: unknown;
          paging_token?: unknown;
        };
        // The cursor walks strictly backwards by paging token.
        if (typeof r.paging_token === 'string' && r.paging_token.length > 0) {
          cursor = r.paging_token;
          sawValid = true;
        }
        if (r.memo_type !== 'hash' || typeof r.memo !== 'string' || typeof r.hash !== 'string') {
          continue;
        }
        try {
          out.push({
            txHash: r.hash,
            memoBytes: decodeBase64AccountData(r.memo),
            createdAt: typeof r.created_at === 'string' ? r.created_at : '',
          });
        } catch {
          // Undecodable memo — skip, never fail the whole scan.
        }
      }
      if (!sawValid) break; // malformed page: no point paginating further
    }
    return out;
  }

  /**
   * One transaction's memo, by hash — used by the claim path to re-derive
   * the one-time key from the announcement before sweeping the funds.
   */
  async getTransactionMemo(txHash: string): Promise<Uint8Array | null> {
    const result = await this.horizonFetch(`/transactions/${txHash}`);
    if (result === 'notFound') return null;
    const response = result;
    if (!response.ok) {
      throw new Error(`Horizon /transactions/${txHash} failed: HTTP ${response.status}`);
    }
    const body = (await response.json()) as unknown;
    if (typeof body !== 'object' || body === null) return null;
    const record = body as { memo?: unknown; memo_type?: unknown };
    if (record.memo_type !== 'hash' || typeof record.memo !== 'string') return null;
    try {
      return decodeBase64AccountData(record.memo);
    } catch {
      return null;
    }
  }

  /**
   * The network's current base reserve in stroops, read from the latest
   * ledger header (0.5 XLM on today's networks; a CREATE_ACCOUNT starting
   * balance must at least cover it). Falls back to the historical constant
   * when the ledger read is unavailable.
   */
  async getBaseReserve(): Promise<bigint> {
    try {
      const result = await this.horizonFetch('/ledgers?order=desc&limit=1');
      if (result === 'notFound') return 5_000_000n;
      const response = result;
      if (!response.ok) return 5_000_000n;
      const body = (await response.json()) as unknown;
      const records =
        typeof body === 'object' &&
        body !== null &&
        Array.isArray((body as { _embedded?: { records?: unknown } })._embedded?.records)
          ? ((body as { _embedded: { records: unknown[] } })._embedded.records)
          : [];
      const first = records[0];
      if (typeof first === 'object' && first !== null) {
        const raw = (first as { base_reserve_in_stroops?: unknown }).base_reserve_in_stroops;
        if (typeof raw === 'string' && /^\d+$/.test(raw)) return BigInt(raw);
        if (typeof raw === 'number') return BigInt(Math.floor(raw));
      }
    } catch {
      // Fall through to the constant.
    }
    return 5_000_000n;
  }

  async getBalance(address: string): Promise<bigint> {
    const account = await this.fetchAccount(address);
    if (account === 'notFunded') return 0n;

    const nativeBalance = account.balances.find(
      (b) =>
        typeof b === 'object' &&
        b !== null &&
        'asset_type' in b &&
        (b as unknown as { asset_type: unknown }).asset_type === 'native',
    );

    if (
      !nativeBalance ||
      typeof nativeBalance !== 'object' ||
      !('balance' in nativeBalance)
    ) {
      throw new Error(`No native balance found for ${address}`);
    }

    const balance = (nativeBalance as unknown as { balance: unknown }).balance;
    if (typeof balance !== 'string') {
      throw new Error(`Native balance is not a string: ${typeof balance}`);
    }

    // Stellar balance is in stroops (1 XLM = 10^7 stroops). Convert via exact
    // integer string math — never floating point, which can round large balances.
    return decimalToStroops(balance);
  }

  /**
   * Fetches the LiquidAsset balance for an issued token (code + issuer).
   * Returns 0n if the account holds none. Used only for display validation;
   * an insufficient asset balance is ultimately rejected on-chain at submit.
   */
  async getAssetBalance(address: string, code: string, issuer: string): Promise<bigint> {
    const account = await this.fetchAccount(address);
    if (account === 'notFunded') return 0n;

    for (const b of account.balances) {
      if (
        typeof b === 'object' &&
        b !== null &&
        'asset_type' in b &&
        'asset_code' in b &&
        'asset_issuer' in b &&
        'balance' in b
      ) {
        const rec = b as {
          asset_type: string;
          asset_code: string;
          asset_issuer: string;
          balance: string;
        };
        if (
          rec.asset_type !== 'native' &&
          rec.asset_code === code &&
          rec.asset_issuer === issuer
        ) {
          return decimalToStroops(rec.balance);
        }
      }
    }
    return 0n;
  }

  /**
   * Returns the network's current base fee in stroops, read live from Horizon
   * so the wallet auto-adjusts instead of hardcoding 100. Falls back to 100
   * stroops if `fee_stats` is unavailable (e.g. an older mirror).
   */
  async getBaseFee(): Promise<bigint> {
    try {
      const result = await this.horizonFetch('/fee_stats');
      if (result === 'notFound') {
        throw new Error('Horizon /fee_stats returned 404.');
      }
      const response = result;
      if (!response.ok) {
        throw new Error(`Horizon /fee_stats failed: HTTP ${response.status}`);
      }
      const data = (await response.json()) as unknown;
      if (typeof data !== 'object' || data === null) {
        throw new Error('Horizon /fee_stats returned unexpected shape.');
      }
      const record = data as { last_ledger_base_fee?: unknown };
      const raw = record.last_ledger_base_fee;
      if (typeof raw !== 'string' || !/^\d+$/.test(raw)) {
        throw new Error('Horizon /fee_stats has no last_ledger_base_fee.');
      }
      const fee = BigInt(raw);
      return fee >= 100n ? fee : 100n;
    } catch {
      // Stellar's minimum base fee is 100 stroops; use the safe floor.
      return BigInt(100);
    }
  }

  async estimateGas(): Promise<bigint> {
    // Auto-adjust: the base fee now reflects live network congestion.
    return this.getBaseFee();
  }

  async sendTransaction(signedTx: unknown): Promise<string> {
    if (typeof signedTx !== 'string') {
      throw new Error('Stellar transaction must be XDR (base64).');
    }

    const result = await this.horizonFetch('/transactions', {
      method: 'POST',
      body: new URLSearchParams({ tx: signedTx }),
    });
    if (result === 'notFound') {
      throw new Error('Horizon /transactions POST failed: HTTP 404.');
    }
    const response = result;

    if (!response.ok) {
      // Horizon returns a JSON body with a human `detail` and an
      // `extras.result_codes` object (the transaction code plus an operations
      // array, e.g. op_underfunded / op_no_destination / op_malformed). Surface
      // both so a failed submit is diagnosable instead of a bare HTTP code.
      let detail = '';
      let resultCodes = '';
      try {
        const body = (await response.json()) as unknown;
        if (typeof body === 'object' && body !== null && 'detail' in body) {
          detail = String((body as { detail: unknown }).detail);
        }
        const extras =
          typeof body === 'object' && body !== null
            ? (body as { extras?: unknown }).extras
            : undefined;
        const codes =
          typeof extras === 'object' && extras !== null
            ? (extras as { result_codes?: unknown }).result_codes
            : undefined;
        if (codes !== undefined) {
          resultCodes = JSON.stringify(codes);
        }
      } catch {
        // Body wasn't JSON; leave detail empty.
      }
      throw new Error(
        `Horizon /transactions POST failed: HTTP ${response.status}` +
          `${detail ? ` — ${detail}` : ''}` +
          `${resultCodes ? ` — result_codes: ${resultCodes}` : ''}`,
      );
    }

    const data = (await response.json()) as unknown;
    if (typeof data !== 'object' || data === null || !('hash' in data)) {
      throw new Error(`Horizon transaction response unexpected: ${JSON.stringify(data)}`);
    }

    const hash = (data as unknown as { hash: unknown }).hash;
    if (typeof hash !== 'string') {
      throw new Error(`Horizon transaction hash is not a string: ${typeof hash}`);
    }

    return hash;
  }

  async getSequence(address: string): Promise<bigint> {
    const account = await this.fetchAccount(address);
    // A not-yet-funded account has no chain state yet; its first operation must
    // be a create-account (via Friendbot). Treated as sequence 0. At send time
    // the submit will fail with the network's insufficient-funds error, which is
    // the correct, honest failure for an unfunded address.
    if (account === 'notFunded') return 0n;
    return BigInt(account.sequence);
  }

  /**
   * Fetches a Horizon path across the configured endpoints, rotating on
   * failure. Uses a 15s timeout per call (the caller's message router has its
   * own timeout).
   *
   * Returns `'notFound'` only when the *official* endpoint answers 404 on a
   * GET — the authoritative "account never funded" signal. A 404 from a custom
   * mirror is treated as a stale/unreliable endpoint and it rotates onward.
   *
   * POSTs (submit) are never retried once they have reached an endpoint that
   * returns a 4xx: re-submitting a signed tx to another endpoint can double-
   * spend. A POST that fails with a network error before any server response
   * IS retried on the next endpoint.
   */
  private async horizonFetch(
    path: string,
    init?: { method?: string; body?: URLSearchParams },
  ): Promise<Response | 'notFound'> {
    const method = init?.method ?? 'GET';
    let lastError: Error | null = null;

    for (let i = 0; i < this.endpoints.length; i += 1) {
      const idx = (this.endpointIndex + i) % this.endpoints.length;
      const url = this.endpoints[idx];
      if (url === undefined || url.length === 0) continue;

      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 15_000);
        let response: Response;
        try {
          const initBody = init?.body;
          response = await fetch(`${url}${path}`, {
            method,
            signal: controller.signal,
            ...(initBody !== undefined ? { body: initBody } : {}),
          });
        } finally {
          clearTimeout(timer);
        }

        // A server-side rejection (4xx) is authoritative for a submit: surface
        // it without retrying (double-spend risk).
        if (method === 'POST' && response.status >= 400 && response.status < 500) {
          return response;
        }

        if (response.ok) {
          this.endpointIndex = idx;
          return response;
        }

        // A GET 404 from an official Horizon endpoint is the authoritative
        // "account never funded" signal (Stellar accounts only exist once
        // created) — on BOTH mainnet and testnet. A 404 from a custom mirror
        // only means "unknown to this mirror"; that rotates onward.
        if (
          method === 'GET' &&
          response.status === 404 &&
          (url.includes('horizon.stellar.org') ||
            url.includes('horizon-testnet.stellar.org'))
        ) {
          return 'notFound';
        }

        // Any other non-2xx (or 404 from a custom mirror): rotate onward.
        throw new Error(`Horizon ${path} failed: HTTP ${response.status}`);
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
      }
    }
    throw lastError ?? new Error(`Horizon ${path} failed on all endpoints.`);
  }
}

export { EvmService, SolanaService, StellarService };

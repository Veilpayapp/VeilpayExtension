/**
 * RPC service with fallback rotation and 5-minute response cache.
 *
 * The chain services (EVM, Solana, Stellar) use this under the hood when
 * multiple endpoints are configured. If one endpoint fails (network error,
 * HTTP 5xx, timeout) the next endpoint in the list is tried automatically.
 * Responses are cached by origin + method + params for up to 5 minutes.
 *
 * Usage:
 *   const rpc = new RpcService(['https://rpc1.example.com', 'https://rpc2.example.com']);
 *   const result = await rpc.call('eth_blockNumber', []);
 */

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------

interface CacheEntry {
  data: unknown;
  expiresAt: number;
}

const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

function cacheKey(method: string, params: unknown[]): string {
  return `${method}:${JSON.stringify(params)}`;
}

// Methods that are safe to cache (read-only, idempotent, and STABLE for the
// cache window). Deliberately excluded: nonces (eth_getTransactionCount),
// blockhashes (getLatestBlockhash), fee markets (eth_gasPrice, eth_feeHistory,
// eth_maxPriorityFeePerGas, getFeeForMessage), and gas estimates
// (eth_estimateGas) — a 5-minute-old nonce guarantees replacement/nonce-too-low
// failures on back-to-back sends, and Solana blockhashes expire in ~60–90 s.
const CACHEABLE_METHODS = new Set([
  'getBalance',
  'getAccountInfo',
  'eth_blockNumber',
  'eth_getBalance',
  'eth_call',
  'getBlockHeight',
  'getSlot',
  'getEpochInfo',
  'getRecentPrioritizationFees',
]);

// ---------------------------------------------------------------------------
// RPC call
// ---------------------------------------------------------------------------

export interface RpcCallOptions {
  /** Timeout in milliseconds (default 15_000). */
  timeout?: number;
  /** Skip the response cache for this call. */
  noCache?: boolean;
}

/**
 * Wraps a single JSON-RPC request with a timeout.
 */
async function fetchWithTimeout(
  fetchFn: typeof globalThis.fetch,
  url: string,
  body: string,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchFn(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Parses a JSON-RPC response and extracts the result or throws.
 */
function parseRpcResponse(raw: unknown): unknown {
  if (typeof raw !== 'object' || raw === null) {
    throw new Error('JSON-RPC response is not an object.');
  }
  const data = raw as Record<string, unknown>;

  if (data.error !== undefined && data.error !== null) {
    const err = data.error as Record<string, unknown>;
    throw new Error(
      `JSON-RPC error: ${err.message ?? JSON.stringify(err)} (code: ${err.code ?? '?'})`,
    );
  }

  if (!('result' in data)) {
    throw new Error('JSON-RPC response has no result field.');
  }

  return data.result;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export class RpcService {
  private currentIndex = 0;
  private responseCache = new Map<string, CacheEntry>();

  /**
   * @param endpoints - Ordered list of RPC URLs. First is primary; the rest
   *   are fallbacks tried in order on failure.
   * @param defaultTimeout - Per-call timeout in ms (default 15s).
   * @param fetchFn - Fetch implementation (defaults to globalThis.fetch, swapped
   *   in tests).
   */
  constructor(
    public readonly endpoints: string[],
    private defaultTimeout = 15_000,
    private fetchFn: typeof globalThis.fetch = globalThis.fetch,
  ) {
    if (endpoints.length === 0) {
      throw new Error('RpcService requires at least one endpoint.');
    }
  }

  /**
   * Returns the current (primary) endpoint URL.
   */
  get primaryUrl(): string {
    return this.endpoints[0] ?? '';
  }

  /**
   * Makes a JSON-RPC call, rotating through fallback endpoints on failure.
   *
   * Cacheable methods (balance, block number, etc.) are cached for 5 minutes
   * and served from cache on subsequent calls to the same {method, params}.
   */
  async call(method: string, params: unknown[], opts?: RpcCallOptions): Promise<unknown> {
    // Check cache first (unless opted out).
    if (!opts?.noCache && CACHEABLE_METHODS.has(method)) {
      const cached = this.getCached(method, params);
      if (cached !== undefined) return cached;
    }

    const body = JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method,
      params,
    });

    const timeoutMs = opts?.timeout ?? this.defaultTimeout;
    let lastError: Error | null = null;

    for (let i = 0; i < this.endpoints.length; i += 1) {
      const idx = (this.currentIndex + i) % this.endpoints.length;
      const url = this.endpoints[idx] ?? '';

      try {
        const response = await fetchWithTimeout(this.fetchFn, url, body, timeoutMs);

        if (!response.ok) {
          // HTTP 4xx are not retried (client errors).
          if (response.status >= 400 && response.status < 500) {
            const text = await response.text().catch(() => '');
            throw new Error(`HTTP ${response.status}: ${text}`);
          }
          // HTTP 5xx = server error, try next fallback.
          throw new Error(`HTTP ${response.status}`);
        }

        const raw = (await response.json()) as unknown;
        const result = parseRpcResponse(raw);

        // Cache the result if applicable.
        if (CACHEABLE_METHODS.has(method)) {
          this.setCache(method, params, result);
        }

        // Rotate to the successful endpoint as the new starting point.
        this.currentIndex = idx;

        return result;
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        // Continue to the next endpoint.
      }
    }

    // All endpoints failed.
    throw lastError ?? new Error(`RPC call "${method}" failed on all endpoints.`);
  }

  /**
   * Clears the entire response cache.
   */
  clearCache(): void {
    this.responseCache.clear();
  }

  private getCached(method: string, params: unknown[]): unknown | undefined {
    const key = cacheKey(method, params);
    const entry = this.responseCache.get(key);
    if (entry === undefined) return undefined;
    if (Date.now() > entry.expiresAt) {
      this.responseCache.delete(key);
      return undefined;
    }
    return entry.data;
  }

  private setCache(method: string, params: unknown[], data: unknown): void {
    const key = cacheKey(method, params);
    this.responseCache.set(key, { data, expiresAt: Date.now() + CACHE_TTL_MS });
  }
}
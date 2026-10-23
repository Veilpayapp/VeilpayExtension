import { bytesToHex } from '@noble/hashes/utils';
import { EVM_CHAIN_ID } from './transaction';

/**
 * Ordered Sepolia EVM endpoints for fee estimation.
 *
 * A single public node is a single point of failure: rate limits and transient
 * 5xx are routine on free RPCs. The fee source tries them in order and falls
 * back rather than surfacing the first failure as "cannot send".
 */
export const SEPOLIA_FEE_ENDPOINTS: string[] = [
  'https://ethereum-sepolia-rpc.publicnode.com',
  'https://sepolia.gateway.tenderly.co',
  'https://1rpc.io/sepolia',
];

/**
 * EVM fee and gas estimation over JSON-RPC.
 *
 * EIP-1559 separates the fee a transaction pays into two parts:
 *   - `maxPriorityFeePerGas` — the tip to the block producer;
 *   - `maxFeePerGas` — the absolute cap, which must cover the base fee plus the
 *     tip once the block is mined.
 *
 * We estimate both from live RPC rather than guessing:
 *   - the tip comes from `eth_maxPriorityFeePerGas` (the network's own
 *     suggestion), with a floor so a zero-fee recommendation still confirms;
 *   - the base fee comes from the latest block header's `baseFeePerGas`, and the
 *     cap is set to twice that plus the tip, hedging the risk of the base fee
 *     rising between estimation and inclusion.
 *
 * Gas for the *transfer* is estimated with `eth_estimateGas` on an unsigned
 * `from`/`to`/`value` call. It is fixed at 21,000 for a plain value transfer in
 * practice, but asking the node keeps the estimate honest if the recipient is a
 * contract with non-trivial receive logic.
 */

const MIN_PRIORITY_FEE = 1_000_000_000n; // 1 gwei
/**
 * Sanity ceilings on RPC-supplied fee data. The RPC is untrusted: a malicious
 * or compromised endpoint could otherwise report an absurd tip (paid IN FULL
 * to the block producer) or base fee (raising the user's total cap). Real
 * Ethereum tips run 1–5 gwei and base fees have never approached 1,000 gwei;
 * clamping beyond these ceilings can only leave a transaction underpriced
 * (re-submittable), never overpaying.
 */
const MAX_PRIORITY_FEE = 100_000_000_000n; // 100 gwei
const MAX_BASE_FEE = 10_000_000_000_000n; // 10,000 gwei
/** Ethereum's block gas limit is ~30–36M; nothing a wallet signs needs more. */
const MAX_GAS_LIMIT = 30_000_000n;

export interface EvmFeeEstimate {
  /** Suggested tip to the block producer, in wei. */
  maxPriorityFeePerGas: bigint;
  /** Absolute per-gas cap, in wei. */
  maxFeePerGas: bigint;
  /** Expected total gas the transfer will consume, in units. */
  gasLimit: bigint;
  /** Total fee = gasLimit * maxFeePerGas, in wei, for display. */
  totalFeeWei: bigint;
}

export interface EvmFeeSource {
  maxPriorityFeePerGas(): Promise<bigint>;
  baseFeePerGas(): Promise<bigint>;
  estimateGas(from: string, to: string, valueWei: bigint, data?: Uint8Array): Promise<bigint>;
}

/** JSON-RPC-backed fee source with endpoint fallback + tolerant parsing. */
export class RpcFeeSource implements EvmFeeSource {
  private endpointIndex = 0;

  constructor(
    private endpoints: string[] = SEPOLIA_FEE_ENDPOINTS,
    private timeoutMs = 10_000,
  ) {}

  async maxPriorityFeePerGas(): Promise<bigint> {
    const raw = await this.call('eth_maxPriorityFeePerGas', []);
    return BigInt(assertHex(raw));
  }

  async baseFeePerGas(): Promise<bigint> {
    const block = await this.call('eth_getBlockByNumber', ['latest', false]);
    if (typeof block !== 'object' || block === null || !('baseFeePerGas' in block)) {
      throw new Error('Latest block has no baseFeePerGas (pre-London or bad RPC).');
    }
    return BigInt(assertHex((block as { baseFeePerGas: unknown }).baseFeePerGas));
  }

  async estimateGas(from: string, to: string, valueWei: bigint, data?: Uint8Array): Promise<bigint> {
    const params: Record<string, string> = { from, to, value: `0x${valueWei.toString(16)}` };
    if (data !== undefined && data.length > 0) {
      params.data = `0x${bytesToHex(data)}`;
    }
    const raw = await this.call('eth_estimateGas', [params]);
    return BigInt(assertHex(raw));
  }

  /**
   * Calls the method across endpoints in order. Tolerates public RPC quirks:
   *  - some nodes omit the `jsonrpc` field on success;
   *  - RPC `error` objects are surfaced with their message, not masked as
   *    "invalid JSON-RPC";
   *  - a whole endpoint failing (HTTP, timeout, shape) rotates to the next.
   */
  private async call(method: string, params: unknown[]): Promise<unknown> {
    let lastError: Error | null = null;
    for (let i = 0; i < this.endpoints.length && this.endpoints.length > 0; i += 1) {
      const idx = (this.endpointIndex + i) % this.endpoints.length;
      const url = this.endpoints[idx];
      if (url === undefined || url.length === 0) continue;
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), this.timeoutMs);
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

        // Surface RPC errors with their real message (a response with `error`
        // has no `result` and is still valid JSON-RPC).
        const error = (data as { error?: unknown }).error;
        if (error !== undefined && error !== null) {
          const message =
            typeof error === 'object' && error !== null && 'message' in error
              ? String((error as { message: unknown }).message)
              : JSON.stringify(error);
          throw new Error(`EVM RPC ${method} error: ${message}`);
        }

        // Tolerant: require `result`, but NOT `jsonrpc` (many public nodes omit it).
        if (!('result' in data)) {
          throw new Error(`EVM RPC ${method} returned no result.`);
        }
        this.endpointIndex = idx;
        return (data as { result: unknown }).result;
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        // Try the next endpoint.
      }
    }
    throw lastError ?? new Error(`EVM RPC ${method} failed on all endpoints.`);
  }
}

function assertHex(value: unknown): string {
  if (typeof value !== 'string' || !/^0x[0-9a-fA-F]+$/.test(value)) {
    throw new Error(`Expected a 0x hex quantity, got ${JSON.stringify(value)}.`);
  }
  return value;
}

/**
 * Estimates the full fee picture for a transaction, querying the live node.
 * `data` is optional and used for contract-call gas estimation.
 */
export async function estimateTransferFee(
  source: EvmFeeSource,
  from: string,
  to: string,
  valueWei: bigint,
  data?: Uint8Array,
): Promise<EvmFeeEstimate> {
  const [tipRaw, baseFeeRaw, gasLimitRaw] = await Promise.all([
    source.maxPriorityFeePerGas(),
    source.baseFeePerGas(),
    source.estimateGas(from, to, valueWei, data),
  ]);

  // Clamp untrusted RPC values to sane bounds (see the ceiling notes above).
  const tip = tipRaw < MIN_PRIORITY_FEE ? MIN_PRIORITY_FEE : tipRaw > MAX_PRIORITY_FEE ? MAX_PRIORITY_FEE : tipRaw;
  const baseFee = baseFeeRaw > MAX_BASE_FEE ? MAX_BASE_FEE : baseFeeRaw;
  const gasLimit = gasLimitRaw > MAX_GAS_LIMIT ? MAX_GAS_LIMIT : gasLimitRaw;

  // 2x the base fee plus the tip gives headroom against a rising base fee.
  const maxFeePerGas = baseFee * 2n + tip;

  return {
    maxPriorityFeePerGas: tip,
    maxFeePerGas,
    gasLimit,
    totalFeeWei: gasLimit * maxFeePerGas,
  };
}

export { EVM_CHAIN_ID };

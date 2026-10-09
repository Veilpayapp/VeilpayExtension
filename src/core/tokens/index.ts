/**
 * Custom token registry — the MetaMask-style "add token" store.
 *
 * One registry across all three chains:
 *  - EVM:   an ERC-20 contract address (metadata read from the chain);
 *  - Solana: an SPL mint (decimals read from the mint account);
 *  - Stellar: an issued asset (code + issuer; adding creates a trustline).
 *
 * Persisted in the vault's meta store (IndexedDB) so tokens survive popup
 * closes, service-worker evictions, and browser restarts. The background
 * resolves balances and sends against this list; the UI renders it in the
 * Assets section and the send form's token picker.
 */

import { readMeta, writeMeta } from '@/core/vault/storage';
import type { ChainId } from '@/core/messaging/protocol';

const STORAGE_KEY = 'tokens:custom';

export interface CustomToken {
  /** Stable id: `evm:erc20:<lowercase-address>` / `solana:spl:<mint>` / `stellar:issued:<code>:<issuer>`. */
  id: string;
  chain: ChainId;
  kind: 'erc20' | 'spl' | 'stellar-issued';
  /** EVM contract address or Solana mint (base58). */
  address?: string;
  /** Stellar asset code (1–12 chars). */
  code?: string;
  /** Stellar issuer strkey (G...). */
  issuer?: string;
  /** Display symbol (from the chain when readable, else user-supplied). */
  symbol: string;
  /** Optional display name (ERC-20 `name()`). */
  name?: string;
  /** Base-unit precision (ERC-20 `decimals()`, SPL mint byte, 7 for Stellar). */
  decimals: number;
  addedAt: number;
}

/** Builds the stable registry id for a token's on-chain coordinates. */
export function tokenId(
  chain: ChainId,
  _kind: CustomToken['kind'],
  coordinate: string,
): string {
  if (chain === 'evm') return `evm:erc20:${coordinate.toLowerCase()}`;
  if (chain === 'solana') return `solana:spl:${coordinate}`;
  return `stellar:issued:${coordinate}`;
}

function isCustomToken(value: unknown): value is CustomToken {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.id === 'string' &&
    typeof candidate.symbol === 'string' &&
    typeof candidate.decimals === 'number' &&
    typeof candidate.addedAt === 'number' &&
    (candidate.chain === 'evm' || candidate.chain === 'solana' || candidate.chain === 'stellar') &&
    (candidate.kind === 'erc20' || candidate.kind === 'spl' || candidate.kind === 'stellar-issued')
  );
}

/** All registered custom tokens (optionally filtered to a chain). */
export async function listCustomTokens(chain?: ChainId): Promise<CustomToken[]> {
  const stored = await readMeta<unknown>(STORAGE_KEY);
  const tokens = Array.isArray(stored) ? stored.filter(isCustomToken) : [];
  return chain === undefined ? tokens : tokens.filter((t) => t.chain === chain);
}

/**
 * Registers a token. Returns false when an identical token is already
 * present (the id is content-derived, so a duplicate is the same token).
 */
export async function addCustomToken(token: CustomToken): Promise<boolean> {
  const tokens = await listCustomTokens();
  if (tokens.some((t) => t.id === token.id)) return false;
  tokens.push(token);
  await writeMeta(STORAGE_KEY, tokens);
  return true;
}

/** Removes a token by its registry id. Unknown ids are a no-op. */
export async function removeCustomToken(id: string): Promise<void> {
  const tokens = await listCustomTokens();
  await writeMeta(
    STORAGE_KEY,
    tokens.filter((t) => t.id !== id),
  );
}

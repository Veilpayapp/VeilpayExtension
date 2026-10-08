/**
 * Testnet faucet (like the mobile app's "Get testnet funds").
 *
 * Mechanism per chain:
 *  - Solana devnet: JSON-RPC `requestAirdrop` on api.devnet.solana.com — returns
 *    a signature. Fully automatable from the service worker.
 *  - Stellar testnet: Friendbot (friendbot.stellar.org) — POST ?addr=... creates
 *    the account and funds it. Automatable.
 *  - EVM (Sepolia): public faucets (Alchemy/Infura/Google Cloud) require a
 *    CAPTCHA/login, so we cannot fund programmatically. We return a short list
 *    of faucet URLs the UI can open.
 *
 * The handler functions are pure-ish (URL building + fetch), so tests can stub
 * `globalThis.fetch` without a live network.
 */

import type { ChainId } from '@/core/messaging/protocol';

export const SOLANA_FAUCET_AMOUNT_lamports = 100_000_000n; // 0.1 SOL
export const STELLAR_FRIENDBOT_URL = 'https://friendbot.stellar.org';

export interface FaucetSuccess {
  ok: true;
  chain: ChainId;
  /** On-chain reference (Solana signature / Stellar tx hash). */
  txHash?: string;
  /** For EVM, we may provide a faucet URL to open in a browser. */
  faucetUrl?: string;
}

export interface FaucetFailure {
  ok: false;
  chain: ChainId;
  error: string;
}

export type FaucetResult = FaucetSuccess | FaucetFailure;

export interface FaucetAirdropResponse {
  jsonrpc: '2.0';
  result?: string;
  error?: { message?: string };
}

/** Requests testnet funds for a chain address (works from the SW). */
export async function requestTestnetFaucet(
  chain: ChainId,
  address: string,
): Promise<FaucetResult> {
  switch (chain) {
    case 'evm':
      // Return a faucet URL that the UI will open in a new tab.
      // User still needs to complete a CAPTCHA, but we pre-fill the address.
      return {
        ok: true,
        chain,
        faucetUrl: `https://sepoliafaucet.com/?address=${encodeURIComponent(address)}`,
      };
    case 'solana':
      try {
        const hash = await solanaAirdrop(address);
        return { ok: true, chain, txHash: hash };
      } catch {
        // If the automatic RPC airdrop is rate-limited or down, fall back to
        // the Solana devnet faucet in a browser tab so the user still gets SOL.
        return {
          ok: true,
          chain,
          faucetUrl: `https://faucet.solana.com/?mode=devnet&address=${encodeURIComponent(address)}`,
        };
      }
    case 'stellar':
      try {
        const hash = await stellarFriendbot(address);
        return { ok: true, chain, txHash: hash };
      } catch (cause) {
        return { ok: false, chain, error: messageOf(cause) };
      }
    default:
      return { ok: false, chain, error: `Unsupported faucet chain: ${chain}` };
  }
}

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : 'Faucet request failed.';
}

async function solanaAirdrop(address: string): Promise<string> {
  const res = await fetch('https://api.devnet.solana.com', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'requestAirdrop',
      params: [address, SOLANA_FAUCET_AMOUNT_lamports.toString()],
    }),
  });
  if (!res.ok) {
    throw new Error(`Solana faucet HTTP ${res.status}`);
  }
  const parsed = (await res.json()) as FaucetAirdropResponse;
  if (typeof parsed.result !== 'string') {
    throw new Error(parsed.error?.message ?? 'Solana airdrop failed.');
  }
  return parsed.result;
}

async function stellarFriendbot(address: string): Promise<string> {
  const url = `${STELLAR_FRIENDBOT_URL}?addr=${encodeURIComponent(address)}`;
  const res = await fetch(url, { method: 'GET' });
  if (!res.ok) {
    throw new Error(`Stellar Friendbot HTTP ${res.status}`);
  }
  const parsed = (await res.json()) as {
    hash?: string;
    error?: unknown;
  };
  if (typeof parsed.hash !== 'string') {
    throw new Error('Stellar Friendbot did not return a transaction hash.');
  }
  return parsed.hash;
}
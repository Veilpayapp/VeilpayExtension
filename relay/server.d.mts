/** Types for the agent relay server (`relay/server.mjs`). */

import type { Bridge } from '../mcp/bridge.mjs';
import type { OAuth } from './oauth.mjs';

export declare const DEFAULT_PORT: number;
export declare const WALLET_TTL_MS: number;
export declare const PAIRING_TTL_MS: number;
export declare function normalizePairingCode(input: unknown): string;

export interface PairingGrant {
  /** Display form, `XXXX-XXXX`. */
  code: string;
  /** Epoch ms when the code stops being consumable. */
  expiresAt: number;
}

export interface RelayOptions {
  now?: () => number;
  baseUrl?: string;
  /** Test hook: shorten the long-poll so suites do not wait 25 seconds. */
  longPollMs?: number;
}

interface Wallet {
  secret: string;
  createdAt: number;
  bridge: Bridge;
}

export interface Relay {
  handle(request: unknown, response: unknown, body: unknown): Promise<void>;
  registerWallet(): { walletId: string; secret: string; pairing: PairingGrant };
  authenticateWallet(headers: Record<string, unknown>): Wallet | null;
  oauth: OAuth;
  stop(): void;
  issuePairingCode(walletId: string): PairingGrant;
  /** Resolves a live code without consuming it. */
  resolvePairingCode(input: unknown): { key: string; walletId: string } | null;
  consumePairingCode(input: unknown): string | null;
  walletCount(): number;
}

export declare function createRelay(options?: RelayOptions): Relay;
export declare function createRelayServer(relay?: Relay): unknown;
export declare function startRelay(
  port?: number,
  relay?: Relay
): Promise<{ server: { close(cb?: () => void): void }; relay: Relay; port: number }>;

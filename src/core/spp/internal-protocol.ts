/**
 * Internal control-plane protocol between the background service worker and
 * the offscreen SPP host.
 *
 * These messages ride the existing `veilpay:internal` channel (the D3 spike's
 * control plane) rather than the Zod-validated Request bus, because the bus is
 * shaped for extension surfaces → background traffic. The background →
 * offscreen direction (SPP ops) and the offscreen → background direction
 * (signing callbacks) both travel here, with the sender checked by the
 * background's `handleInternalMessage` (Chrome-stamped extension context, no
 * tab — content scripts have a tab and are rejected).
 */

/** Control-plane channel marker shared by every internal message. */
export const INTERNAL_CHANNEL = 'veilpay:internal';

/** An operation the background asks the offscreen SPP host to run. */
export type SppExecOp = 'status' | 'register' | 'deposit' | 'transfer' | 'withdraw' | 'sync';

export interface SppExecRequest {
  channel: typeof INTERNAL_CHANNEL;
  kind: 'spp:exec';
  /** Correlation id for the reply. */
  id: string;
  op: SppExecOp;
  payload: {
    /** The wallet's Stellar account 0 address the pool session binds to. */
    address: string;
    /** Stroops as a decimal string (deposit / transfer / withdraw). */
    amountStroops?: string;
    /** Recipient G… address (transfer). */
    to?: string;
  };
}

export interface SppExecOk {
  ok: true;
  result: unknown;
}

export interface SppExecErr {
  ok: false;
  code?: 'VAULT_LOCKED';
  message: string;
}

export type SppExecResponse = SppExecOk | SppExecErr;

/** A signing callback the offscreen host asks the background to perform. */
export type SppSignOp = 'signMessage' | 'signTransaction' | 'signAuthEntry';

export interface SppSignRequest {
  channel: typeof INTERNAL_CHANNEL;
  kind: 'spp:sign';
  id: string;
  op: SppSignOp;
  /** The account the background must sign with (validated against the vault). */
  address: string;
  /** signMessage: the SDK's key-derivation message. */
  message?: string;
  /** signTransaction: unsigned v1 envelope XDR (base64). */
  xdr?: string;
  /** signAuthEntry: the preimage XDR (base64). */
  preimage?: string;
  /** Network passphrase the transaction binds to (signTransaction). */
  networkPassphrase?: string;
}

export interface SppSignResponseOk {
  ok: true;
  /** The signature or signed envelope, base64. */
  result: string;
  address: string;
}

export interface SppSignResponseErr {
  ok: false;
  code?: 'VAULT_LOCKED';
  message: string;
}

export type SppSignResponse = SppSignResponseOk | SppSignResponseErr;

/** A keepalive ping issued while an SPP operation is in flight. */
export interface SppPingMessage {
  channel: typeof INTERNAL_CHANNEL;
  kind: 'spp:ping';
  id: string;
}

/** A type guard for internal-channel SPP exec messages. */
export function isSppExecRequest(value: unknown): value is SppExecRequest {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as Record<string, unknown>).channel === INTERNAL_CHANNEL &&
    (value as Record<string, unknown>).kind === 'spp:exec' &&
    typeof (value as Record<string, unknown>).id === 'string' &&
    typeof (value as Record<string, unknown>).op === 'string' &&
    typeof (value as Record<string, unknown>).payload === 'object' &&
    (value as Record<string, unknown>).payload !== null
  );
}

/** A type guard for internal-channel SPP sign messages. */
export function isSppSignRequest(value: unknown): value is SppSignRequest {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as Record<string, unknown>).channel === INTERNAL_CHANNEL &&
    (value as Record<string, unknown>).kind === 'spp:sign' &&
    typeof (value as Record<string, unknown>).id === 'string' &&
    typeof (value as Record<string, unknown>).op === 'string' &&
    typeof (value as Record<string, unknown>).address === 'string'
  );
}

/** A type guard for internal-channel SPP keepalive pings. */
export function isSppPing(value: unknown): value is SppPingMessage {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as Record<string, unknown>).channel === INTERNAL_CHANNEL &&
    (value as Record<string, unknown>).kind === 'spp:ping'
  );
}

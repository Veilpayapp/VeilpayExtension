/**
 * Internal control-plane protocol between the background service worker and
 * the offscreen SPP host.
 *
 * These messages ride the existing `veilpay:internal` channel (the D3 spike's
 * control plane) rather than the Zod-validated Request bus, because the bus is
 * shaped for extension surfaces → background traffic. The background →
 * offscreen direction (SPP ops) and the offscreen → background direction
 * (signing callbacks) both travel here. Each end verifies its peer exactly:
 * the background accepts `spp:sign` / `spp:ping` / `spike:zk-result` only
 * from the offscreen document, and the offscreen host accepts `spp:exec` only
 * from the background service worker (see `isOffscreenDocumentSender` /
 * `isBackgroundWorkerSender` below) — any other extension page would be a
 * bypass of the request bus's validation, audit, and approval surfaces.
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

/**
 * Whether a message sender is one of this extension's OWN pages (background,
 * offscreen, popup, options) — a BASELINE check only.
 *
 * `sender.id` must be this extension, and a content-script sender (which
 * always carries a `tab`) is rejected even then. This is NOT sufficient as a
 * trust boundary for the control plane: every extension page passes it, and
 * the money-moving `spp:exec` / `spp:sign` paths must be gated with the
 * stricter `isOffscreenDocumentSender` / `isBackgroundWorkerSender` instead
 * (a popup that reaches those paths bypasses the request bus's validation,
 * preflight, and audit). Kept for callers that only need "definitely not a
 * foreign context or content script" and for the guard tests that pin the
 * difference.
 */
export function isExtensionPageSender(sender: chrome.runtime.MessageSender): boolean {
  return sender.id === chrome.runtime.id && sender.tab === undefined;
}

/**
 * Whether a message sender is THIS extension's offscreen document — the only
 * legitimate speaker on the internal channel's offscreen→background direction
 * (`spp:sign`, `spp:ping`, `spike:zk-result`).
 *
 * `sender.url` is Chrome-stamped (a message body can claim anything; the
 * sender cannot forge its own document URL), so this is a stronger gate than
 * `isExtensionPageSender`: a popup/options page — even a compromised one —
 * cannot reach the `spp:sign` path, whose `signTransaction` arm signs
 * envelopes sourced from the wallet without any approval surface. The strict
 * check keeps that power with the vendored SPP runtime alone.
 */
export function isOffscreenDocumentSender(sender: chrome.runtime.MessageSender): boolean {
  return (
    sender.id === chrome.runtime.id &&
    sender.url === chrome.runtime.getURL('offscreen.html')
  );
}

/**
 * Whether a message sender is THIS extension's background service worker —
 * the only legitimate speaker on the internal channel's background→offscreen
 * direction (`spp:exec`).
 *
 * `expectedWorkerUrl` is the worker's URL, resolved by the CALLER (the
 * offscreen document loads it from its packaged `manifest.json` — offscreen
 * documents get a restricted `chrome.runtime` with no `getManifest`). The
 * check itself is Chrome-stamped: `sender.url` cannot be forged by a page,
 * so pool operations stay confined to the background's request bus
 * (validation, preflight, audit) — a UI page driving `spp:exec` directly
 * would skip all three.
 */
export function isBackgroundWorkerSender(
  sender: chrome.runtime.MessageSender,
  expectedWorkerUrl: string | null | undefined,
): boolean {
  if (expectedWorkerUrl === null || expectedWorkerUrl === undefined) return false;
  return sender.id === chrome.runtime.id && sender.url === expectedWorkerUrl;
}

/**
 * Background-side bridge to the offscreen SPP host.
 *
 * The SPP SDK (WASM, workers, OPFS) cannot live in the MV3 service worker, so
 * the background forwards pool operations to the offscreen document over the
 * internal control plane and awaits the result. The offscreen document is
 * created on demand and closed after an idle period — its OPFS database
 * persists across close/reopen, so nothing is lost beyond re-bootstrapping.
 */

import { ProtocolError } from '@/core/messaging/router';
import {
  INTERNAL_CHANNEL,
  type SppExecOp,
  type SppExecResponse,
} from '@/core/spp/internal-protocol';

/** Offscreen documents are closed this long after the last SPP activity. */
const SPP_OFFSCREEN_IDLE_MS = 10 * 60_000;

/** The alarm that enforces the idle close (service workers cannot setTimeout). */
export const SPP_IDLE_ALARM = 'veilpay:spp-idle';

let lastActiveAt = 0;

/** Records SPP activity so the idle closer knows the host is in use. */
export function noteSppActivity(): void {
  lastActiveAt = Date.now();
}

/** Whether the SPP host has EVER been used this service-worker lifetime. */
export function sppEverUsed(): boolean {
  return lastActiveAt !== 0;
}

/**
 * Closes the offscreen document when the SPP host has been idle long enough.
 *
 * The WASM runtime plus its workers cost real memory; the OPFS state survives
 * a close, so an idle close is a pure win. Called from the alarm handler.
 */
export async function closeIdleSppHost(): Promise<void> {
  if (lastActiveAt === 0) return;
  if (Date.now() - lastActiveAt < SPP_OFFSCREEN_IDLE_MS) return;
  lastActiveAt = 0;
  await chrome.offscreen.closeDocument().catch(() => undefined);
}

/**
 * Ensures the offscreen document exists (the D3 spike may have created and
 * already closed it; creation is idempotent when it already exists).
 */
export async function ensureSppOffscreenDocument(): Promise<void> {
  // Prefer the structured probe: matching Chrome's "Only a single offscreen
  // document may be created" error text breaks the moment the wording
  // changes (a reworded error would look fatal and hard-fail every SPP op).
  // getContexts is Chrome 116+; where absent, fall through to creation.
  if (typeof chrome.runtime.getContexts === 'function') {
    const contexts = await chrome.runtime
      .getContexts({ contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT] })
      .catch(() => []);
    if (contexts.length > 0) return;
  }
  try {
    await chrome.offscreen.createDocument({
      url: 'offscreen.html',
      reasons: [chrome.offscreen.Reason.WORKERS],
      justification: 'Host the Stellar Private Payments WASM and worker runtime (privacy pool).',
    });
  } catch (cause) {
    // The probe can race a concurrent creation; "Only a single offscreen
    // document may be created" means it exists — that is the success case
    // here. Anything else is fatal.
    const message = cause instanceof Error ? cause.message : String(cause);
    if (!message.includes('Only a single offscreen')) {
      throw new ProtocolError(
        'INTERNAL',
        `The privacy pool runtime could not start: ${message}`,
      );
    }
  }
}

/**
 * Runs one SPP operation in the offscreen host and returns its result.
 *
 * Errors keep their protocol code (VAULT_LOCKED) when the host flagged one;
 * everything else surfaces as TX_REJECTED with the SDK's display-safe message.
 *
 * ACCEPTED RESIDUAL RISK (documented, deliberate): `runtime.sendMessage` is
 * broadcast to every extension context and Chrome resolves the sender's
 * callback with the FIRST `sendResponse` — so a compromised extension page
 * could race a forged response ahead of the offscreen host's real one (fake
 * balances, a masked success, or a bogus signature that merely fails the op).
 * The request direction is immune (the host's listener only accepts the
 * Chrome-stamped background worker), and the attacker class that can exploit
 * the response race — code running in our own pages — already controls every
 * pixel the user sees, so no integrity the control plane could add would
 * exceed the UI's own. No path to key compromise or theft exists: signatures
 * cannot be forged, only wasted. Moving the replies to explicit
 * sender-gated result messages would close it; revisit if the control plane
 * ever carries data the UI does not itself render.
 */
export async function runSppOp(
  op: SppExecOp,
  payload: { address: string; amountStroops?: string; to?: string },
): Promise<unknown> {
  noteSppActivity();
  await ensureSppOffscreenDocument();

  const response = (await chrome.runtime.sendMessage({
    channel: INTERNAL_CHANNEL,
    kind: 'spp:exec',
    id: crypto.randomUUID(),
    op,
    payload,
  })) as SppExecResponse | undefined;

  if (
    response === undefined ||
    response === null ||
    typeof response !== 'object' ||
    !('ok' in response)
  ) {
    throw new ProtocolError('INTERNAL', 'The privacy pool runtime did not answer.');
  }
  if (!response.ok) {
    if (response.code === 'VAULT_LOCKED') {
      throw new ProtocolError('VAULT_LOCKED', response.message);
    }
    throw new ProtocolError('TX_REJECTED', response.message);
  }
  noteSppActivity();
  return response.result;
}

/** Arms the idle-close alarm; idempotent, safe on every service-worker wake. */
export function ensureSppIdleAlarm(): void {
  chrome.alarms.create(SPP_IDLE_ALARM, { periodInMinutes: 1 });
}

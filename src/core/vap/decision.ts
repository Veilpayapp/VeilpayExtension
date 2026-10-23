/**
 * VAP approval decision function and rolling-window spend counters.
 *
 * `requiresApproval` is the single authority on whether an operation may proceed
 * autonomously, must be confirmed by a human, or is denied outright. It is pure:
 * same grant + operation + spent window → same decision, so it is unit-testable
 * without touching storage.
 *
 * The spend window is persisted alongside grants. `recordSpend` is called at
 * signing time for both auto-approved and user-approved payments, so the window
 * ceiling is enforced against the grant's actual usage.
 *
 * Spec reference: §3 "Approval decision function" of 4_NATIVE_PAYMENT_LAYER_SPEC.md
 */
import { readMeta, writeMeta } from '@/core/vault/storage';
import type { Grant } from './grant';

export type ApprovalReason =
  | 'revoked'
  | 'expired'
  | 'opNotAllowed'
  | 'chainNotAllowed'
  | 'overPerOpCap'
  | 'overWindowCap'
  | 'threshold'
  | 'mode'
  | 'allowlistMiss';

export type ApprovalDecision =
  | { action: 'auto' }
  | { action: 'required'; reason: ApprovalReason }
  | { action: 'deny'; reason: ApprovalReason };

/**
 * An operation submitted against a grant. x402 payments and plain native
 * transfers are the two the wallet can settle today.
 */
export interface VapOperation {
  type: 'x402.pay' | 'native.transfer';
  amount: bigint;
  chain: 'evm' | 'solana' | 'stellar';
  recipient: string;
}

/** Rolling spend window for one grant. `amountSpent` is a decimal string. */
export interface SpendWindow {
  grantId: string;
  windowStart: number;
  windowEnd: number;
  amountSpent: string;
}

/**
 * Decides whether an operation needs a human.
 *
 * Denials are terminal — the operation is rejected, never silently retried.
 * A `required` decision means the caller should park the operation for approval.
 */
export function requiresApproval(
  grant: Grant,
  op: VapOperation,
  spent: bigint,
  now: number = Date.now(),
): ApprovalDecision {
  if (grant.revokedAt !== undefined) return { action: 'deny', reason: 'revoked' };
  if (now > grant.expiresAt) return { action: 'deny', reason: 'expired' };
  if (!grant.caps.allowedOps.includes(op.type)) {
    return { action: 'deny', reason: 'opNotAllowed' };
  }
  if (!grant.caps.allowedChains.includes(op.chain)) {
    return { action: 'deny', reason: 'chainNotAllowed' };
  }

  const maxPerOperation = BigInt(grant.caps.maxPerOperation);
  const maxPerWindow = BigInt(grant.caps.maxPerWindow);
  const approvalThreshold = BigInt(grant.caps.approvalThreshold);

  if (op.amount > maxPerOperation) return { action: 'deny', reason: 'overPerOpCap' };
  if (spent + op.amount > maxPerWindow) return { action: 'deny', reason: 'overWindowCap' };

  if (op.amount >= approvalThreshold) return { action: 'required', reason: 'threshold' };
  if (grant.caps.allowlist.length > 0 && !grant.caps.allowlist.includes(op.recipient)) {
    return { action: 'required', reason: 'allowlistMiss' };
  }
  return { action: 'auto' };
}

// ---------------------------------------------------------------------------
// Spend window persistence
// ---------------------------------------------------------------------------

const SPEND_KEY = 'vap:spendWindows';

/**
 * Per-grant async mutex (promise chain).
 *
 * The window check (`loadSpendWindow` → `requiresApproval`) and the debit
 * (`recordSpend`) span multiple awaits, and a service worker interleaves
 * concurrent handlers: without serialization, two concurrent auto-approved
 * operations both evaluate against the same stale `amountSpent`, both pass
 * `spent + amount > maxPerWindow`, and both settle — exceeding the window
 * cap. Wrapping the whole check→settle→debit sequence in this lock makes the
 * grant's rolling window authoritative under concurrency.
 */
const grantLocks = new Map<string, Promise<void>>();

export async function withGrantLock<T>(grantId: string, fn: () => Promise<T>): Promise<T> {
  const previous = grantLocks.get(grantId) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = previous.then(() => current);
  grantLocks.set(grantId, tail);
  await previous;
  try {
    return await fn();
  } finally {
    release();
    // Drop the chain link only if nobody queued behind us.
    if (grantLocks.get(grantId) === tail) grantLocks.delete(grantId);
  }
}


async function loadWindows(): Promise<SpendWindow[]> {
  const stored = await readMeta<SpendWindow[]>(SPEND_KEY);
  return Array.isArray(stored) ? stored : [];
}

async function saveWindows(windows: SpendWindow[]): Promise<void> {
  await writeMeta(SPEND_KEY, windows);
}

/**
 * Returns the current spend window for a grant, starting a fresh one when the
 * previous window has elapsed.
 */
export async function loadSpendWindow(
  grant: Grant,
  now: number = Date.now(),
): Promise<SpendWindow> {
  const windows = await loadWindows();
  const existing = windows.find((w) => w.grantId === grant.id);
  if (existing !== undefined && existing.windowEnd > now) {
    return existing;
  }
  const fresh = freshWindow(grant, now);
  await saveWindows([...windows.filter((w) => w.grantId !== grant.id), fresh]);
  return fresh;
}

/**
 * Records spend against a grant's window, starting a fresh window if the
 * current one has elapsed. Called at signing time.
 */
export async function recordSpend(
  grant: Grant,
  amount: bigint,
  now: number = Date.now(),
): Promise<void> {
  const windows = await loadWindows();
  const existing = windows.find((w) => w.grantId === grant.id);
  let next: SpendWindow;
  if (existing !== undefined && existing.windowEnd > now) {
    next = {
      ...existing,
      amountSpent: (BigInt(existing.amountSpent) + amount).toString(),
    };
  } else {
    next = freshWindow(grant, now, amount);
  }
  await saveWindows([...windows.filter((w) => w.grantId !== grant.id), next]);
}

function freshWindow(grant: Grant, now: number, initialSpend: bigint = 0n): SpendWindow {
  return {
    grantId: grant.id,
    windowStart: now,
    windowEnd: now + grant.caps.windowSeconds * 1000,
    amountSpent: initialSpend.toString(),
  };
}
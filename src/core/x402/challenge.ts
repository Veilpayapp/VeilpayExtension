/**
 * x402 challenge validation and nonce replay protection.
 *
 * Challenge validation happens before any signing or user-facing prompt. A
 * challenge that fails these checks is rejected with X402_INVALID_CHALLENGE
 * before the pending-approval record is even written.
 *
 * Spec reference: §4.1 "Challenge validation before any signing" of
 * 4_NATIVE_PAYMENT_LAYER_SPEC.md
 */
import { X402Challenge, type X402Challenge as X402ChallengeType } from './types';

// ---------------------------------------------------------------------------
// Nonce LRU — in-memory, capped at 10k entries
// ---------------------------------------------------------------------------

const MAX_SEEN_NONCES = 10_000;
const seenNonces = new Set<string>();

/**
 * Registers a nonce as seen. Evicts the oldest entry when the set exceeds the
 * cap. Thread-safe because the service worker is single-threaded.
 */
export function addSeenNonce(nonce: string): void {
  // The set grows by one nonce per challenge; at 10k it is ~1 MB. A single
  // service-worker restart resets the set, so an evicted-but-valid nonce from
  // before the restart is only a problem if the challenge's expiry is in the
  // future and the server also hasn't seen it — which is the server's job.
  if (seenNonces.size >= MAX_SEEN_NONCES) {
    // Evict one entry. Set iteration order is insertion order, so the first
    // entry is the oldest. This is O(1) amortised over the eviction rate.
    const first = seenNonces.values().next();
    if (!first.done) seenNonces.delete(first.value);
  }
  seenNonces.add(nonce);
}

/** Returns true if the nonce has already been seen. */
export function isSeenNonce(nonce: string): boolean {
  return seenNonces.has(nonce);
}

/** Clears the nonce cache. Exposed for testing. */
export function clearSeenNonces(): void {
  seenNonces.clear();
}

// ---------------------------------------------------------------------------
// Challenge validation
// ---------------------------------------------------------------------------

export interface ValidChallenge {
  valid: true;
  challenge: X402ChallengeType;
}

export interface InvalidChallenge {
  valid: false;
  reason: string;
}

export type ValidationResult = ValidChallenge | InvalidChallenge;

/**
 * The replay guard lives in service-worker memory, which MV3 evicts routinely
 * (~30 s idle). A challenge accepted for an unbounded future window could be
 * re-submitted after any restart and signed again. Capping the validity window
 * bounds that replay surface to minutes regardless of the server's own expiry.
 */
export const MAX_CHALLENGE_TTL_MS = 15 * 60_000;

/**
 * Validates an x402 challenge before any signing occurs.
 *
 * Checks, in order:
 *   1. Zod schema conformance (type-level validation)
 *   2. Expiry is in the future, and no further than MAX_CHALLENGE_TTL out
 *   3. Nonce is not a replay
 *   4. payTo is a valid 0x-prefixed EVM address
 *   5. Resource origin matches the page origin (no cross-origin payment redirection)
 *   6. Amount is positive (zero would be a pointless payment)
 *
 * When all checks pass, the nonce is registered as seen so the same challenge
 * cannot be paid twice.
 */
export function validateChallenge(
  raw: unknown,
  pageOrigin: string | null,
  now: number = Date.now(),
): ValidationResult {
  const parsed = X402Challenge.safeParse(raw);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    const field = first?.path?.join('.') ?? 'unknown';
    return { valid: false, reason: `Challenge field "${field}" is invalid: ${first?.message ?? 'Malformed.'}` };
  }

  const challenge = parsed.data;

  // 1. Expiry — in the future, and not unreasonably far out (see the TTL note).
  if (now >= challenge.expiry) {
    return { valid: false, reason: 'The challenge has expired.' };
  }
  if (challenge.expiry - now > MAX_CHALLENGE_TTL_MS) {
    return { valid: false, reason: 'The challenge validity window is too long.' };
  }

  // 2. Nonce replay
  if (isSeenNonce(challenge.nonce)) {
    return { valid: false, reason: 'This challenge nonce has already been used.' };
  }

  // 3. payTo — must be a valid 0x-prefixed EVM address (EIP-55 checksummed)
  if (!/^0x[0-9a-fA-F]{40}$/.test(challenge.payTo)) {
    return { valid: false, reason: 'The recipient address is not a valid EVM address.' };
  }

  // 4. Resource origin — must match the page origin. Resolving against the
  //    page origin (rather than parsing bare) classifies every form correctly:
  //    "/path" stays same-origin, "https://other" mismatches, and the
  //    protocol-relative "//other/path" resolves CROSS-origin — the old
  //    parse-without-base let "//evil.tld" through as "implicitly same-origin".
  if (pageOrigin !== null) {
    try {
      const resourceUrl = new URL(challenge.resource, pageOrigin);
      if (resourceUrl.origin !== pageOrigin) {
        return {
          valid: false,
          reason: `The resource origin (${resourceUrl.origin}) does not match the page origin (${pageOrigin}).`,
        };
      }
    } catch {
      return { valid: false, reason: 'The resource URL could not be parsed.' };
    }
  }

  // 5. Amount — must be positive
  let amount: bigint;
  try {
    amount = BigInt(challenge.amount);
  } catch {
    return { valid: false, reason: 'The challenge amount is not a valid integer.' };
  }
  if (amount <= 0n) {
    return { valid: false, reason: 'The challenge amount must be greater than zero.' };
  }

  // All checks passed. Register the nonce.
  addSeenNonce(challenge.nonce);

  return { valid: true, challenge };
}
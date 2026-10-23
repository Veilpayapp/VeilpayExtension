/**
 * Consent-fatigue defense: cap approval prompts per origin.
 *
 * A hostile page could otherwise spam `x402.pay` or `vap.grant.request` and
 * bury the user in overlays. Each origin gets at most `MAX_PROMPTS_PER_MINUTE`
 * prompts in a rolling minute; further attempts are denied outright
 * (auto-deny), never queued.
 *
 * The history lives in-memory, so a service-worker restart resets it. That is
 * acceptable: the defense is against bursts, and a restart already drops any
 * in-flight prompts anyway.
 *
 * Spec reference: §9 threat "Consent fatigue" of 4_NATIVE_PAYMENT_LAYER_SPEC.md
 */

const MAX_PROMPTS_PER_MINUTE = 5;
const WINDOW_MS = 60_000;
/** Distinct origins tracked before the map resets — bounds memory against a
 *  burst of one-off origins (each entry is tiny, but unbounded is unbounded). */
const MAX_TRACKED_ORIGINS = 500;

/** Origin → timestamps of recent prompts, oldest first. */
const promptHistory = new Map<string, number[]>();

/**
 * Returns true if a new prompt for `origin` is allowed this minute, and records
 * it. Returns false (auto-deny) when the origin has already prompted 5 times.
 */
export function allowPrompt(origin: string, now: number = Date.now()): boolean {
  if (promptHistory.size >= MAX_TRACKED_ORIGINS && !promptHistory.has(origin)) {
    // Shed the whole window rather than evicting piecemeal: the defense is
    // against bursts, entries expire in a minute anyway, and a full reset
    // cannot be abused to exceed a legit origin's 5/minute by much.
    promptHistory.clear();
  }
  const recent = (promptHistory.get(origin) ?? []).filter((t) => now - t < WINDOW_MS);
  if (recent.length >= MAX_PROMPTS_PER_MINUTE) {
    promptHistory.set(origin, recent);
    return false;
  }
  recent.push(now);
  promptHistory.set(origin, recent);
  return true;
}

/** Test seam: clears history for one origin, or all origins. */
export function clearPromptHistory(origin?: string): void {
  if (origin === undefined) {
    promptHistory.clear();
  } else {
    promptHistory.delete(origin);
  }
}

export { MAX_PROMPTS_PER_MINUTE, WINDOW_MS };
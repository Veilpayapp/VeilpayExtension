/**
 * Session activity tracking.
 *
 * Separate from the vault's own idle deadline for one reason: the deadline
 * answers "may this request proceed?", while activity answers "did a human do
 * something recently?". Those differ precisely where it matters — an agent
 * making autonomous payments keeps the vault legitimately unlocked, but must not
 * thereby appear to be a present, attentive user.
 *
 * Consequently `recordActivity` is only ever called from genuine user
 * interaction. Agent traffic deliberately does not reach it.
 */

export const MIN_IDLE_MS = 5 * 60 * 1000;
export const MAX_IDLE_MS = 60 * 60 * 1000;

/** Absolute ceiling on one unlock, regardless of activity. */
export const MAX_SESSION_MS = 8 * 60 * 60 * 1000;

export type ExpiryReason = 'idle' | 'max-session' | 'stopped';

export class SessionService {
  private readonly startedAt: number;
  private lastActivityAt: number;
  private idleMs: number;
  /**
   * Set by `stop()`, and never cleared.
   *
   * An explicit flag rather than a sentinel timestamp: every method here takes an
   * injectable clock, so "expired" must not depend on `now` being far from the
   * epoch. A stopped session has to read as dead for any clock value.
   */
  private stopped = false;

  constructor(
    idleMs: number,
    now: number = Date.now(),
    restore?: { startedAt: number; lastActivityAt: number },
  ) {
    this.assertIdleInRange(idleMs);
    this.idleMs = idleMs;
    if (
      restore !== undefined &&
      Number.isFinite(restore.startedAt) &&
      Number.isFinite(restore.lastActivityAt) &&
      restore.startedAt <= restore.lastActivityAt
    ) {
      // Reviving a persisted session: the ORIGINAL window continues — the
      // timestamps are restored, not restarted, so a service-worker
      // eviction cannot grant extra unlock time.
      this.startedAt = restore.startedAt;
      this.lastActivityAt = restore.lastActivityAt;
    } else {
      this.startedAt = now;
      this.lastActivityAt = now;
    }
  }

  private assertIdleInRange(ms: number): void {
    if (!Number.isFinite(ms) || ms < MIN_IDLE_MS || ms > MAX_IDLE_MS) {
      throw new RangeError('Idle timeout must be between 5 and 60 minutes.');
    }
  }

  /**
   * Call on genuine user interaction only. Never on agent-initiated work.
   *
   * A stopped session cannot be revived: reviving one would turn a retained
   * reference into a way to keep signing after a lock.
   */
  recordActivity(now: number = Date.now()): void {
    if (this.stopped) return;
    this.lastActivityAt = now;
  }

  setIdleTimeout(ms: number): void {
    this.assertIdleInRange(ms);
    this.idleMs = ms;
  }

  /**
   * Why the session should end, or null if it may continue.
   *
   * The absolute ceiling is checked as well as the idle window, so a session
   * kept warm by continuous agent activity still terminates.
   */
  expiry(now: number = Date.now()): ExpiryReason | null {
    // Checked first, and independently of the clock: an explicitly stopped
    // session is over regardless of what `now` says.
    if (this.stopped) return 'stopped';
    if (now - this.startedAt >= MAX_SESSION_MS) return 'max-session';
    if (now - this.lastActivityAt >= this.idleMs) return 'idle';
    return null;
  }

  isActive(now: number = Date.now()): boolean {
    return this.expiry(now) === null;
  }

  /** Milliseconds until the session ends, floored at zero. */
  timeRemaining(now: number = Date.now()): number {
    if (this.stopped) return 0;
    const untilIdle = this.lastActivityAt + this.idleMs - now;
    const untilCeiling = this.startedAt + MAX_SESSION_MS - now;
    return Math.max(0, Math.min(untilIdle, untilCeiling));
  }

  /** When this unlock began (epoch ms) — read-only, for session persistence. */
  get sessionStartedAt(): number {
    return this.startedAt;
  }

  /** When the user last acted (epoch ms) — read-only, for persistence. */
  get sessionLastActivityAt(): number {
    return this.lastActivityAt;
  }

  /**
   * Whether a human interacted within `withinMs`.
   *
   * The agent-payment layer uses this to decide when an operation needs fresh
   * confirmation rather than relying on the wallet merely being unlocked.
   */
  hasRecentActivity(withinMs = 60_000, now: number = Date.now()): boolean {
    if (this.stopped) return false;
    return now - this.lastActivityAt <= withinMs;
  }

  /** Terminal. A stopped session never becomes active again. */
  stop(): void {
    this.stopped = true;
    this.lastActivityAt = 0;
  }
}

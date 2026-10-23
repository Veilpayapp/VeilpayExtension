/**
 * Direction-aware view transitions for the popup's main views.
 *
 * The popup swaps full-screen surfaces (home / send / receive / import /
 * privacy, plus transaction receipts) by conditional render — an instant
 * DOM swap. This module runs those swaps inside the browser's View
 * Transitions API so the change reads as one continuous motion instead of
 * a teleport:
 *
 *  - the OUTGOING view is snapshotted by the browser (its React state,
 *    inputs, scroll — nothing is lost or remounted; a hand-rolled exit
 *    tree cannot promise that),
 *  - the INCOMING view renders live,
 *  - and the pseudo-element animations in `ui/theme/globals.css`
 *    (`::view-transition-old/new(root)`, the `view-nav-*` keyframes) drive
 *    the actual motion — on the compositor, transform + opacity only.
 *
 * Direction: navigating "deeper" (home → send, opening a receipt) enters
 * from the right; going back (any `onBack`, receive → home) enters from
 * the left — the spatial cue that tells the user where they went.
 */

import { flushSync } from 'react-dom';

/** The popup's main views, in the order the bottom nav walks them. */
export type ViewId = 'accounts' | 'send' | 'receive' | 'import' | 'privacy';

/**
 * Nav depth per view: the bottom-nav order (home, send, receive), with the
 * secondary surfaces (import, privacy) deepest. Back always lands on
 * `accounts`, so any move toward it reads as "back".
 */
const VIEW_ORDER: Record<ViewId, number> = {
  accounts: 0,
  send: 1,
  receive: 2,
  import: 3,
  privacy: 3,
};

/** The travel direction between two views, for the CSS animation choice. */
export function viewDirection(from: ViewId, to: ViewId): 'forward' | 'back' {
  return VIEW_ORDER[to] >= VIEW_ORDER[from] ? 'forward' : 'back';
}

/** The browser API shape this module needs (Chrome 111+). */
interface ViewTransitionLike {
  /** Rejects when the update callback throws. */
  updateCallbackDone?: Promise<void>;
  /** Rejects when the transition is skipped before its first frame. */
  ready?: Promise<void>;
  /** Rejects when the transition is skipped or aborted at any point. */
  finished: Promise<void>;
}
type StartViewTransition = (update: () => void) => ViewTransitionLike;

/**
 * Runs `update` inside a browser view transition, or directly when the API
 * is unavailable (tests, older engines) — the swap still happens, just
 * without the motion.
 *
 * `update` must synchronously commit the new DOM: React batches state
 * updates, and the browser captures the "new" snapshot the moment the
 * transition callback returns — without `flushSync` the transition would
 * crossfade the old view with itself and the switch would land after the
 * animation finished.
 */
export function runViewTransition(
  direction: 'forward' | 'back',
  update: () => void,
): void {
  const doc = document as Document & {
    startViewTransition?: StartViewTransition;
  };
  const start = doc.startViewTransition;
  if (typeof start !== 'function') {
    update();
    return;
  }

  // The CSS keys the animation direction off this attribute; it only
  // matters while the pseudo-element animations run.
  doc.documentElement.dataset.viewNav = direction;
  const transition = start.call(doc, () => {
    flushSync(update);
  });

  // Drop the attribute when the animations finish. A rapid second
  // navigation SKIPS this transition and rejects `finished` — that is
  // normal (the newer transition supersedes it), so both paths clean up.
  // The guard keeps a superseded cleanup from stripping the direction a
  // newer transition just set.
  const clearDirection = () => {
    if (doc.documentElement.dataset.viewNav === direction) {
      delete doc.documentElement.dataset.viewNav;
    }
  };
  // A skipped/aborted transition rejects EVERY promise on the transition
  // object — Chrome aborts when the popup viewport resizes mid-motion, which
  // a popup does whenever the incoming view changes height. `finished` drives
  // the cleanup; the other two rejections carry nothing actionable (the view
  // swap already committed) and are observed here purely so they do not
  // surface as "Uncaught (in promise) InvalidStateError" console noise.
  transition.updateCallbackDone?.catch(() => undefined);
  transition.ready?.catch(() => undefined);
  transition.finished.then(clearDirection, clearDirection);
}

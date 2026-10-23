import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  runViewTransition,
  viewDirection,
  type ViewId,
} from '@/ui/lib/view-transition';

/**
 * The popup's view-switch motion contract.
 *
 * `runViewTransition` is the one entry point every main-view change goes
 * through (App.tsx's `navigate`). These tests pin the two behaviors that
 * actually matter to the user:
 *
 *  - WITH the View Transitions API the state update must run inside
 *    `document.startViewTransition` (with the direction attribute set, and
 *    cleaned up when the transition settles) — that is what makes the swap
 *    animate instead of teleport.
 *  - WITHOUT the API (jsdom, older engines) the update must still run,
 *    synchronously, with no attribute left behind — the wallet works, just
 *    without the motion.
 */

afterEach(() => {
  delete (document as unknown as { startViewTransition?: unknown }).startViewTransition;
  delete document.documentElement.dataset.viewNav;
  vi.restoreAllMocks();
});

/**
 * jsdom has no View Transitions API; the TS DOM lib types the real one
 * (which our minimal stubs do not match), so the install goes through an
 * untyped doorway — what matters is the runtime shape the lib consumes.
 */
type StartViewTransitionStub = (callback: () => void) => { finished: Promise<void> };

function installStartViewTransition(
  impl: StartViewTransitionStub,
): ReturnType<typeof vi.fn> {
  const mock = vi.fn(impl);
  (document as unknown as { startViewTransition: StartViewTransitionStub }).startViewTransition =
    mock;
  return mock;
}

describe('viewDirection', () => {
  it('marks bottom-nav order as forward', () => {
    expect(viewDirection('accounts', 'send')).toBe('forward');
    expect(viewDirection('send', 'receive')).toBe('forward');
    expect(viewDirection('accounts', 'privacy')).toBe('forward');
  });

  it('marks any move toward home as back', () => {
    expect(viewDirection('send', 'accounts')).toBe('back');
    expect(viewDirection('receive', 'accounts')).toBe('back');
    expect(viewDirection('privacy', 'accounts')).toBe('back');
    expect(viewDirection('privacy', 'send')).toBe('back');
  });
});

describe('runViewTransition', () => {
  it('runs the update directly when the API is unavailable', () => {
    const update = vi.fn();
    runViewTransition('forward', update);
    expect(update).toHaveBeenCalledTimes(1);
    expect(document.documentElement.dataset.viewNav).toBeUndefined();
  });

  it('runs the update inside startViewTransition and sets the direction', () => {
    const started: Array<() => void> = [];
    const startViewTransition = installStartViewTransition((callback: () => void) => {
      started.push(callback);
      return { finished: Promise.resolve() };
    });

    const update = vi.fn();
    runViewTransition('back', update);

    // The update is handed to the browser, not run eagerly…
    expect(startViewTransition).toHaveBeenCalledTimes(1);
    expect(update).not.toHaveBeenCalled();
    // …and the CSS direction attribute is in place before the callback runs.
    expect(document.documentElement.dataset.viewNav).toBe('back');

    // When the browser invokes the captured callback, the DOM updates.
    started[0]!();
    expect(update).toHaveBeenCalledTimes(1);
  });

  it('clears the direction attribute once the transition settles', async () => {
    let resolveFinished: () => void = () => undefined;
    installStartViewTransition((callback: () => void) => {
      callback();
      return {
        finished: new Promise<void>((resolve) => {
          resolveFinished = resolve;
        }),
      };
    });

    runViewTransition('forward', vi.fn());
    expect(document.documentElement.dataset.viewNav).toBe('forward');

    resolveFinished();
    await Promise.resolve();
    expect(document.documentElement.dataset.viewNav).toBeUndefined();
  });

  it('a superseded transition does not strip a newer direction', async () => {
    // First transition (will be skipped by the user navigating again).
    let resolveFirst: () => void = () => undefined;
    installStartViewTransition((callback: () => void) => {
      callback();
      return {
        finished: new Promise<void>((resolve) => {
          resolveFirst = resolve;
        }),
      };
    });
    runViewTransition('forward', vi.fn());

    // Second navigation overwrites the direction before the first settles.
    installStartViewTransition((callback: () => void) => {
      callback();
      return { finished: new Promise<void>(() => undefined) };
    });
    runViewTransition('back', vi.fn());
    expect(document.documentElement.dataset.viewNav).toBe('back');

    // The first transition finishing late must NOT remove the active one.
    resolveFirst();
    await Promise.resolve();
    expect(document.documentElement.dataset.viewNav).toBe('back');
  });

  it('cleans up even when the transition is skipped (finished rejects)', async () => {
    installStartViewTransition((callback: () => void) => {
      callback();
      return { finished: Promise.reject(new Error('skipped')) };
    });

    runViewTransition('forward', vi.fn());
    await Promise.resolve();
    expect(document.documentElement.dataset.viewNav).toBeUndefined();
  });

  it('observes every transition promise so an aborted transition stays silent', async () => {
    // The real-world failure this pins: a popup view change that resizes the
    // viewport mid-motion makes Chrome reject `ready`/`updateCallbackDone`/
    // `finished` with InvalidStateError "Viewport size changed". `ready` and
    // `updateCallbackDone` must be OBSERVED (handler attached) or the console
    // fills with "Uncaught (in promise) InvalidStateError". jsdom does not
    // surface unhandled DOM rejections, so the stub records which promises
    // the library actually attached handlers to.
    const abort = new DOMException(
      'Transition was aborted because of invalid state. Viewport size changed',
      'InvalidStateError',
    );
    const observed: string[] = [];

    /** A thenable spy around a REAL rejection, recording observation. */
    const observedRejection = (name: string): Promise<void> => {
      const real = Promise.reject(abort);
      // Keep the real rejection from being an unhandled one under the test
      // itself — the question is whether the LIBRARY observes it.
      real.then(undefined, () => undefined);
      return {
        then: (onFulfilled: unknown, onRejected: unknown) => {
          observed.push(name);
          return real.then(
            onFulfilled as () => void,
            onRejected as ((reason: unknown) => void),
          );
        },
        catch: (onRejected: (reason: unknown) => void) => {
          observed.push(name);
          return real.then(undefined, onRejected);
        },
      } as unknown as Promise<void>;
    };

    installStartViewTransition((callback: () => void) => {
      callback();
      return {
        updateCallbackDone: observedRejection('updateCallbackDone'),
        ready: observedRejection('ready'),
        finished: observedRejection('finished'),
      };
    });

    runViewTransition('forward', vi.fn());
    // All three promises must have handlers attached — the old code observed
    // only `finished`, which left the other two as unhandled rejections.
    expect(observed).toContain('updateCallbackDone');
    expect(observed).toContain('ready');
    expect(observed).toContain('finished');

    await Promise.resolve();
    await Promise.resolve();
    expect(document.documentElement.dataset.viewNav).toBeUndefined();
  });
});

describe('ViewId type sanity (compile-time)', () => {
  it('covers every main view the popup routes between', () => {
    const views: ViewId[] = ['accounts', 'send', 'receive', 'import', 'privacy'];
    expect(views).toHaveLength(5);
  });
});

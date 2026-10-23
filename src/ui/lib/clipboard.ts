/**
 * Clipboard handling for secrets (private keys, recovery phrases).
 *
 * The wipe timer is deliberately module-scoped: a component-scoped timer is
 * cancelled when that component unmounts, and a modal that auto-copies a
 * private key is usually closed within seconds — which previously left the
 * key on the system clipboard forever. A module-level timer survives the
 * unmount and still wipes. (A closed popup kills the whole page and its
 * timers; that residual window is unavoidable from a page context.)
 */

export const CLIPBOARD_CLEAR_MS = 30_000;

let wipeTimer: number | null = null;
let wipeValue: string | null = null;

function scheduleWipe(value: string, clearAfterMs: number): void {
  // One outstanding wipe at a time: re-copying a secret restarts the window
  // rather than letting a pile-up of timers race the clipboard.
  if (wipeTimer !== null) {
    window.clearTimeout(wipeTimer);
  }
  wipeValue = value;
  wipeTimer = window.setTimeout(() => {
    wipeTimer = null;
    const expected = wipeValue;
    wipeValue = null;
    void navigator.clipboard
      .readText()
      .then((current) => {
        // Only clear the clipboard if it still holds our secret: the user may
        // have copied something else during the window, and wiping that would
        // be destructive.
        if (current === expected) {
          return navigator.clipboard.writeText('');
        }
        return undefined;
      })
      .catch(() => {
        // Clipboard read can be blocked (no permission); on failure, best
        // effort is to clear what we wrote. Overwriting an unknown value is
        // the lesser evil to keeping a secret on the system clipboard.
        return navigator.clipboard.writeText('');
      });
  }, clearAfterMs);
}

/**
 * Copies a secret to the clipboard and schedules its removal. Resolves true
 * when the copy succeeded (the wipe is armed either way, so a copied secret
 * never outlives its window because of a later render hiccup).
 */
export async function copySecretToClipboard(
  value: string,
  clearAfterMs: number = CLIPBOARD_CLEAR_MS,
): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(value);
    scheduleWipe(value, clearAfterMs);
    return true;
  } catch {
    return false;
  }
}

/** Test seam: cancel any pending wipe. */
export function cancelPendingClipboardWipe(): void {
  if (wipeTimer !== null) {
    window.clearTimeout(wipeTimer);
    wipeTimer = null;
  }
  wipeValue = null;
}

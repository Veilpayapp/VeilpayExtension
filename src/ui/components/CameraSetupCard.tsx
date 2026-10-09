import { useCallback, useEffect, useState, type JSX } from 'react';
import { Glyph } from '@/ui/components/Glyph';
import { Button } from '@/ui/components/Button';

/**
 * Camera pre-grant for QR scanning.
 *
 * Chrome does not offer a manifest permission that pre-allows `getUserMedia`
 * for an extension — the browser's own permission bubble must be accepted
 * ONCE, and then Chrome remembers the grant for the extension origin forever.
 * This card makes that one acceptance an explicit, expected step instead of a
 * surprise prompt at scan time:
 *
 *   tap "Allow camera" → Chrome's bubble → Allow → every future scan
 *   starts the camera instantly, no prompt.
 *
 * The card hides itself once the permission state is 'granted' (or when no
 * camera exists), and its "ask me later" dismissal is remembered in
 * chrome.storage.session so it does not nag every popup open.
 */
const DISMISS_KEY = 'cameraSetupDismissed';

async function queryCameraPermissionState(): Promise<'granted' | 'prompt' | 'denied' | 'unknown'> {
  try {
    const permissions = (
      navigator as Navigator & {
        permissions?: { query?: (desc: PermissionDescriptor) => Promise<PermissionStatus> };
      }
    ).permissions;
    if (typeof permissions?.query !== 'function') return 'unknown';
    const descriptor = { name: 'camera' } as unknown as PermissionDescriptor;
    const status = await permissions.query(descriptor);
    if (
      status.state === 'granted' ||
      status.state === 'prompt' ||
      status.state === 'denied'
    ) {
      return status.state;
    }
    return 'unknown';
  } catch {
    return 'unknown';
  }
}

export function CameraSetupCard(): JSX.Element | null {
  const [state, setState] = useState<'checking' | 'prompt' | 'granted' | 'denied' | 'unavailable' | 'dismissed'>(
    'checking',
  );
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const boot = async () => {
      try {
        const dismissed = await chrome.storage.session.get(DISMISS_KEY);
        if (dismissed[DISMISS_KEY] === true) {
          if (!cancelled) setState('dismissed');
          return;
        }
      } catch {
        // storage unavailable (tests) — keep showing the card.
      }
      if (typeof navigator === 'undefined' || navigator.mediaDevices?.getUserMedia === undefined) {
        if (!cancelled) setState('unavailable');
        return;
      }
      const permission = await queryCameraPermissionState();
      if (cancelled) return;
      switch (permission) {
        case 'granted':
          setState('granted');
          break;
        case 'denied':
          setState('denied');
          break;
        default:
          setState('prompt');
      }
    };
    void boot();
    return () => {
      cancelled = true;
    };
  }, []);

  const handleAllow = useCallback(async () => {
    setBusy(true);
    try {
      // The stream is started ONLY to trigger Chrome's one-time permission
      // bubble; every track is stopped immediately. Nothing is captured.
      const stream = await navigator.mediaDevices.getUserMedia({
        video: true,
        audio: false,
      });
      stream.getTracks().forEach((track) => track.stop());
      setState('granted');
    } catch {
      const permission = await queryCameraPermissionState();
      setState(permission === 'denied' ? 'denied' : 'prompt');
    } finally {
      setBusy(false);
    }
  }, []);

  const handleDismiss = useCallback(() => {
    setState('dismissed');
    void chrome.storage.session
      .set({ [DISMISS_KEY]: true })
      .catch(() => undefined);
  }, []);

  if (state === 'checking' || state === 'granted' || state === 'dismissed' || state === 'unavailable') {
    return null;
  }

  return (
    <div
      className="flex items-start gap-2.5 rounded-xl border border-accent-500/40 bg-accent-500/5 p-3 animate-fade-in-up"
      role="status"
    >
      <Glyph name="camera" className="h-4 w-4 shrink-0 text-accent-500 mt-0.5" />
      <div className="flex flex-1 flex-col gap-2">
        <div>
          <p className="font-mono text-[11px] font-semibold tracking-wider text-accent-400 uppercase">
            Enable camera for QR scanning
          </p>
          <p className="mt-0.5 font-mono text-[10px] leading-relaxed text-content-secondary">
            {state === 'denied'
              ? 'Camera access was blocked. Retry to ask again, or unblock it in Chrome settings.'
              : 'Allow once and Chrome remembers it — every scan starts instantly, no prompt.'}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button size="sm" onClick={() => void handleAllow()} disabled={busy}>
            <Glyph name="camera" className="h-3.5 w-3.5" />
            {busy ? 'Asking…' : state === 'denied' ? 'Retry camera' : 'Allow camera'}
          </Button>
          <Button size="sm" variant="ghost" onClick={handleDismiss} disabled={busy}>
            Ask me later
          </Button>
        </div>
      </div>
    </div>
  );
}

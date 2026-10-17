import { useCallback, useEffect, useRef, useState, type JSX } from 'react';
import jsQR from 'jsqr';
import { Glyph } from '@/ui/components/Glyph';
import { Button } from '@/ui/components/Button';

interface ScanModalProps {
  isOpen: boolean;
  onClose: () => void;
  /** Receives the parsed recipient (address + optional pre-filled amount). */
  onScanResult: (result: ParsedRecipient) => void;
}

/** A parsed recipient payload, possibly extracted from a payment URI. */
export interface ParsedRecipient {
  /** The recipient address, stripped of any URI scheme/parameters. */
  address: string;
  /** Amount (human-readable) when the input was a payment URI with one. */
  amount?: string;
  /** Memo when the input was a Stellar payment URI with one. */
  memo?: string;
}

/**
 * Normalizes pasted/typed/scanned recipient input.
 *
 * Handles the payment-URI forms wallets actually produce:
 *   stellar:G…?amount=1.5&memo=order-123   (SEP-07 style pay URI)
 *   solana:<pubkey>?amount=2               (Solana Pay)
 *   ethereum:0x…?value=… / 0x…             (EIP-681 address part)
 * plus a bare address. Unknown text passes through unchanged — the send
 * form's estimate/backend validation remains the authority on validity.
 */
export function parseRecipientInput(text: string): ParsedRecipient {
  const trimmed = text.trim();

  const stellar = trimmed.match(/^(?:web\+)?stellar:([^?]+)(?:\?(.*))?$/i);
  if (stellar !== null && stellar[1] !== undefined && stellar[1].length > 0) {
    const params = new URLSearchParams(stellar[2] ?? '');
    const amount = params.get('amount');
    const memo = params.get('memo') ?? params.get('msg');
    return {
      address: stellar[1],
      ...(amount !== null && amount.length > 0 ? { amount } : {}),
      ...(memo !== null && memo.length > 0 ? { memo } : {}),
    };
  }

  const solana = trimmed.match(/^solana:([^?]+)(?:\?(.*))?$/i);
  if (solana !== null && solana[1] !== undefined && solana[1].length > 0) {
    const params = new URLSearchParams(solana[2] ?? '');
    const amount = params.get('amount');
    return {
      address: solana[1],
      ...(amount !== null && amount.length > 0 ? { amount } : {}),
    };
  }

  // EIP-681: ethereum:0x…(optional @chain)(?…). The address is hex; the rest
  // (value etc.) is in native wei units and intentionally NOT pre-filled —
  // converting wei to ETH decimal is done by the backend, not ad-hoc here.
  const evm = trimmed.match(/^(?:ethereum:)?(0x[0-9a-fA-F]{40})(?:[?@].*)?$/);
  if (evm !== null && evm[1] !== undefined) {
    return { address: evm[1] };
  }

  return { address: trimmed };
}

/**
 * Decodes one RGBA video frame. Exported for the decode round-trip test.
 *
 * `dontInvert` is the documented fast path for live video (each frame is
 * normal-polarity black-on-white; trying inversions doubles decode time for
 * no benefit at 8 fps).
 */
export function decodeQrFrame(
  data: Uint8ClampedArray,
  width: number,
  height: number,
): string | null {
  try {
    const result = jsQR(data, width, height, { inversionAttempts: 'dontInvert' });
    return result === null ? null : result.data;
  } catch {
    return null;
  }
}

/** Decode cadence: often enough to feel instant, cheap enough for the SW. */
const DECODE_INTERVAL_MS = 120;
/** Frames are downscaled to this many pixels on the long edge before decoding. */
const DECODE_MAX_DIM = 480;

type CameraState = 'starting' | 'active' | 'denied' | 'blocked' | 'unavailable';

/**
 * Reads Chrome's remembered camera permission for this origin.
 *
 * 'denied' means the user clicked "Block": Chrome will never re-show the
 * camera prompt for this origin, and getUserMedia rejects instantly. 'prompt'
 * means the prompt was only dismissed — a plain retry re-shows it. 'unknown'
 * covers browsers/tests without the Permissions API (treated as retryable).
 */
async function queryCameraPermissionState(): Promise<
  'granted' | 'prompt' | 'denied' | 'unknown'
> {
  try {
    const permissions = (
      navigator as Navigator & {
        permissions?: { query?: (desc: PermissionDescriptor) => Promise<PermissionStatus> };
      }
    ).permissions;
    if (typeof permissions?.query !== 'function') return 'unknown';
    // 'camera' is a Chromium extension of the Permissions API; TS's DOM lib
    // does not carry it, hence the structural cast.
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

/**
 * QR scanner with a REAL camera stream (getUserMedia), plus clipboard and
 * manual fallbacks.
 *
 * - The camera starts when the modal opens (Chrome prompts once per
 *   extension, then remembers) and every track is stopped on close.
 * - Frames are sampled into a downscaled canvas and decoded with jsQR.
 *   A decoded value goes through `parseRecipientInput`, so scanning a
 *   payment QR pre-fills the amount/memo, exactly like pasting its text.
 * - Retry semantics: if Chrome still shows the prompt for this origin (the
 *   user dismissed it), a plain retry re-runs getUserMedia and the allow
 *   popup appears. If the user clicked "Block", Chrome never re-prompts a
 *   denied origin — retry then deep-links to this extension's camera
 *   settings page instead of failing silently.
 * - No camera / denied permission degrades to paste + manual entry — never
 *   a broken preview pretending to scan.
 */
export function ScanModal({
  isOpen,
  onClose,
  onScanResult,
}: ScanModalProps): JSX.Element | null {
  const [manualInput, setManualInput] = useState('');
  const [cameraState, setCameraState] = useState<CameraState>('starting');
  /** Bumped by the retry button to re-run the camera-start effect. */
  const [cameraAttempt, setCameraAttempt] = useState(0);

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  /** Guards against a second decode firing while the modal is closing. */
  const handledRef = useRef(false);
  /** Latest callback identity without restarting the decode effect. */
  const onScanResultRef = useRef(onScanResult);
  onScanResultRef.current = onScanResult;

  const stopCamera = useCallback(() => {
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    if (videoRef.current !== null) videoRef.current.srcObject = null;
  }, []);

  /**
   * Chrome's per-site settings page for this extension's camera permission.
   *
   * After the user explicitly clicks "Block" on the camera prompt, Chrome
   * remembers the denial for the extension origin and getUserMedia rejects
   * instantly forever — no API can re-show the prompt. The recovery path is
   * this deep link, where "Camera → Allow" is one click. Opening it takes
   * focus (which closes the popup and stops the camera — both correct).
   */
  const openCameraPermissionSettings = useCallback(() => {
    const extensionId = globalThis.chrome?.runtime?.id;
    const site =
      typeof extensionId === 'string' && extensionId.length > 0
        ? `chrome-extension://${extensionId}`
        : null;
    const url =
      site !== null
        ? `chrome://settings/content/siteDetails?site=${encodeURIComponent(site)}`
        : 'chrome://settings/content/camera';
    try {
      if (typeof chrome.tabs?.create === 'function') {
        void chrome.tabs.create({ url });
        return;
      }
      window.open(url, '_blank', 'noopener,noreferrer');
    } catch {
      // Settings tab could not be opened; the on-screen guidance remains.
    }
  }, []);

  /**
   * "Retry camera": if Chrome still shows the prompt for this origin (state
   * 'prompt' — e.g. the prompt was dismissed rather than blocked), a plain
   * retry re-runs getUserMedia and the ALLOW POPUP APPEARS. If the user
   * previously clicked "Block" (state 'denied'), a plain retry would fail
   * silently, so we route to the settings page instead.
   */
  const handleRetryCamera = useCallback(async () => {
    const permissionState = await queryCameraPermissionState();
    if (permissionState === 'denied') {
      openCameraPermissionSettings();
      return;
    }
    // 'prompt' | 'granted' | 'unknown' → plain retry: the permission bubble
    // shows (or the stream starts directly when already granted).
    setCameraAttempt((n) => n + 1);
  }, [openCameraPermissionSettings]);

  // ── Camera lifecycle ────────────────────────────────────────────────────
  useEffect(() => {
    if (!isOpen) return;
    let cancelled = false;
    handledRef.current = false;
    setCameraState('starting');

    const start = async () => {
      if (typeof navigator === 'undefined' || navigator.mediaDevices?.getUserMedia === undefined) {
        setCameraState('unavailable');
        return;
      }
      try {
        // `environment` faces the rear camera on phones; desktop ignores it.
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: 'environment' } },
          audio: false,
        });
        if (cancelled) {
          stream.getTracks().forEach((track) => track.stop());
          return;
        }
        streamRef.current = stream;
        setCameraState('active');
      } catch (cause) {
        const name = cause instanceof DOMException ? cause.name : '';
        if (name === 'NotAllowedError' || name === 'SecurityError') {
          // Distinguish a hard Block (Chrome will never re-prompt this
          // origin) from a mere dismissal (retry re-shows the prompt) so
          // the guidance on screen is the truthful one.
          const permissionState = await queryCameraPermissionState();
          setCameraState(permissionState === 'denied' ? 'blocked' : 'denied');
        } else {
          setCameraState('unavailable');
        }
      }
    };

    void start();
    return () => {
      cancelled = true;
      stopCamera();
    };
  }, [isOpen, cameraAttempt, stopCamera]);

  // ── Stream attachment ───────────────────────────────────────────────────
  // The viewfinder <video> unmounts while the camera is denied/blocked and
  // remounts on retry — which can happen AFTER the getUserMedia promise
  // resolves. Attaching here (after the 'active' render commits) is immune
  // to that race; attaching only at resolution time would silently skip.
  useEffect(() => {
    if (cameraState !== 'active') return;
    const video = videoRef.current;
    const stream = streamRef.current;
    if (video === null || stream === null) return;
    if (video.srcObject !== stream) {
      video.srcObject = stream;
    }
    try {
      const playback = video.play() as unknown;
      if (playback instanceof Promise) void playback.catch(() => undefined);
    } catch {
      // Autoplay policy / jsdom: decoding only needs readyState, not play().
    }
  }, [cameraState]);

  // ── Decode loop ─────────────────────────────────────────────────────────
  useEffect(() => {
    if (!isOpen || cameraState !== 'active') return;

    const tick = () => {
      const video = videoRef.current;
      const canvas = canvasRef.current;
      if (
        video !== null &&
        canvas !== null &&
        video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA &&
        video.videoWidth > 0 &&
        video.videoHeight > 0
      ) {
        // Downscale for decode speed; jsQR needs the finder patterns, not
        // full-resolution modules.
        const scale = Math.min(
          1,
          DECODE_MAX_DIM / Math.max(video.videoWidth, video.videoHeight),
        );
        const w = Math.max(1, Math.round(video.videoWidth * scale));
        const h = Math.max(1, Math.round(video.videoHeight * scale));
        if (canvas.width !== w) canvas.width = w;
        if (canvas.height !== h) canvas.height = h;
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        if (ctx !== null) {
          ctx.drawImage(video, 0, 0, w, h);
          const frame = ctx.getImageData(0, 0, w, h);
          const decoded = decodeQrFrame(frame.data, w, h);
          if (decoded !== null && decoded.trim().length > 0 && !handledRef.current) {
            handledRef.current = true;
            stopCamera();
            onScanResultRef.current(parseRecipientInput(decoded));
            return; // stop the loop; the caller closes the modal.
          }
        }
      }
      timer = setTimeout(tick, DECODE_INTERVAL_MS);
    };

    let timer: ReturnType<typeof setTimeout> | undefined = setTimeout(tick, DECODE_INTERVAL_MS);
    return () => {
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [isOpen, cameraState, stopCamera]);

  if (!isOpen) return null;

  const handlePaste = async () => {
    try {
      const text = await navigator.clipboard.readText();
      if (text.trim().length > 0) {
        handledRef.current = true;
        stopCamera();
        onScanResultRef.current(parseRecipientInput(text));
      }
    } catch {
      // Clipboard unavailable (permission denied / empty); the manual field
      // below is the fallback.
    }
  };

  const handleManualSubmit = () => {
    if (manualInput.trim().length === 0) return;
    handledRef.current = true;
    stopCamera();
    onScanResultRef.current(parseRecipientInput(manualInput));
  };

  const handleClose = () => {
    stopCamera();
    onClose();
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm p-4 animate-fade-in"
      role="dialog"
      aria-modal="true"
      aria-label="Scan QR Code"
    >
      <div className="w-full max-w-sm rounded-2xl border border-surface-600 bg-surface-900 p-4 shadow-raised flex flex-col gap-4 text-center animate-scale-in">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Glyph name="scan" className="h-5 w-5 text-accent-500" />
            <h3 className="font-display text-sm font-bold tracking-wider text-content-primary uppercase">
              SCAN QR CODE
            </h3>
          </div>
          <button
            type="button"
            onClick={handleClose}
            aria-label="Close scanner"
            className="text-content-tertiary hover:text-content-primary p-1 rounded-lg"
          >
            <Glyph name="x" className="h-4 w-4" />
          </button>
        </div>

        {/* Live camera viewfinder */}
        {cameraState === 'starting' && (
          <p className="font-mono text-xs text-content-tertiary py-10" aria-live="polite">
            Starting camera…
          </p>
        )}

        {(cameraState === 'active' || cameraState === 'starting') && (
          <div className="relative mx-auto aspect-square w-full max-w-56 overflow-hidden rounded-xl border border-surface-700 bg-black/60">
            <video
              ref={videoRef}
              muted
              playsInline
              autoPlay
              aria-hidden="true"
              className="h-full w-full object-cover"
            />
            {/* Hidden sampling surface */}
            <canvas ref={canvasRef} className="hidden" aria-hidden="true" />
            {/* 4 corner targeting marks */}
            <div className="pointer-events-none absolute left-3 top-3 h-5 w-5 border-l-2 border-t-2 border-accent-500" />
            <div className="pointer-events-none absolute right-3 top-3 h-5 w-5 border-r-2 border-t-2 border-accent-500" />
            <div className="pointer-events-none absolute bottom-3 left-3 h-5 w-5 border-b-2 border-l-2 border-accent-500" />
            <div className="pointer-events-none absolute bottom-3 right-3 h-5 w-5 border-b-2 border-r-2 border-accent-500" />
            {/* Animated laser scan beam */}
            <div className="pointer-events-none absolute inset-x-4 top-0 h-0.5 animate-bounce bg-gradient-to-r from-transparent via-accent-400 to-transparent shadow-[0_0_8px_rgba(245,158,11,0.8)]" />
            <p className="absolute inset-x-2 bottom-1 font-mono text-[9px] text-content-tertiary select-none">
              Point at a payment QR code
            </p>
          </div>
        )}

        {cameraState === 'denied' && (
          <div className="flex flex-col gap-2 rounded-xl border border-warning/40 bg-warning/5 p-3" aria-live="polite">
            <p className="font-mono text-[11px] leading-relaxed text-content-secondary">
              Camera access was denied. Retry to ask again — or paste/type the
              address below.
            </p>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => void handleRetryCamera()}
              fullWidth
            >
              <Glyph name="refresh" className="h-3.5 w-3.5" />
              Retry camera
            </Button>
          </div>
        )}

        {cameraState === 'blocked' && (
          <div className="flex flex-col gap-2 rounded-xl border border-warning/40 bg-warning/5 p-3" aria-live="polite">
            <p className="font-mono text-[11px] leading-relaxed text-content-secondary">
              Camera access is blocked. Chrome will not re-ask until it is
              re-enabled — retry opens the settings page for this extension;
              set Camera to Allow, then scan again. Or paste/type the address
              below.
            </p>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => void handleRetryCamera()}
              fullWidth
            >
              <Glyph name="refresh" className="h-3.5 w-3.5" />
              Retry camera
            </Button>
          </div>
        )}

        {cameraState === 'unavailable' && (
          <div className="flex flex-col gap-2 rounded-xl border border-surface-700 bg-surface-800/80 p-3" aria-live="polite">
            <p className="font-mono text-[11px] text-content-secondary">
              No camera available on this device — paste or type the address below.
            </p>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => void handleRetryCamera()}
              fullWidth
            >
              <Glyph name="refresh" className="h-3.5 w-3.5" />
              Retry camera
            </Button>
          </div>
        )}

        {/* Fallbacks: paste + manual entry */}
        <div className="flex flex-col gap-2">
          <Button variant="secondary" size="sm" onClick={handlePaste} fullWidth>
            <Glyph name="copy" className="h-3.5 w-3.5" />
            Paste from Clipboard
          </Button>

          <div className="flex gap-2">
            <input
              type="text"
              placeholder="Or enter address / payment URI..."
              value={manualInput}
              onChange={(e) => setManualInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleManualSubmit();
              }}
              aria-label="Recipient address or payment URI"
              className="flex-1 rounded-xl border border-surface-700 bg-surface-800 px-3 py-1.5 font-mono text-xs text-content-primary placeholder:text-content-tertiary focus:border-accent-500 outline-none"
            />
            <button
              type="button"
              onClick={handleManualSubmit}
              disabled={manualInput.trim().length === 0}
              className="rounded-xl bg-accent-500 px-3 py-1.5 font-mono text-xs font-bold text-surface-900 disabled:opacity-40"
            >
              OK
            </button>
          </div>

          <p className="font-mono text-[9px] leading-relaxed text-content-tertiary">
            Payment URIs (stellar: / solana: / ethereum:) are parsed — amount and
            memo are pre-filled on the send form.
          </p>
        </div>
      </div>
    </div>
  );
}

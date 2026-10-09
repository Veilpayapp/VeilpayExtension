import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import QRCodeLib from 'qrcode';
import {
  decodeQrFrame,
  parseRecipientInput,
  ScanModal,
} from '@/ui/components/ScanModal';

/**
 * Scanner tests: payment-URI parsing, real QR decoding (the same encode path
 * the receive view's QRCode component uses, decoded back through jsQR), and
 * the camera lifecycle — stream attached, tracks stopped on unmount.
 */

const STELLAR_ADDR = 'GDNWHQOKK5KWSWGBYUD2HOURRJTLOPQAEQZ5MFNZBX7SRWVJIF5R2VOG';
const EVM_ADDR = '0x1122334455667788990011223344556677889900';
const PAY_URI = `stellar:${STELLAR_ADDR}?amount=1.5&memo=order-42`;

describe('parseRecipientInput', () => {
  it('passes a bare address through unchanged', () => {
    expect(parseRecipientInput(STELLAR_ADDR))
      .toEqual({ address: STELLAR_ADDR });
    expect(parseRecipientInput(` ${EVM_ADDR} `))
      .toEqual({ address: EVM_ADDR });
  });

  it('parses a stellar pay URI with amount and memo', () => {
    const result = parseRecipientInput(PAY_URI);
    expect(result.address).toBe(STELLAR_ADDR);
    expect(result.amount).toBe('1.5');
    expect(result.memo).toBe('order-42');
  });

  it('parses a web+stellar URI and omits absent amount/memo', () => {
    const result = parseRecipientInput(`web+stellar:${STELLAR_ADDR}`);
    expect(result.address).toBe(STELLAR_ADDR);
    expect(result.amount).toBeUndefined();
    expect(result.memo).toBeUndefined();
  });

  it('parses a Solana Pay URI with amount', () => {
    const result = parseRecipientInput(
      'solana:9WzDXwBbmkg8ZTbNMqJx8WPC4j9rYZYtL7qoiopiPYQ?amount=2',
    );
    expect(result.address).toBe('9WzDXwBbmkg8ZTbNMqJx8WPC4j9rYZYtL7qoiopiPYQ');
    expect(result.amount).toBe('2');
  });

  it('parses an EIP-681 ethereum URI, stripping params and chain suffix', () => {
    const result = parseRecipientInput(`ethereum:${EVM_ADDR}?value=1e18`);
    expect(result.address).toBe(EVM_ADDR);
    // EVM value is wei — deliberately NOT pre-filled as a human amount.
    expect(result.amount).toBeUndefined();

    const chained = parseRecipientInput(`ethereum:${EVM_ADDR}@1?value=1e18`);
    expect(chained.address).toBe(EVM_ADDR);
  });

  it('passes unknown text through for the estimate/backend to validate', () => {
    expect(parseRecipientInput('hello world')).toEqual({ address: 'hello world' });
  });
});

/**
 * Paints a QR exactly like the receive view renders it: the `qrcode` encoder's
 * module matrix at error-correction L, 4-module quiet zone, scaled pixels,
 * RGBA. Feeding this to `decodeQrFrame` proves the camera decode path reads
 * codes the wallet itself produces (and that other wallets' codes decode).
 */
function paintQr(value: string, scale = 8, quiet = 4): {
  data: Uint8ClampedArray;
  width: number;
  height: number;
} {
  const matrix = QRCodeLib.create(value, { errorCorrectionLevel: 'L' });
  const size = matrix.modules.size;
  const full = size + quiet * 2;
  const dim = full * scale;
  const px = new Uint8ClampedArray(dim * dim * 4);
  for (let i = 0; i < px.length; i += 4) {
    px[i] = 255; px[i + 1] = 255; px[i + 2] = 255; px[i + 3] = 255;
  }
  for (let r = 0; r < size; r += 1) {
    for (let c = 0; c < size; c += 1) {
      if (!matrix.modules.get(r, c)) continue;
      for (let dy = 0; dy < scale; dy += 1) {
        for (let dx = 0; dx < scale; dx += 1) {
          const i = (((r + quiet) * scale + dy) * dim + (c + quiet) * scale + dx) * 4;
          px[i] = 0; px[i + 1] = 0; px[i + 2] = 0; px[i + 3] = 255;
        }
      }
    }
  }
  return { data: px, width: dim, height: dim };
}

describe('decodeQrFrame', () => {
  it.each([STELLAR_ADDR, EVM_ADDR, PAY_URI])('decodes a generated QR: %s', (value) => {
    const frame = paintQr(value);
    expect(decodeQrFrame(frame.data, frame.width, frame.height)).toBe(value);
  });

  it('feeds parseRecipientInput: a scanned pay URI pre-fills amount and memo', () => {
    const frame = paintQr(PAY_URI);
    const decoded = decodeQrFrame(frame.data, frame.width, frame.height);
    expect(decoded).toBe(PAY_URI);
    expect(parseRecipientInput(decoded ?? '')).toMatchObject({
      address: STELLAR_ADDR,
      amount: '1.5',
      memo: 'order-42',
    });
  });

  it('returns null when the frame holds no QR code', () => {
    const dim = 64;
    const px = new Uint8ClampedArray(dim * dim * 4).fill(255);
    expect(decodeQrFrame(px, dim, dim)).toBeNull();
  });
});

describe('ScanModal camera lifecycle', () => {
  afterEach(() => {
    // jsdom has no mediaDevices/permissions by default; drop test mocks.
    Object.defineProperty(navigator, 'mediaDevices', {
      value: undefined,
      configurable: true,
    });
    Object.defineProperty(navigator, 'permissions', {
      value: undefined,
      configurable: true,
    });
    vi.restoreAllMocks();
  });

  it('falls back to manual entry when no camera API exists', async () => {
    render(<ScanModal isOpen onClose={() => undefined} onScanResult={() => undefined} />);

    expect(await screen.findByText(/No camera available/i)).toBeInTheDocument();
    expect(screen.getByLabelText('Recipient address or payment URI')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Paste from Clipboard/i })).toBeInTheDocument();
  });

  it('attaches the live stream to the viewfinder and stops tracks on unmount', async () => {
    const stop = vi.fn();
    const fakeStream = { getTracks: () => [{ stop }] };
    Object.defineProperty(navigator, 'mediaDevices', {
      value: { getUserMedia: vi.fn(async () => fakeStream) },
      configurable: true,
    });

    const { unmount } = render(
      <ScanModal isOpen onClose={() => undefined} onScanResult={() => undefined} />,
    );

    const video = await waitFor(() => {
      const el = document.querySelector('video');
      expect(el).not.toBeNull();
      return el as HTMLVideoElement;
    });
    await waitFor(() => expect(video.srcObject).toBe(fakeStream));

    unmount();
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it('reports a denied camera as a recoverable state, not a broken preview', async () => {
    Object.defineProperty(navigator, 'mediaDevices', {
      value: {
        getUserMedia: vi.fn(async () => {
          throw new DOMException('Permission denied', 'NotAllowedError');
        }),
      },
      configurable: true,
    });

    render(<ScanModal isOpen onClose={() => undefined} onScanResult={() => undefined} />);

    // No Permissions API in this environment → treated as retryable, and the
    // guidance says so truthfully.
    expect(await screen.findByText(/Camera access was denied/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Retry camera/i })).toBeInTheDocument();
    expect(document.querySelector('video')).toBeNull();
  });

  it('retry deep-links to the extension camera settings when Chrome has the origin blocked', async () => {
    const user = userEvent.setup();
    const getUserMedia = vi.fn(async () => {
      throw new DOMException('Permission denied', 'NotAllowedError');
    });
    Object.defineProperty(navigator, 'mediaDevices', {
      value: { getUserMedia },
      configurable: true,
    });
    // Chrome reports a hard Block as 'denied'; getUserMedia will never
    // re-prompt in that state, so retry must route to settings instead.
    Object.defineProperty(navigator, 'permissions', {
      value: { query: vi.fn(async () => ({ state: 'denied' })) },
      configurable: true,
    });
    const tabsCreate = vi.fn();
    (chrome as unknown as { tabs: { create: typeof tabsCreate } }).tabs = { create: tabsCreate };

    render(<ScanModal isOpen onClose={() => undefined} onScanResult={() => undefined} />);
    await screen.findByText(/Camera access is blocked/i);

    await user.click(screen.getByRole('button', { name: /Retry camera/i }));

    // The settings deep link for THIS extension's camera permission, not a
    // silent second failure.
    expect(tabsCreate).toHaveBeenCalledTimes(1);
    expect(tabsCreate).toHaveBeenCalledWith({
      url: `chrome://settings/content/siteDetails?site=${encodeURIComponent('chrome-extension://veilpay-test')}`,
    });
    // getUserMedia is NOT retried while the origin is hard-blocked.
    expect(getUserMedia).toHaveBeenCalledTimes(1);
  });

  it('retry re-runs getUserMedia when the permission is not blocked (prompt shows again)', async () => {
    const user = userEvent.setup();
    const stop = vi.fn();
    const fakeStream = { getTracks: () => [{ stop }] };
    // First attempt: the user dismisses the prompt → NotAllowedError, but the
    // permission stays in 'prompt' state (not a hard Block).
    const getUserMedia = vi
      .fn<() => Promise<MediaStream>>()
      .mockImplementationOnce(async () => {
        throw new DOMException('Permission dismissed', 'NotAllowedError');
      })
      .mockImplementation(async () => fakeStream as unknown as MediaStream);
    Object.defineProperty(navigator, 'mediaDevices', {
      value: { getUserMedia },
      configurable: true,
    });
    // 'prompt' = Chrome WILL show the allow popup again on getUserMedia.
    Object.defineProperty(navigator, 'permissions', {
      value: { query: vi.fn(async () => ({ state: 'prompt' })) },
      configurable: true,
    });

    render(<ScanModal isOpen onClose={() => undefined} onScanResult={() => undefined} />);

    // Dismissal shows the recoverable state with a retry affordance.
    await user.click(await screen.findByRole('button', { name: /Retry camera/i }));

    // Retry went through getUserMedia again — the path that re-shows Chrome's
    // allow popup — and the second grant activates the viewfinder.
    await waitFor(() => expect(getUserMedia).toHaveBeenCalledTimes(2));
    const video = await waitFor(() => {
      const el = document.querySelector('video');
      expect(el).not.toBeNull();
      return el as HTMLVideoElement;
    });
    await waitFor(() => expect(video.srcObject).toBe(fakeStream));
  });
});

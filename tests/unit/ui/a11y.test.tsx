import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { axe, toHaveNoViolations as a11yMatchers } from 'jest-axe';
import App from '@/popup/App';
import SidePanelApp from '@/sidepanel/App';
import OptionsApp from '@/options/App';
import { useWallet } from '@/ui/store/useWallet';
import { colors } from '@/ui/theme/tokens';
import type { ChainId } from '@/core/messaging/protocol';

// jest-axe ships no types; the matcher is registered at runtime and used via
// the local `expectNoAxeViolations` helper below.
expect.extend(a11yMatchers as never);

// ---------------------------------------------------------------------------
// WCAG 2.x relative-luminance / contrast helpers (deterministic, token-level).
// axe-core's color-contrast rule needs real painted colors, which jsdom does
// not compute, so this math is the honest gate for the design tokens.
// ---------------------------------------------------------------------------

function channel(c: number): number {
  const s = c / 255;
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}

function luminance(hex: string): number {
  const h = hex.replace(/^#/, '');
  const r = Number.parseInt(h.slice(0, 2), 16);
  const g = Number.parseInt(h.slice(2, 4), 16);
  const b = Number.parseInt(h.slice(4, 6), 16);
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

function contrastRatio(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  const h = hi ?? 1;
  const l = lo ?? 0;
  return (h + 0.05) / (l + 0.05);
}

const WCAG_AA_NORMAL = 4.5;
const WCAG_AA_LARGE = 3.0;

/** Asserts an axe run reports no WCAG violations (typed helper around the
 *  untyped jest-axe matcher). */
async function expectNoAxeViolations(container: HTMLElement): Promise<void> {
  const results = await axe(container);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (expect(results) as any).toHaveNoViolations();
}

/**
 * Accessibility audit (roadmap 2.18 — WCAG 2.2 AA).
 *
 * Renders every wallet surface with a protocol responder that satisfies the
 * store, then runs axe-core and fails on serious/critical violations. The
 * assertion target is deliberate: not every rule is actionable for a testnet
 * extension (e.g. region landmark rules), so we gate on what users actually
 * hit — contrast, names, keyboard, and dialog semantics.
 */

type Incoming = { kind: string; payload: unknown };
type Responder = (message: Incoming) => unknown;

function uuid(): string {
  return crypto.randomUUID();
}

function buildResponder(overrides: Partial<Record<string, unknown>> = {}): Responder {
  return (message) => {
    const kind = message.kind as string;
    const data = overrides[kind];
    if (data === undefined) {
      return { id: uuid(), ok: true, data: undefined };
    }
    return { id: uuid(), ok: true, data };
  };
}

const INITIAL_STORE = {
  vaultState: 'uninitialized' as const,
  unlockedUntil: null,
  accounts: [],
  accountIndex: 0,
  selectedAccountIdx: 0,
  balances: {},
  zkCapability: null,
  pendingApproval: null,
  isLoading: false,
  error: null,
};

function installResponder(overrides: Partial<Record<string, unknown>> = {}): void {
  const responder = buildResponder(overrides);
  vi.mocked(chrome.runtime.sendMessage).mockImplementation(
    (...args: unknown[]) => {
      const message = args.length >= 2 ? args[1] : args[0];
      return responder(message as Incoming) as never;
    },
  );
}

const ACCOUNTS = [
  { chain: 'evm' as ChainId, index: 0, address: '0x0000000000000000000000000000000000000001', path: "m/44'/60'/0'" },
  { chain: 'solana' as ChainId, index: 0, address: '11111111111111111111111111111111', path: "m/44'/501'/0'" },
];

const UNLOCKED_RESPONDER = {
  'vault.status': { state: 'unlocked', unlockedUntil: Date.now() + 60_000 },
  'zk.capability': null,
  'account.balance': {
    chain: 'evm',
    address: '0x0000000000000000000000000000000000000001',
    balance: '1000000000000000000',
  },
};

beforeEach(() => {
  useWallet.setState(INITIAL_STORE);
  installResponder({
    'vault.status': { state: 'uninitialized', unlockedUntil: null },
    'zk.capability': null,
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  useWallet.setState(INITIAL_STORE);
});

describe('a11y audit — popup', () => {
  it('welcome/onboarding screen has no serious violations', async () => {
    const { container } = render(<App />);
    await expectNoAxeViolations(container);
  });

  it('locked screen has no serious violations', async () => {
    useWallet.setState({ vaultState: 'locked' });
    installResponder({
      'vault.status': { state: 'locked', unlockedUntil: null },
      'zk.capability': null,
    });
    const { container } = render(<App />);
    await expectNoAxeViolations(container);
  });

  it('unlocked dashboard has no serious violations', async () => {
    useWallet.setState({ vaultState: 'unlocked', accounts: ACCOUNTS });
    installResponder(UNLOCKED_RESPONDER);
    const { container } = render(<App />);
    await expectNoAxeViolations(container);
  });

  it('pending dapp connection approval has no serious violations', async () => {
    useWallet.setState({
      vaultState: 'unlocked',
      accounts: ACCOUNTS,
      pendingConnection: {
        origin: 'https://dapp.example',
        requestedAccounts: [
          { chain: 'evm' as ChainId, address: '0x0000000000000000000000000000000000000001' },
        ],
        createdAt: 1_000,
      },
    });
    installResponder(UNLOCKED_RESPONDER);
    const { container } = render(<App />);
    await expectNoAxeViolations(container);
  });

  it('pending transaction approval has no serious violations', async () => {
    useWallet.setState({
      vaultState: 'unlocked',
      accounts: ACCOUNTS,
      pendingApproval: {
        id: 'req-1',
        kind: 'tx',
        origin: 'https://dapp.example',
        address: '0x0000000000000000000000000000000000000001',
        to: '0x0000000000000000000000000000000000000002',
        value: '1000000000000000000',
        createdAt: 1_000,
      },
    });
    installResponder(UNLOCKED_RESPONDER);
    const { container } = render(<App />);
    await expectNoAxeViolations(container);
  });

  it('send form has labeled inputs (no placeholder-only fields)', async () => {
    const user = (await import('@testing-library/user-event')).default.setup();
    useWallet.setState({ vaultState: 'unlocked', accounts: ACCOUNTS });
    installResponder(UNLOCKED_RESPONDER);
    const { container } = render(<App />);
    const sendButtons = await screen.findAllByRole('button', { name: 'Send' });
    await user.click(sendButtons[0]!);
    await expectNoAxeViolations(container);
  });
});

describe('a11y audit — side panel', () => {
  it('unlocked dashboard has no serious violations', async () => {
    useWallet.setState({ vaultState: 'unlocked', accounts: ACCOUNTS });
    installResponder(UNLOCKED_RESPONDER);
    const { container } = render(<SidePanelApp />);
    await expectNoAxeViolations(container);
  });
});

describe('a11y audit — options/settings', () => {
  it('settings layout has no serious violations', async () => {
    installResponder({
      'vault.status': { state: 'unlocked', unlockedUntil: Date.now() + 60_000 },
      'zk.capability': null,
      'permissions.list': [],
      'security.status': { pinEnabled: false, webauthnEnabled: false },
    });
    const { container } = render(<OptionsApp />);
    await expectNoAxeViolations(container);
  });

  it.each([
    'Security',
    'Networks',
    'Permissions',
    'Address Book',
    'Transactions',
    'Session',
    'About',
  ])('settings tab "%s" has no serious violations', async (tabLabel) => {
    const user = (await import('@testing-library/user-event')).default.setup();
    installResponder({
      'vault.status': { state: 'unlocked', unlockedUntil: Date.now() + 60_000 },
      'zk.capability': null,
      'permissions.list': [],
      'security.status': { pinEnabled: false, webauthnEnabled: false },
    });
    const { container } = render(<OptionsApp />);
    await user.click(screen.getByRole('button', { name: tabLabel }));
    await expectNoAxeViolations(container);
  });
});

describe('a11y harness sanity', () => {
  it('catches an intentionally nameless button (proves the harness is live)', async () => {
    const { container } = render(<button />);
    const results = await axe(container);
    const names = results.violations.filter((v) => v.id === 'button-name');
    expect(names.length).toBeGreaterThan(0);
  });
});

describe('design token contrast (WCAG AA)', () => {
  it('primary text on dark surfaces passes AA normal text', () => {
    for (const surface of [colors.surface['700'], colors.surface['800'], colors.surface['900']]) {
      expect(contrastRatio(colors.text.primary, surface)).toBeGreaterThanOrEqual(WCAG_AA_NORMAL);
    }
  });

  it('secondary text on dark surfaces passes AA normal text', () => {
    for (const surface of [colors.surface['700'], colors.surface['800']]) {
      expect(contrastRatio(colors.text.secondary, surface)).toBeGreaterThanOrEqual(WCAG_AA_NORMAL);
    }
  });

  it('tertiary text on dark surfaces passes AA (large text or better)', () => {
    // Tertiary is used for micro-labels and timestamps; require at least AA
    // large-text contrast on the darkest surface it sits on.
    for (const surface of [colors.surface['700'], colors.surface['800']]) {
      expect(contrastRatio(colors.text.tertiary, surface)).toBeGreaterThanOrEqual(WCAG_AA_LARGE);
    }
  });

  it('accent 500 on surface 900 passes AA for large text', () => {
    expect(contrastRatio(colors.accent['500'], colors.surface['900'])).toBeGreaterThanOrEqual(
      WCAG_AA_LARGE,
    );
  });

  it('success/warning/danger on surface 900 are distinguishable (≥3:1)', () => {
    for (const c of [colors.success, colors.warning, colors.danger, colors.info]) {
      expect(contrastRatio(c, colors.surface['900'])).toBeGreaterThanOrEqual(WCAG_AA_LARGE);
    }
  });
});

import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { PrivacyView } from '@/ui/components/PrivacyView';
import { useWallet } from '@/ui/store/useWallet';
import type { SppPoolStatus } from '@/ui/store/useWallet';

/**
 * PrivacyView (the pXLM privacy-pool panel) tests.
 *
 * The panel talks to the background over `chrome.runtime.sendMessage`, which
 * the test shim stubs. Each test installs a responder that answers the SPP
 * request kinds with a valid protocol `Response`, and asserts both what the
 * user sees (status, forms, receipts, errors) and what goes over the wire
 * (kind, payload — amounts must cross the bus as stroop strings).
 */

type Incoming = { kind: string; payload: unknown };
/** What the store's client actually puts on the wire. */
type Envelope = Incoming & { id: string; v: number; source: string };
type Responder = (message: Incoming) => unknown;

function uuid(): string {
  return crypto.randomUUID();
}

function sppStatus(overrides: Partial<SppPoolStatus> = {}): SppPoolStatus {
  return {
    poolContractId: 'CALMZTI56TEDERLWXZJOS5TAN4QN2B36NAJK26MWKND4H5IG4NLPWEJ2',
    assetSymbol: 'pXLM',
    balanceStroops: '0',
    registered: false,
    bootnodeRequired: false,
    syncedLedger: 5_202_551,
    readAt: 1_788_000_000_000,
    ...overrides,
  };
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

const STELLAR_ACCOUNT = {
  chain: 'stellar' as const,
  index: 0,
  address: 'GD6Q6Q6Q6Q6Q6Q6Q6Q6Q6Q6Q6Q6Q6Q6Q6Q6Q6Q6Q6',
  path: "m/44'/148'/0'",
};

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
  sppStatus: null,
};

/**
 * Installs a raw responder AND records every outgoing message (full wire
 * envelope, so kind, payload, and the request envelope shape are all
 * assertable). Returns the captured envelopes.
 */
function installTrackedResponder(
  overrides: Partial<Record<string, unknown>> = {},
  handler?: Responder,
): { sent: Envelope[] } {
  const sent: Envelope[] = [];
  const responder = handler ?? buildResponder(overrides);
  vi.mocked(chrome.runtime.sendMessage).mockImplementation((...args: unknown[]) => {
    // chrome.runtime.sendMessage has overloads:
    //   sendMessage(message, ...)  — extension sends to itself
    //   sendMessage(extensionId, message, ...) — cross-extension
    // The message is either args[0] or args[1] depending on the overload.
    const message = args.length >= 2 ? args[1] : args[0];
    sent.push(message as Envelope);
    return responder(message as Incoming) as never;
  });
  return { sent };
}

function sentOfKind(sent: Envelope[], kind: string): Envelope[] {
  return sent.filter((message) => message.kind === kind);
}

beforeEach(() => {
  useWallet.setState(INITIAL_STORE);
  // Default: an empty, unregistered pool, so the overview renders unless a
  // test says otherwise.
  installTrackedResponder({ 'spp.status': sppStatus() });
});

afterEach(() => {
  vi.restoreAllMocks();
  useWallet.setState(INITIAL_STORE);
});

describe('privacy view (pXLM pool)', () => {
  it('renders the pool status: symbol, private balance, and the registration prompt', async () => {
    const { sent } = installTrackedResponder({
      'spp.status': sppStatus({ balanceStroops: '1500000000', registered: false }),
    });

    render(<PrivacyView onBack={vi.fn()} />);

    // The balance card: pXLM, the formatted private balance (150 XLM), and
    // the pool network tag.
    expect(await screen.findByText('pXLM')).toBeInTheDocument();
    expect(screen.getByText('150')).toBeInTheDocument();
    expect(screen.getByText('Shielded pool · Stellar Testnet')).toBeInTheDocument();

    // Unregistered: the receive section prompts and offers Enable.
    expect(
      screen.getByText('Register your pool keys to receive by address.'),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Enable' })).toBeEnabled();

    // No Stellar account preloaded → nothing to shield.
    expect(screen.getByText('Public XLM available to shield: 0 XLM')).toBeInTheDocument();

    // The status request crossed the bus with an empty payload and the
    // protocol envelope shape.
    const status = sentOfKind(sent, 'spp.status');
    expect(status).toHaveLength(1);
    expect(status[0]!.payload).toEqual({});
    expect(status[0]!.v).toBe(1);
    expect(status[0]!.source).toBe('popup');
    expect(typeof status[0]!.id).toBe('string');
  });

  it('renders the registered receive state when the wallet is registered', async () => {
    installTrackedResponder({
      'spp.status': sppStatus({ registered: true, balanceStroops: '25000000' }),
    });

    render(<PrivacyView onBack={vi.fn()} />);

    expect(
      await screen.findByText('Enabled — others can send to your address.'),
    ).toBeInTheDocument();
    // Registered: no Enable CTA anymore.
    expect(screen.queryByRole('button', { name: 'Enable' })).not.toBeInTheDocument();
  });

  it('disables send and unshield entries without a private balance', async () => {
    installTrackedResponder({
      'spp.status': sppStatus({ balanceStroops: '0' }),
    });

    render(<PrivacyView onBack={vi.fn()} />);

    await screen.findByText('Register your pool keys to receive by address.');
    expect(screen.getByRole('button', { name: 'Shield XLM' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Send privately' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Unshield to XLM' })).toBeDisabled();
  });

  it('shields XLM: sends spp.deposit with stroops and shows the receipt', async () => {
    const user = userEvent.setup();
    useWallet.setState({
      accounts: [STELLAR_ACCOUNT],
      balances: { [`stellar:${STELLAR_ACCOUNT.address}`]: 10_000_000_000n },
    });
    const { sent } = installTrackedResponder({
      'spp.status': sppStatus({ registered: true, balanceStroops: '0' }),
      'spp.deposit': { txHash: 'deposithash001', amountStroops: '25000000' },
    });

    render(<PrivacyView onBack={vi.fn()} />);

    // Overview shows the public balance available to shield (1000 XLM).
    expect(await screen.findByText('Public XLM available to shield: 1000 XLM')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Shield XLM' }));

    // The shield form: header, balance row, and the amount field.
    expect(screen.getByText('SHIELD XLM')).toBeInTheDocument();
    expect(screen.getByText('1000 XLM')).toBeInTheDocument();

    await user.type(screen.getByLabelText('Amount in XLM to shield'), '2.5');
    await user.click(screen.getByRole('button', { name: 'Shield 2.5 XLM' }));

    // Receipt: success note, the tx hash, and the explorer link.
    expect(
      await screen.findByText('Your XLM is now private. Spend it from this balance.'),
    ).toBeInTheDocument();
    const link = screen.getByRole('link', { name: 'deposithash001' });
    expect(link).toHaveAttribute(
      'href',
      'https://stellar.expert/explorer/testnet/tx/deposithash001',
    );
    expect(screen.getByRole('button', { name: 'Done' })).toBeInTheDocument();

    // The wire: spp.deposit with the amount converted to stroops.
    const deposits = sentOfKind(sent, 'spp.deposit');
    expect(deposits).toHaveLength(1);
    expect(deposits[0]!.payload).toEqual({ amountStroops: '25000000' });

    // After success the panel re-reads the pool status.
    await vi.waitFor(() => {
      expect(sentOfKind(sent, 'spp.status').length).toBeGreaterThanOrEqual(2);
    });
  });

  it('sends privately: spp.transfer carries the recipient and the stroop amount', async () => {
    const user = userEvent.setup();
    const recipient = 'G' + 'A'.repeat(55);
    const { sent } = installTrackedResponder({
      'spp.status': sppStatus({ registered: true, balanceStroops: '1500000000' }),
      'spp.transfer': { txHash: 'transferhash02', amountStroops: '5000000' },
    });

    render(<PrivacyView onBack={vi.fn()} />);

    await screen.findByText('150');
    await user.click(screen.getByRole('button', { name: 'Send privately' }));

    expect(screen.getByText('SEND PRIVATELY')).toBeInTheDocument();

    await user.type(screen.getByLabelText('Recipient Stellar address'), recipient);
    await user.type(screen.getByLabelText('Amount in XLM to send'), '0.5');
    await user.click(screen.getByRole('button', { name: 'Send privately 0.5 XLM' }));

    expect(
      await screen.findByText(
        'Sent privately — the ledger records no sender, recipient, or amount.',
      ),
    ).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'transferhash02' })).toBeInTheDocument();

    const transfers = sentOfKind(sent, 'spp.transfer');
    expect(transfers).toHaveLength(1);
    expect(transfers[0]!.payload).toEqual({ to: recipient, amountStroops: '5000000' });
  });

  it('unshields: spp.withdraw carries the stroop amount', async () => {
    const user = userEvent.setup();
    const { sent } = installTrackedResponder({
      'spp.status': sppStatus({ registered: true, balanceStroops: '100000000' }),
      'spp.withdraw': { txHash: 'withdrawhash03', amountStroops: '30000000' },
    });

    render(<PrivacyView onBack={vi.fn()} />);

    await screen.findByText('10');
    await user.click(screen.getByRole('button', { name: 'Unshield to XLM' }));

    expect(screen.getByText('UNSHIELD')).toBeInTheDocument();
    expect(screen.getByText('10 pXLM')).toBeInTheDocument();

    await user.type(screen.getByLabelText('Amount in XLM to unshield'), '3');
    await user.click(screen.getByRole('button', { name: 'Unshield 3 pXLM' }));

    expect(
      await screen.findByText('Private notes converted back to public XLM.'),
    ).toBeInTheDocument();

    const withdrawals = sentOfKind(sent, 'spp.withdraw');
    expect(withdrawals).toHaveLength(1);
    expect(withdrawals[0]!.payload).toEqual({ amountStroops: '30000000' });
  });

  it('registration CTA sends spp.register and flips the receive state', async () => {
    const user = userEvent.setup();
    let registered = false;
    const { sent } = installTrackedResponder(undefined, (message) => {
      if (message.kind === 'spp.status') {
        return { id: uuid(), ok: true, data: sppStatus({ registered, balanceStroops: '0' }) };
      }
      if (message.kind === 'spp.register') {
        registered = true;
        return { id: uuid(), ok: true, data: { txHash: 'registerhash04' } };
      }
      return { id: uuid(), ok: true, data: undefined };
    });

    render(<PrivacyView onBack={vi.fn()} />);

    await screen.findByText('Register your pool keys to receive by address.');
    await user.click(screen.getByRole('button', { name: 'Enable' }));

    // Receipt for the registration, with its own note and hash.
    expect(
      await screen.findByText('This wallet can now receive private transfers by address.'),
    ).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'registerhash04' })).toBeInTheDocument();

    const registrations = sentOfKind(sent, 'spp.register');
    expect(registrations).toHaveLength(1);
    expect(registrations[0]!.payload).toEqual({});

    // Back on the overview, the re-read status now shows the enabled state.
    await user.click(screen.getByRole('button', { name: 'Done' }));
    expect(
      await screen.findByText('Enabled — others can send to your address.'),
    ).toBeInTheDocument();
  });

  it('surfaces the background error and keeps the form values on a failed shield', async () => {
    const user = userEvent.setup();
    useWallet.setState({
      accounts: [STELLAR_ACCOUNT],
      balances: { [`stellar:${STELLAR_ACCOUNT.address}`]: 10_000_000_000n },
    });
    installTrackedResponder(undefined, (message) => {
      if (message.kind === 'spp.status') {
        return {
          id: uuid(),
          ok: true,
          data: sppStatus({ registered: true, balanceStroops: '0' }),
        };
      }
      if (message.kind === 'spp.deposit') {
        return {
          id: uuid(),
          ok: false,
          error: {
            code: 'TX_REJECTED',
            message: 'The pool rejected the operation: insufficient public XLM.',
          },
        };
      }
      return { id: uuid(), ok: true, data: undefined };
    });

    render(<PrivacyView onBack={vi.fn()} />);

    await screen.findByText('Public XLM available to shield: 1000 XLM');
    await user.click(screen.getByRole('button', { name: 'Shield XLM' }));
    await user.type(screen.getByLabelText('Amount in XLM to shield'), '1');
    await user.click(screen.getByRole('button', { name: 'Shield 1 XLM' }));

    // The store's error surfaces in the alert, and the form (not the
    // receipt) is back with the amount preserved for correction.
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(
      'The pool rejected the operation: insufficient public XLM.',
    );
    expect(screen.getByText('SHIELD XLM')).toBeInTheDocument();
    expect(screen.getByLabelText('Amount in XLM to shield')).toHaveValue('1');
    expect(screen.queryByRole('button', { name: 'Done' })).not.toBeInTheDocument();
  });

  it('surfaces a registration failure on the overview', async () => {
    const user = userEvent.setup();
    installTrackedResponder(undefined, (message) => {
      if (message.kind === 'spp.status') {
        return { id: uuid(), ok: true, data: sppStatus({ registered: false }) };
      }
      if (message.kind === 'spp.register') {
        return {
          id: uuid(),
          ok: false,
          error: { code: 'TX_REJECTED', message: 'Could not register the privacy keys.' },
        };
      }
      return { id: uuid(), ok: true, data: undefined };
    });

    render(<PrivacyView onBack={vi.fn()} />);

    await screen.findByText('Register your pool keys to receive by address.');
    await user.click(screen.getByRole('button', { name: 'Enable' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Could not register the privacy keys.',
    );
    // Still on the overview (no receipt), and the CTA is back for a retry.
    expect(screen.getByRole('button', { name: 'Enable' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Done' })).not.toBeInTheDocument();
  });

  it('shows the proving state while an operation is in flight', async () => {
    const user = userEvent.setup();
    useWallet.setState({
      accounts: [STELLAR_ACCOUNT],
      balances: { [`stellar:${STELLAR_ACCOUNT.address}`]: 10_000_000_000n },
    });
    installTrackedResponder(undefined, (message) => {
      if (message.kind === 'spp.status') {
        return {
          id: uuid(),
          ok: true,
          data: sppStatus({ registered: true, balanceStroops: '0' }),
        };
      }
      if (message.kind === 'spp.deposit') {
        // Never settles: the panel must stay in the proving state.
        return new Promise(() => {}) as never;
      }
      return { id: uuid(), ok: true, data: undefined };
    });

    render(<PrivacyView onBack={vi.fn()} />);

    await screen.findByText('Public XLM available to shield: 1000 XLM');
    await user.click(screen.getByRole('button', { name: 'Shield XLM' }));
    await user.type(screen.getByLabelText('Amount in XLM to shield'), '1');
    await user.click(screen.getByRole('button', { name: 'Shield 1 XLM' }));

    // The working screen is honest about proving time; the form is gone.
    expect(await screen.findByText('Generating proof')).toBeInTheDocument();
    expect(
      screen.getByText(/computed on this device. This can take up to a minute./),
    ).toBeInTheDocument();
    expect(screen.queryByLabelText('Amount in XLM to shield')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Done' })).not.toBeInTheDocument();
  });

  it('blocks invalid amounts, over-balance shields, and malformed recipients', async () => {
    const user = userEvent.setup();
    useWallet.setState({
      accounts: [STELLAR_ACCOUNT],
      balances: { [`stellar:${STELLAR_ACCOUNT.address}`]: 10_000_000_000n },
    });
    installTrackedResponder({
      'spp.status': sppStatus({ registered: true, balanceStroops: '50000000' }),
    });

    render(<PrivacyView onBack={vi.fn()} />);

    await screen.findByText('5');

    // ── Shield: empty amount → submit disabled; no request crosses the bus.
    await user.click(screen.getByRole('button', { name: 'Shield XLM' }));
    // A string `name` is an exact full-text match, so 'Shield' selects the
    // submit button without colliding with the overview 'Shield XLM' entry.
    expect(screen.getByRole('button', { name: 'Shield' })).toBeDisabled();

    // Above the public balance (1000 XLM) → blocked with a specific error.
    await user.type(screen.getByLabelText('Amount in XLM to shield'), '2000');
    expect(screen.getByText('Amount exceeds your public XLM balance.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Shield 2000 XLM' })).toBeDisabled();

    // Malformed amount → the generic amount error.
    await user.clear(screen.getByLabelText('Amount in XLM to shield'));
    await user.type(screen.getByLabelText('Amount in XLM to shield'), 'abc');
    expect(screen.getByText('Enter an amount greater than zero.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Shield' })).toBeDisabled();

    // ── Send: a malformed recipient blocks the submit independently of amount.
    await user.click(screen.getByRole('button', { name: 'Back' }));
    await user.click(screen.getByRole('button', { name: 'Send privately' }));

    await user.type(screen.getByLabelText('Recipient Stellar address'), 'GSHORT');
    await user.type(screen.getByLabelText('Amount in XLM to send'), '1');
    expect(screen.getByText('Enter a valid Stellar address.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Send privately 1 XLM' })).toBeDisabled();

    // Above the private balance (5 XLM) → blocked too.
    await user.clear(screen.getByLabelText('Recipient Stellar address'));
    await user.type(screen.getByLabelText('Recipient Stellar address'), 'G' + 'A'.repeat(55));
    await user.clear(screen.getByLabelText('Amount in XLM to send'));
    await user.type(screen.getByLabelText('Amount in XLM to send'), '9');
    expect(screen.getByText('Amount exceeds your private balance.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Send privately 9 XLM' })).toBeDisabled();
  });
});

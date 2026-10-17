import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Dashboard } from '@/ui/components/Dashboard';
import { useWallet } from '@/ui/store/useWallet';

/**
 * Dashboard faucet wiring tests.
 *
 * The faucet button's contract is per-chain, and the UI must be honest about
 * which of the two funding modes the background actually used:
 *
 *  - `txHash`   → funds moved on-chain (Stellar Friendbot / a successful
 *                 Solana airdrop): "on the way" + a balance refresh.
 *  - `faucetUrl`→ the faucet needs the user in a browser (every EVM testnet;
 *                 Solana when the RPC airdrop is rate-limited): the tab MUST
 *                 be opened, and the message must say so — a bare "Funds
 *                 requested!" here is a lie the user waits on forever.
 */

type Incoming = { kind: string; payload: unknown };
type Envelope = Incoming & { id: string; v: number; source: string };

function uuid(): string {
  return crypto.randomUUID();
}

const STELLAR_ACCOUNT = {
  chain: 'stellar' as const,
  index: 0,
  address: 'GD6Q6Q6Q6Q6Q6Q6Q6Q6Q6Q6Q6Q6Q6Q6Q6Q6Q6Q6Q6Q6',
  path: "m/44'/148'/0'",
};

const NETWORK_SUMMARIES = [
  {
    id: 'stellar:mainnet',
    chain: 'stellar' as const,
    kind: 'mainnet' as const,
    name: 'Stellar Mainnet',
    symbol: 'XLM',
    rpcUrls: ['https://horizon.stellar.org'],
    explorerTx: 'https://stellar.expert/explorer/public/tx/{hash}',
    faucet: false,
  },
  {
    id: 'stellar:testnet',
    chain: 'stellar' as const,
    kind: 'testnet' as const,
    name: 'Stellar Testnet',
    symbol: 'XLM',
    rpcUrls: ['https://horizon-testnet.stellar.org'],
    explorerTx: 'https://stellar.expert/explorer/testnet/tx/{hash}',
    faucet: true,
  },
];

const INITIAL_STORE = {
  vaultState: 'unlocked' as const,
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
  networks: [],
  selectedNetworks: {},
};

/**
 * Answers every request kind the dashboard fires on mount with a harmless
 * default, and `faucet.request` with the caller's faucet result.
 */
function installResponder(faucetData: unknown): { sent: Envelope[] } {
  const sent: Envelope[] = [];
  vi.mocked(chrome.runtime.sendMessage).mockImplementation((...args: unknown[]) => {
    const message = (args.length >= 2 ? args[1] : args[0]) as Incoming;
    sent.push(message as Envelope);
    const data =
      message.kind === 'faucet.request'
        ? faucetData
        : message.kind === 'networks.list'
          ? NETWORK_SUMMARIES
          : message.kind === 'networks.selected'
            ? { stellar: 'stellar:testnet' }
            : message.kind === 'account.balance'
              ? { chain: 'stellar', address: STELLAR_ACCOUNT.address, balance: '10000000' }
              : message.kind === 'spp.status'
                ? null
                : { transactions: [], nextCursor: null, source: 'network' };
    return { id: uuid(), ok: true, data } as never;
  });
  return { sent };
}

function renderDashboard(): void {
  render(
    <Dashboard
      accounts={[STELLAR_ACCOUNT]}
      onSend={vi.fn()}
      onReceive={vi.fn()}
      onImport={vi.fn()}
      onLock={vi.fn()}
      onPrivacy={vi.fn()}
    />,
  );
}

function tabsCreate(): ReturnType<typeof vi.fn> {
  const stub = vi.fn();
  (globalThis.chrome as unknown as { tabs: unknown }).tabs = { create: stub };
  return stub;
}

beforeEach(() => {
  useWallet.setState({
    ...INITIAL_STORE,
    accounts: [STELLAR_ACCOUNT],
    networks: NETWORK_SUMMARIES,
    selectedNetworks: { stellar: 'stellar:testnet' },
  });
  installResponder({ ok: true, txHash: 'hash-from-friendbot' });
});

afterEach(() => {
  vi.restoreAllMocks();
  useWallet.setState(INITIAL_STORE);
});

describe('dashboard faucet button', () => {
  it('shows "on the way" and refreshes balances when the faucet funded on-chain', async () => {
    const { sent } = installResponder({ ok: true, txHash: 'abc123' });
    const create = tabsCreate();
    renderDashboard();

    const balanceReadsBefore = sent.filter((message) => message.kind === 'account.balance').length;
    await userEvent.click(await screen.findByRole('button', { name: 'Faucet' }));

    expect(await screen.findByText('Testnet funds on the way')).toBeInTheDocument();
    // The on-chain mode never opens a browser tab…
    expect(create).not.toHaveBeenCalled();
    // …and refreshes the balance so the incoming funds show up.
    await waitFor(() => {
      const balanceReadsAfter = sent.filter((message) => message.kind === 'account.balance').length;
      expect(balanceReadsAfter).toBeGreaterThan(balanceReadsBefore);
    });
  });

  it('opens the faucet page in a new tab and says so (EVM / rate-limited Solana)', async () => {
    installResponder({
      ok: true,
      faucetUrl: 'https://sepoliafaucet.com/?address=0xabc',
    });
    const create = tabsCreate();
    renderDashboard();

    await userEvent.click(await screen.findByRole('button', { name: 'Faucet' }));

    expect(await screen.findByText('Faucet opened in a new tab — finish it there')).toBeInTheDocument();
    // The pre-filled faucet page is opened for the user to complete…
    expect(create).toHaveBeenCalledWith({
      url: 'https://sepoliafaucet.com/?address=0xabc',
      active: true,
    });
    // …and the UI never claims funds were merely "requested" in this mode.
    expect(screen.queryByText('Funds requested!')).not.toBeInTheDocument();
  });

  it('surfaces the background error when the faucet refuses', async () => {
    installResponder({ ok: false, chain: 'stellar', error: 'This network has no faucet.' });
    renderDashboard();

    await userEvent.click(await screen.findByRole('button', { name: 'Faucet' }));

    expect(await screen.findByText('This network has no faucet.')).toBeInTheDocument();
  });
});

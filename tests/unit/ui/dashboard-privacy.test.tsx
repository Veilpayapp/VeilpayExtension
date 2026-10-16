import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Dashboard } from '@/ui/components/Dashboard';
import { useWallet } from '@/ui/store/useWallet';
import type { SppPoolStatus } from '@/ui/store/useWallet';

/**
 * Dashboard ↔ privacy-pool wiring tests (the pXLM tile).
 *
 * The dashboard is the entry surface for the privacy pool: it reads
 * `spp.status` alongside its balance/history refresh, renders the live
 * private balance in the Privacy tile, and hands navigation to the privacy
 * surface through `onPrivacy`. These tests pin that wiring: what crosses the
 * bus, what the tile shows (including the honest `— pXLM` fallback when the
 * pool read fails — never a fabricated number), and that a network switch
 * re-reads the pool status (the read is keyed on the active network).
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

/** Registry summaries the network selector renders. */
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

const STELLAR_ACCOUNT = {
  chain: 'stellar' as const,
  index: 0,
  address: 'GD6Q6Q6Q6Q6Q6Q6Q6Q6Q6Q6Q6Q6Q6Q6Q6Q6Q6Q6Q6Q6',
  path: "m/44'/148'/0'",
};

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
 * Installs a responder that answers the request kinds the dashboard fires on
 * mount, and records every outgoing message (full wire envelope). Returns the
 * captured envelopes.
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

function sentOfKind(sent: Envelope[], kind: string): Envelope[] {
  return sent.filter((message) => message.kind === kind);
}

function renderDashboard(onPrivacy: () => void = vi.fn()): void {
  render(
    <Dashboard
      accounts={[STELLAR_ACCOUNT]}
      onSend={vi.fn()}
      onReceive={vi.fn()}
      onImport={vi.fn()}
      onLock={vi.fn()}
      onPrivacy={onPrivacy}
    />,
  );
}

beforeEach(() => {
  useWallet.setState({
    ...INITIAL_STORE,
    accounts: [STELLAR_ACCOUNT],
    networks: NETWORK_SUMMARIES,
    selectedNetworks: { stellar: 'stellar:testnet' },
  });
  installTrackedResponder({
    'spp.status': sppStatus({ balanceStroops: '1500000000' }),
    'account.balance': { chain: 'stellar', address: STELLAR_ACCOUNT.address, balance: '10000000' },
    'indexer.history': { transactions: [], nextCursor: null, source: 'network' },
    'networks.list': NETWORK_SUMMARIES,
    'networks.selected': { stellar: 'stellar:testnet' },
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  useWallet.setState(INITIAL_STORE);
});

describe('dashboard privacy (pXLM) wiring', () => {
  it('reads spp.status on mount and renders the live private balance in the tile', async () => {
    const { sent } = installTrackedResponder({
      'spp.status': sppStatus({ balanceStroops: '1500000000', registered: true }),
      'account.balance': { chain: 'stellar', address: STELLAR_ACCOUNT.address, balance: '10000000' },
      'indexer.history': { transactions: [], nextCursor: null, source: 'network' },
    });

    renderDashboard();

    // The Privacy section and the pXLM tile.
    expect(screen.getByText('Privacy')).toBeInTheDocument();
    expect(screen.getByText('pXLM')).toBeInTheDocument();
    expect(screen.getByText('PRIVATE XLM')).toBeInTheDocument();
    expect(screen.getByText('Shielded transfers · Testnet')).toBeInTheDocument();

    // The live private balance: 1_500_000_000 stroops → 150 pXLM (exact
    // bigint formatting, never a float).
    expect(await screen.findByText('150 pXLM')).toBeInTheDocument();

    // The status read crossed the bus with the protocol envelope shape.
    const status = sentOfKind(sent, 'spp.status');
    expect(status).toHaveLength(1);
    expect(status[0]!.payload).toEqual({});
    expect(status[0]!.v).toBe(1);
    expect(status[0]!.source).toBe('popup');
    expect(typeof status[0]!.id).toBe('string');
  });

  it('degrades to the honest placeholder when the pool read fails (no fabricated balance)', async () => {
    installTrackedResponder(undefined, (message) => {
      if (message.kind === 'spp.status') {
        return {
          id: uuid(),
          ok: false,
          error: { code: 'INTERNAL', message: 'The privacy pool runtime did not answer.' },
        };
      }
      if (message.kind === 'account.balance') {
        return {
          id: uuid(),
          ok: true,
          data: { chain: 'stellar', address: STELLAR_ACCOUNT.address, balance: '10000000' },
        };
      }
      return { id: uuid(), ok: true, data: undefined };
    });

    renderDashboard();

    // A failing (e.g. locked) read shows the placeholder — never a number
    // the pool did not report.
    expect(await screen.findByText('— pXLM')).toBeInTheDocument();
    expect(screen.queryByText('0 pXLM')).not.toBeInTheDocument();
  });

  it('hands navigation to the privacy surface when the tile is clicked', async () => {
    const onPrivacy = vi.fn();
    renderDashboard(onPrivacy);

    const tile = await screen.findByRole('button', { name: 'Open private payments' });
    await userEvent.setup().click(tile);

    expect(onPrivacy).toHaveBeenCalledTimes(1);
  });

  it('re-reads the pool status when the active network changes', async () => {
    const user = userEvent.setup();
    let statusCalls = 0;
    installTrackedResponder(undefined, (message) => {
      if (message.kind === 'spp.status') {
        statusCalls += 1;
        return { id: uuid(), ok: true, data: sppStatus({ balanceStroops: '1500000000' }) };
      }
      if (message.kind === 'account.balance') {
        return {
          id: uuid(),
          ok: true,
          data: { chain: 'stellar', address: STELLAR_ACCOUNT.address, balance: '10000000' },
        };
      }
      if (message.kind === 'networks.select') {
        return { id: uuid(), ok: true, data: { ok: true } };
      }
      return { id: uuid(), ok: true, data: undefined };
    });

    renderDashboard();

    expect(await screen.findByText('150 pXLM')).toBeInTheDocument();
    expect(statusCalls).toBe(1);

    // Switch the active network: testnet → mainnet. The read is keyed on the
    // active network id, so the pool status must be re-read.
    await user.click(screen.getByRole('button', { name: /Select network, current STELLAR TESTNET/ }));
    await user.click(screen.getByRole('menuitemradio', { name: /Stellar Mainnet/ }));

    expect(
      await screen.findByRole('button', { name: /Select network, current STELLAR MAINNET/ }),
    ).toBeInTheDocument();
    await vi.waitFor(() => {
      expect(statusCalls).toBeGreaterThanOrEqual(2);
    });
  });
});

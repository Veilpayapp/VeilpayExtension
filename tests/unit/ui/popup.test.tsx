import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import App from '@/popup/App';
import { useWallet } from '@/ui/store/useWallet';

/**
 * Popup onboarding smoke tests.
 *
 * The popup talks to the background over `chrome.runtime.sendMessage`, which the
 * test shim stubs with `vi.fn()`. These tests replace it with a responder that
 * returns a valid protocol `Response` for each kind, so the store's `refresh`
 * resolves and the UI reaches a deterministic state.
 */

type Incoming = { kind: string; payload: unknown };
type Responder = (message: Incoming) => unknown;

function uuid(): string {
  return crypto.randomUUID();
}

const VALID_PHRASE =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

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

/** Install a stub that answers protocol requests from the background. */
function installResponder(overrides: Partial<Record<string, unknown>> = {}): void {
  const responder = buildResponder(overrides);
  vi.mocked(chrome.runtime.sendMessage).mockImplementation(
    (...args: unknown[]) => {
      // chrome.runtime.sendMessage has overloads:
      //   sendMessage(message, ...)  — extension sends to itself
      //   sendMessage(extensionId, message, ...) — cross-extension
      // The message is either args[0] or args[1] depending on the overload.
      const message = args.length >= 2 ? args[1] : args[0];
      return responder(message as Incoming) as never;
    },
  );
}

beforeEach(() => {
  useWallet.setState(INITIAL_STORE);
  installResponder({
    'vault.status': { state: 'uninitialized', unlockedUntil: null },
    'zk.capability': null,
    'mnemonic.generate': { mnemonic: VALID_PHRASE },
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  useWallet.setState(INITIAL_STORE);
});

describe('popup onboarding', () => {
  it('shows the welcome screen for an uninitialized vault', async () => {
    render(<App />);
    expect(await screen.findByText('Welcome to Veilpay')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Create new wallet' })).toBeInTheDocument();
  });

  it('walks through phrase generation to the passphrase step', async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(await screen.findByRole('button', { name: 'Create new wallet' }));

    // First, the phrase is hidden behind a reveal gate.
    expect(await screen.findByText('Recovery phrase')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Reveal recovery phrase' })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Reveal recovery phrase' }));

    // Words are shown (11× "abandon" + "about").
    expect(screen.getAllByText('abandon', { selector: 'span' })).toHaveLength(11);
    expect(screen.getByText('about', { selector: 'span' })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: "I've saved it" }));
    expect(await screen.findByText('Set a passphrase')).toBeInTheDocument();
  });

  it('requires matching passphrases before creating the wallet', async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(await screen.findByRole('button', { name: 'Create new wallet' }));
    await user.click(await screen.findByRole('button', { name: 'Reveal recovery phrase' }));
    await user.click(screen.getByRole('button', { name: "I've saved it" }));

    const [first, second] = screen.getAllByPlaceholderText(/passphrase/i);
    if (first === undefined || second === undefined) {
      throw new Error('Expected two passphrase inputs.');
    }
    await user.type(first, 'correct horse battery');
    await user.type(second, 'different passphrase');

    const create = screen.getByRole('button', { name: 'Create wallet' });
    expect(create).toBeEnabled();

    await user.click(create);
    expect(await screen.findByText('Passphrases do not match.')).toBeInTheDocument();
  });

  it('creates a vault and reaches the success screen', async () => {
    const create = vi.fn(async () => ({ state: 'unlocked' }));
    installResponder({
      'vault.status': { state: 'uninitialized', unlockedUntil: null },
      'zk.capability': null,
      'mnemonic.generate': { mnemonic: VALID_PHRASE },
      'vault.create': await create(),
    });

    const user = userEvent.setup();
    render(<App />);

    await user.click(await screen.findByRole('button', { name: 'Create new wallet' }));
    await user.click(await screen.findByRole('button', { name: 'Reveal recovery phrase' }));
    await user.click(screen.getByRole('button', { name: "I've saved it" }));

    const [first, second] = screen.getAllByPlaceholderText(/passphrase/i);
    if (first === undefined || second === undefined) {
      throw new Error('Expected two passphrase inputs.');
    }
    await user.type(first, 'correct horse battery');
    await user.type(second, 'correct horse battery');

    await user.click(screen.getByRole('button', { name: 'Create wallet' }));
    expect(await screen.findByText('Wallet created')).toBeInTheDocument();
  });

  it('rejects a passphrase below the vault minimum on the passphrase step', async () => {
    const user = userEvent.setup();
    installResponder({
      'vault.status': { state: 'uninitialized', unlockedUntil: null },
      'zk.capability': null,
      'mnemonic.generate': { mnemonic: VALID_PHRASE },
    });

    render(<App />);

    await user.click(await screen.findByRole('button', { name: 'Create new wallet' }));
    await user.click(await screen.findByRole('button', { name: 'Reveal recovery phrase' }));
    await user.click(screen.getByRole('button', { name: "I've saved it" }));

    const [first, second] = screen.getAllByPlaceholderText(/passphrase/i);
    if (first === undefined || second === undefined) {
      throw new Error('Expected two passphrase inputs.');
    }
    await user.type(first, 'short');
    await user.type(second, 'short');

    await user.click(screen.getByRole('button', { name: 'Create wallet' }));
    expect(await screen.findByText('Passphrase must be at least 10 characters.')).toBeInTheDocument();
    // Never submitted: still on the passphrase step, not the boot spinner.
    expect(screen.queryByText('Loading wallet…')).not.toBeInTheDocument();
  });

  it('never shows the boot spinner while the import form is submitting', async () => {
    // `vault.create` never resolves: while awaiting, the import form's own
    // progress must render — NOT the page-level "Loading wallet…" gate (which
    // previously hijacked the import flow because phrase stays null).
    vi.mocked(chrome.runtime.sendMessage).mockImplementation(
      (message: unknown) => {
        const kind =
          typeof message === 'object' &&
          message !== null &&
          'kind' in message
            ? String((message as { kind: unknown }).kind)
            : '';
        if (kind === 'vault.create') return new Promise(() => {}) as never;
        if (kind === 'vault.status') {
          return Promise.resolve({
            id: crypto.randomUUID(),
            ok: true,
            data: { state: 'uninitialized', unlockedUntil: null },
          }) as never;
        }
        return Promise.resolve({ id: crypto.randomUUID(), ok: true, data: null }) as never;
      },
    );

    const user = userEvent.setup();
    render(<App />);

    await user.click(await screen.findByRole('button', { name: 'Import existing wallet' }));
    const phraseInput = await screen.findByPlaceholderText('Recovery phrase');
    const nameInputs = screen.getAllByPlaceholderText(/passphrase/i);
    await user.type(phraseInput, VALID_PHRASE);
    await user.type(nameInputs[0]!, 'correct horse battery');
    await user.type(nameInputs[1]!, 'correct horse battery');

    await user.click(screen.getByRole('button', { name: 'Import wallet' }));

    // While the create request is in flight, the popup stays on the import
    // form (Importing…), NOT the boot loading spinner.
    expect(screen.queryByText('Loading wallet…')).not.toBeInTheDocument();
    expect(screen.getByText('Importing…')).toBeInTheDocument();
  });
});

describe('popup unlocked dashboard', () => {
  const ACCOUNTS = [
    { chain: 'evm' as const, index: 0, address: '0x0000000000000000000000000000000000000001', path: 'm/44\'/60\'/0\'' },
    { chain: 'solana' as const, index: 0, address: '11111111111111111111111111111111', path: 'm/44\'/501\'/0\'' },
    { chain: 'stellar' as const, index: 0, address: 'GD6Q6Q6Q6Q6Q6Q6Q6Q6Q6Q6Q6Q6Q6Q6Q6Q6Q6Q6Q6Q6', path: 'm/44\'/148\'/0\'' },
  ];

  it('shows the portfolio and asset list for an unlocked vault', async () => {
    useWallet.setState({ vaultState: 'unlocked', accounts: ACCOUNTS });
    installResponder({
      'vault.status': { state: 'unlocked', unlockedUntil: Date.now() + 60_000 },
      'zk.capability': null,
      'account.balance': { chain: 'evm', address: '0x0000000000000000000000000000000000000001', balance: '1000000000000000000' },
    });

    render(<App />);

    // Dashboard shows portfolio and asset sections.
    expect(await screen.findByText('Portfolio')).toBeInTheDocument();
    expect(screen.getByText('Assets')).toBeInTheDocument();
    expect(screen.getByText(/Recent Transactions/)).toBeInTheDocument();

    // Send/Receive buttons: one quick-action button plus one per asset row.
    expect(screen.getAllByRole('button', { name: 'Send' }).length).toBe(4);
    expect(screen.getAllByRole('button', { name: 'Receive' }).length).toBe(4);
  });

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
    {
      id: 'evm:ethereum',
      chain: 'evm' as const,
      kind: 'mainnet' as const,
      name: 'Ethereum',
      symbol: 'ETH',
      rpcUrls: ['https://1rpc.io/eth'],
      chainId: 1,
      explorerTx: 'https://etherscan.io/tx/{hash}',
      faucet: false,
    },
    {
      id: 'evm:sepolia',
      chain: 'evm' as const,
      kind: 'testnet' as const,
      name: 'Sepolia',
      symbol: 'ETH',
      rpcUrls: ['https://ethereum-sepolia-rpc.publicnode.com'],
      chainId: 11155111,
      explorerTx: 'https://sepolia.etherscan.io/tx/{hash}',
      faucet: true,
    },
    {
      id: 'solana:devnet',
      chain: 'solana' as const,
      kind: 'testnet' as const,
      name: 'Solana Devnet',
      symbol: 'SOL',
      rpcUrls: ['https://api.devnet.solana.com'],
      explorerTx: 'https://explorer.solana.com/tx/{hash}?cluster=devnet',
      faucet: true,
    },
  ];

  it('opens the send form for an account', async () => {
    const user = userEvent.setup();
    useWallet.setState({ vaultState: 'unlocked', accounts: [ACCOUNTS[0]!] });
    installResponder({
      'vault.status': { state: 'unlocked', unlockedUntil: Date.now() + 60_000 },
      'zk.capability': null,
      'account.balance': { chain: 'evm', address: '0x0000000000000000000000000000000000000001', balance: '1000000000000000000' },
    });

    render(<App />);

    // Both the quick-action button and the asset-row button say "Send"; the
    // quick-action one is first in the DOM.
    const [sendButton] = await screen.findAllByRole('button', { name: 'Send' });
    if (!sendButton) throw new Error('Expected a Send button.');
    await user.click(sendButton);

    expect(await screen.findByText(/Send from/)).toBeInTheDocument();
    expect(screen.getByPlaceholderText('Recipient address')).toBeInTheDocument();
    expect(screen.getByLabelText('Amount (ETH)')).toBeInTheDocument();
  });

  it('auto-estimates the fee (debounced) and enables Send when balance suffices', async () => {
    const user = userEvent.setup();
    useWallet.setState({ vaultState: 'unlocked', accounts: [ACCOUNTS[0]!] });
    installResponder({
      'vault.status': { state: 'unlocked', unlockedUntil: Date.now() + 60_000 },
      'zk.capability': null,
      'account.balance': { chain: 'evm', address: '0x0000000000000000000000000000000000000001', balance: '1000000000000000000' },
      'tx.estimate': {
        chain: 'evm',
        from: '0x0000000000000000000000000000000000000001',
        feeNative: '21000000000',
        gasLimit: '21000',
        decimals: 18,
        spendableBalance: '1000000000000000000',
        symbol: 'ETH',
      },
      'tx.transfer': { chain: 'evm', from: '0x0000000000000000000000000000000000000001', to: 'addr', amountNative: '0', hash: '0xabc', decimals: 18 },
    });

    render(<App />);

    const [sendButton] = await screen.findAllByRole('button', { name: 'Send' });
    if (!sendButton) throw new Error('Expected a Send button.');
    await user.click(sendButton);

    // The fee appears WITHOUT a manual "Estimate fee" button (auto-run).
    expect(screen.queryByRole('button', { name: 'Estimate fee' })).not.toBeInTheDocument();

    await user.type(screen.getByPlaceholderText('Recipient address'), '0x1122334455667788990011223344556677889900');
    await user.type(screen.getByLabelText('Amount (ETH)'), '0.5');

    // Debounced estimate runs ~400ms after typing settles.
    expect(await screen.findByText(/Estimated fee: 21000000000 Gwei/)).toBeInTheDocument();

    // With sufficient balance the estimate resolves and Send is enabled.
    await user.click(screen.getByRole('button', { name: 'Send' }));
    expect(await screen.findByText(/Sent!/)).toBeInTheDocument();
  });

  it('disables Send and shows an inline error when the balance is insufficient', async () => {
    const user = userEvent.setup();
    useWallet.setState({ vaultState: 'unlocked', accounts: [ACCOUNTS[0]!] });
    installResponder({
      'vault.status': { state: 'unlocked', unlockedUntil: Date.now() + 60_000 },
      'zk.capability': null,
      'account.balance': { chain: 'evm', address: '0x0000000000000000000000000000000000000001', balance: '1000000000000000000' },
      'tx.estimate': {
        chain: 'evm',
        from: '0x0000000000000000000000000000000000000001',
        feeNative: '21000000000',
        gasLimit: '21000',
        decimals: 18,
        spendableBalance: '0',
        symbol: 'ETH',
      },
    });

    render(<App />);

    const [sendButton] = await screen.findAllByRole('button', { name: 'Send' });
    if (!sendButton) throw new Error('Expected a Send button.');
    await user.click(sendButton);
    await user.type(screen.getByPlaceholderText('Recipient address'), '0x1122334455667788990011223344556677889900');
    await user.type(screen.getByLabelText('Amount (ETH)'), '0.5');

    // Auto-estimate resolves (fee shows) but the spendable gate trips.
    expect(await screen.findByText(/Estimated fee: 21000000000 Gwei/)).toBeInTheDocument();
    expect(await screen.findByText(/Insufficient balance/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();
  });

  it('opens the export-key modal from the asset list and reveals the key', async () => {
    const user = userEvent.setup();
    useWallet.setState({ vaultState: 'unlocked', accounts: [ACCOUNTS[0]!] });
    installResponder({
      'vault.status': { state: 'unlocked', unlockedUntil: Date.now() + 60_000 },
      'zk.capability': null,
      'account.exportKey': {
        privateKey: '0xdeadbeef',
        address: '0x0000000000000000000000000000000000000001',
      },
    });

    render(<App />);

    await user.click(await screen.findByRole('button', { name: 'Export evm private key' }));
    expect(screen.getByText(/Reveal the private key/)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Export private key' }));

    expect(await screen.findByText('0xdeadbeef')).toBeInTheDocument();
  });

  it('sends a Stellar transfer with the memo attached to the wire payload', async () => {
    const user = userEvent.setup();
    const stellar = ACCOUNTS[2]!;
    const sent: Array<{ kind: string; payload: Record<string, unknown> }> = [];

    const responder = buildResponder({
      'vault.status': { state: 'unlocked', unlockedUntil: Date.now() + 60_000 },
      'zk.capability': null,
      'account.balance': { chain: 'stellar', address: stellar.address, balance: '100000000' },
      'tx.estimate': {
        chain: 'stellar',
        from: stellar.address,
        feeNative: '100',
        gasLimit: '1',
        decimals: 7,
        spendableBalance: '100000000',
        symbol: 'XLM',
      },
      'tx.transfer': {
        chain: 'stellar',
        from: stellar.address,
        to: 'recipient',
        amountNative: '15000000',
        hash: 'abc123',
        decimals: 7,
      },
    });
    // Wrap the responder to capture outgoing tx.transfer payloads.
    vi.mocked(chrome.runtime.sendMessage).mockImplementation((...args: unknown[]) => {
      const message = (args.length >= 2 ? args[1] : args[0]) as Incoming;
      if (message.kind === 'tx.transfer') {
        sent.push(message as { kind: string; payload: Record<string, unknown> });
      }
      return responder(message) as never;
    });

    useWallet.setState({ vaultState: 'unlocked', accounts: [stellar] });
    render(<App />);

    const [sendButton] = await screen.findAllByRole('button', { name: 'Send' });
    if (!sendButton) throw new Error('Expected a Send button.');
    await user.click(sendButton);

    await user.type(screen.getByPlaceholderText('Recipient address'), stellar.address);
    await user.type(screen.getByLabelText('Amount (XLM)'), '1.5');
    await user.type(screen.getByLabelText('Memo'), 'order-42');

    // Wait for the debounced estimate so the CTA reflects the real gate.
    await screen.findByText(/Estimated fee: 100 stroops/);
    await user.click(screen.getByRole('button', { name: 'Send' }));

    expect(await screen.findByText(/Sent!/)).toBeInTheDocument();

    // The memo the user typed must actually be on the wire — not collected
    // and dropped.
    const transfer = sent.at(-1);
    expect(transfer).toBeDefined();
    expect(transfer?.payload).toMatchObject({
      chain: 'stellar',
      amount: '1.5',
      memo: 'order-42',
    });
  });

  it('sends a private Stellar payment with private:true on the wire and no memo', async () => {
    const user = userEvent.setup();
    const stellar = ACCOUNTS[2]!;
    // A full-length valid strkey so the recipient meta lookup fires.
    const recipient = 'G' + 'A'.repeat(55);
    const oneTimeAddress = 'G' + 'B'.repeat(55);
    const sent: Array<{ kind: string; payload: Record<string, unknown> }> = [];

    const responder = buildResponder({
      'vault.status': { state: 'unlocked', unlockedUntil: Date.now() + 60_000 },
      'zk.capability': null,
      'account.balance': { chain: 'stellar', address: stellar.address, balance: '100000000' },
      'stellar.stealth.meta': { spendPub: 'ab'.repeat(32), viewPub: 'cd'.repeat(32) },
      'tx.estimate': {
        chain: 'stellar',
        from: stellar.address,
        feeNative: '100',
        gasLimit: '1',
        decimals: 7,
        spendableBalance: '100000000',
        symbol: 'XLM',
      },
      'tx.transfer': {
        chain: 'stellar',
        from: stellar.address,
        to: oneTimeAddress,
        amountNative: '15000000',
        hash: 'abc123',
        decimals: 7,
        private: true,
      },
    });
    vi.mocked(chrome.runtime.sendMessage).mockImplementation((...args: unknown[]) => {
      const message = (args.length >= 2 ? args[1] : args[0]) as Incoming;
      if (message.kind === 'tx.transfer') {
        sent.push(message as { kind: string; payload: Record<string, unknown> });
      }
      return responder(message) as never;
    });

    useWallet.setState({ vaultState: 'unlocked', accounts: [stellar] });
    render(<App />);

    const [sendButton] = await screen.findAllByRole('button', { name: 'Send' });
    if (!sendButton) throw new Error('Expected a Send button.');
    await user.click(sendButton);

    await user.type(screen.getByPlaceholderText('Recipient address'), recipient);
    await user.type(screen.getByLabelText('Amount (XLM)'), '1.5');

    // Flip the privacy switch on.
    await user.click(screen.getByRole('switch', { name: 'Private payment' }));

    // The memo input disappears — MEMO_HASH carries the announcement instead.
    expect(screen.queryByLabelText('Memo')).not.toBeInTheDocument();

    // The recipient lookup resolves and says the recipient accepts privacy.
    expect(
      await screen.findByText(/Recipient accepts private payments/),
    ).toBeInTheDocument();

    await screen.findByText(/Estimated fee: 100 stroops/);
    await user.click(screen.getByRole('button', { name: 'Send' }));

    expect(await screen.findByText(/Sent!/)).toBeInTheDocument();

    // The private flag must actually be on the wire.
    const transfer = sent.at(-1);
    expect(transfer).toBeDefined();
    expect(transfer?.payload).toMatchObject({
      chain: 'stellar',
      amount: '1.5',
      private: true,
    });
    expect(transfer?.payload).not.toHaveProperty('memo');
  });

  it('renders the real balance — never the screenshot placeholder figures', async () => {
    useWallet.setState({ vaultState: 'unlocked', accounts: [ACCOUNTS[2]!] });
    installResponder({
      'vault.status': { state: 'unlocked', unlockedUntil: Date.now() + 60_000 },
      'zk.capability': null,
      'account.balance': { chain: 'stellar', address: ACCOUNTS[2]!.address, balance: '0' },
    });

    render(<App />);

    expect(await screen.findByText('Portfolio')).toBeInTheDocument();

    // The fabricated screenshot figures must never appear, even at zero balance.
    expect(screen.queryByText(/9469/)).not.toBeInTheDocument();
    expect(screen.queryByText(/1,893/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Live price/)).not.toBeInTheDocument();
    expect(screen.queryByText(/-6\.41%/)).not.toBeInTheDocument();
    expect(screen.queryByText(/\.\.\. pXLM/)).not.toBeInTheDocument();

    // A zero balance renders as a real zero.
    expect(await screen.findByText('0')).toBeInTheDocument();
  });

  it('labels incoming activity as RECEIVED with a positive amount', async () => {    const stellar = ACCOUNTS[2]!;
    const incoming = {
      hash: 'tx-in-1',
      chain: 'stellar',
      block: 1,
      timestamp: '2026-08-12T00:00:00Z',
      from: 'GDIFFERENTFROMADDRESS1111111111111111111111111111111111',
      to: stellar.address,
      amount: '15000000', // 1.5 XLM
      fee: '',
      status: 'confirmed',
    };

    vi.mocked(chrome.runtime.sendMessage).mockImplementation((...args: unknown[]) => {
      const message = (args.length >= 2 ? args[1] : args[0]) as Incoming;
      if (message.kind === 'vault.status') {
        return Promise.resolve({
          id: uuid(),
          ok: true,
          data: { state: 'unlocked', unlockedUntil: Date.now() + 60_000 },
        }) as never;
      }
      if (message.kind === 'zk.capability') {
        return Promise.resolve({ id: uuid(), ok: true, data: null }) as never;
      }
      if (message.kind === 'indexer.history') {
        return Promise.resolve({
          id: uuid(),
          ok: true,
          data: { transactions: [incoming], nextCursor: null, source: 'remote' },
        }) as never;
      }
      return Promise.resolve({ id: uuid(), ok: true, data: undefined }) as never;
    });

    useWallet.setState({ vaultState: 'unlocked', accounts: [stellar] });
    render(<App />);

    // Incoming payments render as credits, not debits.
    expect(await screen.findByText(/RECEIVED · STELLAR/)).toBeInTheDocument();
    expect(screen.getByText('+ 1.5 XLM')).toBeInTheDocument();
    expect(screen.queryByText(/SENT · STELLAR/)).not.toBeInTheDocument();
  });

  it('keeps the selected network when navigating away and back', async () => {
    const user = userEvent.setup();
    useWallet.setState({
      vaultState: 'unlocked',
      accounts: ACCOUNTS,
      networks: NETWORK_SUMMARIES,
      selectedNetworks: {
        stellar: 'stellar:testnet',
        evm: 'evm:sepolia',
        solana: 'solana:devnet',
      },
    });
    installResponder({
      'vault.status': { state: 'unlocked', unlockedUntil: Date.now() + 60_000 },
      'zk.capability': null,
      'networks.list': NETWORK_SUMMARIES,
      'networks.selected': {
        stellar: 'stellar:testnet',
        evm: 'evm:sepolia',
        solana: 'solana:devnet',
      },
      'networks.select': { ok: true },
      'account.balance': { chain: 'stellar', address: 'STELLAR-ADDR', balance: '10000000' },
    });

    render(<App />);

    // The dashboard defaults to the first account (EVM) on Sepolia.
    expect(await screen.findByText('Portfolio')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Select network, current SEPOLIA/ })).toBeInTheDocument();

    // Shift the network to Stellar via the selector: the menu lists every
    // registry network; clicking one both persists the selection (store +
    // background) and moves the dashboard to that chain.
    await user.click(screen.getByRole('button', { name: /Select network, current SEPOLIA/ }));
    await user.click(screen.getByRole('menuitemradio', { name: /Stellar Testnet/ }));

    // The banner now shows the Stellar network.
    expect(
      await screen.findByRole('button', { name: /Select network, current STELLAR TESTNET/ }),
    ).toBeInTheDocument();

    // Navigate to the send form and back — the selection must survive the
    // remount instead of snapping back to EVM.
    const [sendButton] = screen.getAllByRole('button', { name: 'Send' });
    if (!sendButton) throw new Error('Expected a Send button.');
    await user.click(sendButton);
    expect(await screen.findByText(/Send from/)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Back' }));

    expect(await screen.findByText('Portfolio')).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /Select network, current STELLAR TESTNET/ }),
    ).toBeInTheDocument();
  });

  it('switches to a mainnet network through the selector and warns', async () => {
    const user = userEvent.setup();
    useWallet.setState({
      vaultState: 'unlocked',
      accounts: ACCOUNTS,
      networks: NETWORK_SUMMARIES,
      selectedNetworks: {
        stellar: 'stellar:testnet',
        evm: 'evm:sepolia',
        solana: 'solana:devnet',
      },
    });
    installResponder({
      'vault.status': { state: 'unlocked', unlockedUntil: Date.now() + 60_000 },
      'zk.capability': null,
      'networks.list': NETWORK_SUMMARIES,
      'networks.selected': {
        stellar: 'stellar:testnet',
        evm: 'evm:sepolia',
        solana: 'solana:devnet',
      },
      'networks.select': { ok: true },
      'account.balance': { chain: 'stellar', address: 'STELLAR-ADDR', balance: '10000000' },
    });

    render(<App />);
    expect(await screen.findByText('Portfolio')).toBeInTheDocument();

    // Move to the Stellar chain first (dashboard defaults to the EVM card),
    // then switch Stellar from testnet to MAINNET: the banner flips from the
    // testnet warning to the real-funds warning.
    await user.click(screen.getByRole('button', { name: /Select network, current SEPOLIA/ }));
    await user.click(screen.getByRole('menuitemradio', { name: /Stellar Testnet/ }));
    expect(
      await screen.findByRole('button', { name: /Select network, current STELLAR TESTNET/ }),
    ).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /Select network, current STELLAR TESTNET/ }));
    await user.click(screen.getByRole('menuitemradio', { name: /Stellar Mainnet/ }));

    expect(
      await screen.findByRole('button', { name: /Select network, current STELLAR MAINNET/ }),
    ).toBeInTheDocument();
    expect(await screen.findByText(/REAL funds move on this network/)).toBeInTheDocument();
  });
});

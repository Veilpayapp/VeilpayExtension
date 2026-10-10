import { useEffect, useState, type JSX } from 'react';
import { Glyph } from '@/ui/components/Glyph';
import { t } from '@/i18n';
import { useWallet, type AccountView } from '@/ui/store/useWallet';
import { ExportKeyModal } from '@/ui/components/ExportKeyModal';
import { AddTokenModal } from '@/ui/components/AddTokenModal';
import { baseToDecimal, nativeDecimalsFor } from '@/ui/lib/format';
import type { ChainId } from '@/core/messaging/protocol';
import type { NetworkSummary } from '@/core/messaging/protocol';
import type { IndexerTx } from '@/core/chains/indexer-service';

/** Resolves the selected network summary for a chain (or a safe fallback). */
export function networkFor(
  chain: ChainId,
  networks: NetworkSummary[],
  selected: Partial<Record<ChainId, string>>,
): NetworkSummary | undefined {
  const id = selected[chain];
  return networks.find((n) => n.chain === chain && n.id === id);
}

/**
 * Display label for the active network on a chain: the selected network's
 * name when known, else the chain's default (testnet) label.
 */
export function networkLabel(
  chain: ChainId,
  networks: NetworkSummary[],
  selected: Partial<Record<ChainId, string>>,
): string {
  return networkFor(chain, networks, selected)?.name ?? `${chain} Testnet`;
}

/**
 * Display metadata per chain, matching the tactical mobile design.
 *
 * Deliberately carries no price or 24h-change data: the extension holds no
 * market-data host permission, so any "live price" shown here would be
 * invented. Balances are rendered in native units only.
 */
const CHAIN_META: Record<
  string,
  { label: string; symbol: string; initial: string; chip: string }
> = {
  stellar: {
    label: 'XLM',
    symbol: 'XLM',
    initial: '●',
    chip: 'bg-surface-800 border border-surface-700 text-accent-500',
  },
  evm: {
    label: 'Ethereum',
    symbol: 'ETH',
    initial: 'Ξ',
    chip: 'bg-gradient-to-br from-[#627EEA] to-[#4A5FC7] text-white',
  },
  solana: {
    label: 'Solana',
    symbol: 'SOL',
    initial: 'S',
    chip: 'bg-gradient-to-br from-[#9945FF] to-[#14F195] text-surface-900',
  },
};

function metaFor(chain: string) {
  return (
    CHAIN_META[chain] ?? {
      label: chain.toUpperCase(),
      symbol: chain.toUpperCase(),
      initial: chain.charAt(0).toUpperCase(),
      chip: 'bg-surface-700 text-accent-500',
    }
  );
}

function formatTime(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleString(undefined, {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return iso;
  }
}

/**
 * Whether a transaction moved funds INTO one of the wallet's own addresses.
 * `IndexerTx.amount` is unsigned, so direction comes from comparing `to`
 * (and `from`, for self-transfers) against the account list.
 */
function isIncoming(tx: IndexerTx, addresses: Set<string>): boolean {
  return addresses.has(tx.to) && !addresses.has(tx.from);
}

export function Dashboard({
  accounts,
  onSend,
  onReceive,
  onImport,
  onLock,
  onScan,
  onSelectTx,
  onSeeAllActivity,
}: {
  accounts: AccountView[];
  onSend: (idx: number) => void;
  onReceive: (idx: number) => void;
  onImport: () => void;
  onLock: () => void;
  onScan?: () => void;
  onSelectTx?: (tx: IndexerTx) => void;
  onSeeAllActivity?: () => void;
}): JSX.Element {
  const {
    balances,
    loadAllBalances,
    loadHistory,
    requestFaucet,
    selectedAccountIdx,
    setSelectedAccountIdx,
    networks,
    selectedNetworks,
    selectNetwork,
    customTokens,
    tokenBalances,
    removeToken,
  } = useWallet();
  const [txs, setTxs] = useState<IndexerTx[]>([]);
  const [txLoading, setTxLoading] = useState(false);
  const [exportAccount, setExportAccount] = useState<AccountView | null>(null);
  const [showBalance, setShowBalance] = useState(true);
  const [faucetLoading, setFaucetLoading] = useState(false);
  const [faucetMessage, setFaucetMessage] = useState<string | null>(null);
  const [networkMenuOpen, setNetworkMenuOpen] = useState(false);
  const [addTokenChain, setAddTokenChain] = useState<ChainId | null>(null);

  // Store-backed selection: navigating to send/receive and back keeps the
  // user's chosen network (the previous local state reset to EVM on every
  // remount — the "shifts network, clicks back, lands on EVM" bug). The
  // selection is ALSO persisted to chrome.storage.session (see useWallet),
  // so a closed-and-reopened popup shows the same network.
  const activeAccountIdx = Math.min(selectedAccountIdx, Math.max(0, accounts.length - 1));
  const activeAccount = accounts[activeAccountIdx] ?? accounts[0];
  const activeChain = activeAccount?.chain ?? 'stellar';
  const activeMeta = metaFor(activeChain);
  const activeNetwork = networkFor(activeChain, networks, selectedNetworks);
  const activeNetworkName = (
    activeNetwork?.name ?? `${activeChain === 'stellar' ? 'Stellar' : activeChain} Testnet`
  ).toUpperCase();

  // Which network the dashboard's active chain is on — drives the effect
  // below so a network switch refetches balances AND history (both are
  // network-scoped: a Sepolia history list is not an Ethereum one).
  const activeNetworkId = selectedNetworks[activeChain];

  useEffect(() => {
    void loadAllBalances();
    if (accounts.length > 0) {
      setTxLoading(true);
      void Promise.allSettled(
        accounts.map((acc) => loadHistory(acc.chain, acc.address, 5)),
      ).then((results) => {
        const all: IndexerTx[] = [];
        for (const r of results) {
          if (r.status === 'fulfilled') {
            all.push(...r.value.transactions);
          }
        }
        all.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
        setTxs(all.slice(0, 5));
        setTxLoading(false);
      });
    }
  }, [accounts, loadAllBalances, loadHistory, activeNetworkId]);

  /** Switches to a network: persists the network selection AND moves the
   *  dashboard to that chain's account, so banner/balances/history all agree. */
  const handleSelectNetwork = async (chain: ChainId, networkId: string) => {
    const idx = accounts.findIndex((a) => a.chain === chain);
    if (idx >= 0) setSelectedAccountIdx(idx);
    setNetworkMenuOpen(false);
    await selectNetwork(chain, networkId);
  };

  const currentActiveBal = activeAccount
    ? balances[`${activeAccount.chain}:${activeAccount.address}`] ?? 0n
    : 0n;

  // The REAL balance, formatted exactly (bigint math, never a float and never
  // a screenshot constant). A zero balance renders as a zero.
  const displayCrypto = baseToDecimal(currentActiveBal, nativeDecimalsFor(activeChain), 7);
  const ownedAddresses = new Set(accounts.map((acc) => acc.address));

  const handleFaucet = async () => {
    if (!activeAccount) return;
    setFaucetLoading(true);
    setFaucetMessage(null);
    try {
      const res = await requestFaucet(activeAccount.chain, activeAccount.address);
      if (res.ok) {
        setFaucetMessage('Funds requested!');
        void loadAllBalances();
      } else {
        setFaucetMessage(res.error ?? 'Faucet request failed');
      }
    } catch {
      setFaucetMessage('Faucet failed');
    } finally {
      setFaucetLoading(false);
      setTimeout(() => setFaucetMessage(null), 3000);
    }
  };

  // Faucets only exist on testnets; the button is hidden (not disabled with a
  // mystery) when the active network has none.
  const faucetAvailable = activeNetwork?.faucet ?? false;

  return (
    <div
      // Entrance animation replays on every view switch back to the dashboard
      // (the component remounts when send/receive unmount it). Compositor-only
      // (opacity/translate) per the motion rules.
      className="flex flex-col gap-3 text-content-primary animate-fade-in-up"
    >
      {/* Hidden landmark for testing compatibility */}
      <h2 className="sr-only">Portfolio</h2>

      {/* 1. Network Selector Banner — the ACTIVE network, not just the chain.
          Clicking opens the full registry: every chain's mainnets and
          testnets plus the user's custom RPCs. Selection persists in the
          background, so balances, sends, and dapp requests all follow it. */}
      <div className="relative">
        <button
          type="button"
          onClick={() => setNetworkMenuOpen((v) => !v)}
          aria-expanded={networkMenuOpen}
          aria-label={`Select network, current ${activeNetworkName}`}
          className="flex w-full items-center justify-between rounded-xl border border-surface-700/80 bg-surface-800/80 px-3.5 py-2.5 text-left transition-colors hover:border-surface-600 active:scale-[0.99]"
        >
          <div>
            <div className="font-mono text-[10px] tracking-wider text-content-tertiary uppercase">
              [ {activeMeta.symbol} · {activeNetwork?.kind === 'mainnet' ? 'MAINNET' : 'TESTNET'} ]
            </div>
            <div className="mt-0.5 font-display text-sm font-bold tracking-wider text-accent-500 uppercase">
              {activeNetworkName}
            </div>
          </div>
          <Glyph
            name="chevron-down"
            className={`h-4 w-4 text-accent-500 transition-transform duration-base ease-smooth ${networkMenuOpen ? 'rotate-180' : ''}`}
          />
        </button>

        {networkMenuOpen && (
          <div
            className="absolute left-0 right-0 top-full z-30 mt-1 max-h-[26rem] overflow-y-auto rounded-xl border border-surface-600 bg-surface-800 p-1.5 shadow-raised animate-pop-in"
            role="menu"
            aria-label="Networks"
          >
            {(['stellar', 'evm', 'solana'] as const).map((chain) => {
              const chainNetworks = networks.filter((n) => n.chain === chain);
              if (chainNetworks.length === 0) return null;
              const chainAccount = accounts.find((a) => a.chain === chain);
              return (
                <div key={chain} className="mb-1">
                  <div className="px-2 pt-1 pb-0.5 font-mono text-[9px] font-bold tracking-widest text-content-tertiary uppercase">
                    {chain === 'stellar' ? 'Stellar' : chain === 'evm' ? 'EVM networks' : 'Solana'}
                    {chainAccount === undefined ? ' · no account' : ''}
                  </div>
                  {chainNetworks.map((n, i) => {
                    const isActive = selectedNetworks[chain] === n.id;
                    return (
                      <button
                        key={n.id}
                        type="button"
                        role="menuitemradio"
                        aria-checked={isActive}
                        onClick={() => void handleSelectNetwork(chain, n.id)}
                        style={{ animationDelay: `${Math.min(i * 30, 240)}ms` }}
                        className={`flex w-full animate-fade-in items-center justify-between rounded-lg px-3 py-2 text-xs font-mono transition-colors ${
                          isActive
                            ? 'bg-accent-500/15 font-semibold text-accent-400'
                            : 'text-content-secondary hover:bg-surface-700'
                        }`}
                      >
                        <span className="flex items-center gap-2">
                          {n.id.startsWith('custom:') && (
                            <Glyph name="settings" className="h-3 w-3 text-content-tertiary" />
                          )}
                          <span>{n.name}</span>
                          <span
                            className={`rounded-full border px-1.5 py-0.5 text-[8px] font-bold tracking-wider ${
                              n.kind === 'mainnet'
                                ? 'border-success/40 text-success'
                                : 'border-accent-500/40 text-accent-400'
                            }`}
                          >
                            {n.kind === 'mainnet' ? 'MAINNET' : 'TESTNET'}
                          </span>
                        </span>
                        <span className="text-[10px] text-content-tertiary">{n.symbol}</span>
                      </button>
                    );
                  })}
                </div>
              );
            })}
            {networks.length === 0 && (
              <p className="px-3 py-2 font-mono text-xs text-content-tertiary">
                Loading networks…
              </p>
            )}
          </div>
        )}
      </div>

      {/* 2. Total Balance Card (matches Screenshot 1) */}
      <section className="relative rounded-2xl border border-surface-700/80 bg-surface-800/80 p-4 shadow-raised">
        {/* Top row: Label + Eye toggle */}
        <div className="flex items-center justify-between">
          <span className="font-mono text-xs text-content-tertiary">Total balance</span>
          <button
            type="button"
            onClick={() => setShowBalance((s) => !s)}
            aria-label={showBalance ? 'Hide balance' : 'Show balance'}
            className="text-content-tertiary hover:text-content-primary p-0.5 transition-colors"
          >
            <Glyph name={showBalance ? 'eye' : 'eye-off'} className="h-4 w-4" />
          </button>
        </div>

        {/* Large Balance Display — the real on-chain balance, native units.
            No USD figure is shown: there is no market-data source, so any
            dollar value here would be fabricated. */}
        <div className="mt-1 flex items-baseline justify-between">
          <div className="font-display text-3xl font-extrabold tracking-tight text-white">
            {showBalance ? displayCrypto : '••••••••'}
          </div>
        </div>

        {/* Sub-balance and Wallet Lock Badge */}
        <div className="mt-0.5 flex items-center justify-between">
          <span className="font-mono text-xs text-content-secondary">
            {showBalance ? `${activeMeta.symbol} · ${activeNetworkName}` : '••••••••'}
          </span>

          <button
            type="button"
            onClick={onLock}
            className="flex items-center gap-1.5 rounded-lg border border-accent-500/70 bg-accent-500/10 px-2.5 py-1 font-mono text-xs font-semibold text-accent-500 transition-colors hover:bg-accent-500/20 active:scale-95"
          >
            <Glyph name="lock" className="h-3 w-3" />
            <span>Wallet</span>
          </button>
        </div>
      </section>

      {/* 3. Four Quick Action Square Buttons (matches Screenshot 1) */}
      <div className="grid grid-cols-4 gap-2.5 py-1">
        {/* SEND */}
        <button
          type="button"
          onClick={() => onSend(activeAccountIdx)}
          aria-label="Send"
          className="flex aspect-square flex-col items-center justify-center gap-1.5 rounded-xl border border-surface-700 bg-surface-800/90 p-2 text-content-primary transition-all duration-base hover:-translate-y-0.5 hover:border-accent-500/50 hover:bg-surface-700 active:scale-95"
        >
          <Glyph name="send" className="h-4 w-4 rotate-[-45deg] text-content-primary" />
          <span className="font-mono text-[10px] font-bold tracking-wider text-content-secondary uppercase">
            SEND
          </span>
        </button>

        {/* FAUCET — testnet networks only */}
        {faucetAvailable && (
          <button
            type="button"
            onClick={handleFaucet}
            disabled={faucetLoading}
            aria-label="Faucet"
            className="flex aspect-square flex-col items-center justify-center gap-1.5 rounded-xl border border-surface-700 bg-surface-800/90 p-2 text-content-primary transition-all duration-base hover:-translate-y-0.5 hover:border-accent-500/50 hover:bg-surface-700 active:scale-95 disabled:opacity-50"
          >
            <Glyph name="droplet" className={`h-4 w-4 text-content-primary ${faucetLoading ? 'animate-bounce' : ''}`} />
            <span className="font-mono text-[10px] font-bold tracking-wider text-content-secondary uppercase">
              FAUCET
            </span>
          </button>
        )}
        {!faucetAvailable && (
          <button
            type="button"
            onClick={() => onReceive(activeAccountIdx)}
            aria-label="History"
            className="flex aspect-square flex-col items-center justify-center gap-1.5 rounded-xl border border-surface-700 bg-surface-800/90 p-2 text-content-primary transition-all duration-base hover:-translate-y-0.5 hover:border-accent-500/50 hover:bg-surface-700 active:scale-95"
          >
            <Glyph name="activity" className="h-4 w-4 text-content-primary" />
            <span className="font-mono text-[10px] font-bold tracking-wider text-content-secondary uppercase">
              ACTIVITY
            </span>
          </button>
        )}

        {/* SCAN — Highlight Solid Amber Block! */}
        <button
          type="button"
          onClick={onScan}
          aria-label="Scan"
          className="flex aspect-square flex-col items-center justify-center gap-1 rounded-xl bg-accent-500 p-2 text-surface-900 shadow-[0_4px_14px_-2px_rgba(245,158,11,0.55)] transition-all duration-base hover:-translate-y-0.5 hover:brightness-105 active:scale-95"
        >
          <Glyph name="scan" className="h-5 w-5 stroke-[2] text-surface-900" />
          <span className="font-mono text-[10px] font-black tracking-wider text-surface-900 uppercase">
            SCAN
          </span>
        </button>

        {/* RECEIVE */}
        <button
          type="button"
          onClick={() => onReceive(activeAccountIdx)}
          aria-label="Receive"
          className="flex aspect-square flex-col items-center justify-center gap-1.5 rounded-xl border border-surface-700 bg-surface-800/90 p-2 text-content-primary transition-all duration-base hover:-translate-y-0.5 hover:border-accent-500/50 hover:bg-surface-700 active:scale-95"
        >
          <Glyph name="receive" className="h-4 w-4 text-content-primary" />
          <span className="font-mono text-[10px] font-bold tracking-wider text-content-secondary uppercase">
            RECEIVE
          </span>
        </button>
      </div>

      {faucetMessage && (
        <div className="rounded-lg bg-surface-700/80 px-3 py-1.5 text-center font-mono text-xs text-accent-400 animate-fade-in">
          {faucetMessage}
        </div>
      )}

      {/* 4. FIAT GATEWAY Card (matches Screenshot 1).
            The aggregator backend does not exist yet (fiat.veilpay.org has no
            DNS record), so this is an honest non-interactive "coming soon"
            tile — no fake fees, no dead link. */}
      <div
        aria-disabled="true"
        className="flex w-full items-center justify-between rounded-xl border border-surface-700/80 bg-surface-800/80 p-3.5 opacity-75"
      >
        <div className="flex items-center gap-3">
          <Glyph name="card" className="h-5 w-5 text-accent-500" />
          <div>
            <div className="font-display text-xs font-bold tracking-wider text-accent-500 uppercase">
              FIAT GATEWAY
            </div>
            <div className="mt-0.5 font-mono text-[10px] text-content-secondary">
              Buy/Sell crypto via Veilpay Aggregator
            </div>
          </div>
        </div>
        <span className="rounded-full border border-surface-600 bg-surface-900 px-2 py-0.5 font-mono text-[9px] font-bold tracking-wider text-content-tertiary uppercase">
          Coming soon
        </span>
      </div>

      {/* 5. Privacy Section (matches Screenshot 1).
            Stealth-address payments (core/privacy/stealth.ts) are a real
            cryptographic foundation but are NOT wired into the send path yet.
            Shown as coming soon — never a fabricated private balance. */}
      <section className="flex flex-col gap-2">
        <h3 className="font-display text-sm font-bold text-white">Privacy</h3>
        <div className="flex items-center justify-between rounded-xl border border-surface-700/80 bg-surface-800/80 p-3">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-lg border border-accent-500/60 bg-surface-900 text-accent-500">
              <span className="text-base font-bold">◇</span>
            </div>
            <div>
              <div className="flex items-center gap-2">
                <span className="font-display text-sm font-bold text-white">pXLM</span>
                <span className="font-mono text-[9px] font-semibold tracking-wider text-content-tertiary uppercase">
                  PRIVATE XLM
                </span>
              </div>
              <div className="mt-0.5 font-mono text-[10px] text-content-secondary">
                Shielded transfers · Testnet
              </div>
            </div>
          </div>

          <div className="text-right">
            <div className="font-mono text-[10px] font-semibold text-content-tertiary uppercase tracking-wider">
              Coming soon
            </div>
            <div className="mt-0.5 flex items-center justify-end gap-1 font-mono text-[10px] font-bold tracking-wider text-accent-500">
              <Glyph name="lock" className="h-2.5 w-2.5" />
              <span>PRIVATE</span>
            </div>
          </div>
        </div>
      </section>

      {/* 6. Assets Section (matches Screenshot 1) */}
      <section className="flex flex-col gap-2">
        <div className="flex items-center justify-between">
          <h3 className="font-display text-sm font-bold text-white">Assets</h3>
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={() => onImport}
              className="font-mono text-[11px] text-accent-500 hover:underline"
            >
              Manage
            </button>
            {/* MetaMask-style add-token: opens the chain-aware modal and the
                token lands in the registry (and the send form's picker). */}
            <button
              type="button"
              onClick={() => setAddTokenChain(activeChain)}
              aria-label={`Add token on ${activeChain}`}
              className="flex items-center gap-1 font-mono text-[11px] font-semibold text-accent-500 hover:underline"
            >
              <Glyph name="plus" className="h-3 w-3" />
              Add token
            </button>
          </div>
        </div>

        {accounts.length === 0 ? (
          <p className="font-mono text-xs text-content-tertiary">
            No accounts. Import or create a wallet.
          </p>
        ) : (
          <ul className="flex flex-col gap-2">
            {accounts.map((acc, i) => {
              const key = `${acc.chain}:${acc.address}` as const;
              const bal = balances[key] ?? 0n;
              const meta = metaFor(acc.chain);
              const cryptoAmt = baseToDecimal(bal, nativeDecimalsFor(acc.chain), 4);
              const networkName = networkLabel(acc.chain, networks, selectedNetworks);

              return (
                <li
                  key={key}
                  className="flex items-center justify-between rounded-xl border border-surface-700/80 bg-surface-800/80 p-3 transition-colors hover:border-surface-600"
                >
                  <div className="flex items-center gap-3">
                    <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-surface-700">
                      <span className="text-xs font-bold text-accent-500">●</span>
                    </div>
                    <div>
                      <div className="font-display text-sm font-bold text-white">{meta.label}</div>
                      <div className="font-mono text-[10px] text-content-tertiary">
                        {meta.symbol} · {networkName}
                      </div>
                    </div>
                  </div>

                  <div className="flex items-center gap-3">
                    <div className="text-right">
                      <div className="font-mono text-xs font-bold text-white">
                        {showBalance ? `${cryptoAmt} ${meta.symbol}` : '••••••••'}
                      </div>
                    </div>

                    {/* Action buttons preserved for tests and operations */}
                    <div className="flex items-center gap-1">
                      <button
                        type="button"
                        onClick={() => onSend(i)}
                        aria-label="Send"
                        className="rounded-lg bg-surface-700 px-2 py-1 font-mono text-[10px] font-semibold text-content-primary hover:bg-surface-600"
                      >
                        Send
                      </button>
                      <button
                        type="button"
                        onClick={() => onReceive(i)}
                        aria-label="Receive"
                        className="rounded-lg bg-surface-700 px-2 py-1 font-mono text-[10px] font-semibold text-content-primary hover:bg-surface-600"
                      >
                        Receive
                      </button>
                      <button
                        type="button"
                        onClick={() => setExportAccount(acc)}
                        aria-label={`${t('common.export')} ${acc.chain} private key`}
                        title={`${t('common.export')} ${acc.chain} private key`}
                        className="rounded-lg bg-surface-700 p-1 text-content-tertiary hover:bg-surface-600 hover:text-content-primary"
                      >
                        <Glyph name="key" className="h-3 w-3" />
                      </button>
                    </div>
                  </div>
                </li>
              );
            })}
            {/* Custom tokens — the MetaMask-style registry, per chain, with
                live base-unit balances from the background. */}
            {customTokens.map((token, idx) => {
              const acc = accounts.find((a) => a.chain === token.chain);
              if (acc === undefined) return null;
              const bal = tokenBalances[token.id] ?? 0n;
              const cryptoAmt = baseToDecimal(bal, token.decimals, 4);
              return (
                <li
                  key={token.id}
                  style={{ animationDelay: `${Math.min(idx * 40, 200)}ms` }}
                  className="flex animate-fade-in-up items-center justify-between rounded-xl border border-surface-700/60 bg-surface-800/60 p-3 transition-colors hover:border-surface-600"
                >
                  <div className="flex items-center gap-3">
                    <div className="flex h-10 w-10 items-center justify-center rounded-lg border border-accent-500/30 bg-surface-900">
                      <Glyph name="token" className="h-4 w-4 text-accent-500" />
                    </div>
                    <div>
                      <div className="font-display text-sm font-bold text-white">{token.symbol}</div>
                      <div className="max-w-[11rem] truncate font-mono text-[10px] text-content-tertiary">
                        {token.kind === 'stellar-issued'
                          ? `${token.code} · ${token.issuer!.slice(0, 8)}…`
                          : (token.address ?? '').slice(0, 12) + '…'}
                      </div>
                    </div>
                  </div>
                  <div className="flex items-center gap-3">
                    <div className="text-right font-mono text-xs font-bold text-white">
                      {showBalance ? `${cryptoAmt} ${token.symbol}` : '••••••••'}
                    </div>
                    <button
                      type="button"
                      onClick={() => void removeToken(token.id)}
                      aria-label={`Remove ${token.symbol}`}
                      title={`Remove ${token.symbol}`}
                      className="rounded-lg bg-surface-700 p-1 text-content-tertiary hover:bg-surface-600 hover:text-danger"
                    >
                      <Glyph name="x" className="h-3 w-3" />
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {/* 7. Activity Section (matches Screenshot 1) */}
      <section className="flex flex-col gap-2">
        <div className="flex items-center justify-between">
          <div className="flex items-baseline gap-1.5">
            <h3 className="font-display text-sm font-bold text-white">Activity</h3>
            <span className="sr-only">Recent Transactions</span>
          </div>
          <button
            type="button"
            onClick={onSeeAllActivity}
            className="font-mono text-xs font-semibold text-accent-500 hover:underline"
          >
            See all
          </button>
        </div>

        {txLoading ? (
          <ul className="flex flex-col gap-2" aria-busy="true">
            {[0, 1].map((i) => (
              <li
                key={i}
                className="relative h-12 overflow-hidden rounded-xl border border-surface-700/70 bg-surface-800/60"
              >
                <span className="absolute inset-0 -translate-x-full animate-shimmer bg-gradient-to-r from-transparent via-white/5 to-transparent" />
              </li>
            ))}
          </ul>
        ) : txs.length === 0 ? (
          <p className="font-mono text-xs text-content-tertiary">No recent transactions.</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {txs.map((tx, idx) => {
              // Direction is derived, not assumed: the indexer's amount is
              // unsigned, so "money left" vs "money arrived" is whether the
              // wallet's own address is the recipient.
              const incoming = isIncoming(tx, ownedAddresses);
              const sign = incoming ? '+' : '-';
              const amountText = `${sign} ${baseToDecimal(BigInt(tx.amount), nativeDecimalsFor(tx.chain), 4)} ${metaFor(tx.chain).symbol}`;
              return (
                <li
                  key={`${tx.hash}-${idx}`}
                  onClick={() => onSelectTx?.(tx)}
                  className="flex cursor-pointer items-center justify-between rounded-xl border border-surface-700/70 bg-surface-800/60 px-3 py-2.5 transition-colors hover:border-surface-600 active:scale-[0.99]"
                >
                  <div className="flex min-w-0 flex-1 flex-col">
                    <span className="inline-flex items-center gap-1.5 font-mono text-xs font-semibold text-content-primary">
                      {incoming ? 'RECEIVED' : 'SENT'} · {tx.chain.toUpperCase()}
                      {tx.status === 'confirmed' ? (
                        <Glyph name="check" className="h-3.5 w-3.5 text-success" />
                      ) : (
                        <Glyph name="spinner" className="h-3.5 w-3.5 text-accent-500" />
                      )}
                    </span>
                    <span className="truncate font-mono text-[10px] text-content-tertiary">
                      {tx.from.slice(0, 6)}… → {tx.to.slice(0, 6)}…
                    </span>
                  </div>

                  <div className="ml-2 flex shrink-0 flex-col items-end font-mono">
                    <span
                      className={`text-xs font-bold ${incoming ? 'text-success' : 'text-[#FF5A5A]'}`}
                    >
                      {amountText}
                    </span>
                    <span className="text-[10px] text-content-tertiary">
                      {formatTime(tx.timestamp)}
                    </span>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {/* Export Key Modal */}
      {exportAccount !== null && (
        <ExportKeyModal account={exportAccount} onClose={() => setExportAccount(null)} />
      )}

      {/* Add Token Modal — chain-aware (ERC-20 / SPL mint / Stellar trustline) */}
      {addTokenChain !== null && (
        <AddTokenModal chain={addTokenChain} onClose={() => setAddTokenChain(null)} />
      )}
    </div>
  );
}

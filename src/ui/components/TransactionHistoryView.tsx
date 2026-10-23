import { useEffect, useState } from 'react';
import type { ChainId } from '@/core/messaging/protocol';
import type { IndexerTx } from '@/core/chains/indexer-service';
import { useWallet } from '@/ui/store/useWallet';
import { Button } from '@/ui/components/Button';
import { Glyph } from '@/ui/components/Glyph';
import { EmptyState, ErrorState } from '@/ui/components/ErrorBoundary';

/**
 * Block-explorer URL for a transaction hash on a given chain (testnet).
 * Returns null when no explorer is known for the chain.
 */
export function explorerUrlFor(chain: ChainId, hash: string): string | null {
  switch (chain) {
    case 'evm':
      return `https://sepolia.etherscan.io/tx/${hash}`;
    case 'solana':
      return `https://explorer.solana.com/tx/${hash}?cluster=devnet`;
    case 'stellar':
      return `https://stellar.expert/explorer/testnet/tx/${hash}`;
    default:
      return null;
  }
}

/**
 * Serializes the visible transactions to CSV (RFC-4180-ish: quotes fields that
 * contain a comma, quote, or newline; doubles embedded quotes).
 */
export function transactionsToCsv(txs: IndexerTx[]): string {
  const escape = (value: string | number | undefined): string => {
    const s = value === undefined ? '' : String(value);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const header = ['chain', 'hash', 'status', 'timestamp', 'block', 'from', 'to', 'amount', 'fee'];
  const rows = txs.map((tx) =>
    [tx.chain, tx.hash, tx.status, tx.timestamp, tx.block, tx.from, tx.to, tx.amount, tx.fee]
      .map(escape)
      .join(','),
  );
  return [header.join(','), ...rows].join('\n');
}

function formatTimestamp(iso: string): string {
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

/** Native symbol + decimals per chain, for rendering indexer amounts. */
const AMOUNT_META: Record<string, { symbol: string; decimals: number }> = {
  evm: { symbol: 'ETH', decimals: 18 },
  solana: { symbol: 'SOL', decimals: 9 },
  stellar: { symbol: 'XLM', decimals: 7 },
};

/**
 * Renders a base-unit amount (decimal string from the indexer) as a short
 * human figure. Falls back to the raw string for an unknown chain rather than
 * guessing a scale and printing a wrong number.
 */
function formatAmount(amount: string, chain: string): string {
  const meta = AMOUNT_META[chain];
  if (meta === undefined) return amount;
  try {
    const value = Number(BigInt(amount)) / 10 ** meta.decimals;
    return `${value.toLocaleString(undefined, { maximumFractionDigits: 4 })} ${meta.symbol}`;
  } catch {
    return amount;
  }
}

/**
 * Transaction history view — sortable, filterable by chain, with a details
 * modal (block-explorer link) and CSV export of the visible rows.
 */
export function TransactionHistoryView() {
  const { accounts, loadHistory } = useWallet();
  const [txs, setTxs] = useState<IndexerTx[]>([]);
  const [filterChain, setFilterChain] = useState<ChainId | 'all'>('all');
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<IndexerTx | null>(null);
  const [source, setSource] = useState<'remote' | 'cache' | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      setIsLoading(true);
      setError(null);
      try {
        const all: IndexerTx[] = [];
        let anyCached = false;
        for (const acc of accounts) {
          const history = await loadHistory(acc.chain, acc.address, 20);
          if (history.source === 'cache') anyCached = true;
          for (const tx of history.transactions) {
            all.push(tx);
          }
        }
        // Sort by timestamp descending (ISO-8601 strings compare lexicographically).
        all.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
        if (!cancelled) {
          setTxs(all);
          setSource(anyCached ? 'cache' : 'remote');
        }
      } catch (cause) {
        if (!cancelled) {
          setError(cause instanceof Error ? cause.message : 'Could not load transaction history.');
        }
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    };
    void load();
    return () => { cancelled = true; };
  }, [accounts, loadHistory]);

  const filtered = filterChain === 'all' ? txs : txs.filter((tx) => tx.chain === filterChain);

  const handleExportCsv = () => {
    const csv = transactionsToCsv(filtered);
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = 'veilpay-transactions.csv';
    anchor.click();
    URL.revokeObjectURL(url);
  };

  if (isLoading) {
    return (
      <div className="flex flex-col gap-3">
        <h2 className="font-display text-lg font-semibold text-content-primary">
          Transaction History
        </h2>
        <div className="flex flex-col gap-2" aria-busy="true" aria-label="Loading transactions">
          {[0, 1, 2, 3].map((i) => (
            <div
              key={i}
              className="relative overflow-hidden rounded-2xl border border-surface-700/60 bg-surface-800/70 p-4"
            >
              <div className="h-3 w-20 rounded bg-surface-700" />
              <div className="mt-3 h-3 w-3/4 rounded bg-surface-700" />
              <div className="mt-3 h-3 w-1/3 rounded bg-surface-700" />
              <div className="absolute inset-0 -translate-x-full animate-shimmer bg-gradient-to-r from-transparent via-white/5 to-transparent" />
            </div>
          ))}
        </div>
      </div>
    );
  }

  if (error !== null) {
    return (
      <div className="flex flex-col gap-4">
        <h2 className="font-display text-lg font-semibold text-content-primary">Transaction History</h2>
        <ErrorState title="Load failed" message={error} onRetry={() => window.location.reload()} />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-baseline gap-2">
          <h2 className="font-display text-lg font-semibold text-content-primary">History</h2>
          <span className="font-body text-xs text-content-tertiary">
            {filtered.length} {filtered.length === 1 ? 'entry' : 'entries'}
          </span>
        </div>
        <Button variant="ghost" size="sm" onClick={handleExportCsv} disabled={filtered.length === 0}>
          Export CSV
        </Button>
      </div>

      <div className="flex items-center gap-1.5 overflow-x-auto pb-0.5">
        {(['all', 'evm', 'solana', 'stellar'] as const).map((c) => (
          <button
            key={c}
            type="button"
            aria-pressed={filterChain === c}
            className={`shrink-0 rounded-full px-3 py-1 font-body text-xs transition-colors ${
              filterChain === c
                ? 'bg-accent-500/15 font-semibold text-accent-400'
                : 'text-content-tertiary hover:bg-surface-700 hover:text-content-secondary'
            }`}
            onClick={() => setFilterChain(c)}
          >
            {c === 'all' ? 'All' : c.charAt(0).toUpperCase() + c.slice(1)}
          </button>
        ))}
        {source === 'cache' && (
          <span className="ml-auto shrink-0 font-body text-[10px] text-content-tertiary">
            cached
          </span>
        )}
      </div>

      {filtered.length === 0 ? (
        <EmptyState
          title="No transactions"
          message="No transactions found for the selected filter."
        />
      ) : (
        <div className="flex flex-col gap-2">
          {filtered.map((tx) => (
            <button
              key={tx.hash}
              type="button"
              className="group flex items-center gap-3 rounded-2xl border border-surface-700/60 bg-surface-800/70 p-3 text-left transition-colors hover:border-surface-600 hover:bg-surface-700/70"
              onClick={() => setSelected(tx)}
            >
              <span
                aria-hidden
                className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full ${
                  tx.status === 'failed'
                    ? 'bg-error/15 text-error'
                    : tx.status === 'pending'
                      ? 'bg-surface-700 text-content-secondary'
                      : 'bg-success/15 text-success'
                }`}
              >
                <Glyph
                  name={tx.status === 'failed' ? 'alert' : tx.status === 'pending' ? 'spinner' : 'check'}
                  className={`h-4 w-4 ${tx.status === 'pending' ? 'animate-spin' : ''}`}
                />
              </span>

              <div className="min-w-0 flex-1">
                <div className="flex items-baseline justify-between gap-2">
                  <span className="font-body text-sm font-semibold text-content-primary">
                    {tx.status === 'failed' ? 'Failed' : tx.status === 'pending' ? 'Pending' : 'Sent'}
                  </span>
                  <span className="shrink-0 font-mono text-xs text-content-secondary">
                    {formatAmount(tx.amount, tx.chain)}
                  </span>
                </div>
                <div className="mt-0.5 flex items-center justify-between gap-2">
                  <span className="truncate font-body text-[11px] text-content-tertiary">
                    {formatTimestamp(tx.timestamp)}
                  </span>
                  <Glyph
                    name="chevron-right"
                    className="h-3.5 w-3.5 shrink-0 text-content-tertiary transition-transform group-hover:translate-x-0.5"
                  />
                </div>
              </div>
            </button>
          ))}
        </div>
      )}

      {selected !== null && (
        <TransactionDetailsModal tx={selected} onClose={() => setSelected(null)} />
      )}
    </div>
  );
}

/**
 * Details modal for a single transaction: full fields plus a block-explorer link
 * for the chain. Clicking outside the card closes it (light dismiss).
 */
function TransactionDetailsModal({ tx, onClose }: { tx: IndexerTx; onClose: () => void }) {
  const url = explorerUrlFor(tx.chain, tx.hash);

  const row = (label: string, value: string) => (
    <div className="flex flex-col gap-0.5">
      <span className="font-body text-[10px] uppercase tracking-wide text-content-tertiary">
        {label}
      </span>
      <span className="font-mono text-xs text-content-primary break-all">{value}</span>
    </div>
  );

  return (
    <div
      className="fixed inset-0 z-50 flex animate-fade-in items-center justify-center bg-black/60 p-4 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-label="Transaction details"
      onClick={onClose}
    >
      <div
        className="w-full max-w-md animate-scale-in rounded-2xl border border-surface-600 bg-surface-800 p-4 shadow-raised"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-3">
          <h3 className="font-display text-base font-semibold text-content-primary">
            Transaction details
          </h3>
          <Button variant="ghost" size="sm" onClick={onClose} aria-label="Close">
            <Glyph name="x" className="h-4 w-4" />
          </Button>
        </div>

        <div className="flex flex-col gap-3">
          {row('Chain', tx.chain)}
          {row('Hash', tx.hash)}
          {row('Status', tx.status ?? 'completed')}
          {row('Timestamp', formatTimestamp(tx.timestamp))}
          {row('Block / slot', String(tx.block))}
          {row('From', tx.from)}
          {row('To', tx.to)}
          {row('Amount', tx.amount)}
          {row('Fee', tx.fee)}
        </div>

        {url !== null && (
          <div className="mt-4">
            <Button fullWidth variant="secondary" onClick={() => window.open(url, '_blank', 'noopener,noreferrer')}>
              <Glyph name="external" className="h-4 w-4" /> View on explorer
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}

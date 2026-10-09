import { useState, type JSX } from 'react';
import { Glyph } from '@/ui/components/Glyph';
import { explorerUrlFor } from '@/ui/components/TransactionHistoryView';
import type { ChainId } from '@/core/messaging/protocol';

export interface TransactionReceiptData {
  hash: string;
  chain: ChainId;
  from: string;
  to: string;
  /** Human-readable amount string. */
  amount: string;
  symbol: string;
  timestamp?: string;
  status?: 'completed' | 'pending' | 'failed';
  /**
   * Direction relative to THIS wallet: funds leaving ('sent') or arriving
   * ('received'). Derived by the caller from the account list — the indexer's
   * amount is unsigned. Defaults to 'sent' (the post-send receipt).
   */
  direction?: 'sent' | 'received';
  networkName?: string;
}

interface TransactionReceiptViewProps {
  receipt: TransactionReceiptData;
  onBack: () => void;
}

function truncateAddress(addr: string): string {
  if (!addr) return '';
  if (addr.length <= 16) return addr;
  return `${addr.slice(0, 8)}...${addr.slice(-6)}`;
}

function formatReceiptTimestamp(timestamp?: string): { date: string; time: string } {
  const d = timestamp ? new Date(timestamp) : new Date();
  const date = d.toLocaleDateString('en-US', {
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  });
  const time = d.toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  });
  return { date, time };
}

export function TransactionReceiptView({
  receipt,
  onBack,
}: TransactionReceiptViewProps): JSX.Element {
  const [copiedHash, setCopiedHash] = useState(false);
  const [copiedFrom, setCopiedFrom] = useState(false);
  const [copiedTo, setCopiedTo] = useState(false);

  const { date, time } = formatReceiptTimestamp(receipt.timestamp);
  const explorerUrl = explorerUrlFor(receipt.chain, receipt.hash);
  const networkDisplay = receipt.networkName ?? `${receipt.chain.toUpperCase()} TESTNET`;

  // Status badge reflects the transaction's real state, not a constant.
  const status = receipt.status ?? 'completed';
  const statusBadge =
    status === 'completed'
      ? { label: 'COMPLETED', classes: 'border-success/80 bg-success/10 text-success' }
      : status === 'pending'
        ? { label: 'PENDING', classes: 'border-warning/80 bg-warning/10 text-warning' }
        : { label: 'FAILED', classes: 'border-danger/80 bg-danger/10 text-danger' };

  // Direction drives the sign, the hero label, and the amount color — a
  // payment this wallet received must not render as a debit.
  const received = receipt.direction === 'received';
  const sign = received ? '+' : '-';
  const heroLabel = received ? 'RECEIVED' : 'SENT';

  const copy = (text: string, setter: (val: boolean) => void) => {
    void navigator.clipboard?.writeText(text);
    setter(true);
    setTimeout(() => setter(false), 2000);
  };

  return (
    <main className="relative flex min-h-[600px] w-[400px] flex-col bg-surface-900 p-4 animate-fade-in text-content-primary">
      {/* Top Header */}
      <header className="flex items-center justify-between py-1">
        <button
          type="button"
          onClick={onBack}
          aria-label="Back to dashboard"
          className="flex items-center gap-1.5 font-mono text-xs font-semibold text-content-secondary hover:text-white transition-colors"
        >
          <Glyph name="arrow-left" className="h-4 w-4" />
          <span>BACK</span>
        </button>

        <div
          className={`flex items-center gap-1.5 rounded border px-2 py-0.5 font-mono text-[10px] font-bold tracking-wider ${statusBadge.classes}`}
        >
          <span className="h-1.5 w-1.5 rounded-sm bg-current" />
          <span>{statusBadge.label}</span>
        </div>
      </header>

      {/* Hero: Amount with Faint Watermark Arrow */}
      <div className="relative my-6 flex flex-col items-center justify-center overflow-hidden py-4 text-center">
        {/* Subtle background arrow watermark */}
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 flex items-center justify-center opacity-5 select-none"
        >
          <svg viewBox="0 0 24 24" className="h-48 w-48 stroke-current fill-none stroke-1">
            {received ? (
              <>
                <line x1="7" y1="7" x2="17" y2="17" />
                <polyline points="17 7 17 17 7 17" />
              </>
            ) : (
              <>
                <line x1="7" y1="17" x2="17" y2="7" />
                <polyline points="7 7 17 7 17 17" />
              </>
            )}
          </svg>
        </div>

        <span className="font-mono text-xs font-bold tracking-widest text-accent-500 uppercase">
          {heroLabel}
        </span>
        <div
          className={`mt-1 font-display text-4xl font-extrabold tracking-tight ${received ? 'text-success' : 'text-[#FF5A5A]'}`}
        >
          {sign} {receipt.amount}
        </div>
        <span className="mt-1 font-mono text-sm font-bold text-accent-500">
          {receipt.symbol}
        </span>
      </div>

      {/* Details Card */}
      <div className="flex-1 rounded-2xl border border-surface-700/60 bg-surface-800/80 p-4 shadow-raised">
        <div className="flex flex-col divide-y divide-surface-700/60">
          {/* FROM */}
          <div className="flex items-center justify-between py-2.5">
            <span className="font-mono text-[10px] font-semibold tracking-wider text-content-tertiary uppercase">
              FROM
            </span>
            <div className="flex items-center gap-2">
              <span className="font-mono text-xs text-content-primary">
                {truncateAddress(receipt.from)}
              </span>
              <button
                type="button"
                onClick={() => copy(receipt.from, setCopiedFrom)}
                aria-label="Copy sender address"
                className="text-accent-500 hover:text-accent-400 p-0.5"
              >
                <Glyph name={copiedFrom ? 'check' : 'copy'} className="h-3.5 w-3.5" />
              </button>
            </div>
          </div>

          {/* TO */}
          <div className="flex items-center justify-between py-2.5">
            <span className="font-mono text-[10px] font-semibold tracking-wider text-content-tertiary uppercase">
              TO
            </span>
            <div className="flex items-center gap-2">
              <span className="font-mono text-xs text-content-primary">
                {truncateAddress(receipt.to)}
              </span>
              <button
                type="button"
                onClick={() => copy(receipt.to, setCopiedTo)}
                aria-label="Copy recipient address"
                className="text-accent-500 hover:text-accent-400 p-0.5"
              >
                <Glyph name={copiedTo ? 'check' : 'copy'} className="h-3.5 w-3.5" />
              </button>
            </div>
          </div>

          {/* TIMESTAMP */}
          <div className="flex items-center justify-between py-2.5">
            <span className="font-mono text-[10px] font-semibold tracking-wider text-content-tertiary uppercase">
              TIMESTAMP
            </span>
            <div className="text-right font-mono text-xs text-content-primary">
              <div>{date}</div>
              <div className="text-[10px] text-content-tertiary">{time}</div>
            </div>
          </div>

          {/* NETWORK */}
          <div className="flex items-center justify-between py-2.5">
            <span className="font-mono text-[10px] font-semibold tracking-wider text-content-tertiary uppercase">
              NETWORK
            </span>
            <span className="font-mono text-xs font-semibold text-content-primary uppercase">
              {networkDisplay}
            </span>
          </div>

          {/* TX HASH */}
          <div className="pt-2.5">
            <span className="mb-1.5 block font-mono text-[10px] font-semibold tracking-wider text-content-tertiary uppercase">
              TX HASH
            </span>
            <div className="rounded-lg border border-surface-700 bg-surface-900/90 px-3 py-2 font-mono text-[11px] text-content-secondary break-all">
              {receipt.hash}
            </div>
          </div>
        </div>

        {/* Buttons: COPY & EXPLORER */}
        <div className="mt-4 flex gap-2">
          <button
            type="button"
            onClick={() => copy(receipt.hash, setCopiedHash)}
            className="flex flex-1 items-center justify-center gap-2 rounded-xl bg-accent-500 py-2.5 font-mono text-xs font-bold text-surface-900 shadow-sm transition-transform active:scale-95 hover:bg-accent-400"
          >
            <Glyph name={copiedHash ? 'check' : 'copy'} className="h-4 w-4" />
            <span>{copiedHash ? 'COPIED' : 'COPY'}</span>
          </button>

          {explorerUrl !== null && (
            <button
              type="button"
              onClick={() => window.open(explorerUrl, '_blank', 'noopener,noreferrer')}
              className="flex flex-1 items-center justify-center gap-2 rounded-xl border border-accent-500/80 bg-surface-900/60 py-2.5 font-mono text-xs font-bold text-accent-500 transition-colors hover:bg-accent-500/10 active:scale-95"
            >
              <Glyph name="external" className="h-4 w-4" />
              <span>EXPLORER</span>
            </button>
          )}
        </div>
      </div>
    </main>
  );
}

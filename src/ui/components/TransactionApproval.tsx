import { useState } from 'react';
import { Glyph } from '@/ui/components/Glyph';
import { BrandLogo } from '@/ui/components/BrandLogo';
import { t } from '@/i18n';
import { Button } from '@/ui/components/Button';
import { Card } from '@/ui/components/Card';
import type { PendingApproval } from '@/ui/store/useWallet';

/**
 * Converts a base-unit value to a display figure.
 *
 * Defaults to ETH at 18 decimals for dapp requests, which carry no metadata;
 * agent payments carry an explicit symbol and decimals.
 *
 * Values that truncate to "0.0000" fall back to raw base units: a rounded
 * zero on an approval overlay would make a real payment look like a no-op
 * (the same rule X402Approval follows).
 */
function formatAmount(value: string | undefined, symbol = 'ETH', decimals = 18): string {
  if (value === undefined) return `0 ${symbol}`;
  try {
    const raw = BigInt(value);
    const scale = 10n ** BigInt(decimals);
    const whole = raw / scale;
    const fraction = raw % scale;
    const frac = fraction.toString().padStart(decimals, '0').slice(0, 4);
    if (whole === 0n && /^0+$/.test(frac) && raw > 0n) {
      return `${value} ${symbol} (base units)`;
    }
    return `${whole}.${frac} ${symbol}`;
  } catch {
    return `${value} ${symbol}`;
  }
}

/**
 * Transaction / signature approval overlay — shown when a dapp calls
 * `eth_sendTransaction`, `personal_sign`, or `eth_signTypedData_v4`.
 *
 * Displays what the dapp asked for (recipient, amount, calldata presence, or
 * the message to sign) with Approve / Reject buttons. Approving wakes the
 * awaiting background handler, which signs and broadcasts (or signs the
 * message) and resolves the dapp's original call.
 */
export function TransactionApproval({
  approval,
  onApprove,
  onReject,
}: {
  approval: PendingApproval;
  onApprove: () => void;
  onReject: () => void;
}) {
  const [isLoading, setIsLoading] = useState(false);

  const handleApprove = async () => {
    setIsLoading(true);
    await onApprove();
  };

  const handleReject = async () => {
    setIsLoading(true);
    await onReject();
  };

  const isTx = approval.kind === 'tx';

  return (
    <main className="flex min-h-[600px] w-[400px] animate-fade-in flex-col gap-4 p-4">
      <header className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <BrandLogo size="md" />
          <h1 className="font-display text-lg font-bold text-content-primary">{t('brand')}</h1>
        </div>
        <span className="rounded-full border border-surface-600 px-2 py-0.5 font-mono text-[10px] text-content-tertiary">
          {t('version')}
        </span>
      </header>

      <div className="flex flex-1 flex-col gap-4">
        <div className="flex flex-col items-center justify-center gap-3 pt-4 pb-2">
          <div className="flex h-14 w-14 items-center justify-center rounded-2xl border border-accent-500/25 bg-accent-500/15 text-accent-400">
            <Glyph name={isTx ? 'send' : 'key'} className="h-6 w-6" />
          </div>
          <h2 className="font-display text-lg font-semibold text-content-primary">
            {isTx ? t('approval.transactionTitle') : t('approval.signatureTitle')}
          </h2>
          <p className="font-body text-sm text-content-secondary text-center max-w-xs">
            {t('approval.requestAction', {
              action: isTx ? 'to send a transaction' : 'a message signature',
            })}
          </p>
          <span className="inline-flex max-w-full items-center gap-1.5 rounded-full border border-surface-600 bg-surface-800 px-2.5 py-1">
            <Glyph name="link" className="h-3 w-3 shrink-0 text-content-tertiary" />
            <span className="truncate font-mono text-[11px] text-content-secondary">
              {approval.origin.replace(/^https?:\/\//, '')}
            </span>
          </span>
        </div>

        {isTx ? (
          <Card title={t('approval.transaction')}>
            <div className="flex flex-col divide-y divide-surface-700/70">
              <DetailRow label={t('approval.from')} value={approval.address} />
              <DetailRow label={t('approval.to')} value={approval.to ?? '—'} />
              <DetailRow
                label={t('approval.amount')}
                value={formatAmount(approval.value, approval.symbol, approval.decimals)}
                mono={false}
              />
              {approval.data !== undefined && approval.data.length > 2 && (
                <DetailRow
                  label={t('approval.calldata')}
                  value={`${approval.data.slice(0, 18)}… (${((approval.data.length - 2) / 2).toFixed(0)} bytes)`}
                  mono={false}
                />
              )}
            </div>
          </Card>
        ) : (
          <Card title={t('approval.message')}>
            <div className="flex flex-col divide-y divide-surface-700/70">
              <DetailRow label={t('approval.account')} value={approval.address} />
              <DetailRow label={t('approval.message')} value={approval.message ?? '—'} />
            </div>
          </Card>
        )}

        <div className="mt-auto flex flex-col gap-2">
          <div className="flex gap-3">
            <Button variant="secondary" fullWidth onClick={handleReject} disabled={isLoading}>
              {t('common.reject')}
            </Button>
            <Button variant="primary" fullWidth onClick={handleApprove} disabled={isLoading}>
              {isLoading ? 'Approving…' : t('common.approve')}
            </Button>
          </div>
          <p className="text-center font-body text-[11px] text-content-tertiary">
            Only approve if you trust this site.
          </p>
        </div>
      </div>
    </main>
  );
}

function DetailRow({
  label,
  value,
  mono = true,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div className="flex items-start justify-between gap-3 py-2 first:pt-0 last:pb-0">
      <span className="shrink-0 pt-0.5 font-body text-[10px] uppercase tracking-wide text-content-tertiary">
        {label}
      </span>
      <span
        className={`min-w-0 text-right text-xs text-content-primary break-all ${
          mono ? 'font-mono' : 'font-body'
        }`}
      >
        {value}
      </span>
    </div>
  );
}

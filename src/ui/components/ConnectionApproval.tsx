import { useState } from 'react';
import { Glyph } from '@/ui/components/Glyph';
import { BrandLogo } from '@/ui/components/BrandLogo';
import { t } from '@/i18n';
import { Button } from '@/ui/components/Button';
import { Card } from '@/ui/components/Card';

/** Per-chain chip styling, matching the dashboard's coin badges. */
const CHAIN_CHIP: Record<string, { label: string; initial: string; chip: string }> = {
  evm: { label: 'Ethereum', initial: 'Ξ', chip: 'bg-gradient-to-br from-[#627EEA] to-[#4A5FC7]' },
  solana: {
    label: 'Solana',
    initial: 'S',
    chip: 'bg-gradient-to-br from-[#9945FF] to-[#14F195] text-surface-900',
  },
  stellar: { label: 'Stellar', initial: 'X', chip: 'bg-gradient-to-br from-[#7B8299] to-[#3E4557]' },
};

function chainChip(chain: string) {
  return (
    CHAIN_CHIP[chain] ?? { label: chain.toUpperCase(), initial: chain.charAt(0).toUpperCase(), chip: 'bg-surface-600' }
  );
}

/** Connection approval overlay shown when a dapp requests account access. */
export function ConnectionApproval({
  origin,
  requestedAccounts,
  onApprove,
  onReject,
}: {
  origin: string;
  requestedAccounts: { chain: string; address: string }[];
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
            <Glyph name="link" className="h-6 w-6" />
          </div>
          <h2 className="font-display text-lg font-semibold text-content-primary">
            {t('approval.connectionTitle')}
          </h2>
          <p className="font-body text-sm text-content-secondary text-center max-w-xs">
            {t('approval.requestAccess')}
          </p>
          <span className="inline-flex max-w-full items-center gap-1.5 rounded-full border border-surface-600 bg-surface-800 px-2.5 py-1">
            <Glyph name="link" className="h-3 w-3 shrink-0 text-content-tertiary" />
            <span className="truncate font-mono text-[11px] text-content-secondary">
              {origin.replace(/^https?:\/\//, '')}
            </span>
          </span>
        </div>

        <Card title={t('approval.account')}>
          <ul className="flex flex-col gap-2">
            {requestedAccounts.map((acc) => {
              const meta = chainChip(acc.chain);
              return (
                <li
                  key={`${acc.chain}:${acc.address}`}
                  className="flex items-center gap-3 rounded-xl border border-surface-700/70 bg-surface-800/80 px-3 py-2"
                >
                  <span
                    aria-hidden
                    className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-xs font-bold ${meta.chip}`}
                  >
                    {meta.initial}
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="font-body text-xs font-semibold text-content-primary">{meta.label}</p>
                    {/* Approval surface: the address is shown IN FULL — a
                        truncated address on a consent screen is how account
                        confusion and address-poisoning start. */}
                    <p className="break-all font-mono text-[10px] text-content-tertiary">
                      {acc.address}
                    </p>
                  </div>
                </li>
              );
            })}
          </ul>
        </Card>

        <div className="mt-auto flex flex-col gap-2">
          <div className="flex gap-3">
            <Button variant="secondary" fullWidth onClick={handleReject} disabled={isLoading}>
              {t('common.reject')}
            </Button>
            <Button variant="primary" fullWidth onClick={handleApprove} disabled={isLoading}>
              {isLoading ? 'Approving…' : t('approval.approveConnection')}
            </Button>
          </div>
          <p className="text-center font-body text-[11px] text-content-tertiary">
            This site will see your address and request approvals.
          </p>
        </div>
      </div>
    </main>
  );
}

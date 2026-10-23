import { useEffect, useState } from 'react';
import { Icon } from '@/ui/components/Icon';
import { hexToBytes } from '@noble/hashes/utils';
import { t } from '@/i18n';
import { Button } from '@/ui/components/Button';
import { Card } from '@/ui/components/Card';
import { Input } from '@/ui/components/Input';
import { useWallet } from '@/ui/store/useWallet';
import type { PendingGrantRequest } from '@/ui/store/useWallet';
import { authenticateWebAuthn } from '@/core/security';

/** Formats a wei decimal string as a short ETH figure for display. */
function formatEthAmount(wei: string): string {
  try {
    const value = BigInt(wei);
    const whole = value / 10n ** 18n;
    const fraction = value % 10n ** 18n;
    const frac = fraction.toString().padStart(18, '0').slice(0, 4).replace(/0+$/, '');
    return `${whole}${frac.length > 0 ? `.${frac}` : ''} ETH`;
  } catch {
    return `${wei} wei`;
  }
}

/**
 * Grant approval overlay — shown when a page calls
 * `window.veilpay.agent.requestGrant(...)`.
 *
 * Displays the requested caps verbatim. Approving is gated by a 3s hold-to-
 * confirm countdown (anti-clickjack, spec §9) and by VAP-01 confirmation:
 * a PIN when configured (verified in the background), or a WebAuthn passkey
 * ceremony when no PIN is configured (run here — `navigator.credentials` is a
 * page-context API — with the result reported over the privileged resolve kind).
 */
export function GrantApproval({
  request,
  onApprove,
  onReject,
}: {
  request: PendingGrantRequest;
  onApprove: (pin?: string, webauthn?: boolean) => void;
  onReject: () => void;
}) {
  const { securityStatus, loadSecurityStatus, requestWebAuthnChallenge } = useWallet();
  const [isLoading, setIsLoading] = useState(false);
  const [confirmState, setConfirmState] = useState<'idle' | 'counting' | 'ready'>('idle');
  const [confirmCount, setConfirmCount] = useState(3);
  const [pin, setPin] = useState('');
  const [webauthnConfirmed, setWebauthnConfirmed] = useState(false);
  const [passkeyError, setPasskeyError] = useState<string | null>(null);
  const caps = request.requestedCaps;
  const expiresAt = new Date(Date.now() + request.expiresInSeconds * 1000);

  // Until the security status has loaded we cannot know whether a PIN or
  // passkey gates this grant — treat "unknown" as "confirmation required"
  // (fail closed). The background re-verifies either way; this keeps the UI
  // honest about it.
  const statusLoaded = securityStatus !== null;
  const pinRequired = securityStatus?.pinEnabled === true;
  const webauthnRequired = securityStatus?.webauthnEnabled === true && !pinRequired;

  useEffect(() => {
    void loadSecurityStatus();
  }, [loadSecurityStatus]);

  const handlePasskey = async () => {
    setPasskeyError(null);
    const result = await requestWebAuthnChallenge();
    if (result === null) {
      setPasskeyError('Could not start passkey confirmation.');
      return;
    }
    const ok = await authenticateWebAuthn(result.credentialId, hexToBytes(result.challenge));
    if (ok) {
      setWebauthnConfirmed(true);
    } else {
      setPasskeyError('Passkey confirmation failed. Try again.');
    }
  };

  const handleApprove = async () => {
    if (confirmState === 'idle') {
      setConfirmState('counting');
      const timer = setInterval(() => {
        setConfirmCount((c) => {
          if (c <= 1) {
            clearInterval(timer);
            setConfirmState('ready');
            return 0;
          }
          return c - 1;
        });
      }, 1000);
      return;
    }
    if (confirmState !== 'ready') return;
    if (pinRequired && pin.length === 0) return;
    if (webauthnRequired && !webauthnConfirmed) return;
    setIsLoading(true);
    await onApprove(pinRequired ? pin : undefined, webauthnRequired);
  };

  const handleReject = async () => {
    setIsLoading(true);
    await onReject();
  };

  // The button must stay enabled in the idle state so the first click can start
  // the countdown; the confirmation requirement gates only the ready state.
  const confirmationMissing =
    !statusLoaded ||
    (pinRequired && pin.length === 0) ||
    (webauthnRequired && !webauthnConfirmed);
  const approveDisabled = isLoading || confirmState === 'counting' || (confirmState === 'ready' && confirmationMissing);

  return (
    <main className="flex min-h-[600px] w-[400px] flex-col gap-4 p-4">
      <header className="flex items-baseline justify-between">
        <h1 className="font-display text-lg font-bold text-content-primary">{t('brand')}</h1>
        <span className="font-mono text-xs text-content-tertiary">{t('version')}</span>
      </header>

      <div className="flex flex-1 flex-col gap-4">
        <div className="flex flex-col items-center justify-center gap-3 py-6">
          <div className="flex h-14 w-14 items-center justify-center rounded-full bg-accent-primary/20">
            <Icon name="key" className="h-7 w-7" />
          </div>
          <h2 className="font-display text-lg font-semibold text-content-primary">
            {t('vap.grantTitle')}
          </h2>
          <p className="font-body text-sm text-content-secondary text-center max-w-xs">
            {t('vap.grantDescription')}
          </p>
          <p className="font-mono text-xs text-content-tertiary">{request.origin}</p>
        </div>

        <Card title={t('vap.requestedCaps')}>
          <div className="flex flex-col gap-2">
            <DetailRow label={t('vap.maxPerOperation')} value={formatEthAmount(caps.maxPerOperation)} />
            <DetailRow label={t('vap.maxPerWindow')} value={formatEthAmount(caps.maxPerWindow)} />
            <DetailRow label={t('vap.window')} value={`${caps.windowSeconds / 3600} hours`} />
            <DetailRow label={t('vap.autoApproveUnder')} value={formatEthAmount(caps.approvalThreshold)} />
            <DetailRow label={t('vap.expires')} value={expiresAt.toLocaleString()} mono={false} />
          </div>
        </Card>

        {pinRequired && confirmState === 'ready' && (
          <Input
            type="password"
            label="PIN"
            placeholder="Enter your PIN to create the grant"
            value={pin}
            onChange={(e) => setPin(e.target.value)}
            autoFocus
            disabled={isLoading}
          />
        )}

        {webauthnRequired && confirmState === 'ready' && !webauthnConfirmed && (
          <div className="flex flex-col gap-1">
            <Button variant="secondary" fullWidth onClick={handlePasskey} disabled={isLoading}>
              {isLoading ? 'Confirming…' : 'Confirm with passkey'}
            </Button>
            {passkeyError !== null && (
              <p className="font-body text-xs text-danger">{passkeyError}</p>
            )}
          </div>
        )}

        <div className="mt-auto flex gap-3">
          <Button variant="secondary" fullWidth onClick={handleReject} disabled={isLoading}>
            {t('common.reject')}
          </Button>
          <Button
            variant="primary"
            fullWidth
            onClick={handleApprove}
            disabled={approveDisabled}
          >
            {isLoading
              ? 'Creating…'
              : confirmState === 'counting'
                ? t('vap.holdToConfirm', { count: confirmCount })
                : t('vap.createGrant')}
          </Button>
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
    <div className="flex flex-col gap-0.5">
      <span className="font-body text-[10px] uppercase tracking-wide text-content-tertiary">
        {label}
      </span>
      <span
        className={`text-xs text-content-primary break-all ${
          mono ? 'font-mono' : 'font-body'
        }`}
      >
        {value}
      </span>
    </div>
  );
}
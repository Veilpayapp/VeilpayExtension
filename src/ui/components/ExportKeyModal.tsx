import { useState } from 'react';
import { t } from '@/i18n';
import { useWallet, type AccountView } from '@/ui/store/useWallet';
import { Button } from '@/ui/components/Button';
import { Card } from '@/ui/components/Card';
import { copySecretToClipboard } from '@/ui/lib/clipboard';

/**
 * Export key modal.
 *
 * Requires the vault to be unlocked (enforced by the background handler), then
 * reveals the chain's private key. The key is copied to the clipboard and
 * auto-cleared after 30 seconds. The wipe timer lives in the clipboard module,
 * NOT in this component: closing the modal within the window must not cancel
 * the wipe, or the key would sit on the system clipboard indefinitely.
 */
export function ExportKeyModal({
  account,
  onClose,
}: {
  account: AccountView;
  onClose: () => void;
}) {
  const [step, setStep] = useState<'confirm' | 'show'>('confirm');
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [key, setKey] = useState<string | null>(null);
  const [address, setAddress] = useState<string | null>(null);

  const copyToClipboard = async (value: string) => {
    const ok = await copySecretToClipboard(value);
    setCopied(ok);
    if (ok) {
      // Visual acknowledgement only; the clipboard wipe itself is armed inside
      // copySecretToClipboard and survives this component unmounting.
      window.setTimeout(() => setCopied(false), 2_000);
    }
  };

  const handleExport = async () => {
    setError(null);
    try {
      const result = await useWallet.getState().exportKey(account.chain, account.index);
      setKey(result.privateKey);
      setAddress(result.address);
      setStep('show');
      await copyToClipboard(result.privateKey);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t('surfaces.couldNotExport'));
    }
  };

  if (step === 'confirm') {
    return (
      <Card title={t('surfaces.exportKeyTitle')} className="animate-scale-in">
        <p className="font-body text-xs text-content-secondary mb-3">
          {t('surfaces.exportKeyConfirmBody', { chain: account.chain })}
        </p>
        <p className="font-body text-xs text-content-tertiary mb-3">
          {t('surfaces.exportKeyWarning')}
        </p>
        {error !== null && (
          <p className="font-body text-xs text-error mb-2">{error}</p>
        )}
        <div className="flex flex-col gap-2">
          <Button fullWidth onClick={handleExport}>
            {t('surfaces.exportKeyTitle')}
          </Button>
          <Button variant="ghost" size="sm" onClick={onClose}>
            {t('common.cancel')}
          </Button>
        </div>
      </Card>
    );
  }

  return (
    <Card title={t('surfaces.privateKeyTitle')} className="animate-scale-in">
      <p className="font-body text-xs text-content-tertiary mb-3">
        {t('surfaces.keyCopiedHint')}
      </p>
      <div className="rounded-lg bg-surface-900 p-3 font-mono text-xs text-content-primary break-all">
        {key}
      </div>
      <p className="font-mono text-[10px] text-content-tertiary mt-2">
        {address}
      </p>
      <div className="mt-3 flex gap-2">
        <Button variant="secondary" size="sm" onClick={() => { if (key) void copyToClipboard(key); }}>
          {copied ? t('surfaces.copied') : t('surfaces.copyAgain')}
        </Button>
        <Button variant="ghost" size="sm" onClick={onClose}>
          {t('common.close')}
        </Button>
      </div>
    </Card>
  );
}

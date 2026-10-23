import { useEffect, useState } from 'react';
import { t } from '@/i18n';
import { useWallet } from '@/ui/store/useWallet';
import { Button } from '@/ui/components/Button';
import { Card } from '@/ui/components/Card';
import { Input } from '@/ui/components/Input';
import { TestnetBanner } from '@/ui/components/TestnetBanner';
import { Icon } from '@/ui/components/Icon';
import { Dashboard } from '@/ui/components/Dashboard';
import { TransactionHistoryView } from '@/ui/components/TransactionHistoryView';
import { ConnectionApproval } from '@/ui/components/ConnectionApproval';
import { TransactionApproval } from '@/ui/components/TransactionApproval';
import { X402Approval } from '@/ui/components/X402Approval';
import { GrantApproval } from '@/ui/components/GrantApproval';
import { WalletConnectView } from '@/ui/components/WalletConnectView';
import { BrandLogo } from '@/ui/components/BrandLogo';
import { Glyph, type GlyphName } from '@/ui/components/Glyph';
import { useTheme } from '@/ui/theme/useTheme';

/** Full-height wallet companion surface for approvals and quick account access. */
export default function SidePanelApp() {
  const { isDark, toggleTheme } = useTheme();
  const {
    vaultState, isLoading, error, accounts, pendingConnection, pendingApproval,
    pendingX402Payment, pendingGrantRequest, refresh, loadAccounts,
    loadPendingConnection, resolvePendingConnection, loadPendingApproval,
    resolvePendingApproval, loadPendingX402, resolvePendingX402,
    loadPendingGrantRequest, resolvePendingGrantRequest, unlock, lock,
  } = useWallet();
  const [unlockPassphrase, setUnlockPassphrase] = useState('');
  const [unlockError, setUnlockError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<'wallet' | 'activity' | 'settings' | 'connect'>('wallet');

  useEffect(() => {
    void refresh();
    void loadPendingConnection();
    void loadPendingApproval();
    void loadPendingX402();
    void loadPendingGrantRequest();
  }, [refresh, loadPendingConnection, loadPendingApproval, loadPendingX402, loadPendingGrantRequest]);

  useEffect(() => {
    if (vaultState === 'unlocked' && accounts.length === 0) void loadAccounts();
  }, [vaultState, accounts.length, loadAccounts]);

  const handleUnlock = async () => {
    setUnlockError(null);
    if (unlockPassphrase.length === 0) {
      setUnlockError(t('wallet.passphrase'));
      return;
    }
    const ok = await unlock(unlockPassphrase);
    // Clear the passphrase from state either way — the side panel is
    // long-lived, and the secret's job ends when the vault answers.
    setUnlockPassphrase('');
    if (!ok) {
      setUnlockError(t('wallet.wrongPassphrase'));
    }
  };

  const handleApproveConnection = async () => {
    if (pendingConnection === null) return;
    const granted = await resolvePendingConnection(
      pendingConnection.origin,
      pendingConnection.requestedAccounts.map((a) => a.address),
      'approve',
    );
    if (granted) void refresh();
  };

  const handleDenyConnection = async () => {
    if (pendingConnection !== null) {
      await resolvePendingConnection(pendingConnection.origin, [], 'deny');
    }
  };

  const handleApproveApproval = async () => {
    if (pendingApproval !== null) await resolvePendingApproval(pendingApproval.id, 'approve');
  };

  const handleDenyApproval = async () => {
    if (pendingApproval !== null) await resolvePendingApproval(pendingApproval.id, 'deny');
  };

  const handleApproveX402 = async () => {
    if (pendingX402Payment !== null) await resolvePendingX402(pendingX402Payment.id, 'approve');
  };

  const handleDenyX402 = async () => {
    if (pendingX402Payment !== null) await resolvePendingX402(pendingX402Payment.id, 'deny');
  };

  const handleApproveGrant = async (pin?: string, webauthn?: boolean) => {
    if (pendingGrantRequest !== null) await resolvePendingGrantRequest(pendingGrantRequest.id, 'approve', pin, webauthn);
  };

  const handleDenyGrant = async () => {
    if (pendingGrantRequest !== null) await resolvePendingGrantRequest(pendingGrantRequest.id, 'deny');
  };

  const openPopup = () => {
    void chrome.action.openPopup().catch(() => undefined);
  };

  // All approval overlays are gated on the vault being unlocked: a dapp request
  // that lands while the wallet is locked must surface the unlock screen, not
  // the approval (matching the popup's gating).
  if (vaultState === 'unlocked' && pendingConnection !== null) {
    return (
      <div className="bg-surface-base">
        <ConnectionApproval
          origin={pendingConnection.origin}
          requestedAccounts={pendingConnection.requestedAccounts}
          onApprove={handleApproveConnection}
          onReject={handleDenyConnection}
        />
      </div>
    );
  }

  if (vaultState === 'unlocked' && pendingApproval !== null) {
    return (
      <div className="bg-surface-base">
        <TransactionApproval
          approval={pendingApproval}
          onApprove={handleApproveApproval}
          onReject={handleDenyApproval}
        />
      </div>
    );
  }

  if (vaultState === 'unlocked' && pendingX402Payment !== null) {
    return (
      <div className="bg-surface-base">
        <X402Approval
          payment={pendingX402Payment}
          onApprove={handleApproveX402}
          onReject={handleDenyX402}
        />
      </div>
    );
  }

  if (vaultState === 'unlocked' && pendingGrantRequest !== null) {
    return (
      <div className="bg-surface-base">
        <GrantApproval
          request={pendingGrantRequest}
          onApprove={handleApproveGrant}
          onReject={handleDenyGrant}
        />
      </div>
    );
  }

  if (isLoading && vaultState === 'uninitialized') {
    return (
      <main className="flex min-h-screen flex-col items-center justify-center gap-3 p-6">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-accent-500 border-t-transparent" />
        <p className="font-body text-sm text-content-secondary">{t('status.loadingWallet')}</p>
      </main>
    );
  }

  const header = (
    <header className="flex items-center justify-between">
      <div className="flex items-center gap-2">
        <BrandLogo size="md" />
        <h1 className="font-display text-lg font-bold text-content-primary">{t('brand')}</h1>
      </div>
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={toggleTheme}
          aria-label={isDark ? 'Switch to light mode' : 'Switch to dark mode'}
          title={isDark ? 'Switch to light mode' : 'Switch to dark mode'}
          className="rounded-lg border border-surface-600/80 bg-surface-800 p-1.5 text-content-secondary transition-colors hover:border-accent-500/50 hover:text-accent-500 active:scale-95"
        >
          <Glyph name={isDark ? 'sun' : 'moon'} className="h-3.5 w-3.5" />
        </button>
        <span className="rounded-full border border-surface-600 px-2 py-0.5 font-mono text-[10px] text-content-tertiary">
          {t('version')}
        </span>
      </div>
    </header>
  );

  if (vaultState === 'uninitialized') {
    return (
      <main className="flex min-h-screen flex-col gap-4 p-4">
        {header}
        <div className="flex flex-1 flex-col items-center justify-center gap-4 text-center">
          <div className="flex h-12 w-12 items-center justify-center rounded-full bg-surface-700"><Icon name="wand" className="h-6 w-6" /></div>
          <h2 className="font-display text-base font-semibold text-content-primary">{t('wallet.noWallet')}</h2>
          <p className="font-body text-sm text-content-secondary max-w-xs">{t('wallet.noWalletDescription')}</p>
          <Button fullWidth onClick={openPopup}>{t('wallet.openPopup')}</Button>
        </div>
      </main>
    );
  }

  if (vaultState === 'locked') {
    return (
      <main className="flex min-h-screen flex-col gap-4 p-4">
        {header}
        <div className="flex flex-1 flex-col items-center justify-center gap-4">
          <div className="flex h-12 w-12 items-center justify-center rounded-full bg-surface-700"><Icon name="lock" className="h-6 w-6" /></div>
          <p className="font-body text-sm text-content-secondary">{t('wallet.locked')}</p>
          <div className="w-full max-w-sm">
            <Input
              type="password"
              label={t('wallet.passphrase')}
              placeholder={t('wallet.passphrase')}
              value={unlockPassphrase}
              onChange={(e) => { setUnlockPassphrase(e.target.value); setUnlockError(null); }}
              onKeyDown={(e) => { if (e.key === 'Enter') void handleUnlock(); }}
              error={unlockError ?? null}
              passwordToggle
              autoFocus
              disabled={isLoading}
            />
          </div>
          <Button fullWidth onClick={handleUnlock} disabled={isLoading || unlockPassphrase.length === 0}>
            {isLoading ? t('wallet.unlocking') : t('wallet.unlock')}
          </Button>
          {error !== null && <p className="font-body text-xs text-danger">{error}</p>}
        </div>
      </main>
    );
  }

  const tabs: { key: 'wallet' | 'activity' | 'settings' | 'connect'; label: string; icon: GlyphName }[] = [
    { key: 'wallet', label: 'Wallet', icon: 'wallet' },
    { key: 'activity', label: t('settings.transactions'), icon: 'activity' },
    { key: 'connect', label: 'Connect', icon: 'link' },
    { key: 'settings', label: t('common.settings'), icon: 'settings' },
  ];

  return (
    <div className="flex min-h-screen flex-col">
      {/* Keyed by tab so switching tabs fades the new panel in instead of
          swapping instantly. The animation runs on each tab change because the
          key change remounts the wrapper. */}
      <div key={activeTab} className="flex-1 animate-fade-in overflow-y-auto p-4">
        {activeTab === 'wallet' && (
          <div className="flex flex-col gap-3">
            {header}
            <TestnetBanner />
            <Dashboard
              accounts={accounts}
              onSend={openPopup}
              onReceive={openPopup}
              onImport={openPopup}
              onLock={() => void lock()}
            />
          </div>
        )}
        {activeTab === 'activity' && <TransactionHistoryView />}
        {activeTab === 'connect' && <WalletConnectView />}
        {activeTab === 'settings' && (
          <div className="flex flex-col gap-3">
            {header}
            <Card title={t('common.settings')}>
              <div className="flex flex-col gap-2">
                <Button variant="secondary" fullWidth onClick={() => void lock()}>
                  {t('common.lock')}
                </Button>
                <Button variant="ghost" fullWidth onClick={openPopup}>
                  {t('common.import')}
                </Button>
                <Button variant="ghost" fullWidth onClick={() => void chrome.runtime.openOptionsPage()}>
                  {t('common.settings')}
                </Button>
              </div>
            </Card>
          </div>
        )}
      </div>
      <nav className="flex shrink-0 gap-1 border-t border-surface-700/70 bg-surface-800/80 px-2 py-2 backdrop-blur">
        {tabs.map((tab) => (
          <button
            key={tab.key}
            type="button"
            onClick={() => setActiveTab(tab.key)}
            aria-current={activeTab === tab.key ? 'page' : undefined}
            className={`flex flex-1 flex-col items-center gap-1 rounded-xl px-2 py-2 font-body text-[11px] transition-all duration-base ease-out active:scale-95 ${
              activeTab === tab.key
                ? 'bg-accent-500/15 font-semibold text-accent-400'
                : 'text-content-tertiary hover:bg-surface-700 hover:text-content-secondary'
            }`}
          >
            <Glyph name={tab.icon} className="h-[18px] w-[18px]" />
            {tab.label}
          </button>
        ))}
      </nav>
    </div>
  );
}

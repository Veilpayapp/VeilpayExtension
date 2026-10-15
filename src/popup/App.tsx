import { useCallback, useEffect, useMemo, useState } from 'react';
import { t } from '@/i18n';
import { useWallet, type AccountView } from '@/ui/store/useWallet';
import { Button } from '@/ui/components/Button';
import { Card } from '@/ui/components/Card';
import { Input } from '@/ui/components/Input';
import { TestnetBanner } from '@/ui/components/TestnetBanner';
import { Dashboard } from '@/ui/components/Dashboard';
import { ConnectionApproval } from '@/ui/components/ConnectionApproval';
import { TransactionApproval } from '@/ui/components/TransactionApproval';
import { X402Approval } from '@/ui/components/X402Approval';
import { GrantApproval } from '@/ui/components/GrantApproval';
import { Icon } from '@/ui/components/Icon';
import { Glyph } from '@/ui/components/Glyph';
import { BrandLogo } from '@/ui/components/BrandLogo';
import { QRCode } from '@/ui/components/QRCode';
import { TacticalBottomNav, type TacticalTab } from '@/ui/components/TacticalBottomNav';
import { TransactionReceiptView } from '@/ui/components/TransactionReceiptView';
import { ScanModal, type ParsedRecipient } from '@/ui/components/ScanModal';
import { AddressBookPicker } from '@/ui/components/AddressBookPicker';
import { CameraSetupCard } from '@/ui/components/CameraSetupCard';
import { PrivacyView } from '@/ui/components/PrivacyView';
import { baseToDecimal, nativeDecimalsFor } from '@/ui/lib/format';
import { networkFor, networkLabel } from '@/ui/components/Dashboard';
import { vaultExists } from '@/core/vault/storage';
import type { IndexerTx } from '@/core/chains/indexer-service';
import type { StellarAssetInput, TokenInputType, ZkCapability } from '@/core/messaging/protocol';

const AUTO_RELOAD_KEY = 'bootAutoReloadedAt';
const AUTO_RELOAD_WINDOW_MS = 60_000;

/**
 * Minutes remaining in the unlock window, floored at zero ("locking…" once
 * the deadline has passed but the UI has not re-read state yet).
 */
function formatMinutesRemaining(unlockedUntil: number, nowMs: number): string {
  const remainingMs = unlockedUntil - nowMs;
  if (remainingMs <= 0) return 'locking…';
  const minutes = Math.ceil(remainingMs / 60_000);
  return `${minutes}m unlocked`;
}

/**
 * One automatic recovery attempt for a stale/broken background service worker.
 *
 * If the popup boots to an error (SW never responded), Chrome may still be
 * running an old service worker from a previous build. Reloading the extension
 * re-registers the SW from the current `dist/`. Guarded by a per-session
 * timestamp so it runs at most once a minute — a genuinely broken SW surfaces
 * the manual Retry / Reload buttons instead of looping.
 *
 * VAULT-AWARE (the early-lock fix): `chrome.runtime.reload()` also wipes
 * `chrome.storage.session` — which is where the vault's 15-minute unlock
 * window lives across service-worker evictions. Auto-reloading while a vault
 * EXISTS would therefore lock the user out seconds into their session. So the
 * reload fires only when no vault exists (nothing to lose); otherwise the
 * error screen with manual Retry is shown and the session survives.
 */
async function maybeAutoReload(): Promise<boolean> {
  try {
    const hasVault = await vaultExists();
    if (hasVault) return false;
    const stored = await chrome.storage.session.get(AUTO_RELOAD_KEY);
    const last = stored[AUTO_RELOAD_KEY] as number | undefined;
    const now = Date.now();
    if (typeof last === 'number' && now - last < AUTO_RELOAD_WINDOW_MS) return false;
    await chrome.storage.session.set({ [AUTO_RELOAD_KEY]: now });
    chrome.runtime.reload();
    return true;
  } catch {
    return false;
  }
}

type OnboardingStep = 'welcome' | 'phrase' | 'passphrase' | 'success' | 'complete' | 'import';

/**
 * Phase 1 popup — onboarding, unlock, accounts, send/receive, and import.
 *
 * State machine:
 *   vaultState=uninitialized → onboarding flow
 *   vaultState=locked       → unlock screen
 *   vaultState=unlocked     → account list with send/receive/import
 */
export default function App() {
  const {
    vaultState,
    isLoading,
    error,
    accounts,
    zkCapability,
    unlockedUntil,
    pendingConnection,
    pendingApproval,
    pendingX402Payment,
    pendingGrantRequest,
    refresh,
    loadAccounts,
    generateMnemonic,
    createVault,
    estimateTransfer,
    sendTransfer,
    unlock,
    lock,
    reset,
    clearError,
    loadPendingConnection,
    resolvePendingConnection,
    loadPendingApproval,
    resolvePendingApproval,
    loadPendingX402,
    resolvePendingX402,
    loadPendingGrantRequest,
    resolvePendingGrantRequest,
    networks,
    selectedNetworks,
  } = useWallet();

  const [step, setStep] = useState<OnboardingStep>('welcome');
  const [phrase, setPhrase] = useState<string | null>(null);
  const [phraseRevealed, setPhraseRevealed] = useState(false);
  const [phraseCopied, setPhraseCopied] = useState(false);
  const [passphrase1, setPassphrase1] = useState('');
  const [passphrase2, setPassphrase2] = useState('');
  const [passphraseError, setPassphraseError] = useState<string | null>(null);
  const [unlockPassphrase, setUnlockPassphrase] = useState('');
  const [unlockError, setUnlockError] = useState<string | null>(null);
  /** The store's `unlockedUntil`, polled so the header countdown stays live. */
  const [nowMs, setNowMs] = useState(Date.now());
  useEffect(() => {
    if (unlockedUntil === null) return;
    const id = window.setInterval(() => setNowMs(Date.now()), 20_000);
    return () => window.clearInterval(id);
  }, [unlockedUntil]);
  /**
   * Bumped on every failed unlock so the shake animation replays. React reuses
   * the DOM node otherwise, and re-applying the same class to an unchanged
   * element does not restart a CSS animation — changing the key remounts it.
   */
  const [unlockAttempt, setUnlockAttempt] = useState(0);
  const [resetConfirm, setResetConfirm] = useState(false);

  // Send / receive / import / privacy view
  const [view, setView] = useState<'accounts' | 'send' | 'receive' | 'import' | 'privacy'>('accounts');
  const [sendTo, setSendTo] = useState('');
  const [sendAmount, setSendAmount] = useState('');
  /** Stellar MEMO_TEXT, sent with the transfer. Lifted here so a scanned
   *  payment URI (stellar:…?memo=…) can pre-fill it. */
  const [sendMemo, setSendMemo] = useState('');
  const [sendAsset, setSendAsset] = useState<StellarAssetInput | undefined>(undefined);
  const [sendToken, setSendToken] = useState<TokenInputType | undefined>(undefined);
  const [sendFee, setSendFee] = useState<string | null>(null);
  const [sendDecimals, setSendDecimals] = useState<number | null>(null);
  const [sendSpendable, setSendSpendable] = useState<string | null>(null);
  const [sendStatus, setSendStatus] = useState<'fee' | 'confirm' | 'sending' | 'done'>('fee');
  const [sendHash, setSendHash] = useState<string | null>(null);
  /** Stellar privacy payment (one-time stealth address) toggle. */
  const [sendPrivate, setSendPrivate] = useState(false);
  /** The transfer's actual on-chain destination (the one-time address for a
   *  private send), so the receipt tells the truth instead of echoing the
   *  typed recipient. */
  const [sendReceiptTo, setSendReceiptTo] = useState<string | null>(null);
  const [receiveIdx, setReceiveIdx] = useState(0);
  const [importPhrase, setImportPhrase] = useState('');
  const [importPass1, setImportPass1] = useState('');
  const [importPass2, setImportPass2] = useState('');
  const [importError, setImportError] = useState<string | null>(null);
  const [selectedTx, setSelectedTx] = useState<IndexerTx | null>(null);
  const [scanModalOpen, setScanModalOpen] = useState(false);

  // Refresh vault state on mount
  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Load accounts once the vault is unlocked so the dashboard renders them.
  // Without this a fresh popup shows "No accounts loaded" with no way to fix it
  // (the dashboard's Refresh button only reloads balances, not the account list).
  useEffect(() => {
    if (vaultState === 'unlocked' && accounts.length === 0) {
      void loadAccounts();
    }
  }, [vaultState, accounts.length, loadAccounts]);

  // A dapp connection request can land while the popup is closed (the background
  // opens it via chrome.action.openPopup). Reload it on mount so the approval UI
  // is rendered even if the popup started fresh.
  useEffect(() => {
    void loadPendingConnection();
  }, [loadPendingConnection]);

  // Same for a dapp transaction/signature request awaiting approval.
  useEffect(() => {
    void loadPendingApproval();
  }, [loadPendingApproval]);

  // Same for an x402 payment request awaiting approval.
  useEffect(() => {
    void loadPendingX402();
  }, [loadPendingX402]);

  // Same for a VAP grant request awaiting approval.
  useEffect(() => {
    void loadPendingGrantRequest();
  }, [loadPendingGrantRequest]);

  // If the background service never answered while still on the WELCOME step
  // (no create/import flow started), Chrome may be running a stale service
  // worker. One automatic reload re-registers it from the current build; only
  // fires on the initial load so a create/import error never nukes the form.
  useEffect(() => {
    if (
      error !== null &&
      vaultState === 'uninitialized' &&
      phrase === null &&
      step === 'welcome'
    ) {
      void maybeAutoReload();
    }
  }, [error, vaultState, phrase, step]);

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
    if (pendingConnection === null) return;
    await resolvePendingConnection(pendingConnection.origin, [], 'deny');
  };

  const handleApproveApproval = async () => {
    if (pendingApproval === null) return;
    await resolvePendingApproval(pendingApproval.id, 'approve');
  };

  const handleDenyApproval = async () => {
    if (pendingApproval === null) return;
    await resolvePendingApproval(pendingApproval.id, 'deny');
  };

  const handleApproveX402 = async () => {
    if (pendingX402Payment === null) return;
    await resolvePendingX402(pendingX402Payment.id, 'approve');
  };

  const handleDenyX402 = async () => {
    if (pendingX402Payment === null) return;
    await resolvePendingX402(pendingX402Payment.id, 'deny');
  };

  const handleApproveGrant = async (pin?: string, webauthn?: boolean) => {
    if (pendingGrantRequest === null) return;
    await resolvePendingGrantRequest(pendingGrantRequest.id, 'approve', pin, webauthn);
  };

  const handleDenyGrant = async () => {
    if (pendingGrantRequest === null) return;
    await resolvePendingGrantRequest(pendingGrantRequest.id, 'deny');
  };

  // Reset onboarding state when vault state changes (e.g., after reset)
  useEffect(() => {
    if (vaultState === 'uninitialized') {
      setStep('welcome');
      setPhrase(null);
      setPhraseRevealed(false);
      setPhraseCopied(false);
      setPassphrase1('');
      setPassphrase2('');
      setPassphraseError(null);
      setUnlockPassphrase('');
      setUnlockError(null);
      setResetConfirm(false);
    }
  }, [vaultState]);

  const handleCreateWallet = async () => {
    const mnemonic = await generateMnemonic(256);
    if (mnemonic !== null) {
      setPhrase(mnemonic);
      setPhraseRevealed(false);
      setPhraseCopied(false);
      setStep('phrase');
    }
  };

  const handleCopyPhrase = () => {
    if (phrase !== null) {
      void navigator.clipboard.writeText(phrase);
      setPhraseCopied(true);
      setTimeout(() => setPhraseCopied(false), 2000);
    }
  };

  const handlePhraseRevealed = () => {
    setPhraseRevealed(true);
  };

  const handlePhraseConfirmed = () => {
    setStep('passphrase');
  };

  const handlePassphraseSubmit = async () => {
    setPassphraseError(null);

    // Matches the vault's authoritative minimum (src/core/vault/index.ts,
    // MIN_PASSPHRASE_LENGTH). The UI must not accept a passphrase the vault will
    // reject, or the create flow fails after the user submits.
    if (passphrase1.length < 10) {
      setPassphraseError(t('onboarding.passphraseMin'));
      return;
    }
    if (passphrase1 !== passphrase2) {
      setPassphraseError(t('onboarding.passphraseMismatch'));
      return;
    }
    if (phrase === null) {
      setPassphraseError(t('onboarding.noPhrase'));
      return;
    }

    const ok = await createVault(phrase, passphrase1);
    if (ok) {
      setStep('success');
      setPassphrase1('');
      setPassphrase2('');
    }
  };

  const handleFinishOnboarding = () => {
    // The vault is already unlocked at this point; 'complete' is a sentinel so
    // the success screen gives way to the account view.
    setStep('complete');
  };

  const handleUnlock = async () => {
    setUnlockError(null);
    if (unlockPassphrase.length === 0) {
      setUnlockError('Enter your passphrase.');
      return;
    }
    const ok = await unlock(unlockPassphrase);
    if (!ok) {
      setUnlockError('Wrong passphrase. Try again.');
      setUnlockPassphrase('');
      setUnlockAttempt((attempt) => attempt + 1);
    }
  };

  const handleReset = async () => {
    if (!resetConfirm) {
      setResetConfirm(true);
      return;
    }
    setResetConfirm(false);
    await reset();
  };

  const handleLock = async () => {
    await lock();
  };

  const [sendAccount, setSendAccount] = useState<AccountView | null>(null);

  const startSend = (idx: number) => {
    const acc = accounts[idx];
    if (acc === undefined) return;
    setSendAccount(acc);
    setSendTo('');
    setSendAmount('');
    setSendMemo('');
    setSendAsset(undefined);
    setSendToken(undefined);
    setSendFee(null);
    setSendDecimals(null);
    setSendSpendable(null);
    setSendStatus('fee');
    setSendHash(null);
    setSendPrivate(false);
    setSendReceiptTo(null);
    setView('send');
  };

  // Convert a Stellar asset selection into a TokenInput (for the unified send
  // path); native assets collapse to the generic `native` kind.
  const tokenFromAsset = (asset: StellarAssetInput | undefined): TokenInputType | undefined =>
    asset === undefined || asset.type === 'native'
      ? { kind: 'native' }
      : { kind: 'stellar-issued', code: asset.code, issuer: asset.issuer };

  // The current send form computes this token object once, from the per-chain
  // asset/token selection, so the estimate and the confirm always agree.
  // Wrapped in useCallback so its identity stays stable across renders that do
  // not change the estimate inputs — this prevents the debounced auto-estimate
  // effect from re-firing in a loop after each successful estimate.
  const handleSendFee = useCallback(
    async (token?: TokenInputType) => {
      if (sendAccount === null || sendTo.length === 0 || sendAmount.length === 0) return;
      const resolvedToken = token ?? sendToken ?? tokenFromAsset(sendAsset);
      try {
        const fee = await estimateTransfer(
          sendAccount.chain,
          sendAccount.index,
          sendTo,
          sendAmount,
          sendAsset,
          resolvedToken,
        );
        setSendFee(fee.feeNative);
        setSendDecimals(fee.decimals);
        setSendSpendable(fee.spendableBalance);
        setSendStatus('confirm');
      } catch {
        // error is surfaced via the store
      }
    },
    [sendAccount, sendTo, sendAmount, sendAsset, sendToken, estimateTransfer],
  );

  const handleSendConfirm = async (memo?: string, isPrivate?: boolean) => {
    if (sendAccount === null) return;
    setSendStatus('sending');
    try {
      const { hash, to, private: wasPrivate } = await sendTransfer(
        sendAccount.chain,
        sendAccount.index,
        sendTo,
        sendAmount,
        sendAsset,
        sendToken ?? tokenFromAsset(sendAsset),
        memo,
        isPrivate === true,
      );
      setSendHash(hash);
      // A private payment lands on a one-time address — the receipt must
      // show that, not the recipient's public address they typed.
      setSendReceiptTo(wasPrivate === true ? to : null);
      setSendStatus('done');
    } catch {
      setSendStatus('fee');
    }
  };

  const startReceive = (idx: number) => {
    setReceiveIdx(idx);
    setView('receive');
  };

  /**
   * A scanned/pasted recipient lands here from either ScanModal mount
   * (dashboard or send form). A payment URI contributes address + amount +
   * memo; plain text contributes the address alone. When entering the send
   * flow fresh (no account selected yet) the form is reset first, so the
   * URI's amount/memo are not clobbered by the reset.
   */
  const handleScanResult = (result: ParsedRecipient) => {
    const enteringFresh = sendAccount === null;
    if (enteringFresh) startSend(0);
    setSendTo(result.address);
    setSendAmount(
      enteringFresh || sendAmount.length === 0 ? (result.amount ?? '') : sendAmount,
    );
    setSendMemo(
      enteringFresh || sendMemo.length === 0 ? (result.memo ?? '') : sendMemo,
    );
    setView('send');
    setScanModalOpen(false);
  };

  const handleImportSubmit = async () => {
    setImportError(null);
    if (importPass1.length < 10) {
      setImportError('Passphrase must be at least 10 characters.');
      return;
    }
    if (importPass1 !== importPass2) {
      setImportError('Passphrases do not match.');
      return;
    }
    const ok = await createVault(importPhrase.trim(), importPass1);
    if (ok) {
      if (step === 'import') {
        // Onboarding import: show success screen, then let user proceed
        setStep('success');
      } else {
        setView('accounts');
        void loadAccounts();
      }
    } else {
      setImportError('Could not import wallet. Check the phrase.');
    }
  };

  // ── Loading (INITIAL BOOT ONLY) ─────────────────────────────────────────
  // Gate strictly to the boot state: once the user has picked an onboarding
  // step (create/import) the step's own component renders its progress, and the
  // page-level "Loading wallet…" spinner must NOT hijack it. Import never sets
  // `phrase`, so without the step guard an in-flight `createVault` would swap
  // the whole popup to the boot spinner.
  if (isLoading && vaultState === 'uninitialized' && phrase === null && step === 'welcome') {
    return (
      <main className="flex min-h-[600px] w-[400px] flex-col items-center justify-center gap-3 p-4">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-accent-500 border-t-transparent" />
        <p className="font-body text-sm text-content-secondary">{t('status.loadingWallet')}</p>
      </main>
    );
  }

  // ── Error state ──────────────────────────────────────────────────────────
  if (error && vaultState === 'uninitialized' && phrase === null) {
    return (
      <main className="flex min-h-[600px] w-[400px] flex-col items-center justify-center gap-4 p-4">
        <p className="font-body text-sm text-danger text-center">{error}</p>
        <div className="flex gap-2">
          <Button variant="secondary" onClick={() => refresh()}>
            Retry
          </Button>
          <Button variant="ghost" onClick={() => chrome.runtime.reload()}>
            Reload extension
          </Button>
        </div>
      </main>
    );
  }

  // ── Success (transient: after vault.create, before first unlock) ─────────
  // Must render before the vaultState === 'unlocked' branch so the success
  // screen shows even though the vault is now unlocked.
  if (step === 'success') {
    return (
      <main className="flex min-h-[600px] w-[400px] flex-col gap-4 p-4">
        <header className="flex items-baseline justify-between">
          <h1 className="font-display text-lg font-bold text-content-primary">{t('brand')}</h1>
          <span className="font-mono text-xs text-content-tertiary">{t('version')}</span>
        </header>

        <div className="flex flex-1 flex-col items-center justify-center gap-4">
          <div className="flex h-12 w-12 items-center justify-center rounded-full bg-success/20">
            <Icon name="check" className="h-6 w-6" />
          </div>
          <h2 className="font-display text-lg font-semibold text-content-primary">{t('onboarding.walletCreated')}</h2>
          <p className="font-body text-sm text-content-secondary text-center max-w-xs">
            {t('onboarding.walletCreatedHint')}
          </p>
          {/* One-time camera pre-grant: allow it here and every future QR scan
              starts instantly (Chrome remembers the grant for the extension). */}
          <div className="w-full max-w-xs">
            <CameraSetupCard />
          </div>
          <Button fullWidth onClick={handleFinishOnboarding}>
            {t('onboarding.continue')}
          </Button>
        </div>
      </main>
    );
  }

  // ── Pending dapp connection — takes over the popup so the user can approve ──
  if (vaultState === 'unlocked' && pendingConnection !== null) {
    return (
      <ConnectionApproval
        origin={pendingConnection.origin}
        requestedAccounts={pendingConnection.requestedAccounts}
        onApprove={handleApproveConnection}
        onReject={handleDenyConnection}
      />
    );
  }

  // ── Pending dapp transaction/signature — takes over the popup ───────────
  if (vaultState === 'unlocked' && pendingApproval !== null) {
    return (
      <TransactionApproval
        approval={pendingApproval}
        onApprove={handleApproveApproval}
        onReject={handleDenyApproval}
      />
    );
  }

  // ── Pending x402 payment — takes over the popup so the user can approve ──
  if (vaultState === 'unlocked' && pendingX402Payment !== null) {
    return (
      <X402Approval
        payment={pendingX402Payment}
        onApprove={handleApproveX402}
        onReject={handleDenyX402}
      />
    );
  }

  // ── Pending VAP grant request — takes over the popup so the user can decide ──
  if (vaultState === 'unlocked' && pendingGrantRequest !== null) {
    return (
      <GrantApproval
        request={pendingGrantRequest}
        onApprove={handleApproveGrant}
        onReject={handleDenyGrant}
      />
    );
  }

  const handleTabSelect = (tab: TacticalTab) => {
    if (tab === 'home') {
      setSelectedTx(null);
      setView('accounts');
    } else if (tab === 'send') {
      if (accounts.length === 0) return; // nothing to send from; stay put
      setSelectedTx(null);
      startSend(0);
    } else if (tab === 'scan') {
      setScanModalOpen(true);
    } else if (tab === 'receive') {
      if (accounts.length === 0) return; // no address to show; stay put
      setSelectedTx(null);
      startReceive(0);
    } else if (tab === 'settings') {
      void chrome.runtime.openOptionsPage();
    }
  };

  // ── Unlocked — send / receive / accounts / import / receipt ────────────
  if (vaultState === 'unlocked') {
    if (selectedTx !== null) {
      const decimals = nativeDecimalsFor(selectedTx.chain);
      const symbol = selectedTx.chain === 'stellar' ? 'XLM' : selectedTx.chain === 'solana' ? 'SOL' : 'ETH';
      // Direction is derived from the wallet's own addresses: an incoming
      // payment must render as a credit, not a debit.
      const ownedAddresses = new Set(accounts.map((a) => a.address));
      const direction: 'sent' | 'received' =
        ownedAddresses.has(selectedTx.to) && !ownedAddresses.has(selectedTx.from)
          ? 'received'
          : 'sent';
      let amountFormatted = selectedTx.amount;
      try {
        amountFormatted = baseToDecimal(BigInt(selectedTx.amount), decimals, 6);
      } catch {
        amountFormatted = selectedTx.amount;
      }

      return (
        <TransactionReceiptView
          receipt={{
            hash: selectedTx.hash,
            chain: selectedTx.chain,
            from: selectedTx.from,
            to: selectedTx.to,
            amount: amountFormatted,
            symbol,
            networkName: networkLabel(selectedTx.chain, networks, selectedNetworks).toUpperCase(),
            timestamp: selectedTx.timestamp,
            status: selectedTx.status === 'confirmed' ? 'completed' : selectedTx.status,
            direction,
          }}
          onBack={() => setSelectedTx(null)}
        />
      );
    }

    if (view === 'send') {
      return (
        <>
          <SendForm
            account={sendAccount ?? accounts[0]!}
            sendTo={sendTo}
            sendAmount={sendAmount}
            sendMemo={sendMemo}
            sendAsset={sendAsset}
            sendToken={sendToken}
            sendFee={sendFee}
            sendDecimals={sendDecimals}
            sendSpendable={sendSpendable}
            sendStatus={sendStatus}
            sendHash={sendHash}
            sendPrivate={sendPrivate}
            sendReceiptTo={sendReceiptTo}
            isLoading={isLoading}
            error={error}
            onToChange={setSendTo}
            onAmountChange={setSendAmount}
            onMemoChange={setSendMemo}
            onPrivateChange={setSendPrivate}
            onAssetChange={setSendAsset}
            onTokenChange={setSendToken}
            onEstimate={handleSendFee}
            onConfirm={() => void handleSendConfirm(sendMemo, sendPrivate)}
            onBack={() => setView('accounts')}
            onClearError={clearError}
            onOpenScan={() => setScanModalOpen(true)}
            onTabSelect={handleTabSelect}
          />
          {/* Mounted here too: the form's camera button must actually open
              the scanner, not just flip a flag no modal was listening to. */}
          <ScanModal
            isOpen={scanModalOpen}
            onClose={() => setScanModalOpen(false)}
            onScanResult={handleScanResult}
          />
        </>
      );
    }
    if (view === 'receive') {
      const acc = accounts[receiveIdx];
      if (acc === undefined) return null;
      return (
        <ReceiveView
          account={acc}
          onBack={() => setView('accounts')}
          onTabSelect={handleTabSelect}
        />
      );
    }
    if (view === 'import') {
      return (
        <ImportWallet
          importPhrase={importPhrase}
          importPass1={importPass1}
          importPass2={importPass2}
          importError={importError}
          isLoading={isLoading}
          onPhraseChange={setImportPhrase}
          onPass1Change={setImportPass1}
          onPass2Change={setImportPass2}
          onSubmit={handleImportSubmit}
          onBack={() => setView('accounts')}
        />
      );
    }
    if (view === 'privacy') {
      return <PrivacyView onBack={() => setView('accounts')} />;
    }

    // Default: Dashboard matching Screenshot 1 & 2
    return (
      <main className="flex min-h-[600px] w-[400px] flex-col bg-surface-900 text-content-primary">
        {/* Top Header matching Screenshot 1 */}
        <header className="flex shrink-0 items-center justify-between border-b border-surface-800/80 px-4 py-3">
          <div className="flex items-center gap-2">
            <BrandLogo size="md" className="h-6 w-6" />
            <h1 className="font-display text-base font-extrabold tracking-wider text-white uppercase">
              {t('brand')}
            </h1>
          </div>

          <div className="flex items-center gap-2">
            {/* Session countdown: the live minutes remaining in the 15-minute
                unlock window, so the auto-lock is visible instead of a
                surprise. Hidden while the store has no deadline. */}
            {unlockedUntil !== null && (
              <span
                className="flex items-center gap-1 rounded-lg border border-surface-700/80 bg-surface-800/80 px-2 py-1 font-mono text-[10px] text-content-tertiary"
                title="Time until the wallet auto-locks"
              >
                <Glyph name="lock" className="h-3 w-3 text-accent-500/70" />
                {formatMinutesRemaining(unlockedUntil, nowMs)}
              </span>
            )}

            {/* Account pill */}
            <div className="flex items-center gap-1.5 rounded-lg border border-surface-700/80 bg-surface-800/80 px-2.5 py-1 text-xs font-mono text-content-primary">
              <Glyph name="user" className="h-3.5 w-3.5 text-accent-500" />
              <span>Account 1</span>
              <Glyph name="chevron-down" className="h-3 w-3 text-content-tertiary" />
            </div>

            {/* Sunburst Settings button */}
            <button
              type="button"
              onClick={() => void chrome.runtime.openOptionsPage()}
              aria-label="Settings"
              className="rounded-lg p-1 text-content-secondary hover:bg-surface-800 hover:text-white transition-colors"
            >
              <Glyph name="sun" className="h-4 w-4" />
            </button>
          </div>
        </header>

        {/* Scrollable Main Surface */}
        <div className="flex-1 overflow-y-auto px-4 py-3 flex flex-col gap-3">
          <TestnetBanner />

          {/* Dismissible camera pre-grant — hidden once granted or dismissed. */}
          <CameraSetupCard />

          <Dashboard
            accounts={accounts}
            onSend={startSend}
            onReceive={startReceive}
            onImport={() => setView('import')}
            onLock={handleLock}
            onScan={() => setScanModalOpen(true)}
            onSelectTx={(tx) => setSelectedTx(tx)}
            onSeeAllActivity={() => void chrome.runtime.openOptionsPage()}
            onPrivacy={() => setView('privacy')}
          />

          <ZkResult capability={zkCapability} />
        </div>

        {/* Tactical Bottom Navigation Bar */}
        <TacticalBottomNav activeTab="home" onSelectTab={handleTabSelect} />

        {/* Tactical QR Scan Modal */}
        <ScanModal
          isOpen={scanModalOpen}
          onClose={() => setScanModalOpen(false)}
          onScanResult={handleScanResult}
        />
      </main>
    );
  }

  // ── Locked — unlock screen ──────────────────────────────────────────────
  if (vaultState === 'locked') {
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

        <div className="flex flex-1 flex-col items-center justify-center gap-4">
          <div className="relative flex h-14 w-14 items-center justify-center">
            <span aria-hidden className="absolute inset-0 animate-pulse-ring rounded-full bg-accent-500/25" />
            <div className="relative flex h-12 w-12 animate-pop-in items-center justify-center rounded-2xl border border-surface-600 bg-surface-700">
              <Icon name="lock" className="h-6 w-6" />
            </div>
          </div>
          <p className="font-body text-sm text-content-secondary">{t('wallet.locked')}</p>

          <div className="w-full max-w-xs animate-fade-in-up">
            <div
              key={unlockAttempt}
              className={unlockError !== null ? 'animate-shake' : undefined}
            >
              <Input
                type="password"
                label={t('wallet.passphrase')}
                placeholder={t('wallet.passphrase')}
                value={unlockPassphrase}
                onChange={(e) => {
                  setUnlockPassphrase(e.target.value);
                  setUnlockError(null);
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void handleUnlock();
                }}
                error={unlockError ?? null}
                passwordToggle
                autoFocus
                disabled={isLoading}
              />
            </div>
          </div>

          <Button
            fullWidth
            onClick={handleUnlock}
            disabled={isLoading || unlockPassphrase.length === 0}
          >
            {isLoading ? t('wallet.unlocking') : t('wallet.unlock')}
          </Button>

          {error && (
            <p className="font-body text-xs text-danger">{error}</p>
          )}

          <div className="flex gap-2">
            {resetConfirm ? (
              <>
                <p className="font-body text-xs text-danger">This cannot be undone.</p>
                <Button variant="danger" size="sm" onClick={handleReset}>
                  Confirm reset
                </Button>
                <Button variant="ghost" size="sm" onClick={() => setResetConfirm(false)}>
                  Cancel
                </Button>
              </>
            ) : (
              <Button variant="ghost" size="sm" onClick={handleReset}>
                Reset wallet
              </Button>
            )}
          </div>
        </div>
      </main>
    );
  }

  // ── Onboarding flows ────────────────────────────────────────────────────

  // Import flow (from welcome screen)
  if (step === 'import') {
    return (
      <ImportWallet
        importPhrase={importPhrase}
        importPass1={importPass1}
        importPass2={importPass2}
        importError={importError}
        isLoading={isLoading}
        onPhraseChange={setImportPhrase}
        onPass1Change={setImportPass1}
        onPass2Change={setImportPass2}
        onSubmit={handleImportSubmit}
        onBack={() => setStep('welcome')}
      />
    );
  }

  // Step 3: Passphrase
  if (step === 'passphrase') {
    return (
      <main className="flex min-h-[600px] w-[400px] flex-col gap-4 p-4 animate-fade-in-up">
        <header className="flex items-baseline justify-between">
          <h1 className="font-display text-lg font-bold text-content-primary">{t('brand')}</h1>
          <span className="font-mono text-xs text-content-tertiary">{t('version')}</span>
        </header>

        <div className="flex flex-1 flex-col gap-4">
          <h2 className="font-display text-base font-semibold text-content-primary">
            {t('onboarding.setPassphrase')}
          </h2>
          <p className="font-body text-xs text-content-secondary">
            {t('onboarding.passphraseHint')}
          </p>

          <div className="flex flex-col gap-3">
            <Input
              type="password"
              label="Passphrase (min. 10 characters)"
              placeholder="Passphrase (min. 10 characters)"
              value={passphrase1}
              onChange={(e) => {
                setPassphrase1(e.target.value);
                setPassphraseError(null);
              }}
              passwordToggle
              disabled={isLoading}
            />
            <Input
              type="password"
              label="Confirm passphrase"
              placeholder="Confirm passphrase"
              value={passphrase2}
              onChange={(e) => {
                setPassphrase2(e.target.value);
                setPassphraseError(null);
              }}
              passwordToggle
              error={passphraseError ?? null}
              disabled={isLoading}
            />
          </div>

          <div className="flex gap-2">
            <Button variant="secondary" onClick={() => setStep('phrase')} disabled={isLoading}>
              {t('common.back')}
            </Button>
            <Button
              fullWidth
              onClick={handlePassphraseSubmit}
              disabled={isLoading || passphrase1.length === 0 || passphrase2.length === 0}
            >
              {isLoading ? t('onboarding.creating') : t('onboarding.create')}
            </Button>
          </div>
        </div>
      </main>
    );
  }

  // Step 2: Phrase display
  if (step === 'phrase' && phrase !== null) {
    const words = phrase.split(' ');

    return (
      <main className="flex min-h-[600px] w-[400px] flex-col gap-4 p-4 animate-fade-in-up">
        <header className="flex items-baseline justify-between">
          <h1 className="font-display text-lg font-bold text-content-primary">{t('brand')}</h1>
          <span className="font-mono text-xs text-content-tertiary">{t('version')}</span>
        </header>

        <div className="flex flex-1 flex-col gap-4">
          <h2 className="font-display text-base font-semibold text-content-primary">
            {t('onboarding.recoveryPhrase')}
          </h2>
          <p className="font-body text-xs text-content-secondary">
            {t('onboarding.phraseHint')}
          </p>

          {!phraseRevealed ? (
            <div className="flex flex-col items-center gap-3 py-4">
              <p className="font-body text-sm text-content-secondary text-center">
                {t('onboarding.phrasePrivacy')}
              </p>
              <Button variant="primary" onClick={handlePhraseRevealed}>
                {t('onboarding.revealPhrase')}
              </Button>
            </div>
          ) : (
            <>
              <Card className="!bg-surface-900">
                <div className="grid grid-cols-2 gap-x-4 gap-y-2">
                  {words.map((word, i) => (
                    <div
                      key={i}
                      className="flex items-center gap-2 font-mono text-sm"
                    >
                      <span className="text-content-tertiary w-6 text-right text-xs">
                        {i + 1}
                      </span>
                      <span className="text-content-primary">{word}</span>
                    </div>
                  ))}
                </div>
              </Card>

              <div className="flex gap-2">
                <Button variant="secondary" onClick={handleCopyPhrase}>
                  {phraseCopied ? 'Copied!' : t('common.copy')}
                </Button>
                <Button
                  variant="danger"
                  fullWidth
                  onClick={() => {
                    setPhrase(null);
                    setStep('welcome');
                  }}
                >
                  {t('onboarding.startOver')}
                </Button>
              </div>

              <div className="mt-auto">
                <Button fullWidth onClick={handlePhraseConfirmed}>
                  {t('onboarding.savedPhrase')}
                </Button>
              </div>
            </>
          )}
        </div>
      </main>
    );
  }

  // Step 1: Welcome
  return (
    <main className="flex min-h-[600px] w-[400px] flex-col gap-3 p-4 animate-fade-in-up">
      <header className="flex items-baseline justify-between">
        <h1 className="font-display text-lg font-bold text-content-primary">{t('brand')}</h1>
        <span className="font-mono text-xs text-content-tertiary">{t('version')}</span>
      </header>

      <TestnetBanner />

      <div className="flex flex-1 flex-col items-center justify-center gap-4">
        <div className="flex h-16 w-16 items-center justify-center overflow-hidden rounded-full bg-accent-500/20">
          <BrandLogo size="lg" />
        </div>
        <h2 className="font-display text-xl font-bold text-content-primary">
          {t('onboarding.welcome')}
        </h2>
        <p className="font-body text-sm text-content-secondary text-center max-w-xs">
          {t('onboarding.welcomeSubtitle')}
        </p>

        <Button fullWidth onClick={handleCreateWallet} disabled={isLoading}>
          {isLoading ? t('onboarding.generating') : t('onboarding.createWallet')}
        </Button>

        <Button variant="ghost" onClick={() => { setStep('import'); setImportPhrase(''); setImportPass1(''); setImportPass2(''); setImportError(null); }}>
          {t('onboarding.importExisting')}
        </Button>
      </div>

      <div className="mt-auto flex gap-2">
        <Button
          variant="ghost"
          size="sm"
          onClick={() => void chrome.runtime.openOptionsPage()}
        >
          {t('common.settings')}
        </Button>
      </div>
    </main>
  );
}

// ── ZK result card ───────────────────────────────────────────────────────

function ZkResult({ capability }: { capability: ZkCapability | null }) {
  if (capability === null) {
    return (
      <Card title="D3 — ZK capability">
        <p className="font-body text-xs text-content-tertiary">
          Not measured yet. The probe runs once in an offscreen document after install.
        </p>
      </Card>
    );
  }

  return (
    <Card title="D3 — ZK capability">
      <StatusRow
        label="Status"
        value={capability.status}
        tone={capability.status === 'viable' ? 'good' : 'neutral'}
      />
      <StatusRow
        label="WASM compile"
        value={capability.wasmCompileWorks ? 'works' : 'blocked'}
        tone={capability.wasmCompileWorks ? 'good' : 'bad'}
      />
      {capability.proofElapsedMs !== null && (
        <StatusRow
          label="Proof time"
          value={`${capability.proofElapsedMs} ms`}
          tone="neutral"
        />
      )}
      {capability.failureReason !== null && (
        <p className="mt-2 font-body text-xs text-content-tertiary">
          {capability.failureReason}
        </p>
      )}
    </Card>
  );
}

// ── Send form ───────────────────────────────────────────────────────────
const ESTIMATE_DEBOUNCE_MS = 400;

function decimalToBase(decimal: string, decimals: number): bigint {
  const dot = decimal.indexOf('.');
  const whole = dot === -1 ? decimal : decimal.slice(0, dot);
  const frac = dot === -1 ? '' : decimal.slice(dot + 1);
  const truncated = frac.slice(0, decimals).padEnd(decimals, '0');
  const scale = 10n ** BigInt(decimals);
  try {
    return BigInt(whole || '0') * scale + BigInt(truncated || '0');
  } catch {
    return 0n;
  }
}

function SendForm({
  account,
  sendTo,
  sendAmount,
  sendMemo,
  sendAsset,
  sendToken,
  sendFee,
  sendDecimals,
  sendSpendable,
  sendStatus,
  sendHash,
  sendPrivate,
  sendReceiptTo,
  isLoading,
  error,
  onToChange,
  onAmountChange,
  onMemoChange,
  onPrivateChange,
  onAssetChange,
  onTokenChange,
  onEstimate,
  onConfirm,
  onBack,
  onClearError,
  onOpenScan,
  onTabSelect,
}: {
  account: AccountView;
  sendTo: string;
  sendAmount: string;
  sendMemo: string;
  sendAsset: StellarAssetInput | undefined;
  sendToken: TokenInputType | undefined;
  sendFee: string | null;
  sendDecimals: number | null;
  sendSpendable: string | null;
  sendStatus: 'fee' | 'confirm' | 'sending' | 'done';
  sendHash: string | null;
  sendPrivate: boolean;
  sendReceiptTo: string | null;
  isLoading: boolean;
  error: string | null;
  onToChange: (v: string) => void;
  onAmountChange: (v: string) => void;
  onMemoChange: (v: string) => void;
  onPrivateChange: (v: boolean) => void;
  onAssetChange: (a: StellarAssetInput | undefined) => void;
  onTokenChange: (t: TokenInputType | undefined) => void;
  onEstimate: (token?: TokenInputType) => Promise<void>;
  onConfirm: () => void;
  onBack: () => void;
  onClearError: () => void;
  onOpenScan?: () => void;
  onTabSelect?: (tab: TacticalTab) => void;
}) {
  const isStellar = account.chain === 'stellar';
  const nativeSymbol =
    account.chain === 'evm' ? 'ETH' : account.chain === 'solana' ? 'SOL' : 'XLM';
  const feeSymbol =
    account.chain === 'evm' ? 'Gwei' : account.chain === 'solana' ? 'lamports' : 'stroops';

  const { balances, networks, selectedNetworks, customTokens, fetchStealthMeta } = useWallet();
  // The live network name for this account's chain — mainnet or testnet,
  // whichever is selected. Receipts and headers must never hardcode TESTNET.
  const networkName = networkLabel(account.chain, networks, selectedNetworks).toUpperCase();
  const [addressBookOpen, setAddressBookOpen] = useState(false);
  const [tokenMenuOpen, setTokenMenuOpen] = useState(false);
  /** Tokens registered for THIS chain, from the add-token registry. */
  const chainTokens = customTokens.filter((tok) => tok.chain === account.chain);

  /** Whether the current selection is a manual, not-yet-identified token. */
  const isManualToken = isStellar
    ? sendAsset?.type === 'issued' &&
      (sendAsset.code.length === 0 || sendAsset.issuer.length === 0)
    : (sendToken?.kind === 'erc20' || sendToken?.kind === 'spl') &&
      ((sendToken.kind === 'erc20' && (sendToken.address?.length ?? 0) === 0) ||
        (sendToken.kind === 'spl' && (sendToken.mint?.length ?? 0) === 0));

  // Normalize selection into TokenInput
  const resolvedToken: TokenInputType | undefined = useMemo<TokenInputType | undefined>(
    () =>
      isStellar
        ? sendAsset === undefined || sendAsset.type === 'native'
          ? { kind: 'native' }
          : { kind: 'stellar-issued', code: sendAsset.code, issuer: sendAsset.issuer }
        : sendToken ?? { kind: 'native' },
    [isStellar, sendAsset, sendToken],
  );

  /** Whether the picker currently shows the chain's native asset. */
  const isNativeSelection =
    sendAsset === undefined || sendAsset.type === 'native'
      ? sendToken === undefined || sendToken.kind === 'native'
      : false;

  // Label: the registered token's symbol when a registry token is selected,
  // the asset code for Stellar issued assets, else the native symbol.
  const assetLabel =
    sendAsset?.type === 'issued'
      ? sendAsset.code
      : sendToken?.kind === 'erc20' || sendToken?.kind === 'spl'
        ? (() => {
            const id =
              sendToken.kind === 'erc20'
                ? sendToken.address.toLowerCase()
                : sendToken.mint;
            return (
              customTokens.find(
                (tok) => tok.address !== undefined && tok.address.toLowerCase() === id,
              )?.symbol ?? 'Token'
            );
          })()
        : nativeSymbol;

  // Auto-estimate
  const ready =
    sendTo.length > 0 &&
    sendAmount.length > 0 &&
    resolvedToken !== undefined &&
    (resolvedToken.kind !== 'stellar-issued' || (sendAsset?.type === 'issued' && sendAsset.code.length > 0 && sendAsset.issuer.length > 0)) &&
    (resolvedToken.kind !== 'erc20' || (resolvedToken.address?.length ?? 0) > 0) &&
    (resolvedToken.kind !== 'spl' || (resolvedToken.mint?.length ?? 0) > 0);

  useEffect(() => {
    if (!ready || sendStatus === 'sending' || sendStatus === 'done') return;
    const id = window.setTimeout(() => {
      void onEstimate(resolvedToken);
    }, ESTIMATE_DEBOUNCE_MS);
    return () => window.clearTimeout(id);
  }, [sendTo, sendAmount, resolvedToken, ready, sendStatus, onEstimate]);

  const insufficientBalance =
    sendDecimals !== null && sendSpendable !== null && sendFee !== null && sendAmount.length > 0
      ? (() => {
          const base = decimalToBase(sendAmount, sendDecimals);
          const spendable = (() => {
            try {
              return BigInt(sendSpendable);
            } catch {
              return 0n;
            }
          })();
          const isNative = sendToken === undefined || sendToken.kind === 'native';
          const fee = isNative
            ? (() => {
                try {
                  return BigInt(sendFee);
                } catch {
                  return 0n;
                }
              })()
            : 0n;
          return base + fee > spendable;
        })()
      : false;

  // ── Stellar privacy payments (pXLM stealth) ─────────────────────────────
  // The toggle exists only for Stellar native XLM: an issued asset can never
  // ride a one-time CREATE_ACCOUNT, and other chains have no stealth layer.
  const privacyAvailable = isStellar && (sendToken === undefined || sendToken.kind === 'native');

  // The selection can change under a live toggle (user picks an issued asset
  // or an ERC-20) — drop private mode the moment it becomes impossible.
  useEffect(() => {
    if (!privacyAvailable && sendPrivate) onPrivateChange(false);
  }, [privacyAvailable, sendPrivate, onPrivateChange]);

  /** Whether the recipient looks like a Stellar G… strkey worth checking. */
  const recipientLooksStellar = /^G[A-Z2-7]{55}$/.test(sendTo.trim());
  const [recipientPrivacy, setRecipientPrivacy] = useState<
    'unknown' | 'checking' | 'available' | 'unavailable'
  >('unknown');

  // Look the recipient's published meta-address up (read-only) so the form
  // can say WHY private mode is unavailable instead of failing at send time.
  useEffect(() => {
    if (!sendPrivate || !recipientLooksStellar) {
      setRecipientPrivacy('unknown');
      return;
    }
    let cancelled = false;
    setRecipientPrivacy('checking');
    void fetchStealthMeta(sendTo.trim()).then((meta) => {
      if (cancelled) return;
      setRecipientPrivacy(meta !== null ? 'available' : 'unavailable');
    });
    return () => {
      cancelled = true;
    };
  }, [sendPrivate, recipientLooksStellar, sendTo, fetchStealthMeta]);

  /** A private send needs a recipient that actually published a meta-address. */
  const privateBlocked =
    sendPrivate &&
    (recipientPrivacy === 'unavailable' ||
      (sendTo.trim().length > 0 && !recipientLooksStellar));

  const disableSend =
    isLoading ||
    sendStatus === 'sending' ||
    sendTo.length === 0 ||
    sendAmount.length === 0 ||
    ready === false ||
    insufficientBalance ||
    privateBlocked;

  // ── Real available balance ──────────────────────────────────────────────
  // The estimate's spendable is authoritative once present (token-aware, and
  // exactly what the backend checks before signing). Before that: the live
  // store balance, but only for the native token — the native balance says
  // nothing about an ERC20/SPL/issued balance, so those show "—" until the
  // estimate fills it in. Never a placeholder constant.
  const isNativeToken = resolvedToken === undefined || resolvedToken.kind === 'native';
  const estimateKnown = sendSpendable !== null && sendDecimals !== null;
  const storeBalance = balances[`${account.chain}:${account.address}`] ?? 0n;
  const spendableBase = estimateKnown
    ? BigInt(sendSpendable!)
    : isNativeToken
      ? storeBalance
      : null;
  const spendableDecimals = sendDecimals ?? nativeDecimalsFor(account.chain);
  const spendableDisplay =
    spendableBase !== null ? baseToDecimal(spendableBase, spendableDecimals, 6) : null;

  // Percentage / MAX pre-fills, computed with exact bigint math on the same
  // spendable the backend enforces. MAX reserves the network fee for native
  // sends (fee is drawn from the same balance); token sends take the full
  // token balance (the fee is paid from native separately).
  const feeBase = isNativeToken && sendFee !== null ? (() => { try { return BigInt(sendFee); } catch { return 0n; } })() : 0n;

  const handlePercentage = (percent: 'max' | number) => {
    if (spendableBase === null) return;
    let base: bigint;
    if (percent === 'max') {
      base = spendableBase > feeBase ? spendableBase - feeBase : 0n;
    } else {
      base = (spendableBase * BigInt(Math.round(percent * 100))) / 100n;
    }
    onAmountChange(baseToDecimal(base, spendableDecimals, spendableDecimals));
    onClearError();
  };

  const handlePasteAddress = async () => {
    try {
      const text = await navigator.clipboard.readText();
      if (text.trim().length > 0) {
        onToChange(text.trim());
        onClearError();
      }
    } catch {
      // Ignore
    }
  };

  if (sendStatus === 'done' && sendHash !== null) {
    return (
      <div className="relative">
        <span className="sr-only">Sent!</span>
        <TransactionReceiptView
          receipt={{
            hash: sendHash,
            chain: account.chain,
            from: account.address,
            // A private payment's real destination is the one-time address
            // the background derived — show that, not the typed recipient.
            to: sendReceiptTo ?? sendTo,
            amount: sendAmount,
            symbol: assetLabel,
            networkName,
            timestamp: new Date().toISOString(),
          }}
          onBack={onBack}
        />
      </div>
    );
  }

  return (
    <main className="flex min-h-[600px] w-[400px] flex-col bg-surface-900 text-content-primary animate-fade-in-up">
      {/* Top Header matching Screenshot 4 */}
      <header className="flex shrink-0 items-center justify-between border-b border-surface-800/80 px-4 py-3">
        <button
          type="button"
          onClick={onBack}
          aria-label="Back"
          className="flex items-center gap-1.5 font-mono text-xs font-semibold text-content-secondary hover:text-white transition-colors"
        >
          <Glyph name="arrow-left" className="h-4 w-4" />
          <span>BACK</span>
        </button>

        <h1 className="font-display text-sm font-bold tracking-widest text-white uppercase">
          SEND PAYMENT
        </h1>

        <div className="w-12" />
      </header>

      {/* Main Content Form */}
      <div className="flex-1 overflow-y-auto px-4 py-3 flex flex-col gap-3">
        {/* SENDING FROM Card matching Screenshot 4 */}
        <div className="rounded-xl border border-surface-700/80 bg-surface-800/80 p-3.5 shadow-raised flex flex-col gap-2">
          <div className="flex items-start justify-between">
            <div>
              <span className="font-mono text-[10px] tracking-wider text-content-tertiary uppercase">
                SENDING FROM
              </span>
              <span className="sr-only">Send from {account.chain} (#{account.index})</span>
              <div className="mt-0.5 font-display text-sm font-bold tracking-wider text-accent-500 uppercase">
                {networkName}
              </div>
            </div>
            <BrandLogo size="md" className="h-7 w-7" />
          </div>

          <div className="flex items-center justify-between border-t border-surface-700/60 pt-2 font-mono text-xs">
            <span className="text-content-tertiary">Available Balance</span>
            <span className="text-content-primary font-semibold">
              {spendableDisplay !== null ? `≈ ${spendableDisplay} ${assetLabel}` : '— (estimating…)'}
            </span>
          </div>
        </div>

        {/* Recipient Address Section matching Screenshot 4 */}
        <div>
          <label
            htmlFor="recipient-address"
            className="block font-mono text-[10px] font-semibold tracking-wider text-content-tertiary uppercase mb-1.5"
          >
            {assetLabel} RECIPIENT ADDRESS
          </label>
          <div className="relative">
            <input
              id="recipient-address"
              type="text"
              placeholder="Recipient address"
              aria-label="Recipient address"
              value={sendTo}
              onChange={(e) => {
                onToChange(e.target.value);
                onClearError();
              }}
              disabled={isLoading || sendStatus === 'sending'}
              className="w-full rounded-xl border border-surface-700 bg-surface-800/90 px-3 py-2.5 pr-24 font-mono text-xs text-content-primary placeholder:text-content-tertiary focus:border-accent-500 outline-none"
            />
            <div className="absolute right-2 top-1/2 -translate-y-1/2 flex items-center gap-1.5 text-accent-500">
              <button
                type="button"
                onClick={() => setAddressBookOpen(true)}
                aria-label="Address book"
                title="Address book"
                className="p-1 hover:text-accent-400 transition-colors"
              >
                <Glyph name="card" className="h-4 w-4" />
              </button>
              <button
                type="button"
                onClick={onOpenScan}
                aria-label="Scan QR"
                title="Scan QR"
                className="p-1 hover:text-accent-400 transition-colors"
              >
                <Glyph name="camera" className="h-4 w-4" />
              </button>
              <button
                type="button"
                onClick={handlePasteAddress}
                aria-label="Paste address"
                title="Paste address"
                className="p-1 hover:text-accent-400 transition-colors"
              >
                <Glyph name="copy" className="h-4 w-4" />
              </button>
            </div>
          </div>
        </div>

        {/* Asset / Token selection: the registered custom tokens (from
            "Add token") plus native, with a manual fallback for one-off
            sends. Selecting a registered token fills its address/issuer —
            no dead-end empty token. */}
        <div className="relative">
          <button
            type="button"
            onClick={() => setTokenMenuOpen((v) => !v)}
            aria-expanded={tokenMenuOpen}
            aria-label={`Select token, current ${assetLabel}`}
            className="flex w-full items-center justify-between rounded-xl border border-surface-700/80 bg-surface-800/80 px-3 py-2.5 text-left transition-colors hover:border-surface-600 active:scale-[0.99]"
          >
            <span className="flex items-center gap-2">
              <Glyph name="token" className="h-4 w-4 text-accent-500" />
              <span className="font-mono text-xs font-semibold text-content-primary">
                {assetLabel}
              </span>
              <span className="font-mono text-[10px] text-content-tertiary">
                {isNativeSelection ? `Native ${nativeSymbol}` : 'Token'}
              </span>
            </span>
            <Glyph
              name="chevron-down"
              className={`h-3.5 w-3.5 text-accent-500 transition-transform duration-base ease-smooth ${tokenMenuOpen ? 'rotate-180' : ''}`}
            />
          </button>

          {tokenMenuOpen && (
            <div
              className="absolute left-0 right-0 top-full z-30 mt-1 max-h-56 overflow-y-auto rounded-xl border border-surface-600 bg-surface-800 p-1.5 shadow-raised animate-pop-in"
              role="menu"
              aria-label="Tokens"
            >
              <button
                type="button"
                role="menuitemradio"
                aria-checked={isNativeSelection}
                onClick={() => {
                  onAssetChange(undefined);
                  onTokenChange(undefined);
                  onClearError();
                  setTokenMenuOpen(false);
                }}
                className={`flex w-full items-center justify-between rounded-lg px-3 py-2 text-xs font-mono transition-colors ${
                  isNativeSelection
                    ? 'bg-accent-500/15 font-semibold text-accent-400'
                    : 'text-content-secondary hover:bg-surface-700'
                }`}
              >
                <span>Native ({nativeSymbol})</span>
                <span className="text-[10px] text-content-tertiary">native</span>
              </button>

              {chainTokens.map((tok) => {
                const selected =
                  (tok.kind === 'erc20' && sendToken?.kind === 'erc20' && sendToken.address === tok.address) ||
                  (tok.kind === 'spl' && sendToken?.kind === 'spl' && sendToken.mint === tok.address) ||
                  (tok.kind === 'stellar-issued' &&
                    (sendToken?.kind === 'stellar-issued' || sendAsset?.type === 'issued') &&
                    sendAsset?.type === 'issued' &&
                    sendAsset.code === tok.code &&
                    sendAsset.issuer === tok.issuer);
                return (
                  <button
                    key={tok.id}
                    type="button"
                    role="menuitemradio"
                    aria-checked={selected}
                    onClick={() => {
                      if (tok.kind === 'stellar-issued') {
                        onAssetChange({ type: 'issued', code: tok.code!, issuer: tok.issuer! });
                        onTokenChange({ kind: 'stellar-issued', code: tok.code!, issuer: tok.issuer! });
                      } else if (tok.kind === 'erc20') {
                        onTokenChange({ kind: 'erc20', address: tok.address! });
                      } else {
                        onTokenChange({ kind: 'spl', mint: tok.address! });
                      }
                      onClearError();
                      setTokenMenuOpen(false);
                    }}
                    className={`flex w-full items-center justify-between rounded-lg px-3 py-2 text-xs font-mono transition-colors ${
                      selected
                        ? 'bg-accent-500/15 font-semibold text-accent-400'
                        : 'text-content-secondary hover:bg-surface-700'
                    }`}
                  >
                    <span>{tok.symbol}</span>
                    <span className="max-w-[9rem] truncate text-[10px] text-content-tertiary">
                      {tok.kind === 'stellar-issued'
                        ? `${tok.code} · ${tok.issuer!.slice(0, 8)}…`
                        : `${(tok.address ?? '').slice(0, 10)}…`}
                    </span>
                  </button>
                );
              })}

              <button
                type="button"
                role="menuitemradio"
                aria-checked={isManualToken}
                onClick={() => {
                  // Stellar flows through the legacy `asset` field (the
                  // normalized token is derived from it), so the manual
                  // selection seeds an empty issued asset there.
                  if (account.chain === 'stellar') {
                    onAssetChange({ type: 'issued', code: '', issuer: '' });
                    onTokenChange(undefined);
                  } else {
                    onTokenChange(
                      account.chain === 'evm'
                        ? { kind: 'erc20', address: '' }
                        : { kind: 'spl', mint: '' },
                    );
                  }
                  onClearError();
                  setTokenMenuOpen(false);
                }}
                className="flex w-full items-center justify-between rounded-lg px-3 py-2 text-xs font-mono text-content-secondary transition-colors hover:bg-surface-700"
              >
                <span>Other token…</span>
                <span className="text-[10px] text-content-tertiary">manual</span>
              </button>
            </div>
          )}
        </div>

        {/* Manual token entry — appears only for the "Other token…" selection:
            EVM/Solana take a contract/mint address, Stellar a code + issuer. */}
        {isManualToken && (
          <div className="flex flex-col gap-2 animate-fade-in-up">
            {isStellar ? (
              <>
                <div>
                  <label
                    htmlFor="manual-token-code"
                    className="block font-mono text-[10px] font-semibold tracking-wider text-content-tertiary uppercase mb-1"
                  >
                    ASSET CODE
                  </label>
                  <input
                    id="manual-token-code"
                    type="text"
                    placeholder="USDC"
                    maxLength={12}
                    value={sendAsset?.type === 'issued' ? sendAsset.code : ''}
                    onChange={(e) =>
                      onAssetChange({
                        type: 'issued',
                        code: e.target.value,
                        issuer: sendAsset?.type === 'issued' ? sendAsset.issuer : '',
                      })
                    }
                    disabled={isLoading || sendStatus === 'sending'}
                    className="w-full rounded-xl border border-surface-700 bg-surface-800/90 px-3 py-2 font-mono text-xs text-content-primary placeholder:text-content-tertiary focus:border-accent-500 outline-none"
                  />
                </div>
                <div>
                  <label
                    htmlFor="manual-token-issuer"
                    className="block font-mono text-[10px] font-semibold tracking-wider text-content-tertiary uppercase mb-1"
                  >
                    ISSUER ADDRESS
                  </label>
                  <input
                    id="manual-token-issuer"
                    type="text"
                    placeholder="G…"
                    value={sendAsset?.type === 'issued' ? sendAsset.issuer : ''}
                    onChange={(e) =>
                      onAssetChange({
                        type: 'issued',
                        code: sendAsset?.type === 'issued' ? sendAsset.code : '',
                        issuer: e.target.value,
                      })
                    }
                    disabled={isLoading || sendStatus === 'sending'}
                    className="w-full rounded-xl border border-surface-700 bg-surface-800/90 px-3 py-2 font-mono text-xs text-content-primary placeholder:text-content-tertiary focus:border-accent-500 outline-none"
                  />
                </div>
              </>
            ) : (
              <div>
                <label
                  htmlFor="manual-token-address"
                  className="block font-mono text-[10px] font-semibold tracking-wider text-content-tertiary uppercase mb-1"
                >
                  {account.chain === 'evm' ? 'ERC-20 CONTRACT ADDRESS' : 'SPL MINT ADDRESS'}
                </label>
                <input
                  id="manual-token-address"
                  type="text"
                  placeholder={account.chain === 'evm' ? '0x…' : 'Base58 mint'}
                  value={sendToken?.kind === 'erc20' ? sendToken.address : sendToken?.kind === 'spl' ? sendToken.mint : ''}
                  onChange={(e) =>
                    onTokenChange(
                      account.chain === 'evm'
                        ? { kind: 'erc20', address: e.target.value }
                        : { kind: 'spl', mint: e.target.value },
                    )
                  }
                  disabled={isLoading || sendStatus === 'sending'}
                  className="w-full rounded-xl border border-surface-700 bg-surface-800/90 px-3 py-2 font-mono text-xs text-content-primary placeholder:text-content-tertiary focus:border-accent-500 outline-none"
                />
              </div>
            )}
            <p className="font-mono text-[10px] text-content-tertiary">
              Tip: add the token once with "Add token" and it appears in this
              picker every time.
            </p>
          </div>
        )}

        {/* Amount Section matching Screenshot 4 */}
        <div>
          <div className="flex items-center justify-between mb-1.5">
            <label
              htmlFor="send-amount"
              className="font-mono text-[10px] font-semibold tracking-wider text-content-tertiary uppercase"
            >
              AMOUNT <span className="sr-only">Amount ({assetLabel})</span>
            </label>
          </div>

          <div className="flex items-center justify-between rounded-xl border border-surface-700 bg-surface-800/90 px-3 py-2.5">
            <input
              id="send-amount"
              type="text"
              inputMode="decimal"
              placeholder="0.00"
              aria-label={`Amount (${assetLabel})`}
              value={sendAmount}
              onChange={(e) => {
                onAmountChange(e.target.value);
                onClearError();
              }}
              disabled={isLoading || sendStatus === 'sending'}
              className="w-full bg-transparent font-display text-2xl font-bold text-white placeholder:text-content-tertiary outline-none"
            />
            <div className="flex shrink-0 items-center gap-1 rounded-lg bg-surface-700/80 px-2.5 py-1 font-mono text-xs font-bold text-accent-500">
              <span>{assetLabel}</span>
              <Glyph name="chevron-down" className="h-3 w-3" />
            </div>
          </div>
        </div>

        {/* Percentage Chips matching Screenshot 4.
            Real pre-fills from the live spendable; MAX reserves the network
            fee for native sends. Disabled until a real spendable is known. */}
        <div className="grid grid-cols-4 gap-2">
          {[
            { label: '25%', value: 0.25 },
            { label: '50%', value: 0.5 },
            { label: '75%', value: 0.75 },
            { label: 'MAX', value: 'max' as const },
          ].map((chip) => (
            <button
              key={chip.label}
              type="button"
              onClick={() => handlePercentage(chip.value)}
              disabled={spendableBase === null}
              className="rounded-lg border border-surface-700/80 bg-surface-800/80 py-1.5 font-mono text-xs font-semibold text-content-secondary transition-colors hover:border-accent-500/50 hover:text-white active:scale-95 disabled:opacity-40"
            >
              {chip.label}
            </button>
          ))}
        </div>

        {/* PRIVATE PAYMENT (Stellar stealth) — one-time address derived from
            the recipient's published meta-address; the payment is unlinkable
            on-chain. Only Stellar native XLM; issued assets and other chains
            hide the toggle entirely. */}
        {isStellar && (
          <div className="flex flex-col gap-1.5">
            <button
              type="button"
              role="switch"
              aria-checked={sendPrivate}
              aria-label="Private payment"
              disabled={!privacyAvailable || isLoading || sendStatus === 'sending'}
              onClick={() => {
                onPrivateChange(!sendPrivate);
                onClearError();
              }}
              className="flex items-center justify-between rounded-xl border border-surface-700/80 bg-surface-800/80 px-3 py-2.5 text-left transition-all hover:border-accent-500/40 disabled:opacity-40"
            >
              <span className="flex flex-col gap-0.5">
                <span className="flex items-center gap-1.5 font-mono text-[10px] font-semibold tracking-wider text-content-secondary uppercase">
                  <Glyph name="lock" className="h-3.5 w-3.5 text-accent-500" />
                  PRIVATE PAYMENT
                </span>
                <span className="font-mono text-[10px] text-content-tertiary">
                  One-time address · unlinkable
                </span>
              </span>
              <span
                aria-hidden
                className={`relative h-5 w-9 shrink-0 rounded-full transition-colors ${
                  sendPrivate ? 'bg-accent-500' : 'bg-surface-700'
                }`}
              >
                <span
                  className={`absolute top-0.5 h-4 w-4 rounded-full bg-white transition-all ${
                    sendPrivate ? 'left-[18px]' : 'left-0.5'
                  }`}
                />
              </span>
            </button>
            {sendPrivate && (
              <p
                className={`font-mono text-[10px] leading-relaxed ${
                  recipientPrivacy === 'available'
                    ? 'text-success'
                    : recipientPrivacy === 'unavailable'
                      ? 'text-warning'
                      : 'text-content-tertiary'
                }`}
              >
                {recipientPrivacy === 'checking' && 'Checking whether the recipient accepts private payments…'}
                {recipientPrivacy === 'available' &&
                  'Recipient accepts private payments — the amount lands on a fresh one-time address only they can unlock.'}
                {recipientPrivacy === 'unavailable' &&
                  'This recipient has not enabled private payments in Veilpay yet. Turn the toggle off to send normally.'}
                {recipientPrivacy === 'unknown' &&
                  'Pays a fresh one-time address derived from the recipient’s published privacy keys.'}
              </p>
            )}
          </div>
        )}

        {/* MEMO (OPTIONAL) — Stellar only (the only chain with transaction
            memos in this wallet), and actually sent: it is attached as
            MEMO_TEXT by the background's XDR builder. Hidden for private
            payments: the 32-byte announcement occupies MEMO_HASH. */}
        {isStellar && !sendPrivate && (
          <div>
            <label
              htmlFor="send-memo"
              className="block font-mono text-[10px] font-semibold tracking-wider text-content-tertiary uppercase mb-1.5"
            >
              MEMO (OPTIONAL) <span className="normal-case">· max 28 bytes</span>
            </label>
            <input
              id="send-memo"
              type="text"
              placeholder="Add a note for this transaction"
              aria-label="Memo"
              maxLength={28}
              value={sendMemo}
              onChange={(e) => {
                onMemoChange(e.target.value);
                onClearError();
              }}
              disabled={isLoading || sendStatus === 'sending'}
              className="w-full rounded-xl border border-surface-700 bg-surface-800/90 px-3 py-2 font-mono text-xs text-content-primary placeholder:text-content-tertiary focus:border-accent-500 outline-none"
            />
          </div>
        )}

        {/* Feedback: Fee, Insufficient Balance, Error */}
        {sendFee !== null && (
          <p className="font-mono text-xs text-content-secondary">
            Estimated fee: {sendFee} {feeSymbol}
          </p>
        )}

        {insufficientBalance && sendStatus === 'confirm' && (
          <p className="font-body text-xs text-danger">
            Insufficient balance for the amount{sendToken === undefined || sendToken.kind === 'native' ? ' plus fee' : ''}.
          </p>
        )}

        {error !== null && (
          <p className="font-body text-xs text-danger">{error}</p>
        )}

        {/* Main CTA button matching Screenshot 4 */}
        <div className="mt-auto pt-2">
          <Button
            fullWidth
            onClick={onConfirm}
            disabled={disableSend}
            aria-label="Send"
            className="py-3 font-mono text-xs font-bold uppercase tracking-wider bg-accent-500 text-surface-900 shadow-md hover:bg-accent-400 active:scale-98"
          >
            {isLoading ? 'Sending…' : 'CONTINUE'}
          </Button>
        </div>
      </div>

      {/* Tactical Bottom Navigation Bar */}
      <TacticalBottomNav activeTab="send" onSelectTab={onTabSelect ?? (() => {})} />

      {/* Address Book Picker — real saved entries for this chain */}
      <AddressBookPicker
        isOpen={addressBookOpen}
        chain={account.chain}
        onClose={() => setAddressBookOpen(false)}
        onSelect={(address) => {
          onToChange(address);
          onClearError();
        }}
      />
    </main>
  );
}

// ── Receive view matching Screenshot 5 ──────────────────────────────────
function ReceiveView({
  account,
  onBack,
  onTabSelect,
}: {
  account: AccountView;
  onBack: () => void;
  onTabSelect?: (tab: TacticalTab) => void;
}) {
  const {
    requestFaucet,
    networks,
    selectedNetworks,
    fetchStealthMeta,
    publishStealthMeta,
    scanStealthPayments,
    claimStealthPayment,
  } = useWallet();
  const [faucetState, setFaucetState] = useState<'idle' | 'loading' | 'success' | 'error'>('idle');
  const [faucetError, setFaucetError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [requestAmount, setRequestAmount] = useState('');
  const [linkCopied, setLinkCopied] = useState(false);

  // ── Stellar privacy payments (pXLM stealth) ─────────────────────────────
  // Receive-side surface: publish the meta-address other Veilpay payers use
  // to derive one-time addresses for this account, and scan/claim incoming
  // private payments.
  const isStellar = account.chain === 'stellar';
  const [privacyPublished, setPrivacyPublished] = useState<'unknown' | 'yes' | 'no'>('unknown');
  const [privacyBusy, setPrivacyBusy] = useState(false);
  const [privacyMsg, setPrivacyMsg] = useState<string | null>(null);
  const [privacyScan, setPrivacyScan] = useState<
    Array<{ txHash: string; oneTimeAddress: string; amountStroops: string; createdAt: string }>
  >([]);
  const [privacyScanning, setPrivacyScanning] = useState(false);
  const [claimingTx, setClaimingTx] = useState<string | null>(null);

  // Check the published state whenever the address or network changes.
  useEffect(() => {
    if (!isStellar) return;
    let cancelled = false;
    void fetchStealthMeta(account.address).then((meta) => {
      if (cancelled) return;
      setPrivacyPublished(meta !== null ? 'yes' : 'no');
    });
    return () => {
      cancelled = true;
    };
  }, [isStellar, account.address, fetchStealthMeta, selectedNetworks]);

  const handlePublishPrivacy = async () => {
    setPrivacyBusy(true);
    setPrivacyMsg(null);
    try {
      const result = await publishStealthMeta();
      setPrivacyPublished('yes');
      setPrivacyMsg(
        result.alreadyPublished
          ? 'Privacy meta-address already published.'
          : 'Privacy meta-address published — others can now pay you privately.',
      );
    } catch {
      // error surfaces via the store's error banner
    } finally {
      setPrivacyBusy(false);
    }
  };

  const handleScanPrivacy = async () => {
    setPrivacyScanning(true);
    setPrivacyMsg(null);
    try {
      const found = await scanStealthPayments();
      setPrivacyScan(found);
    } catch {
      // error surfaces via the store's error banner
    } finally {
      setPrivacyScanning(false);
    }
  };

  const handleClaimPrivacy = async (txHash: string) => {
    setClaimingTx(txHash);
    setPrivacyMsg(null);
    try {
      const { txHash: sweepHash } = await claimStealthPayment(txHash);
      setPrivacyMsg(`Claimed — sweep transaction ${sweepHash.slice(0, 12)}…`);
      // Re-scan so the claimed entry disappears from the list.
      const found = await scanStealthPayments().catch(() => null);
      if (found !== null) setPrivacyScan(found);
    } catch {
      // error surfaces via the store's error banner
    } finally {
      setClaimingTx(null);
    }
  };

  const nativeSymbol =
    account.chain === 'evm' ? 'ETH' : account.chain === 'solana' ? 'SOL' : 'XLM';
  // The live selected network — the warning box must name the real network
  // the funds arrive on, not a hardcoded testnet.
  const networkSummary = networkFor(account.chain, networks, selectedNetworks);
  const networkName = networkLabel(account.chain, networks, selectedNetworks).toUpperCase();
  const faucetAvailable = networkSummary?.faucet ?? false;

  const handleCopy = () => {
    void navigator.clipboard.writeText(account.address);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleShare = async () => {
    if (navigator.share) {
      try {
        await navigator.share({
          title: 'My Veilpay Address',
          text: account.address,
        });
        return;
      } catch {
        // Fallback
      }
    }
    handleCopy();
  };

  const handleShareLink = () => {
    const payUri = `${account.chain}:${account.address}${requestAmount ? `?amount=${requestAmount}` : ''}`;
    void navigator.clipboard.writeText(payUri);
    setLinkCopied(true);
    setTimeout(() => setLinkCopied(false), 2000);
  };

  const handleFaucet = async () => {
    setFaucetState('loading');
    setFaucetError(null);
    const result = await requestFaucet(account.chain, account.address);
    if (result.ok && result.faucetUrl !== undefined) {
      if (typeof chrome.tabs?.create === 'function') {
        void chrome.tabs.create({ url: result.faucetUrl });
      } else {
        window.open(result.faucetUrl, '_blank', 'noopener,noreferrer');
      }
      setFaucetState('success');
    } else if (result.ok) {
      setFaucetState('success');
    } else {
      setFaucetState('error');
      setFaucetError(result.error ?? 'Could not request testnet funds.');
    }
  };

  return (
    <main className="flex min-h-[600px] w-[400px] flex-col bg-surface-900 text-content-primary animate-fade-in-up">
      {/* Top Header matching Screenshot 5 */}
      <header className="flex shrink-0 items-center justify-between border-b border-surface-800/80 px-4 py-3">
        <button
          type="button"
          onClick={onBack}
          aria-label="Back"
          className="flex items-center gap-1.5 font-mono text-xs font-semibold text-content-secondary hover:text-white transition-colors"
        >
          <Glyph name="arrow-left" className="h-4 w-4" />
          <span>BACK</span>
        </button>

        <h1 className="font-display text-sm font-bold tracking-widest text-white uppercase">
          RECEIVE
        </h1>

        <div className="w-12" />
      </header>

      {/* Main Content */}
      <div className="flex-1 overflow-y-auto px-4 py-3 flex flex-col gap-3">
        {/* Network Banner matching Screenshot 5 */}
        <div className="flex items-center justify-center gap-2 py-1">
          <BrandLogo size="md" className="h-6 w-6" />
          <span className="font-display text-sm font-bold tracking-wider text-accent-500 uppercase">
            {networkName}
          </span>
        </div>

        {/* Big QR Code Card matching Screenshot 5 */}
        <div className="flex items-center justify-center rounded-2xl border border-surface-700/80 bg-surface-800/80 p-5 shadow-raised">
          <div className="rounded-xl bg-white p-3 shadow-md">
            <QRCode value={account.address} size={200} />
          </div>
        </div>

        {/* Warning Box matching Screenshot 5 */}
        <div className="flex items-start gap-2.5 rounded-xl border border-accent-500/40 bg-accent-500/5 p-3">
          <Glyph name="alert" className="h-4 w-4 text-accent-500 shrink-0 mt-0.5" />
          <p className="font-mono text-[11px] leading-relaxed text-content-secondary">
            Ensure you only send <span className="text-white font-semibold">{nativeSymbol}</span> to this address via the <span className="text-accent-400 font-semibold">{networkName}</span> network.
          </p>
        </div>

        {/* YOUR ADDRESS Card matching Screenshot 5 */}
        <div>
          <span className="block font-mono text-[10px] font-semibold tracking-wider text-content-tertiary uppercase mb-1.5">
            YOUR ADDRESS
          </span>
          <div className="rounded-xl border border-surface-700 bg-surface-800/90 p-3 font-mono text-xs text-content-primary break-all text-center select-all">
            {account.address}
          </div>

          <div className="mt-2 flex gap-2">
            <button
              type="button"
              onClick={handleCopy}
              className="flex flex-1 items-center justify-center gap-2 rounded-xl border border-surface-700 bg-surface-800/80 py-2.5 font-mono text-xs font-bold text-accent-500 transition-colors hover:bg-surface-700 active:scale-95"
            >
              <Glyph name={copied ? 'check' : 'copy'} className="h-4 w-4" />
              <span>{copied ? 'COPIED' : 'COPY'}</span>
            </button>

            <button
              type="button"
              onClick={handleShare}
              className="flex flex-1 items-center justify-center gap-2 rounded-xl border border-surface-700 bg-surface-800/80 py-2.5 font-mono text-xs font-bold text-accent-500 transition-colors hover:bg-surface-700 active:scale-95"
            >
              <Glyph name="share" className="h-4 w-4" />
              <span>SHARE</span>
            </button>
          </div>
        </div>

        {/* REQUEST SPECIFIC AMOUNT matching Screenshot 5 */}
        <div>
          <label
            htmlFor="receive-amount"
            className="block font-mono text-[10px] font-semibold tracking-wider text-content-tertiary uppercase mb-1.5"
          >
            REQUEST SPECIFIC AMOUNT
          </label>
          <div className="flex items-center justify-between rounded-xl border border-surface-700 bg-surface-800/90 px-3 py-2">
            <input
              id="receive-amount"
              type="text"
              inputMode="decimal"
              placeholder="0.00"
              value={requestAmount}
              onChange={(e) => setRequestAmount(e.target.value)}
              className="w-full bg-transparent font-mono text-sm text-content-primary placeholder:text-content-tertiary outline-none"
            />
            <span className="font-mono text-xs font-bold text-accent-500 ml-2">
              {nativeSymbol}
            </span>
          </div>
        </div>

        {/* SHARE RECEIVE LINK button matching Screenshot 5 */}
        <button
          type="button"
          onClick={handleShareLink}
          className="w-full rounded-xl border border-surface-600 bg-surface-800 py-3 font-mono text-xs font-bold tracking-wider text-white transition-colors hover:bg-surface-700 active:scale-98 uppercase"
        >
          {linkCopied ? 'LINK COPIED TO CLIPBOARD' : 'SHARE RECEIVE LINK'}
        </button>

        {/* Get testnet funds / faucet option — only networks that have one */}
        {faucetAvailable && (
          <div className="mt-1">
            <Button
              fullWidth
              variant="secondary"
              onClick={handleFaucet}
              disabled={faucetState === 'loading'}
            >
              {faucetState === 'loading' ? 'Requesting testnet funds…' : 'Get testnet funds'}
            </Button>
            {faucetState === 'success' && (
              <p className="mt-1.5 font-mono text-[11px] text-success text-center">
                Funds requested successfully!
              </p>
            )}
            {faucetState === 'error' && (
              <p className="mt-1.5 font-mono text-[11px] text-danger text-center">{faucetError}</p>
            )}
          </div>
        )}
        {!faucetAvailable && (
          <p className="mt-1 font-mono text-[11px] leading-relaxed text-content-tertiary text-center">
            This is a live network — send real {nativeSymbol} to this address.
          </p>
        )}

        {/* ── Private payments (Stellar stealth) ───────────────────────────
            Publish the meta-address payers derive one-time addresses from,
            and scan + claim incoming private payments. */}
        {isStellar && (
          <div className="flex flex-col gap-2 rounded-2xl border border-surface-700/60 bg-surface-800/70 p-3.5 animate-fade-in-up">
            <div className="flex items-center justify-between">
              <span className="flex items-center gap-1.5 font-mono text-[10px] font-semibold tracking-wider text-content-secondary uppercase">
                <Glyph name="lock" className="h-3.5 w-3.5 text-accent-500" />
                PRIVATE PAYMENTS
              </span>
              <span
                className={`font-mono text-[10px] font-semibold ${
                  privacyPublished === 'yes' ? 'text-success' : 'text-content-tertiary'
                }`}
              >
                {privacyPublished === 'yes'
                  ? 'ENABLED'
                  : privacyPublished === 'no'
                    ? 'OFF'
                    : '…'}
              </span>
            </div>

            <p className="font-mono text-[10px] leading-relaxed text-content-tertiary">
              One-time addresses derived from your published keys — payments to
              you are unlinkable on-chain.
            </p>

            {privacyPublished !== 'yes' && (
              <Button
                fullWidth
                variant="secondary"
                onClick={() => void handlePublishPrivacy()}
                disabled={privacyBusy}
              >
                {privacyBusy ? 'Publishing…' : 'Enable private payments'}
              </Button>
            )}

            <Button
              fullWidth
              variant="ghost"
              onClick={() => void handleScanPrivacy()}
              disabled={privacyScanning || privacyBusy}
            >
              {privacyScanning ? 'Scanning…' : 'Scan for private payments'}
            </Button>

            {privacyScan.length > 0 && (
              <div className="flex flex-col gap-2 animate-fade-in">
                {privacyScan.map((entry) => (
                  <div
                    key={entry.txHash}
                    className="flex items-center justify-between gap-2 rounded-xl border border-surface-700 bg-surface-800/90 p-2.5"
                  >
                    <div className="flex min-w-0 flex-col gap-0.5">
                      <span className="font-mono text-xs font-bold text-content-primary">
                        {baseToDecimal(BigInt(entry.amountStroops), 7, 7)} XLM
                      </span>
                      <span className="truncate font-mono text-[10px] text-content-tertiary">
                        One-time {entry.oneTimeAddress.slice(0, 8)}…{entry.oneTimeAddress.slice(-6)}
                      </span>
                    </div>
                    <Button
                      size="sm"
                      variant="primary"
                      onClick={() => void handleClaimPrivacy(entry.txHash)}
                      disabled={claimingTx !== null}
                    >
                      {claimingTx === entry.txHash ? 'Claiming…' : 'Claim'}
                    </Button>
                  </div>
                ))}
              </div>
            )}

            {privacyMsg !== null && (
              <p className="font-mono text-[10px] leading-relaxed text-success animate-fade-in">
                {privacyMsg}
              </p>
            )}
          </div>
        )}
      </div>

      {/* Tactical Bottom Navigation Bar */}
      <TacticalBottomNav activeTab="receive" onSelectTab={onTabSelect ?? (() => {})} />
    </main>
  );
}

// ── Import wallet ───────────────────────────────────────────────────────
function ImportWallet({
  importPhrase,
  importPass1,
  importPass2,
  importError,
  isLoading,
  onPhraseChange,
  onPass1Change,
  onPass2Change,
  onSubmit,
  onBack,
}: {
  importPhrase: string;
  importPass1: string;
  importPass2: string;
  importError: string | null;
  isLoading: boolean;
  onPhraseChange: (v: string) => void;
  onPass1Change: (v: string) => void;
  onPass2Change: (v: string) => void;
  onSubmit: () => void;
  onBack: () => void;
}) {
  return (
    <main className="flex min-h-[600px] w-[400px] flex-col gap-4 p-4 animate-fade-in-up">
      <header className="flex items-baseline justify-between">
        <h1 className="font-display text-lg font-bold text-content-primary">Veilpay</h1>
        <span className="font-mono text-xs text-content-tertiary">v0.0.1</span>
      </header>

      <div className="flex flex-1 flex-col gap-4">
        <h2 className="font-display text-base font-semibold text-content-primary">
          {t('onboarding.import')}
        </h2>
        <p className="font-body text-xs text-content-secondary">
          {t('onboarding.importHint')}
        </p>

        <Input
          label={t('onboarding.recoveryPhrase')}
          placeholder={t('onboarding.recoveryPhrase')}
          value={importPhrase}
          onChange={(e) => onPhraseChange(e.target.value)}
          disabled={isLoading}
        />
        <Input
          type="password"
          label="New passphrase (min. 10 chars)"
          placeholder="New passphrase (min. 10 chars)"
          value={importPass1}
          onChange={(e) => onPass1Change(e.target.value)}
          passwordToggle
          disabled={isLoading}
        />
        <Input
          type="password"
          label="Confirm passphrase"
          placeholder="Confirm passphrase"
          value={importPass2}
          onChange={(e) => onPass2Change(e.target.value)}
          passwordToggle
          error={importError ?? null}
          disabled={isLoading}
        />

        <div className="flex gap-2 mt-auto">
          <Button variant="secondary" onClick={onBack} disabled={isLoading}>
            {t('common.back')}
          </Button>
          <Button
            fullWidth
            onClick={onSubmit}
            disabled={isLoading || importPhrase.length === 0 || importPass1.length === 0 || importPass2.length === 0}
          >
            {isLoading ? t('onboarding.importing') : t('onboarding.import')}
          </Button>
        </div>
      </div>
    </main>
  );
}

function StatusRow({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone: 'good' | 'bad' | 'neutral';
}) {
  const color =
    tone === 'good' ? 'text-success' : tone === 'bad' ? 'text-danger' : 'text-content-secondary';

  return (
    <div className="flex items-center justify-between py-1">
      <span className="font-body text-xs text-content-secondary">{label}</span>
      <span className={`font-mono text-xs ${color}`}>{value}</span>
    </div>
  );
}
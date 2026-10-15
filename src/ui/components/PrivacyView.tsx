import { useEffect, useState, type JSX } from 'react';
import { Button } from '@/ui/components/Button';
import { Glyph } from '@/ui/components/Glyph';
import { Input } from '@/ui/components/Input';
import { baseToDecimal, decimalToBase } from '@/ui/lib/format';
import { useWallet } from '@/ui/store/useWallet';

/**
 * The Stellar Private Payments (pXLM) privacy pool surface.
 *
 * Three money movements, all running through the offscreen SPP runtime with
 * Groth16 proofs generated on-device:
 *
 *   Shield   — public XLM in, private notes out (deposit into the pool).
 *   Send     — a private transfer to another registered wallet; the ledger
 *              records only that the pool was used.
 *   Unshield — private notes back to public XLM.
 *
 * Amounts are entered in XLM (7 decimals) and cross the bus as stroops. The
 * "working" state is honest about proving time — a Groth16 proof takes
 * seconds to minutes, and pretending otherwise makes users resubmit.
 */

type Mode = 'overview' | 'shield' | 'send' | 'unshield' | 'working' | 'receipt';

const XLM_DECIMALS = 7;

export function PrivacyView({ onBack }: { onBack: () => void }): JSX.Element {
  const {
    sppStatus,
    loadSppStatus,
    sppDeposit,
    sppTransfer,
    sppWithdraw,
    sppRegister,
    isLoading,
    error,
    clearError,
    accounts,
    balances,
  } = useWallet();

  const [mode, setMode] = useState<Mode>('overview');
  const [amount, setAmount] = useState('');
  const [to, setTo] = useState('');
  const [txHash, setTxHash] = useState<string | null>(null);
  const [receiptNote, setReceiptNote] = useState<string | null>(null);

  useEffect(() => {
    void loadSppStatus();
  }, [loadSppStatus]);

  const stellarAccount = accounts.find((a) => a.chain === 'stellar');
  const publicXlm = stellarAccount
    ? (balances[`stellar:${stellarAccount.address}`] ?? 0n)
    : 0n;
  const publicXlmText = baseToDecimal(publicXlm, XLM_DECIMALS, 7);
  const privateStroops = sppStatus ? BigInt(sppStatus.balanceStroops) : 0n;
  const privateText = baseToDecimal(privateStroops, XLM_DECIMALS, 7);

  const amountStroops = decimalToBase(amount.trim(), XLM_DECIMALS);
  const amountValid = amountStroops > 0n;
  const recipientValid = /^G[A-Z2-7]{55}$/.test(to.trim());

  const shieldTooMuch = amountStroops > publicXlm;
  const sendTooMuch = amountStroops > privateStroops;
  const unshieldTooMuch = amountStroops > privateStroops;

  const exitForm = () => {
    clearError();
    setAmount('');
    setTo('');
    setMode('overview');
  };

  const run = async (
    action: 'shield' | 'send' | 'unshield' | 'register',
  ): Promise<void> => {
    clearError();
    setMode('working');
    try {
      let result: { txHash: string };
      if (action === 'shield') {
        result = await sppDeposit(amountStroops.toString());
      } else if (action === 'send') {
        result = await sppTransfer(to.trim(), amountStroops.toString());
      } else if (action === 'unshield') {
        result = await sppWithdraw(amountStroops.toString());
      } else {
        result = await sppRegister();
      }
      setTxHash(result.txHash);
      setReceiptNote(
        action === 'shield'
          ? 'Your XLM is now private. Spend it from this balance.'
          : action === 'send'
            ? 'Sent privately — the ledger records no sender, recipient, or amount.'
            : action === 'unshield'
              ? 'Private notes converted back to public XLM.'
              : 'This wallet can now receive private transfers by address.',
      );
      setAmount('');
      setTo('');
      setMode('receipt');
      void loadSppStatus();
    } catch {
      // The store surfaces the error; fall back to the form so the user can fix it.
      setMode(action === 'register' ? 'overview' : action);
    }
  };

  // ── Receipt ───────────────────────────────────────────────────────────────
  if (mode === 'receipt' && txHash !== null) {
    return (
      <main className="flex min-h-[600px] w-[400px] animate-fade-in flex-col bg-surface-900 text-content-primary">
        <header className="flex shrink-0 items-center justify-between border-b border-surface-800/80 px-4 py-3">
          <button
            type="button"
            onClick={() => setMode('overview')}
            aria-label="Back"
            className="flex items-center gap-1.5 font-mono text-xs font-semibold text-content-secondary hover:text-white transition-colors"
          >
            <Glyph name="arrow-left" className="h-4 w-4" />
            <span>BACK</span>
          </button>
          <h1 className="font-display text-sm font-bold tracking-widest text-white uppercase">
            PRIVATE PAYMENT
          </h1>
          <div className="w-12" />
        </header>

        <div className="flex flex-1 flex-col items-center justify-center gap-4 px-6">
          <div className="relative flex h-14 w-14 items-center justify-center">
            <span aria-hidden className="absolute inset-0 animate-pulse-ring rounded-full bg-success/25" />
            <div className="relative flex h-12 w-12 animate-pop-in items-center justify-center rounded-2xl border border-success/60 bg-surface-700">
              <Glyph name="lock" className="h-6 w-6 text-success" />
            </div>
          </div>
          <p className="text-center font-body text-sm text-content-secondary">
            {receiptNote}
          </p>
          <div className="w-full rounded-xl border border-surface-700/60 bg-surface-800/70 p-3">
            <div className="font-mono text-[10px] tracking-wider text-content-tertiary uppercase">
              Transaction
            </div>
            <a
              href={`https://stellar.expert/explorer/testnet/tx/${txHash}`}
              target="_blank"
              rel="noreferrer"
              className="mt-1 block break-all font-mono text-[11px] text-accent-500 hover:underline"
            >
              {txHash}
            </a>
          </div>
          <Button fullWidth onClick={() => setMode('overview')}>
            Done
          </Button>
        </div>
      </main>
    );
  }

  // ── Working (proving + submitting) ───────────────────────────────────────
  if (mode === 'working') {
    return (
      <main className="flex min-h-[600px] w-[400px] animate-fade-in flex-col bg-surface-900 text-content-primary">
        <header className="flex shrink-0 items-center justify-between border-b border-surface-800/80 px-4 py-3">
          <div className="w-12" />
          <h1 className="font-display text-sm font-bold tracking-widest text-white uppercase">
            PRIVATE PAYMENT
          </h1>
          <div className="w-12" />
        </header>
        <div className="flex flex-1 flex-col items-center justify-center gap-5 px-6">
          <div className="relative flex h-16 w-16 items-center justify-center">
            <span aria-hidden className="absolute inset-0 animate-pulse-ring rounded-full bg-accent-500/25" />
            <div className="flex h-14 w-14 items-center justify-center rounded-2xl border border-accent-500/50 bg-surface-700">
              <span className="h-5 w-5 animate-spin rounded-full border-2 border-accent-500 border-t-transparent" />
            </div>
          </div>
          <div className="text-center">
            <p className="font-display text-sm font-bold tracking-wider text-white uppercase">
              Generating proof
            </p>
            <p className="mt-1 font-body text-xs text-content-secondary">
              The zero-knowledge proof is computed on this device. This can take
              up to a minute.
            </p>
          </div>
        </div>
      </main>
    );
  }

  // ── Forms ────────────────────────────────────────────────────────────────
  const formMode = mode === 'shield' || mode === 'send' || mode === 'unshield';
  const headerTitle =
    mode === 'shield' ? 'SHIELD XLM' : mode === 'send' ? 'SEND PRIVATELY' : mode === 'unshield' ? 'UNSHIELD' : 'PRIVACY POOL';

  const submitDisabled =
    isLoading ||
    !amountValid ||
    (mode === 'shield' && shieldTooMuch) ||
    (mode === 'send' && (!recipientValid || sendTooMuch)) ||
    (mode === 'unshield' && unshieldTooMuch);

  return (
    <main className="flex min-h-[600px] w-[400px] animate-fade-in-up flex-col bg-surface-900 text-content-primary">
      <header className="flex shrink-0 items-center justify-between border-b border-surface-800/80 px-4 py-3">
        <button
          type="button"
          onClick={formMode ? exitForm : onBack}
          aria-label="Back"
          className="flex items-center gap-1.5 font-mono text-xs font-semibold text-content-secondary hover:text-white transition-colors"
        >
          <Glyph name="arrow-left" className="h-4 w-4" />
          <span>BACK</span>
        </button>
        <h1 className="font-display text-sm font-bold tracking-widest text-white uppercase">
          {headerTitle}
        </h1>
        <div className="w-12" />
      </header>

      <div className="flex flex-1 flex-col gap-3 overflow-y-auto px-4 py-3">
        {error !== null && (
          <div
            role="alert"
            className="rounded-xl border border-danger/60 bg-danger/10 p-3 font-body text-xs text-danger"
          >
            {error}
          </div>
        )}

        {/* Balance summary — always visible in every mode. */}
        <div className="rounded-xl border border-surface-700/80 bg-surface-800/80 p-3.5">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-lg border border-accent-500/60 bg-surface-900 text-accent-500">
                <Glyph name="lock" className="h-5 w-5" />
              </div>
              <div>
                <div className="flex items-center gap-2">
                  <span className="font-display text-sm font-bold text-white">pXLM</span>
                  <span className="font-mono text-[9px] font-semibold tracking-wider text-content-tertiary uppercase">
                    Private XLM
                  </span>
                </div>
                <div className="mt-0.5 font-mono text-[10px] text-content-secondary">
                  Shielded pool · Stellar Testnet
                </div>
              </div>
            </div>
            <div className="text-right">
              <div className="font-mono text-xs font-bold text-white">{privateText}</div>
              <div className="mt-0.5 flex items-center justify-end gap-1 font-mono text-[10px] font-bold tracking-wider text-accent-500">
                <Glyph name="lock" className="h-2.5 w-2.5" />
                <span>PRIVATE</span>
              </div>
            </div>
          </div>
        </div>

        {!formMode && (
          <>
            {/* How the pool works — one honest paragraph, no marketing. */}
            <div className="rounded-xl border border-surface-700/60 bg-surface-800/60 p-3 font-body text-[11px] leading-relaxed text-content-secondary">
              Balances and transfers inside the pool are protected by
              zero-knowledge proofs: the public ledger records only that the
              pool was used, never who paid whom or how much. Pool screening
              (blocklist policy) keeps provenance out without exposing you.
            </div>

            <div className="flex flex-col gap-2">
              <Button
                fullWidth
                size="lg"
                onClick={() => {
                  clearError();
                  setMode('shield');
                }}
              >
                <Glyph name="lock" className="h-4 w-4" />
                Shield XLM
              </Button>
              <Button
                fullWidth
                size="lg"
                variant="secondary"
                disabled={privateStroops <= 0n}
                onClick={() => {
                  clearError();
                  setMode('send');
                }}
              >
                <Glyph name="send" className="h-4 w-4" />
                Send privately
              </Button>
              <Button
                fullWidth
                size="lg"
                variant="secondary"
                disabled={privateStroops <= 0n}
                onClick={() => {
                  clearError();
                  setMode('unshield');
                }}
              >
                <Glyph name="refresh" className="h-4 w-4" />
                Unshield to XLM
              </Button>
            </div>

            {/* Receiving: registration state + one-time enable. */}
            <div className="rounded-xl border border-surface-700/60 bg-surface-800/60 p-3">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <div className="font-display text-xs font-bold tracking-wider text-white uppercase">
                    Receive privately
                  </div>
                  <div className="mt-1 font-mono text-[10px] text-content-secondary">
                    {sppStatus === null
                      ? 'Reading pool state…'
                      : sppStatus.registered
                        ? 'Enabled — others can send to your address.'
                        : 'Register your pool keys to receive by address.'}
                  </div>
                </div>
                {sppStatus !== null && !sppStatus.registered && (
                  <Button
                    size="sm"
                    variant="secondary"
                    disabled={isLoading}
                    onClick={() => void run('register')}
                  >
                    Enable
                  </Button>
                )}
              </div>
            </div>

            <div className="mt-1 font-mono text-[10px] text-content-tertiary">
              Public XLM available to shield: {publicXlmText} XLM
            </div>
          </>
        )}

        {formMode && (
          <div className="flex animate-fade-in-up flex-col gap-3">
            {mode === 'send' && (
              <Input
                label="Recipient (G…)"
                placeholder="G…"
                value={to}
                onChange={(e) => {
                  setTo(e.target.value);
                  clearError();
                }}
                error={
                  to.trim().length > 0 && !recipientValid
                    ? 'Enter a valid Stellar address.'
                    : null
                }
                aria-label="Recipient Stellar address"
              />
            )}

            <Input
              label="Amount (XLM)"
              placeholder="0.0"
              inputMode="decimal"
              value={amount}
              onChange={(e) => {
                setAmount(e.target.value);
                clearError();
              }}
              error={
                amount.trim().length > 0 && !amountValid
                  ? 'Enter an amount greater than zero.'
                  : mode === 'shield' && shieldTooMuch
                    ? 'Amount exceeds your public XLM balance.'
                    : (mode === 'send' ? sendTooMuch : unshieldTooMuch)
                      ? 'Amount exceeds your private balance.'
                      : null
              }
              aria-label={`Amount in XLM to ${mode}`}
            />

            <div className="flex items-center justify-between rounded-xl border border-surface-700/60 bg-surface-800/60 px-3 py-2 font-mono text-[10px] text-content-tertiary">
              <span>
                {mode === 'shield' ? 'PUBLIC BALANCE' : 'PRIVATE BALANCE'}
              </span>
              <span>
                {mode === 'shield' ? `${publicXlmText} XLM` : `${privateText} pXLM`}
              </span>
            </div>

            {mode === 'send' && (
              <div className="rounded-xl border border-surface-700/60 bg-surface-800/60 p-3 font-body text-[11px] leading-relaxed text-content-secondary">
                The recipient must have enabled receiving privately. Neither the
                amount nor the addresses appear on the public ledger.
              </div>
            )}

            <Button
              fullWidth
              size="lg"
              disabled={submitDisabled}
              onClick={() => void run(mode === 'shield' ? 'shield' : mode === 'send' ? 'send' : 'unshield')}
            >
              <Glyph name="lock" className="h-4 w-4" />
              {mode === 'shield' ? 'Shield' : mode === 'send' ? 'Send privately' : 'Unshield'}
              {amountValid ? ` ${amount.trim()} ${mode === 'unshield' ? 'pXLM' : 'XLM'}` : ''}
            </Button>
          </div>
        )}
      </div>
    </main>
  );
}

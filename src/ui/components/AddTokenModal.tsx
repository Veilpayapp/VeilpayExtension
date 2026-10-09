import { useState, type JSX } from 'react';
import { Glyph } from '@/ui/components/Glyph';
import { Button } from '@/ui/components/Button';
import { useWallet } from '@/ui/store/useWallet';
import type { ChainId, CustomToken } from '@/core/messaging/protocol';

/**
 * MetaMask-style "Add token" modal.
 *
 * Chain-aware, because each chain identifies a token differently:
 *  - EVM:    the ERC-20 contract address (symbol/decimals/name are fetched
 *            from the chain — the registry never trusts caller metadata);
 *  - Stellar: asset code + issuer, and adding CREATES THE TRUSTLINE
 *            (Stellar's real "add token": without it the account cannot hold
 *            the asset at all);
 *  - Solana: the SPL mint (decimals are read from the mint account).
 *
 * The token lands in the registry (survives restarts), appears in the Assets
 * list with a live balance, and becomes selectable in the send form.
 */
export function AddTokenModal({
  chain,
  onClose,
}: {
  chain: ChainId;
  onClose: () => void;
}): JSX.Element {
  const { addToken, networks, selectedNetworks } = useWallet();
  const [contract, setContract] = useState('');
  const [code, setCode] = useState('');
  const [issuer, setIssuer] = useState('');
  const [symbol, setSymbol] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [added, setAdded] = useState<CustomToken | null>(null);

  const isStellar = chain === 'stellar';
  const isEvm = chain === 'evm';

  const networkName = (() => {
    const id = selectedNetworks[chain];
    const network = networks.find((n) => n.chain === chain && n.id === id);
    return network?.name ?? `${chain} Testnet`;
  })();

  const valid = isStellar
    ? code.trim().length > 0 && issuer.trim().length > 0
    : contract.trim().length > 0;

  const handleSubmit = async () => {
    setError(null);
    setBusy(true);
    try {
      const result = await addToken({
        chain,
        ...(isStellar
          ? { code: code.trim(), issuer: issuer.trim() }
          : { contract: contract.trim() }),
        ...(symbol.trim().length > 0 ? { symbol: symbol.trim() } : {}),
      });
      setAdded(result.token);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not add the token.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm p-4 animate-fade-in"
      role="dialog"
      aria-modal="true"
      aria-label="Add token"
    >
      <div className="w-full max-w-sm rounded-2xl border border-surface-600 bg-surface-900 p-4 shadow-raised flex flex-col gap-3 animate-pop-in">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Glyph name="token" className="h-5 w-5 text-accent-500" />
            <h3 className="font-display text-sm font-bold tracking-wider text-content-primary uppercase">
              ADD TOKEN
            </h3>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close add token"
            className="text-content-tertiary hover:text-content-primary p-1 rounded-lg"
          >
            <Glyph name="x" className="h-4 w-4" />
          </button>
        </div>

        {added !== null ? (
          <div className="flex flex-col gap-3 py-4 text-center animate-fade-in-up">
            <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-success/20">
              <Glyph name="check" className="h-6 w-6 text-success" />
            </div>
            <p className="font-display text-sm font-semibold text-content-primary">
              {added.symbol} added
            </p>
            <p className="font-mono text-[11px] leading-relaxed text-content-secondary">
              {isStellar
                ? 'The trustline transaction was broadcast. The asset appears in your Assets list and the send form.'
                : 'The token appears in your Assets list and the send form.'}
            </p>
            <Button fullWidth onClick={onClose}>
              Done
            </Button>
          </div>
        ) : (
          <>
            <p className="font-mono text-[10px] leading-relaxed text-content-tertiary">
              Adding on <span className="text-accent-400">{networkName}</span>.
              {isEvm && ' Symbol and decimals are read from the contract itself.'}
              {isStellar && ' A trustline is created so you can hold the asset.'}
              {chain === 'solana' && ' Decimals are read from the mint account.'}
            </p>

            {isStellar ? (
              <div className="flex flex-col gap-2">
                <div>
                  <label
                    htmlFor="token-code"
                    className="block font-mono text-[10px] font-semibold tracking-wider text-content-tertiary uppercase mb-1"
                  >
                    ASSET CODE
                  </label>
                  <input
                    id="token-code"
                    type="text"
                    placeholder="USDC"
                    maxLength={12}
                    value={code}
                    onChange={(e) => setCode(e.target.value)}
                    disabled={busy}
                    className="w-full rounded-xl border border-surface-700 bg-surface-800 px-3 py-2 font-mono text-xs text-content-primary placeholder:text-content-tertiary focus:border-accent-500 outline-none"
                  />
                </div>
                <div>
                  <label
                    htmlFor="token-issuer"
                    className="block font-mono text-[10px] font-semibold tracking-wider text-content-tertiary uppercase mb-1"
                  >
                    ISSUER ADDRESS
                  </label>
                  <input
                    id="token-issuer"
                    type="text"
                    placeholder="G…"
                    value={issuer}
                    onChange={(e) => setIssuer(e.target.value)}
                    disabled={busy}
                    className="w-full rounded-xl border border-surface-700 bg-surface-800 px-3 py-2 font-mono text-xs text-content-primary placeholder:text-content-tertiary focus:border-accent-500 outline-none"
                  />
                </div>
              </div>
            ) : (
              <div>
                <label
                  htmlFor="token-contract"
                  className="block font-mono text-[10px] font-semibold tracking-wider text-content-tertiary uppercase mb-1"
                  >
                  {isEvm ? 'TOKEN CONTRACT ADDRESS' : 'SPL MINT ADDRESS'}
                </label>
                <input
                  id="token-contract"
                  type="text"
                  placeholder={isEvm ? '0x…' : 'Base58 mint'}
                  value={contract}
                  onChange={(e) => setContract(e.target.value)}
                  disabled={busy}
                  className="w-full rounded-xl border border-surface-700 bg-surface-800 px-3 py-2 font-mono text-xs text-content-primary placeholder:text-content-tertiary focus:border-accent-500 outline-none"
                />
              </div>
            )}

            <div>
              <label
                htmlFor="token-symbol"
                className="block font-mono text-[10px] font-semibold tracking-wider text-content-tertiary uppercase mb-1"
              >
                SYMBOL {isEvm ? '(OPTIONAL — READ FROM CHAIN)' : isStellar ? '(OPTIONAL)' : '(OPTIONAL)'}
              </label>
              <input
                id="token-symbol"
                type="text"
                placeholder={isEvm ? 'Read from the contract' : 'Display symbol'}
                maxLength={32}
                value={symbol}
                onChange={(e) => setSymbol(e.target.value)}
                disabled={busy || isEvm}
                className="w-full rounded-xl border border-surface-700 bg-surface-800 px-3 py-2 font-mono text-xs text-content-primary placeholder:text-content-tertiary focus:border-accent-500 outline-none disabled:opacity-50"
              />
            </div>

            {error !== null && (
              <p className="font-body text-xs text-danger animate-shake" role="alert">
                {error}
              </p>
            )}

            <div className="flex gap-2">
              <Button variant="secondary" onClick={onClose} disabled={busy}>
                Cancel
              </Button>
              <Button fullWidth onClick={() => void handleSubmit()} disabled={busy || !valid}>
                {busy ? 'Adding…' : 'Add token'}
              </Button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

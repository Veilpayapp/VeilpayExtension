import { useWallet } from '@/ui/store/useWallet';
import type { NetworkSummary } from '@/core/messaging/protocol';

/**
 * Network-aware banner for every surface that touches funds.
 *
 * The banner answers "what am I about to move funds on RIGHT NOW?", so it
 * keys on the chain the user is actually viewing (the dashboard's active
 * account), not a fixed-priority scan of every chain's selection — the old
 * scan always named the first mainnet in chain order, so a user who switched
 * the dashboard from Stellar Mainnet to Ethereum still read "You are on
 * Stellar Mainnet". On chain-agnostic surfaces (no accounts yet, e.g. the
 * welcome screen) it falls back to the wallet-wide scan: any selected mainnet
 * is the thing to warn about.
 *
 * Priority within the resolved set:
 * - mainnet → the inverse warning: REAL funds move on this network now;
 * - custom RPC → caution: the endpoint is user-supplied and unvetted;
 * - otherwise → the historical testnet warning.
 *
 * When the store is still loading (no selection known) the safe default is
 * the testnet warning.
 */
export function TestnetBanner({ scope = 'testnet' }: { scope?: 'testnet' | 'privacy' }) {
  const { accounts, selectedAccountIdx, networks, selectedNetworks } = useWallet();

  if (scope === 'privacy') {
    return (
      <Banner
        tone="warning"
        copy="Privacy payments use unaudited cryptography — small amounts only, for now."
      />
    );
  }

  // The viewed chain, when a dashboard account exists to view.
  const activeChain =
    accounts.length > 0
      ? accounts[Math.min(selectedAccountIdx, accounts.length - 1)]?.chain
      : undefined;

  const resolve = (chain: 'stellar' | 'evm' | 'solana'): NetworkSummary | undefined => {
    const id = selectedNetworks[chain];
    return networks.find((n) => n.chain === chain && n.id === id);
  };

  // Viewed-chain first; the wallet-wide scan only when nothing is being viewed.
  const selected: NetworkSummary[] =
    activeChain !== undefined
      ? (() => {
          const viewed = resolve(activeChain);
          return viewed !== undefined ? [viewed] : [];
        })()
      : (['stellar', 'evm', 'solana'] as const)
          .map(resolve)
          .filter((n): n is NetworkSummary => n !== undefined);

  const mainnet = selected.find((n) => n.kind === 'mainnet');
  if (mainnet !== undefined) {
    return (
      <Banner
        tone="danger"
        copy={`You are on ${mainnet.name}. REAL funds move on this network — verify every address.`}
      />
    );
  }

  const custom = selected.find((n) => n.id.startsWith('custom:'));
  if (custom !== undefined) {
    return (
      <Banner
        tone="warning"
        copy={`${custom.name} is a custom RPC you added. Verify you trust this endpoint.`}
      />
    );
  }

  return <Banner tone="warning" copy="Testnet only. Do not send mainnet funds to these addresses." />;
}

function Banner({ tone, copy }: { tone: 'warning' | 'danger'; copy: string }) {
  return (
    <div
      role="status"
      className={`flex items-start gap-2 rounded-md border px-3 py-2 ${
        tone === 'danger' ? 'border-danger/40 bg-danger/10' : 'border-warning/40 bg-warning/10'
      }`}
    >
      <span aria-hidden="true" className={tone === 'danger' ? 'text-danger' : 'text-warning'}>
        &#9888;
      </span>
      <p
        className={`font-body text-xs leading-snug ${tone === 'danger' ? 'text-danger' : 'text-warning'}`}
      >
        {copy}
      </p>
    </div>
  );
}

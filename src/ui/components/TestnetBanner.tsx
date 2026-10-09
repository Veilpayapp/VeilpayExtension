import { useWallet } from '@/ui/store/useWallet';
import type { NetworkSummary } from '@/core/messaging/protocol';

/**
 * Network-aware banner for every surface that touches funds.
 *
 * Scans the SELECTED network of every chain (the popup is multi-chain), in
 * priority order:
 * - mainnet → the inverse warning: REAL funds move on this network now;
 * - custom RPC → caution: the endpoint is user-supplied and unvetted;
 * - otherwise → the historical testnet warning.
 *
 * When the store is still loading (no selection known) the safe default is
 * the testnet warning.
 */
export function TestnetBanner({ scope = 'testnet' }: { scope?: 'testnet' | 'privacy' }) {
  const { networks, selectedNetworks } = useWallet();

  if (scope === 'privacy') {
    return (
      <Banner
        tone="warning"
        copy="Privacy payments use unaudited cryptography — small amounts only, for now."
      />
    );
  }

  const selected: NetworkSummary[] = [];
  for (const chain of ['stellar', 'evm', 'solana'] as const) {
    const id = selectedNetworks[chain];
    const match = networks.find((n) => n.chain === chain && n.id === id);
    if (match !== undefined) selected.push(match);
  }

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

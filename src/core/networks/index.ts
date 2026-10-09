/**
 * Network registry — the source of truth for every network the wallet can
 * talk to: mainnets AND testnets, per chain, with the metadata each layer
 * needs (RPC endpoints, EIP-155 chain id, Stellar passphrase, explorer,
 * faucet availability).
 *
 * Design:
 *  - Presets are static and verified data; users may also register custom
 *    RPC endpoints (see CustomNetwork below), which the selection resolves
 *    on top of the presets.
 *  - Selection is persisted per chain in IndexedDB and defaults to the
 *    historical testnet endpoints, so existing installs keep their exact
 *    current behavior until a user explicitly switches.
 *  - Every RPC URL below was verified live (chainId responses) before being
 *    listed. The matching host permissions live in src/manifest.config.ts.
 *
 * The selection is consumed by the background's service creation: balances,
 * estimates, broadcasts, fee sources, the dapp provider (eth.chainId /
 * eth.switchChain), WalletConnect session namespaces, and the agent bridge
 * all resolve through `resolveNetworkRpcUrl` / `resolveEvmChainId` /
 * `resolveStellarPassphrase`, so switching a network here switches every
 * layer at once.
 */

import { readMeta, writeMeta } from '@/core/vault/storage';
import type { ChainId } from '@/core/messaging/protocol';

const STORAGE_KEY = 'networks:custom';
const SELECTION_KEY = 'networks:selection';

export interface CustomNetwork {
  /** EVM, Solana, or Stellar. */
  chain: ChainId;
  /** Display name, e.g. "Sepolia via Infura". */
  name: string;
  /** RPC endpoint URL. */
  rpcUrl: string;
  /** Optional chain ID (for EVM networks). */
  chainId?: number;
  /** Optional explorer URL. */
  explorerUrl?: string;
}

export type NetworkKind = 'mainnet' | 'testnet';

export interface NetworkProfile {
  /** Stable id, e.g. 'stellar:mainnet', 'evm:sepolia', 'custom:My RPC'. */
  id: string;
  chain: ChainId;
  kind: NetworkKind;
  /** Display name. */
  name: string;
  /** Native asset symbol. */
  symbol: string;
  /** RPC endpoints, most preferred first. */
  rpcUrls: string[];
  /** EVM only: EIP-155 chain id used when signing transactions. */
  chainId?: number;
  /** Stellar only: network passphrase bound into the signature base. */
  passphrase?: string;
  /** Builds the explorer URL for a transaction hash. */
  explorerTx: (hash: string) => string;
  /** Whether testnet funds can be requested on this network. */
  faucet: boolean;
}

// ── Presets ────────────────────────────────────────────────────────────────

/** Official Stellar network passphrases — part of the signature pre-image. */
const STELLAR_MAINNET_PASSPHRASE = 'Public Global Stellar Network ; September 2015';
const STELLAR_TESTNET_PASSPHRASE = 'Test SDF Network ; September 2015';

export const NETWORKS: readonly NetworkProfile[] = [
  // ── Stellar ─────────────────────────────────────────────────────────────
  {
    id: 'stellar:mainnet',
    chain: 'stellar',
    kind: 'mainnet',
    name: 'Stellar Mainnet',
    symbol: 'XLM',
    rpcUrls: ['https://horizon.stellar.org'],
    passphrase: STELLAR_MAINNET_PASSPHRASE,
    explorerTx: (hash) => `https://stellar.expert/explorer/public/tx/${hash}`,
    faucet: false,
  },
  {
    id: 'stellar:testnet',
    chain: 'stellar',
    kind: 'testnet',
    name: 'Stellar Testnet',
    symbol: 'XLM',
    rpcUrls: ['https://horizon-testnet.stellar.org'],
    passphrase: STELLAR_TESTNET_PASSPHRASE,
    explorerTx: (hash) => `https://stellar.expert/explorer/testnet/tx/${hash}`,
    faucet: true,
  },

  // ── EVM ─────────────────────────────────────────────────────────────────
  {
    id: 'evm:ethereum',
    chain: 'evm',
    kind: 'mainnet',
    name: 'Ethereum',
    symbol: 'ETH',
    rpcUrls: ['https://1rpc.io/eth'],
    chainId: 1,
    explorerTx: (hash) => `https://etherscan.io/tx/${hash}`,
    faucet: false,
  },
  {
    id: 'evm:sepolia',
    chain: 'evm',
    kind: 'testnet',
    name: 'Sepolia',
    symbol: 'ETH',
    rpcUrls: [
      'https://ethereum-sepolia-rpc.publicnode.com',
      'https://sepolia.gateway.tenderly.co',
      'https://1rpc.io/sepolia',
    ],
    chainId: 11155111,
    explorerTx: (hash) => `https://sepolia.etherscan.io/tx/${hash}`,
    faucet: true,
  },
  {
    id: 'evm:base',
    chain: 'evm',
    kind: 'mainnet',
    name: 'Base',
    symbol: 'ETH',
    rpcUrls: ['https://base-rpc.publicnode.com'],
    chainId: 8453,
    explorerTx: (hash) => `https://basescan.org/tx/${hash}`,
    faucet: false,
  },
  {
    id: 'evm:base-sepolia',
    chain: 'evm',
    kind: 'testnet',
    name: 'Base Sepolia',
    symbol: 'ETH',
    rpcUrls: ['https://base-sepolia-rpc.publicnode.com'],
    chainId: 84532,
    explorerTx: (hash) => `https://sepolia.basescan.org/tx/${hash}`,
    faucet: true,
  },
  {
    id: 'evm:polygon',
    chain: 'evm',
    kind: 'mainnet',
    name: 'Polygon',
    symbol: 'POL',
    rpcUrls: ['https://1rpc.io/matic'],
    chainId: 137,
    explorerTx: (hash) => `https://polygonscan.com/tx/${hash}`,
    faucet: false,
  },
  {
    id: 'evm:arbitrum',
    chain: 'evm',
    kind: 'mainnet',
    name: 'Arbitrum One',
    symbol: 'ETH',
    rpcUrls: ['https://arbitrum-one-rpc.publicnode.com'],
    chainId: 42161,
    explorerTx: (hash) => `https://arbiscan.io/tx/${hash}`,
    faucet: false,
  },
  {
    id: 'evm:optimism',
    chain: 'evm',
    kind: 'mainnet',
    name: 'Optimism',
    symbol: 'ETH',
    rpcUrls: ['https://optimism-rpc.publicnode.com'],
    chainId: 10,
    explorerTx: (hash) => `https://optimistic.etherscan.io/tx/${hash}`,
    faucet: false,
  },
  {
    id: 'evm:bsc',
    chain: 'evm',
    kind: 'mainnet',
    name: 'BNB Smart Chain',
    symbol: 'BNB',
    rpcUrls: ['https://bsc-rpc.publicnode.com'],
    chainId: 56,
    explorerTx: (hash) => `https://bscscan.com/tx/${hash}`,
    faucet: false,
  },
  {
    id: 'evm:avalanche',
    chain: 'evm',
    kind: 'mainnet',
    name: 'Avalanche C-Chain',
    symbol: 'AVAX',
    rpcUrls: ['https://avalanche-c-chain-rpc.publicnode.com'],
    chainId: 43114,
    explorerTx: (hash) => `https://snowtrace.io/tx/${hash}`,
    faucet: false,
  },

  // ── Additional EVM testnets ────────────────────────────────────────────
  {
    id: 'evm:polygon-amoy',
    chain: 'evm',
    kind: 'testnet',
    name: 'Polygon Amoy',
    symbol: 'POL',
    rpcUrls: ['https://polygon-amoy-bor-rpc.publicnode.com'],
    chainId: 80002,
    explorerTx: (hash) => `https://amoy.polygonscan.com/tx/${hash}`,
    faucet: true,
  },
  {
    id: 'evm:arbitrum-sepolia',
    chain: 'evm',
    kind: 'testnet',
    name: 'Arbitrum Sepolia',
    symbol: 'ETH',
    rpcUrls: ['https://arbitrum-sepolia-rpc.publicnode.com'],
    chainId: 421614,
    explorerTx: (hash) => `https://sepolia.arbiscan.io/tx/${hash}`,
    faucet: true,
  },
  {
    id: 'evm:optimism-sepolia',
    chain: 'evm',
    kind: 'testnet',
    name: 'Optimism Sepolia',
    symbol: 'ETH',
    rpcUrls: ['https://optimism-sepolia-rpc.publicnode.com'],
    chainId: 11155420,
    explorerTx: (hash) => `https://sepolia-optimism.etherscan.io/tx/${hash}`,
    faucet: true,
  },
  {
    id: 'evm:bsc-chapel',
    chain: 'evm',
    kind: 'testnet',
    name: 'BNB Chapel',
    symbol: 'tBNB',
    rpcUrls: ['https://bsc-testnet-rpc.publicnode.com'],
    chainId: 97,
    explorerTx: (hash) => `https://testnet.bscscan.com/tx/${hash}`,
    faucet: true,
  },
  {
    id: 'evm:avalanche-fuji',
    chain: 'evm',
    kind: 'testnet',
    name: 'Avalanche Fuji',
    symbol: 'AVAX',
    rpcUrls: ['https://avalanche-fuji-c-chain-rpc.publicnode.com'],
    chainId: 43113,
    explorerTx: (hash) => `https://testnet.snowtrace.io/tx/${hash}`,
    faucet: true,
  },

  // ── Solana ──────────────────────────────────────────────────────────────
  {
    id: 'solana:mainnet',
    chain: 'solana',
    kind: 'mainnet',
    name: 'Solana Mainnet',
    symbol: 'SOL',
    rpcUrls: ['https://solana-rpc.publicnode.com', 'https://api.mainnet.solana.com'],
    explorerTx: (hash) => `https://explorer.solana.com/tx/${hash}`,
    faucet: false,
  },
  {
    id: 'solana:devnet',
    chain: 'solana',
    kind: 'testnet',
    name: 'Solana Devnet',
    symbol: 'SOL',
    rpcUrls: ['https://api.devnet.solana.com'],
    explorerTx: (hash) => `https://explorer.solana.com/tx/${hash}?cluster=devnet`,
    faucet: true,
  },
  {
    id: 'solana:testnet',
    chain: 'solana',
    kind: 'testnet',
    name: 'Solana Testnet',
    symbol: 'SOL',
    rpcUrls: ['https://api.testnet.solana.com'],
    explorerTx: (hash) => `https://explorer.solana.com/tx/${hash}?cluster=testnet`,
    faucet: true,
  },
];

/**
 * The default network per chain. These match the endpoints the wallet has
 * always used (testnets), so an existing install's behavior is unchanged
 * until the user explicitly switches.
 */
export const DEFAULT_NETWORK_IDS: Record<ChainId, string> = {
  stellar: 'stellar:testnet',
  evm: 'evm:sepolia',
  solana: 'solana:devnet',
};

export function findNetworkById(id: string): NetworkProfile | undefined {
  return NETWORKS.find((network) => network.id === id);
}

/**
 * Finds an EVM preset by its EIP-155 chain id — used by `eth.switchEthereumChain`
 * to accept or reject a dapp's requested chain, and by WalletConnect to resolve
 * an `eip155:<id>` reference onto a selectable network.
 */
export function findEvmNetworkByChainId(chainId: number): NetworkProfile | undefined {
  return NETWORKS.find(
    (network) => network.chain === 'evm' && network.chainId === chainId,
  );
}

export function listNetworks(chain: ChainId): NetworkProfile[] {
  return NETWORKS.filter((network) => network.chain === chain);
}

/**
 * Serializes a profile for the message bus: `explorerTx` is a closure and
 * cannot cross `structuredClone`, so it is materialized against a sentinel
 * hash and the UI re-templates it per receipt.
 */
export function toNetworkSummary(network: NetworkProfile): {
  id: string;
  chain: ChainId;
  kind: NetworkKind;
  name: string;
  symbol: string;
  rpcUrls: string[];
  chainId?: number;
  explorerTx: string;
  faucet: boolean;
} {
  return {
    id: network.id,
    chain: network.chain,
    kind: network.kind,
    name: network.name,
    symbol: network.symbol,
    rpcUrls: [...network.rpcUrls],
    ...(network.chainId !== undefined ? { chainId: network.chainId } : {}),
    explorerTx: network.explorerTx('{hash}'),
    faucet: network.faucet,
  };
}

// ── Custom RPC endpoints (user-registered) ─────────────────────────────────

function isCustomNetwork(value: unknown): value is CustomNetwork {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.chain === 'string' &&
    typeof candidate.name === 'string' &&
    typeof candidate.rpcUrl === 'string'
  );
}

/**
 * Loads custom networks from IndexedDB.
 * Malformed/partial rows are dropped rather than propagated to the UI.
 */
export async function getCustomNetworks(): Promise<CustomNetwork[]> {
  const stored = await readMeta<unknown>(STORAGE_KEY);
  return Array.isArray(stored) ? stored.filter(isCustomNetwork) : [];
}

/**
 * Adds a custom network. Returns false if the name already exists.
 */
export async function addCustomNetwork(network: CustomNetwork): Promise<boolean> {
  const networks = await getCustomNetworks();
  if (networks.some((n) => n.name === network.name)) {
    return false;
  }
  networks.push(network);
  await writeMeta(STORAGE_KEY, networks);
  return true;
}

/**
 * Removes a custom network by name.
 */
export async function removeCustomNetwork(name: string): Promise<void> {
  const networks = await getCustomNetworks();
  await writeMeta(
    STORAGE_KEY,
    networks.filter((n) => n.name !== name),
  );
}

/** Wraps a user-registered RPC as a selectable network profile. */
function customNetworkToProfile(custom: CustomNetwork): NetworkProfile {
  return {
    id: `custom:${custom.name}`,
    chain: custom.chain,
    // A user-supplied RPC is treated as unclassified rather than assumed
    // mainnet; faucet flows never target custom endpoints.
    kind: 'testnet',
    name: custom.name,
    symbol: '—',
    rpcUrls: [custom.rpcUrl],
    ...(typeof custom.chainId === 'number' ? { chainId: custom.chainId } : {}),
    explorerTx: (hash) =>
      custom.explorerUrl !== undefined && custom.explorerUrl.length > 0
        ? `${custom.explorerUrl.replace(/\/+$/, '')}/tx/${hash}`
        : `about:blank`,
    faucet: false,
  };
}

/** Presets for a chain plus the user's custom RPCs for it. */
export async function listSelectableNetworks(chain: ChainId): Promise<NetworkProfile[]> {
  const custom = await getCustomNetworks();
  return [
    ...listNetworks(chain),
    ...custom.filter((n) => n.chain === chain).map(customNetworkToProfile),
  ];
}

// ── Selection ──────────────────────────────────────────────────────────────

/**
 * The currently selected network id for a chain (persisted; falls back to
 * the historical testnet default when nothing valid is stored).
 */
export async function getSelectedNetworkId(chain: ChainId): Promise<string> {
  const stored = await readMeta<Record<string, unknown>>(SELECTION_KEY);
  const id = stored?.[chain];
  if (typeof id !== 'string' || id.length === 0) {
    return DEFAULT_NETWORK_IDS[chain];
  }
  // A stored id pointing at a removed custom network falls back to the
  // default rather than resolving to nothing.
  if (id.startsWith('custom:')) {
    const name = id.slice('custom:'.length);
    const custom = (await getCustomNetworks()).find((n) => n.name === name);
    if (custom === undefined || custom.chain !== chain) {
      return DEFAULT_NETWORK_IDS[chain];
    }
  } else if (findNetworkById(id) === undefined) {
    return DEFAULT_NETWORK_IDS[chain];
  }
  return id;
}

/**
 * Selects the active network for a chain. Returns false (and persists
 * nothing) when the id does not resolve to a preset or custom network of
 * that chain.
 */
export async function setSelectedNetworkId(chain: ChainId, networkId: string): Promise<boolean> {
  const selectable = await listSelectableNetworks(chain);
  if (!selectable.some((n) => n.id === networkId)) {
    return false;
  }
  const stored = (await readMeta<Record<string, unknown>>(SELECTION_KEY)) ?? {};
  await writeMeta(SELECTION_KEY, { ...stored, [chain]: networkId });
  return true;
}

/**
 * Resolves the selected network for a chain into a full profile. Always
 * returns a usable profile (worst case the chain's default).
 */
export async function getSelectedNetwork(chain: ChainId): Promise<NetworkProfile> {
  const id = await getSelectedNetworkId(chain);
  const selectable = await listSelectableNetworks(chain);
  const match = selectable.find((n) => n.id === id);
  if (match !== undefined) return match;
  const fallback = findNetworkById(DEFAULT_NETWORK_IDS[chain]);
  if (fallback === undefined) {
    throw new Error(`No network profile available for chain ${chain}.`);
  }
  return fallback;
}

// ── Resolution helpers (for the background wiring step) ────────────────────

/**
 * Resolves the RPC URL for a chain, preferring custom networks over defaults.
 * Legacy behavior, unchanged: the network SELECTION does not participate
 * here — the selected network's URL comes from `resolveNetworkRpcUrl`, which
 * the background adopts in the wiring step as one atomic change. Until then
 * every existing call site behaves exactly as before.
 */
export async function resolveRpcUrl(
  chain: ChainId,
  defaultUrl: string,
): Promise<string> {
  const custom = await getCustomNetworks();
  const match = custom.find((n) => n.chain === chain);
  return match?.rpcUrl ?? defaultUrl;
}

/**
 * The RPC URLs for the SELECTED network of a chain (custom RPCs still win,
 * since they are the most explicit user intent). Used by the network-aware
 * wiring: balances, estimates, broadcasts, and history.
 */
export async function resolveNetworkRpcUrls(chain: ChainId): Promise<string[]> {
  const custom = await getCustomNetworks();
  const customMatch = custom.find((n) => n.chain === chain);
  if (customMatch !== undefined) return [customMatch.rpcUrl];
  const selected = await getSelectedNetwork(chain);
  return [...selected.rpcUrls];
}

/** The first (most preferred) RPC URL for the selected network of a chain. */
export async function resolveNetworkRpcUrl(chain: ChainId): Promise<string> {
  const urls = await resolveNetworkRpcUrls(chain);
  return urls[0] ?? '';
}

/** The EIP-155 chain id transactions must be signed with for EVM sends. */
export async function resolveEvmChainId(): Promise<number> {
  const selected = await getSelectedNetwork('evm');
  return selected.chainId ?? 11155111;
}

/** The Stellar network passphrase bound into the transaction signature. */
export async function resolveStellarPassphrase(): Promise<string> {
  const selected = await getSelectedNetwork('stellar');
  return selected.passphrase ?? STELLAR_TESTNET_PASSPHRASE;
}

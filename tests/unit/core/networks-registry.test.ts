import { beforeEach, describe, expect, it } from 'vitest';
import { TESTNET_ENDPOINTS } from '@/core/chains';
import {
  addCustomNetwork,
  DEFAULT_NETWORK_IDS,
  findNetworkById,
  getCustomNetworks,
  getSelectedNetwork,
  getSelectedNetworkId,
  listNetworks,
  listSelectableNetworks,
  NETWORKS,
  removeCustomNetwork,
  resolveEvmChainId,
  resolveNetworkRpcUrl,
  resolveRpcUrl,
  resolveStellarPassphrase,
  setSelectedNetworkId,
} from '@/core/networks';

/**
 * Network registry invariants.
 *
 * The registry is the foundation for multi-network (mainnet + testnet)
 * support. These tests pin the properties the wiring step will rely on:
 * preset integrity, live-verified chain ids, selection persistence, and —
 * critically — that the DEFAULTS reproduce the wallet's historical testnet
 * endpoints exactly, so nothing changes until a user switches.
 */

beforeEach(async () => {
  // Isolate IndexedDB-backed state between tests.
  await import('@/core/vault/storage').then(({ writeMeta }) =>
    Promise.all([
      writeMeta('networks:selection', undefined),
      writeMeta('networks:custom', undefined),
    ]),
  );
});

describe('registry integrity', () => {
  it('has unique network ids', () => {
    const ids = NETWORKS.map((n) => n.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('every preset carries at least one https RPC endpoint', () => {
    for (const network of NETWORKS) {
      expect(network.rpcUrls.length).toBeGreaterThan(0);
      for (const url of network.rpcUrls) {
        expect(url.startsWith('https://')).toBe(true);
      }
    }
  });

  it('EVM presets carry an EIP-155 chain id; Stellar presets carry a passphrase', () => {
    for (const network of NETWORKS) {
      if (network.chain === 'evm') expect(typeof network.chainId).toBe('number');
      if (network.chain === 'stellar') expect(network.passphrase?.length).toBeGreaterThan(0);
    }
  });

  it('only testnets offer faucet funding', () => {
    for (const network of NETWORKS) {
      if (network.kind === 'mainnet') expect(network.faucet).toBe(false);
    }
  });

  it('mainnet and testnet are both available for every chain', () => {
    for (const chain of ['stellar', 'evm', 'solana'] as const) {
      const kinds = new Set(listNetworks(chain).map((n) => n.kind));
      expect(kinds.has('mainnet')).toBe(true);
      expect(kinds.has('testnet')).toBe(true);
    }
  });

  it('carries the live-verified EIP-155 chain ids', () => {
    const expectChainId = (id: string, expected: number) => {
      expect(findNetworkById(id)?.chainId).toBe(expected);
    };
    expectChainId('evm:ethereum', 1);
    expectChainId('evm:sepolia', 11155111);
    expectChainId('evm:base', 8453);
    expectChainId('evm:base-sepolia', 84532);
    expectChainId('evm:polygon', 137);
    expectChainId('evm:arbitrum', 42161);
  });

  it('testnet explorer URLs match the existing receipt links', () => {
    // These must stay byte-identical to TransactionHistoryView.explorerUrlFor,
    // which tests already pin — a registry entry that drifted would give the
    // receipt one explorer and the history view another.
    expect(findNetworkById('evm:sepolia')?.explorerTx('0xdeadbeef')).toBe(
      'https://sepolia.etherscan.io/tx/0xdeadbeef',
    );
    expect(findNetworkById('solana:devnet')?.explorerTx('hash')).toBe(
      'https://explorer.solana.com/tx/hash?cluster=devnet',
    );
    expect(findNetworkById('stellar:testnet')?.explorerTx('hash')).toBe(
      'https://stellar.expert/explorer/testnet/tx/hash',
    );
  });
});

describe('defaults preserve existing behavior', () => {
  it('the default network per chain resolves to the historical endpoints', async () => {
    for (const chain of ['stellar', 'evm', 'solana'] as const) {
      const id = await getSelectedNetworkId(chain);
      expect(id).toBe(DEFAULT_NETWORK_IDS[chain]);
      const network = await getSelectedNetwork(chain);
      // The first preset URL is exactly what the wallet has always used —
      // no install changes behavior until a user explicitly switches.
      expect(network.rpcUrls[0]).toBe(TESTNET_ENDPOINTS[chain]);
    }
  });

  it('resolveEvmChainId / resolveStellarPassphrase default to the historical values', async () => {
    expect(await resolveEvmChainId()).toBe(11155111);
    expect(await resolveStellarPassphrase()).toBe('Test SDF Network ; September 2015');
  });

  it('legacy resolveRpcUrl ignores the selection and keeps custom-over-default', async () => {
    await setSelectedNetworkId('evm', 'evm:ethereum');
    // Selection deliberately does not leak into the legacy resolver.
    expect(await resolveRpcUrl('evm', TESTNET_ENDPOINTS.evm)).toBe(
      TESTNET_ENDPOINTS.evm,
    );
    await addCustomNetwork({
      chain: 'evm',
      name: 'My node',
      rpcUrl: 'https://rpc.example.com',
    });
    expect(await resolveRpcUrl('evm', TESTNET_ENDPOINTS.evm)).toBe(
      'https://rpc.example.com',
    );
  });
});

describe('selection persistence', () => {
  it('persists and resolves a selected network', async () => {
    expect(await setSelectedNetworkId('evm', 'evm:base')).toBe(true);
    expect(await getSelectedNetworkId('evm')).toBe('evm:base');
    const selected = await getSelectedNetwork('evm');
    expect(selected.id).toBe('evm:base');
    expect(selected.chainId).toBe(8453);
    expect(await resolveNetworkRpcUrl('evm')).toBe('https://base-rpc.publicnode.com');
    expect(await resolveEvmChainId()).toBe(8453);
  });

  it('switches the Stellar network, including the signing passphrase', async () => {
    await setSelectedNetworkId('stellar', 'stellar:mainnet');
    expect(await resolveStellarPassphrase()).toBe(
      'Public Global Stellar Network ; September 2015',
    );
    expect(await resolveNetworkRpcUrl('stellar')).toBe('https://horizon.stellar.org');
  });

  it('rejects an unknown network id without persisting anything', async () => {
    expect(await setSelectedNetworkId('evm', 'evm:does-not-exist')).toBe(false);
    expect(await getSelectedNetworkId('evm')).toBe(DEFAULT_NETWORK_IDS.evm);
  });

  it('rejects a network id from a different chain', async () => {
    expect(await setSelectedNetworkId('evm', 'stellar:mainnet')).toBe(false);
    expect(await getSelectedNetworkId('evm')).toBe(DEFAULT_NETWORK_IDS.evm);
  });

  it('selects and resolves a custom RPC, then falls back when it is removed', async () => {
    await addCustomNetwork({
      chain: 'solana',
      name: 'My Solana node',
      rpcUrl: 'https://sol.example.com',
    });
    const selectable = await listSelectableNetworks('solana');
    const custom = selectable.find((n) => n.id === 'custom:My Solana node');
    expect(custom).toBeDefined();
    expect(custom?.rpcUrls[0]).toBe('https://sol.example.com');
    expect(custom?.faucet).toBe(false);

    expect(await setSelectedNetworkId('solana', 'custom:My Solana node')).toBe(true);
    expect(await resolveNetworkRpcUrl('solana')).toBe('https://sol.example.com');

    await removeCustomNetwork('My Solana node');
    // The dangling selection falls back to the chain default — never to a
    // profile that no longer exists.
    expect(await getSelectedNetworkId('solana')).toBe(DEFAULT_NETWORK_IDS.solana);
    expect(await resolveNetworkRpcUrl('solana')).toBe(TESTNET_ENDPOINTS.solana);
  });

  it('custom networks round-trip through the store', async () => {
    await addCustomNetwork({ chain: 'evm', name: 'A', rpcUrl: 'https://a.example.com' });
    await addCustomNetwork({ chain: 'evm', name: 'B', rpcUrl: 'https://b.example.com' });
    expect((await getCustomNetworks()).map((n) => n.name)).toEqual(['A', 'B']);
    // Duplicate names are refused.
    expect(await addCustomNetwork({ chain: 'evm', name: 'A', rpcUrl: 'https://x' })).toBe(false);
  });
});

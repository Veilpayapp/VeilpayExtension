import { describe, expect, it } from 'vitest';
import {
  SPP_ASSET_SYMBOL,
  SPP_CONTRACT_CONFIG,
  SPP_KEY_DERIVATION_MESSAGE,
  SPP_NETWORK_PASSPHRASE,
  SPP_POOL_CONTRACT_ID,
  SPP_RPC_URL,
} from '@/core/spp/deployment';

/**
 * These constants pin on-chain trust: the wallet hard-codes WHICH contracts
 * it will derive pool keys against and move funds through. A single edited
 * character redirects every privacy operation to a different (possibly
 * attacker-controlled) deployment, so the invariants below fail loudly on
 * accidental edits — an emptied field, a swapped id, or a mainnet passphrase.
 */

/** Stellar account strkey: version byte 6<<3 encodes the G… prefix. */
const ACCOUNT_STRKEY = /^G[A-Z2-7]{55}$/;
/** Soroban contract strkey: version byte 2<<3 encodes the C… prefix. */
const CONTRACT_STRKEY = /^C[A-Z2-7]{55}$/;

/** All contract ids the deployment uses, for the distinctness checks. */
function allContractIds(): string[] {
  const config = SPP_CONTRACT_CONFIG;
  return [
    config.asp_membership,
    config.asp_non_membership,
    config.public_key_registry,
    ...Object.values(config.verifiers),
    ...config.pools.flatMap((pool) => [pool.poolContractId, pool.tokenContractId]),
  ];
}

describe('SPP deployment pinning', () => {
  it('pins the TESTNET network passphrase — never mainnet', () => {
    // The passphrase is hashed into every transaction signature and every
    // pool key derivation; a mainnet value would bind privacy keys to the
    // wrong network silently.
    expect(SPP_NETWORK_PASSPHRASE).toBe('Test SDF Network ; September 2015');
    expect(SPP_NETWORK_PASSPHRASE).not.toContain('Public Global');
  });

  it('pins an https Soroban TESTNET RPC endpoint', () => {
    expect(SPP_RPC_URL).toMatch(/^https:\/\//);
    expect(SPP_RPC_URL).toContain('soroban-testnet');
    expect(SPP_RPC_URL).not.toContain('mainnet');
  });

  it('the config agrees with the exported constants', () => {
    expect(SPP_CONTRACT_CONFIG.networkPassphrase).toBe(SPP_NETWORK_PASSPHRASE);
    expect(SPP_CONTRACT_CONFIG.rpcUrl).toBe(SPP_RPC_URL);
    expect(SPP_CONTRACT_CONFIG.network).toBe('testnet');
  });

  it('exposes exactly ONE enabled native-XLM pool with a blocklist policy', () => {
    expect(SPP_CONTRACT_CONFIG.pools).toHaveLength(1);
    const pool = SPP_CONTRACT_CONFIG.pools[0]!;
    expect(pool.enabled).toBe(true);
    expect(pool.asset.kind).toBe('native');
    expect(pool.policyFlags).toContain('blocklist');
    expect(pool.deploymentLedger).toBeGreaterThan(0);
  });

  it('SPP_POOL_CONTRACT_ID is the single enabled pool', () => {
    expect(SPP_POOL_CONTRACT_ID).toBe(SPP_CONTRACT_CONFIG.pools[0]!.poolContractId);
    expect(SPP_POOL_CONTRACT_ID).toMatch(CONTRACT_STRKEY);
  });

  it('the pool and its wrapped-token contract are distinct strkeys', () => {
    const pool = SPP_CONTRACT_CONFIG.pools[0]!;
    expect(pool.poolContractId).toMatch(CONTRACT_STRKEY);
    expect(pool.tokenContractId).toMatch(CONTRACT_STRKEY);
    expect(pool.tokenContractId).not.toBe(pool.poolContractId);
  });

  it('every contract id in the deployment is a strkey and pairwise distinct', () => {
    // If two roles ever share an id, one contract's events would be ingested
    // under another role's parser — a silent state-corruption bug.
    const ids = allContractIds();
    for (const id of ids) {
      expect(id).toMatch(CONTRACT_STRKEY);
    }
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('verifiers is a non-empty registry of contract strkeys', () => {
    const entries = Object.entries(SPP_CONTRACT_CONFIG.verifiers);
    expect(entries.length).toBeGreaterThan(0);
    for (const [key, id] of entries) {
      expect(key.length).toBeGreaterThan(0);
      expect(id).toMatch(CONTRACT_STRKEY);
    }
  });

  it('deployer and admin are account strkeys', () => {
    expect(SPP_CONTRACT_CONFIG.deployer).toMatch(ACCOUNT_STRKEY);
    expect(SPP_CONTRACT_CONFIG.admin).toMatch(ACCOUNT_STRKEY);
  });

  it('carries a non-empty KDF domain (it labels the stored privacy keys)', () => {
    expect(typeof SPP_CONTRACT_CONFIG.kdf_domain).toBe('string');
    expect(SPP_CONTRACT_CONFIG.kdf_domain.length).toBeGreaterThan(0);
  });

  it('the display symbol is pXLM', () => {
    expect(SPP_ASSET_SYMBOL).toBe('pXLM');
  });

  it('derives the key-derivation message from the pinned KDF domain', () => {
    // The message template is baked into the vendored SDK's WASM; the domain
    // is ours. Its signature IS the seed of the pool's privacy keys, and the
    // background signs this exact string and nothing else.
    expect(SPP_KEY_DERIVATION_MESSAGE).toBe('Privacy Pool Key Derivation [v2] (Veilpay)');
    expect(SPP_KEY_DERIVATION_MESSAGE).toContain(SPP_CONTRACT_CONFIG.kdf_domain);
  });
});

describe('the pinned config is immutable at runtime', () => {
  it('the config object and every nested object/array are frozen', () => {
    expect(Object.isFrozen(SPP_CONTRACT_CONFIG)).toBe(true);
    expect(Object.isFrozen(SPP_CONTRACT_CONFIG.pools)).toBe(true);
    expect(Object.isFrozen(SPP_CONTRACT_CONFIG.pools[0])).toBe(true);
    expect(Object.isFrozen(SPP_CONTRACT_CONFIG.pools[0]!.asset)).toBe(true);
    expect(Object.isFrozen(SPP_CONTRACT_CONFIG.pools[0]!.policyFlags)).toBe(true);
    expect(Object.isFrozen(SPP_CONTRACT_CONFIG.verifiers)).toBe(true);
  });

  it('mutating the pool id fails silently in strict mode and changes nothing', () => {
    'use strict';
    const before = SPP_CONTRACT_CONFIG.pools[0]!.poolContractId;
    expect(() => {
      (SPP_CONTRACT_CONFIG.pools[0] as { poolContractId?: string }).poolContractId =
        'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4';
    }).toThrow(TypeError);
    expect(SPP_CONTRACT_CONFIG.pools[0]!.poolContractId).toBe(before);
  });
});

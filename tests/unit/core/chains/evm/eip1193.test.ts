import { describe, expect, it } from 'vitest';
import { EIP1193, eip1193CodeFor, eip1193Error } from '@/core/chains/evm/eip1193';
import { findEvmNetworkByChainId } from '@/core/networks';

describe('eip1193 helpers', () => {
  it('resolves Sepolia by chain id through the network registry', () => {
    expect(findEvmNetworkByChainId(11155111)?.id).toBe('evm:sepolia');
  });

  it('resolves every supported EVM network by its live-verified chain id', () => {
    expect(findEvmNetworkByChainId(1)?.id).toBe('evm:ethereum');
    expect(findEvmNetworkByChainId(8453)?.id).toBe('evm:base');
    expect(findEvmNetworkByChainId(137)?.id).toBe('evm:polygon');
    expect(findEvmNetworkByChainId(42161)?.id).toBe('evm:arbitrum');
    expect(findEvmNetworkByChainId(10)?.id).toBe('evm:optimism');
    expect(findEvmNetworkByChainId(43114)?.id).toBe('evm:avalanche');
  });

  it('returns undefined for a chain id no preset carries', () => {
    expect(findEvmNetworkByChainId(123456789)).toBeUndefined();
  });

  it('maps the protocol CHAIN_UNSUPPORTED code to EIP-1193 4902', () => {
    expect(eip1193CodeFor('CHAIN_UNSUPPORTED')).toBe(4902);
  });

  it('maps unknown protocol kinds to EIP-1193 4200 (unsupported method)', () => {
    expect(eip1193CodeFor('UNKNOWN_KIND')).toBe(4200);
  });

  it('returns undefined for codes with no EIP-1193 mapping', () => {
    expect(eip1193CodeFor('USER_REJECTED')).toBeUndefined();
    expect(eip1193CodeFor('VAULT_LOCKED')).toBeUndefined();
  });

  it('builds an error with a numeric EIP-1193 code', () => {
    const err = eip1193Error(EIP1193.UNRECOGNIZED_CHAIN, 'Unrecognized chain.');
    expect(err.code).toBe(4902);
    expect(err.message).toBe('Unrecognized chain.');
    expect(err).toBeInstanceOf(Error);
  });
});

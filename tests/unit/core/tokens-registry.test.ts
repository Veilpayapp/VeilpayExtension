import { beforeEach, describe, expect, it } from 'vitest';
import {
  addCustomToken,
  listCustomTokens,
  removeCustomToken,
  tokenId,
  type CustomToken,
} from '@/core/tokens';

/**
 * Custom token registry invariants — the MetaMask-style "add token" store.
 *
 * Persisted in the vault's meta store; validation at the boundary so a
 * malformed row never surfaces as a selectable token.
 */

const ERC20: CustomToken = {
  id: tokenId('evm', 'erc20', '0x0000000000000000000000000000000000000001'),
  chain: 'evm',
  kind: 'erc20',
  address: '0x0000000000000000000000000000000000000001',
  symbol: 'TST',
  name: 'Test Token',
  decimals: 18,
  addedAt: 1,
};

const SPL: CustomToken = {
  id: tokenId('solana', 'spl', 'So11111111111111111111111111111111111111112'),
  chain: 'solana',
  kind: 'spl',
  address: 'So11111111111111111111111111111111111111112',
  symbol: 'wSOL',
  decimals: 9,
  addedAt: 2,
};

const ISSUED: CustomToken = {
  id: tokenId('stellar', 'stellar-issued', 'USDC:GA5ZSEJYB37JRG5AZCAJS2BJO4NFXTXGBEPBLZ6DVLD6DP5MGWDOZKAQ'),
  chain: 'stellar',
  kind: 'stellar-issued',
  code: 'USDC',
  issuer: 'GA5ZSEJYB37JRG5AZCAJS2BJO4NFXTXGBEPBLZ6DVLD6DP5MGWDOZKAQ',
  symbol: 'USDC',
  decimals: 7,
  addedAt: 3,
};

beforeEach(async () => {
  await import('@/core/vault/storage').then(({ writeMeta }) =>
    writeMeta('tokens:custom', undefined),
  );
});

describe('token ids', () => {
  it('derives stable, chain-distinct ids', () => {
    expect(tokenId('evm', 'erc20', '0xABC')).toBe('evm:erc20:0xabc'); // case-insensitive
    expect(tokenId('solana', 'spl', 'Mint123')).toBe('solana:spl:Mint123');
    expect(tokenId('stellar', 'stellar-issued', 'USDC:GISSUER')).toBe('stellar:issued:USDC:GISSUER');
    expect(tokenId('evm', 'erc20', '0xABC')).not.toBe(tokenId('solana', 'spl', '0xABC'));
  });
});

describe('registry round-trips', () => {
  it('adds and lists tokens across chains', async () => {
    expect(await addCustomToken(ERC20)).toBe(true);
    expect(await addCustomToken(SPL)).toBe(true);
    expect(await addCustomToken(ISSUED)).toBe(true);

    const all = await listCustomTokens();
    expect(all.map((t) => t.id).sort()).toEqual([ERC20.id, SPL.id, ISSUED.id].sort());

    const stellarOnly = await listCustomTokens('stellar');
    expect(stellarOnly).toHaveLength(1);
    expect(stellarOnly[0]!.code).toBe('USDC');
  });

  it('rejects a duplicate token (same id)', async () => {
    expect(await addCustomToken(ERC20)).toBe(true);
    expect(await addCustomToken({ ...ERC20, symbol: 'OTHER' })).toBe(false);
    expect((await listCustomTokens())).toHaveLength(1);
  });

  it('removes a token by id and tolerates unknown ids', async () => {
    await addCustomToken(ERC20);
    await addCustomToken(SPL);

    await removeCustomToken(ERC20.id);
    const remaining = await listCustomTokens();
    expect(remaining.map((t) => t.id)).toEqual([SPL.id]);

    // Removing again is a no-op, not an error.
    await removeCustomToken(ERC20.id);
    expect(await listCustomTokens()).toHaveLength(1);
  });

  it('drops malformed rows rather than surfacing them', async () => {
    await import('@/core/vault/storage').then(({ writeMeta }) =>
      writeMeta('tokens:custom', [
        'not-an-object',
        42,
        { id: 'x', chain: 'evm', kind: 'nope', symbol: 'S', decimals: 1, addedAt: 1 },
        ERC20,
      ]),
    );
    const tokens = await listCustomTokens();
    expect(tokens).toHaveLength(1);
    expect(tokens[0]!.id).toBe(ERC20.id);
  });
});

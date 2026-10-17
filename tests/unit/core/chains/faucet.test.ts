import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  SOLANA_FAUCET_AMOUNT_lamports,
  requestTestnetFaucet,
} from '@/core/chains/faucet';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('requestTestnetFaucet', () => {
  it('requests a Solana devnet airdrop via JSON-RPC', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ jsonrpc: '2.0', result: 'sig123' }));
    vi.stubGlobal('fetch', fetchImpl);

    const result = await requestTestnetFaucet('solana', '11111111111111111111111111111111');

    expect(result).toEqual({ ok: true, chain: 'solana', txHash: 'sig123' });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.devnet.solana.com');
    const body = JSON.parse(String(init.body)) as {
      method: string;
      params: unknown[];
    };
    expect(body.method).toBe('requestAirdrop');
    expect(body.params[0]).toBe('11111111111111111111111111111111');
    // Lamports ride as a JSON NUMBER: the public Solana RPCs reject string
    // amounts ("invalid type: string, expected u64").
    expect(body.params[1]).toBe(Number(SOLANA_FAUCET_AMOUNT_lamports));
    expect(typeof body.params[1]).toBe('number');
  });

  it('falls back to the Solana web faucet when the automatic airdrop fails', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse({ jsonrpc: '2.0', error: { message: 'Invalid request' } }),
      ),
    );
    const result = await requestTestnetFaucet('solana', 'bad');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.faucetUrl).toContain('faucet.solana.com');
      expect(result.faucetUrl).toContain(encodeURIComponent('bad'));
    }
  });

  it('funds a Stellar address via Friendbot', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ hash: 'stellar-hash' }));
    vi.stubGlobal('fetch', fetchImpl);

    const result = await requestTestnetFaucet('stellar', 'GA...');

    expect(result).toEqual({ ok: true, chain: 'stellar', txHash: 'stellar-hash' });
    const [url] = fetchImpl.mock.calls[0] as unknown as [string];
    expect(url.startsWith('https://friendbot.stellar.org?addr=')).toBe(true);
    expect(url).toContain(encodeURIComponent('GA...'));
  });

  it('returns the Sepolia web faucet URL for EVM (CAPTCHA-bound)', async () => {
    const result = await requestTestnetFaucet('evm', '0xabc123');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.faucetUrl).toContain('sepoliafaucet.com');
      expect(result.faucetUrl).toContain(encodeURIComponent('0xabc123'));
    }
  });

  it('never makes a network call for EVM', async () => {
    const fetchImpl = vi.fn();
    vi.stubGlobal('fetch', fetchImpl);
    await requestTestnetFaucet('evm', '0x0');
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
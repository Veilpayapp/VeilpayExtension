import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createEvmService, createSolanaService, createStellarService } from '@/core/chains';

describe('Chain Services', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    global.fetch = fetchMock;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('EVM Service', () => {
    it('gets balance via eth_getBalance', async () => {
      const service = createEvmService('http://localhost:8545');

      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          jsonrpc: '2.0',
          result: '0x0de0b6b3a7640000',
          id: 1,
        }),
      });

      const balance = await service.getBalance('0x1234567890123456789012345678901234567890');

      expect(balance).toBe(BigInt('0x0de0b6b3a7640000'));
      expect(fetchMock).toHaveBeenCalledWith('http://localhost:8545', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: expect.stringContaining('eth_getBalance'),
      });
    });

    it('estimates gas via eth_estimateGas', async () => {
      const service = createEvmService();

      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          jsonrpc: '2.0',
          result: '0x5208',
          id: 1,
        }),
      });

      const gas = await service.estimateGas({ to: '0x456', value: '0x100' });

      expect(gas).toBe(BigInt('0x5208'));
    });

    it('sends a transaction via eth_sendRawTransaction', async () => {
      const service = createEvmService();

      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          jsonrpc: '2.0',
          result: '0xabcdef1234567890',
          id: 1,
        }),
      });

      const txHash = await service.sendTransaction('0x02f86...');

      expect(txHash).toBe('0xabcdef1234567890');
    });

    it('propagates JSON-RPC errors', async () => {
      const service = createEvmService();

      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          jsonrpc: '2.0',
          error: { code: -32600, message: 'Invalid Request' },
          id: 1,
        }),
      });

      await expect(service.getBalance('0x123')).rejects.toThrow(/Invalid Request/);
    });

    it('propagates HTTP errors', async () => {
      const service = createEvmService();

      fetchMock.mockResolvedValueOnce({
        ok: false,
        status: 500,
      });

      await expect(service.getBalance('0x123')).rejects.toThrow(/HTTP 500/);
    });
  });

  describe('Solana Service', () => {
    it('gets balance via getBalance RPC', async () => {
      const service = createSolanaService();

      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          jsonrpc: '2.0',
          result: { value: 5000000000 },
          id: 1,
        }),
      });

      const balance = await service.getBalance(
        'So11111111111111111111111111111111111111112',
      );

      expect(balance).toBe(BigInt(5000000000));
    });

    it('estimates gas as a fixed fee', async () => {
      const service = createSolanaService();

      const gas = await service.estimateGas({});

      expect(gas).toBe(BigInt(5000));
    });

    it('sends a transaction via sendTransaction RPC', async () => {
      const service = createSolanaService();

      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          jsonrpc: '2.0',
          result: 'tx_signature_base58',
          id: 1,
        }),
      });

      const signature = await service.sendTransaction('base64encodedtx');

      expect(signature).toBe('tx_signature_base58');
    });

    it('gets sequence number via getAccountInfo RPC', async () => {
      const service = createSolanaService();

      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          jsonrpc: '2.0',
          result: {
            value: {
              lamports: 1000000,
              owner: 'TokenkegQfeZyiNwAJsyFbPVwwQQfHub6PuCvjLjsm6',
            },
          },
          id: 1,
        }),
      });

      const seq = await service.getSequence('Some11111111111111111111111111111111111112');

      // Solana doesn't have a sequence number; we return 0 as a placeholder.
      expect(seq).toBe(BigInt(0));
    });
  });

  describe('Stellar Service', () => {
    it('gets balance from Horizon /accounts', async () => {
      const service = createStellarService();

      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          id: 'GDZST3XVCDTUJ76ZAV2HA72KYQJPOTPXP4NO5WYOXQJ5FNJR7G64AAAA',
          account_id: 'GDZST3XVCDTUJ76ZAV2HA72KYQJPOTPXP4NO5WYOXQJ5FNJR7G64AAAA',
          balances: [
            {
              balance: '50.0000000',
              asset_type: 'native',
            },
          ],
          sequence: '123',
        }),
      });

      const balance = await service.getBalance('GDZST3XVCDTUJ76ZAV2HA72KYQJPOTPXP4NO5WYOXQJ5FNJR7G64AAAA');

      // 50 XLM = 500000000 stroops
      expect(balance).toBe(BigInt(500000000));
    });

    it('reads high-precision XLM balances into exact stroops (no float rounding)', async () => {
      const service = createStellarService();

      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          id: 'GDZST3XVCDTUJ76ZAV2HA72KYQJPOTPXP4NO5WYOXQJ5FNJR7G64AAAA',
          balances: [
            {
              balance: '1.0000001',
              asset_type: 'native',
            },
          ],
          sequence: '1',
        }),
      });

      const balance = await service.getBalance('GDZST3XVCDTUJ76ZAV2HA72KYQJPOTPXP4NO5WYOXQJ5FNJR7G64AAAA');

      // 1 XLM + 1 stroop = 10000001 stroops, exact to the last stroop.
      expect(balance).toBe(BigInt(10000001));
    });

    it('estimates gas as 100 stroops', async () => {
      const service = createStellarService();

      const gas = await service.estimateGas({});

      expect(gas).toBe(BigInt(100));
    });

    it('sends a transaction via Horizon /transactions POST', async () => {
      const service = createStellarService();

      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          hash: 'abc123...',
          ledger: 100,
        }),
      });

      const txHash = await service.sendTransaction('xdr_base64_string');

      expect(txHash).toBe('abc123...');
      expect(fetchMock).toHaveBeenCalledWith(
        expect.stringContaining('/transactions'),
        expect.objectContaining({ method: 'POST' }),
      );
    });

    it('surfaces Horizon result_codes (transaction + operations) on a failed POST', async () => {
      const service = createStellarService();

      fetchMock.mockResolvedValueOnce({
        ok: false,
        status: 400,
        json: async () => ({
          type: 'https://stellar.org/horizon-errors/transaction_failed',
          title: 'Transaction Failed',
          status: 400,
          detail: 'The transaction failed when submitting to the Stellar network.',
          extras: {
            result_codes: {
              transaction: 'tx_failed',
              operations: ['op_underfunded'],
            },
          },
        }),
      });

      await expect(service.sendTransaction('xdr_base64_string')).rejects.toThrow(
        'result_codes: {"transaction":"tx_failed","operations":["op_underfunded"]}',
      );
    });

    it('gets sequence number from Horizon /accounts', async () => {
      const service = createStellarService();

      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          id: 'GDZST3XVCDTUJ76ZAV2HA72KYQJPOTPXP4NO5WYOXQJ5FNJR7G64AAAA',
          sequence: '456',
        }),
      });

      const seq = await service.getSequence('GDZST3XVCDTUJ76ZAV2HA72KYQJPOTPXP4NO5WYOXQJ5FNJR7G64AAAA');

      expect(seq).toBe(BigInt(456));
    });

    it('treats a 404 (never-funded account) as a zero balance', async () => {
      const service = createStellarService();

      fetchMock.mockResolvedValueOnce({
        ok: false,
        status: 404,
      });

      // Horizon returns 404 for addresses that have never been funded — that is
      // a fresh account (0 balance / no sequence), not an error.
      expect(await service.getBalance('GDZST3XVCDTUJ76ZAV2HA72KYQJPOTPXP4NO5WYOXQJ5FNJR7G64AAAA')).toBe(0n);
      fetchMock.mockResolvedValueOnce({
        ok: false,
        status: 404,
      });
      expect(await service.getSequence('GDZST3XVCDTUJ76ZAV2HA72KYQJPOTPXP4NO5WYOXQJ5FNJR7G64AAAA')).toBe(0n);
    });

    it('propagates non-404 Horizon HTTP errors', async () => {
      const service = createStellarService();

      fetchMock.mockResolvedValueOnce({
        ok: false,
        status: 500,
      });

      await expect(service.getBalance('GDZST3XVCDTUJ76ZAV2HA72KYQJPOTPXP4NO5WYOXQJ5FNJR7G64AAAA')).rejects.toThrow(
        /HTTP 500/,
      );
    });

    it('reports an unfunded account as not funded (isFunded=false)', async () => {
      const service = createStellarService();
      const funded = service.isFunded as ((a: string) => Promise<boolean>) | undefined;
      expect(funded).toBeTypeOf('function');
      const isFunded = (funded as (a: string) => Promise<boolean>).bind(service);

      fetchMock.mockResolvedValueOnce({ ok: false, status: 404 });
      expect(await isFunded('GDZST3XVCDTUJ76ZAV2HA72KYQJPOTPXP4NO5WYOXQJ5FNJR7G64AAAA')).toBe(false);

      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ balances: [], sequence: '456' }),
      });
      expect(await isFunded('GDZST3XVCDTUJ76ZAV2HA72KYQJPOTPXP4NO5WYOXQJ5FNJR7G64AAAA')).toBe(true);
    });

    it('surfaces Horizon transaction rejection detail (not just the HTTP code)', async () => {
      const service = createStellarService();

      fetchMock.mockResolvedValueOnce({
        ok: false,
        status: 400,
        json: async () => ({ detail: 'tx_bad_seq: bad sequence', title: 'Transaction Failed' }),
      });

      await expect(service.sendTransaction('xdr_base64_string')).rejects.toThrow(/tx_bad_seq/);
    });

    // ── Stealth payment support surface ────────────────────────────────────

    /** Base64 for mock Horizon payloads (jsdom-safe, no Buffer dependency). */
    function b64(bytes: Uint8Array): string {
      return btoa(String.fromCharCode(...bytes));
    }

    it('reads manage_data entries with base64 values decoded', async () => {
      const service = createStellarService();
      const entry = new Uint8Array([1, 2, 3, 4]);

      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          balances: [],
          sequence: '1',
          data: {
            vpstealth: { value: b64(entry) },
            other: { value: b64(new Uint8Array(8).fill(9)) },
          },
        }),
      });

      const entries = await service.getAccountDataEntries!('GDZST3XVCDTUJ76ZAV2HA72KYQJ5FNJR7G64AAAA');
      expect(entries['vpstealth']).toEqual(entry);
      expect(entries['other']).toHaveLength(8);
    });

    it('returns no data entries for an unfunded account', async () => {
      const service = createStellarService();

      fetchMock.mockResolvedValueOnce({ ok: false, status: 404 });

      const entries = await service.getAccountDataEntries!('GDZST3XVCDTUJ76ZAV2HA72KYQJ5FNJR7G64AAAA');
      expect(entries).toEqual({});
    });

    it('skips malformed data entries instead of failing the read', async () => {
      const service = createStellarService();

      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          balances: [],
          sequence: '1',
          data: { vpstealth: { value: '%%%not-base64%%%' } },
        }),
      });

      const entries = await service.getAccountDataEntries!('GDZST3XVCDTUJ76ZAV2HA72KYQJ5FNJR7G64AAAA');
      expect(entries['vpstealth']).toBeUndefined();
    });

    it('lists recent MEMO_HASH transactions with the request excluding failed txs', async () => {
      const service = createStellarService();
      const memo = new Uint8Array(32).fill(0xab);

      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          _embedded: {
            records: [
              {
                hash: 'tx-hash-1',
                memo_type: 'hash',
                memo: b64(memo),
                created_at: '2024-01-01T00:00:00Z',
              },
              { hash: 'tx-hash-2', memo_type: 'none' }, // skipped: not a hash memo
              { hash: 'tx-hash-3', memo_type: 'text', memo: 'hello' }, // skipped
            ],
          },
        }),
      });

      const result = await service.listRecentHashMemoTransactions!(50);
      expect(result).toHaveLength(1);
      expect(result[0]!.txHash).toBe('tx-hash-1');
      expect(result[0]!.memoBytes).toEqual(memo);
      expect(result[0]!.createdAt).toBe('2024-01-01T00:00:00Z');
      // Failed transactions can never carry value: they are excluded so the
      // scan surface stays clean.
      expect(fetchMock).toHaveBeenCalledWith(
        expect.stringContaining('include_failed=false'),
        expect.anything(),
      );
    });

    it('paginates the memo scan across pages using the cursor', async () => {
      const service = createStellarService();
      const page1Memo = new Uint8Array(32).fill(0x11);
      const page2Memo = new Uint8Array(32).fill(0x22);

      // Page 1: one hash-memo tx + a paging token to continue from.
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          _embedded: {
            records: [
              {
                hash: 'tx-newer',
                memo_type: 'hash',
                memo: b64(page1Memo),
                created_at: '2024-01-02T00:00:00Z',
                paging_token: '1002',
              },
              { hash: 'tx-plain', memo_type: 'none', paging_token: '1001' },
            ],
          },
        }),
      });
      // Page 2: one more hash-memo tx, then the next page is empty → stop.
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          _embedded: {
            records: [
              {
                hash: 'tx-older',
                memo_type: 'hash',
                memo: b64(page2Memo),
                created_at: '2024-01-01T00:00:00Z',
                paging_token: '900',
              },
            ],
          },
        }),
      });
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ _embedded: { records: [] } }),
      });

      const result = await service.listRecentHashMemoTransactions!(200, 5);
      expect(result.map((r) => r.txHash)).toEqual(['tx-newer', 'tx-older']);
      // The second page request must carry the cursor from page 1.
      const secondCall = fetchMock.mock.calls[1]![0] as string;
      expect(secondCall).toContain('cursor=1001');
    });

    it('reads one transaction memo by hash', async () => {
      const service = createStellarService();
      const memo = new Uint8Array(32).fill(0xcd);

      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          hash: 'tx-hash-1',
          memo_type: 'hash',
          memo: b64(memo),
        }),
      });
      expect(await service.getTransactionMemo!('tx-hash-1')).toEqual(memo);

      // A text-memo transaction has no announcement.
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ hash: 'tx-hash-2', memo_type: 'text', memo: 'hi' }),
      });
      expect(await service.getTransactionMemo!('tx-hash-2')).toBeNull();
    });

    it('reads the live base reserve from the latest ledger', async () => {
      const service = createStellarService();

      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          _embedded: { records: [{ base_reserve_in_stroops: '5000000' }] },
        }),
      });
      expect(await service.getBaseReserve!()).toBe(5_000_000n);

      // A failed ledger read falls back to the historical constant.
      fetchMock.mockResolvedValueOnce({ ok: false, status: 500 });
      expect(await service.getBaseReserve!()).toBe(5_000_000n);
    });
  });

  describe('cross-chain interface', () => {
    it('all services expose the chain property', () => {
      const evm = createEvmService();
      const solana = createSolanaService();
      const stellar = createStellarService();

      expect(evm.chain).toBe('evm');
      expect(solana.chain).toBe('solana');
      expect(stellar.chain).toBe('stellar');
    });

    it('all services support getBalance', async () => {
      const services = [createEvmService(), createSolanaService(), createStellarService()];

      for (const service of services) {
        expect(typeof service.getBalance).toBe('function');
      }
    });
  });
});

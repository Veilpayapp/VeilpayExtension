import { describe, expect, it } from 'vitest';
import { TxEstimateRequest, TxTransferRequest } from '@/core/messaging/protocol';

// Schema-valid Stellar strkey shape: G + 55 of [A-Z2-7] (regex only; no checksum check here).
const G = 'G' + 'A'.repeat(55);

function envelope(payload: unknown) {
  return {
    id: '00000000-0000-4000-8000-000000000000',
    source: 'popup',
    v: 1,
    kind: 'tx.transfer',
    payload,
  };
}

describe('transfer payload schema', () => {
  it('accepts a whole-number amount', () => {
    expect(TxTransferRequest.safeParse(envelope({
      chain: 'evm', index: 0, to: '0xabc', amount: '1',
    })).success).toBe(true);
  });

  it('accepts a fractional amount (human-readable native units)', () => {
    const result = TxTransferRequest.safeParse(envelope({
      chain: 'stellar', index: 0, to: G, amount: '0.5',
    }));
    expect(result.success).toBe(true);
  });

  it('rejects a malformed amount', () => {
    expect(TxTransferRequest.safeParse(envelope({
      chain: 'evm', index: 0, to: '0xabc', amount: 'abc',
    })).success).toBe(false);
    expect(TxTransferRequest.safeParse(envelope({
      chain: 'evm', index: 0, to: '0xabc', amount: '-1',
    })).success).toBe(false);
    // More than 30 fractional digits would risk overflowing uint256 base units.
    expect(TxTransferRequest.safeParse(envelope({
      chain: 'evm', index: 0, to: '0xabc', amount: '0.' + '9'.repeat(40),
    })).success).toBe(false);
  });

  it('accepts a native Stellar asset', () => {
    const result = TxTransferRequest.safeParse(envelope({
      chain: 'stellar', index: 0, to: G,
      amount: '1', asset: { type: 'native' },
    }));
    expect(result.success).toBe(true);
  });

  it('accepts an issued Stellar asset with a valid code and issuer', () => {
    const result = TxTransferRequest.safeParse(envelope({
      chain: 'stellar', index: 0, to: G,
      amount: '12.5',
      asset: { type: 'issued', code: 'USDC', issuer: G },
    }));
    expect(result.success).toBe(true);
  });

  it('rejects an issued asset with an oversized code or malformed issuer', () => {
    expect(TxTransferRequest.safeParse(envelope({
      chain: 'stellar', index: 0, to: G,
      amount: '1', asset: { type: 'issued', code: 'TOOLONGCODE123', issuer: G },
    })).success).toBe(false);
    expect(TxTransferRequest.safeParse(envelope({
      chain: 'stellar', index: 0, to: G,
      amount: '1', asset: { type: 'issued', code: 'USDC', issuer: 'not-an-address' },
    })).success).toBe(false);
  });

  it('requires an amount (no base-unit field anymore)', () => {
    const result = TxEstimateRequest.safeParse(envelope({
      chain: 'solana', index: 0, to: 'abc',
    }) as Record<string, unknown>);
    expect(result.success).toBe(false);
  });
});

describe('TokenInput token selection', () => {
  const EVM = '0x' + 'ab'.repeat(20);
  const SPL = '9' + 'a'.repeat(31);

  it('accepts a native token (default) across every chain', () => {
    for (const chain of ['evm', 'solana', 'stellar'] as const) {
      const result = TxTransferRequest.safeParse(envelope({
        chain, index: 0, to: 'recipient', amount: '1', token: { kind: 'native' },
      }));
      expect(result.success).toBe(true);
    }
  });

  it('accepts an ERC20 token on EVM', () => {
    const result = TxTransferRequest.safeParse(envelope({
      chain: 'evm', index: 0, to: '0xrecipient', amount: '3.14', token: { kind: 'erc20', address: EVM },
    }));
    expect(result.success).toBe(true);
  });

  it('accepts an SPL token on Solana', () => {
    const result = TxTransferRequest.safeParse(envelope({
      chain: 'solana', index: 0, to: 'recipient', amount: '1.5', token: { kind: 'spl', mint: SPL },
    }));
    expect(result.success).toBe(true);
  });

  it('rejects an ERC20 with a malformed contract address', () => {
    expect(TxTransferRequest.safeParse(envelope({
      chain: 'evm', index: 0, to: 'r', amount: '1', token: { kind: 'erc20', address: '0x123' },
    })).success).toBe(false);
  });

  it('rejects an unknown token kind', () => {
    expect(TxTransferRequest.safeParse(envelope({
      chain: 'evm', index: 0, to: 'r', amount: '1', token: { kind: 'bitcoin' },
    })).success).toBe(false);
  });

  it('rejects an SPL mint that is too short', () => {
    expect(TxTransferRequest.safeParse(envelope({
      chain: 'solana', index: 0, to: 'r', amount: '1', token: { kind: 'spl', mint: 'abc' },
    })).success).toBe(false);
  });
});

describe('transfer memo (Stellar MEMO_TEXT)', () => {
  it('accepts an optional memo up to 28 characters', () => {
    expect(TxTransferRequest.safeParse(envelope({
      chain: 'stellar', index: 0, to: G, amount: '1',
    })).success).toBe(true);
    expect(TxTransferRequest.safeParse(envelope({
      chain: 'stellar', index: 0, to: G, amount: '1', memo: 'order-123',
    })).success).toBe(true);
    expect(TxTransferRequest.safeParse(envelope({
      chain: 'stellar', index: 0, to: G, amount: '1', memo: 'x'.repeat(28),
    })).success).toBe(true);
  });

  it('rejects a memo longer than 28 characters', () => {
    expect(TxTransferRequest.safeParse(envelope({
      chain: 'stellar', index: 0, to: G, amount: '1', memo: 'x'.repeat(29),
    })).success).toBe(false);
  });

  it('keeps the memo optional and untyped on the estimate request', () => {
    // The estimate shares TransferPayload minus the memo; a memo key in an
    // estimate payload is stripped by zod rather than changing the estimate.
    const result = TxEstimateRequest.safeParse({
      ...envelope({
        chain: 'stellar', index: 0, to: G, amount: '1', memo: 'order-123',
      }),
      kind: 'tx.estimate',
    });
    expect(result.success).toBe(true);
    expect((result.success ? result.data : null)?.payload).not.toHaveProperty('memo');
  });
});

describe('privacy payment flag (Stellar stealth)', () => {
  it('accepts private: true on a Stellar transfer', () => {
    const result = TxTransferRequest.safeParse(envelope({
      chain: 'stellar', index: 0, to: G, amount: '1', private: true,
    }));
    expect(result.success).toBe(true);
  });

  it('keeps the flag optional (normal sends are unaffected)', () => {
    expect(TxTransferRequest.safeParse(envelope({
      chain: 'stellar', index: 0, to: G, amount: '1',
    })).success).toBe(true);
  });

  it('rejects a non-boolean private flag', () => {
    expect(TxTransferRequest.safeParse(envelope({
      chain: 'stellar', index: 0, to: G, amount: '1', private: 'yes',
    })).success).toBe(false);
  });

  it('strips the private flag from estimate requests (fee reads never carry it)', () => {
    const result = TxEstimateRequest.safeParse({
      ...envelope({
        chain: 'stellar', index: 0, to: G, amount: '1', private: true,
      }),
      kind: 'tx.estimate',
    });
    expect(result.success).toBe(true);
    expect((result.success ? result.data : null)?.payload).not.toHaveProperty('private');
  });
});

describe('stellar stealth request schemas', () => {
  it('meta request requires a valid Stellar G address', async () => {
    const { StellarStealthMetaRequest } = await import('@/core/messaging/protocol');
    const base = {
      id: '00000000-0000-4000-8000-000000000000',
      source: 'popup',
      v: 1,
      kind: 'stellar.stealth.meta',
    };
    expect(StellarStealthMetaRequest.safeParse({
      ...base, payload: { address: G },
    }).success).toBe(true);
    expect(StellarStealthMetaRequest.safeParse({
      ...base, payload: { address: 'not-a-strkey' },
    }).success).toBe(false);
    expect(StellarStealthMetaRequest.safeParse({
      ...base, payload: {},
    }).success).toBe(false);
  });

  it('publish and scan take empty payloads', async () => {
    const { StellarStealthPublishRequest, StellarStealthScanRequest } = await import(
      '@/core/messaging/protocol'
    );
    expect(StellarStealthPublishRequest.safeParse({
      id: '00000000-0000-4000-8000-000000000000',
      source: 'popup',
      v: 1,
      kind: 'stellar.stealth.publish',
      payload: {},
    }).success).toBe(true);
    expect(StellarStealthScanRequest.safeParse({
      id: '00000000-0000-4000-8000-000000000000',
      source: 'popup',
      v: 1,
      kind: 'stellar.stealth.scan',
      payload: {},
    }).success).toBe(true);
  });

  it('claim requires the announcement transaction hash', async () => {
    const { StellarStealthClaimRequest } = await import('@/core/messaging/protocol');
    const base = {
      id: '00000000-0000-4000-8000-000000000000',
      source: 'popup',
      v: 1,
      kind: 'stellar.stealth.claim',
    };
    expect(StellarStealthClaimRequest.safeParse({
      ...base, payload: { txHash: 'abc123' },
    }).success).toBe(true);
    expect(StellarStealthClaimRequest.safeParse({
      ...base, payload: {},
    }).success).toBe(false);
    expect(StellarStealthClaimRequest.safeParse({
      ...base, payload: { txHash: '' },
    }).success).toBe(false);
  });

  it('marks the privileged stealth kinds so pages can never reach them', async () => {
    const { isPrivilegedKind } = await import('@/core/messaging/protocol');
    expect(isPrivilegedKind('stellar.stealth.publish')).toBe(true);
    expect(isPrivilegedKind('stellar.stealth.scan')).toBe(true);
    expect(isPrivilegedKind('stellar.stealth.claim')).toBe(true);
    // meta is a public read, exactly like an address lookup.
    expect(isPrivilegedKind('stellar.stealth.meta')).toBe(false);
  });
});

describe('tx response schema (token fields + error code)', () => {
  it('accepts the new tx.estimate response fields', async () => {
    const { Response } = await import('@/core/messaging/protocol');
    const ok = Response.safeParse({
      id: '00000000-0000-4000-8000-000000000000',
      ok: true,
      data: {
        chain: 'evm',
        from: '0x' + 'ab'.repeat(20),
        feeNative: '21000000000',
        gasLimit: '21000',
        decimals: 6,
        spendableBalance: '100000000',
        symbol: 'USDC',
      },
    } as unknown);
    expect(ok.success).toBe(true);
  });

  it('accepts a response missing the optional symbol', async () => {
    const { Response } = await import('@/core/messaging/protocol');
    const ok = Response.safeParse({
      id: '00000000-0000-4000-8000-000000000000',
      ok: true,
      data: {
        chain: 'solana',
        from: 'addr',
        feeNative: '5000',
        gasLimit: '1',
        decimals: 9,
        spendableBalance: '0',
      },
    } as unknown);
    expect(ok.success).toBe(true);
  });

  it('accepts INSUFFICIENT_BALANCE as a transportable error code', async () => {
    const { Response } = await import('@/core/messaging/protocol');
    const err = Response.safeParse({
      id: '00000000-0000-4000-8000-000000000000',
      ok: false,
      error: { code: 'INSUFFICIENT_BALANCE', message: 'Insufficient token balance.' },
    });
    expect(err.success).toBe(true);
  });

  // Response `data` is intentionally `z.unknown()` on the wire — the shape of
  // each response kind is enforced at compile time by `ResponseData`/HandlerMap,
  // not by a runtime schema. This documents that the new fields are part of the
  // typed contract (see `ResponseData['tx.estimate']`).
  it('treats the response body as opaque JSON on the wire', async () => {
    const { Response } = await import('@/core/messaging/protocol');
    const ok = Response.safeParse({
      id: '00000000-0000-4000-8000-000000000000',
      ok: true,
      data: { any: ['body', 'is', 'allowed'] },
    });
    expect(ok.success).toBe(true);
  });
});

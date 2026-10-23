import { describe, expect, it } from 'vitest';
import { estimateTransferFee, type EvmFeeSource } from '@/core/chains/evm/fees';

const FROM = '0x0000000000000000000000000000000000000001';
const TO = '0x0000000000000000000000000000000000000002';

function source(overrides: Partial<EvmFeeSource> = {}): EvmFeeSource {
  return {
    maxPriorityFeePerGas: async () => 2_000_000_000n, // 2 gwei
    baseFeePerGas: async () => 20_000_000_000n, // 20 gwei
    estimateGas: async () => 21_000n,
    ...overrides,
  };
}

describe('estimateTransferFee', () => {
  it('uses the RPC values when they are sane', async () => {
    const fee = await estimateTransferFee(source(), FROM, TO, 1n);
    expect(fee.maxPriorityFeePerGas).toBe(2_000_000_000n);
    expect(fee.maxFeePerGas).toBe(42_000_000_000n); // 2*20 + 2
    expect(fee.gasLimit).toBe(21_000n);
    expect(fee.totalFeeWei).toBe(42_000_000_000n * 21_000n);
  });

  it('floors the tip at 1 gwei so a zero-tip network still confirms', async () => {
    const fee = await estimateTransferFee(
      source({ maxPriorityFeePerGas: async () => 0n }),
      FROM,
      TO,
      1n,
    );
    expect(fee.maxPriorityFeePerGas).toBe(1_000_000_000n);
  });

  it('clamps a hostile RPC tip to 100 gwei (the tip is paid in full)', async () => {
    const fee = await estimateTransferFee(
      source({ maxPriorityFeePerGas: async () => 100_000_000_000_000_000_000n }), // 0.1 ETH/gas
      FROM,
      TO,
      1n,
    );
    expect(fee.maxPriorityFeePerGas).toBe(100_000_000_000n);
  });

  it('clamps a hostile RPC base fee to 10,000 gwei', async () => {
    const fee = await estimateTransferFee(
      source({ baseFeePerGas: async () => 1_000_000_000_000_000_000n }), // 1 ETH/gas
      FROM,
      TO,
      1n,
    );
    expect(fee.maxFeePerGas).toBe(10_000_000_000_000n * 2n + 2_000_000_000n);
  });

  it('clamps an absurd gas limit to the block-gas ceiling', async () => {
    const fee = await estimateTransferFee(
      source({ estimateGas: async () => 999_999_999_999n }),
      FROM,
      TO,
      1n,
    );
    expect(fee.gasLimit).toBe(30_000_000n);
  });
});

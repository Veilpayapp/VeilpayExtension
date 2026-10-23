import { beforeEach, describe, expect, it } from 'vitest';
import {
  addSeenNonce,
  clearSeenNonces,
  isSeenNonce,
  validateChallenge,
} from '@/core/x402/challenge';

// The nonce LRU is module-level state; each test starts from a clean slate so
// the suite does not depend on execution order.
beforeEach(() => {
  clearSeenNonces();
});

const NOW = 1_700_000_000_000;

function validChallenge(overrides: Record<string, unknown> = {}) {
  return {
    scheme: 'x402',
    amount: '1000000000000000', // 0.001 ETH
    asset: 'ETH',
    chain: 'evm',
    payTo: '0x1111111111111111111111111111111111111111',
    nonce: 'nonce-1',
    expiry: NOW + 60_000,
    resource: '/protected',
    description: 'Access the protected endpoint',
    ...overrides,
  };
}

describe('validateChallenge', () => {
  it('accepts a well-formed challenge and marks its nonce as seen', () => {
    const result = validateChallenge(validChallenge(), 'https://service.example', NOW);
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.challenge.amount).toBe('1000000000000000');
      expect(isSeenNonce('nonce-1')).toBe(true);
    }
  });

  it('accepts a relative resource path against any page origin', () => {
    const result = validateChallenge(validChallenge(), 'https://anything.example', NOW);
    expect(result.valid).toBe(true);
  });

  it('rejects a challenge past its expiry', () => {
    const result = validateChallenge(validChallenge(), 'https://service.example', NOW + 120_000);
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.reason).toMatch(/expired/i);
  });

  it('rejects a replayed nonce', () => {
    const first = validateChallenge(validChallenge(), 'https://service.example', NOW);
    expect(first.valid).toBe(true);
    const second = validateChallenge(validChallenge(), 'https://service.example', NOW);
    expect(second.valid).toBe(false);
    if (!second.valid) expect(second.reason).toMatch(/already been used/i);
  });

  it('rejects a challenge on an unsupported chain', () => {
    const result = validateChallenge(validChallenge({ chain: 'solana' }), 'https://service.example', NOW);
    expect(result.valid).toBe(false);
  });

  it('rejects a malformed payTo address', () => {
    const result = validateChallenge(
      validChallenge({ payTo: 'not-an-address' }),
      'https://service.example',
      NOW,
    );
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.reason).toMatch(/recipient/i);
  });

  it('rejects a resource whose origin differs from the page', () => {
    const result = validateChallenge(
      validChallenge({ resource: 'https://evil.example/pay' }),
      'https://service.example',
      NOW,
    );
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.reason).toMatch(/does not match/i);
  });

  it('rejects a zero amount', () => {
    const result = validateChallenge(validChallenge({ amount: '0' }), 'https://service.example', NOW);
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.reason).toMatch(/greater than zero/i);
  });

  it('rejects a non-numeric amount', () => {
    const result = validateChallenge(
      validChallenge({ amount: '1.5' }),
      'https://service.example',
      NOW,
    );
    expect(result.valid).toBe(false);
  });

  it('does not register the nonce when validation fails', () => {
    const result = validateChallenge(
      validChallenge({ amount: '0' }),
      'https://service.example',
      NOW,
    );
    expect(result.valid).toBe(false);
    expect(isSeenNonce('nonce-1')).toBe(false);
  });

  it('rejects a protocol-relative resource URL (cross-origin bypass)', () => {
    const result = validateChallenge(
      validChallenge({ resource: '//evil.example/pay' }),
      'https://service.example',
      NOW,
    );
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.reason).toMatch(/does not match/i);
  });

  it('accepts a path with a double slash that stays on the page origin', () => {
    const result = validateChallenge(
      validChallenge({ resource: '/api//double-slash' }),
      'https://service.example',
      NOW,
    );
    expect(result.valid).toBe(true);
  });

  it('rejects a challenge whose validity window exceeds the TTL cap', () => {
    const result = validateChallenge(
      validChallenge({ expiry: NOW + 60 * 60_000 }), // 1 hour out
      'https://service.example',
      NOW,
    );
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.reason).toMatch(/validity window/i);
  });
});

describe('nonce LRU', () => {
  it('tracks seen nonces and evicts the oldest when over capacity', () => {
    clearSeenNonces();
    for (let i = 0; i < 10_000; i += 1) addSeenNonce(`nonce-${i}`);
    expect(isSeenNonce('nonce-0')).toBe(true);

    // One more pushes the set over the cap and evicts the oldest entries.
    addSeenNonce('nonce-10000');
    expect(isSeenNonce('nonce-10000')).toBe(true);
    expect(isSeenNonce('nonce-0')).toBe(false);
    clearSeenNonces();
  });
});

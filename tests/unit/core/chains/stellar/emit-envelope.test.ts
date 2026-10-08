import { it } from 'vitest';
import { writeFileSync } from 'node:fs';
import { encodeStellarAddress, signStellarPayment } from '@/core/chains/stellar/transaction';

it('emits a real envelope for submission to Horizon', () => {
  // Deterministic keys so we can reproduce/submit repeatedly.
  const sourcePub = new Uint8Array(32).fill(0x0a);
  const destPub = new Uint8Array(32).fill(0x0b);
  const key = new Uint8Array(32).fill(0x01);
  const result = signStellarPayment({
    from: encodeStellarAddress(sourcePub),
    to: encodeStellarAddress(destPub),
    amount: 1_000_000n,
    sequence: 769_286_220_546_539_520n, // a "real-looking" sequence
    fee: 100,
  }, key);
  writeFileSync('stellar-envelope.b64', result.raw);
  console.info('WROTE envelope len', result.raw.length);
});
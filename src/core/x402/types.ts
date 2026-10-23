import { z } from 'zod';

/**
 * x402 payment challenge, transmitted by a server in its `WWW-Authenticate` or
 * `X-402-Challenge` header when it returns 402 Payment Required.
 *
 * Every field is validated with Zod at the extension boundary. A malformed
 * challenge from a compromised page must never reach handler logic.
 *
 * Spec reference: §4.1 of 4_NATIVE_PAYMENT_LAYER_SPEC.md
 */

export const X402Challenge = z.object({
  /** Scheme identifier. Always "x402" for this implementation. */
  scheme: z.literal('x402'),
  /** Amount in base units as a decimal string (bigint cannot cross the bus).
   *  Capped at 78 digits (uint256's maximum) so a hostile challenge cannot
   *  force a huge BigInt conversion in the service worker. */
  amount: z.string().max(78).regex(/^\d+$/, 'Amount must be a non-negative integer.'),
  /** Asset ticker, e.g. "ETH", "USDC". */
  asset: z.string().min(1).max(16),
  /** Chain the payment settles on. EVM only for the first slice. */
  chain: z.enum(['evm']),
  /** Recipient address, in the chain's canonical format (EIP-55 checksummed). */
  payTo: z.string().min(1),
  /** Server-generated nonce for replay protection. */
  nonce: z.string().min(1).max(256),
  /** Unix-millisecond expiry. Payments must arrive before this. */
  expiry: z.number().int().nonnegative(),
  /** The resource being paid for — a URI or path the server recognises. */
  resource: z.string().min(1),
  /** Human-readable description of the service or resource. */
  description: z.string().min(1).max(500),
});

export type X402Challenge = z.infer<typeof X402Challenge>;

/**
 * The canonical JSON payload the wallet signs.
 *
 * The payload is serialised as a deterministic JSON string (sorted keys, no
 * whitespace), then UTF-8 encoded, then EIP-191 personal_signed with the user's
 * EVM account key. The provider verifies the signature via ecrecover.
 */
export const X402PaymentPayload = z.object({
  /** The challenge this payment satisfies. */
  challenge: X402Challenge,
  /** EIP-55 checksummed address of the signer. */
  signer: z.string().min(1),
  /** Unix-millisecond timestamp of when the wallet signed. */
  signedAt: z.number().int().nonnegative(),
});

export type X402PaymentPayload = z.infer<typeof X402PaymentPayload>;

/**
 * The value of the `X-PAYMENT` header.
 *
 * Encoded as a base64-encoded JSON object:
 *   { version: 1, payload: X402PaymentPayload, signature: "0x..." }
 *
 * The provider decodes this, ecrecover-verifies the signature against the
 * payload, cross-checks the recovered signer, and validates the challenge fields
 * (nonce freshness, expiry, payTo, resource).
 */
export const X402PaymentHeader = z.object({
  /** Protocol version. Bumped when the header shape changes incompatibly. */
  version: z.literal(1),
  /** The canonical payment payload. */
  payload: X402PaymentPayload,
  /** EIP-191 compact signature (r || s || v), 0x-prefixed hex. */
  signature: z.string().regex(/^0x[0-9a-fA-F]{130}$/, 'Signature must be a 65-byte 0x-prefixed hex string.'),
});

export type X402PaymentHeader = z.infer<typeof X402PaymentHeader>;

/**
 * Detects whether a value is an x402 challenge. Thin guard for the inpage shim
 * so the caller can receive a typed challenge without importing Zod at the page
 * boundary.
 */
export function isX402Challenge(value: unknown): value is X402Challenge {
  return X402Challenge.safeParse(value).success;
}
# Veilpay Security Audit & Scorecard

**Date:** 2026-08-16 · **Scope:** full extension (vault, background worker, messaging bus, content/inpage, chain signing for EVM/Solana/Stellar, VAP grants, x402, WalletConnect, privacy/SPP, popup/sidepanel/options UI) · **Method:** manual review of every security-critical module (all of `src/core`, `src/background`, `src/content`, approval surfaces), adversarial test additions, and empirical verification of signature preimages against node behavior.

Scoring is 0–10 per domain against consumer self-custody wallet standards (MetaMask/Phantom-class expectations): **key custody, signing correctness, consent integrity, network/RPC hygiene, protocol security, agent payments, privacy, UX safety, code hygiene**. "Before" is the state found on arrival; "after" is this working tree.

---

## Scorecard

| Domain | Before | After | What moved |
| --- | --- | --- | --- |
| Key custody & vault crypto | 7.5 | **9.0** | Clipboard wipe now unmount-proof; secrets cleared from UI state after use |
| Signing correctness (wire validity) | 2.0 | **9.0** | EIP-1559 digest fix (was invalid on real networks) + node-equivalence test; EIP-712 bytesN/salt fix |
| Consent & approval integrity | 5.0 | **7.5** | Offscreen source-forgery closed; WC kinds privileged; WC resolve bound to request+session+chain |
| Network & RPC hygiene | 5.5 | **8.0** | Fee ceilings vs hostile RPC; switchChain gated; fetch timeouts; pending-nonce reads |
| Protocol & message security | 7.0 | **9.0** | Surface identity from Chrome-stamped URL path, not payload |
| Agent payments (VAP/x402) | 6.5 | **8.5** | Per-grant mutex closes spend-window race; challenge TTL cap; protocol-relative URL fix |
| Privacy (stealth/SPP) | 7.0 | **7.5** | Rejection-sampled ephemeral scalars; honest docs; dormant plaintext store still Phase 3 |
| UX safety (anti-phishing) | 6.0 | **8.5** | Pre-broadcast review screen; full addresses on approvals; amount zero-fallback; GrantApproval fail-closed |
| Code & build hygiene | 8.5 | **9.0** | Lint clean; 874 tests; all gates pass |
| **Overall** | **≈5.9** | **≈8.5** | |

---

## Critical

**C1 — EVM transactions were signed over the wrong digest (FIXED).** `evm/transaction.ts` appended three zeroed signature fields to the EIP-1559 signing preimage — the legacy EIP-155 pattern applied to a type-2 envelope. The spec sighash is exactly 9 fields (`0x02 ‖ rlp([chainId, nonce, maxPriorityFee, maxFee, gas, to, value, data, accessList])`). Empirically verified: a node recovering the signer over the spec digest got a random address, so **every EVM transaction this build produced was invalid on a real network**. The unit tests were self-consistent (verified the signature against the code's own digest). Fixed to hash the 9-field preimage; a new regression test decodes the broadcast envelope, recomputes the node-side sighash, and ecrecovers the externally-known signer.

## High — fixed

- **H1 — Privileged gate trusted the sender-declared `source` field.** The offscreen document (running the vendored SPP SDK) shares the extension origin and could invoke *any* privileged kind (`account.exportKey`, `vault.reset`, `tx.transfer`) by claiming `source: 'popup'`. The router now derives the surface from the Chrome-stamped `sender.url` path (`/popup.html|/options.html|/sidepanel.html`) — never the payload.
- **H2 — WalletConnect approval kinds were not privileged.** `wc.pair`, `wc.proposal.approve`, and `wc.request.resolve` (which signs and broadcasts) were callable by any bus sender. All eight `wc.*` kinds are now privileged.
- **H3 — `solana.signMessage` was a transaction-signing oracle.** A bare ed25519 signature over a "message" that is actually a serialized transaction message *is* a valid transaction signature. New `looksLikeTransactionMessage` detector (strict whole-buffer legacy+v0 parse) rejects such payloads before any prompt.
- **H4 — VAP spend-window TOCTOU race.** Check (`requiresApproval`) and debit (`recordSpend`) spanned multiple awaits; N concurrent auto-approved ops all passed against the same stale total and all settled, defeating `maxPerWindow`. A per-grant async mutex (`withGrantLock`) now serializes check→settle→debit; regression test proves one-of-three settles under a tight window.
- **H5 — ExportKeyModal clipboard wipe was cancelled on unmount.** The 30s auto-clear timer died when the modal closed, leaving the private key on the system clipboard indefinitely. The wipe now lives in a module-scoped helper (`ui/lib/clipboard.ts`) that survives unmount; the mnemonic copy path uses it too.
- **H6 — No pre-broadcast review for wallet-initiated sends.** One CONTINUE click broadcast. The send form now opens a review overlay (full untruncated recipient, amount, fee, network, memo) requiring a distinct "Confirm send", and the CTA stays disabled until a fee estimate has completed.
- **H7 — RPC fee data trusted blindly.** A malicious/custom RPC could report an absurd priority tip (paid in full to the block producer) or base fee. Both are now clamped to sanity ceilings (100 gwei tip, 10,000 gwei base, 30M gas), with tests.
- **H8 — EIP-712 `bytesN` (incl. domain `salt`) was keccak-hashed.** Per spec, fixed bytes are atomic: left-aligned, zero-padded, *unhashed*. The old code diverged from every verifying contract (and from MetaMask/ethers). Fixed, with a test that reconstructs the domain separator independently.

## Medium — fixed

- x402 challenges: **max 15-minute validity window** (the nonce replay LRU is RAM-only and resets on every MV3 service-worker eviction) and **protocol-relative resource URLs** (`//evil.tld/…`) no longer bypass the same-origin check.
- **`eth.switchChain` required no connection and flipped the global network** for any page. Now requires an approved origin.
- **Stellar strkey decode never verified the CRC16 checksum** — a corrupted address passed and would be paid. Now verified; mismatch throws.
- **Amount encoders lacked range checks**: negative values passed `decimalAmountToBaseUnits` and wrapped to ~u64::MAX on Solana's wire; Stellar XDR helpers silently dropped high bits. All fail closed now.
- **No PIN throttling.** scrypt (N=2^17) plus a persistent exponential-backoff lockout (5 fast attempts, then 30s→5min doubling) now guards `security.pin.verify`.
- **TransactionApproval truncated amounts** ("0.0000 ETH" for real payments) — now falls back to base units, matching X402Approval.
- **GrantApproval gating was fail-open while security status loaded** — now fail-closed (the background re-verifies regardless).
- **WC `request.resolve` resolved whatever was pending** — now optionally bound to the exact `requestId` the UI displayed, rejects a swapped request, and `eth_sendTransaction` requires the sender to be a session-approved account and the request chain to match the selected network.
- **EVM nonce read used `latest`** — a second send while the first was pending could reuse the nonce. Now `pending`.
- **Dapp `eth_sendTransaction` without `to`** silently became a self-send while the approval showed "—". Now rejected (deployment unsupported).

## Low — fixed

Shamir share parsing (`zz`→0 byte silently, duplicate x-values → confusing GF error), unbounded decimal strings (BigInt DoS) capped at uint256 width, `window.open` without `noopener,noreferrer`, truncated addresses on the connection-approval surface, missing fetch timeouts on EVM/Solana RPC + blockhash fetch, Solana blockhash length validation, agent-bridge URLs restricted to https or loopback http, prompt-limiter map bounded, ed25519/secp256k1 ephemeral scalars rejection-sampled (no modulo bias), WC resolve no longer substitutes self for a missing recipient, `RpcService`'s 5-minute cache no longer covers nonces/blockhashes/fee methods (was latent).

## Efficiency improvements

- **Audit ledger `tail()`** now reads the last entry via a reverse IndexedDB cursor (O(1)) instead of materializing the entire ledger on every audit append — the old shape made every grant operation O(ledger size).
- **EVM nonce reads** moved to the `pending` tag (fewer failed/replacement transactions = fewer wasted RPC round-trips and retries).
- **Fetch timeouts** (15s) on the hot RPC paths turn indefinite hangs into endpoint failover.
- **Prompt-limiter** memory is bounded (≤500 origins).
- Lint is clean (removed dead constants); bundle remains at 12% of the size budget.

## Deferred (roadmap, not regressions)

These are real but require feature-scale work or wire-format changes; none is a live exploit today:

1. **Display depth for blind signing**: EIP-712 shows the primary-type name only; Solana dapp transactions show the raw blob; WC tx hints truncate. Decode + render (Permit/setApprovalForAll warnings, Solana instruction decode) is the highest-value remaining work.
2. **WebAuthn grant confirmation is a trusted boolean** — the background never verifies an assertion against the stored COSE key. Wire the challenge through `vap.grant.resolve` and verify the signature.
3. **Privacy commitment store holds plaintext note preimages** (dormant — no writer exists). Before Phase 3 wires it: encrypt with a vault-derived key or derive-don't-store. Loud warnings are now in the code.
4. **Fee visibility in the dapp approval path**: dapp-initiated transactions are approved before fee estimation; surface `totalFeeWei` in the approval record.
5. **Single-slot pending approvals**: a second request clobbers the first's record. Key pending records by id.
6. **x402 payment payload lacks chainId/EIP-712 domain binding** (wire-format change; coordinate with the reference server).
7. **SPP offscreen signing gates** pin the source account and network but not the operation set; parse envelopes to require pool-contract invokeHostFunction ops only.
8. **`account.exportKey`** requires only an unlocked vault — consider passphrase/PIN re-verification.
9. **`eth.rpc` read passthrough is open to any page** (matches MetaMask's pre-connect reads; accepted design, noted).

## Postscript (same day)

**Network banner context bug (FIXED).** `TestnetBanner` named the first mainnet in a fixed chain-priority scan, so switching the dashboard from Stellar Mainnet to Ethereum (or any other mainnet) kept reading "You are on Stellar Mainnet". A warning that names the wrong network trains users to ignore warnings. The banner now keys on the chain actually being viewed (the dashboard's active account), falling back to the wallet-wide scan only on chain-agnostic surfaces like the welcome screen. Regression test covers mainnet→mainnet switching both ways.

**Pairing-time agent grant (behavior change, by request).** Connecting an agent (local bridge or hosted relay) now creates a default standing grant — 0.01 native units/payment, 0.1/day, 90-day expiry, all three chains — so in-cap agent payments are silent from the first one. The approval threshold sits at the window cap, so the grant never defers to a prompt: within caps it settles, beyond caps it is *denied* (not queued for a human). Cross-chain safety comes from normalizing op amounts to wei-equivalent value before the cap check (a flat base-unit cap across chains with 18/9/7 decimals would otherwise mean 0.01 ETH but 10M SOL). Caps are enforced in the background under the per-grant mutex, every outcome is audit-logged, and the grant is visible/revocable under VAP Grants. The residual risk is the documented one from the design notes: prompt-injection of the agent can spend within the caps — the caps are the blast-radius bound, and they are the reason this is safe to enable.

## Verified strengths (unchanged)

Vault: PBKDF2-SHA512 600k iterations (2.8× the OWASP floor), AES-256-GCM, non-extractable CryptoKeys, scoped `withMnemonic`/`withAccount` with finally-wipes, idle+absolute session ceilings that survive MV3 eviction without extending the window. Bus: zod on every message, origins only from Chrome-stamped sender fields, uniform INTERNAL errors (no stack/key leakage). Approvals: per-origin grants, 5/min prompt limiter, hold-to-confirm, full recipient in `TransactionApproval`. Chains: correct BIP-39/44/SLIP-0010, low-s signatures, EIP-155 chain binding, Stellar network-passphrase binding, post-sign address re-derivation checks, Horizon no-retry-after-4xx (double-spend protection). SPP: key-derivation arm pinned to a single fixed message; internal channel gated to the offscreen URL. Shamir GF(256) math independently verified correct. Storage: zod-validated at the boundary; hash-chained audit ledger.

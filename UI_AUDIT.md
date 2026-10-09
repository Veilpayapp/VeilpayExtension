# Veilpay UI Redesign — Audit & Remediation

Audit of the Gemini UI redesign (`UI_REDESIGN_README.md`) against the actual
source, focused on one question: **does the wallet show real data, and does the
backend actually work?**

## Verdict

The backend is genuinely solid — real RPC calls, real signing, real history,
real faucet. The redesign's UI layer, however, **fabricates numbers and
features to match the design screenshots**. A fresh testnet wallet showed
`$1,893.01 / 9469.8001512 XLM` it does not have.

## Backend verification (all real, no changes needed)

| Surface | Status | Evidence |
| --- | --- | --- |
| Messaging router | ✅ real | Origin-verified dispatch, zod-validated envelopes, `ORIGIN_DENIED` for privileged kinds from pages |
| Chain services | ✅ real | Live HTTP to Sepolia publicnode (with fallbacks), Solana devnet, Horizon testnet; endpoint rotation + 15s timeouts; POSTs never retried (double-spend safety) |
| `tx.estimate` | ✅ real | EVM gas + EIP-1559 from live RPC; Stellar reads `/fee_stats` live; spendable resolved per token |
| `tx.transfer` | ✅ real | Signs inside `vault.withAccount` (key zeroized after), pre-submit `INSUFFICIENT_BALANCE` checks, signer cross-check, honest chain error surfacing |
| Stellar XDR builder | ✅ real | Hand-rolled XDR, correct signature base (`networkId ‖ taggedTransaction`), v1 envelope, protocol-19 preconditions |
| History | ✅ real | Horizon `/payments`, Solana RPC, EVM RPC → normalized `IndexerTx`; IndexedDB cache only as fallback |
| Faucet | ✅ real | Friendbot (Stellar) / real faucet URLs (EVM, Solana) |
| Vault / store | ✅ real | `useWallet` maps 1:1 onto background handlers; no key material in UI |

## Fabrications found (introduced by the redesign)

| # | Location | Fabrication | Severity |
| --- | --- | --- | --- |
| 1 | `Dashboard.tsx` (fake fallback) | `displayCrypto = totalCrypto > 0 ? totalCrypto : 9469.8001512` — zero balance rendered as 9469.8 XLM / $1,893.01 | **Critical** — outright fake money |
| 2 | `Dashboard.tsx` (`CHAIN_META`) | Hardcoded "live" prices (XLM $0.20, ETH $3200, SOL $180) + 24h deltas (`-6.41%` etc.) labeled "Live price / Today"; USD valuations in the hero and asset rows computed from them. No price feed exists and no price host is in `host_permissions` | **High** — fake market data |
| 3 | `Dashboard.tsx` (privacy card) | `... pXLM` "PRIVATE XLM" balance — `pXLM` exists nowhere in the backend; `src/core/privacy/stealth.ts` is an unwired foundation | High |
| 4 | `Dashboard.tsx` (activity) | Every transaction rendered `- amount` in red — `IndexerTx.amount` is unsigned; incoming payments shown as debits | High |
| 5 | `App.tsx` SendForm | Available-balance fallback of `9469.8001512` when the estimate hasn't loaded | **Critical** |
| 6 | `App.tsx` SendForm | "Address book" button injects `GDZQWH5FA4TQYY7EXAMPLE345` — a garbage address into a real send form | **Critical** — send-safety |
| 7 | `App.tsx` SendForm | Memo field collected but never sent: protocol has no memo field, builder hardcodes `MEMO_NONE` | High — dead feature |
| 8 | `App.tsx` SendForm | Privacy pills (`Shield / Send privately / Unshield`) + "PRIVACY ACTIVE — Zero-Knowledge Shielded" banner: pure decoration, no privacy path exists | High — false security claim |
| 9 | `App.tsx` SendForm | "SWAP TO USD" toggles an `amountInUsd` state that is never read | Medium |
| 10 | `ScanModal.tsx` | "SCAN QR CODE" with viewfinder + laser animation — no camera, no decoding; only paste/manual text | Medium |
| 11 | `FiatGatewayModal.tsx` | Opens `https://fiat.veilpay.org` (DNS does not resolve — dead link) and advertises fabricated "Best Route (0.5% – 1.2%)" fees | High |
| 12 | `Dashboard.tsx` / `App.tsx` | MAX chip computes 99% of the (sometimes fake) spendable instead of the real max | Medium |

## Remediation applied

1. **Real balances everywhere.** Zero balance renders as `0 XLM`. The
   fake-price USD hero/valuations and the fake `... pXLM` are gone (privacy
   card becomes an honest *coming soon*; stealth payments are not wired yet).
2. **Memo wired end-to-end** (Stellar `MEMO_TEXT`): protocol schema →
   background → XDR builder → SendForm (Stellar sends only; other chains
   reject it instead of silently dropping user input).
3. **Real address book.** The SendForm book button opens a picker backed by
   the IndexedDB address book (filtered to the send chain); no more injected
   example address.
4. **Real activity direction.** Rows compare `from`/`to` against the wallet's
   own addresses: `+ amount` in success green for received, `- amount` in
   danger red for sent, with a Received/Sent label. The receipt shows the
   true direction and status badge.
5. **Honest send form.** Available balance comes from the estimate or the
   store (never a constant); privacy pills and the "PRIVACY ACTIVE" banner,
   and the dead "SWAP TO USD" control are removed; MAX computes the real
   max (spendable minus fee for native assets) with exact bigint math.
6. **Real QR scanning.** The modal now opens a live camera viewfinder
   (`getUserMedia`, rear-facing preferred), decodes frames with jsQR at a
   downsampled 480px, and stops every track on close. A scanned payment URI
   (`stellar:G…?amount=…&memo=…`, Solana Pay, EIP-681) pre-fills the send
   form's recipient, amount, and memo. Retry semantics are Chrome-truthful:
   a dismissed prompt (permission state `prompt`) → retry re-runs
   getUserMedia and the **allow popup re-appears**; a hard Block (state
   `denied`) → Chrome never re-prompts a denied origin, so retry deep-links
   to this extension's `chrome://settings/content/siteDetails` page where
   Camera → Allow is one click. jsQR moved from devDependencies to
   dependencies (+~47 KB gzip, 11.1% of the bundle budget).
7. **Honest fiat card.** The dead `fiat.veilpay.org` link and fabricated fees
   are removed; the card is a non-interactive *coming soon* tile. The modal
   component is deleted.

Test-critical strings (`Portfolio`, `Assets`, `Recent Transactions`, `Send`,
`Receive`, `Recipient address`, `Amount (SYM)`, `Estimated fee: …`,
`Sent!`, `Insufficient balance`, `Export … private key`) were preserved.

---

## Round 2 — multi-network groundwork, idle-lock fix, motion (verified 564/564)

### Fixed: the wallet relocking long before 15 minutes

The vault held its unlocked session **only in service-worker memory**, and
MV3 kills the worker ~30s after the popup closes — so the promised 15-minute
idle window never actually existed; the wallet relocked within about a minute
of closing the popup. The session is now mirrored into
`chrome.storage.session` (Chrome's in-memory, trusted-contexts-only store:
never written to disk, unreadable from content scripts, wiped when the
browser closes) and restored on every worker wake **with the original
timestamps** — an eviction grants no extra unlock time, it only preserves the
time the user already had. Lock removes the mirror; expired/malformed rows
are discarded rather than revived. Proven by
`tests/unit/core/vault-session-restore.test.ts` (5 tests: restore + usable
mnemonic, original-window continuation, expired-row rejection, lock removal,
malformed-row safety).

### Fixed: selected network snapping back to EVM after navigating back

The dashboard's network selection was component-local state, so every
remount (send → back, receive → back) reset it to account 0 (EVM). Selection
now lives in the `useWallet` store (`selectedAccountIdx`), survives view
switches, and resets when the account list is cleared (lock/account switch).
Regression-tested in `popup.test.tsx`.

### Added: entrance animations on every view switch

Home → send → receive → receipt → import now each enter with
`animate-fade-in-up` (compositor-only opacity/translate per the motion
rules; replays on remount, not on re-render).

### Foundation: the network registry (multi-network, mainnet + testnet)

`src/core/networks/index.ts` now carries a verified `NetworkProfile`
registry — the groundwork for "support every network":

| Chain | Networks |
| --- | --- |
| Stellar | Mainnet (`horizon.stellar.org`, public passphrase), Testnet |
| EVM | Ethereum (1), Sepolia (11155111), Base (8453), Base Sepolia (84532), Polygon (137), Arbitrum One (42161) |
| Solana | Mainnet, Devnet |

- Every RPC endpoint was **verified live** (chainId responses) before being
  listed; Ethereum mainnet and Polygon use `1rpc.io`, an origin the manifest
  already permits.
- Selection persists per chain in IndexedDB; defaults reproduce the
  historical testnet endpoints **exactly** (test-asserted against
  `TESTNET_ENDPOINTS`), so no install changes behavior until a user switches.
- Resolvers for the wiring step: `resolveNetworkRpcUrl`,
  `resolveEvmChainId` (EIP-155 signing id), `resolveStellarPassphrase`
  (signature pre-image). The legacy `resolveRpcUrl` behavior is unchanged and
  test-pinned.
- 16 tests in `tests/unit/core/networks-registry.test.ts` pin registry
  integrity, verified chain ids, selection persistence, custom-RPC
  round-trips, and explorer-URL compatibility with existing receipts.

### Camera "allow by default" — the honest constraint

No Chrome API lets an extension pre-grant its own camera permission: the
first `getUserMedia` must show the user the prompt (that is Chrome's
anti-abuse design). Veilpay's scanner already prompts on first open, and
Chrome then remembers the grant — every later scan starts without asking.
The denied/blocked retry paths (prompt re-show vs. settings deep-link) are
covered in the previous section.

### Remaining roadmap (next rounds)

1. **Wire the registry through the background** as one atomic change:
   balances/estimates/broadcasts/history follow the selected network; EVM
   signing uses the per-network chain id; Stellar uses the per-network
   passphrase; faucet gated to testnets; manifest host_permissions for
   `horizon.stellar.org`, `*.publicnode.com` mainnet origins; network
   switcher UI in the dashboard (per-chain network lists from the registry).
2. **Custom tokens**: Stellar trustlines + issued assets, ERC20, SPL import
   (contract/mint + decimals + symbol resolution, persisted per network).
3. **Privacy payments on Stellar** wiring the existing stealth-address
   crypto into the send path.
4. **WalletConnect** end-to-end verification (pairing, proposals, requests).
5. **Agent payments with the Render relay** verified end-to-end.


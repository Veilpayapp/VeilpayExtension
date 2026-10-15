# Veilpay Architecture

## Overview

Veilpay is a privacy-preserving payment extension built on zero-knowledge proofs and encrypted message passing. It operates across four runtime domains:

- **Background Service Worker**: Vault orchestration, transaction signing, message routing
- **Content Script**: Web page bridge, x402 request interception
- **Inpage Script**: Native `window.veilpay` API for dApps
- **UI Surfaces**: Popup, side panel, options, offscreen workers

## Core Domains

### Messaging (`src/core/messaging/`)

**Contract**: Strongly typed request/response protocol with async-first routing.

- `protocol.ts`: Message type definitions (Request, Response, WrappedMessage)
- `client.ts`: Async messenger API with request/response correlation
- `router.ts`: Handler registry and dispatch logic

**Flow**: Content → Background via `chrome.runtime.sendMessage()`, Background publishes to UI surfaces via broadcast.

### Vault (`src/core/vault/`)

**Contract**: Encrypted key storage with zero-knowledge proof support.

- `storage.ts`: IndexedDB wrapper with AES-GCM encryption at rest
- `crypto.ts`: Key derivation (PBKDF2), encryption/decryption, ZK proof generation
- `index.ts`: Vault API (lock/unlock, sign, derive)

**State**: Locked by default; unlocked for 15 min after user auth; auto-locks or on ext suspend.

### Stores (`src/core/stores/`)

**Pattern**: Zustand slices composed into a root store. Persisted to IndexedDB via middleware.

- `auth.ts`: Session state, seed phrase management
- `accounts.ts`: Derived accounts, labels, balances
- `chains.ts`: Supported chains, metadata
- `transactions.ts`: Pending/history, signatures
- `ui.ts`: Modal state, selected account/chain
- `privacy.ts`: ZK proof cache, privacy preferences
- `settings.ts`: User preferences (theme, gas, slippage, RPC overrides)

### CSP ZK Spike (`src/spike/csp-zk-probe.ts`)

**Goal**: Feasibility check for confidential signing (CSP) + ZK proof emission on background thread.

**Approach**:
1. Derive ephemeral keypair from session secret + random nonce
2. Sign transaction hash with ephemeral key (CSP-compatible pattern)
3. Generate range proof over tx amount (stub for Phase 1)
4. Return proof + signature to content script; sign again with hot key for broadcast

**Why**: Allows extension to prove knowledge of transaction without revealing private key to untrusted page.

### Stellar Private Payments / privacy pool (`src/core/spp/`)

**What**: The pXLM privacy pool — shield public XLM into private notes
(UTXO-style commitments), transfer privately by `G…` address, unshield on
demand. Groth16 proofs over BN254 prove note ownership and Merkle membership
on-chain; the public ledger never learns sender, recipient, or amount.

**Layout**:
- `deployment.ts` — the pinned testnet deployment (pool, registry, ASP, and
  verifier contract ids) the wallet talks to. Identifiers are compile-time
  constants: a compromised network response cannot redirect pool operations.
- `host.ts` — the offscreen runtime host. The vendored SPP web SDK
  (`third_party/spp-sdk`, built from source) needs OPFS, Workers, and WASM,
  none of which exist in the MV3 service worker, so it runs in the offscreen
  document and is driven over the internal control plane (`spp:exec`).
- `bridge.ts` — the background-side bridge: creates the offscreen document on
  demand, forwards ops, and closes it after an idle period.
- `internal-protocol.ts` — the control-plane message shapes plus the signing
  callback protocol (`spp:sign`) that keeps vault keys in the service worker.

**Key handling**: the SDK's three signing callbacks (`signMessage`,
`signAuthEntry`, `signTransaction` — see
`src/core/chains/stellar/soroban-sign.ts`) round-trip to the background,
where they are answered inside `vault.withAccount`. The private key never
exists outside the service worker; the offscreen document only ever sees
public XDR. Pool privacy keys are derived from the wallet's own signature
over an SDK-issued derivation message, so the recovery phrase restores
private notes.

**Assets**: the SDK runtime and circuit artifacts ship as static files under
`dist/spp/` (staged by `scripts/copy-spp-assets.mjs`), imported by URL —
never bundled — because the SDK derives its worker and WASM URLs from its own
module location. `scripts/check-bundle-size.mjs` excludes them from the code
budget (they are data, not code).

**Verification**: `scripts/spp-smoke/` drives the flow at three levels —
`drive.mjs` runs the SDK directly in a page (deposit → private transfer →
withdraw with exact balance conservation), `twowallet-drive.mjs` proves the
cross-wallet path (two fresh wallets: the sender's private transfer lands as
spendable notes under the recipient's — different — keys, resolved through
the on-chain registry), and `extension-e2e.mjs` drives the real extension
path end-to-end (vault → background handlers → offscreen runtime →
vault-backed signer → proofs → testnet contracts), including a private send
to a second registered wallet.

## Request/Response Flows

### Vault Lock/Unlock

```
Content: { type: "VAULT_UNLOCK", password }
  ↓
Background: Derive auth key, verify password hash
  ↓
Background: Load encrypted master seed, decrypt, cache in memory
  ↓
Response: { success: true, sessionId }
```

### Transaction Signing

```
Page (inpage): window.veilpay.signTx(tx)
  ↓
Inpage → Content: postMessage({ type: "REQUEST_SIGN", tx })
  ↓
Content → Background: chrome.runtime.sendMessage({ type: "REQUEST_SIGN", tx })
  ↓
Background: Correlate to UI (show approval modal)
  ↓
UI → Background: { type: "APPROVE_SIGN", correlationId }
  ↓
Background: Load account private key, sign, emit ZK proof
  ↓
Inpage: postMessage({ type: "SIGNATURE_READY", sig, proof })
  ↓
Page: Return to caller
```

### x402 Payment Request

```
Page: <script data-x402-recipient="addr" data-x402-amount="1.5">
  ↓
Content: Intercept, extract metadata
  ↓
Content → Background: { type: "REQUEST_PAYMENT", recipient, amount, scriptId }
  ↓
Background: Show payment approval modal (side panel)
  ↓
User: Approve + select account/chain
  ↓
Background: Sign, emit ZK proof, broadcast tx
  ↓
Inpage: postMessage({ type: "PAYMENT_COMPLETE", txHash })
```

## UI Surfaces

### Popup (390×600)

- Quick vault unlock
- Account selector
- Recent transactions
- Settings link

### Side Panel (480×680)

- Transaction approval modal
- Payment confirmation
- Key derivation UI
- Privacy settings

### Options (Full Window)

- Master seed backup/recovery
- Account management (create, rename, hide)
- Chain toggles
- RPC override configuration
- Gas preferences
- Privacy & ZK settings

### Offscreen Document

- Long-lived crypto operations (Key derivation, proof generation)
- Background message relay to UI

## Extension Manifest v3 Contract

**Permissions**:
- `storage` (IndexedDB + chrome.storage.local)
- `tabs` (tab query for content script injection)
- `webRequest` optional (future rate limiting)

**Entry Points**:
- `background.service_worker`: `src/background/index.ts`
- `content_scripts`: `src/content/index.ts`
- `action.default_popup`: `public/popup.html`
- `side_panel`: `public/sidepanel.html`
- `options_page`: `public/options.html`
- `offscreen_documents`: `public/offscreen.html`

## Build & Development

**Vite + React + TypeScript**:
- `npm run dev` watches all sources, rebuilds manifest
- `npm run build` produces `dist/` ready for `chrome://extensions` load
- `npm run build:check-size` fails if bundle > 5MB

**CI/CD** (`.github/workflows/ci.yml`):
- Typecheck, lint (ESLint), unit tests (Vitest)
- Build verification
- Bundle size check

## Testing Strategy

**Unit** (`tests/unit/core/`):
- Crypto (derive, encrypt, ZK stub)
- Messaging (client, router, protocol)
- CSP spike (ephemeral key, proof emission)

**Integration** (future):
- Content ↔ Background messaging
- Vault lock/unlock flow
- Transaction signing e2e

**Manual** (for now):
- Real dApp integration (test-landing-page.html in Phase 2)
- ZK proof verification (wait for CSP probe results)

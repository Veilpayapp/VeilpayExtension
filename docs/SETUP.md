# Setup Guide

## Prerequisites

- **Node.js**: 20.x (LTS)
- **npm**: 10.x
- **Chrome/Chromium**: Latest (for Manifest v3)
- **Git**: For version control

## Installation

```bash
# Clone the repo
git clone <repo-url>
cd Veilpayextension

# Install dependencies
npm install

# Verify installation
npm run typecheck
npm run lint
```

## Development Workflow

### 1. Start Watch Mode

```bash
npm run dev
```

This runs Vite in watch mode. Output goes to `dist/`.

### 2. Load Extension into Chrome

1. Open `chrome://extensions`
2. Enable **Developer mode** (top right)
3. Click **Load unpacked**
4. Navigate to `dist/` folder
5. Pin the extension to the toolbar

### 3. Reload After Changes

- **Manifest or background script**: Click the reload icon on the extension card
- **Content script**: Reload the page in the browser
- **Popup/Options**: Close and reopen the popup

### 4. Debug

**Background Service Worker**:
- `chrome://extensions` → Veilpay card → "Service Worker" link
- Opens DevTools for the background script

**Popup**:
- Right-click extension icon → **Inspect popup**
- Opens DevTools for the popup React component

**Content Script**:
- Inspect the page where the extension runs
- DevTools → Sources → find `content.js` in the file tree

**Storage**:
- Inspect the page → DevTools → Application → IndexedDB → **Veilpay**
- View encrypted vault state

## Testing

### Unit Tests

```bash
# Run all tests once
npm run test:unit

# Run in watch mode
npm run test:unit -- --watch

# Run specific test file
npm run test:unit -- vault-crypto.test.ts

# Run with coverage
npm run test:unit -- --coverage
```

### Build Verification

```bash
# Build production artifact
npm run build

# Check bundle size (should be <5MB)
npm run build:check-size

# Inspect dist/ structure
ls -la dist/
```

### CSP Spike (Manual)

```bash
bash scripts/csp-spike.sh
```

This runs the CSP/ZK proof spike test in isolation. Used to validate ephemeral key derivation and proof generation before Phase 2 integration.

## Code Quality

```bash
# Typecheck (TypeScript)
npm run typecheck

# Lint (ESLint)
npm run lint

# Format (Prettier) — optional, CI checks it
npm run format
```

Run these before committing. CI enforces them on every push.

## Project Structure

```
Veilpayextension/
├── src/
│   ├── background/           # Service worker entry
│   ├── content/              # Content script + inpage bridge
│   ├── popup/                # Popup UI (React)
│   ├── sidepanel/            # Side panel UI (React)
│   ├── options/              # Options page (React)
│   ├── offscreen/            # Offscreen document (for crypto if needed)
│   ├── core/
│   │   ├── messaging/        # Protocol + client + router
│   │   ├── vault/            # Crypto + storage
│   │   ├── stores/           # Zustand stores (root, auth, accounts, etc.)
│   │   └── spike/            # CSP/ZK proof experiments
│   ├── ui/
│   │   ├── theme/            # Tailwind tokens + colors
│   │   └── components/       # Reusable React components (Phase 2+)
│   └── manifest.config.ts    # Manifest v3 generation
├── public/
│   ├── icons/                # Extension icons (128x128, 48x48, 16x16)
│   ├── popup.html            # Popup template
│   ├── sidepanel.html        # Side panel template
│   ├── options.html          # Options template
│   └── offscreen.html        # Offscreen template
├── tests/
│   ├── setup.ts              # Global test setup (chrome mock)
│   ├── fixtures/             # Mock data
│   ├── unit/
│   │   └── core/             # Vault, messaging, CSP tests
│   └── integration/          # End-to-end tests (Phase 2+)
├── docs/
│   ├── AGENT_PAYMENTS.md    # Agent payments design + threat model
│   ├── ARCHITECTURE.md      # System design
│   ├── MCP_SETUP.md         # Connecting Claude / ChatGPT
│   └── SETUP.md             # You are here
├── scripts/
│   ├── build.sh              # Production build
│   ├── dev.sh                # Development watch
│   └── csp-spike.sh          # CSP spike test runner
├── .github/workflows/
│   └── ci.yml                # GitHub Actions CI
├── vite.config.ts            # Vite configuration
├── vitest.config.ts          # Vitest configuration
├── tsconfig.json             # TypeScript configuration
├── tailwind.config.js        # Tailwind CSS configuration
├── postcss.config.js         # PostCSS configuration
├── package.json              # Dependencies + scripts
└── README.md                 # Project overview
```

## Common Tasks

### Add a New Message Type

1. Edit `src/core/messaging/protocol.ts`:
   - Add request/response interfaces
   - Register in `RequestType` and `ResponseType` unions

2. Implement handler in `src/core/messaging/router.ts`:
   - Add case to `handleRequest`
   - Update `RequestHandler` map

3. Call from client:
   ```typescript
   import { messageClient } from '@/core/messaging/client';
   const response = await messageClient.send({ type: 'MyRequest', payload: {} });
   ```

4. Test in `tests/unit/core/messaging.test.ts`

### Add a New Zustand Store

1. Create file: `src/core/stores/myFeature.ts`
2. Export hook + types:
   ```typescript
   export const useMyStore = create<MyState>((set) => ({ ... }));
   ```
3. Add to root store in `src/core/stores/rootStore.ts`
4. Use in React:
   ```typescript
   const { state } = useMyStore();
   ```

### Add Crypto Tests

1. Create file: `tests/unit/core/myCrypto.test.ts`
2. Import mocked `crypto.subtle` from `setup.ts`
3. Mock implementations as needed
4. Run: `npm run test:unit -- myCrypto.test.ts`

## Environment Variables

Copy `.env.example` to `.env.local` (not committed). Vite exposes only `VITE_`-prefixed variables to the browser bundle, and secrets must never go in env — key material lives in the encrypted IndexedDB vault.

```bash
cp .env.example .env.local
```

No environment variables are required. Transaction history is read directly from the testnet chains (Stellar Horizon, Solana devnet, EVM Sepolia) via the host permissions in the manifest; the chain fetchers live in `src/core/chains/{stellar,solana,evm}/history.ts` and are dispatched by `src/core/chains/indexer-service.ts`. RPC endpoints are pinned in the manifest as host permissions (testnet-only), so no RPC env is needed until Phase 5 mainnet work.

## Troubleshooting

### "Module not found" Error

Check `tsconfig.json` and `vite.config.ts` for path aliases. Should have:
```json
"@": "src"
```

### Chrome API Undefined

In browser, `chrome` is global. In Node tests, it's mocked in `tests/setup.ts`. Verify:
```typescript
// In tests
vi.mocked(chrome.runtime.sendMessage);

// In content script / background
chrome.runtime.sendMessage({ ... });
```

### IndexedDB Fails in Test

The mock in `setup.ts` is minimal. For real IndexedDB tests, use a local IndexedDB mock library (e.g., `idb-keyval`) or skip in CI.

### Build Size Too Large

Run `npm run build:check-size` to see breakdown. Common culprits:
- Unused dependencies
- Large libraries (swap for lightweight alternatives)
- Source maps (disable in production)

Check Vite bundle analyzer:
```bash
npm install -D rollup-plugin-visualizer
# Then add to vite.config.ts
```

### CI Fails but Local Works

Common causes:
- Node version mismatch → use `nvm use`
- Cache stale → `npm ci` instead of `npm install`
- ENV not set → check `.env.local` not committed

## Next: Build & Test

Once setup is complete:

```bash
npm run build
npm run test:unit
npm run dev
```

Load into Chrome and verify no errors in the Service Worker console.

Then review `docs/ARCHITECTURE.md` to understand the system, and
`docs/MCP_SETUP.md` to connect an AI agent.

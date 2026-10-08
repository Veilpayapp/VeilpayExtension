# Veilpay — Privacy-First Ethereum Payment Extension

**Status**: Phase 1 — Foundation & Messaging (In Progress)

Veilpay is a Chrome extension that enables private Ethereum payments through **censorship-resistant anonymous routing** and **zero-knowledge proofs** (ZK), without requiring a centralized relayer. The extension manages HD wallet accounts, encrypts transaction data, and routes payments through mixing pools to obscure sender/recipient relationships.

## Vision

Users should be able to send ETH and tokens privately with the same ease as MetaMask, without:
- Trusting a third party (no relayer, no privacy service)
- Exposing transaction graph to blockchain analysis
- Sacrificing transaction speed or cost

Veilpay achieves this through:
1. **Ephemeral keypairs** derived from a master seed (BIP-32-inspired)
2. **ZK proofs** that prove ownership without revealing identity
3. **Mixing pools** that break on-chain transaction links
4. **Onion routing** for message confidentiality between nodes

## Architecture

```
┌─ Content Script (inpage.ts)
│  └─ Injects `window.veilpay` into page context
│     └─ Pages call: veilpay.send({ to, amount, token })
│
├─ Background Service Worker (background/index.ts)
│  ├─ Message router + protocol validation
│  ├─ Vault (encrypted key storage, crypto ops)
│  └─ State stores (accounts, transactions, settings)
│
├─ Popup UI (popup/App.tsx)
│  ├─ Account dashboard
│  ├─ Send form + approval flow
│  ├─ Transaction history
│  └─ Settings
│
├─ Side Panel (sidepanel/App.tsx)
│  └─ Quick access to vault + pending transactions
│
└─ Options Page (options/App.tsx)
   └─ Advanced settings, key recovery, network config
```

**Data Flow**:
```
page → content script ┬─ [IPC bridge] → background service worker
                      └─ onMessage callback

page requests veilpay.send() → content validates → background processes → stores Zustand state → notifies popup
```

## Phase 1: Foundation & Messaging (Current)

**Goals**:
- [ ] Establish typed message protocol (`protocol.ts`)
- [ ] Build message router and client library
- [ ] Implement vault (encrypted storage, crypto ops)
- [ ] Wire messaging across service worker, content script, and inpage script
- [ ] Set up React UI skeleton (popup, side panel, options)
- [ ] Configure build, CI/CD, and testing infrastructure
- [ ] Prove CSP/ZK proof spike (offline, no relayer)

**Deliverables**:
- TypeScript message protocol with full type safety
- Working vault with AES-GCM encryption (SubtleCrypto)
- Messaging client/router pattern
- Popup that displays vault status
- CSP spike test proving ephemeral key derivation + proof generation

**Key Files**:
- `src/core/messaging/protocol.ts` — Request/response types
- `src/core/messaging/client.ts` — Message sender
- `src/core/messaging/router.ts` — Message handler registry
- `src/core/vault/crypto.ts` — SubtleCrypto wrapper
- `src/core/vault/storage.ts` — IndexedDB vault
- `src/background/index.ts` — Service worker entry
- `src/content/index.ts` — Content script + bridge
- `tests/unit/core/csp-zk.spike.test.ts` — Proof spike

## Phase 2: Wallet Integration & HD Keys

**Goals**:
- Implement BIP-32/BIP-44 HD wallet derivation
- Add account management (create, import, recover)
- Wire popup send form to background
- Implement transaction approval flow
- Add network support (Ethereum mainnet + testnets)

## Phase 3: ZK Proofs & Mixing

**Goals**:
- Implement ZK proof circuit for ownership
- Connect to mixing pool smart contracts
- Implement onion routing message layer
- Add transaction bundling

## Phase 4: Privacy & UX Polish

**Goals**:
- Add privacy settings (mixing rounds, delay, fee tolerance)
- Implement transaction history view
- Add account recovery from seed phrase
- Polish UI and accessibility

---

## Quick Start

### Prerequisites
- **Node.js** 20.x
- **Chrome** (Manifest v3 compatible)

### Install

```bash
npm install
npm run build
```

### Load into Chrome

1. Open `chrome://extensions`
2. Enable **Developer mode**
3. Click **Load unpacked** → select `dist/` folder
4. Pin extension to toolbar

### Development

```bash
npm run dev         # Watch mode (Vite)
npm run test:unit   # Run tests
npm run lint        # Check code quality
```

See `docs/SETUP.md` for detailed instructions.

## AI agents (MCP)

Claude and ChatGPT can pay from this wallet over MCP — the extension's caps
and approval prompts still apply, and it is testnet-only. Local mode runs
`mcp/veilpay-mcp.mjs` (Claude Code / Claude Desktop); relay mode deploys
`relay/server.mjs` for one-click web connectors. Full guide with free
Render deployment: **`docs/MCP_SETUP.md`**. Verify the whole stack with
`npm run smoke:agent`.

---

## Tech Stack

- **Build**: Vite + esbuild
- **Runtime**: Chrome Extensions API (Manifest v3)
- **Crypto**: SubtleCrypto (Web Crypto API)
- **Storage**: IndexedDB (via idb-keyval)
- **State**: Zustand
- **UI**: React 18 + TypeScript + Tailwind CSS
- **Testing**: Vitest + jsdom
- **CI/CD**: GitHub Actions
- **Type Safety**: TypeScript strict mode

---

## Security Considerations

### Phase 1 Constraints

- **No relayer**: All proof generation is offline and deterministic
- **Encrypted vault**: Keys stored as AES-GCM ciphertext in IndexedDB
- **No key export**: Private keys never leave the extension context
- **Deterministic crypto**: SubtleCrypto ensures reproducible signatures (no nonce randomness in tests)

### Known Limitations

- CSP spike is offline; Phase 2 will connect to actual mixing pools
- No transaction broadcast yet (Phase 2)
- No fee estimation (Phase 2)
- No token support yet (Phase 1 is ETH only; Phase 3+ adds ERC-20)

### Audit Notes

- Review `src/core/vault/crypto.ts` for key derivation + encryption
- Review `src/core/messaging/protocol.ts` for message validation
- Review message handling in `src/background/index.ts` for authorization checks
- All private keys are ephemeral and derived on-the-fly (no persistent secrets except master seed in vault)

---

## Project Structure

```
Veilpayextension/
├── src/
│   ├── background/           # Service worker
│   ├── content/              # Content script + inpage bridge
│   ├── popup/                # Popup UI (React)
│   ├── sidepanel/            # Side panel UI (React)
│   ├── options/              # Options page (React)
│   ├── offscreen/            # Offscreen document
│   ├── core/
│   │   ├── messaging/        # Protocol + client + router
│   │   ├── vault/            # Crypto + storage
│   │   ├── stores/           # Zustand stores
│   │   └── spike/            # CSP/ZK proof experiments
│   ├── ui/
│   │   ├── theme/            # Tailwind tokens
│   │   └── components/       # Reusable components (Phase 2+)
│   └── manifest.config.ts    # Manifest v3 generator
├── public/
│   ├── icons/                # Extension icons
│   └── *.html                # Entry point templates
├── tests/
│   ├── unit/                 # Unit tests
│   └── fixtures/             # Mock data
├── docs/
│   ├── ARCHITECTURE.md       # System design
│   ├── PHASE_1_ROADMAP.md    # This phase's goals
│   └── SETUP.md              # Setup guide
├── scripts/
│   ├── build.sh              # Build script
│   ├── dev.sh                # Dev watch script
│   └── csp-spike.sh          # CSP spike runner
└── vite.config.ts            # Build config
```

---

## Contributing

1. Read `docs/ARCHITECTURE.md` to understand the system
2. Check `docs/PHASE_1_ROADMAP.md` for current priorities
3. Follow the message protocol in `src/core/messaging/protocol.ts`
4. Add tests for any new feature
5. Run `npm run lint` and `npm run typecheck` before pushing

---

## License

MIT

---

## Support

- **Issues**: GitHub Issues
- **Docs**: See `docs/` directory
- **Setup**: `docs/SETUP.md`
- **Architecture**: `docs/ARCHITECTURE.md`

---

**Phase 1 Status**: Foundation scaffolding complete. Next: Integrate wallet + prove CSP/ZK spike.
# VeilpayExtension
# VeilpayExtension

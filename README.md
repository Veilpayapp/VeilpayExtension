<div align="center">

# Veilpay

**A self-custody, multi-chain testnet wallet for Chrome — that dapps, x402 services, and AI agents can pay from, but never control.**

[![CI](https://github.com/chiragchanchal/VeilpayExtension/actions/workflows/ci.yml/badge.svg)](https://github.com/chiragchanchal/VeilpayExtension/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
![Node](https://img.shields.io/badge/node-%E2%89%A520-green)

*Keys never leave the extension. Every payment is capped, prompted, and audit-logged.*

</div>

---

## What is Veilpay?

Veilpay is a Manifest V3 Chrome extension that holds your own keys and speaks
three chains at once — **EVM (Sepolia)**, **Solana (devnet)**, and
**Stellar (testnet)**. It exposes a normal wallet provider to dapps, answers
[x402](https://x402.dev/) payment challenges inside `fetch`, and ships an
[MCP](https://modelcontextprotocol.io) server so **Claude and ChatGPT can
check balances and send testnet payments on your behalf** — always inside
spending caps you set, and with approval prompts for anything above them.

> **Testnet only.** Sepolia ETH, devnet SOL, testnet XLM. There is no mainnet
> path — by design, this is a place to experiment safely.

## Highlights

| | |
| --- | --- |
| 🔐 **Self-custody** | HD wallet (BIP-32/39), AES-GCM encrypted vault in IndexedDB, auto-lock |
| ⛓️ **Three chains** | EVM + Solana + Stellar accounts from one seed |
| 🖥️ **Dapp provider** | `window.veilpay`, EIP-1193 `ethereum`, and `solana` providers in pages |
| 💸 **x402 payments** | HTTP 402 payment challenges intercepted and settled from the wallet |
| 🤖 **AI agent payments** | MCP server (`mcp/`), hosted relay (`relay/`), OAuth pairing code |
| 🧢 **Spending caps (VAP)** | Per-origin grants with `maxPerWindow` limits, prompt above threshold |
| 🔔 **Human approvals** | Every transaction above your threshold opens an approval overlay |
| 📜 **Audit ledger** | Hash-chained, append-only record of every sensitive operation |
| 🚰 **Built-in faucet** | Fund all three testnets from the extension |

## Install (anyone can run it)

**Prerequisites:** [Node.js 20+](https://nodejs.org/) and Chrome/Chromium.

```bash
git clone https://github.com/chiragchanchal/VeilpayExtension.git
cd VeilpayExtension
npm install
npm run build
```

Then load it into Chrome:

1. Open `chrome://extensions`
2. Enable **Developer mode** (top-right toggle)
3. Click **Load unpacked** → select the `dist/` folder
4. Pin Veilpay to your toolbar

First run: create a vault, save the seed phrase somewhere safe, and use the
built-in faucet to fund your testnet accounts.

## Let Claude or ChatGPT pay from it

The extension ships everything needed for agent payments — no extra install.

1. In the extension: **Settings → Agent → Connect** (relay mode). The panel
   shows an 8-character **pairing code** and copies the connector URL.
2. In Claude: **Settings → Connectors → Add custom connector**.
   In ChatGPT: **Settings → Connectors → Add MCP server**.
3. Paste `https://veilpay-relay.onrender.com/mcp` (the default relay) — or your
   own deployment from the next section.
4. When the relay's pairing page opens, type the code from the extension, and
   approve.

You ask, the agent calls a tool, the wallet decides:

> **You:** what's my Solana balance?
> **Claude:** *(calls `get_balance`)* 4.25 SOL on devnet.
> **You:** send 0.5 to `9xQe…`
> **Claude:** *(calls `send_payment`)* Sent — the wallet asked you to approve it
> first, because it's above your cap.

Six tools are exposed: `wallet_status`, `list_accounts`, `get_balance`,
`send_payment`, `list_grants`, `revoke_grant`. Spending caps and approval
prompts apply to the agent exactly as they do to a dapp.

**Full guide — local mode (Claude Code / Claude Desktop), relay mode, and
troubleshooting: [docs/MCP_SETUP.md](docs/MCP_SETUP.md)**

### Run your own relay (optional, free)

Prefer not to use the default hosted relay? Deploy your own in one click on
Render's free tier:

[![Deploy to Render](https://render.com/images/deploy-button.svg)](https://render.com/deploy?repo=https://github.com/chiragchanchal/VeilpayExtension)

Zero-dependency Node — `render.yaml` and a `Dockerfile` are included for any
other host. The relay only moves *messages*: it never sees keys, and cannot
sign anything. Design and threat model:
[docs/AGENT_PAYMENTS.md](docs/AGENT_PAYMENTS.md).

## Architecture

```
┌────────────────┐  provider + approvals   ┌──────────────────────────┐
│  dapp (page)   │ ──────────────────────► │  content + inpage bridge │
└────────────────┘                         └───────────┬──────────────┘
┌────────────────┐  x402 challenge          ┌───────────▼──────────────┐
│  x402 service  │                          │   background worker      │
└────────────────┘                          │  vault · chains · grants │
┌────────────────┐  MCP over relay/stdio    │  approvals · audit ledger│
│  Claude / GPT  │ ──────────────────────►  └──────────────────────────┘
└────────────────┘            (asks; never signs)
```

- `src/background/` — service worker: message router, vault ops, chain
  clients, approval flows, agent bridge
- `src/content/`, `src/core/x402/` — page provider and the fetch interceptor
- `src/core/vault/` — AES-GCM encrypted key storage (PBKDF2 + WebCrypto)
- `src/core/chains/` — EVM, Solana, and Stellar transaction building/signing
  on [@noble/curves](https://github.com/paulmillr/noble-curves)
- `src/ui/`, `src/popup/`, `src/sidepanel/`, `src/options/` — React 19 +
  Tailwind surfaces
- `relay/` — the hosted agent relay (OAuth + long-poll bridge, zero deps)
- `mcp/` — the local MCP server for Claude Code / Claude Desktop
- `docs/` — [architecture](docs/ARCHITECTURE.md) ·
  [agent payments](docs/AGENT_PAYMENTS.md) ·
  [MCP setup](docs/MCP_SETUP.md) · [setup](docs/SETUP.md)

## Security model

- **Keys stay home.** Private keys live only in the extension's encrypted
  vault and are never exported, logged, or sent to any dapp, relay, or server.
- **The relay and MCP server cannot sign.** They relay *requests*; the
  extension enforces caps, prompts, and signs locally.
- **Privileged actions are origin-gated.** Vault unlock, pairing, and grant
  changes are only accepted from the extension's own UI, verified by
  Chrome-stamped sender fields — never from a page.
- **Approvals are transient.** Pending approvals live in session storage and
  are cancelled when the vault locks.

## Development

```bash
npm run dev          # Vite watch mode → dist/
npm run test         # full suite (512 tests)
npm run lint         # ESLint, zero warnings allowed
npm run typecheck    # strict TypeScript
npm run build        # typecheck + production build
npm run gate:all     # everything: types, lint, tests, build, size, secrets
npm run smoke:agent  # live end-to-end check of the relay + MCP + OAuth stack
npm run sim:pairing  # simulates the full pairing flow, incl. relay restarts
npm run x402:server  # local x402 reference server for manual testing
```

A dapp playground for the provider surface is included: run `npm run dev`
and open `http://localhost:5173/dapp-demo.html` — it exercises connect,
sign, send, and a full x402 payment against the wallet.

## Contributing

1. Read [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) first
2. Follow the message protocol in `src/core/messaging/protocol.ts`
3. Add tests for anything you change — `npm run gate:all` must pass
4. Keep the bundle lean: `npm run build:check-size` enforces the budget

## License

[MIT](LICENSE) — clone it, run it, build on it.

# Paying from Veilpay with Claude or ChatGPT (MCP)

Veilpay ships an MCP server, so an AI client can read the wallet and pay from
it — with the wallet's spending caps and approval prompts still enforced. You
ask, the client calls a tool, the wallet decides.

> **You:** what's my Solana balance?
> **Claude:** _(calls `get_balance`)_ 4.25 SOL on devnet.
> **You:** send 0.5 to `9xQe…`
> **Claude:** _(calls `send_payment`)_ Sent — the wallet asked you to approve it first, because it's above your cap.

Testnet only: Sepolia ETH, devnet SOL, testnet XLM. No mainnet path exists.

## How it fits together

```
┌────────────┐  stdio (local)  ┌──────────────────┐  localhost  ┌──────────────────────┐
│ Claude Code │ ─────────────► │ mcp/veilpay-mcp.mjs │ ─────────► │ Veilpay extension     │
│ Claude Desk │                └──────────────────┘             │ (polls, approves,     │
└────────────┘                                                  │  signs, broadcasts)   │
                                                                 └──────────────────────┘
┌────────────┐  Streamable HTTP + OAuth                                        ▲
│ ChatGPT     │ ─────────────► relay/server.mjs (deployed, free) ──────────────┘
│ claude.ai   │
└────────────┘
```

The server never sees key material. It can only _relay_ a request; the
extension decides whether caps allow it to run automatically or a human must
approve it. See `docs/AGENT_PAYMENTS.md` for the design and threat model.

## The tools

| Tool            | Purpose                                                              |
| --------------- | -------------------------------------------------------------------- |
| `wallet_status` | Is the extension reachable and the wallet unlocked? Call this first. |
| `list_accounts` | Wallet addresses, one per chain.                                     |
| `get_balance`   | Balance for a chain (or any address).                                |
| `send_payment`  | Send funds. `amount` is a decimal string such as `"1"` or `"0.05"`.  |
| `list_grants`   | Active spending caps.                                                |
| `revoke_grant`  | Stop an autonomous spending grant.                                   |

## Verify the stack first

One command exercises everything locally — the relay over real HTTP, the OAuth
handshake, a full tool-call round trip, and the stdio server as Claude Desktop
drives it:

```bash
npm run smoke:agent
```

After deploying the relay, point the same script at it:

```bash
node scripts/smoke-agent-stack.mjs https://your-relay.onrender.com
```

## Option A — local, for Claude Code / Claude Desktop

Nothing leaves your machine: the MCP server runs on your computer and the
extension polls it over loopback.

1. Build and load the extension (`npm run build`, then `chrome://extensions` →
   Developer mode → Load unpacked → `dist/`). Unlock the wallet.
2. Start the server:

   ```bash
   node mcp/veilpay-mcp.mjs
   ```

   On first run it prints a pairing token and writes it to
   `~/.veilpay-mcp/config.json` (Windows: `%USERPROFILE%\.veilpay-mcp\config.json`).

3. **Veilpay → Settings → Agent → Run locally** — paste the token, keep the
   port at `8765`, and pair. The status pill turns **Connected**.
4. Register the server with your client:

   **Claude Code**

   ```bash
   claude mcp add veilpay -- node /absolute/path/to/mcp/veilpay-mcp.mjs
   ```

   **Claude Desktop** — edit the config file:
   - macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`
   - Windows: `%APPDATA%\Claude\claude_desktop_config.json`
   - Linux: `~/.config/Claude/claude_desktop_config.json`

   ```json
   {
     "mcpServers": {
       "veilpay": {
         "command": "node",
         "args": ["/absolute/path/to/mcp/veilpay-mcp.mjs"]
       }
     }
   }
   ```

   Restart the client after saving.

5. Ask: _“Check my Veilpay wallet status.”_ The client calls `wallet_status`
   and reports the extension is reachable.

The wallet must stay unlocked and the extension running — the server relays to
it, it does not replace it.

## Option B — relay, for ChatGPT and claude.ai connectors

Web clients cannot reach your machine, so a small relay is deployed once and
the extension dials out to it. Users of your extension then connect with one
click: they paste nothing but the relay URL.

### Deploy the relay for free (Render)

The relay is a single zero-dependency Node process.

1. Push this repo to GitHub (it must be reachable by Render).
2. Open
   [**Deploy to Render**](https://render.com/deploy?repo=https://github.com/chiragchanchal/VeilpayExtension)
   — the `render.yaml` blueprint in the repo root provisions a free web
   service. (Manual path: Render dashboard → New → Blueprint → select the
   repo.)
3. When it is live, note the URL, e.g. `https://veilpay-relay.onrender.com`,
   then verify it:

   ```bash
   node scripts/smoke-agent-stack.mjs https://veilpay-relay.onrender.com
   ```

Free-plan trade-offs: the service sleeps after ~15 minutes without traffic
(the first request after that takes ~30–60 s to wake), and pairings live in
memory, so a restart means users re-connect from the extension — one click. A
`Dockerfile` is also included if you prefer another host that runs containers;
any Node 20+ host with TLS works.

### Connect a wallet (what your users do)

1. **Veilpay → Settings → Agent → Hosted relay** — enter
   `https://veilpay-relay.onrender.com` and Connect. The extension registers
   itself and puts its MCP URL on the clipboard.
2. In ChatGPT: **Settings → Connectors → Add an MCP server**, paste the URL,
   then Connect. In claude.ai: **Settings → Connectors → Add custom
   connector**, same paste. (If your plan gates custom connectors, the option
   will not appear — that is a client-side limitation, not a relay error.)
3. The client opens the relay's consent page — approve it. That is the whole
   flow.

### Try it

- _“What's my wallet status?”_ → `wallet_status`
- _“Show my accounts and balances.”_ → `list_accounts`, `get_balance`
- _“Send 0.05 SOL to …”_ → `send_payment` — above your approval threshold, the
  extension prompts you and the call waits (up to three minutes), then reports.

Fund testnet accounts from the extension's built-in faucet.

## Safety model, in one screen

- **The relay and MCP server cannot sign anything.** Keys never leave the
  extension; a deployed relay can only _ask_ for a payment, and the extension
  enforces caps and prompts regardless of who is asking.
- **A grant is a real spending capability.** Anything holding the pairing
  token or a bearer token can spend up to your caps without prompts. Keep
  `maxPerWindow` and `approvalThreshold` small, and use `revoke_grant` /
  Disconnect when you are done.
- **Local mode keeps metadata private.** A relay routes payment metadata
  (amount, recipient) through a third party — that is the cost of zero-setup;
  run `mcp/veilpay-mcp.mjs` locally if that matters to you.
- **Testnet only.** These funds have no monetary value.

## Troubleshooting

| Symptom                                 | Meaning                                                                                                            |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `wallet_status` errors                  | Extension closed or locked. Open Veilpay, unlock, retry.                                                           |
| Status pill “Waiting for the AI client” | Paired but the bridge is unreachable: local — is `node mcp/veilpay-mcp.mjs` running? relay — is the service awake? |
| 401 from the relay                      | Token no longer matches (relay restarted, or disconnected) — re-connect from Settings → Agent.                     |
| Connector creation fails in ChatGPT     | The URL must be public `https://`; check with the smoke script. Also verify your plan allows custom connectors.    |
| First request after idle is slow        | Free-plan cold start (~30–60 s). It succeeds on retry.                                                             |

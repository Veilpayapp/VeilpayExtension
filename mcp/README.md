# Veilpay MCP server

Lets Claude (or any MCP client) pay from your Veilpay wallet:

> **You:** send 1 SOL to `9xQe...`
> **Claude:** _(calls `send_payment`)_
> **Wallet:** sends it — or asks you to approve first, if it's above your cap.

Free, local, no accounts, no hosting. See `docs/AGENT_PAYMENTS.md` for the
design and its threat model.

## How it fits together

```
Claude  ──MCP/stdio──►  veilpay-mcp.mjs  ──localhost:8765──►  Veilpay extension
```

The MCP server never sees key material. It relays a request; the extension
decides whether your spending caps allow it to run automatically or whether you
must approve it.

## Run it

```bash
node mcp/veilpay-mcp.mjs
```

On first run it generates a pairing token, prints it, and writes it to
`~/.veilpay-mcp/config.json`. Paste that token into **Veilpay → Settings → Agent
bridge** to connect the wallet.

Environment overrides:

| Variable              | Default                      | Purpose                   |
| --------------------- | ---------------------------- | ------------------------- |
| `VEILPAY_BRIDGE_PORT` | `8765`                       | Port the extension polls. |
| `VEILPAY_MCP_CONFIG`  | `~/.veilpay-mcp/config.json` | Token location.           |

Check it is up: `curl http://127.0.0.1:8765/health`

## Add to Claude Code

```bash
claude mcp add veilpay -- node /absolute/path/to/mcp/veilpay-mcp.mjs
```

## Add to Claude Desktop

In `claude_desktop_config.json`:

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

Use an absolute path — the client spawns the server from its own working
directory.

## Tools

| Tool            | Purpose                                                   |
| --------------- | --------------------------------------------------------- |
| `wallet_status` | Is the extension reachable and unlocked?                  |
| `list_accounts` | Wallet addresses, one per chain.                          |
| `get_balance`   | Balance for a chain (or any address).                     |
| `send_payment`  | Send funds. `amount` is a decimal like `"1"` or `"0.05"`. |
| `list_grants`   | Active spending caps.                                     |
| `revoke_grant`  | Stop an autonomous spending grant.                        |

## Limits worth knowing

- **Testnet only.** Sepolia ETH, devnet SOL, testnet XLM. No mainnet path
  exists, so these funds have no monetary value.
- **The wallet must be unlocked**, and the extension must be running.
- **A grant is a real spending capability.** Once one exists, anything holding
  the token can spend up to its caps without asking. Keep `maxPerWindow` and
  `approvalThreshold` small, and revoke grants you are not using.
- **Loopback only.** The bridge binds `127.0.0.1` and requires the token, so
  another machine cannot reach it — but any local process that reads the token
  can. Treat it like a password.
- A `send_payment` above your approval threshold blocks until you approve it in
  the extension, up to three minutes.

## Tests

```bash
npx vitest run tests/unit/mcp
```

For a live end-to-end check of this server, the relay, and the OAuth flow over
real HTTP, run `npm run smoke:agent` (see `docs/MCP_SETUP.md`).

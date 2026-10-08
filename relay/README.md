# Agent relay — deploy this so users install nothing

Lets an AI client pay from Veilpay with **one click**. The user never runs Node,
never copies a token: the extension registers here, and the client's OAuth
discovery does the rest.

[![Deploy to Render](https://render.com/images/deploy-logo.svg)](https://render.com/deploy?repo=https://github.com/chiragchanchal/VeilpayExtension)

Free-tier one-click deploy via the `render.yaml` blueprint in the repo root; a
`Dockerfile` is included for any other host. Full setup guide, including what
end users do in ChatGPT/Claude: `docs/MCP_SETUP.md`.

```
Veilpay extension ──outbound poll──► relay ◄──Streamable HTTP + OAuth── Claude / ChatGPT
```

An extension can never be reached inbound, so the relay is the only way to make
this zero-setup. It is a small Node process with **no dependencies**.

## Run locally

```bash
node relay/server.mjs
# → http://127.0.0.1:8788
```

Check it: `curl http://127.0.0.1:8788/health`

## Deploy

One click on the free Render plan: the button above, or Render → New →
Blueprint → this repo (`render.yaml` at the repo root is the blueprint).

Any other host that runs Node 20+ and terminates TLS also works (a
`Dockerfile` is included). Set:

| Variable | Required | Value |
| --- | --- | --- |
| `VEILPAY_RELAY_PUBLIC_URL` | no | `https://your-relay.example` — only if a proxy strips the forwarded headers Render and friends set. |
| `PORT` | no | Injected by most hosts. |
| `VEILPAY_RELAY_HOST` | no | `0.0.0.0` to accept external traffic (the blueprint and Dockerfile set this). |

`VEILPAY_RELAY_PUBLIC_URL` matters: OAuth metadata must advertise the public
`https://` origin, and the client rejects the discovery if it doesn't match what
it requested. Without it the server falls back to forwarded headers, which is
right behind a proxy but wrong if the headers are absent.

TLS is not optional — MCP clients only connect to `https://`, and a bearer token
over plaintext is a credential in the clear.

No persistent state: wallets live in memory. A restart drops pairings, and the
user re-runs the one-click flow. Add a store before running this for real.

## Endpoints

| Path | Purpose |
| --- | --- |
| `GET /health` | Liveness; no auth. |
| `POST /wallet/register` | The extension registers; returns a wallet id + secret. |
| `GET /next`, `POST /result` | The extension's authenticated long-poll. |
| `GET /.well-known/oauth-authorization-server` | OAuth discovery. |
| `GET /.well-known/oauth-protected-resource` | Resource discovery (RFC 9728). |
| `POST /register` | Dynamic client registration. |
| `GET /authorize` | The consent page a human sees. |
| `POST /authorize/approve` | Approves and redirects with a code. |
| `POST /token` | Exchanges a code (PKCE S256, single use) for a bearer token. |
| `POST /mcp/<walletId>` | Remote MCP. Requires `Authorization: Bearer …`. |

## Security posture

**Assume this process is hostile.** It routes every payment, so it is designed
to be safely operated by someone you would not otherwise trust:

- It holds no key material and cannot sign anything.
- It **cannot authorise a payment**. Spending caps and the approval prompt live
  inside the extension, so the relay can only *ask*. A fully compromised relay
  is reduced to spamming requests, which the extension's prompt limiter and the
  user's own caps bound.
- It **does** see payment metadata (amount, recipient), because it routes it.
  That is the real cost of zero-setup, and why the local `mcp/` mode still ships
  for anyone who would rather not expose it.

What is enforced here: PKCE S256 on every exchange, single-use authorization
codes, registered-redirect validation (no open redirect), constant-time secret
comparison, and a strict CSP on the consent page.

## The honest gap to retail

"Add this connector" cannot be pre-filled: neither Claude nor ChatGPT documents
a URL that pre-populates a custom connector. The panel therefore opens the right
settings page and copies the MCP URL to the clipboard, so the user pastes once.
Closing that last gap needs vendor support (or a published connector listed in
their directory).

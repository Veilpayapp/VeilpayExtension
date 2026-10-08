#!/usr/bin/env node
/**
 * End-to-end smoke test for the Veilpay agent stack.
 *
 * The unit tests drive the pieces; this drives the systems. It boots the real
 * relay over real HTTP, simulates the extension's poll loop, performs the
 * actual OAuth handshake an MCP client performs, and round-trips a tool call
 * the way Claude or ChatGPT would. It then spawns the local stdio MCP server
 * as a real subprocess and drives it the way Claude Desktop does.
 *
 * Usage:
 *   node scripts/smoke-agent-stack.mjs                  # everything, locally
 *   node scripts/smoke-agent-stack.mjs https://relay.example   # post-deploy checks
 *
 * Exit code 0 means every check passed; anything else prints what failed.
 */

import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRelay, startRelay } from '../relay/server.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

const failures = [];

function check(name, condition, detail = undefined) {
  if (condition) {
    console.info(`  ok  ${name}`);
  } else {
    failures.push(name);
    console.info(`FAIL  ${name}${detail === undefined ? '' : ` — ${detail}`}`);
  }
}

function base64url(input) {
  return Buffer.from(input).toString('base64url');
}

// ---------------------------------------------------------------------------
// Relay: the whole remote path a ChatGPT/Claude connector takes
// ---------------------------------------------------------------------------

/**
 * The extension's side of the wire: poll /next, answer every request through
 * `handle`, POST /result. This is exactly what src/background/agent-bridge.ts
 * does, minus the signing.
 */
async function runExtensionPoller(base, headers, handle, signal) {
  while (!signal.aborted) {
    let response;
    try {
      response = await fetch(`${base}/next`, { headers, signal });
    } catch {
      return; // aborted, or the relay went away
    }
    if (response.status !== 200) continue; // 204: nothing to do

    let payload;
    try {
      const data = await handle(await response.json());
      payload = { id: data.id, ok: true, data: data.result };
    } catch (cause) {
      payload = { id: null, ok: false, error: { message: String(cause) } };
    }
    if (payload.id === null) continue;
    await fetch(`${base}/result`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(payload),
    }).catch(() => {});
  }
}

/** Performs the OAuth handshake an MCP client performs, and returns a bearer token. */
async function obtainBearerToken(base, pairingCode) {
  const verifier = base64url(randomBytes(32));
  const challenge = base64url(createHash('sha256').update(verifier).digest());
  const redirectUri = 'https://client.example/callback';

  const client = await (
    await fetch(`${base}/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ redirect_uris: [redirectUri] }),
    })
  ).json();

  const params = new URLSearchParams({
    client_id: client.client_id,
    redirect_uri: redirectUri,
    response_type: 'code',
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state: 'smoke',
  });

  const approval = await fetch(`${base}/authorize/approve?${params}`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ pairing_code: pairingCode }),
    redirect: 'manual',
  });
  if (approval.status !== 302) {
    throw new Error(`authorize/approve returned ${approval.status}`);
  }
  const code = new URL(approval.headers.get('location') ?? '').searchParams.get('code');

  const token = await (
    await fetch(`${base}/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'authorization_code',
        code,
        client_id: client.client_id,
        redirect_uri: redirectUri,
        code_verifier: verifier,
      }),
    })
  ).json();
  return token.access_token;
}

/** One MCP request over Streamable HTTP, as the AI client sends it. */
async function mcpRequest(base, bearer, message) {
  const response = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(bearer === undefined ? {} : { authorization: `Bearer ${bearer}` }),
    },
    body: JSON.stringify(message),
  });
  if (response.status === 202) return { status: 202, body: null };
  return { status: response.status, body: await response.json() };
}

async function smokeRelay() {
  console.info('\n== relay: OAuth + MCP over real HTTP ==');
  // The production long-poll timing; the poller is aborted at cleanup so the
  // open socket never delays shutdown.
  const { server, relay, port } = await startRelay(0, createRelay());
  const base = `http://127.0.0.1:${port}`;
  try {
    // The extension registers itself, exactly as agent.relay.register does.
    const registration = await (await fetch(`${base}/wallet/register`, { method: 'POST' })).json();
    const walletHeaders = {
      'x-veilpay-wallet': registration.walletId,
      'x-veilpay-secret': registration.secret,
    };

    // Simulated wallet: answer status and balance requests with canned data.
    const canned = {
      status: { unlocked: true, chains: ['evm', 'solana', 'stellar'] },
      balance: { chain: 'solana', address: 'SimulatedAddress', balance: '4.25' },
    };
    const poller = new AbortController();
    const pollerDone = runExtensionPoller(
      base,
      walletHeaders,
      async (request) => {
        if (request.tool === 'status') return { id: request.id, result: canned.status };
        if (request.tool === 'balance') return { id: request.id, result: canned.balance };
        throw new Error(`smoke wallet cannot execute "${request.tool}"`);
      },
      poller.signal
    );

    // A client that never authenticated must be pointed at the OAuth metadata.
    const anonymousRaw = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 0, method: 'tools/list' }),
    });
    const anonymousBody = await anonymousRaw.json();
    check(
      'unauthenticated MCP call is refused with a resource_metadata pointer',
      anonymousRaw.status === 401 &&
        (anonymousRaw.headers.get('www-authenticate') ?? '').includes('resource_metadata'),
      JSON.stringify(anonymousBody)
    );

    // Discovery documents an MCP client reads before anything else.
    const as = await (await fetch(`${base}/.well-known/oauth-authorization-server`)).json();
    check(
      'OAuth authorization-server metadata is served',
      typeof as.authorization_endpoint === 'string' &&
        as.code_challenge_methods_supported?.includes('S256')
    );
    const pr = await (await fetch(`${base}/.well-known/oauth-protected-resource`)).json();
    check(
      'OAuth protected-resource metadata is served',
      typeof pr.resource === 'string' && Array.isArray(pr.authorization_servers)
    );

    const pairingPage = await fetch(`${base}/authorize?client_id=universal-smoke`);
    check(
      'universal authorize route shows the pairing page',
      pairingPage.status === 200 && (await pairingPage.text()).includes('pairing_code')
    );

    const bearer = await obtainBearerToken(base, registration.pairing.code);

    const init = await mcpRequest(base, bearer, {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { clientInfo: { name: 'smoke', version: '0' } },
    });
    check(
      'initialize is answered',
      init.status === 200 && init.body?.result?.serverInfo?.name === 'veilpay'
    );

    // A notification must be accepted with 202 and never answered.
    const notification = await mcpRequest(base, bearer, {
      jsonrpc: '2.0',
      method: 'notifications/initialized',
    });
    check('notification is accepted with 202', notification.status === 202);

    const listed = await mcpRequest(base, bearer, {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/list',
    });
    check(
      'tools/list exposes the six wallet tools',
      listed.status === 200 && listed.body?.result?.tools?.length === 6,
      `got ${listed.body?.result?.tools?.length} tools`
    );

    // The full payment round trip: MCP call → relay queue → extension poll →
    // result → MCP response. This is the exact path a "what's my balance"
    // prompt takes.
    const balance = await mcpRequest(base, bearer, {
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'get_balance', arguments: { chain: 'solana' } },
    });
    check(
      'tools/call round-trips through the simulated extension',
      balance.status === 200 &&
        typeof balance.body?.result?.content?.[0]?.text === 'string' &&
        balance.body.result.content[0].text.includes('4.25'),
      JSON.stringify(balance.body?.result?.content?.[0] ?? null)
    );

    poller.abort();
    await pollerDone;

    check('relay holds exactly one registered wallet', relay.walletCount() === 1);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(() => resolve()));
  }
}

// ---------------------------------------------------------------------------
// Local MCP server: the stdio path Claude Code / Claude Desktop take
// ---------------------------------------------------------------------------

/** Reads newline-delimited JSON-RPC from a child and resolves calls by id. */
class StdioMcpChild {
  constructor(child) {
    this.child = child;
    this.pending = new Map();
    this.nextId = 1;
    this.stderr = '';
    child.stdout.setEncoding('utf8');
    let buffer = '';
    child.stdout.on('data', (chunk) => {
      buffer += chunk;
      let newline = buffer.indexOf('\n');
      while (newline !== -1) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf('\n');
        if (line.length === 0) continue;
        try {
          const message = JSON.parse(line);
          const waiter = this.pending.get(message.id);
          if (waiter !== undefined) {
            this.pending.delete(message.id);
            waiter(message);
          }
        } catch {
          // Not JSON-RPC: ignore, stdout must stay protocol-clean.
        }
      }
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      this.stderr += chunk;
    });
  }

  call(method, params) {
    const id = this.nextId;
    this.nextId += 1;
    const message = { jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`no stdio response to ${method} within 30s`)),
        30_000
      );
      this.pending.set(id, (response) => {
        clearTimeout(timer);
        resolve(response);
      });
      this.child.stdin.write(`${JSON.stringify(message)}\n`);
    });
  }

  exit() {
    this.child.stdin.end();
    this.child.kill();
  }
}

async function smokeLocalMcp() {
  console.info('\n== local MCP server: stdio, as Claude Desktop drives it ==');
  const configDir = mkdtempSync(join(tmpdir(), 'veilpay-smoke-'));
  const configPath = join(configDir, 'config.json');

  // Port 0 asks the OS for a free port; the real port is reported on stderr.
  const child = spawn(process.execPath, [join(ROOT, 'mcp', 'veilpay-mcp.mjs')], {
    env: {
      ...process.env,
      VEILPAY_MCP_CONFIG: configPath,
      VEILPAY_BRIDGE_PORT: '0',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const mcp = new StdioMcpChild(child);

  try {
    // Startup is async: wait for the readiness line before reading the port
    // back out of stderr, or the checks below race the announcement.
    const announced = await new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), 15_000);
      const onData = (chunk) => {
        if (chunk.includes('MCP server ready')) {
          clearTimeout(timer);
          child.stderr.off('data', onData);
          resolve(true);
        }
      };
      child.stderr.on('data', onData);
    });
    check(
      'MCP server starts and announces the bridge',
      announced && /Bridge on http:\/\/127\.0\.0\.1:\d+/.test(mcp.stderr),
      mcp.stderr.slice(0, 300)
    );

    const init = await mcp.call('initialize', {
      clientInfo: { name: 'smoke', version: '0' },
    });
    check(
      'initialize answers with server info',
      init?.result?.serverInfo?.name === 'veilpay' && init?.result?.protocolVersion !== undefined
    );

    const listed = await mcp.call('tools/list', {});
    check(
      'tools/list exposes the six wallet tools',
      listed?.result?.tools?.length === 6,
      `got ${listed?.result?.tools?.length} tools`
    );

    const port = Number(/Bridge on http:\/\/127\.0\.0\.1:(\d+)/.exec(mcp.stderr)?.[1]);
    const token = JSON.parse(readFileSync(configPath, 'utf8')).token;
    const health = await (await fetch(`http://127.0.0.1:${port}/health`)).json();
    check(
      'bridge /health answers and sees no extension yet',
      health.ok === true && health.extensionConnected === false
    );

    // Full round trip: enqueue wallet_status via stdio, act as the extension.
    const statusCall = mcp.call('tools/call', { name: 'wallet_status', arguments: {} });
    // Give the server a moment to enqueue before polling it back out.
    await new Promise((resolve) => setTimeout(resolve, 150));
    const next = await (
      await fetch(`http://127.0.0.1:${port}/next`, { headers: { 'x-veilpay-token': token } })
    ).json();
    check(
      'extension poll receives the wallet_status request',
      next.tool === 'status',
      JSON.stringify(next)
    );
    await fetch(`http://127.0.0.1:${port}/result`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-veilpay-token': token },
      body: JSON.stringify({
        id: next.id,
        ok: true,
        data: { unlocked: true, chains: ['evm', 'solana', 'stellar'] },
      }),
    });
    const status = await statusCall;
    check(
      'wallet_status result flows back over stdio',
      status?.result?.content?.[0]?.text?.includes('unlocked') === true,
      JSON.stringify(status?.result?.content?.[0] ?? null)
    );

    // A bad token must never reach the queue.
    const refused = await fetch(`http://127.0.0.1:${port}/next`, {
      headers: { 'x-veilpay-token': 'not-the-token' },
    });
    check('bridge rejects a wrong token', refused.status === 401);

    // Argument validation fails before anything reaches the wallet.
    const invalid = await mcp.call('tools/call', {
      name: 'send_payment',
      arguments: { chain: 'dogecoin', to: 'x', amount: '1' },
    });
    check(
      'send_payment with a bad chain is refused client-side',
      invalid?.result?.isError === true
    );
  } finally {
    mcp.exit();
    rmSync(configDir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Remote mode: verify a deployed relay without local processes
// ---------------------------------------------------------------------------

async function smokeRemote(origin) {
  console.info(`\n== remote relay: ${origin} ==`);
  // Localhost is how a container or dev instance is checked; TLS is only
  // meaningful for a public origin.
  const localOrigin = /\/\/(localhost|127\.0\.0\.1)(:|\/|$)/.test(origin);
  if (localOrigin) {
    console.info('  ..  https check skipped: localhost origin');
  } else {
    check('origin uses https', origin.startsWith('https://'), 'MCP clients require TLS');
  }

  const healthResponse = await fetch(`${origin}/health`);
  const health = await healthResponse.json();
  check('GET /health is 200 ok', healthResponse.status === 200 && health.ok === true);

  const prResponse = await fetch(`${origin}/.well-known/oauth-protected-resource`);
  const pr = prResponse.status === 200 ? await prResponse.json() : {};
  check(
    'protected-resource metadata is served',
    prResponse.status === 200 && typeof pr.resource === 'string'
  );

  const asResponse = await fetch(`${origin}/.well-known/oauth-authorization-server`);
  const as = asResponse.status === 200 ? await asResponse.json() : {};
  check(
    'authorization-server metadata is served',
    asResponse.status === 200 &&
      typeof as.authorization_endpoint === 'string' &&
      typeof as.token_endpoint === 'string'
  );

  const challenge = await fetch(`${origin}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
  });
  check(
    'MCP endpoint refuses anonymous calls with a metadata pointer',
    challenge.status === 401 &&
      (challenge.headers.get('www-authenticate') ?? '').includes('resource_metadata')
  );

  console.info(
    '\nThe wallet-side check needs the extension: open Veilpay → Settings → Agent,\n' +
      'connect to this relay, then ask your AI client "what is my wallet status?".'
  );
}

// ---------------------------------------------------------------------------

async function main() {
  const target = process.argv[2];
  if (target !== undefined) {
    await smokeRemote(target.replace(/\/$/, ''));
  } else {
    await smokeRelay();
    await smokeLocalMcp();
  }

  console.info('');
  if (failures.length === 0) {
    console.info('All agent-stack checks passed.');
    process.exit(0);
  }
  console.error(`${failures.length} check(s) failed: ${failures.join('; ')}`);
  process.exit(1);
}

main().catch((cause) => {
  console.error(`smoke test crashed: ${cause instanceof Error ? cause.stack : String(cause)}`);
  process.exit(1);
});

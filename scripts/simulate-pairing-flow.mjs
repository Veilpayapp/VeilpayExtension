/**
 * End-to-end simulation of the user's exact flow, including the failure mode
 * they hit: relay restart between "Connect" and entering the pairing code.
 *
 * Simulates, against a real relay process (spawned like production):
 *   - the extension: register, poll loop with wallet_unknown auto-recovery
 *     (mirrors src/background/agent-bridge.ts + index.ts logic)
 *   - the AI client: dynamic registration, GET /authorize, POST /authorize/approve
 *     with the pairing code, token exchange, /mcp call
 *
 * Run: node scripts/simulate-pairing-flow.mjs
 */
import { createHash, randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';

const PORT = 18790;
const BASE = `http://127.0.0.1:${PORT}`;
let failures = 0;
function check(name, ok, detail = '') {
  console.info(`${ok ? '  ok  ' : 'FAIL  '}${name}${ok ? '' : ` — ${detail}`}`);
  if (!ok) failures += 1;
}

async function startRelay() {
  const child = spawn(process.execPath, ['relay/server.mjs'], {
    env: { ...process.env, VEILPAY_RELAY_PORT: String(PORT), VEILPAY_RELAY_HOST: '127.0.0.1' },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  // Wait for the port to answer.
  for (let i = 0; i < 100; i += 1) {
    try {
      const health = await fetch(`${BASE}/health`);
      if (health.ok) return child;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  throw new Error('relay did not start');
}

async function stopRelay(child) {
  child.kill();
  await once(child, 'exit');
}

/** The extension's registration, as agent.relay.register performs it. */
async function extensionRegister() {
  const response = await fetch(`${BASE}/wallet/register`, { method: 'POST' });
  const body = await response.json();
  return {
    walletId: body.walletId,
    secret: body.secret,
    code: body.pairing.code,
    expiresAt: body.pairing.expiresAt,
  };
}

/** One poll cycle, as agent-bridge.ts pollOnce does (wallet_unknown detection). */
async function pollOnce(wallet) {
  const response = await fetch(`${BASE}/next`, {
    headers: { 'x-veilpay-wallet': wallet.walletId, 'x-veilpay-secret': wallet.secret },
  });
  if (response.status === 204) return { connected: true, unauthorized: false };
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    return { connected: false, unauthorized: body.code === 'wallet_unknown' };
  }
  return { connected: true, unauthorized: false };
}

/** The extension's self-recovery, as recoverAgentRelay performs it. */
async function recoverWallet(wallet) {
  const fresh = await extensionRegister();
  Object.assign(wallet, fresh);
  return fresh;
}

/** The AI client's OAuth + pairing, as the browser does it. */
async function clientPairWithCode(code) {
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const redirectUri = 'https://client.example/callback';
  const client = await (
    await fetch(`${BASE}/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ redirect_uris: [redirectUri] }),
    })
  ).json();

  const page = await fetch(
    `${BASE}/authorize?client_id=${client.client_id}&redirect_uri=${encodeURIComponent(redirectUri)}&response_type=code&code_challenge=${challenge}&code_challenge_method=S256&state=sim`
  );
  const pageHtml = await page.text();

  const approval = await fetch(
    `${BASE}/authorize/approve?client_id=${client.client_id}&redirect_uri=${encodeURIComponent(redirectUri)}&response_type=code&code_challenge=${challenge}&code_challenge_method=S256&state=sim`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ pairing_code: code }).toString(),
      redirect: 'manual',
    }
  );
  const approvalBody = approval.status === 302 ? '' : await approval.text();
  return { pageShowsPairingInput: pageHtml.includes('pairing_code'), approval, approvalBody };
}

console.info('== phase 1: fresh register, immediate pairing (the happy path) ==');
let relay = await startRelay();
try {
  const wallet = await extensionRegister();
  const happy = await clientPairWithCode(wallet.code);
  check('pairing page is shown', happy.pageShowsPairingInput);
  check(
    'fresh code authorizes immediately',
    happy.approval.status === 302,
    `status ${happy.approval.status} body ${happy.approvalBody.slice(0, 120)}`
  );
} finally {
  await stopRelay(relay);
}

console.info("\n== phase 2: relay restarts between Connect and code entry (the user's failure) ==");
relay = await startRelay();
try {
  const wallet = await extensionRegister();
  console.info(`  extension registered, code ${wallet.code}`);
  // The relay restarts (deploy / free-tier sleep) — in-memory state is wiped.
  await stopRelay(relay);
  relay = await startRelay();

  // The user enters the code the panel still shows.
  const stale = await clientPairWithCode(wallet.code);
  const rejected = /does not recognize that code|not valid/i.test(stale.approvalBody);
  check(
    "stale code is rejected as unknown (reproduced the user's error)",
    stale.approval.status === 400 && rejected,
    `status ${stale.approval.status}`
  );

  // The extension's poller notices the wallet is gone and recovers.
  const outcome = await pollOnce(wallet);
  check(
    'poller detects wallet_unknown after the restart',
    outcome.unauthorized === true,
    JSON.stringify(outcome)
  );
  const fresh = await recoverWallet(wallet);
  console.info(`  extension re-registered, fresh code ${fresh.code}`);
  const freshPoll = await pollOnce(wallet);
  check('recovered wallet polls cleanly again', freshPoll.connected === true);

  // A pairing code fetched AFTER recovery authorizes.
  const codeResp = await (
    await fetch(`${BASE}/wallet/pairing-code`, {
      method: 'POST',
      headers: { 'x-veilpay-wallet': wallet.walletId, 'x-veilpay-secret': wallet.secret },
    })
  ).json();
  const retry = await clientPairWithCode(codeResp.code);
  check(
    'post-recovery code authorizes',
    retry.approval.status === 302,
    `status ${retry.approval.status} body ${retry.approvalBody.slice(0, 120)}`
  );
} finally {
  await stopRelay(relay);
}

console.info('');
if (failures === 0) {
  console.info('Simulation complete: the failure is reproduced and the recovery path works.');
  process.exit(0);
}
console.error(`${failures} check(s) failed.`);
process.exit(1);

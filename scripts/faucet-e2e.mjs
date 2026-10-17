/**
 * Faucet e2e bot — drives the REAL extension path for EVERY faucet network
 * the wallet carries, with automatic retries on upstream/service errors.
 *
 *   built extension → popup page (CDP) → chrome.runtime → background
 *   faucet handler → chain faucet (Friendbot / Solana RPC airdrop / EVM
 *   faucet URL map).
 *
 * Checks, per faucet network:
 *   - stellar:testnet → faucet.request MUST fund on-chain (txHash) and the
 *     account balance MUST become positive afterwards.
 *   - solana:{devnet,testnet} → txHash (airdrop landed) or faucetUrl (the
 *     documented rate-limit fallback). If a txHash lands, the balance is
 *     polled positive.
 *   - every evm testnet → faucetUrl whose host matches the wallet's URL map
 *     (pins the map, including the fixed Avalanche host).
 *   - each returned faucetUrl is probed for reachability (informational:
 *     some faucet pages 403 non-browser clients by design).
 *   - once, the REAL Faucet button in the popup is clicked (EVM account) and
 *     the bot verifies the pre-filled faucet page actually opens in a tab —
 *     the UI must never claim funds were "requested" without opening it.
 *
 * Every step retries automatically (attempts with backoff): a transient
 * upstream error (RPC reset, faucet hiccup, CDP glitch) costs a retry, not
 * the run.
 *
 * Usage:
 *
 *   npm run build && node scripts/faucet-e2e.mjs
 */

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const EXTENSION_DIR = resolve(process.cwd(), 'dist');
// Distinct from the SPP smoke drivers' CDP ports (9333-9341) so the two
// never fight over a port if run concurrently.
const CDP_PORT = 9345;
const PASSPHRASE = 'veilpay faucet bot pass phrase 2444';

/** The faucet networks the wallet ships (chain, networkId, expectation). */
const MATRIX = [
  { chain: 'evm', networkId: 'evm:sepolia', mode: 'url', host: 'sepoliafaucet.com' },
  { chain: 'evm', networkId: 'evm:base-sepolia', mode: 'url', host: 'alchemy.com' },
  { chain: 'evm', networkId: 'evm:arbitrum-sepolia', mode: 'url', host: 'alchemy.com' },
  { chain: 'evm', networkId: 'evm:optimism-sepolia', mode: 'url', host: 'alchemy.com' },
  { chain: 'evm', networkId: 'evm:polygon-amoy', mode: 'url', host: 'faucet.polygon.technology' },
  { chain: 'evm', networkId: 'evm:bsc-chapel', mode: 'url', host: 'testnet.bnbchain.org' },
  { chain: 'evm', networkId: 'evm:avalanche-fuji', mode: 'url', host: 'faucet.avax.network' },
  { chain: 'solana', networkId: 'solana:devnet', mode: 'tx-or-url' },
  { chain: 'solana', networkId: 'solana:testnet', mode: 'tx-or-url' },
  { chain: 'stellar', networkId: 'stellar:testnet', mode: 'tx' },
];

/** Faucet pages that 403 non-browser clients by design (bot protection). */
const BOT_PROTECTED_HOSTS = new Set(['faucet.polygon.technology']);

const failures = [];
function expect(condition, message) {
  if (!condition) failures.push(message);
  console.log(`[faucet-bot] ${condition ? '✓' : '✗'} ${message}`);
}

function sendExpression(kind, payload) {
  const safePayload = JSON.stringify(payload).replace(/'/g, "\\'");
  return `(async () => {
    const response = await chrome.runtime.sendMessage({
      id: crypto.randomUUID(), v: 1, kind: '${kind}', source: 'popup',
      payload: ${safePayload},
    });
    return JSON.stringify(response, (key, value) =>
      typeof value === 'bigint' ? value.toString() : value,
    );
  })()`;
}

async function main() {
  const profileDir = mkdtempSync(resolve(tmpdir(), 'faucet-bot-'));
  const edge = spawn(EDGE, [
    '--headless=new',
    '--disable-gpu',
    `--remote-debugging-port=${CDP_PORT}`,
    `--user-data-dir=${profileDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    `--disable-extensions-except=${EXTENSION_DIR}`,
    `--load-extension=${EXTENSION_DIR}`,
    'about:blank',
  ]);
  edge.stderr.on('data', () => {});

  try {
    await waitForCdp();
    console.log('[faucet-bot] Edge up, extension loading');

    let extensionId = null;
    for (let i = 0; i < 60 && extensionId === null; i += 1) {
      const targets = await cdpJson('/json/list');
      const target = targets.find(
        (t) => t.type === 'service_worker' && (t.url ?? '').includes('service-worker-loader'),
      );
      if (target) extensionId = new URL(target.url).host;
      else await sleep(500);
    }
    if (extensionId === null) throw new Error('Extension did not load.');
    console.log(`[faucet-bot] extension id: ${extensionId}`);

    // The popup page as a tab: same extension page the real UI runs in.
    const page = await cdpJson('/json/new?about:blank', 'PUT');
    const ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((res, rej) => {
      ws.addEventListener('open', res, { once: true });
      ws.addEventListener('error', rej, { once: true });
    });
    let nextId = 1;
    const pending = new Map();
    ws.addEventListener('message', (event) => {
      const message = JSON.parse(event.data);
      if (message.id && pending.has(message.id)) {
        pending.get(message.id)(message);
        pending.delete(message.id);
      }
    });
    const send = (method, params = {}) =>
      new Promise((res, rej) => {
        const id = nextId++;
        pending.set(id, res);
        ws.send(JSON.stringify({ id, method, params }));
        setTimeout(() => {
          if (pending.has(id)) {
            pending.delete(id);
            rej(new Error(`CDP timeout: ${method}`));
          }
        }, 120_000);
      });

    await send('Runtime.enable');
    await send('Page.enable');
    await send('Page.navigate', { url: `chrome-extension://${extensionId}/popup.html` });
    await sleep(4000);

    const evaluate = async (expression) => {
      const result = await send('Runtime.evaluate', {
        expression,
        awaitPromise: true,
        returnByValue: true,
      });
      if (result.result.exceptionDetails) {
        const details = result.result.exceptionDetails;
        const detail =
          details.exception?.description?.split('\n')[0] ?? details.text ?? 'unknown error';
        throw new Error(`evaluation failed: ${detail}`);
      }
      return JSON.parse(result.result.result.value ?? 'null');
    };
    const request = async (label, kind, payload) => {
      const response = await evaluate(sendExpression(kind, payload));
      console.log(`[faucet-bot] ${label}: ${JSON.stringify(response).slice(0, 200)}`);
      return response;
    };

    // ── Fresh wallet ────────────────────────────────────────────────────────
    const status = await request('vault.status', 'vault.status', {});
    if (status?.data?.state !== 'uninitialized') {
      throw new Error(`Expected a fresh profile, vault state is ${status?.data?.state}`);
    }
    const mnemonicResponse = await request('mnemonic.generate', 'mnemonic.generate', {
      strength: 128,
    });
    await request('vault.create', 'vault.create', {
      mnemonic: mnemonicResponse?.data?.mnemonic,
      passphrase: PASSPHRASE,
    });
    const accounts = await request('accounts.list', 'accounts.list', { accountIndex: 0 });
    const addresses = {};
    for (const account of accounts?.data ?? []) addresses[account.chain] = account.address;
    console.log(`[faucet-bot] addresses: ${JSON.stringify(addresses)}`);

    // ── The REAL Faucet button opens the pre-filled faucet tab (EVM) ────────
    // The popup page mounted while the vault was still uninitialized (the
    // bot created the wallet over CDP afterwards), so it renders onboarding.
    // Reload it: with an unlocked vault it bootstraps into the dashboard.
    await send('Page.navigate', { url: `chrome-extension://${extensionId}/popup.html` });
    await sleep(4000);
    await withRetries('faucet button opens the faucet tab', async () => {
      const click = `(() => {
        const button = document.querySelector('button[aria-label="Faucet"]');
        if (!button) throw new Error('Faucet button not rendered');
        button.click();
        return JSON.stringify({ clicked: true });
      })()`;
      await evaluate(click);
      // chrome.tabs.create is not synchronous with the click's fetch chain:
      // the message travels to the background and back before the tab opens.
      for (let i = 0; i < 20; i += 1) {
        await sleep(500);
        const targets = await cdpJson('/json/list');
        const tab = targets.find(
          (t) => t.type === 'page' && (t.url ?? '').startsWith('https://'),
        );
        if (tab) {
          expect(
            tab.url.includes('sepoliafaucet.com') || tab.url.includes('alchemy.com'),
            `Faucet button opened the pre-filled faucet page in a tab (${tab.url.slice(0, 60)}…)`,
          );
          return;
        }
      }
      throw new Error('no faucet tab appeared after clicking the button');
    });

    // ── Every faucet network, through the real background handler ──────────
    for (const entry of MATRIX) {
      await withRetries(`${entry.networkId} faucet`, async () => {
        const select = await request(
          `networks.select ${entry.networkId}`,
          'networks.select',
          { chain: entry.chain, networkId: entry.networkId },
        );
        if (select?.ok !== true) throw new Error(`networks.select failed for ${entry.networkId}`);

        const response = await request(`faucet.request ${entry.networkId}`, 'faucet.request', {
          chain: entry.chain,
          address: addresses[entry.chain],
        });
        if (response?.ok !== true) {
          throw new Error(`faucet.request failed: ${JSON.stringify(response).slice(0, 160)}`);
        }
        const data = response.data ?? {};
        const label = `${entry.networkId}`;

        if (entry.mode === 'tx') {
          expect(
            typeof data.txHash === 'string' && data.txHash.length > 0,
            `${label} funded on-chain (txHash ${String(data.txHash).slice(0, 16)}…)`,
          );
          await balanceBecomesPositive(entry.chain, addresses[entry.chain], label, request);
          return;
        }

        if (entry.mode === 'url') {
          expect(
            typeof data.faucetUrl === 'string' && data.faucetUrl.includes(entry.host),
            `${label} returns its mapped faucet URL host (${entry.host})`,
          );
          if (data.faucetUrl.includes('fauc.avax.network')) {
            failures.push(`${label} still returns the dead fauc.avax.network host`);
          }
          await probeReachable(data.faucetUrl, label);
          return;
        }

        // tx-or-url (Solana): the airdrop may be rate-limited (429) — the
        // documented fallback then hands back the web faucet URL.
        if (typeof data.txHash === 'string' && data.txHash.length > 0) {
          expect(true, `${label} airdropped on-chain (txHash ${data.txHash.slice(0, 16)}…)`);
          await balanceBecomesPositive(entry.chain, addresses[entry.chain], label, request, 60_000);
          return;
        }
        expect(
          typeof data.faucetUrl === 'string' && data.faucetUrl.includes('faucet.solana.com'),
          `${label} airdrop rate-limited → web-faucet fallback URL`,
        );
        await probeReachable(data.faucetUrl, label);
      });
    }

    console.log(`\n[faucet-bot] ${failures.length === 0 ? 'PASS' : 'FAIL'}`);
    for (const failure of failures) console.error(`  ✗ ${failure}`);
    process.exitCode = failures.length === 0 ? 0 : 1;
    ws.close();
  } finally {
    edge.kill();
    setTimeout(() => {
      try {
        rmSync(profileDir, { recursive: true, force: true });
      } catch {
        // best-effort
      }
    }, 500).unref();
  }
}

/** Retries a step on ANY failure (upstream error, service hiccup, CDP glitch). */
async function withRetries(label, fn, attempts = 3) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await fn(attempt);
    } catch (error) {
      lastError = error;
      console.log(
        `[faucet-bot] ${label} attempt ${attempt}/${attempts} failed: ${error.message}`,
      );
      if (attempt < attempts) await sleep(2000 * attempt);
    }
  }
  console.error(`[faucet-bot] ${label} FAILED after ${attempts} attempts: ${lastError.message}`);
  // A failed step must fail the run even when no `expect` fired.
  failures.push(`${label} failed after ${attempts} attempts: ${lastError.message}`);
}

/** Polls the wallet's own balance read until the faucet funds have landed. */
async function balanceBecomesPositive(chain, address, label, request, budgetMs = 90_000) {
  const startedAt = Date.now();
  for (;;) {
    const balance = await request(`account.balance ${chain}`, 'account.balance', {
      chain,
      address,
    });
    const value = BigInt(balance?.data?.balance ?? '0');
    if (value > 0n) {
      expect(true, `${label} balance landed (${value.toString()} base units)`);
      return;
    }
    if (Date.now() - startedAt > budgetMs) {
      expect(false, `${label} balance never became positive`);
      return;
    }
    await sleep(3000);
  }
}

/** Informational reachability probe of a returned faucet URL. */
async function probeReachable(url, label) {
  try {
    const host = new URL(url).host;
    const response = await fetch(url, {
      redirect: 'follow',
      signal: AbortSignal.timeout(15_000),
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
      },
    });
    if (BOT_PROTECTED_HOSTS.has(host) && response.status === 403) {
      console.log(`[faucet-bot] ℹ ${label} faucet page is bot-protected (403 to probes; opens in a real browser tab)`);
      return;
    }
    console.log(
      `[faucet-bot] ${response.status >= 200 && response.status < 400 ? '✓' : 'ℹ'} ${label} faucet page HTTP ${response.status}`,
    );
  } catch (cause) {
    console.log(`[faucet-bot] ℹ ${label} faucet page probe failed: ${String(cause).slice(0, 80)}`);
  }
}

async function cdpJson(path, method = 'GET') {
  const response = await fetch(`http://127.0.0.1:${CDP_PORT}${path}`, { method });
  return response.json();
}

async function waitForCdp() {
  for (let i = 0; i < 120; i += 1) {
    try {
      await cdpJson('/json/version');
      return;
    } catch {
      await sleep(500);
    }
  }
  throw new Error('Edge CDP did not come up.');
}

main().catch((error) => {
  console.error('[faucet-bot] driver failed:', error);
  process.exitCode = 1;
});

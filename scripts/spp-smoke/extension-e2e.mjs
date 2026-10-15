/**
 * End-to-end test of the Veilpay extension's SPP (pXLM privacy pool) support
 * against Stellar testnet, through the REAL code path:
 *
 *   built extension → service worker handlers → internal control plane →
 *   offscreen SPP runtime (WASM/OPFS/workers) → vault-backed signer →
 *   Groth16 proofs → Soroban pool contracts on testnet.
 *
 * Drives chrome.runtime messages from the extension's own popup page (loaded
 * in a tab so CDP can evaluate inside the extension origin), which is exactly
 * what the UI does. Usage:
 *
 *   npm run build && node scripts/spp-smoke/extension-e2e.mjs
 */

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const EXTENSION_DIR = resolve(process.cwd(), 'dist');
const CDP_PORT = 9334;
const PASSPHRASE = 'veilpay e2e pass phrase 2444';

const DEPOSIT_STROOPS = 200_000_000n; // 20 XLM
const TRANSFER_STROOPS = 50_000_000n; // 5 XLM
const WITHDRAW_STROOPS = 25_000_000n; // 2.5 XLM

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
  const profileDir = mkdtempSync(resolve(tmpdir(), 'spp-e2e-'));
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

  const failures = [];
  try {
    await waitForCdp();
    console.log('[e2e] Edge up, extension loaded');

    // Our extension: the service worker is loaded from the dist output's
    // `service-worker-loader.js` — distinctive enough to disambiguate from
    // Edge's built-in extensions, which also appear in the target list.
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
    console.log(`[e2e] extension id: ${extensionId}`);

    // Open the popup page as a tab: same extension page the UI runs in, and
    // CDP can evaluate inside the extension origin.
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
        }, 300_000);
      });

    await send('Runtime.enable');
    await send('Page.enable');
    await send('Page.navigate', { url: `chrome-extension://${extensionId}/popup.html` });
    await sleep(4000);

    const request = async (label, kind, payload) => {
      const started = Date.now();
      const result = await send('Runtime.evaluate', {
        expression: sendExpression(kind, payload),
        awaitPromise: true,
        returnByValue: true,
      });
      if (result.result.exceptionDetails) {
        throw new Error(
          `${label}: evaluation failed: ${result.result.exceptionDetails.text}`,
        );
      }
      const response = JSON.parse(result.result.result.value ?? 'null');
      const elapsed = ((Date.now() - started) / 1000).toFixed(1);
      console.log(`[e2e] ${label} (${elapsed}s): ${truncate(result.result.result.value)}`);
      if (response?.ok !== true) {
        failures.push(`${label}: ${result.result.result.value}`);
      }
      return response;
    };

    // ── Scenario ───────────────────────────────────────────────────────────
    const status = await request('vault.status', 'vault.status', {});
    if (status?.data?.state !== 'uninitialized') {
      // A leftover profile would poison the test; fail loudly.
      throw new Error(`Expected a fresh profile, vault state is ${status?.data?.state}`);
    }

    const mnemonicResponse = await request('mnemonic.generate', 'mnemonic.generate', {
      strength: 128,
    });
    const mnemonic = mnemonicResponse?.data?.mnemonic;
    if (typeof mnemonic !== 'string' || mnemonic.length === 0) throw new Error('No mnemonic.');

    await request('vault.create', 'vault.create', { mnemonic, passphrase: PASSPHRASE });

    const accounts = await request('accounts.list', 'accounts.list', { accountIndex: 0 });
    const stellarAccount = (accounts?.data ?? []).find((a) => a.chain === 'stellar');
    const stellarAddress = stellarAccount?.address;
    if (typeof stellarAddress !== 'string') throw new Error('No Stellar account.');
    console.log(`[e2e] stellar address: ${stellarAddress}`);

    // Fund the wallet (testnet faucet) and wait for the balance to land.
    await fundAndWait(stellarAddress);

    const balanceBefore = await request('account.balance #1', 'account.balance', {
      chain: 'stellar',
      address: stellarAddress,
    });
    const publicBefore = BigInt(balanceBefore?.data?.balance ?? '0');
    console.log(`[e2e] public XLM before: ${formatStroops(publicBefore)}`);

    // The full privacy-pool flow through the real extension path.
    const spp1 = await request('spp.status #1 (runtime bootstrap)', 'spp.status', {});
    const balance1 = BigInt(spp1?.data?.balanceStroops ?? '0');

    await request('spp.register', 'spp.register', {});

    const deposit = await request('spp.deposit (shield)', 'spp.deposit', {
      amountStroops: DEPOSIT_STROOPS.toString(),
    });

    const spp2 = await request('spp.status #2', 'spp.status', {});
    const balance2 = BigInt(spp2?.data?.balanceStroops ?? '0');

    const transfer = await request('spp.transfer (private self-send)', 'spp.transfer', {
      to: stellarAddress,
      amountStroops: TRANSFER_STROOPS.toString(),
    });

    // Measure the private balance right after the transfer (before the
    // withdraw changes it), so conservation is asserted at the right point.
    const sppMid = await request('spp.status #2b (after transfer)', 'spp.status', {});
    const balanceMid = BigInt(sppMid?.data?.balanceStroops ?? '0');

    const withdraw = await request('spp.withdraw (unshield)', 'spp.withdraw', {
      amountStroops: WITHDRAW_STROOPS.toString(),
    });

    const spp3 = await request('spp.status #3', 'spp.status', {});
    const balance3 = BigInt(spp3?.data?.balanceStroops ?? '0');

    const balanceAfter = await request('account.balance #2', 'account.balance', {
      chain: 'stellar',
      address: stellarAddress,
    });
    const publicAfter = BigInt(balanceAfter?.data?.balance ?? '0');

    // ── Assertions ─────────────────────────────────────────────────────────
    const expect = (condition, message) => {
      if (!condition) failures.push(message);
      console.log(`[e2e] ${condition ? '✓' : '✗'} ${message}`);
    };
    expect(deposit?.data?.txHash?.length > 0, 'deposit produced a transaction hash');
    expect(
      balance2 === balance1 + DEPOSIT_STROOPS,
      `private balance grew by the deposit (${balance1} → ${balance2})`,
    );
    expect(transfer?.data?.txHash?.length > 0, 'private transfer produced a transaction hash');
    expect(
      balanceMid === balance2,
      `private transfer conserved value (${balance2} → ${balanceMid})`,
    );
    expect(withdraw?.data?.txHash?.length > 0, 'withdraw produced a transaction hash');
    expect(
      balance3 === balance1 + DEPOSIT_STROOPS - WITHDRAW_STROOPS,
      `final private balance = deposit − withdraw (${balance3})`,
    );
    // Soroban resource fees for three pool transactions are several XLM; the
    // exact figure varies with footprint, so the public-balance assertions
    // use a generous fee allowance rather than exact arithmetic.
    const feeAllowance = 15_000_000n; // 1.5 XLM
    expect(
      publicAfter < publicBefore,
      `public XLM decreased (${formatStroops(publicBefore)} → ${formatStroops(publicAfter)})`,
    );
    expect(
      publicAfter > publicBefore - DEPOSIT_STROOPS - feeAllowance,
      'withdraw was credited back to the public balance',
    );
    expect(spp3?.data?.registered === true, 'wallet is registered to receive privately');

    console.log(`\n[e2e] ${failures.length === 0 ? 'PASS' : 'FAIL'}`);
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

function truncate(value) {
  return value === null || value === undefined ? 'null' : value.slice(0, 240);
}

function formatStroops(stroops) {
  return `${(Number(stroops) / 1e7).toFixed(7)} XLM`;
}

async function fundAndWait(address) {
  const response = await fetch(`https://friendbot.stellar.org/?addr=${encodeURIComponent(address)}`);
  const body = await response.json().catch(() => ({}));
  console.log(`[e2e] friendbot: successful=${body.successful}`);
  for (let i = 0; i < 30; i += 1) {
    const horizon = await fetch(
      `https://horizon-testnet.stellar.org/accounts/${encodeURIComponent(address)}`,
    );
    if (horizon.ok) {
      const account = await horizon.json();
      const xlm = account.balances?.find((b) => b.asset_type === 'native')?.balance;
      if (xlm !== undefined) {
        console.log(`[e2e] funded: ${xlm} XLM`);
        return;
      }
    }
    await sleep(2000);
  }
  throw new Error('Account did not fund.');
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
  console.error('[e2e] driver failed:', error);
  process.exitCode = 1;
});

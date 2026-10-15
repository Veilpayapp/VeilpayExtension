/**
 * Drives the SPP registry entry verification page headlessly (follow-up to
 * diag-drive.mjs): serves on :8791, CDP on :9341, navigates to
 * diag-verify.html, polls window.__SPP_DIAG_VERIFY until done (~90 s budget),
 * prints the console + result, exits 0 when complete.
 *
 * Usage: node scripts/spp-smoke/diag-verify-drive.mjs
 */

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { startServer } from './server.mjs';

const PORT = 8791;
const CDP_PORT = 9341;
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const TIMEOUT_MS = 120_000;

async function main() {
  const server = await startServer(PORT);
  const profileDir = mkdtempSync(join(tmpdir(), 'spp-verify-'));
  const edge = spawn(EDGE, [
    '--headless=new',
    '--disable-gpu',
    `--remote-debugging-port=${CDP_PORT}`,
    `--user-data-dir=${profileDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    'about:blank',
  ]);
  edge.stderr.on('data', () => {});

  try {
    const version = await waitForCdp(CDP_PORT, 30_000);
    console.log(`[verify-drive] Edge ready: ${version.Browser}`);

    const targets = await cdpJson(CDP_PORT, '/json/list');
    const page = targets.find((t) => t.type === 'page');
    if (!page) throw new Error('No page target found.');
    const ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve, { once: true });
      ws.addEventListener('error', reject, { once: true });
    });

    let nextId = 1;
    const pending = new Map();
    const consoleLines = [];
    ws.addEventListener('message', (event) => {
      const message = JSON.parse(event.data);
      if (message.id && pending.has(message.id)) {
        pending.get(message.id)(message);
        pending.delete(message.id);
        return;
      }
      if (message.method === 'Runtime.consoleAPICalled') {
        const text = message.params.args
          .map((a) => (a.value !== undefined ? JSON.stringify(a.value) : (a.description ?? '')))
          .join(' ');
        consoleLines.push(text.slice(0, 2000));
      }
    });

    const send = (method, params = {}) =>
      new Promise((resolve, reject) => {
        const id = nextId++;
        pending.set(id, resolve);
        ws.send(JSON.stringify({ id, method, params }));
        setTimeout(() => {
          if (pending.has(id)) {
            pending.delete(id);
            reject(new Error(`CDP timeout: ${method}`));
          }
        }, 30_000);
      });

    await send('Runtime.enable');
    await send('Page.enable');
    await send('Page.navigate', { url: `http://127.0.0.1:${PORT}/diag-verify.html` });

    const started = Date.now();
    let result = null;
    while (Date.now() - started < TIMEOUT_MS) {
      await sleep(2000);
      const evaluation = await send('Runtime.evaluate', {
        expression: 'window.__SPP_DIAG_VERIFY ? JSON.stringify(window.__SPP_DIAG_VERIFY) : "null"',
        returnByValue: true,
      });
      const value = evaluation?.result?.result?.value;
      if (value && value !== 'null') {
        result = JSON.parse(value);
        if (result.done) break;
      }
      process.stdout.write(`[verify-drive] waiting… ${Math.round((Date.now() - started) / 1000)}s\r`);
    }

    console.log('\n[verify-drive] console output:');
    for (const line of consoleLines) console.log(`  ${line}`);
    console.log('\n[verify-drive] result:');
    console.log(JSON.stringify(result, null, 2));
    ws.close();
    const done = result?.done === true;
    console.log(`\n[verify-drive] ${done ? 'COMPLETE' : 'INCOMPLETE/TIMEOUT'}`);
    console.log(
      `[verify-drive] entry present with matching keys: ${
        result?.ok === true ? 'YES' : 'NO'
      }`,
    );
    process.exitCode = done ? 0 : 1;
  } finally {
    edge.kill();
    server.close();
    setTimeout(() => {
      try {
        rmSync(profileDir, { recursive: true, force: true });
      } catch {
        // Best-effort cleanup.
      }
    }, 500).unref();
  }
}

async function cdpJson(port, path) {
  const response = await fetch(`http://127.0.0.1:${port}${path}`);
  return response.json();
}

async function waitForCdp(port, timeoutMs) {
  const started = Date.now();
  for (;;) {
    try {
      return await cdpJson(port, '/json/version');
    } catch {
      if (Date.now() - started > timeoutMs) throw new Error('Edge CDP did not come up.');
      await sleep(250);
    }
  }
}

main().catch((error) => {
  console.error('[verify-drive] driver failed:', error);
  process.exitCode = 1;
});

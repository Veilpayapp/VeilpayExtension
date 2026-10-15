/**
 * Drives the SPP smoke test headlessly:
 *
 *   1. bundles the signer (esbuild) so the page can import it as plain ESM,
 *   2. serves the SDK + page from a local static server,
 *   3. launches Edge headless with CDP,
 *   4. navigates to the page and polls window.__SPP_RESULT until done,
 *   5. prints the collected steps and exits 0/1.
 *
 * Usage: node scripts/spp-smoke/drive.mjs [--timeout-ms 480000]
 */

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { startServer } from './server.mjs';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const ROOT = join(HERE, '..', '..');

const PORT = 8788;
const CDP_PORT = 9333;
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';

const args = process.argv.slice(2);
const timeoutIdx = args.indexOf('--timeout-ms');
const TIMEOUT_MS = timeoutIdx >= 0 ? Number(args[timeoutIdx + 1]) : 480_000;

async function main() {
  // 1. Bundle the signer so the page loads it without bare imports.
  await run('npx', [
    'esbuild',
    join(HERE, 'signer-src.js'),
    '--bundle',
    '--format=esm',
    `--outfile=${join(HERE, 'signer.mjs')}`,
    '--log-level=error',
  ]);

  // 2. Static server.
  const server = await startServer(PORT);

  // 3. Launch Edge headless.
  const profileDir = mkdtempSync(join(tmpdir(), 'spp-smoke-'));
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
  edge.stderr.on('data', () => {}); // Edge is chatty; ignore.

  try {
    const version = await waitForCdp(CDP_PORT, 30_000);
    console.log(`[drive] Edge ready: ${version.Browser}`);

    // 4. Attach to the initial page target.
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
      if (message.method === 'Runtime.exceptionThrown') {
        consoleLines.push(
          `[exception] ${message.params.exceptionDetails.text} ${
            message.params.exceptionDetails.exception?.description ?? ''
          }`.slice(0, 2000),
        );
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
    await send('Page.navigate', { url: `http://127.0.0.1:${PORT}/page.html` });

    // 5. Poll for completion.
    const started = Date.now();
    let result = null;
    while (Date.now() - started < TIMEOUT_MS) {
      await sleep(2000);
      const evaluation = await send('Runtime.evaluate', {
        expression: 'window.__SPP_RESULT ? JSON.stringify(window.__SPP_RESULT) : "null"',
        returnByValue: true,
      });
      const value = evaluation?.result?.result?.value;
      if (value && value !== 'null') {
        result = JSON.parse(value);
        if (result.done) break;
      }
      process.stdout.write(`[drive] waiting… ${Math.round((Date.now() - started) / 1000)}s\r`);
    }

    console.log('\n[drive] console output:');
    for (const line of consoleLines) console.log(`  ${line}`);
    console.log('\n[drive] result summary:');
    if (result) {
      const { steps, ...summary } = result;
      console.log(JSON.stringify(summary, null, 2));
      console.log('[drive] steps:');
      for (const step of steps ?? []) {
        console.log(`  ${step.message}${step.data ? ` ${JSON.stringify(step.data).slice(0, 200)}` : ''}`);
      }
    } else {
      console.log('TIMED OUT waiting for the page to finish.');
    }

    ws.close();
    const ok = result?.ok === true;
    console.log(`\n[drive] ${ok ? 'PASS' : 'FAIL'}`);
    process.exitCode = ok ? 0 : 1;
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

function run(command, cmdArgs) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, cmdArgs, { cwd: ROOT, shell: true });
    const output = [];
    child.stdout.on('data', (d) => output.push(d));
    child.stderr.on('data', (d) => output.push(d));
    child.on('close', (code) => {
      if (code === 0) resolve(output.join(''));
      else reject(new Error(`${command} exited ${code}: ${output.join('')}`));
    });
  });
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
  console.error('[drive] driver failed:', error);
  process.exitCode = 1;
});

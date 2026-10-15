#!/usr/bin/env node
/**
 * Bundle size gate (D2: 5MB gzip ceiling).
 *
 * Fails the build if the packaged extension exceeds the budget. Runs after
 * `vite build`, walks `dist/`, and gzips each file to get a realistic
 * over-the-wire figure rather than raw bytes.
 *
 * `dist/spp/` — the Stellar Private Payments runtime (WASM, workers, and
 * circuit proving keys) — is DATA, not code: it is loaded by URL from the
 * offscreen document, never parsed by the page. It is measured and reported
 * separately instead of counting against the code budget; the whole SDK
 * cannot fit under a code-size ceiling by construction.
 *
 * Chrome Web Store rejects packages over 100MB, but the real constraint is
 * install-time UX and review scrutiny — hence the tighter self-imposed limit.
 */

import { readdir, readFile, stat } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';
import { join, relative, sep } from 'node:path';

const DIST = 'dist';
const BUDGET_BYTES = 5 * 1024 * 1024;
/** Files above this individually are worth naming in the report. */
const NOTABLE_BYTES = 200 * 1024;
/** Data assets measured separately from the code budget. */
const DATA_PREFIXES = ['spp'];

async function walk(dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...(await walk(full)));
    } else if (entry.isFile()) {
      out.push(full);
    }
  }
  return out;
}

function human(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

async function main() {
  try {
    await stat(DIST);
  } catch {
    console.error(`No ${DIST}/ directory. Run "npm run build" first.`);
    process.exit(1);
  }

  const files = await walk(DIST);
  if (files.length === 0) {
    console.error(`${DIST}/ is empty. The build produced nothing.`);
    process.exit(1);
  }

  let totalGzip = 0;
  let totalRaw = 0;
  let dataGzip = 0;
  let dataRaw = 0;
  const notable = [];

  for (const file of files) {
    const contents = await readFile(file);
    const gzipped = gzipSync(contents, { level: 9 }).length;
    // Path separators are platform-dependent; normalize so the data-prefix
    // exclusion behaves identically on Windows and POSIX.
    const rel = relative(DIST, file).split(sep).join('/');
    const isData = DATA_PREFIXES.some((prefix) => rel.startsWith(`${prefix}/`) || rel === prefix);
    if (isData) {
      dataRaw += contents.length;
      dataGzip += gzipped;
      continue;
    }
    totalRaw += contents.length;
    totalGzip += gzipped;
    if (gzipped >= NOTABLE_BYTES) {
      notable.push({ path: rel, gzipped });
    }
  }

  notable.sort((a, b) => b.gzipped - a.gzipped);

  console.log(`Files:      ${files.length}`);
  console.log(`Raw:        ${human(totalRaw)}`);
  console.log(`Gzip:       ${human(totalGzip)}`);
  console.log(`Budget:     ${human(BUDGET_BYTES)}`);
  console.log(`Headroom:   ${human(BUDGET_BYTES - totalGzip)}`);
  console.log(`SPP data:   ${human(dataGzip)} gzip (${human(dataRaw)} raw, excluded from the code budget)`);

  if (notable.length > 0) {
    console.log('\nLargest contributors (gzip):');
    for (const { path, gzipped } of notable.slice(0, 10)) {
      console.log(`  ${human(gzipped).padStart(10)}  ${path}`);
    }
  }

  if (totalGzip > BUDGET_BYTES) {
    console.error(
      `\nFAIL: bundle is ${human(totalGzip - BUDGET_BYTES)} over the ${human(BUDGET_BYTES)} budget.`,
    );
    console.error(
      'Options: lazy-load chain SDKs per surface, defer snarkjs, or renegotiate D2.',
    );
    process.exit(1);
  }

  const usedPct = ((totalGzip / BUDGET_BYTES) * 100).toFixed(1);
  console.log(`\nPASS: ${usedPct}% of budget used.`);
}

await main();

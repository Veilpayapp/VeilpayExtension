#!/usr/bin/env node
/**
 * Copies the Stellar Private Payments runtime into the built package.
 *
 * The SPP SDK cannot go through the Vite bundler: it derives its worker and
 * WASM URLs from its own module location and expects its dist/ tree to keep
 * its on-disk layout. This script copies the vendored runtime (built from the
 * SAME source tree as the deployed pool contracts — see
 * third_party/spp-sdk/README.md) verbatim into dist/spp/, plus the pinned
 * circuit artifacts and LGPL compliance files.
 *
 * Layout produced (consumed by @/core/spp/host via chrome.runtime.getURL):
 *
 *   dist/spp/js/…                  SDK entry (facade)
 *   dist/spp/dist/…                wasm glue + .wasm + workers/ + licenses/
 *   dist/spp/dist/circuits/…       the deployment's circuit artifacts
 *   dist/spp/circuits.json         the circuit lock (artifact fingerprints)
 *
 * The circuit source bundle is copied too: LGPL-3.0 requires offering
 * corresponding source for the compiled circuits we redistribute.
 */

import { copyFile, cp, mkdir, readdir, stat, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..');
const SDK = join(ROOT, 'third_party', 'spp-sdk');
const CIRCUITS = join(ROOT, 'third_party', 'spp-circuits');
const DIST = join(ROOT, 'dist', 'spp');

/**
 * Circuit artifacts the blocklist pool needs at prove time, pinned to the
 * deployment's committed ceremony. `graph.bin` is the witness generator,
 * `proving_key.bin` the Groth16 proving key, `r1cs` the constraint system,
 * and `vk.json` the verification key (informational client-side; the same key
 * is baked into the deployed verifier contract).
 */
const CIRCUIT_STEMS = ['policy_tx_2_2_B'];
const CIRCUIT_FILES = ['graph.bin', 'proving_key.bin', 'r1cs', 'vk.json'];

async function main() {
  if (!existsSync(join(SDK, 'js', 'index.js'))) {
    console.error('spp assets: third_party/spp-sdk is missing (see its README.md).');
    process.exit(1);
  }
  if (!existsSync(join(CIRCUITS, 'circuits.json'))) {
    console.error('spp assets: third_party/spp-circuits/circuits.json is missing.');
    process.exit(1);
  }
  if (!existsSync(join(ROOT, 'dist'))) {
    console.error('spp assets: dist/ does not exist — run vite build first.');
    process.exit(1);
  }

  // SDK entry + wasm glue + workers + licenses, layout-preserving. The vendored
  // tree ships no dist/circuits (we pin our own below), but skip defensively.
  await mkdir(join(DIST, 'js'), { recursive: true });
  await cp(join(SDK, 'js'), join(DIST, 'js'), { recursive: true });
  await mkdir(join(DIST, 'dist'), { recursive: true });
  for (const entry of await readdir(join(SDK, 'dist'))) {
    if (entry === 'circuits') continue; // replaced by the pinned ceremony below
    const from = join(SDK, 'dist', entry);
    if ((await stat(from)).isDirectory()) {
      await cp(from, join(DIST, 'dist', entry), { recursive: true });
    } else {
      await copyFile(from, join(DIST, 'dist', entry));
    }
  }

  // The circuit lock: fingerprints every artifact the prover may fetch.
  await copyFile(join(CIRCUITS, 'circuits.json'), join(DIST, 'circuits.json'));

  // Circuit artifacts pinned to the deployment ceremony.
  const circuitsDir = join(DIST, 'dist', 'circuits');
  await mkdir(circuitsDir, { recursive: true });
  /**
   * The ceremony's naming: graph and r1cs join with a dot, keys with an
   * underscore (policy_tx_2_2_B.graph.bin / policy_tx_2_2_B_proving_key.bin).
   */
  const artifactName = (stem, suffix) =>
    suffix === 'graph.bin' || suffix === 'r1cs'
      ? `${stem}.${suffix}`
      : `${stem}_${suffix}`;
  for (const stem of CIRCUIT_STEMS) {
    for (const suffix of CIRCUIT_FILES) {
      const name = artifactName(stem, suffix);
      const from = join(CIRCUITS, name);
      if (!existsSync(from)) {
        // The vk.json is informational client-side; the r1cs is only fetched
        // by some prover paths. Missing optional files warn, required ones
        // (graph + proving key) fail loudly.
        if (suffix === 'vk.json' || suffix === 'r1cs') {
          console.warn(`spp assets: optional circuit artifact ${name} not vendored — skipping.`);
          continue;
        }
        console.error(`spp assets: missing circuit artifact ${name}.`);
        process.exit(1);
      }
      await copyFile(from, join(circuitsDir, name));
    }
  }

  // LGPL compliance for the redistributed compiled circuits.
  await cp(join(CIRCUITS, 'licenses'), join(DIST, 'dist', 'licenses'), {
    recursive: true,
  });
  const sourceBundle = join(CIRCUITS, 'source-bundle.tar.gz');
  if (existsSync(sourceBundle)) {
    await copyFile(sourceBundle, join(circuitsDir, 'source-bundle.tar.gz'));
  }
  for (const name of ['NOTICE.txt', 'LGPL-3.0.txt', 'README.md']) {
    const from = join(CIRCUITS, name);
    if (existsSync(from)) await copyFile(from, join(circuitsDir, name));
  }

  // A machine-readable provenance note next to the circuits.
  await writeFile(
    join(circuitsDir, 'PROVENANCE.txt'),
    [
      'Stellar Private Payments circuit artifacts bundled with the Veilpay extension.',
      '',
      `Stems: ${CIRCUIT_STEMS.join(', ')}`,
      'Source: NethermindEth/stellar-private-payments deployments/testnet/circuit_keys',
      '        (the committed ceremony the on-chain verifiers were deployed with).',
      'Fingerprints are pinned by circuits.json (copied to dist/spp/circuits.json).',
      'Compiled circuits incorporate iden3/circomlib (LGPL-3.0): see NOTICE.txt,',
      'LGPL-3.0.txt, and source-bundle.tar.gz for the corresponding source.',
    ].join('\n'),
    'utf8',
  );

  console.log('spp assets: copied SDK + pinned circuits into dist/spp');
}

await main();

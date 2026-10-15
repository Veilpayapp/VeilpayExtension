/**
 * SPP registry-lookup diagnostic page.
 *
 * Reproduces the missing-registry-entry bug with a FRESH random wallet and
 * instruments every stage of the pipeline:
 *
 *   1. boots the vendored SDK exactly like page.js does,
 *   2. derives privacy keys and registers them on-chain (tx hash captured),
 * 2b. queries the RPC directly to confirm the on-chain `public_key_event`
 *      for THIS wallet exists (and captures its ledger),
 *   3. then polls ~every 5 s for ~3 minutes, recording per poll:
 *        - client.sync() duration,
 *        - recipientLookup(our address) → entry present? + sync markers,
 *        - recipientLookup(known-old registered address) → entry present?,
 *        - account.isRegistered() (on-chain simulated read),
 *        - operationalFeed(50) counts by kind + every 'registry' item.
 *
 * operationalFeed 'registry' items are built from a SQL JOIN on the
 * public_keys table, so their presence/absence discriminates
 * ingestion/parse (upstream of the table) from lookup-mismatch (downstream).
 *
 * Everything lands in window.__SPP_DIAG_RESULT (with .done and .ok) so the
 * driver can poll it.
 */

import {
  signSppMessage,
  signSorobanAuthPreimage,
  signSorobanTransactionEnvelope,
  stellarKeyInfo,
} from './signer.mjs';

const RESULT = (window.__SPP_DIAG_RESULT = { done: false, ok: false, steps: [], polls: [] });

function log(message, data) {
  const entry = { at: Date.now(), message, data: data === undefined ? null : data };
  RESULT.steps.push(entry);
  console.log(`[diag ${Math.round(performance.now())}ms] ${message}`, data ?? '');
}

const RPC = 'https://soroban-testnet.stellar.org';
const PASSPHRASE = 'Test SDF Network ; September 2015';
const LOOP_MS = 180_000;
const POLL_EVERY_MS = 5_000;
// Registered in earlier runs (ledger ~5166818 era and today ~5202551): its
// entry is a second probe of the local registry table.
const KNOWN_OLD_ADDRESS = 'GANBEFMT4SCGBG2OPD6MXKRAN6GNZ7ZXY5XEZ7LGLW6OPBG7VXIDNYPS';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------------------
// Small helpers (XDR topic construction for owner matching)
// ---------------------------------------------------------------------------

function u32be(value) {
  return new Uint8Array([
    (value >>> 24) & 0xff,
    (value >>> 16) & 0xff,
    (value >>> 8) & 0xff,
    value & 0xff,
  ]);
}

function concatBytes(arrays) {
  const total = arrays.reduce((n, a) => n + a.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const a of arrays) {
    out.set(a, offset);
    offset += a.length;
  }
  return out;
}

function toBase64(bytes) {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 1) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

/** XDR of ScVal::Address(ScAddress::Account(AccountId(Ed25519(publicKey)))). */
function expectedOwnerTopic(publicKey) {
  return toBase64(concatBytes([u32be(18), u32be(0), u32be(0), publicKey]));
}

async function rpc(method, params) {
  const response = await fetch(RPC, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const body = await response.json();
  if (body.error) throw new Error(`${method}: ${body.error.message}`);
  return body.result;
}

/** Registry-contract events on-chain, straight from the RPC. */
async function registryEventsFrom(startLedger, registryContractId) {
  const result = await rpc('getEvents', {
    startLedger,
    filters: [{ type: 'contract', contractIds: [registryContractId] }],
    pagination: { limit: 20 },
  });
  return result.events ?? [];
}

function summarizeLookup(lookup) {
  const entry = lookup.entry ?? null;
  return {
    entryPresent: Boolean(entry),
    entryOwner: entry ? String(entry.owner ?? 'n/a') : null,
    entryLedger: entry ? String(entry.ledger ?? 'n/a') : null,
    entryNoteKey: entry ? String(entry.notePublicKey) : null,
    entryEncryptionKey: entry ? String(entry.encryptionPublicKey) : null,
    registryFullySynced: lookup.registryFullySynced,
    registryLastFullyIndexedLedger: lookup.registryLastFullyIndexedLedger,
    networkTipLedger: lookup.networkTipLedger,
  };
}

// ---------------------------------------------------------------------------
// The diagnostic
// ---------------------------------------------------------------------------

void (async () => {
  let client = null;
  let account = null;
  try {
    log('boot');
    const mod = await import('/sdk/js/index.js');
    const { Client, Storage, bootnodeRequired, configureTelemetry } = mod;

    // A FRESH random wallet: never registered before.
    const seed = new Uint8Array(32);
    crypto.getRandomValues(seed);
    const { address, publicKey } = stellarKeyInfo(seed);
    RESULT.address = address;
    RESULT.seedHex = [...seed].map((b) => b.toString(16).padStart(2, '0')).join('');
    log('fresh wallet', { address });

    const contractConfig = await (await fetch('/deployments.json')).json();
    const REGISTRY = contractConfig.public_key_registry;
    RESULT.registryContractId = REGISTRY;
    log('deployment config loaded', {
      registry: REGISTRY,
      pools: contractConfig.pools.map((p) => p.poolContractId),
    });

    const funded = await (await fetch(`/friendbot?addr=${encodeURIComponent(address)}`)).json();
    log('friendbot', { successful: funded.successful, hash: funded.hash ?? null });

    await mod.default();
    log('wasm initialized');
    try {
      configureTelemetry({ level: 'debug', sink: 'console' });
    } catch {
      // Telemetry is diagnostic only.
    }

    const storage = await Storage.open();
    log('storage open');

    const needsBootnode = await bootnodeRequired(RPC, storage, { contractConfig });
    RESULT.bootnodeRequired = needsBootnode;
    log('bootnodeRequired', needsBootnode);

    const circuitLock = await (await fetch('/circuits.json')).json();
    client = await Client.new({
      rpcUrl: RPC,
      storage,
      contractConfig,
      circuitsBaseUrl: '/circuits/',
      circuitLock,
    });
    log('client created');

    const signer = {
      async getPublicKey() {
        return address;
      },
      async signMessage(message) {
        log('signer.signMessage', message);
        return { signedMessage: signSppMessage(message, seed), signerAddress: address };
      },
      async signTransaction(xdr, opts = {}) {
        log('signer.signTransaction', `${xdr.slice(0, 24)}…`);
        return {
          signedTxXdr: signSorobanTransactionEnvelope(
            xdr,
            seed,
            opts.networkPassphrase ?? PASSPHRASE,
          ),
          signerAddress: address,
        };
      },
      async signAuthEntry(preimage) {
        log('signer.signAuthEntry', `${preimage.slice(0, 24)}…`);
        return { signedAuthEntry: signSorobanAuthPreimage(preimage, seed), signerAddress: address };
      },
    };

    account = await client.account({ networkPassphrase: PASSPHRASE, userAddress: address }, signer);
    log('account bound');
    await account.derivePrivacyKeys();
    const keys = await account.privacyKeys();
    RESULT.ourKeys = {
      notePublicKey: String(keys.notePublicKey),
      encryptionPublicKey: String(keys.encryptionPublicKey),
    };
    log('privacy keys derived', RESULT.ourKeys);

    // Pre-registration state + on-chain baseline around the tip.
    const preLookup = await client.recipientLookup(address);
    log('lookup before register', summarizeLookup(preLookup));
    const latestBefore = await rpc('getLatestLedger', {});
    const baselineWindowStart = Math.max(1, latestBefore.sequence - 5);
    const baselineEvents = await registryEventsFrom(baselineWindowStart, REGISTRY);
    log('on-chain registry events in last 5 ledgers (baseline)', {
      windowStart: baselineWindowStart,
      events: baselineEvents.map((e) => ({ ledger: e.ledger, id: e.id })),
    });

    // ── Register ───────────────────────────────────────────────────────────
    const registerStart = performance.now();
    const txHash = await account.registerPublicKeys();
    RESULT.registerTxHash = String(txHash);
    RESULT.registerMs = Math.round(performance.now() - registerStart);
    log('registerPublicKeys complete', { txHash: RESULT.registerTxHash, ms: RESULT.registerMs });

    const txStatus = await rpc('getTransaction', { hash: RESULT.registerTxHash }).catch(
      (error) => ({ error: String(error) }),
    );
    RESULT.registerTxStatus = txStatus.status ?? txStatus.error ?? 'unknown';
    log('register tx status (RPC getTransaction)', RESULT.registerTxStatus);

    // The on-chain event for THIS wallet, straight from the RPC.
    const eventsAfter = await registryEventsFrom(baselineWindowStart, REGISTRY);
    const ourTopic = expectedOwnerTopic(publicKey);
    const baselineIds = new Set(baselineEvents.map((e) => e.id));
    RESULT.onChainRegisterEvents = eventsAfter
      .filter((e) => !baselineIds.has(e.id))
      .map((e) => ({
        ledger: e.ledger,
        id: e.id,
        ownerMatchesUs: e.topic?.[1] === ourTopic,
        topicCount: e.topic?.length ?? 0,
        value: (e.value ?? '').slice(0, 60),
      }));
    log('new on-chain registry events after register', RESULT.onChainRegisterEvents);

    const contracts = await client.allContractsData();
    RESULT.pools = contracts.pools.map((p) => ({ contractId: p.contractId, ledger: p.ledger }));
    log('allContractsData pools', RESULT.pools);

    // Initial catch-up sync (fresh OPFS database).
    const syncStart = performance.now();
    await client.sync();
    RESULT.initialSyncMs = Math.round(performance.now() - syncStart);
    log('initial foreground sync complete', { ms: RESULT.initialSyncMs });

    // ── Observation loop: ~3 minutes, ~one measurement per 5 s ────────────
    const loopStart = Date.now();
    while (Date.now() - loopStart < LOOP_MS) {
      const pollStart = Date.now();
      const poll = { n: RESULT.polls.length + 1, atMs: pollStart - loopStart };

      try {
        const syncStart = performance.now();
        await client.sync();
        poll.syncMs = Math.round(performance.now() - syncStart);
      } catch (error) {
        poll.syncError = String(error);
      }

      try {
        const lookup = await client.recipientLookup(address);
        Object.assign(poll, summarizeLookup(lookup));
      } catch (error) {
        poll.lookupError = String(error);
      }

      try {
        const oldLookup = await client.recipientLookup(KNOWN_OLD_ADDRESS);
        poll.oldEntryPresent = Boolean(oldLookup.entry ?? null);
        poll.oldNoteKey = oldLookup.entry ? String(oldLookup.entry.notePublicKey) : null;
        poll.oldRegistryLastFullyIndexedLedger = oldLookup.registryLastFullyIndexedLedger;
      } catch (error) {
        poll.oldLookupError = String(error);
      }

      try {
        const feed = await client.operationalFeed(50);
        const byKind = {};
        for (const item of feed) {
          byKind[item.kind] = (byKind[item.kind] ?? 0) + 1;
        }
        poll.feedByKind = byKind;
        poll.feedRegistryItems = feed
          .filter((item) => item.kind === 'registry')
          .map((item) => ({
            ledger: item.ledger,
            contractId: item.contractId ?? null,
            title: item.title,
            body: item.body,
          }));
      } catch (error) {
        poll.feedError = String(error);
      }

      try {
        poll.registeredOnChain = await account.isRegistered();
      } catch (error) {
        poll.registeredOnChainError = String(error);
      }

      RESULT.polls.push(poll);
      log(`poll #${poll.n}`, poll);
      if (poll.entryPresent) RESULT.ok = true;

      const wait = pollStart + POLL_EVERY_MS - Date.now();
      if (wait > 0) await sleep(wait);
    }

    RESULT.done = true;
    log('loop complete', { polls: RESULT.polls.length, entryEverPresent: RESULT.ok });
  } catch (error) {
    RESULT.error = String(error?.stack ?? error);
    log('FAILED', RESULT.error);
    RESULT.done = true;
  }
})();

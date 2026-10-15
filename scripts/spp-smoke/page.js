/**
 * SPP smoke test page — runs the SDK end-to-end against Stellar testnet with
 * a locally-held key, driven headlessly over CDP.
 *
 * Covers the full privacy flow: bootnode check → sync → key registration →
 * deposit (shield) → private transfer to self → withdraw (unshield), with
 * balance assertions after each step. The page records every step into
 * window.__SPP_RESULT so the driver can poll for completion; console output
 * mirrors the same information.
 */

import {
  signSppMessage,
  signSorobanAuthPreimage,
  signSorobanTransactionEnvelope,
  stellarKeyInfo,
} from './signer.mjs';

const RESULT = (window.__SPP_RESULT = { done: false, ok: false, steps: [] });

function log(message, data) {
  const entry = { at: Date.now(), message, data: data === undefined ? null : data };
  RESULT.steps.push(entry);
  console.log(`[spp ${Math.round(performance.now())}ms] ${message}`, data ?? '');
}

const RPC = 'https://soroban-testnet.stellar.org';
const PASSPHRASE = 'Test SDF Network ; September 2015';
const POOL = 'CALMZTI56TEDERLWXZJOS5TAN4QN2B36NAJK26MWKND4H5IG4NLPWEJ2';
const DEPOSIT_STROOPS = 500_000_000n; // 50 XLM
const TRANSFER_STROOPS = 200_000_000n; // 20 XLM
const WITHDRAW_STROOPS = 100_000_000n; // 10 XLM

// Deterministic test seed: the smoke run must be reproducible, and re-runs
// reuse the same SPP keys (derived from the wallet signature).
const seed = new Uint8Array(32);
{
  const hex = 'a11ce00d7d1e5f0d7b8a11c32f70c9ff1c2f1c0642c93b4f4f5b3c1d2e3f4a5b';
  for (let i = 0; i < 32; i += 1) {
    seed[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
}

async function fundViaProxy(address) {
  const response = await fetch(`/friendbot?addr=${encodeURIComponent(address)}`);
  return response.json();
}

void (async () => {
  try {
    log('boot');
    const { Client, Storage, bootnodeRequired, configureTelemetry } = await import(
      '/sdk/js/index.js'
    );

    const { address } = stellarKeyInfo(seed);
    RESULT.address = address;
    log('wallet address', address);

    const contractConfig = await (await fetch('/deployments.json')).json();
    log('deployment config loaded', {
      pools: contractConfig.pools.map((p) => p.poolContractId),
      deploymentLedger: contractConfig.pools[0].deploymentLedger,
    });

    const funded = await fundViaProxy(address);
    log('friendbot', { successful: funded.successful, hash: funded.hash });

    const init = (await import('/sdk/js/index.js')).default;
    await init();
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
    const client = await Client.new({
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
        return {
          signedAuthEntry: signSorobanAuthPreimage(preimage, seed),
          signerAddress: address,
        };
      },
    };

    const account = await client.account(
      { networkPassphrase: PASSPHRASE, userAddress: address },
      signer,
    );
    log('account bound', {
      userAddress: account.userAddress,
      signerAddress: account.signerAddress,
    });

    // The current SDK derives privacy keys explicitly (it needs the wallet's
    // signMessage callback): derive when they are not stored yet.
    try {
      await account.privacyKeys();
      log('privacy keys present');
    } catch {
      log('deriving privacy keys');
      await account.derivePrivacyKeys();
      log('privacy keys derived');
    }
    const keys = await account.privacyKeys();
    log('derived privacy keys', keys);

    // The registry entry must match the CURRENT derived keys — an entry left
    // by an older derivation format would route transfers to keys this
    // wallet cannot read. NOTE: the entry uses noteKey/encryptionKey; the
    // derived keys use notePublicKey/encryptionPublicKey.
    const lookup = await client.recipientLookup(address);
    log('registry lookup before register', {
      entryNoteKey: lookup.entry?.noteKey ?? null,
    });
    const registerResult = await account.registerPublicKeys();
    log('registered public keys', String(registerResult));
    const keysAfterRegister = await account.privacyKeys();
    log('derived privacy keys after register', keysAfterRegister);
    const lookupAfter = await client.recipientLookup(address);
    log('registry lookup after register', {
      entryNoteKey: lookupAfter.entry?.noteKey ?? null,
      matches:
        lookupAfter.entry !== undefined &&
        lookupAfter.entry.noteKey === keysAfterRegister.notePublicKey &&
        lookupAfter.entry.encryptionKey === keysAfterRegister.encryptionPublicKey,
      registryFullySynced: lookupAfter.registryFullySynced,
      registryLastFullyIndexedLedger: lookupAfter.registryLastFullyIndexedLedger,
      networkTipLedger: lookupAfter.networkTipLedger,
    });

    const registered = await account.isRegistered();
    log('registered on-chain', registered);

    await client.backgroundSync();
    log('backgroundSync started');

    const syncStart = performance.now();
    await client.sync();
    RESULT.syncMs = Math.round(performance.now() - syncStart);
    log('foreground sync complete', { ms: RESULT.syncMs });

    const pool = await account.pool({ poolContract: POOL });
    log('pool session open');

    const balanceBefore = await pool.balance();
    RESULT.balanceBefore = String(balanceBefore);
    log('pool balance before', String(balanceBefore));

    const depositStart = performance.now();
    const deposit = await pool.deposit(DEPOSIT_STROOPS);
    RESULT.depositMs = Math.round(performance.now() - depositStart);
    RESULT.depositResult = safeJson(deposit);
    log('deposit complete', { ms: RESULT.depositMs, result: RESULT.depositResult });

    await client.sync();
    const balanceAfterDeposit = await pool.balance();
    RESULT.balanceAfterDeposit = String(balanceAfterDeposit);
    log('pool balance after deposit', String(balanceAfterDeposit));

    // Private transfer to self: spends deposit notes into fresh notes under
    // our own keys — exercises nullifiers, Merkle membership, and the
    // recipient encryption path without a second wallet.
    const transferStart = performance.now();
    const transfer = await pool.transfer(address, TRANSFER_STROOPS);
    RESULT.transferMs = Math.round(performance.now() - transferStart);
    RESULT.transferResult = safeJson(transfer);
    log('private transfer complete', { ms: RESULT.transferMs, result: RESULT.transferResult });

    await client.sync();
    const balanceAfterTransfer = await pool.balance();
    RESULT.balanceAfterTransfer = String(balanceAfterTransfer);
    log('pool balance after transfer', String(balanceAfterTransfer));

    const withdrawStart = performance.now();
    const withdraw = await pool.withdraw(WITHDRAW_STROOPS);
    RESULT.withdrawMs = Math.round(performance.now() - withdrawStart);
    RESULT.withdrawResult = safeJson(withdraw);
    log('withdraw complete', { ms: RESULT.withdrawMs, result: RESULT.withdrawResult });

    await client.sync();
    const balanceAfterWithdraw = await pool.balance();
    RESULT.balanceAfterWithdraw = String(balanceAfterWithdraw);
    log('pool balance after withdraw', String(balanceAfterWithdraw));

    const notes = await pool.notes();
    RESULT.notes = safeJson(notes);
    log('notes', RESULT.notes);

    // The full cycle must conserve value exactly: deposit − withdraw, with
    // the private transfer moving value only between own notes.
    const expectedFinal = balanceBefore + DEPOSIT_STROOPS - WITHDRAW_STROOPS;
    RESULT.ok =
      balanceAfterDeposit === balanceBefore + DEPOSIT_STROOPS &&
      balanceAfterTransfer === balanceAfterDeposit &&
      balanceAfterWithdraw === expectedFinal;
    RESULT.expectedFinal = String(expectedFinal);
    RESULT.done = true;
  } catch (error) {
    RESULT.error = String(error?.stack ?? error);
    log('FAILED', RESULT.error);
    RESULT.done = true;
  }
})();

function safeJson(value) {
  try {
    return JSON.parse(
      JSON.stringify(value, (_key, val) => (typeof val === 'bigint' ? String(val) : val)),
    );
  } catch {
    return String(value);
  }
}

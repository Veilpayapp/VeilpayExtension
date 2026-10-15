/**
 * SPP two-wallet smoke test — proves the CROSS-WALLET private transfer path.
 *
 * One page, two independent wallets (fresh random seeds), one SDK client:
 *
 *   1. wallet A and wallet B each derive privacy keys and register them
 *      on-chain (both accounts are funded by friendbot for fees),
 *   2. A waits until B's registry entry is visible in the LOCAL index and
 *      matches B's derived keys (the exact lookup that the registered-check
 *      bug once masked),
 *   3. A shields XLM (deposit) and transfers privately to B's G… address —
 *      the sender resolves B's keys through the registry index and encrypts
 *      the notes to them,
 *   4. B's pool balance and unspent notes must show EXACTLY the transferred
 *      amount, and A's balance must be deposit − transfer.
 *
 * Receipt on B's side is the whole point: a self-transfer can cheat by using
 * local keys, but a cross-wallet transfer only lands if the registry lookup,
 * the recipient encryption, and B's note scanning all work.
 *
 * Records everything into window.__SPP_RESULT for the driver.
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
const DEPOSIT_STROOPS = 300_000_000n; // 30 XLM (shielded by A)
const TRANSFER_STROOPS = 70_000_000n; // 7 XLM (sent privately A → B)

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function randomSeed() {
  const seed = new Uint8Array(32);
  crypto.getRandomValues(seed);
  return seed;
}

/** A fresh signer bound to one seed, exactly like page.js's signer. */
function makeSigner(seed) {
  const { address } = stellarKeyInfo(seed);
  return {
    async getPublicKey() {
      return address;
    },
    async signMessage(message) {
      return { signedMessage: signSppMessage(message, seed), signerAddress: address };
    },
    async signTransaction(xdr, opts = {}) {
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
      return { signedAuthEntry: signSorobanAuthPreimage(preimage, seed), signerAddress: address };
    },
  };
}

/** Polls the local registry until B's entry exists and matches B's keys. */
async function waitForLocalEntry(client, address, expected, budgetMs = 90_000) {
  const started = Date.now();
  for (;;) {
    await client.sync().catch(() => undefined);
    const lookup = await client.recipientLookup(address).catch(() => null);
    const entry = lookup?.entry;
    if (
      entry &&
      entry.noteKey === expected.notePublicKey &&
      entry.encryptionKey === expected.encryptionPublicKey
    ) {
      return { ok: true, waitedMs: Date.now() - started, ledger: entry.ledger };
    }
    if (Date.now() - started > budgetMs) {
      return { ok: false, waitedMs: Date.now() - started };
    }
    await sleep(3_000);
  }
}

void (async () => {
  try {
    log('boot');
    const { Client, Storage, bootnodeRequired } = await import('/sdk/js/index.js');

    // Two INDEPENDENT wallets. Neither has ever transacted with the pool, so
    // B's receipt cannot come from any earlier state.
    const seedA = randomSeed();
    const seedB = randomSeed();
    const walletA = stellarKeyInfo(seedA);
    const walletB = stellarKeyInfo(seedB);
    RESULT.addressA = walletA.address;
    RESULT.addressB = walletB.address;
    log('wallet addresses', { a: walletA.address, b: walletB.address });

    const contractConfig = await (await fetch('/deployments.json')).json();
    const fundA = await (await fetch(`/friendbot?addr=${walletA.address}`)).json();
    const fundB = await (await fetch(`/friendbot?addr=${walletB.address}`)).json();
    log('friendbot', { a: fundA.successful, b: fundB.successful });

    const init = (await import('/sdk/js/index.js')).default;
    await init();
    log('wasm initialized');

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

    const accountA = await client.account(
      { networkPassphrase: PASSPHRASE, userAddress: walletA.address },
      makeSigner(seedA),
    );
    const accountB = await client.account(
      { networkPassphrase: PASSPHRASE, userAddress: walletB.address },
      makeSigner(seedB),
    );
    log('both account sessions open');

    await accountA.derivePrivacyKeys();
    const keysB = await accountB.derivePrivacyKeys();
    log('privacy keys derived for both wallets');

    const registerA = String(await accountA.registerPublicKeys());
    const registerB = String(await accountB.registerPublicKeys());
    RESULT.registerTxHashA = registerA;
    RESULT.registerTxHashB = registerB;
    log('both wallets registered on-chain', { a: registerA, b: registerB });

    // The transfer's recipient resolution reads the LOCAL registry index —
    // the sender must see B's entry before it can encrypt notes to B.
    const bVisible = await waitForLocalEntry(client, walletB.address, keysB);
    RESULT.recipientEntryVisible = bVisible.ok;
    RESULT.recipientEntryWaitMs = bVisible.waitedMs;
    log('B visible in local registry index', bVisible);
    if (!bVisible.ok) {
      throw new Error("B's registry entry never appeared in the local index.");
    }

    const poolA = await accountA.pool({ poolContract: POOL });
    const poolB = await accountB.pool({ poolContract: POOL });

    const balanceBeforeA = await poolA.balance();
    const balanceBeforeB = await poolB.balance();
    RESULT.balanceBeforeA = String(balanceBeforeA);
    RESULT.balanceBeforeB = String(balanceBeforeB);
    log('pool balances before', { a: String(balanceBeforeA), b: String(balanceBeforeB) });

    // A shields XLM into the pool.
    const deposit = await poolA.deposit(DEPOSIT_STROOPS);
    RESULT.depositResult = safeJson(deposit);
    log('A deposited (shield)', RESULT.depositResult);

    await client.sync();
    const balanceAfterDepositA = await poolA.balance();
    RESULT.balanceAfterDepositA = String(balanceAfterDepositA);
    log('A balance after deposit', RESULT.balanceAfterDepositA);

    // The private cross-wallet transfer: the public ledger records only that
    // the pool was used — not A, not B, not the amount.
    const transfer = await poolA.transfer(walletB.address, TRANSFER_STROOPS);
    RESULT.transferResult = safeJson(transfer);
    log('A transferred privately to B', RESULT.transferResult);

    await client.sync();
    const balanceAfterTransferA = await poolA.balance();
    const balanceAfterTransferB = await poolB.balance();
    RESULT.balanceAfterTransferA = String(balanceAfterTransferA);
    RESULT.balanceAfterTransferB = String(balanceAfterTransferB);
    log('balances after transfer', {
      a: RESULT.balanceAfterTransferA,
      b: RESULT.balanceAfterTransferB,
    });

    // B's unspent notes must sum to the transferred amount — notes B alone
    // can decrypt.
    const notesB = await poolB.notes();
    const unspentSumB = notesB.reduce((total, note) => total + BigInt(note.amount), 0n);
    RESULT.bUnspentNoteCount = notesB.filter((note) => !note.spent).length;
    RESULT.bUnspentNoteSum = String(unspentSumB);
    log('B unspent notes', { count: RESULT.bUnspentNoteCount, sum: RESULT.bUnspentNoteSum });

    RESULT.ok =
      balanceAfterDepositA === balanceBeforeA + DEPOSIT_STROOPS &&
      balanceAfterTransferA === balanceAfterDepositA - TRANSFER_STROOPS &&
      balanceAfterTransferB === balanceBeforeB + TRANSFER_STROOPS &&
      unspentSumB === TRANSFER_STROOPS;
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

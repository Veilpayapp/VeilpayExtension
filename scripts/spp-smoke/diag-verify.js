/**
 * SPP registry entry verification (follow-up to diag-page.js).
 *
 * The diagnostic run registered a FRESH wallet:
 *   address            GBNHET6QGHDF2QXQF3CT22K4V34A6NV5VYUUJ2RQ46WAMQ3YJIWORP35
 *   register tx        78ebf0d79bf28ab79833e5a64630edbe7643bc0a04db2659c9edc6d9c65ec321
 *   register ledger    5202929
 *   derived notePublicKey        0xc56dc59e538d99635c491a32d9f82e1deb8ff233cce09c9b8c001b1499fcb21a
 *   derived encryptionPublicKey  0xb23ef0635d7e3f134e2f970052b27fde6533c08719b2ac57c1f1b3d7fe94ef21
 *
 * This page boots the SDK, syncs a FRESH database, and looks that wallet up
 * with the CORRECT PublicKeyEntry property names (address / noteKey /
 * encryptionKey / ledger), so we can prove the local registry index returns
 * the entry AND its keys match the derived ones. No signer or registration
 * needed — a pure read path.
 */

const RESULT = (window.__SPP_DIAG_VERIFY = { done: false, ok: false });

function log(message, data) {
  console.log(`[verify ${Math.round(performance.now())}ms] ${message}`, data ?? '');
}

const RPC = 'https://soroban-testnet.stellar.org';
const REGISTERED = {
  address: 'GBNHET6QGHDF2QXQF3CT22K4V34A6NV5VYUUJ2RQ46WAMQ3YJIWORP35',
  registerLedger: 5202929,
  notePublicKey: '0xc56dc59e538d99635c491a32d9f82e1deb8ff233cce09c9b8c001b1499fcb21a',
  encryptionPublicKey: '0xb23ef0635d7e3f134e2f970052b27fde6533c08719b2ac57c1f1b3d7fe94ef21',
};
const OLD_REGISTERED = 'GANBEFMT4SCGBG2OPD6MXKRAN6GNZ7ZXY5XEZ7LGLW6OPBG7VXIDNYPS';

const normalize = (value) => String(value).toLowerCase().replace(/^0x/, '');

void (async () => {
  try {
    log('boot');
    const mod = await import('/sdk/js/index.js');
    const { Client, Storage, bootnodeRequired } = mod;
    const contractConfig = await (await fetch('/deployments.json')).json();

    await mod.default();
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

    const syncStart = performance.now();
    await client.sync();
    RESULT.syncMs = Math.round(performance.now() - syncStart);
    log('sync complete', { ms: RESULT.syncMs });

    const lookup = await client.recipientLookup(REGISTERED.address);
    const entry = lookup.entry ?? null;
    RESULT.entry = entry
      ? {
          address: entry.address,
          ledger: entry.ledger,
          noteKey: entry.noteKey,
          encryptionKey: entry.encryptionKey,
        }
      : null;
    RESULT.markers = {
      registryFullySynced: lookup.registryFullySynced,
      registryLastFullyIndexedLedger: lookup.registryLastFullyIndexedLedger,
      networkTipLedger: lookup.networkTipLedger,
    };
    log('recipientLookup (fresh wallet registered in the diagnostic run)', RESULT.entry);
    log('lookup markers', RESULT.markers);

    if (entry) {
      const matches =
        normalize(entry.noteKey) === normalize(REGISTERED.notePublicKey) &&
        normalize(entry.encryptionKey) === normalize(REGISTERED.encryptionPublicKey) &&
        entry.address === REGISTERED.address &&
        Number(entry.ledger) === REGISTERED.registerLedger;
      RESULT.keysMatchDerived = matches;
      log('entry keys match the derived keys', matches);
    }

    const oldLookup = await client.recipientLookup(OLD_REGISTERED);
    RESULT.oldEntry = oldLookup.entry
      ? {
          address: oldLookup.entry.address,
          ledger: oldLookup.entry.ledger,
          noteKey: oldLookup.entry.noteKey,
          encryptionKey: oldLookup.entry.encryptionKey,
        }
      : null;
    log('recipientLookup (known-old registered wallet)', RESULT.oldEntry);

    RESULT.ok = Boolean(entry) && RESULT.keysMatchDerived === true;
    RESULT.done = true;
    log('verification complete', { ok: RESULT.ok });
  } catch (error) {
    RESULT.error = String(error?.stack ?? error);
    log('FAILED', RESULT.error);
    RESULT.done = true;
  }
})();

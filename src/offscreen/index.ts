/**
 * Offscreen document — hosts contexts the MV3 service worker cannot.
 *
 * Two responsibilities:
 *
 *  1. The D3 spike (Groth16-proving capability probe), run once on install
 *     and reported over the internal control plane.
 *  2. The SPP (Stellar Private Payments) runtime host: the SDK needs OPFS,
 *     Web Workers, and WASM, none of which exist in the service worker. The
 *     background drives it with `spp:exec` messages; see `@/core/spp/host`.
 *
 * Both report/answer over the `veilpay:internal` channel so the background's
 * request bus never sees control-plane traffic.
 */

import { runCspSpike, toZkCapability } from '@/spike/csp-zk-probe';
import { executeSppOp } from '@/core/spp/host';
import {
  isSppExecRequest,
  isBackgroundWorkerSender,
  INTERNAL_CHANNEL,
} from '@/core/spp/internal-protocol';

/**
 * Resolves the background service worker's URL from the PACKAGED manifest.
 *
 * Offscreen documents get a restricted `chrome.runtime` — `getURL` and
 * messaging exist, `getManifest` does NOT (calling it throws), so the worker
 * URL this document must gate `spp:exec` senders against is read from the
 * extension's own `manifest.json` resource. The build pipeline rewrites the
 * service-worker entry (e.g. to `service-worker-loader.js`), so the live
 * manifest is the only source that is right in dev AND production. A failed
 * load resolves null: the gate then rejects every sender (fail-closed) —
 * SPP ops stop rather than run ungated.
 */
const backgroundWorkerUrl: Promise<string | null> = (async () => {
  try {
    const response = await fetch(chrome.runtime.getURL('manifest.json'));
    if (!response.ok) return null;
    const manifest = (await response.json()) as {
      background?: { service_worker?: unknown };
    };
    const worker = manifest.background?.service_worker;
    return typeof worker === 'string' && worker.length > 0
      ? chrome.runtime.getURL(worker)
      : null;
  } catch {
    return null;
  }
})();

void (async () => {
  const report = await runCspSpike();

  await chrome.runtime.sendMessage({
    // Marks this as control-plane traffic so the background routes it away from
    // the request bus, which would otherwise reject it as a malformed Request.
    channel: INTERNAL_CHANNEL,
    kind: 'spike:zk-result',
    result: toZkCapability(report),
  });
})();

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!isSppExecRequest(message)) return false;

  // The SPP host is driven by the BACKGROUND service worker only — the URL
  // check is Chrome-stamped, so even a compromised extension page cannot
  // pose as it. Pool ops submitted from here skip the request bus's
  // validation, preflight, and audit trail by design (the bus cannot host
  // the SDK), which is exactly why the entry point must be the bus's own
  // caller and nobody else. A content-script sender (tab set) is equally
  // rejected. The gate waits for the worker-URL load (a local resource
  // fetch; the first message can race it right after document creation).
  backgroundWorkerUrl
    .then((workerUrl) => {
      if (!isBackgroundWorkerSender(sender, workerUrl)) {
        sendResponse({ ok: false, message: 'Rejected: untrusted sender.' });
        return;
      }
      return executeSppOp(message.op, message.payload)
        .then((result) => sendResponse({ ok: true, result }))
        .catch((cause: unknown) => {
          const detail = cause instanceof Error ? cause.message : String(cause);
          // The vault-locked sentinel travels so the background can surface the
          // protocol-level VAULT_LOCKED error instead of a generic failure.
          const code =
            typeof cause === 'object' &&
            cause !== null &&
            (cause as { code?: unknown }).code === 'VAULT_LOCKED'
              ? { code: 'VAULT_LOCKED' as const }
              : {};
          sendResponse({ ok: false, message: detail, ...code });
        });
    })
    .catch(() => {
      // backgroundWorkerUrl never rejects (it resolves null on failure), but
      // a broken chain must not leave the caller hanging.
      sendResponse({ ok: false, message: 'Rejected: untrusted sender.' });
    });
  return true; // keep the channel open for the async response
});

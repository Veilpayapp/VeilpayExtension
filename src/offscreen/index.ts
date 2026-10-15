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
import { isSppExecRequest, INTERNAL_CHANNEL } from '@/core/spp/internal-protocol';

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

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!isSppExecRequest(message)) return false;

  executeSppOp(message.op, message.payload)
    .then((result) => sendResponse({ ok: true, result }))
    .catch((cause: unknown) => {
      const detail = cause instanceof Error ? cause.message : String(cause);
      // The vault-locked sentinel travels so the background can surface the
      // protocol-level VAULT_LOCKED error instead of a generic failure.
      const code =
        typeof cause === 'object' && cause !== null && (cause as { code?: unknown }).code === 'VAULT_LOCKED'
          ? { code: 'VAULT_LOCKED' as const }
          : {};
      sendResponse({ ok: false, message: detail, ...code });
    });
  return true; // keep the channel open for the async response
});

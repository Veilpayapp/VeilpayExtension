import {
  EXTENSION_SOURCES,
  isPrivilegedKind,
  Request,
  type Response,
  type ResponseData,
  type RequestKind,
} from './protocol';

/**
 * Handler signature. `origin` and `pageOrigin` are derived by the router from
 * the Chrome-supplied sender, never from the message body, so a handler can
 * trust them.
 *
 * - `origin`: the effective origin of the sender (extension origin for our own
 *   pages; the `chrome-extension://` origin for content-script messages — which
 *   is useless for distinguishing dapps, hence `pageOrigin`).
 * - `pageOrigin`: for a content-script/tab message, the origin of the page the
 *   content script runs in, parsed from Chrome's `sender.url`. For an
 *   extension-owned surface (no tab) it is the extension origin. This is the
 *   value dapp permission checks must use — it cannot be spoofed by the page.
 */
export type Handler<K extends RequestKind> = (
  payload: Extract<Request, { kind: K }>['payload'],
  ctx: { origin: string | null; pageOrigin: string | null; tabId: number | null }
) => Promise<ResponseData[K]>;

export type HandlerMap = { [K in RequestKind]: Handler<K> };

export type ErrorCode =
  | 'BAD_REQUEST'
  | 'UNKNOWN_KIND'
  | 'VAULT_LOCKED'
  | 'INTERNAL'
  | 'ORIGIN_DENIED'
  | 'CONNECT_PENDING'
  | 'USER_REJECTED'
  | 'APPROVAL_TIMEOUT'
  | 'CHAIN_UNSUPPORTED'
  | 'X402_INVALID_CHALLENGE'
  | 'PROMPT_RATE_LIMITED'
  | 'TX_REJECTED'
  | 'INSUFFICIENT_BALANCE';

/** Thrown by handlers to produce a specific, display-safe error response. */
export class ProtocolError extends Error {
  readonly code: ErrorCode;

  constructor(code: ErrorCode, message: string) {
    super(message);
    this.name = 'ProtocolError';
    this.code = code;
  }
}

const FALLBACK_ID = '00000000-0000-0000-0000-000000000000';

function err(id: string, code: ErrorCode, message: string): Response {
  return { id, ok: false, error: { code, message } };
}

/** `chrome-extension://<id>`, the only origin our own surfaces can report. */
function extensionOrigin(): string | null {
  const id = globalThis.chrome?.runtime?.id;
  return typeof id === 'string' && id.length > 0 ? `chrome-extension://${id}` : null;
}

/**
 * The origin of the page a message came from, or the extension origin for our
 * own surfaces.
 *
 * For content-script / tab messages Chrome populates `sender.url` with the
 * page's own URL; parsing it yields the real dapp origin, which the page cannot
 * forge. For extension-owned surfaces (no tab) there is no page, so we fall back
 * to the sender origin (the extension's own). Malformed/absent URLs resolve to
 * null and callers treat it as an untrusted sender.
 */
function pageOriginFromSender(sender: chrome.runtime.MessageSender): string | null {
  if (sender.tab !== undefined && typeof sender.url === 'string') {
    try {
      return new URL(sender.url).origin;
    } catch {
      return null;
    }
  }
  return sender.origin ?? null;
}

/**
 * Whether a message genuinely came from an extension-owned surface.
 *
 * Three independent conditions, because the first two cannot be forged from a
 * page and the third catches a surface that should never ask for a secret:
 *
 *  1. No `tab`. Chrome populates `sender.tab` for every content-script message
 *     and never for an extension page, so its presence alone disqualifies.
 *  2. `origin` equals our own extension origin. Chrome stamps this; a page
 *     cannot spoof it.
 *  3. The declared `source` is a UI surface. This one *is* forgeable, so it is
 *     never load-bearing on its own — it exists to reject `offscreen` and
 *     `inpage`, which share our origin or our bus but must not unlock a vault.
 */
function isTrustedExtensionSurface(
  request: Request,
  sender: chrome.runtime.MessageSender
): boolean {
  if (sender.tab !== undefined) return false;

  const expected = extensionOrigin();
  if (expected === null || sender.origin !== expected) return false;

  return EXTENSION_SOURCES.includes(request.source);
}

/**
 * Validates an inbound message and dispatches it.
 *
 * Anything that fails validation is rejected before a handler runs. Unexpected
 * exceptions are flattened to INTERNAL so no stack trace or key material can
 * escape to a page context.
 */
export async function dispatch(
  raw: unknown,
  sender: chrome.runtime.MessageSender,
  handlers: HandlerMap
): Promise<Response> {
  const parsed = Request.safeParse(raw);

  if (!parsed.success) {
    const claimedId =
      typeof raw === 'object' && raw !== null && 'id' in raw && typeof raw.id === 'string'
        ? raw.id
        : FALLBACK_ID;
    return err(claimedId, 'BAD_REQUEST', 'Message did not match the expected shape.');
  }

  const request = parsed.data;

  // Enforced before the handler map is touched: a kind that carries a secret or
  // destroys the vault must originate from our own UI, not from a page that
  // merely claims to be it.
  if (isPrivilegedKind(request.kind) && !isTrustedExtensionSurface(request, sender)) {
    return err(
      request.id,
      'ORIGIN_DENIED',
      'That action can only be started from the Veilpay interface.'
    );
  }

  const ctx = {
    origin: sender.origin ?? null,
    // A tab message carries the real page URL in `sender.url`, which Chrome
    // stamps and a page cannot spoof. Parse it so dapp permission checks key on
    // the genuine page origin rather than a self-asserted payload field.
    pageOrigin: pageOriginFromSender(sender),
    tabId: sender.tab?.id ?? null,
  };

  try {
    switch (request.kind) {
      case 'ping':
        return { id: request.id, ok: true, data: await handlers.ping(request.payload, ctx) };
      case 'vault.status':
        return {
          id: request.id,
          ok: true,
          data: await handlers['vault.status'](request.payload, ctx),
        };
      case 'session.lock':
        return {
          id: request.id,
          ok: true,
          data: await handlers['session.lock'](request.payload, ctx),
        };
      case 'zk.capability':
        return {
          id: request.id,
          ok: true,
          data: await handlers['zk.capability'](request.payload, ctx),
        };
      case 'accounts.list':
        return {
          id: request.id,
          ok: true,
          data: await handlers['accounts.list'](request.payload, ctx),
        };
      case 'account.balance':
        return {
          id: request.id,
          ok: true,
          data: await handlers['account.balance'](request.payload, ctx),
        };
      case 'indexer.history':
        return {
          id: request.id,
          ok: true,
          data: await handlers['indexer.history'](request.payload, ctx),
        };
      case 'tx.estimate':
        return {
          id: request.id,
          ok: true,
          data: await handlers['tx.estimate'](request.payload, ctx),
        };
      case 'tx.transfer':
        return {
          id: request.id,
          ok: true,
          data: await handlers['tx.transfer'](request.payload, ctx),
        };
      case 'vault.create':
        return {
          id: request.id,
          ok: true,
          data: await handlers['vault.create'](request.payload, ctx),
        };
      case 'vault.unlock':
        return {
          id: request.id,
          ok: true,
          data: await handlers['vault.unlock'](request.payload, ctx),
        };
      case 'vault.reset':
        return {
          id: request.id,
          ok: true,
          data: await handlers['vault.reset'](request.payload, ctx),
        };
      case 'mnemonic.generate':
        return {
          id: request.id,
          ok: true,
          data: await handlers['mnemonic.generate'](request.payload, ctx),
        };
      case 'security.status':
        return {
          id: request.id,
          ok: true,
          data: await handlers['security.status'](request.payload, ctx),
        };
      case 'security.pin.setup':
        return {
          id: request.id,
          ok: true,
          data: await handlers['security.pin.setup'](request.payload, ctx),
        };
      case 'security.pin.verify':
        return {
          id: request.id,
          ok: true,
          data: await handlers['security.pin.verify'](request.payload, ctx),
        };
      case 'security.webauthn.setup':
        return {
          id: request.id,
          ok: true,
          data: await handlers['security.webauthn.setup'](request.payload, ctx),
        };
      case 'security.webauthn.challenge':
        return {
          id: request.id,
          ok: true,
          data: await handlers['security.webauthn.challenge'](request.payload, ctx),
        };
      case 'eth.chainId':
        return {
          id: request.id,
          ok: true,
          data: await handlers['eth.chainId'](request.payload, ctx),
        };
      case 'eth.requestAccounts':
        return {
          id: request.id,
          ok: true,
          data: await handlers['eth.requestAccounts'](request.payload, ctx),
        };
      case 'eth.accounts':
        return {
          id: request.id,
          ok: true,
          data: await handlers['eth.accounts'](request.payload, ctx),
        };
      case 'eth.sendTransaction':
        return {
          id: request.id,
          ok: true,
          data: await handlers['eth.sendTransaction'](request.payload, ctx),
        };
      case 'eth.switchChain':
        return {
          id: request.id,
          ok: true,
          data: await handlers['eth.switchChain'](request.payload, ctx),
        };
      case 'personal.sign':
        return {
          id: request.id,
          ok: true,
          data: await handlers['personal.sign'](request.payload, ctx),
        };
      case 'eth.rpc':
        return {
          id: request.id,
          ok: true,
          data: await handlers['eth.rpc'](request.payload, ctx),
        };
      case 'eth.signTypedData':
        return {
          id: request.id,
          ok: true,
          data: await handlers['eth.signTypedData'](request.payload, ctx),
        };
      case 'permissions.list':
        return {
          id: request.id,
          ok: true,
          data: await handlers['permissions.list'](request.payload, ctx),
        };
      case 'permissions.grant':
        return {
          id: request.id,
          ok: true,
          data: await handlers['permissions.grant'](request.payload, ctx),
        };
      case 'permissions.revoke':
        return {
          id: request.id,
          ok: true,
          data: await handlers['permissions.revoke'](request.payload, ctx),
        };
      case 'permissions.pending':
        return {
          id: request.id,
          ok: true,
          data: await handlers['permissions.pending'](request.payload, ctx),
        };
      case 'permissions.connection':
        return {
          id: request.id,
          ok: true,
          data: await handlers['permissions.connection'](request.payload, ctx),
        };
      case 'account.exportKey':
        return {
          id: request.id,
          ok: true,
          data: await handlers['account.exportKey'](request.payload, ctx),
        };
      case 'solana.connect':
        return {
          id: request.id,
          ok: true,
          data: await handlers['solana.connect'](request.payload, ctx),
        };
      case 'solana.signTransaction':
        return {
          id: request.id,
          ok: true,
          data: await handlers['solana.signTransaction'](request.payload, ctx),
        };
      case 'solana.signMessage':
        return {
          id: request.id,
          ok: true,
          data: await handlers['solana.signMessage'](request.payload, ctx),
        };
      case 'faucet.request':
        return {
          id: request.id,
          ok: true,
          data: await handlers['faucet.request'](request.payload, ctx),
        };
      case 'wc.pair':
        return {
          id: request.id,
          ok: true,
          data: await handlers['wc.pair'](request.payload, ctx),
        };
      case 'wc.proposal.pending':
        return {
          id: request.id,
          ok: true,
          data: await handlers['wc.proposal.pending'](request.payload, ctx),
        };
      case 'wc.proposal.approve':
        return {
          id: request.id,
          ok: true,
          data: await handlers['wc.proposal.approve'](request.payload, ctx),
        };
      case 'wc.proposal.reject':
        return {
          id: request.id,
          ok: true,
          data: await handlers['wc.proposal.reject'](request.payload, ctx),
        };
      case 'wc.session.list':
        return {
          id: request.id,
          ok: true,
          data: await handlers['wc.session.list'](request.payload, ctx),
        };
      case 'wc.session.disconnect':
        return {
          id: request.id,
          ok: true,
          data: await handlers['wc.session.disconnect'](request.payload, ctx),
        };
      case 'wc.request.pending':
        return {
          id: request.id,
          ok: true,
          data: await handlers['wc.request.pending'](request.payload, ctx),
        };
      case 'wc.request.resolve':
        return {
          id: request.id,
          ok: true,
          data: await handlers['wc.request.resolve'](request.payload, ctx),
        };
      case 'agent.status':
        return {
          id: request.id,
          ok: true,
          data: await handlers['agent.status'](request.payload, ctx),
        };
      case 'agent.configure':
        return {
          id: request.id,
          ok: true,
          data: await handlers['agent.configure'](request.payload, ctx),
        };
      case 'agent.relay.register':
        return {
          id: request.id,
          ok: true,
          data: await handlers['agent.relay.register'](request.payload, ctx),
        };
      case 'agent.relay.pairing-code':
        return {
          id: request.id,
          ok: true,
          data: await handlers['agent.relay.pairing-code'](request.payload, ctx),
        };
      case 'agent.disable':
        return {
          id: request.id,
          ok: true,
          data: await handlers['agent.disable'](request.payload, ctx),
        };
      case 'tx.pending':
        return {
          id: request.id,
          ok: true,
          data: await handlers['tx.pending'](request.payload, ctx),
        };
      case 'tx.resolve':
        return {
          id: request.id,
          ok: true,
          data: await handlers['tx.resolve'](request.payload, ctx),
        };
      case 'x402.pay':
        return {
          id: request.id,
          ok: true,
          data: await handlers['x402.pay'](request.payload, ctx),
        };
      case 'x402.resolve':
        return {
          id: request.id,
          ok: true,
          data: await handlers['x402.resolve'](request.payload, ctx),
        };
      case 'x402.pending':
        return {
          id: request.id,
          ok: true,
          data: await handlers['x402.pending'](request.payload, ctx),
        };
      case 'vap.grants.list':
        return {
          id: request.id,
          ok: true,
          data: await handlers['vap.grants.list'](request.payload, ctx),
        };
      case 'vap.grant.revoke':
        return {
          id: request.id,
          ok: true,
          data: await handlers['vap.grant.revoke'](request.payload, ctx),
        };
      case 'vap.grant.request':
        return {
          id: request.id,
          ok: true,
          data: await handlers['vap.grant.request'](request.payload, ctx),
        };
      case 'vap.grant.resolve':
        return {
          id: request.id,
          ok: true,
          data: await handlers['vap.grant.resolve'](request.payload, ctx),
        };
      case 'vap.grant.pending':
        return {
          id: request.id,
          ok: true,
          data: await handlers['vap.grant.pending'](request.payload, ctx),
        };
      default: {
        const exhaustive: never = request;
        void exhaustive;
        return err(FALLBACK_ID, 'UNKNOWN_KIND', 'Unsupported request kind.');
      }
    }
  } catch (cause) {
    if (cause instanceof ProtocolError) {
      return err(request.id, cause.code, cause.message);
    }
    console.error('[veilpay] handler threw', cause);
    return err(request.id, 'INTERNAL', 'The wallet could not complete that request.');
  }
}

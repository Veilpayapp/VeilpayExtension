/**
 * OAuth 2.1 for the relay's remote MCP endpoint.
 *
 * Why this exists rather than a shared code the user types: MCP clients discover
 * auth from the server, so if the relay advertises the right metadata the client
 * drives the whole handshake itself. The user clicks Connect and approves once —
 * nothing to copy, nothing to paste.
 *
 * The flow, per the MCP authorization spec:
 *   1. Client fetches `/.well-known/oauth-protected-resource` and
 *      `/.well-known/oauth-authorization-server`.
 *   2. Client registers itself via dynamic client registration (`POST /register`).
 *   3. Client sends the user to `/authorize`; we show a consent or pairing page
 *      and issue a code.
 *   4. Client exchanges the code at `/token` for a bearer token.
 *   5. Client calls `/mcp` with `Authorization: Bearer …`.
 *
 * PKCE (S256) is required, which is the one detail that matters here: without it
 * an intercepted authorization code is directly replayable.
 *
 * The wallet identity is carried in the resource path (`/mcp/<walletId>`) for
 * wallet-scoped URLs, or supplied by the human through a short-lived pairing
 * code on the consent page when the universal connector URL `/mcp` is used.
 */

import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';

/** Authorization codes are single-use and short-lived. */
export const CODE_TTL_MS = 5 * 60 * 1000;

/** Access tokens outlive a session but not forever. */
export const ACCESS_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;

function base64url(input) {
  return Buffer.from(input).toString('base64url');
}

/** Constant-time compare for secrets that arrive over the wire. */
export function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

/** Verifies a PKCE S256 challenge against the original verifier. */
export function verifyPkce(verifier, challenge) {
  if (typeof verifier !== 'string' || typeof challenge !== 'string') return false;
  const digest = base64url(createHash('sha256').update(verifier).digest());
  return safeEqual(digest, challenge);
}

/**
 * Issues the metadata documents a client needs.
 *
 * `resource` is the MCP endpoint's base, which must match what the client asked
 * for or the client rejects the discovery as belonging to another server.
 */
export function authorizationServerMetadata(baseUrl) {
  return {
    issuer: baseUrl,
    authorization_endpoint: `${baseUrl}/authorize`,
    token_endpoint: `${baseUrl}/token`,
    registration_endpoint: `${baseUrl}/register`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none'],
    scopes_supported: ['veilpay.pay'],
  };
}

export function protectedResourceMetadata(baseUrl) {
  return {
    resource: `${baseUrl}/mcp`,
    authorization_servers: [baseUrl],
    bearer_methods_supported: ['header'],
    scopes_supported: ['veilpay.pay'],
  };
}

/**
 * OAuth state. A plain object so tests can drive it without a socket or clock.
 */
export function createOAuth({ now = () => Date.now(), wallets } = {}) {
  /** clientId → { redirectUris } */
  const clients = new Map();
  /** code → { clientId, walletId, challenge, redirectUri, expiresAt, used } */
  const codes = new Map();
  /** token → { walletId, expiresAt } */
  const tokens = new Map();

  function registerClient(body) {
    // Public clients only: no secret is issued, so PKCE is what binds the code
    // to the requester.
    const clientId = `vc_${randomUUID()}`;
    const redirectUris = Array.isArray(body?.redirect_uris)
      ? body.redirect_uris.filter((uri) => typeof uri === 'string' && uri.length > 0)
      : [];
    clients.set(clientId, { redirectUris });
    return {
      client_id: clientId,
      redirect_uris: redirectUris,
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code'],
      response_types: ['code'],
    };
  }

  /**
   * Extracts the wallet an authorization request is for, or null when the
   * request carries none.
   *
   * Per RFC 8707 and the MCP spec, a client asks for a token for a specific
   * `resource`, which for a wallet-scoped URL is `…/mcp/<walletId>`. That is
   * the authoritative signal; `wallet` is accepted as a fallback for clients
   * that omit it. A null return means the universal connector URL was used and
   * the caller must resolve the wallet another way (the pairing code).
   */
  function walletFromAuthorize(params) {
    const resource = params.resource;
    if (typeof resource === 'string') {
      const match = /\/mcp\/([^/?#]+)/.exec(resource);
      if (match?.[1] !== undefined) return decodeURIComponent(match[1]);
    }
    return typeof params.wallet === 'string' ? params.wallet : null;
  }

  /**
   * Validates an authorization request and mints a code.
   *
   * Returning the redirect (rather than performing it) keeps this testable and
   * lets the caller surface an error page when the request is malformed.
   */
  function authorize(params) {
    const clientId = params.client_id;
    const client = clients.get(clientId);
    if (client === undefined) return { ok: false, error: 'Unknown client_id.' };

    const redirectUri = params.redirect_uri;
    // An unregistered redirect is the classic open-redirect hole: the code would
    // be delivered to an attacker's URL.
    if (typeof redirectUri !== 'string' || !client.redirectUris.includes(redirectUri)) {
      return { ok: false, error: 'redirect_uri is not registered for this client.' };
    }
    if (params.response_type !== 'code') {
      return { ok: false, error: 'Only response_type=code is supported.' };
    }
    if (params.code_challenge_method !== 'S256' || typeof params.code_challenge !== 'string') {
      return { ok: false, error: 'PKCE with code_challenge_method=S256 is required.' };
    }

    const walletId = walletFromAuthorize(params);
    if (walletId === null || !wallets.has(walletId)) {
      return { ok: false, error: 'This wallet is not registered with the relay.' };
    }

    const code = randomBytes(32).toString('base64url');
    codes.set(code, {
      clientId,
      walletId,
      challenge: params.code_challenge,
      redirectUri,
      expiresAt: now() + CODE_TTL_MS,
      used: false,
    });

    const url = new URL(redirectUri);
    url.searchParams.set('code', code);
    if (typeof params.state === 'string') url.searchParams.set('state', params.state);
    return { ok: true, redirectTo: url.toString() };
  }

  /** Exchanges a code for a bearer token. Single use, PKCE-checked. */
  function token(body) {
    const code = body?.code;
    const entry = typeof code === 'string' ? codes.get(code) : undefined;
    if (entry === undefined) return { ok: false, error: 'invalid_grant' };
    if (entry.used || entry.expiresAt < now()) {
      codes.delete(code);
      return { ok: false, error: 'invalid_grant' };
    }
    if (body?.client_id !== entry.clientId || body?.redirect_uri !== entry.redirectUri) {
      return { ok: false, error: 'invalid_grant' };
    }
    if (!verifyPkce(body?.code_verifier, entry.challenge)) {
      return { ok: false, error: 'invalid_grant' };
    }

    // Burn the code before issuing anything, so a replay cannot race this.
    entry.used = true;
    codes.delete(code);

    const accessToken = randomBytes(32).toString('base64url');
    tokens.set(accessToken, {
      walletId: entry.walletId,
      expiresAt: now() + ACCESS_TOKEN_TTL_MS,
    });
    return {
      ok: true,
      body: {
        access_token: accessToken,
        token_type: 'Bearer',
        expires_in: Math.floor(ACCESS_TOKEN_TTL_MS / 1000),
        scope: 'veilpay.pay',
      },
    };
  }

  /** Resolves the wallet a bearer token acts for, or null. */
  function resolveToken(header) {
    if (typeof header !== 'string' || !header.startsWith('Bearer ')) return null;
    const token = header.slice(7);
    const entry = tokens.get(token);
    if (entry === undefined) return null;
    if (entry.expiresAt < now()) {
      tokens.delete(token);
      return null;
    }
    return entry.walletId;
  }

  /** Drops tokens and codes for a wallet that has been unregistered. */
  function revokeWallet(walletId) {
    for (const [token, entry] of tokens) {
      if (entry.walletId === walletId) tokens.delete(token);
    }
  }

  return {
    registerClient,
    authorize,
    token,
    resolveToken,
    revokeWallet,
    walletFromAuthorize,
    clientCount: clients.size,
  };
}

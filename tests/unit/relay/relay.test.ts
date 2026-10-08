import { afterAll, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { startRelay, createRelay } from '../../../relay/server.mjs';
import { verifyPkce } from '../../../relay/oauth.mjs';

/**
 * These drive the real OAuth handshake against a live server on an ephemeral
 * port, because the parts most likely to break only exist over HTTP: discovery
 * metadata, redirect validation, and the PKCE exchange.
 */

const servers: { close: (cb?: () => void) => void }[] = [];

async function bootRelay(relay = createRelay({ longPollMs: 50 })) {
  // A short long-poll keeps the suite fast; production holds the socket open.
  const { server, port } = await startRelay(0, relay);
  servers.push(server);
  return { base: `http://127.0.0.1:${port}`, relay };
}

afterAll(async () => {
  await Promise.all(
    servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve())))
  );
});

/** A fixed PKCE pair; the verifier only has to be long enough to be valid. */
function pkce() {
  const verifier = 'a'.repeat(43);
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

interface Registered {
  client_id: string;
}

async function registerClient(base: string): Promise<Registered> {
  const response = await fetch(`${base}/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ redirect_uris: ['https://client.example/callback'] }),
  });
  return (await response.json()) as Registered;
}

function authorizeParams(clientId: string, walletId: string, challenge: string): URLSearchParams {
  return new URLSearchParams({
    client_id: clientId,
    redirect_uri: 'https://client.example/callback',
    response_type: 'code',
    code_challenge: challenge,
    code_challenge_method: 'S256',
    wallet: walletId,
    state: 'xyz',
  });
}

describe('PKCE', () => {
  it('accepts the matching verifier and rejects any other', () => {
    const { verifier, challenge } = pkce();
    expect(verifyPkce(verifier, challenge)).toBe(true);
    expect(verifyPkce('b'.repeat(43), challenge)).toBe(false);
    expect(verifyPkce(undefined, challenge)).toBe(false);
    expect(verifyPkce(verifier, undefined)).toBe(false);
  });
});

describe('pairing codes', () => {
  it('returns a pairing code when registering a wallet', () => {
    const relay = createRelay();
    const registration = relay.registerWallet();

    expect(registration.walletId).toBeTruthy();
    expect(registration.secret).toBeTruthy();
    expect(registration.pairing.code).toMatch(/^[0-9A-Z]{4}-[0-9A-Z]{4}$/);
    expect(registration.pairing.expiresAt).toBeGreaterThan(Date.now());
    relay.stop();
  });

  it('keeps one live code and replaces it after expiry', () => {
    let now = 1_000_000;
    const relay = createRelay({ now: () => now });
    const { walletId } = relay.registerWallet();

    const first = relay.issuePairingCode(walletId);
    expect(relay.issuePairingCode(walletId)).toEqual(first);

    now += 15 * 60 * 1000 + 1;
    const second = relay.issuePairingCode(walletId);
    expect(second.code).not.toBe(first.code);
    // Expiry must invalidate the code that was displayed before the refresh.
    expect(relay.consumePairingCode(first.code)).toBeNull();
    relay.stop();
  });

  it('distinguishes an expired code from one this relay never issued', () => {
    let now = 1_000_000;
    const relay = createRelay({ now: () => now });
    const { walletId } = relay.registerWallet();
    const { code } = relay.issuePairingCode(walletId);

    expect(relay.pairingCodeStatus(code)).toMatchObject({ status: 'valid', walletId });
    expect(relay.pairingCodeStatus('NEVR-1SSU')).toMatchObject({ status: 'unknown' });

    now += 15 * 60 * 1000 + 1;
    // "Expired" and "unknown" must stay distinguishable: the error page uses
    // them to tell a slow user apart from a client pointed at the wrong relay.
    expect(relay.pairingCodeStatus(code)).toMatchObject({ status: 'expired' });
    relay.stop();
  });

  it('consumes codes once and accepts human-friendly formatting', () => {
    const relay = createRelay();
    const { walletId } = relay.registerWallet();
    const { code } = relay.issuePairingCode(walletId);
    const typed = code.toLowerCase().replace('-', ' ');

    expect(relay.consumePairingCode(typed)).toBe(walletId);
    // A pairing code is a one-time trust gesture, not a reusable password.
    expect(relay.consumePairingCode(code)).toBeNull();
    expect(relay.consumePairingCode('never-issued')).toBeNull();
    relay.stop();
  });
});

describe('OAuth discovery', () => {
  it('advertises the endpoints an MCP client needs', async () => {
    const { base } = await bootRelay();

    const as = (await (await fetch(`${base}/.well-known/oauth-authorization-server`)).json()) as {
      authorization_endpoint: string;
      token_endpoint: string;
      code_challenge_methods_supported: string[];
    };
    expect(as.authorization_endpoint).toContain('/authorize');
    expect(as.token_endpoint).toContain('/token');
    // Without S256 advertised the client cannot satisfy the PKCE requirement.
    expect(as.code_challenge_methods_supported).toContain('S256');

    const pr = (await (await fetch(`${base}/.well-known/oauth-protected-resource`)).json()) as {
      resource: string;
      authorization_servers: string[];
    };
    expect(pr.resource).toContain('/mcp');
    expect(pr.authorization_servers).toHaveLength(1);
  });

  it('points an unauthenticated MCP call at the metadata document', async () => {
    const { base, relay } = await bootRelay();
    const { walletId } = relay.registerWallet();

    const response = await fetch(`${base}/mcp/${walletId}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });

    expect(response.status).toBe(401);
    // This header is what makes the client start OAuth instead of giving up.
    expect(response.headers.get('www-authenticate')).toContain('resource_metadata');
  });
});

describe('universal connector URL', () => {
  it('shows a pairing page when no wallet or resource is supplied', async () => {
    const { base } = await bootRelay();
    const response = await fetch(`${base}/authorize`);

    expect(response.status).toBe(200);
    const page = await response.text();
    expect(page).toContain('pairing code');
    expect(page).toContain('name="pairing_code"');
  });

  it('uses the resource path to identify a wallet', async () => {
    const { base, relay } = await bootRelay();
    const { walletId } = relay.registerWallet();
    const { challenge } = pkce();
    const client = await registerClient(base);
    const params = authorizeParams(client.client_id, walletId, challenge);
    params.delete('wallet');
    params.set('resource', `${base}/mcp/${walletId}`);

    const response = await fetch(`${base}/authorize?${params}`);
    expect(response.status).toBe(200);
    const page = await response.text();
    // RFC 8707 resource is authoritative even when the legacy wallet param is absent.
    expect(page).toContain('Connect your Veilpay wallet');
    expect(page).not.toContain('Wallet not connected');
  });

  it('completes the universal pairing flow through /mcp', async () => {
    const { base, relay } = await bootRelay();
    const { pairing } = relay.registerWallet();
    const { verifier, challenge } = pkce();
    const client = await registerClient(base);
    const params = authorizeParams(client.client_id, 'unused', challenge);
    params.delete('wallet');

    const approval = await fetch(`${base}/authorize/approve?${params}`, {
      method: 'POST',
      redirect: 'manual',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ pairing_code: pairing.code }),
    });
    expect(approval.status).toBe(302);
    const code = new URL(approval.headers.get('location') ?? '').searchParams.get('code');

    const tokenResponse = await fetch(`${base}/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        code,
        client_id: client.client_id,
        redirect_uri: 'https://client.example/callback',
        code_verifier: verifier,
      }),
    });
    expect(tokenResponse.status).toBe(200);
    const token = (await tokenResponse.json()) as { access_token: string };

    const mcp = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${token.access_token}`,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    expect(mcp.status).toBe(200);
    const listed = (await mcp.json()) as { result: { tools: unknown[] } };
    expect(listed.result.tools).toHaveLength(6);
  });

  it('does not burn a valid pairing code when OAuth validation fails', async () => {
    const { base, relay } = await bootRelay();
    const { pairing, walletId } = relay.registerWallet();
    const client = await registerClient(base);
    const params = new URLSearchParams({
      client_id: client.client_id,
      redirect_uri: 'https://client.example/callback',
      response_type: 'code',
      // Deliberately omit code_challenge: the client can retry with the same
      // pairing code after it completes its PKCE setup.
    });
    params.delete('wallet');

    const invalid = await fetch(`${base}/authorize/approve?${params}`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ pairing_code: pairing.code }),
    });
    expect(invalid.status).toBe(400);

    const resolved = relay.resolvePairingCode(pairing.code);
    expect(resolved?.walletId).toBe(walletId);
  });

  it('rejects an invalid pairing code without a wallet parameter', async () => {
    const { base } = await bootRelay();
    const { challenge } = pkce();
    const client = await registerClient(base);
    const params = authorizeParams(client.client_id, 'unused', challenge);
    params.delete('wallet');

    const response = await fetch(`${base}/authorize/approve?${params}`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ pairing_code: 'NOPE-0000' }),
    });
    expect(response.status).toBe(400);
    const page = await response.text();
    // The page must name both real causes (a restart wiped the code, or the
    // client points elsewhere) and end with the action that fixes either:
    // re-copy whatever the extension shows now.
    expect(page).toContain('does not recognize that code');
    expect(page).toContain('restarted');
    expect(page).toContain('copy the code shown now');
  });

  it('tells a slow user the code expired, distinctly from an unknown one', async () => {
    let now = 1_000_000;
    const relay = createRelay({ now: () => now, longPollMs: 50 });
    const { base } = await bootRelay(relay);
    const { pairing } = relay.registerWallet();
    const { challenge } = pkce();
    const client = await registerClient(base);
    const params = authorizeParams(client.client_id, 'unused', challenge);
    params.delete('wallet');

    now += 15 * 60 * 1000 + 1;
    const response = await fetch(`${base}/authorize/approve?${params}`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ pairing_code: pairing.code }),
    });
    expect(response.status).toBe(400);
    const page = await response.text();
    expect(page).toContain('expired');
    expect(page).toContain('copy a fresh code');
  });

  it('never serves form-action, which aborts the OAuth redirect in browsers', async () => {
    // A form-action CSP on the pairing/consent page makes the browser abort
    // the redirect to the AI client's callback AFTER the relay consumed the
    // pairing code — leaving the user with "does not recognize that code" on
    // every retry. The form posts to a server-generated same-origin action, so
    // the directive adds nothing; it must simply never appear.
    const { base } = await bootRelay();
    const response = await fetch(`${base}/authorize`);
    const csp = response.headers.get('content-security-policy') ?? '';
    expect(csp).not.toContain('form-action');
    // The rest of the page hardening stays intact.
    expect(csp).toContain("default-src 'none'");
    expect(response.headers.get('x-frame-options')).toBe('DENY');
  });
});

describe('relay pairing-code endpoint', () => {
  it('requires the wallet secret and returns a live code', async () => {
    const { base, relay } = await bootRelay();
    const { walletId, secret } = relay.registerWallet();

    const response = await fetch(`${base}/wallet/pairing-code`, {
      method: 'POST',
      headers: { 'x-veilpay-wallet': walletId, 'x-veilpay-secret': secret },
    });
    expect(response.status).toBe(200);
    const result = (await response.json()) as { ok: boolean; code: string; expiresAt: number };
    expect(result.ok).toBe(true);
    expect(result.code).toMatch(/^[0-9A-Z]{4}-[0-9A-Z]{4}$/);
    expect(result.expiresAt).toBeGreaterThan(Date.now());

    const wrongSecret = await fetch(`${base}/wallet/pairing-code`, {
      method: 'POST',
      headers: { 'x-veilpay-wallet': walletId, 'x-veilpay-secret': 'wrong' },
    });
    expect(wrongSecret.status).toBe(401);
    // Pairing refresh must not become an unauthenticated wallet lookup.
    expect((await fetch(`${base}/wallet/pairing-code`, { method: 'POST' })).status).toBe(401);
  });
});

describe('wallet-scoped MCP paths', () => {
  it('does not let a wallet token cross wallet paths', async () => {
    const { base, relay } = await bootRelay();
    const { walletId: walletA } = relay.registerWallet();
    const { walletId: walletB } = relay.registerWallet();
    const { verifier, challenge } = pkce();
    const client = await registerClient(base);
    const params = authorizeParams(client.client_id, walletA, challenge);
    const approval = await fetch(`${base}/authorize/approve?${params}`, {
      method: 'POST',
      redirect: 'manual',
    });
    const code = new URL(approval.headers.get('location') ?? '').searchParams.get('code');
    const tokenResponse = await fetch(`${base}/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        code,
        client_id: client.client_id,
        redirect_uri: 'https://client.example/callback',
        code_verifier: verifier,
      }),
    });
    const token = (await tokenResponse.json()) as { access_token: string };
    const headers = {
      'content-type': 'application/json',
      authorization: `Bearer ${token.access_token}`,
    };
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' });

    expect((await fetch(`${base}/mcp/${walletB}`, { method: 'POST', headers, body })).status).toBe(
      401
    );
    // The same token remains valid on the wallet it was minted for.
    expect((await fetch(`${base}/mcp/${walletA}`, { method: 'POST', headers, body })).status).toBe(
      200
    );
  });
});

describe('OAuth authorization code flow', () => {
  it('issues a token through the full handshake', async () => {
    const { base, relay } = await bootRelay();
    const { walletId } = relay.registerWallet();
    const { verifier, challenge } = pkce();
    const client = await registerClient(base);
    const params = authorizeParams(client.client_id, walletId, challenge);

    // The consent page is what the user sees, so it must be a real page.
    const consent = await fetch(`${base}/authorize?${params}`);
    expect(consent.status).toBe(200);
    expect(consent.headers.get('content-type')).toContain('text/html');
    expect(await consent.text()).toContain('Connect your Veilpay wallet');

    const approval = await fetch(`${base}/authorize/approve?${params}`, {
      method: 'POST',
      redirect: 'manual',
    });
    expect(approval.status).toBe(302);
    const location = new URL(approval.headers.get('location') ?? '');
    expect(location.searchParams.get('state')).toBe('xyz');
    const code = location.searchParams.get('code');
    expect(code).toBeTruthy();

    const tokenResponse = await fetch(`${base}/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'authorization_code',
        code,
        client_id: client.client_id,
        redirect_uri: 'https://client.example/callback',
        code_verifier: verifier,
      }),
    });
    expect(tokenResponse.status).toBe(200);
    const token = (await tokenResponse.json()) as { access_token: string; token_type: string };
    expect(token.token_type).toBe('Bearer');

    // The token must actually work against the MCP endpoint, or the whole
    // handshake was theatre.
    const mcp = await fetch(`${base}/mcp/${walletId}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${token.access_token}`,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }),
    });
    expect(mcp.status).toBe(200);
    const listed = (await mcp.json()) as { result: { tools: unknown[] } };
    expect(listed.result.tools).toHaveLength(6);
  });

  it('refuses a redirect_uri that was never registered', async () => {
    const { base, relay } = await bootRelay();
    const { walletId } = relay.registerWallet();
    const { challenge } = pkce();
    const client = await registerClient(base);

    const params = authorizeParams(client.client_id, walletId, challenge);
    // An attacker's URL: honouring it would deliver the code straight to them.
    params.set('redirect_uri', 'https://evil.example/steal');

    const approval = await fetch(`${base}/authorize/approve?${params}`, {
      method: 'POST',
      redirect: 'manual',
    });
    expect(approval.status).toBe(400);
  });

  it('burns an authorization code after one use', async () => {
    const { base, relay } = await bootRelay();
    const { walletId } = relay.registerWallet();
    const { verifier, challenge } = pkce();
    const client = await registerClient(base);
    const params = authorizeParams(client.client_id, walletId, challenge);

    const approval = await fetch(`${base}/authorize/approve?${params}`, {
      method: 'POST',
      redirect: 'manual',
    });
    const code = new URL(approval.headers.get('location') ?? '').searchParams.get('code');

    const exchange = () =>
      fetch(`${base}/token`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          grant_type: 'authorization_code',
          code,
          client_id: client.client_id,
          redirect_uri: 'https://client.example/callback',
          code_verifier: verifier,
        }),
      });

    expect((await exchange()).status).toBe(200);
    // A replay must fail, or an intercepted code is a usable credential.
    expect((await exchange()).status).toBe(400);
  });

  it('rejects an exchange with the wrong PKCE verifier', async () => {
    const { base, relay } = await bootRelay();
    const { walletId } = relay.registerWallet();
    const { challenge } = pkce();
    const client = await registerClient(base);
    const params = authorizeParams(client.client_id, walletId, challenge);

    const approval = await fetch(`${base}/authorize/approve?${params}`, {
      method: 'POST',
      redirect: 'manual',
    });
    const code = new URL(approval.headers.get('location') ?? '').searchParams.get('code');

    const response = await fetch(`${base}/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'authorization_code',
        code,
        client_id: client.client_id,
        redirect_uri: 'https://client.example/callback',
        code_verifier: 'wrong'.padEnd(43, 'z'),
      }),
    });
    expect(response.status).toBe(400);
  });

  it('shows an expired link rather than a consent form for an unknown wallet', async () => {
    const { base } = await bootRelay();
    const response = await fetch(`${base}/authorize?wallet=does-not-exist`);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('Wallet not connected');
  });

  it('escapes the wallet id so the consent page cannot be injected into', async () => {
    const { base } = await bootRelay();
    const response = await fetch(
      `${base}/authorize?wallet=${encodeURIComponent('<img src=x onerror=alert(1)>')}`
    );
    const page = await response.text();
    // An unknown wallet renders the error page, which must still be escaped.
    expect(page).not.toContain('<img src=x');
  });
});

describe('relay wallet transport', () => {
  it('refuses a poll with no credentials at all', async () => {
    const { base } = await bootRelay();
    expect((await fetch(`${base}/next`)).status).toBe(401);
  });

  it('rejects a wrong secret', async () => {
    const { base, relay } = await bootRelay();
    const { walletId } = relay.registerWallet();

    const response = await fetch(`${base}/next`, {
      headers: { 'x-veilpay-wallet': walletId, 'x-veilpay-secret': 'nope' },
    });
    expect(response.status).toBe(401);
  });

  it('answers an authenticated poll with 204 once its long-poll elapses', async () => {
    const { base, relay } = await bootRelay();
    const { walletId, secret } = relay.registerWallet();

    const polled = await fetch(`${base}/next`, {
      headers: { 'x-veilpay-wallet': walletId, 'x-veilpay-secret': secret },
    });
    expect(polled.status).toBe(204);
  });
});

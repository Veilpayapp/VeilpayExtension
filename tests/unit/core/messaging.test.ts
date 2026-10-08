import { describe, expect, it, vi } from 'vitest';
import { dispatch, ProtocolError, type HandlerMap } from '@/core/messaging/router';
import { newId } from '@/core/messaging/protocol';

const sender = {} as chrome.runtime.MessageSender;

/**
 * An extension surface: extension origin, and no tab, because only a content
 * script gets a tab stamped on its sender. `veilpay-test` is the runtime id the
 * chrome stub in tests/setup.ts reports.
 */
const uiSender = {
  origin: 'chrome-extension://veilpay-test',
  url: 'chrome-extension://veilpay-test/popup.html',
} as chrome.runtime.MessageSender;

/** A content script running in a page. Chrome always stamps the tab. */
const pageSender = {
  origin: 'https://evil.example',
  url: 'https://evil.example/',
  tab: { id: 7 } as chrome.tabs.Tab,
} as chrome.runtime.MessageSender;

function handlers(overrides: Partial<HandlerMap> = {}): HandlerMap {
  return {
    ping: async (payload) => ({
      sentAt: payload.sentAt,
      receivedAt: 1_000,
      roundTripHint: 1_000 - payload.sentAt,
    }),
    'vault.status': async () => ({ state: 'locked' as const, unlockedUntil: null }),
    'session.lock': async () => ({ state: 'locked' as const }),
    'zk.capability': async () => null,
    'accounts.list': async () => [],
    'account.balance': async () => ({ chain: 'evm', address: '', balance: '0' }),
    'tx.estimate': async () => ({
      chain: 'evm',
      from: '0x0000000000000000000000000000000000000000',
      feeNative: '0',
      gasLimit: '21000',
      decimals: 18,
      spendableBalance: '0',
      symbol: 'ETH',
    }),
    'tx.transfer': async () => ({
      chain: 'evm',
      from: '0x0000000000000000000000000000000000000000',
      to: '0x0000000000000000000000000000000000000001',
      amountNative: '0',
      hash: '0x0000',
      decimals: 18,
    }),
    'security.status': async () => ({ pinEnabled: false, webauthnEnabled: false }),
    'security.pin.setup': async () => ({ ok: true }),
    'security.pin.verify': async () => ({ ok: true }),
    'security.webauthn.setup': async () => ({ ok: true }),
    'security.webauthn.challenge': async () => ({ credentialId: 'cred-1', challenge: '0a' }),
    'eth.chainId': async () => ({ chainId: '0xaa36a7' }),
    'eth.requestAccounts': async () => ({ accounts: [] }),
    'eth.accounts': async () => ({ accounts: [] }),
    'eth.sendTransaction': async () => ({ hash: '0x0' }),
    'eth.switchChain': async () => ({ chainId: '0xaa36a7' }),
    'personal.sign': async () => ({ signature: '0x0' }),
    'eth.rpc': async () => ({ result: '0x1' }),
    'eth.signTypedData': async () => ({ signature: '0x0' }),
    'permissions.list': async () => [],
    'permissions.grant': async () => ({ ok: true }),
    'permissions.revoke': async () => ({ ok: true }),
    'permissions.pending': async () => null,
    'permissions.connection': async () => ({ ok: true }),
    'tx.pending': async () => null,
    'tx.resolve': async () => ({ ok: true }),
    'faucet.request': async () => ({ ok: true, txHash: 'hash' }),
    'indexer.history': async () => ({
      transactions: [],
      nextCursor: null,
      source: 'cache' as const,
    }),
    'x402.pay': async () => ({ paymentHeader: 'dGVzdA==' }),
    'x402.resolve': async () => ({ ok: true }),
    'x402.pending': async () => null,
    'vap.grants.list': async () => [],
    'vap.grant.revoke': async () => ({ ok: true }),
    'vap.grant.request': async () => ({ grantId: 'grant-1' }),
    'vap.grant.resolve': async () => ({ ok: true }),
    'vap.grant.pending': async () => null,
    'account.exportKey': async () => ({
      privateKey: '0x00',
      address: '0x0000000000000000000000000000000000000000',
    }),
    'solana.connect': async () => ({ publicKey: '11111111111111111111111111111111' }),
    'solana.signTransaction': async () => ({ signature: 'sig', signedTransaction: 'tx' }),
    'solana.signMessage': async () => ({
      signature: 'sig',
      publicKey: '11111111111111111111111111111111',
    }),
    'wc.pair': async () => ({ ok: true }),
    'wc.proposal.pending': async () => null,
    'wc.proposal.approve': async () => ({ ok: true }),
    'wc.proposal.reject': async () => ({ ok: true }),
    'wc.session.list': async () => [],
    'wc.session.disconnect': async () => ({ ok: true }),
    'wc.request.pending': async () => null,
    'wc.request.resolve': async () => ({ ok: true }),
    'agent.status': async () => ({
      enabled: false,
      mode: null,
      endpoint: null,
      paired: false,
      connected: false,
      lastPollAt: null,
    }),
    'agent.configure': async () => ({ ok: true }),
    'agent.relay.register': async () => ({
      mcpUrl: 'https://relay.example/mcp',
      walletId: 'wallet-1',
      pairingCode: 'ABCD-2F9G',
      pairingCodeExpiresAt: 10_000,
    }),
    'agent.relay.pairing-code': async () => ({
      pairingCode: 'ABCD-2F9G',
      pairingCodeExpiresAt: 10_000,
    }),
    'agent.disable': async () => ({ ok: true }),
    'vault.create': async () => ({ state: 'unlocked' as const }),
    'vault.unlock': async () => ({ state: 'unlocked' as const, unlockedUntil: 1_000 }),
    'vault.reset': async () => ({ state: 'uninitialized' as const }),
    'mnemonic.generate': async () => ({ mnemonic: 'word '.repeat(11) + 'word' }),
    ...overrides,
  };
}

describe('message dispatch', () => {
  it('round-trips a valid ping', async () => {
    const response = await dispatch(
      { id: newId(), v: 1, source: 'popup', kind: 'ping', payload: { sentAt: 400 } },
      sender,
      handlers()
    );

    expect(response.ok).toBe(true);
    if (response.ok) {
      expect(response.data).toEqual({ sentAt: 400, receivedAt: 1_000, roundTripHint: 600 });
    }
  });

  it('preserves the request id so callers can correlate', async () => {
    const id = newId();
    const response = await dispatch(
      { id, v: 1, source: 'popup', kind: 'ping', payload: { sentAt: 0 } },
      sender,
      handlers()
    );

    expect(response.id).toBe(id);
  });

  it('rejects a malformed envelope before any handler runs', async () => {
    const ping = vi.fn();
    const response = await dispatch(
      { id: 'not-a-uuid', v: 1, source: 'popup', kind: 'ping', payload: {} },
      sender,
      handlers({ ping: ping as unknown as HandlerMap['ping'] })
    );

    expect(response.ok).toBe(false);
    if (!response.ok) expect(response.error.code).toBe('BAD_REQUEST');
    expect(ping).not.toHaveBeenCalled();
  });

  it('rejects an unknown kind', async () => {
    const response = await dispatch(
      { id: newId(), v: 1, source: 'popup', kind: 'vault.export', payload: {} },
      sender,
      handlers()
    );

    expect(response.ok).toBe(false);
    if (!response.ok) expect(response.error.code).toBe('BAD_REQUEST');
  });

  it('rejects an unsupported protocol version', async () => {
    const response = await dispatch(
      { id: newId(), v: 2, source: 'popup', kind: 'ping', payload: { sentAt: 0 } },
      sender,
      handlers()
    );

    expect(response.ok).toBe(false);
  });

  it('surfaces a ProtocolError code from a handler', async () => {
    const response = await dispatch(
      { id: newId(), v: 1, source: 'popup', kind: 'vault.status', payload: {} },
      sender,
      handlers({
        'vault.status': async () => {
          throw new ProtocolError('VAULT_LOCKED', 'The wallet is locked.');
        },
      })
    );

    expect(response.ok).toBe(false);
    if (!response.ok) {
      expect(response.error.code).toBe('VAULT_LOCKED');
      expect(response.error.message).toBe('The wallet is locked.');
    }
  });

  it('flattens an unexpected throw so no internals leak to the caller', async () => {
    const secret = 'mnemonic: abandon abandon abandon';
    const response = await dispatch(
      { id: newId(), v: 1, source: 'inpage', kind: 'vault.status', payload: {} },
      sender,
      handlers({
        'vault.status': async () => {
          throw new Error(secret);
        },
      })
    );

    expect(response.ok).toBe(false);
    if (!response.ok) {
      expect(response.error.code).toBe('INTERNAL');
      expect(response.error.message).not.toContain('mnemonic');
      expect(response.error.message).not.toContain('abandon');
    }
  });

  it('derives origin from the Chrome sender rather than the payload', async () => {
    const seen: Array<string | null> = [];
    await dispatch(
      {
        id: newId(),
        v: 1,
        source: 'inpage',
        kind: 'vault.status',
        payload: {},
      },
      { origin: 'https://real.example' } as chrome.runtime.MessageSender,
      handlers({
        'vault.status': async (_payload, ctx) => {
          seen.push(ctx.origin);
          return { state: 'locked' as const, unlockedUntil: null };
        },
      })
    );

    expect(seen).toEqual(['https://real.example']);
  });
});

/**
 * These are the tests that make `PRIVILEGED_KINDS` a control rather than a
 * comment. The threat is a compromised content script: it can put any string it
 * likes in `source`, so authorisation has to come from the sender fields Chrome
 * fills in, which a page cannot influence.
 */
describe('privileged kind enforcement', () => {
  it('allows a privileged kind from an extension surface', async () => {
    const response = await dispatch(
      {
        id: newId(),
        v: 1,
        source: 'popup',
        kind: 'vault.unlock',
        payload: { passphrase: 'correct horse battery staple' },
      },
      uiSender,
      handlers()
    );

    expect(response.ok).toBe(true);
  });

  it('denies a privileged kind from a content script that forges its source', async () => {
    const unlock = vi.fn();
    const response = await dispatch(
      {
        id: newId(),
        v: 1,
        source: 'popup', // the lie
        kind: 'vault.unlock',
        payload: { passphrase: 'correct horse battery staple' },
      },
      pageSender, // the truth
      handlers({ 'vault.unlock': unlock as unknown as HandlerMap['vault.unlock'] })
    );

    expect(response.ok).toBe(false);
    if (!response.ok) expect(response.error.code).toBe('ORIGIN_DENIED');
    expect(unlock).not.toHaveBeenCalled();
  });

  it('denies a destructive reset from a page', async () => {
    const reset = vi.fn();
    const response = await dispatch(
      {
        id: newId(),
        v: 1,
        source: 'options',
        kind: 'vault.reset',
        payload: { confirmation: 'DELETE' },
      },
      pageSender,
      handlers({ 'vault.reset': reset as unknown as HandlerMap['vault.reset'] })
    );

    expect(response.ok).toBe(false);
    if (!response.ok) expect(response.error.code).toBe('ORIGIN_DENIED');
    expect(reset).not.toHaveBeenCalled();
  });

  it('denies a privileged kind whose declared source is not a UI surface', async () => {
    // Extension origin, no tab — but `inpage` is not an authorised surface, so
    // the source check still rejects it.
    const response = await dispatch(
      {
        id: newId(),
        v: 1,
        source: 'inpage',
        kind: 'mnemonic.generate',
        payload: { strength: 256 },
      },
      uiSender,
      handlers()
    );

    expect(response.ok).toBe(false);
    if (!response.ok) expect(response.error.code).toBe('ORIGIN_DENIED');
  });

  it('denies a privileged kind from the offscreen document', async () => {
    // The offscreen document runs the ZK probe. It has extension origin but no
    // business touching the vault.
    const response = await dispatch(
      {
        id: newId(),
        v: 1,
        source: 'offscreen',
        kind: 'vault.reset',
        payload: { confirmation: 'DELETE' },
      },
      uiSender,
      handlers()
    );

    expect(response.ok).toBe(false);
    if (!response.ok) expect(response.error.code).toBe('ORIGIN_DENIED');
  });

  it('denies a transfer from a page, so a compromised page cannot move funds', async () => {
    const transfer = vi.fn();
    const response = await dispatch(
      {
        id: newId(),
        v: 1,
        source: 'popup', // forged
        kind: 'tx.transfer',
        payload: {
          chain: 'evm',
          index: 0,
          to: '0x0000000000000000000000000000000000000001',
          amount: '1',
        },
      },
      pageSender,
      handlers({ 'tx.transfer': transfer as unknown as HandlerMap['tx.transfer'] })
    );

    expect(response.ok).toBe(false);
    if (!response.ok) expect(response.error.code).toBe('ORIGIN_DENIED');
    expect(transfer).not.toHaveBeenCalled();
  });

  it('denies a privileged kind when the sender carries no origin at all', async () => {
    const response = await dispatch(
      {
        id: newId(),
        v: 1,
        source: 'popup',
        kind: 'vault.unlock',
        payload: { passphrase: 'correct horse battery staple' },
      },
      sender, // bare {}, as an unidentifiable caller would be
      handlers()
    );

    expect(response.ok).toBe(false);
    if (!response.ok) expect(response.error.code).toBe('ORIGIN_DENIED');
  });

  it('still allows an unprivileged kind from a content script', async () => {
    const response = await dispatch(
      { id: newId(), v: 1, source: 'content', kind: 'vault.status', payload: {} },
      pageSender,
      handlers()
    );

    expect(response.ok).toBe(true);
  });

  it('rejects a reset whose confirmation literal is wrong', async () => {
    const reset = vi.fn();
    const response = await dispatch(
      {
        id: newId(),
        v: 1,
        source: 'options',
        kind: 'vault.reset',
        payload: { confirmation: 'delete' }, // lowercase
      },
      uiSender,
      handlers({ 'vault.reset': reset as unknown as HandlerMap['vault.reset'] })
    );

    expect(response.ok).toBe(false);
    if (!response.ok) expect(response.error.code).toBe('BAD_REQUEST');
    expect(reset).not.toHaveBeenCalled();
  });

  it('rejects a mnemonic strength outside the allowed set', async () => {
    const response = await dispatch(
      {
        id: newId(),
        v: 1,
        source: 'popup',
        kind: 'mnemonic.generate',
        payload: { strength: 192 },
      },
      uiSender,
      handlers()
    );

    expect(response.ok).toBe(false);
    if (!response.ok) expect(response.error.code).toBe('BAD_REQUEST');
  });

  it('denies account.exportKey from a compromised content script', async () => {
    // The raw private key is the single most sensitive kind on the bus. It must
    // NOT be reachable from a content script that forges `source`.
    const exportKey = vi.fn();
    const response = await dispatch(
      {
        id: newId(),
        v: 1,
        source: 'popup', // forged
        kind: 'account.exportKey',
        payload: { chain: 'evm', index: 0 },
      },
      pageSender,
      handlers({ 'account.exportKey': exportKey as unknown as HandlerMap['account.exportKey'] })
    );

    expect(response.ok).toBe(false);
    if (!response.ok) expect(response.error.code).toBe('ORIGIN_DENIED');
    expect(exportKey).not.toHaveBeenCalled();
  });

  it('denies account.exportKey from the offscreen document', async () => {
    // Offscreen shares our origin and has no tab, but must never hold a private key.
    const response = await dispatch(
      {
        id: newId(),
        v: 1,
        source: 'offscreen',
        kind: 'account.exportKey',
        payload: { chain: 'evm', index: 0 },
      },
      uiSender,
      handlers()
    );

    expect(response.ok).toBe(false);
    if (!response.ok) expect(response.error.code).toBe('ORIGIN_DENIED');
  });

  it('denies permissions.grant from a compromised content script', async () => {
    // A page must not be able to grant itself (or any origin) standing wallet access.
    const grant = vi.fn();
    const response = await dispatch(
      {
        id: newId(),
        v: 1,
        source: 'content',
        kind: 'permissions.grant',
        payload: { origin: 'https://evil.example', addresses: ['0xabc'] },
      },
      pageSender,
      handlers({ 'permissions.grant': grant as unknown as HandlerMap['permissions.grant'] })
    );

    expect(response.ok).toBe(false);
    if (!response.ok) expect(response.error.code).toBe('ORIGIN_DENIED');
    expect(grant).not.toHaveBeenCalled();
  });

  it('denies permissions.connection resolution from a compromised content script', async () => {
    // Resolving a pending connection persists a grant on approve, so it is a
    // privileged mutation a page must not be able to drive.
    const resolve = vi.fn();
    const response = await dispatch(
      {
        id: newId(),
        v: 1,
        source: 'content',
        kind: 'permissions.connection',
        payload: { origin: 'https://evil.example', addresses: ['0xabc'], action: 'approve' },
      },
      pageSender,
      handlers({
        'permissions.connection': resolve as unknown as HandlerMap['permissions.connection'],
      })
    );

    expect(response.ok).toBe(false);
    if (!response.ok) expect(response.error.code).toBe('ORIGIN_DENIED');
    expect(resolve).not.toHaveBeenCalled();
  });

  it('still allows reading the pending connection from a content script', async () => {
    // Reading the pending request reveals only the requesting origin and
    // addresses — no key material. It is not privileged.
    const response = await dispatch(
      { id: newId(), v: 1, source: 'content', kind: 'permissions.pending', payload: {} },
      pageSender,
      handlers()
    );

    expect(response.ok).toBe(true);
  });

  it('denies account.exportKey from a compromised content script', async () => {
    // Enumerating the wallet's full address set leaks which addresses are held.
    const list = vi.fn();
    const response = await dispatch(
      {
        id: newId(),
        v: 1,
        source: 'content',
        kind: 'accounts.list',
        payload: { accountIndex: 0 },
      },
      pageSender,
      handlers({ 'accounts.list': list as unknown as HandlerMap['accounts.list'] })
    );

    expect(response.ok).toBe(false);
    if (!response.ok) expect(response.error.code).toBe('ORIGIN_DENIED');
    expect(list).not.toHaveBeenCalled();
  });

  it('denies vap.grant.resolve from a compromised content script', async () => {
    // Resolving a pending grant request persists a standing grant, so a page
    // must not be able to drive it (VAP-01 boundary).
    const resolve = vi.fn();
    const response = await dispatch(
      {
        id: newId(),
        v: 1,
        source: 'content',
        kind: 'vap.grant.resolve',
        payload: { id: 'g-1', action: 'approve' },
      },
      pageSender,
      handlers({ 'vap.grant.resolve': resolve as unknown as HandlerMap['vap.grant.resolve'] })
    );

    expect(response.ok).toBe(false);
    if (!response.ok) expect(response.error.code).toBe('ORIGIN_DENIED');
    expect(resolve).not.toHaveBeenCalled();
  });
});

/**
 * The router derives `ctx.pageOrigin` for dapp permission checks from Chrome's
 * `sender.url` (which a page cannot forge), not from any message-body field.
 */
describe('page origin derivation', () => {
  it('derives the page origin from sender.url for a tab message', async () => {
    const seen: Array<string | null> = [];
    await dispatch(
      {
        id: newId(),
        v: 1,
        source: 'inpage',
        kind: 'eth.accounts',
        payload: { origin: 'https://forged.example' }, // the lie in the body
      },
      {
        origin: 'chrome-extension://veilpay-test',
        url: 'https://real-dapp.example/app/',
        tab: { id: 3 } as chrome.tabs.Tab,
      } as chrome.runtime.MessageSender,
      handlers({
        'eth.accounts': async (_payload, ctx) => {
          seen.push(ctx.pageOrigin);
          return { accounts: [] };
        },
      })
    );

    // The forged payload origin is ignored; the URL is the authority.
    expect(seen).toEqual(['https://real-dapp.example']);
  });

  it('falls back to the sender origin for an extension surface', async () => {
    const seen: Array<string | null> = [];
    await dispatch(
      {
        id: newId(),
        v: 1,
        source: 'popup',
        kind: 'eth.accounts',
        payload: {},
      },
      {
        origin: 'chrome-extension://veilpay-test',
        url: 'chrome-extension://veilpay-test/popup.html',
      } as chrome.runtime.MessageSender,
      handlers({
        'eth.accounts': async (_payload, ctx) => {
          seen.push(ctx.pageOrigin);
          return { accounts: [] };
        },
      })
    );

    expect(seen).toEqual(['chrome-extension://veilpay-test']);
  });
});

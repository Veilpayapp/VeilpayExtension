import { describe, expect, it, vi } from 'vitest';
import {
  pollOnce,
  startAgentBridgeLoop,
  type AgentBridgeConfig,
  type BridgeRequest,
} from '@/background/agent-bridge';

const CONFIG: AgentBridgeConfig = {
  mode: 'local',
  baseUrl: 'http://127.0.0.1:8765',
  token: 'token-abc',
  pairedAt: 0,
};

const RELAY_CONFIG: AgentBridgeConfig = {
  mode: 'relay',
  baseUrl: 'https://relay.example',
  token: 'relay-secret',
  walletId: 'wallet-1',
  pairedAt: 0,
};

/** A fetch stub that returns queued responses in order. */
function fetchQueue(responses: (Response | Error)[]) {
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  const impl = vi.fn(async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    const next = responses.shift();
    if (next === undefined) throw new Error('no queued response');
    if (next instanceof Error) throw next;
    return next;
  });
  return { impl: impl as unknown as typeof fetch, calls };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const noopExecute = async () => ({ ok: true });

describe('agent bridge polling', () => {
  it('reports disconnected when the bridge is unreachable', async () => {
    const { impl } = fetchQueue([new Error('ECONNREFUSED')]);
    const outcome = await pollOnce(CONFIG, noopExecute, impl);

    expect(outcome).toEqual({ connected: false, handled: false, unauthorized: false });
  });

  it('treats a 204 long-poll timeout as connected but idle', async () => {
    const { impl, calls } = fetchQueue([new Response(null, { status: 204 })]);
    const outcome = await pollOnce(CONFIG, noopExecute, impl);

    expect(outcome).toEqual({ connected: true, handled: false, unauthorized: false });
    // The pairing token must travel on every poll; without it the bridge 401s.
    expect(calls[0]?.init?.headers).toMatchObject({ 'x-veilpay-token': 'token-abc' });
  });

  it('treats a plain rejected token as disconnected, not recoverable', async () => {
    const { impl } = fetchQueue([json({ ok: false }, 401)]);
    const outcome = await pollOnce(CONFIG, noopExecute, impl);

    // A local bridge never forgets a wallet, so a 401 is a token mismatch the
    // user must re-pair by hand — not something to recover automatically.
    expect(outcome).toEqual({ connected: false, handled: false, unauthorized: false });
  });

  it('marks a wallet_unknown 401 as recoverable for a relay wallet', async () => {
    const { impl } = fetchQueue([json({ ok: false, code: 'wallet_unknown' }, 401)]);
    const outcome = await pollOnce(RELAY_CONFIG, noopExecute, impl);

    // The relay lost its in-memory state (free-tier restart): the poll loop's
    // owner may re-register and continue.
    expect(outcome).toEqual({ connected: false, handled: false, unauthorized: true });
  });

  it('treats a bad-secret 401 as a mismatch, not a lost wallet', async () => {
    const { impl } = fetchQueue([json({ ok: false, code: 'bad_secret' }, 401)]);
    const outcome = await pollOnce(RELAY_CONFIG, noopExecute, impl);

    // Re-registering on a bad secret would silently replace a working wallet
    // and drop every AI client's grant, so this must NOT be recoverable.
    expect(outcome).toEqual({ connected: false, handled: false, unauthorized: false });
  });

  it('executes a delivered request and posts the result back', async () => {
    const { impl, calls } = fetchQueue([
      json({ id: 'req-1', tool: 'status', args: {} }),
      json({ ok: true }),
    ]);
    const execute = vi.fn(async (request: BridgeRequest) => ({
      tool: request.tool,
      unlocked: true,
    }));

    const outcome = await pollOnce(CONFIG, execute, impl);

    expect(outcome).toEqual({ connected: true, handled: true, unauthorized: false });
    expect(execute).toHaveBeenCalledWith({ id: 'req-1', tool: 'status', args: {} });

    const posted = JSON.parse(String(calls[1]?.init?.body)) as {
      id: string;
      ok: boolean;
      data: { unlocked: boolean };
    };
    expect(posted.id).toBe('req-1');
    expect(posted.ok).toBe(true);
    expect(posted.data.unlocked).toBe(true);
  });

  it('reports a tool failure to the agent instead of throwing', async () => {
    const { impl, calls } = fetchQueue([
      json({ id: 'req-2', tool: 'send', args: { amount: '1' } }),
      json({ ok: true }),
    ]);
    const execute = vi.fn(async () => {
      throw new Error('Denied by the spending grant (overPerOpCap).');
    });

    // A denied payment is a normal outcome, so the loop must survive it.
    const outcome = await pollOnce(CONFIG, execute, impl);

    expect(outcome).toEqual({ connected: true, handled: true, unauthorized: false });
    const posted = JSON.parse(String(calls[1]?.init?.body)) as {
      ok: boolean;
      error: { message: string };
    };
    expect(posted.ok).toBe(false);
    expect(posted.error.message).toContain('overPerOpCap');
  });

  it('ignores a malformed request without executing anything', async () => {
    const { impl } = fetchQueue([json({ tool: 'status' })]);
    const execute = vi.fn(noopExecute);

    const outcome = await pollOnce(CONFIG, execute, impl);

    // No id means there is nothing to correlate a result to.
    expect(outcome).toEqual({ connected: true, handled: false, unauthorized: false });
    expect(execute).not.toHaveBeenCalled();
  });

  it('does not crash on a non-JSON body', async () => {
    const { impl } = fetchQueue([new Response('<html>not json</html>', { status: 200 })]);
    const outcome = await pollOnce(CONFIG, noopExecute, impl);
    expect(outcome).toEqual({ connected: true, handled: false, unauthorized: false });
  });

  it('defaults missing args to an empty object', async () => {
    const { impl } = fetchQueue([json({ id: 'req-3', tool: 'accounts' }), json({ ok: true })]);
    const execute = vi.fn(async () => ({}));

    await pollOnce(CONFIG, execute, impl);

    expect(execute).toHaveBeenCalledWith({ id: 'req-3', tool: 'accounts', args: {} });
  });
});

describe('agent bridge loop recovery', () => {
  it('stops and hands over on a wallet_unknown 401 instead of polling a dead credential', async () => {
    const onUnauthorized = vi.fn();
    // A recoverable 401, then a healthy 204 that must never be reached: the
    // loop stops after the handover, and the caller replaces it after
    // re-registering.
    const { impl, calls } = fetchQueue([
      json({ ok: false, code: 'wallet_unknown' }, 401),
      new Response(null, { status: 204 }),
    ]);
    const loop = startAgentBridgeLoop(RELAY_CONFIG, noopExecute, impl, { onUnauthorized });

    await new Promise((resolve) => setTimeout(resolve, 25));

    expect(onUnauthorized).toHaveBeenCalledTimes(1);
    expect(loop.connected()).toBe(false);
    expect(calls.length).toBe(1);
    loop.stop();
  });
});

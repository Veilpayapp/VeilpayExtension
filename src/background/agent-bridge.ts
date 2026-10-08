/**
 * Agent bridge — lets a local MCP server (Claude, ChatGPT via MCP) request
 * payments from the wallet.
 *
 * Direction of trust, which is the whole design: the extension cannot be
 * reached inbound, so *this* side polls a localhost HTTP server that the MCP
 * server runs. Nothing is exposed to the network, and every request is
 * authorised by the same grant machinery as a dapp payment — the bridge is just
 * another client. See `docs/AGENT_PAYMENTS.md`.
 *
 * This module owns transport only. What a tool *does* is injected as `execute`,
 * so the payment logic stays next to the rest of the wallet's signing code and
 * this file remains testable with a fake fetch.
 */

const STORAGE_KEY = 'agent:bridge';

/** How long a poll waits before the server answers 204. Matches the server. */
export const POLL_TIMEOUT_MS = 25_000;

/** Backoff after a failed poll, so a closed bridge does not spin. */
export const RETRY_DELAY_MS = 3_000;

export interface AgentBridgeConfig {
  /**
   * `local` talks to the MCP server the user runs; `relay` talks to a hosted
   * server the user does not run. Both speak the same /next + /result protocol,
   * so only the base URL and auth headers differ.
   */
  mode: 'local' | 'relay';
  /** Origin only, e.g. `http://127.0.0.1:8765` or `https://relay.example`. */
  baseUrl: string;
  /**
   * A bearer credential: anything that reads it can drive the wallet within the
   * user's grant caps. It lives in `chrome.storage.local`, which is unencrypted
   * on disk — acceptable only because grants bound what it can do, and why it is
   * never returned over the message bus or written to logs.
   */
  token: string;
  /** Relay only: identifies this wallet's queue on the server. */
  walletId?: string;
  /** Epoch ms when the user paired. */
  pairedAt: number;
}

/**
 * Auth headers for the configured transport.
 *
 * Kept in one place so a relay request can never accidentally be sent with the
 * local header (or vice versa), which would fail closed but confusingly.
 */
function authHeaders(config: AgentBridgeConfig): Record<string, string> {
  if (config.mode === 'relay') {
    return {
      'x-veilpay-wallet': config.walletId ?? '',
      'x-veilpay-secret': config.token,
    };
  }
  return { 'x-veilpay-token': config.token };
}

export async function loadAgentBridgeConfig(): Promise<AgentBridgeConfig | null> {
  const stored = await chrome.storage.local.get(STORAGE_KEY);
  const value = stored[STORAGE_KEY];
  if (typeof value !== 'object' || value === null) return null;
  const record = value as Record<string, unknown>;
  if (typeof record.token !== 'string') return null;

  // Legacy shape from before the relay existed: { port, token }.
  if (typeof record.baseUrl !== 'string') {
    if (typeof record.port !== 'number') return null;
    return {
      mode: 'local',
      baseUrl: `http://127.0.0.1:${record.port}`,
      token: record.token,
      pairedAt: typeof record.pairedAt === 'number' ? record.pairedAt : 0,
    };
  }

  const config: AgentBridgeConfig = {
    mode: record.mode === 'relay' ? 'relay' : 'local',
    baseUrl: record.baseUrl,
    token: record.token,
    pairedAt: typeof record.pairedAt === 'number' ? record.pairedAt : 0,
  };
  if (typeof record.walletId === 'string') config.walletId = record.walletId;
  return config;
}

export async function saveAgentBridgeConfig(config: AgentBridgeConfig): Promise<void> {
  await chrome.storage.local.set({ [STORAGE_KEY]: config });
}

export async function clearAgentBridgeConfig(): Promise<void> {
  await chrome.storage.local.remove(STORAGE_KEY);
}

export interface BridgeRequest {
  id: string;
  tool: string;
  args: Record<string, unknown>;
}

/**
 * Performs one poll cycle.
 *
 * Returns whether a request was handled, plus the connection state, so the
 * caller can drive backoff and status reporting without inspecting the network
 * itself. `unauthorized` marks a 401: the bridge no longer knows this wallet,
 * which for a hosted relay means it restarted and dropped its in-memory
 * pairings — the caller can re-register rather than retry a dead credential.
 */
export interface PollOutcome {
  connected: boolean;
  handled: boolean;
  /** True only for a 401 poll: the stored wallet credentials were refused. */
  unauthorized: boolean;
}

export async function pollOnce(
  config: AgentBridgeConfig,
  execute: (request: BridgeRequest) => Promise<unknown>,
  fetchImpl: typeof fetch = fetch,
  signal?: AbortSignal
): Promise<PollOutcome> {
  let response: Response;
  try {
    response = await fetchImpl(`${config.baseUrl}/next`, {
      headers: authHeaders(config),
      ...(signal !== undefined ? { signal } : {}),
    });
  } catch {
    // Bridge not running, or the service worker is shutting down.
    return { connected: false, handled: false, unauthorized: false };
  }

  if (response.status === 204) {
    // Long-poll elapsed with no work: the server is healthy and idle.
    return { connected: true, handled: false, unauthorized: false };
  }
  if (!response.ok) {
    // The server distinguishes an unknown wallet (volatile state was lost)
    // from a bad secret (credential mismatch). Only the first is safe to
    // recover automatically: re-registering on a bad-secret 401 would revoke
    // valid OAuth grants unnecessarily.
    let unauthorized = false;
    if (response.status === 401 && config.mode === 'relay') {
      try {
        const error = (await response.json()) as { code?: unknown };
        unauthorized = error.code === 'wallet_unknown';
      } catch {
        // Older relay versions return no machine-readable recovery reason.
      }
    }
    return { connected: false, handled: false, unauthorized };
  }

  let request: BridgeRequest;
  try {
    const parsed = (await response.json()) as unknown;
    if (typeof parsed !== 'object' || parsed === null) {
      return { connected: true, handled: false, unauthorized: false };
    }
    const record = parsed as Record<string, unknown>;
    if (typeof record.id !== 'string' || typeof record.tool !== 'string') {
      return { connected: true, handled: false, unauthorized: false };
    }
    request = {
      id: record.id,
      tool: record.tool,
      args:
        typeof record.args === 'object' && record.args !== null
          ? (record.args as Record<string, unknown>)
          : {},
    };
  } catch {
    return { connected: true, handled: false, unauthorized: false };
  }

  let payload: { id: string; ok: boolean; data?: unknown; error?: { message: string } };
  try {
    const data = await execute(request);
    payload = { id: request.id, ok: true, data };
  } catch (cause) {
    // A tool failure is a normal outcome (cap exceeded, user denied), so it is
    // reported to the agent rather than thrown into the poll loop.
    const message =
      cause instanceof Error ? cause.message : 'The wallet could not complete that request.';
    payload = { id: request.id, ok: false, error: { message } };
  }

  try {
    await fetchImpl(`${config.baseUrl}/result`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...authHeaders(config),
      },
      body: JSON.stringify(payload),
      ...(signal !== undefined ? { signal } : {}),
    });
  } catch {
    // The agent will have timed out on its side; nothing more to do.
  }

  return { connected: true, handled: true, unauthorized: false };
}

export interface AgentBridgeLoop {
  stop(): void;
  /** Current connection state, for `agent.status`. */
  connected(): boolean;
  lastPollAt(): number | null;
}

/**
 * Runs `pollOnce` in a loop until stopped.
 *
 * The loop deliberately lives in the service worker rather than the offscreen
 * document: an in-flight `fetch` keeps the worker alive, so the poll survives,
 * and the vault still enforces its own idle deadline regardless. The cost is
 * that the worker stays warm while the bridge is enabled — the reason this is
 * opt-in rather than always-on.
 *
 * When a poll is refused with 401 the relay has forgotten this wallet (a hosted
 * relay restarts and drops its in-memory state). The loop stops and hands the
 * problem to `onUnauthorized`, whose job is to re-register and start a fresh
 * loop — never to keep polling dead credentials.
 */
export function startAgentBridgeLoop(
  config: AgentBridgeConfig,
  execute: (request: BridgeRequest) => Promise<unknown>,
  fetchImpl: typeof fetch = fetch,
  options: { onUnauthorized?: () => void } = {}
): AgentBridgeLoop {
  let running = true;
  let isConnected = false;
  let lastPoll: number | null = null;
  const controller = new AbortController();

  const sleep = (ms: number) =>
    new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, ms);
      controller.signal.addEventListener('abort', () => {
        clearTimeout(timer);
        resolve();
      });
    });

  void (async () => {
    while (running) {
      const outcome = await pollOnce(config, execute, fetchImpl, controller.signal);
      if (!running) break;
      isConnected = outcome.connected;
      if (outcome.connected) lastPoll = Date.now();
      if (outcome.unauthorized) {
        // The relay dropped this wallet. Stop polling with the dead credential;
        // the caller re-registers and replaces this loop with a live one.
        isConnected = false;
        options.onUnauthorized?.();
        break;
      }
      // A healthy long-poll returns immediately after 204; only back off when
      // the bridge looks unreachable, so a live bridge adds no latency.
      if (!outcome.connected) await sleep(RETRY_DELAY_MS);
    }
  })();

  return {
    stop() {
      running = false;
      controller.abort();
    },
    connected: () => isConnected,
    lastPollAt: () => lastPoll,
  };
}

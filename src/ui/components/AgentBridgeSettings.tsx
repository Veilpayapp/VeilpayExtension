import { useCallback, useEffect, useState } from 'react';
import { createClient } from '@/core/messaging/client';
import { Button } from '@/ui/components/Button';
import { Card } from '@/ui/components/Card';
import { Input } from '@/ui/components/Input';
import { Glyph } from '@/ui/components/Glyph';

const send = createClient('options');

interface AgentStatus {
  enabled: boolean;
  mode: 'local' | 'relay' | null;
  endpoint: string | null;
  paired: boolean;
  connected: boolean;
  lastPollAt: number | null;
}

/**
 * Where each client manages connected apps / MCP servers.
 *
 * These are ordinary settings URLs, not deep links: no vendor documents a
 * "add this connector" URL, so the honest behaviour is to open the right page
 * and put the server URL on the clipboard, ready to paste.
 */
const CLIENTS = {
  claude: {
    label: 'Claude',
    settingsUrl: 'https://claude.ai/settings/connectors',
    hint: 'Settings → Connectors → Add custom connector',
  },
  chatgpt: {
    label: 'ChatGPT',
    settingsUrl: 'https://chatgpt.com/#settings/Connectors',
    hint: 'Settings → Connectors → Add MCP server',
  },
} as const;

type ClientKey = keyof typeof CLIENTS;

const DEFAULT_PORT = 8765;
const DEFAULT_RELAY_URL = 'https://veilpay-relay.onrender.com';

/**
 * Connects the wallet to an AI client.
 *
 * Two paths, and the difference is who hosts the server. `relay` needs no
 * install: the extension registers with a hosted server and the user pastes one
 * URL. `local` runs the MCP server on this machine, which keeps payment
 * metadata off a third party but requires Node.
 */
export function AgentBridgeSettings() {
  const [status, setStatus] = useState<AgentStatus | null>(null);
  const [mode, setMode] = useState<'relay' | 'local'>('relay');
  const [client, setClient] = useState<ClientKey>('claude');
  const [relayUrl, setRelayUrl] = useState(DEFAULT_RELAY_URL);
  const [port, setPort] = useState(String(DEFAULT_PORT));
  const [token, setToken] = useState('');
  const [mcpUrl, setMcpUrl] = useState<string | null>(null);
  const [pairingCode, setPairingCode] = useState<string | null>(null);
  const [pairingCodeExpiresAt, setPairingCodeExpiresAt] = useState<number | null>(null);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    try {
      setStatus(await send('agent.status', {}));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not read bridge status.');
    }
  }, []);

  useEffect(() => {
    void refresh();
    // Connection state is live, so poll it while this panel is open.
    const timer = window.setInterval(() => void refresh(), 5_000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  // The displayed code must always be the relay's live one. A restart (a
  // deploy, a free-tier sleep) silently invalidates whatever was issued at
  // Connect time, and a stale code is exactly the relay's "does not recognize
  // that code" rejection. Refreshing is safe: the relay returns the same live
  // code while it is valid — this never swaps a code out from under someone
  // who is typing it — and after a wipe it surfaces the replacement at once,
  // because the background has re-registered the wallet by then.
  useEffect(() => {
    if (status?.mode !== 'relay' || status.paired !== true) return;
    let cancelled = false;
    const refreshCode = () => {
      void send('agent.relay.pairing-code', {})
        .then((result) => {
          if (cancelled) return;
          setPairingCode(result.pairingCode);
          setPairingCodeExpiresAt(result.pairingCodeExpiresAt);
        })
        .catch(() => {
          // Keep the last shown code; the retry in ten seconds covers a
          // restart-in-progress, and the manual button surfaces the error.
        });
    };
    refreshCode();
    const timer = window.setInterval(refreshCode, 10_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [status?.mode, status?.paired]);

  const copy = async (value: string) => {
    await navigator.clipboard.writeText(value).catch(() => undefined);
    setCopied(true);
    setTimeout(() => setCopied(false), 2_000);
  };

  /**
   * Requests access to the user-supplied relay origin.
   *
   * A relay is any https host, so granting every site up front would undo the
   * minimal-permission design; the origin is requested here instead. This must
   * run inside a click handler — Chrome requires a user gesture.
   */
  const ensureRelayPermission = async (origin: string): Promise<boolean> => {
    const pattern = `${origin}/*`;
    if (await chrome.permissions.contains({ origins: [pattern] })) return true;
    return chrome.permissions.request({ origins: [pattern] });
  };

  const handleRelayConnect = async () => {
    setError(null);
    setMcpUrl(null);
    const trimmed = relayUrl.trim().replace(/\/$/, '');
    if (!/^https?:\/\//.test(trimmed)) {
      setError('Enter the relay URL, including https://.');
      return;
    }

    setBusy(true);
    try {
      if (!(await ensureRelayPermission(new URL(trimmed).origin))) {
        setError('Permission for that relay was declined.');
        return;
      }
      const result = await send('agent.relay.register', { baseUrl: trimmed });
      setMcpUrl(result.mcpUrl);
      setPairingCode(result.pairingCode);
      setPairingCodeExpiresAt(result.pairingCodeExpiresAt);
      // Put the URL on the clipboard immediately: the next step is pasting it
      // into the client, and making the user select it by hand is the friction
      // this path exists to remove.
      await copy(result.mcpUrl);
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not reach the relay.');
    } finally {
      setBusy(false);
    }
  };

  const handleLocalPair = async () => {
    setError(null);
    const parsedPort = Number(port);
    if (!Number.isInteger(parsedPort) || parsedPort <= 0 || parsedPort > 65535) {
      setError('Port must be a number between 1 and 65535.');
      return;
    }
    if (token.trim().length < 16) {
      setError('Paste the pairing token printed by the MCP server.');
      return;
    }

    setBusy(true);
    try {
      await send('agent.configure', {
        mode: 'local',
        baseUrl: `http://127.0.0.1:${parsedPort}`,
        token: token.trim(),
      });
      setToken('');
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not pair the bridge.');
    } finally {
      setBusy(false);
    }
  };

  const handleRefreshPairingCode = async () => {
    setError(null);
    setBusy(true);
    try {
      const result = await send('agent.relay.pairing-code', {});
      setPairingCode(result.pairingCode);
      setPairingCodeExpiresAt(result.pairingCodeExpiresAt);
      await copy(result.pairingCode);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not get a pairing code.');
    } finally {
      setBusy(false);
    }
  };

  const handleDisable = async () => {
    setBusy(true);
    try {
      await send('agent.disable', {});
      setMcpUrl(null);
      setPairingCode(null);
      setPairingCodeExpiresAt(null);
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not disconnect.');
    } finally {
      setBusy(false);
    }
  };

  const statusPill = (
    <div className="mb-3 flex items-center gap-2">
      <span
        className={`inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 font-body text-[11px] font-medium ${
          status?.connected
            ? 'bg-success/15 text-success'
            : status?.paired
              ? 'bg-warning/15 text-warning'
              : 'bg-surface-700 text-content-tertiary'
        }`}
      >
        <span
          aria-hidden
          className={`h-1.5 w-1.5 rounded-full ${
            status?.connected ? 'bg-success' : status?.paired ? 'bg-warning' : 'bg-content-tertiary'
          }`}
        />
        {status?.connected
          ? 'Connected'
          : status?.paired
            ? 'Waiting for the AI client'
            : 'Not connected'}
      </span>
      {status?.endpoint !== null && status?.endpoint !== undefined && (
        <span className="truncate font-mono text-[11px] text-content-tertiary">
          {status.endpoint}
        </span>
      )}
    </div>
  );

  // Once a relay URL exists, the remaining step lives in the AI client, so show
  // that rather than the connection form again.
  if (mcpUrl !== null || status?.paired === true) {
    const chosen = CLIENTS[client];
    const url =
      mcpUrl ??
      (status?.mode === 'relay' && status.endpoint !== null ? `${status.endpoint}/mcp` : '');
    return (
      <div className="flex flex-col gap-3">
        <Card title="Agent">
          {statusPill}
          <p className="mb-3 font-body text-xs text-content-secondary">
            Everyone uses this same public MCP URL. Add it to {chosen.label}, then enter the pairing
            code below when the client opens Veilpay.
          </p>

          {url.length > 0 && (
            <div className="mb-3 rounded-xl border border-surface-700/60 bg-surface-900 p-3">
              <p className="font-body text-[10px] uppercase tracking-wide text-content-tertiary">
                Shared MCP server URL
              </p>
              <p className="mt-0.5 break-all font-mono text-[11px] text-content-primary">{url}</p>
            </div>
          )}

          <div className="mb-3 rounded-xl border border-accent-500/25 bg-accent-500/10 p-3">
            <div className="flex items-center justify-between">
              <p className="font-body text-[10px] uppercase tracking-wide text-accent-400">
                Pairing code
              </p>
              {pairingCodeExpiresAt !== null && (
                <p className="font-body text-[10px] text-content-tertiary">
                  Expires{' '}
                  {new Date(pairingCodeExpiresAt).toLocaleTimeString([], {
                    hour: '2-digit',
                    minute: '2-digit',
                  })}
                </p>
              )}
            </div>
            {pairingCode !== null ? (
              <p className="mt-1 text-center font-mono text-xl font-semibold tracking-[0.22em] text-content-primary">
                {pairingCode}
              </p>
            ) : (
              <p className="mt-1 font-body text-xs text-content-secondary">
                Generate a code when you are ready to connect an AI client.
              </p>
            )}
            <Button
              variant="secondary"
              fullWidth
              className="mt-2"
              onClick={() => void handleRefreshPairingCode()}
              disabled={busy}
            >
              <Glyph name="copy" className="h-4 w-4" />
              {pairingCode === null ? 'Get pairing code' : 'Copy fresh code'}
            </Button>
          </div>

          <div className="flex gap-2">
            {url.length > 0 && (
              <Button variant="secondary" fullWidth onClick={() => void copy(url)}>
                <Glyph name={copied ? 'check' : 'copy'} className="h-4 w-4" />
                {copied ? 'Copied' : 'Copy URL'}
              </Button>
            )}
            <Button
              variant="primary"
              fullWidth
              onClick={() => window.open(chosen.settingsUrl, '_blank', 'noopener,noreferrer')}
            >
              <Glyph name="external" className="h-4 w-4" />
              Open {chosen.label}
            </Button>
          </div>

          <p className="mt-3 font-body text-[11px] text-content-tertiary">{chosen.hint}</p>
          <p className="mt-2 font-body text-[11px] text-content-tertiary">
            The client opens a Veilpay page. Enter the pairing code shown above, then approve. The
            code above is always the relay's current one — it is replaced automatically if it
            expires or the relay restarts.
          </p>

          <Button
            variant="ghost"
            fullWidth
            className="mt-3"
            onClick={handleDisable}
            disabled={busy}
          >
            Disconnect
          </Button>
        </Card>

        <Card title="Which client?">
          <div className="flex gap-2">
            {(Object.keys(CLIENTS) as ClientKey[]).map((key) => (
              <button
                key={key}
                type="button"
                onClick={() => setClient(key)}
                aria-pressed={client === key}
                className={`flex-1 rounded-xl border px-3 py-2 font-body text-xs ${
                  client === key
                    ? 'border-accent-500 bg-accent-500/10 text-content-primary'
                    : 'border-surface-700 text-content-secondary'
                }`}
              >
                {CLIENTS[key].label}
              </button>
            ))}
          </div>
        </Card>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <Card title="Agent">
        {statusPill}

        <p className="mb-3 font-body text-xs text-content-secondary">
          Let an AI assistant pay from this wallet, within caps you set. Pick where you use it.
        </p>

        <div className="mb-3 flex gap-2">
          {(Object.keys(CLIENTS) as ClientKey[]).map((key) => (
            <button
              key={key}
              type="button"
              onClick={() => setClient(key)}
              aria-pressed={client === key}
              className={`flex-1 rounded-xl border px-3 py-2 font-body text-xs ${
                client === key
                  ? 'border-accent-500 bg-accent-500/10 text-content-primary'
                  : 'border-surface-700 text-content-secondary'
              }`}
            >
              {CLIENTS[key].label}
            </button>
          ))}
        </div>

        <div className="mb-3 flex gap-2">
          <button
            type="button"
            onClick={() => setMode('relay')}
            aria-pressed={mode === 'relay'}
            className={`flex-1 rounded-xl border px-3 py-2 font-body text-xs ${
              mode === 'relay'
                ? 'border-accent-500 bg-accent-500/10 text-content-primary'
                : 'border-surface-700 text-content-secondary'
            }`}
          >
            Hosted relay
          </button>
          <button
            type="button"
            onClick={() => setMode('local')}
            aria-pressed={mode === 'local'}
            className={`flex-1 rounded-xl border px-3 py-2 font-body text-xs ${
              mode === 'local'
                ? 'border-accent-500 bg-accent-500/10 text-content-primary'
                : 'border-surface-700 text-content-secondary'
            }`}
          >
            Run locally
          </button>
        </div>

        {mode === 'relay' ? (
          <>
            <Input
              label="Relay URL"
              placeholder="https://relay.example"
              value={relayUrl}
              onChange={(e) => setRelayUrl(e.target.value)}
              disabled={busy}
            />
            <Button className="mt-3" fullWidth onClick={handleRelayConnect} disabled={busy}>
              {busy ? 'Connecting…' : 'Connect'}
            </Button>
          </>
        ) : (
          <>
            <Input
              label="Bridge port"
              placeholder={String(DEFAULT_PORT)}
              value={port}
              onChange={(e) => setPort(e.target.value)}
              disabled={busy}
            />
            <div className="mt-3">
              <Input
                type="password"
                passwordToggle
                label="Pairing token"
                placeholder="Paste the token from the MCP server"
                value={token}
                onChange={(e) => setToken(e.target.value)}
                disabled={busy}
              />
            </div>
            <Button className="mt-3" fullWidth onClick={handleLocalPair} disabled={busy}>
              {busy ? 'Pairing…' : 'Pair bridge'}
            </Button>
          </>
        )}

        {error !== null && <p className="mt-2 font-body text-xs text-danger">{error}</p>}
      </Card>

      <Card title="Before you connect">
        <ul className="flex flex-col gap-2 font-body text-xs text-content-secondary">
          <li className="flex gap-2">
            <Glyph name="alert" className="mt-0.5 h-3.5 w-3.5 shrink-0 text-warning" />
            <span>
              This grants a spending capability. Keep your caps in <strong>VAP Grants</strong>{' '}
              small, and disconnect when you are done.
            </span>
          </li>
          <li className="flex gap-2">
            <Glyph name="shield" className="mt-0.5 h-3.5 w-3.5 shrink-0 text-content-tertiary" />
            <span>
              A relay can only <em>ask</em> for payments — it can never authorise one. Caps and
              approvals are enforced here, in the extension.
            </span>
          </li>
          <li className="flex gap-2">
            <Glyph name="wallet" className="mt-0.5 h-3.5 w-3.5 shrink-0 text-content-tertiary" />
            <span>Testnet only. Sepolia ETH, devnet SOL, and testnet XLM — no monetary value.</span>
          </li>
        </ul>
      </Card>
    </div>
  );
}

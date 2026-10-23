import { useState, useEffect } from 'react';
import { useWallet } from '@/ui/store/useWallet';
import { Button } from '@/ui/components/Button';
import { Card } from '@/ui/components/Card';
import { Input } from '@/ui/components/Input';

/** WalletConnect management view: pair, approve proposals, list sessions. */
export function WalletConnectView() {
  const {
    pendingWcProposal,
    wcSessions,
    pendingWcRequest,
    wcPair,
    loadWcProposal,
    wcApproveProposal,
    wcRejectProposal,
    loadWcSessions,
    wcDisconnect,
    loadWcRequest,
    wcResolveRequest,
    accounts,
    loadAccounts,
  } = useWallet();

  const [uri, setUri] = useState('');
  const [pairing, setPairing] = useState(false);
  const [proposalLoading, setProposalLoading] = useState(false);

  // Load data when the component mounts and periodically.
  useEffect(() => {
    void loadWcProposal();
    void loadWcSessions();
    void loadWcRequest();
    if (accounts.length === 0) void loadAccounts();
  }, [loadWcProposal, loadWcSessions, loadWcRequest, accounts.length, loadAccounts]);

  const handlePair = async () => {
    if (!uri.trim()) return;
    setPairing(true);
    const ok = await wcPair(uri.trim());
    setPairing(false);
    if (ok) {
      setUri('');
      // Wait a moment for the proposal to arrive, then load it.
      setTimeout(() => void loadWcProposal(), 1000);
    }
  };

  const handleApproveProposal = async () => {
    if (!pendingWcProposal) return;
    setProposalLoading(true);
    // Use the first EVM account (or all accounts?) For simplicity, share the first EVM address.
    const evmAccounts = accounts.filter((a) => a.chain === 'evm');
    const addresses = evmAccounts.map((a) => a.address);
    if (addresses.length === 0) {
      // No EVM account; can't approve.
      return;
    }
    const ok = await wcApproveProposal(pendingWcProposal.id, addresses);
    setProposalLoading(false);
    if (ok) {
      await loadWcSessions();
      await loadWcProposal();
    }
  };

  const handleRejectProposal = async () => {
    if (!pendingWcProposal) return;
    setProposalLoading(true);
    await wcRejectProposal(pendingWcProposal.id);
    setProposalLoading(false);
    await loadWcProposal();
  };

  const handleDisconnect = async (topic: string) => {
    await wcDisconnect(topic);
    await loadWcSessions();
  };

  const handleResolveRequest = async (action: 'approve' | 'deny') => {
    // Bind the decision to the exact request being displayed — if another
    // request arrived in between, the background refuses rather than
    // approving the wrong one.
    await wcResolveRequest(action, pendingWcRequest?.requestId);
    await loadWcRequest();
  };

  return (
    <div className="flex flex-col gap-4 p-4">
      <h2 className="font-display text-base font-semibold text-content-primary">WalletConnect</h2>

      {/* Pending proposal */}
      {pendingWcProposal && (
        <Card title="Session request">
          <div className="flex flex-col gap-3">
            <p className="font-body text-sm text-content-secondary">
              <strong>{pendingWcProposal.name}</strong> wants to connect.
              {pendingWcProposal.url && (
                <span className="block text-xs text-content-tertiary">{pendingWcProposal.url}</span>
              )}
            </p>
            <div className="rounded-lg bg-surface-700 p-2 text-xs text-content-secondary">
              <p>Chains: {Object.keys(pendingWcProposal.requiredNamespaces).join(', ')}</p>
              <p>Methods: {Object.values(pendingWcProposal.requiredNamespaces).flatMap((ns) => ns.methods).join(', ')}</p>
            </div>
            <div className="flex gap-3">
              <Button variant="secondary" fullWidth onClick={handleRejectProposal} disabled={proposalLoading}>
                Reject
              </Button>
              <Button variant="primary" fullWidth onClick={handleApproveProposal} disabled={proposalLoading}>
                {proposalLoading ? 'Approving…' : 'Approve'}
              </Button>
            </div>
          </div>
        </Card>
      )}

      {/* Pairing input */}
      {!pendingWcProposal && (
        <Card title="Connect to a dapp">
          <div className="flex flex-col gap-3">
            <p className="font-body text-sm text-content-secondary">
              Paste a WalletConnect URI from a dapp (e.g. from a QR code or deep link).
            </p>
            <Input
              value={uri}
              onChange={(e) => setUri(e.target.value)}
              placeholder="wc:..."
              disabled={pairing}
            />
            <Button
              variant="primary"
              fullWidth
              onClick={handlePair}
              disabled={pairing || !uri.trim()}
            >
              {pairing ? 'Pairing…' : 'Pair'}
            </Button>
          </div>
        </Card>
      )}

      {/* Pending request (e.g., sign or send) */}
      {pendingWcRequest && (
        <Card title="Request from dapp">
          <div className="flex flex-col gap-3">
            <p className="font-body text-sm text-content-secondary">
              <strong>{pendingWcRequest.method}</strong> – {pendingWcRequest.hint}
            </p>
            <div className="flex gap-3">
              <Button variant="secondary" fullWidth onClick={() => handleResolveRequest('deny')}>
                Deny
              </Button>
              <Button variant="primary" fullWidth onClick={() => handleResolveRequest('approve')}>
                Approve
              </Button>
            </div>
          </div>
        </Card>
      )}

      {/* Active sessions */}
      <Card title="Active sessions">
        {wcSessions.length === 0 ? (
          <p className="font-body text-sm text-content-tertiary">No active WalletConnect sessions.</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {wcSessions.map((session) => (
              <li
                key={session.topic}
                className="flex items-center justify-between gap-2 rounded-lg bg-surface-700 px-3 py-2"
              >
                <div className="min-w-0">
                  <p className="font-body text-sm font-medium text-content-primary">
                    {session.name}
                  </p>
                  {session.url && (
                    <p className="text-xs text-content-tertiary">{session.url}</p>
                  )}
                  <p className="text-xs text-content-tertiary">
                    Accounts: {session.accounts.length}
                  </p>
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => handleDisconnect(session.topic)}
                >
                  Disconnect
                </Button>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
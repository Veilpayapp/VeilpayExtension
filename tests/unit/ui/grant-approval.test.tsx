import '@testing-library/jest-dom/vitest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { GrantApproval } from '@/ui/components/GrantApproval';
import { useWallet, type PendingGrantRequest } from '@/ui/store/useWallet';
import { authenticateWebAuthn } from '@/core/security';

vi.mock('@/core/security', () => ({
  authenticateWebAuthn: vi.fn(async () => true),
}));

const REQUEST: PendingGrantRequest = {
  id: 'g-1',
  origin: 'https://service.example',
  requestedCaps: {
    maxPerOperation: '10000000000000000', // 0.01 ETH
    maxPerWindow: '100000000000000000', // 0.1 ETH
    windowSeconds: 86_400,
    approvalThreshold: '1000000000000000', // 0.001 ETH
    allowedOps: ['x402.pay'],
    allowedChains: ['evm'],
    allowlist: [],
  },
  expiresInSeconds: 604_800,
  createdAt: 1_000,
};

beforeEach(() => {
  useWallet.setState({ securityStatus: null });
});

describe('GrantApproval', () => {
  it('shows the requested caps and origin', () => {
    render(<GrantApproval request={REQUEST} onApprove={() => {}} onReject={() => {}} />);

    expect(screen.getByText('Grant request')).toBeInTheDocument();
    expect(screen.getByText(/service\.example/)).toBeInTheDocument();
    expect(screen.getByText('0.01 ETH')).toBeInTheDocument(); // max per op
    expect(screen.getByText('0.1 ETH')).toBeInTheDocument(); // max per window
    expect(screen.getByText('24 hours')).toBeInTheDocument();
    expect(screen.getByText('0.001 ETH')).toBeInTheDocument(); // auto-approve under
    expect(screen.getByRole('button', { name: 'Create grant' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Reject' })).toBeInTheDocument();
  });

  it('calls onReject when the user rejects', async () => {
    const user = userEvent.setup();
    const onReject = vi.fn(async () => undefined);
    render(<GrantApproval request={REQUEST} onApprove={() => {}} onReject={onReject} />);

    await user.click(screen.getByRole('button', { name: 'Reject' }));
    expect(onReject).toHaveBeenCalledTimes(1);
  });

  it('requires the 3s hold before approving (anti-clickjack)', async () => {
    // Security status loaded: neither PIN nor passkey configured.
    useWallet.setState({ securityStatus: { pinEnabled: false, webauthnEnabled: false } });
    vi.useFakeTimers();
    const onApprove = vi.fn(async () => undefined);
    render(<GrantApproval request={REQUEST} onApprove={onApprove} onReject={() => {}} />);

    // First click only starts the countdown; onApprove must not fire.
    fireEvent.click(screen.getByRole('button', { name: 'Create grant' }));
    expect(onApprove).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: /Hold to confirm/ })).toBeDisabled();

    // Advance past the 3s countdown, then a second click performs the approval.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_000);
    });
    fireEvent.click(screen.getByRole('button', { name: 'Create grant' }));
    expect(onApprove).toHaveBeenCalledTimes(1);

    vi.useRealTimers();
  });

  it('requires the PIN before approving when one is configured (VAP-01)', async () => {
    useWallet.setState({ securityStatus: { pinEnabled: true, webauthnEnabled: false } });
    vi.useFakeTimers();
    const onApprove = vi.fn(async () => undefined);
    render(<GrantApproval request={REQUEST} onApprove={onApprove} onReject={() => {}} />);

    // Complete the hold, then the PIN field appears and approve stays disabled.
    fireEvent.click(screen.getByRole('button', { name: 'Create grant' }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_000);
    });
    expect(screen.getByLabelText('PIN')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Create grant' })).toBeDisabled();

    // Entering a PIN enables approval; the PIN is passed to onApprove.
    fireEvent.change(screen.getByLabelText('PIN'), { target: { value: '1234' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create grant' }));
    expect(onApprove).toHaveBeenCalledWith('1234', false);

    vi.useRealTimers();
  });

  it('requires a passkey ceremony before approving when only WebAuthn is configured', async () => {
    useWallet.setState({
      securityStatus: { pinEnabled: false, webauthnEnabled: true },
      requestWebAuthnChallenge: async () => ({ credentialId: 'cred-1', challenge: '0a' }),
    });
    vi.useFakeTimers();
    const onApprove = vi.fn(async () => undefined);
    render(<GrantApproval request={REQUEST} onApprove={onApprove} onReject={() => {}} />);

    // Complete the hold; approve stays disabled until the passkey ceremony runs.
    fireEvent.click(screen.getByRole('button', { name: 'Create grant' }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_000);
    });
    expect(screen.getByRole('button', { name: 'Confirm with passkey' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Create grant' })).toBeDisabled();

    // Run the ceremony (mocked success), then approve passes webauthn: true.
    fireEvent.click(screen.getByRole('button', { name: 'Confirm with passkey' }));
    await act(async () => {});
    expect(authenticateWebAuthn).toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Create grant' }));
    expect(onApprove).toHaveBeenCalledWith(undefined, true);

    vi.useRealTimers();
  });
});

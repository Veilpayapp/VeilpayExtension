import { SignClient } from '@walletconnect/sign-client';
import { getSdkError } from '@walletconnect/utils';
import type { SignClientTypes, SessionTypes } from '@walletconnect/types';
import { ChromeStorageAdapter } from './storage';
import { setPendingWcProposal, clearPendingWcProposal, getPendingWcProposal } from './proposal-store';
import { setPendingWcRequest, clearPendingWcRequestForTopic } from './request-store';
import { openApprovalSurface } from '@/background/approval-surface';
import {
  findEvmNetworkByChainId,
  resolveEvmChainId,
  setSelectedNetworkId,
} from '@/core/networks';

/**
 * WalletConnect client singleton.
 *
 * Manages the SignClient instance, handles incoming session proposals and
 * requests, and exposes methods for pairing, session management, and responding
 * to proposals/requests.
 */
export class WalletConnectClient {
  private static instance: WalletConnectClient | null = null;
  private client: InstanceType<typeof SignClient> | null = null;
  private initialized = false;
  private initPromise: Promise<void> | null = null;

  private constructor() {}

  static getInstance(): WalletConnectClient {
    if (!WalletConnectClient.instance) {
      WalletConnectClient.instance = new WalletConnectClient();
    }
    return WalletConnectClient.instance;
  }

  /**
   * Initializes the SignClient with a storage adapter and event handlers.
   * Must be called once on service worker startup.
   */
  init(): Promise<void> {
    if (this.initialized) return Promise.resolve();
    if (this.initPromise !== null) return this.initPromise;
    this.initPromise = this.doInit();
    return this.initPromise;
  }

  private async doInit(): Promise<void> {
    if (this.initialized || this.client !== null) return;

    const storage = new ChromeStorageAdapter('wc:');
    const projectId = 'f70c43f1c427d9450b0e003b5566972c';

    this.client = await SignClient.init({
      projectId,
      storage,
      metadata: {
        name: 'Veilpay',
        description: 'Self-custody multi-chain wallet',
        url: 'chrome-extension://' + chrome.runtime.id,
        icons: ['https://veilpay.io/favicon.ico'],
      },
    });

    this.client.on('session_proposal', this.handleSessionProposal.bind(this));
    this.client.on('session_request', this.handleSessionRequest.bind(this));
    this.client.on('session_delete', this.handleSessionDelete.bind(this));
    this.client.on('session_expire', this.handleSessionExpire.bind(this));

    this.initialized = true;
    console.info('[veilpay] WalletConnect client initialized');
  }

  /**
   * Whether the WalletConnect client is ready to pair / respond.
   */
  isReady(): boolean {
    return this.initialized && this.client !== null;
  }

  /**
   * Pair with a dapp using a WC URI (e.g., from a QR code or deep link).
   */
  async pair(uri: string): Promise<void> {
    if (!this.client) throw new Error('WalletConnect client not initialized');
    await this.client.pair({ uri });
  }

  /**
   * List all active sessions.
   */
  getSessions(): SessionTypes.Struct[] {
    if (!this.client) return [];
    return this.client.session.getAll();
  }

  /**
   * Disconnect a session by its topic.
   */
  async disconnect(topic: string): Promise<void> {
    if (!this.client) throw new Error('WalletConnect client not initialized');
    await this.client.disconnect({
      topic,
      reason: getSdkError('USER_DISCONNECTED'),
    });
  }

  /**
   * Approve a session proposal with selected accounts.
   *
   * The session binds to the dapp's requested EVM chains when the wallet's
   * registry carries them (the dapp's first supported chain becomes the
   * wallet's SELECTED EVM network, so balances, signing, and the dapp's
   * requests all agree on one chain); otherwise the currently selected
   * network is offered and the dapp decides whether that is acceptable.
   */
  async approveProposal(proposalId: number, accounts: string[]): Promise<void> {
    if (!this.client) throw new Error('WalletConnect client not initialized');
    const proposal = await getPendingWcProposal();
    if (!proposal || proposal.id !== proposalId) {
      throw new Error('Proposal not found or already handled');
    }

    const evmAccounts = accounts.filter((a) => a.startsWith('0x'));
    if (evmAccounts.length === 0) {
      throw new Error('No EVM accounts selected');
    }

    // Resolve the chain the session will use: the dapp's first requested
    // eip155 chain that this wallet's registry supports, else the current
    // selection. Persist the choice so `eth.chainId` and sends follow it.
    const requestedChains =
      proposal.requiredNamespaces.eip155?.chains ??
      proposal.optionalNamespaces?.eip155?.chains ??
      [];
    let chainId = (await resolveEvmChainId()).toString();
    for (const reference of requestedChains) {
      const parsed = Number.parseInt(reference.split(':')[1] ?? '', 10);
      const network =
        Number.isInteger(parsed) ? findEvmNetworkByChainId(parsed) : undefined;
      if (network !== undefined) {
        await setSelectedNetworkId('evm', network.id);
        chainId = (network.chainId ?? chainId).toString();
        break;
      }
    }

    const namespace = 'eip155';
    const namespaces: SessionTypes.Namespaces = {
      [namespace]: {
        accounts: evmAccounts.map((addr) => `${namespace}:${chainId}:${addr}`),
        methods: [
          'eth_sendTransaction',
          'eth_signTransaction',
          'personal_sign',
          'eth_sign',
          'eth_signTypedData',
          'eth_signTypedData_v4',
        ],
        events: ['chainChanged', 'accountsChanged'],
      },
    };

    await this.client.approve({
      id: proposalId,
      namespaces,
    });
    await clearPendingWcProposal();
  }

  /**
   * Reject a session proposal.
   */
  async rejectProposal(proposalId: number): Promise<void> {
    if (!this.client) throw new Error('WalletConnect client not initialized');
    await this.client.reject({
      id: proposalId,
      reason: getSdkError('USER_REJECTED'),
    });
    await clearPendingWcProposal();
  }

  /**
   * Sends a successful JSON-RPC response back to the dapp for a session request
   * that was parked for approval.
   */
  async respondResult(topic: string, requestId: number, result: unknown): Promise<void> {
    if (!this.client) throw new Error('WalletConnect client not initialized');
    await this.client.respond({
      topic,
      response: { id: requestId, jsonrpc: '2.0', result },
    });
  }

  /**
   * Sends a JSON-RPC error response back to the dapp for a session request that
   * was rejected or could not be fulfilled.
   */
  async respondError(
    topic: string,
    requestId: number,
    error: { code: number; message: string },
  ): Promise<void> {
    if (!this.client) throw new Error('WalletConnect client not initialized');
    await this.client.respond({
      topic,
      response: { id: requestId, jsonrpc: '2.0', error },
    });
  }

  /**
   * Handle incoming session proposal.
   */
  private async handleSessionProposal(event: SignClientTypes.EventArguments['session_proposal']): Promise<void> {
    console.info('[veilpay] WC session proposal', event);
    const { id, params } = event;
    const proposal = {
      id,
      proposer: params.proposer,
      requiredNamespaces: params.requiredNamespaces,
      optionalNamespaces: params.optionalNamespaces,
      relays: params.relays,
      expiryTimestamp: params.expiryTimestamp,
    };
    await setPendingWcProposal(proposal);
    void openApprovalSurface();
  }

  /**
   * Handle incoming session request (e.g., eth_sendTransaction).
   */
  private async handleSessionRequest(event: SignClientTypes.EventArguments['session_request']): Promise<void> {
    console.info('[veilpay] WC session request', event);
    const { topic, id, params } = event;
    const { request, chainId } = params;
    // Store the request and open approval surface.
    await setPendingWcRequest({ topic, requestId: id, chainId, request });
    void openApprovalSurface();
  }

  /**
   * Handle session deletion (dapp disconnected).
   */
  private handleSessionDelete(event: SignClientTypes.EventArguments['session_delete']): void {
    console.info('[veilpay] WC session deleted', event);
    // A deleted session clears its pending request automatically: responding on
    // a dead topic would throw, so drop any parked request for that topic too.
    void clearPendingWcRequestForTopic(event.topic);
  }

  /**
   * Handle session expiration.
   */
  private handleSessionExpire(event: SignClientTypes.EventArguments['session_expire']): void {
    console.info('[veilpay] WC session expired', event);
    void clearPendingWcRequestForTopic(event.topic);
  }
}
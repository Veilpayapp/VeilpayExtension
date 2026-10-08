import { dispatch, ProtocolError, type HandlerMap } from '@/core/messaging/router';
import * as vault from '@/core/vault';
import { readMeta, writeMeta } from '@/core/vault/storage';
import { createChainService, TESTNET_ENDPOINTS } from '@/core/chains';
import { decimalAmountToBaseUnits } from '@/core/chains/amounts';
import { fetchTransactionHistoryCached } from '@/core/chains/indexer-service';
import {
  ZkCapability,
  type ChainId,
  type StellarAssetInput,
  type TokenInputType,
} from '@/core/messaging/protocol';
import { resolveRpcUrl } from '@/core/networks';
import { RpcFeeSource, estimateTransferFee } from '@/core/chains/evm/fees';
import {
  EVM_CHAIN_ID,
  signTransaction,
  signPersonalMessage,
  type UnsignedEvmTransaction,
} from '@/core/chains/evm/transaction';
import { signTypedData, type TypedData } from '@/core/chains/evm/eip712';
import {
  deriveAssociatedTokenAddress,
  parseSolanaTransaction,
  signSolanaMessage,
  signSolanaSplTransfer,
  signSolanaTransfer,
  signSolanaTransaction,
  type UnsignedSolanaSplTransfer,
  type UnsignedSolanaTransfer,
} from '@/core/chains/solana/transaction';
import { erc20TransferCalldata } from '@/core/chains/evm/erc20';
import { signStellarPayment, type UnsignedStellarPayment } from '@/core/chains/stellar/transaction';
import { base58 } from '@scure/base';
import { bytesToHex } from '@noble/hashes/utils';
import {
  getSecurityStatus,
  getWebAuthnChallenge,
  setupPin,
  verifyUserPin,
  setupWebAuthn,
} from '@/core/security';
import {
  listPermissions,
  grantPermission,
  revokeOrigin,
  getApprovedAddresses,
} from '@/core/permissions';
import {
  setPendingConnection,
  getPendingConnection,
  clearPendingConnection,
} from '@/background/connection-approval';
import {
  setPendingApproval,
  getPendingApproval,
  clearPendingApproval,
  waitForApproval,
  resolveApproval,
  VaultLockedApprovalError,
} from '@/background/transaction-approval';
import {
  setPendingX402Payment,
  getPendingX402Payment,
  clearPendingX402Payment,
  waitForX402Approval,
  resolveX402Approval,
  X402VaultLockedApprovalError,
} from '@/background/x402-approval';
import { validateChallenge } from '@/core/x402/challenge';
import { requestTestnetFaucet } from '@/core/chains/faucet';
import { signPaymentPayload } from '@/core/x402/payment';
import {
  getActiveGrantByOrigin,
  listGrants,
  revokeGrant,
  createGrant,
  type GrantCaps,
} from '@/core/vap/grant';
import { loadSpendWindow, recordSpend, requiresApproval } from '@/core/vap/decision';
import { requireGrantConfirmation } from '@/core/vap/confirmation';
import { appendAudit } from '@/core/vap/audit';
import {
  setPendingGrantRequest,
  getPendingGrantRequest,
  clearPendingGrantRequest,
  waitForGrantApproval,
  resolveGrantApproval,
  GrantVaultLockedApprovalError,
} from '@/background/grant-approval';
import { allowPrompt } from '@/background/prompt-limiter';
import {
  getWalletConnectClient,
  getPendingWcProposal,
  getPendingWcRequest,
  clearPendingWcRequest,
  initWalletConnect,
} from '@/background/walletconnect';
import {
  loadAgentBridgeConfig,
  saveAgentBridgeConfig,
  clearAgentBridgeConfig,
  startAgentBridgeLoop,
  type AgentBridgeLoop,
} from '@/background/agent-bridge';
import { openApprovalSurface } from '@/background/approval-surface';

/**
 * Background service worker — the only context that ever holds key material.
 *
 * MV3 terminates this worker aggressively. That is treated as a feature: an
 * eviction drops the in-memory mnemonic and forces a re-unlock. Nothing here may
 * assume it stays alive between messages, so all durable state goes to IndexedDB.
 */

const IDLE_ALARM = 'veilpay:idle-check';
const ZK_CAPABILITY_KEY = 'spike:zk-capability';

/**
 * Read-only EVM methods the injected provider may proxy to the node.
 *
 * Everything here is a pure read: balances, blocks, receipts, gas prices,
 * `eth_call`, and logs. Nothing here can move funds or reveal key material, so
 * it is safe to allow from any page without approval.
 */
const ALLOWED_EVM_READS = new Set([
  'eth_blockNumber',
  'eth_chainId',
  'eth_getBalance',
  'eth_getCode',
  'eth_getTransactionCount',
  'eth_getTransactionByHash',
  'eth_getTransactionReceipt',
  'eth_getBlockByNumber',
  'eth_getBlockByHash',
  'eth_getLogs',
  'eth_gasPrice',
  'eth_estimateGas',
  'eth_feeHistory',
  'eth_maxPriorityFeePerGas',
  'eth_call',
  'eth_syncing',
  'net_version',
  'web3_clientVersion',
]);

const handlers: HandlerMap = {
  ping: async (payload) => ({
    sentAt: payload.sentAt,
    receivedAt: Date.now(),
    roundTripHint: Date.now() - payload.sentAt,
  }),

  'vault.status': async () => ({
    state: await vault.getState(),
    unlockedUntil: vault.unlockedUntil(),
  }),

  'session.lock': async () => {
    vault.lock();
    return { state: await vault.getState() };
  },

  'zk.capability': async () => (await readMeta<ZkCapability>(ZK_CAPABILITY_KEY)) ?? null,

  'accounts.list': async (payload) => {
    try {
      const addresses = await vault.getAllAccountAddresses(payload.accountIndex);
      return addresses.map((address) => ({
        chain: address.chain,
        index: address.index,
        address: address.address,
        path: address.path,
      }));
    } catch (cause) {
      // A locked vault is an expected state, not a fault; the UI branches on it.
      if (cause instanceof vault.VaultLocked) {
        throw new ProtocolError('VAULT_LOCKED', 'Unlock the wallet to see your accounts.');
      }
      throw cause;
    }
  },

  /**
   * Balances are read here rather than in the UI so no extension page needs
   * network host permissions, and so a compromised page cannot see which
   * addresses are being queried.
   *
   * `bigint` is returned as a decimal string: it does not survive
   * `structuredClone` over the message bus, and JSON would silently lose
   * precision above 2^53.
   */
  'account.balance': async (payload) => {
    const service = createChainService(payload.chain);
    const balance = await service.getBalance(payload.address);
    return {
      chain: payload.chain,
      address: payload.address,
      balance: balance.toString(),
    };
  },

  /**
   * Transaction history. Runs here, in the service worker, because host
   * permissions grant cross-origin fetch access in this context only —
   * extension pages (popup/sidepanel/options) are subject to CORS like any web
   * page. The UI receives history over the typed bus instead of fetching it.
   */
  'indexer.history': async (payload) => {
    const history = await fetchTransactionHistoryCached(
      payload.chain,
      payload.address,
      payload.limit
    );
    return history;
  },

  /**
   * Fee preview for a transfer. Nothing is broadcast; the UI shows this before
   * asking the user to confirm.
   *
   * EVM estimates gas + EIP-1559 fees from live RPC. Solana and Stellar use
   * their current base fees (Stellar reads `fee_stats` live).
   */
  'tx.estimate': async (payload) => {
    let address: string;
    try {
      address = (await vault.getAccountAddress(payload.chain, payload.index)).address;
    } catch (cause) {
      if (cause instanceof vault.VaultLocked) {
        throw new ProtocolError('VAULT_LOCKED', 'Unlock the wallet to estimate the fee.');
      }
      throw cause;
    }

    const descriptor = normalizeToken(payload.token, payload.asset);
    const token = await resolveToken(payload.chain, descriptor, address);

    const amount = parseTransferAmount(
      payload.amount,
      payload.chain,
      'tx.estimate',
      token.decimals
    );
    if (amount <= 0n) {
      throw new ProtocolError('BAD_REQUEST', 'Amount must be greater than zero.');
    }

    switch (payload.chain) {
      case 'evm': {
        const isErc20 = descriptor.kind === 'erc20';
        const data =
          isErc20 && typeof descriptor.address === 'string'
            ? erc20TransferCalldata(payload.to, amount)
            : undefined;
        const source = new RpcFeeSource();
        const fees = await estimateTransferFee(
          source,
          address,
          isErc20 ? descriptor.address : payload.to,
          amount,
          data
        );
        return {
          chain: 'evm',
          from: address,
          feeNative: fees.totalFeeWei.toString(),
          gasLimit: fees.gasLimit.toString(),
          decimals: token.decimals,
          spendableBalance: token.spendable.toString(),
          symbol: token.symbol,
        };
      }
      case 'solana': {
        const service = createChainService(
          'solana',
          await resolveRpcUrl('solana', TESTNET_ENDPOINTS.solana)
        );
        const fee = await service.estimateGas({});
        return {
          chain: 'solana',
          from: address,
          feeNative: fee.toString(), // current lamports fee
          gasLimit: '1',
          decimals: token.decimals,
          spendableBalance: token.spendable.toString(),
          symbol: token.symbol,
        };
      }
      case 'stellar': {
        const baseFee = await fetchStellarBaseFee();
        const base: {
          chain: 'stellar';
          from: string;
          feeNative: string;
          gasLimit: string;
          assetCode?: string;
          decimals: number;
          spendableBalance: string;
          symbol: string;
        } = {
          chain: 'stellar',
          from: address,
          feeNative: baseFee.toString(), // live base fee in stroops
          gasLimit: '1',
          decimals: token.decimals,
          spendableBalance: token.spendable.toString(),
          symbol: token.symbol,
        };
        if (descriptor.kind === 'stellar-issued') {
          base.assetCode = descriptor.code;
        }
        return base;
      }
      default:
        throw new ProtocolError('BAD_REQUEST', 'Unsupported chain.');
    }
  },

  /**
   * Builds, signs, and broadcasts a transfer.
   *
   * Signing happens inside `vault.withAccount`, which derives the key, hands it
   * to the callback, and zeroizes it on return — so the private key never exists
   * outside the service worker and is never on the message bus. The returned
   * sender is cross-checked against the signing key's address before broadcast.
   */
  'tx.transfer': async (payload) => {
    let address: string;
    try {
      address = (await vault.getAccountAddress(payload.chain, payload.index)).address;
    } catch (cause) {
      if (cause instanceof vault.VaultLocked) {
        throw new ProtocolError('VAULT_LOCKED', 'Unlock the wallet to send funds.');
      }
      throw cause;
    }

    // Resolve the token's precision and the sender's spendable balance, convert
    // the human-readable amount to base units, and validate the balance before
    // signing so a low balance surfaces as a clear INSUFFICIENT_BALANCE instead
    // of an opaque node rejection.
    const descriptor = normalizeToken(payload.token, payload.asset);
    const token = await resolveToken(payload.chain, descriptor, address);
    const amount = parseTransferAmount(
      payload.amount,
      payload.chain,
      'tx.transfer',
      token.decimals
    );
    if (amount <= 0n) {
      throw new ProtocolError('BAD_REQUEST', 'Amount must be greater than zero.');
    }

    try {
      const result = await buildAndBroadcast(
        payload,
        amount,
        descriptor,
        token.decimals,
        token.spendable
      );
      return { ...result, decimals: token.decimals };
    } catch (cause) {
      if (cause instanceof vault.VaultLocked) {
        // A locked vault is an expected state the UI branches on, so surface it
        // as VAULT_LOCKED rather than letting the router flatten it to INTERNAL.
        throw new ProtocolError('VAULT_LOCKED', 'Unlock the wallet to send funds.');
      }
      // Surface the chain/node rejection to the popup so a failed broadcast
      // tells the truth ("insufficient funds", "nonce too low") instead of the
      // opaque INTERNAL fallback. Display-safe by construction: node messages
      // carry no key material.
      //
      // For Stellar the rejection carries an `extras.result_codes` object
      // (e.g. {"transaction":"tx_bad_seq","operations":["op_underfunded"]});
      // that is THE diagnostic, so pull it out and keep it verbatim instead of
      // truncating it away with the verbose Horizon preamble.
      if (cause instanceof ProtocolError) {
        throw cause;
      }
      if (cause instanceof Error && cause.message.length > 0) {
        const noHex = cause.message.replace(/0x[0-9a-fA-F]{6,}/g, '0x…');
        const codesMatch = noHex.match(/"transaction":"[\w]+"|"operations":\[[^\]]*\]/g);
        if (cause.message.includes('result_codes') && codesMatch !== null) {
          const codes = codesMatch.join(', ');
          const detailMatch = cause.message.match(/— ([^—]+) — result_codes/s);
          const detail = detailMatch ? detailMatch[1]!.trim() : '';
          const suffix = [detail, `result_codes: ${codes}`].filter(Boolean).join(' — ');
          throw new ProtocolError('TX_REJECTED', `The network rejected the transaction: ${suffix}`);
        }
        const safe = noHex.slice(0, 240);
        throw new ProtocolError('TX_REJECTED', `The network rejected the transaction: ${safe}`);
      }
      throw cause;
    }
  },

  /**
   * Returns a fresh phrase for the user to record, and persists nothing.
   *
   * This is the one response that legitimately carries a secret, which is why
   * the router restricts the kind to extension-owned surfaces. It becomes
   * durable only if the user follows up with `vault.create`.
   */
  'mnemonic.generate': async (payload) => ({
    mnemonic: vault.generateMnemonic(payload.strength),
  }),

  /**
   * Phrase validity is checked here rather than relying on the vault's own bare
   * `Error`, so every rejection below is an authored, display-safe string and
   * anything unrecognised still flattens to INTERNAL in the router.
   */
  'vault.create': async (payload) => {
    if (!vault.validateMnemonic(payload.mnemonic)) {
      throw new ProtocolError('BAD_REQUEST', 'That recovery phrase is not a valid BIP-39 phrase.');
    }

    try {
      await vault.create(payload.mnemonic, payload.passphrase);
    } catch (cause) {
      if (cause instanceof vault.WeakPassphrase || cause instanceof vault.VaultAlreadyExists) {
        throw new ProtocolError('BAD_REQUEST', cause.message);
      }
      throw cause;
    }

    ensureIdleAlarm();
    return { state: await vault.getState() };
  },

  'vault.unlock': async (payload) => {
    if ((await vault.getState()) === 'uninitialized') {
      throw new ProtocolError('BAD_REQUEST', 'There is no wallet on this device yet.');
    }

    try {
      await vault.unlock(payload.passphrase);
    } catch (cause) {
      if (cause instanceof vault.DecryptionFailed) {
        // Deliberately uniform: a caller must not be able to tell a wrong
        // secret from a damaged vault.
        throw new ProtocolError('BAD_REQUEST', 'Could not unlock the wallet.');
      }
      throw cause;
    }

    // Re-armed here as well as on install, so a wallet unlocked after an alarm
    // was lost still relocks on schedule.
    ensureIdleAlarm();
    return { state: await vault.getState(), unlockedUntil: vault.unlockedUntil() };
  },

  /**
   * Destructive and irreversible without the recovery phrase.
   *
   * The schema pins `confirmation` to the literal `'DELETE'`, so arriving here
   * means the UI collected an explicit typed confirmation; there is no second
   * check to make that Zod has not already made.
   */
  'vault.reset': async () => {
    await vault.reset();
    return { state: await vault.getState() };
  },

  /**
   * Security settings for the setup flow. Safe to call while locked — PIN and
   * WebAuthn unlock are configured before a wallet has a passphrase.
   */
  'security.status': async () => getSecurityStatus(),

  'security.pin.setup': async (payload) => setupPin(payload.pin),

  'security.pin.verify': async (payload) => verifyUserPin(payload.pin),

  'security.webauthn.setup': async () => setupWebAuthn(),

  /**
   * Starts a WebAuthn ceremony for grant confirmation (VAP-01).
   *
   * The UI presents the returned challenge to the platform authenticator and
   * reports success via `vap.grant.resolve`'s `webauthn` flag. `navigator.credentials`
   * is not available in the service worker, so the ceremony runs in the UI; the
   * flag travels the privileged resolve kind.
   */
  'security.webauthn.challenge': async () => {
    const challenge = await getWebAuthnChallenge();
    if (challenge === null) {
      throw new ProtocolError('BAD_REQUEST', 'No passkey is registered on this device.');
    }
    return {
      credentialId: challenge.credentialId,
      challenge: bytesToHex(challenge.challenge),
    };
  },

  /**
   * EIP-1193 provider handlers.
   * eth.chainId and eth.accounts are read-only and safe to call from any origin.
   * eth.requestAccounts, eth.sendTransaction, and personal.sign require the
   * vault to be unlocked (checked by the downstream handlers).
   */

  'eth.chainId': async () => ({
    chainId: `0x${EVM_CHAIN_ID.toString(16)}`,
  }),

  /**
   * EIP-1193 `wallet_switchEthereumChain`.
   *
   * The wallet is single-chain (Sepolia), so the only valid target is the
   * current chain; anything else fails with CHAIN_UNSUPPORTED (mapped to
   * EIP-1193 4902 by the inpage shim). The inpage emits `chainChanged` to the
   * dapp after a successful switch.
   */
  'eth.switchChain': async (payload) => {
    const requested = payload.chainId.toLowerCase();
    const current = `0x${EVM_CHAIN_ID.toString(16)}`.toLowerCase();
    if (requested !== current) {
      throw new ProtocolError(
        'CHAIN_UNSUPPORTED',
        `Unrecognized chain ID ${payload.chainId}. Veilpay supports Sepolia (${current}).`
      );
    }
    return { chainId: current };
  },

  'eth.requestAccounts': async (_payload, ctx) => {
    const state = await vault.getState();
    if (state !== 'unlocked') {
      throw new ProtocolError('VAULT_LOCKED', 'Unlock the wallet first.');
    }
    // The origin check keys on the Chrome-stamped page origin (from the router),
    // never on a self-asserted payload field.
    const origin = ctx.pageOrigin;
    if (origin === null) {
      throw new ProtocolError('ORIGIN_DENIED', 'Could not verify the requesting origin.');
    }
    const accounts = await vault.getAllAccountAddresses(0);
    const evmAccounts = accounts.filter((a) => a.chain === 'evm').map((a) => a.address);

    // Never auto-grant. A dapp only ever sees addresses the user has explicitly
    // approved; granting here would hand every account to any page that calls
    // the bridge, permanently. New origins get a pending connection request
    // surfaced to the popup instead.
    const approved = await getApprovedAddresses(origin);
    if (approved.length === 0) {
      // No grant yet — register a pending request and prompt the user.
      const allAccounts = await vault.getAllAccountAddresses(0);
      await setPendingConnection({
        origin,
        requestedAccounts: allAccounts
          .filter((a) => a.chain === 'evm')
          .map((a) => ({ chain: a.chain, address: a.address })),
        createdAt: Date.now(),
      });
      void openApprovalSurface();
      return { accounts: [] };
    }
    return { accounts: evmAccounts.filter((addr) => approved.includes(addr)) };
  },

  'eth.accounts': async (_payload, ctx) => {
    const state = await vault.getState();
    if (state !== 'unlocked') {
      return { accounts: [] };
    }
    const origin = ctx.pageOrigin;
    if (origin === null) {
      return { accounts: [] };
    }
    const approved = await getApprovedAddresses(origin);
    return { accounts: approved };
  },

  'eth.sendTransaction': async (payload, ctx) => {
    const origin = ctx.pageOrigin;
    if (origin === null) {
      throw new ProtocolError('ORIGIN_DENIED', 'Could not verify the requesting origin.');
    }
    const approved = await getApprovedAddresses(origin);
    if (approved.length === 0) {
      throw new ProtocolError('ORIGIN_DENIED', 'No accounts approved for this origin.');
    }

    // The sender is the dapp's `from` when it named an approved account,
    // otherwise the first approved EVM address (dapps routinely omit `from`).
    const from = await pickApprovedEvmAddress(payload.tx.from, approved);
    const accountIndex = await findEvmAccountIndex(from);
    if (accountIndex === null) {
      throw new ProtocolError('BAD_REQUEST', 'Sender is not a wallet account.');
    }

    // Park the request until a human decides. The dapp's message channel stays
    // open; `tx.resolve` (from our own UI) settles the waiter.
    const id = crypto.randomUUID();
    const record: Parameters<typeof setPendingApproval>[0] = {
      id,
      kind: 'tx',
      origin,
      address: from,
      createdAt: Date.now(),
    };
    if (payload.tx.to !== undefined) record.to = payload.tx.to;
    if (payload.tx.value !== undefined) {
      record.value = normalizeWei(payload.tx.value).toString();
    }
    if (payload.tx.data !== undefined) record.data = payload.tx.data;
    await setPendingApproval(record);
    void openApprovalSurface();

    let decision;
    try {
      decision = await waitForApproval(id);
    } catch (cause) {
      if (cause instanceof VaultLockedApprovalError) {
        throw new ProtocolError('VAULT_LOCKED', cause.message);
      }
      throw cause;
    }
    if (decision === 'deny') {
      throw new ProtocolError('USER_REJECTED', 'User rejected the transaction.');
    }

    // Approved — sign and broadcast with the vault's key, inside withAccount so
    // the private key never outlives the call.
    return vault.withAccount('evm', accountIndex, async (account) => {
      const service = createChainService('evm');
      const source = new RpcFeeSource();

      const value = payload.tx.value === undefined ? 0n : normalizeWei(payload.tx.value);
      const data = payload.tx.data === undefined ? undefined : hexToBytesStrict(payload.tx.data);
      const to = payload.tx.to ?? account.address;

      const [nonce, fees] = await Promise.all([
        service.getSequence(account.address),
        estimateTransferFee(source, account.address, to, value, data),
      ]);

      const unsigned: UnsignedEvmTransaction = {
        chainId: EVM_CHAIN_ID,
        nonce,
        maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
        maxFeePerGas: fees.maxFeePerGas,
        gasLimit: fees.gasLimit,
        to,
        value,
      };
      if (data !== undefined) unsigned.data = data;

      const signed = signTransaction(unsigned, account.privateKey);
      if (signed.from.toLowerCase() !== account.address.toLowerCase()) {
        throw new Error('Signer address does not match the derived account.');
      }

      const hash = await service.sendTransaction(signed.raw);
      return { hash };
    });
  },

  'personal.sign': async (payload, ctx) => {
    const origin = ctx.pageOrigin;
    if (origin === null) {
      throw new ProtocolError('ORIGIN_DENIED', 'Could not verify the requesting origin.');
    }
    const approved = await getApprovedAddresses(origin);
    if (approved.length === 0) {
      throw new ProtocolError('ORIGIN_DENIED', 'No accounts approved for this origin.');
    }
    if (!approved.some((addr) => addr.toLowerCase() === payload.address.toLowerCase())) {
      throw new ProtocolError('ORIGIN_DENIED', 'Signing address is not approved for this origin.');
    }

    const accountIndex = await findEvmAccountIndex(payload.address);
    if (accountIndex === null) {
      throw new ProtocolError('BAD_REQUEST', 'Signing address is not a wallet account.');
    }

    // Park the request until a human decides, then sign with the vault key.
    const id = crypto.randomUUID();
    await setPendingApproval({
      id,
      kind: 'sign',
      origin,
      address: payload.address,
      message: payload.message,
      createdAt: Date.now(),
    });
    void openApprovalSurface();

    let decision;
    try {
      decision = await waitForApproval(id);
    } catch (cause) {
      if (cause instanceof VaultLockedApprovalError) {
        throw new ProtocolError('VAULT_LOCKED', cause.message);
      }
      throw cause;
    }
    if (decision === 'deny') {
      throw new ProtocolError('USER_REJECTED', 'User rejected the signature request.');
    }

    return vault.withAccount('evm', accountIndex, async (account) => {
      const message = hexToBytesStrict(payload.message);
      const { signature, from } = signPersonalMessage(message, account.privateKey);
      if (from.toLowerCase() !== account.address.toLowerCase()) {
        throw new Error('Signer address does not match the derived account.');
      }
      return { signature };
    });
  },

  /**
   * Read-only EVM JSON-RPC passthrough for dapps.
   *
   * Dapps call `eth_getBalance`, `eth_blockNumber`, `eth_call`, `eth_getCode`,
   * etc. the moment they connect. Those are safe to proxy from the SW (it has
   * host permissions); they never sign or broadcast. Only a strict allowlist is
   * forwarded so the page cannot trick the wallet into calling anything else.
   */
  'eth.rpc': async (payload) => {
    if (!ALLOWED_EVM_READS.has(payload.method)) {
      throw new ProtocolError('UNKNOWN_KIND', `RPC method "${payload.method}" is not allowed.`);
    }
    const service = createChainService('evm');
    if (typeof service.rpcCall !== 'function') {
      throw new ProtocolError('INTERNAL', 'EVM read passthrough is unavailable.');
    }
    const result = await service.rpcCall(payload.method, payload.params);
    return { result };
  },

  /**
   * EIP-712 typed-data signing (`eth_signTypedData_v4`).
   *
   * Mirrors `personal.sign`: the origin must be approved, the address must be a
   * wallet account, the user approves in the popup, then the background hashes
   * per EIP-712 and signs inside `withAccount`.
   */
  'eth.signTypedData': async (payload, ctx) => {
    const origin = ctx.pageOrigin;
    if (origin === null) {
      throw new ProtocolError('ORIGIN_DENIED', 'Could not verify the requesting origin.');
    }
    const approved = await getApprovedAddresses(origin);
    if (approved.length === 0) {
      throw new ProtocolError('ORIGIN_DENIED', 'No accounts approved for this origin.');
    }
    if (!approved.some((addr) => addr.toLowerCase() === payload.address.toLowerCase())) {
      throw new ProtocolError('ORIGIN_DENIED', 'Signing address is not approved for this origin.');
    }
    const accountIndex = await findEvmAccountIndex(payload.address);
    if (accountIndex === null) {
      throw new ProtocolError('BAD_REQUEST', 'Signing address is not a wallet account.');
    }

    const typedData = payload.typedData as TypedData;
    const id = crypto.randomUUID();
    await setPendingApproval({
      id,
      kind: 'sign',
      origin,
      address: payload.address,
      message: JSON.stringify({ primaryType: typedData?.primaryType ?? 'TypedData' }),
      createdAt: Date.now(),
    });
    void openApprovalSurface();

    let decision;
    try {
      decision = await waitForApproval(id);
    } catch (cause) {
      if (cause instanceof VaultLockedApprovalError) {
        throw new ProtocolError('VAULT_LOCKED', cause.message);
      }
      throw cause;
    }
    if (decision === 'deny') {
      throw new ProtocolError('USER_REJECTED', 'User rejected the signature request.');
    }

    return vault.withAccount('evm', accountIndex, async (account) => {
      const { signature, from } = signTypedData(typedData, account.privateKey);
      if (from.toLowerCase() !== account.address.toLowerCase()) {
        throw new Error('Signer address does not match the derived account.');
      }
      return { signature };
    });
  },

  'permissions.list': async () => listPermissions(),

  'permissions.grant': async (payload) => {
    await grantPermission(payload.origin, payload.addresses);
    return { ok: true };
  },

  'permissions.revoke': async (payload) => {
    await revokeOrigin(payload.origin);
    return { ok: true };
  },

  'permissions.pending': async () => getPendingConnection(),

  /**
   * Resolves the pending dapp connection request.
   *
   * `approve` persists a real grant and clears the pending record; `deny` just
   * clears it. This is privileged (router), so only our own UI can invoke it —
   * a page cannot resolve its own approval. The granted addresses are validated
   * against the wallet's own accounts so the UI cannot mint arbitrary grants
   * either.
   */
  'permissions.connection': async (payload) => {
    const pending = await getPendingConnection();
    if (pending === null || pending.origin !== payload.origin) {
      throw new ProtocolError('BAD_REQUEST', 'No pending connection for that origin.');
    }

    if (payload.action === 'deny') {
      await clearPendingConnection();
      return { ok: true };
    }

    // Approve: intersect the requested addresses with the wallet's real accounts
    // so we never persist a grant to an address this wallet does not own.
    const accounts = await vault.getAllAccountAddresses(0);
    const owned = new Set(accounts.map((a) => a.address.toLowerCase()));
    const granted = payload.addresses.filter((addr) => owned.has(addr.toLowerCase()));
    await grantPermission(payload.origin, granted);
    await clearPendingConnection();
    return { ok: true };
  },

  /**
   * Reads the pending dapp transaction/signature request, or null.
   *
   * The UI polls this while deciding whether to show an approval overlay. A
   * request registered in a previous service-worker lifetime (e.g. the popup
   * opened after the worker was evicted) is still readable from session
   * storage; its waiter is gone, but the UI can still surface it and the user
   * can approve/deny — the original dapp call will have timed out.
   */
  'tx.pending': async () => {
    const pending = await getPendingApproval();
    if (pending === null) return null;
    const view: {
      id: string;
      kind: 'tx' | 'sign';
      origin: string;
      address: string;
      createdAt: number;
      to?: string;
      value?: string;
      data?: string;
      message?: string;
    } = {
      id: pending.id,
      kind: pending.kind,
      origin: pending.origin,
      address: pending.address,
      createdAt: pending.createdAt,
    };
    if (pending.to !== undefined) view.to = pending.to;
    if (pending.value !== undefined) view.value = pending.value;
    if (pending.data !== undefined) view.data = pending.data;
    if (pending.message !== undefined) view.message = pending.message;
    return view;
  },

  /**
   * Resolves a pending dapp transaction/signature request.
   *
   * Privileged (router): only our own UI surface can decide whether a page's
   * transaction is signed or its message is signed. `approve` wakes the
   * original handler, which then signs inside `vault.withAccount`; `deny`
   * wakes it to throw USER_REJECTED.
   */
  'tx.resolve': async (payload) => {
    const pending = await getPendingApproval();
    if (pending === null || pending.id !== payload.id) {
      throw new ProtocolError('BAD_REQUEST', 'No pending approval with that id.');
    }

    // Settle the waiter first so the awaiting handler can proceed, then clear
    // the record so a stale approval is never re-surfaced.
    const settled = resolveApproval(payload.id, payload.action);
    await clearPendingApproval();
    if (!settled) {
      // The service worker restarted while the user was deciding — the original
      // dapp call is gone, but the request is still consumed.
      console.warn('[veilpay] approval resolved after its waiter was lost');
    }
    return { ok: true };
  },

  /**
   * x402 consumer flow — a page replays its 402-gated request with the
   * `X-PAYMENT` header this handler returns.
   *
   * The challenge is validated before anything is signed or any prompt is
   * shown. On approval the payment payload is EIP-191 personal_signed inside
   * `vault.withAccount`, so the private key never outlives the call and never
   * crosses the message bus. The page replays its original request with the
   * returned header; the provider verifies the signature statelessly.
   */
  'x402.pay': async (payload, ctx) => {
    const state = await vault.getState();
    if (state !== 'unlocked') {
      throw new ProtocolError('VAULT_LOCKED', 'Unlock the wallet first.');
    }
    const origin = ctx.pageOrigin;
    if (origin === null) {
      throw new ProtocolError('ORIGIN_DENIED', 'Could not verify the requesting origin.');
    }

    // Reject forged/expired/replayed challenges before any signing or prompt.
    const validation = validateChallenge(payload.challenge, origin);
    if (!validation.valid) {
      throw new ProtocolError('X402_INVALID_CHALLENGE', validation.reason);
    }
    const challenge = validation.challenge;
    const amount = BigInt(challenge.amount);

    // A VAP grant for this origin can auto-approve payments within its caps,
    // removing the prompt for low-value payments the user has pre-authorized.
    const grant = await getActiveGrantByOrigin(origin);
    if (grant !== null) {
      const window = await loadSpendWindow(grant);
      const decision = requiresApproval(
        grant,
        { type: 'x402.pay', amount, chain: 'evm', recipient: challenge.payTo },
        BigInt(window.amountSpent)
      );
      if (decision.action === 'deny') {
        void appendAudit('op.denied', {
          origin,
          chain: 'evm',
          amount: challenge.amount,
          nonce: challenge.nonce,
          resource: challenge.resource,
          grantId: grant.id,
          reason: decision.reason,
        });
        throw new ProtocolError(
          'X402_INVALID_CHALLENGE',
          `Payment denied by grant policy (${decision.reason}).`
        );
      }
      if (decision.action === 'auto') {
        const { header } = await vault.withAccount('evm', 0, async (account) => {
          return signPaymentPayload(challenge, account.privateKey, account.address);
        });
        await recordSpend(grant, amount);
        void appendAudit('op.settled', {
          origin,
          chain: 'evm',
          amount: challenge.amount,
          nonce: challenge.nonce,
          resource: challenge.resource,
          grantId: grant.id,
          approvedBy: 'grant',
        });
        return { paymentHeader: header };
      }
      // decision.action === 'required': fall through to the prompt path.
    }

    // Consent-fatigue defense (spec §9): no more than 5 prompts per origin per
    // minute. A burst is auto-denied, not queued.
    if (!allowPrompt(origin)) {
      throw new ProtocolError(
        'PROMPT_RATE_LIMITED',
        'Too many approval requests from this origin. Try again in a minute.'
      );
    }

    // Park the payment request until a human decides, then sign the payload.
    const id = crypto.randomUUID();
    await setPendingX402Payment({
      id,
      kind: 'x402.pay',
      origin,
      challenge,
      createdAt: Date.now(),
    });
    void openApprovalSurface();

    let decision;
    try {
      decision = await waitForX402Approval(id);
    } catch (cause) {
      if (cause instanceof X402VaultLockedApprovalError) {
        throw new ProtocolError('VAULT_LOCKED', cause.message);
      }
      throw cause;
    }
    if (decision === 'deny') {
      throw new ProtocolError('USER_REJECTED', 'User rejected the payment.');
    }

    void appendAudit('op.approved', {
      origin,
      chain: 'evm',
      amount: challenge.amount,
      nonce: challenge.nonce,
      resource: challenge.resource,
      approvedBy: 'user',
    });

    // The first EVM account is the payer for this slice; the overlay showed the
    // user exactly who receives what before approving.
    const paymentHeader = await vault.withAccount('evm', 0, async (account) => {
      const { header } = signPaymentPayload(challenge, account.privateKey, account.address);
      return header;
    });
    void appendAudit('op.settled', {
      origin,
      chain: 'evm',
      amount: challenge.amount,
      nonce: challenge.nonce,
      resource: challenge.resource,
      approvedBy: 'user',
    });
    if (grant !== null) await recordSpend(grant, amount);
    await clearPendingX402Payment();
    return { paymentHeader };
  },

  /**
   * Resolves a pending x402 payment.
   *
   * Privileged (router): only our own UI surface can decide whether a page's
   * payment is signed. `approve` wakes the awaiting `x402.pay` handler, which
   * then signs inside `vault.withAccount`; `deny` wakes it to throw
   * USER_REJECTED.
   */
  'x402.resolve': async (payload) => {
    const pending = await getPendingX402Payment();
    if (pending === null || pending.id !== payload.id) {
      throw new ProtocolError('BAD_REQUEST', 'No pending payment with that id.');
    }

    // Settle the waiter first so the awaiting handler can proceed, then clear
    // the record so a stale payment is never re-surfaced.
    const settled = resolveX402Approval(payload.id, payload.action);
    await clearPendingX402Payment();
    if (!settled) {
      console.warn('[veilpay] x402 payment resolved after its waiter was lost');
    }
    return { ok: true };
  },

  /**
   * Reads the pending x402 payment, or null.
   *
   * Mirrors `tx.pending`: the popup reads this on open to decide whether to
   * render the approval overlay, including when the service worker restarted
   * while the user was deciding (the original page call has timed out, but the
   * request is still consumable).
   */
  'x402.pending': async () => {
    const pending = await getPendingX402Payment();
    if (pending === null) return null;
    return {
      id: pending.id,
      origin: pending.origin,
      challenge: pending.challenge,
      createdAt: pending.createdAt,
    };
  },

  /**
   * Lists active VAP grants for settings display.
   *
   * Read-only and safe from any surface: grants carry no key material and
   * reveal no addresses.
   */
  'vap.grants.list': async () => listGrants(),

  /**
   * Revokes a VAP grant by id.
   *
   * Privileged (router): only our own surfaces may remove an origin's standing
   * payment authority. Because `getActiveGrantByOrigin` filters revoked grants,
   * revocation takes effect before the next `x402.pay` returns (VAP-04).
   */
  'vap.grant.revoke': async (payload) => {
    await revokeGrant(payload.id);
    void appendAudit('grant.revoked', { grantId: payload.id });
    return { ok: true };
  },

  /**
   * Agent grant negotiation — a page requests a grant.
   *
   * Always prompts: the requested caps are parked in session storage, the
   * approval surface opens, and the grant is created only after the user
   * approves (grant negotiation is never silent). The origin is the
   * Chrome-stamped page origin, so a page cannot request a grant for another
   * origin.
   */
  'vap.grant.request': async (payload, ctx) => {
    const state = await vault.getState();
    if (state !== 'unlocked') {
      throw new ProtocolError('VAULT_LOCKED', 'Unlock the wallet first.');
    }
    const origin = ctx.pageOrigin;
    if (origin === null) {
      throw new ProtocolError('ORIGIN_DENIED', 'Could not verify the requesting origin.');
    }

    // Consent-fatigue defense (spec §9).
    if (!allowPrompt(origin)) {
      throw new ProtocolError(
        'PROMPT_RATE_LIMITED',
        'Too many grant requests from this origin. Try again in a minute.'
      );
    }

    // The page proposes caps; the user sees them verbatim in the overlay and can
    // refuse. The schema caps the lifetime at 90 days.
    const caps: GrantCaps = payload.caps;
    const id = crypto.randomUUID();
    await setPendingGrantRequest({
      id,
      origin,
      requestedCaps: caps,
      expiresInSeconds: payload.expiresInSeconds,
      createdAt: Date.now(),
    });
    void openApprovalSurface();

    let decision;
    try {
      decision = await waitForGrantApproval(id);
    } catch (cause) {
      if (cause instanceof GrantVaultLockedApprovalError) {
        throw new ProtocolError('VAULT_LOCKED', cause.message);
      }
      throw cause;
    }
    if (decision === 'deny') {
      throw new ProtocolError('USER_REJECTED', 'User rejected the grant request.');
    }

    const grant = await createGrant({
      clientId: origin,
      clientLabel: origin,
      caps,
      expiresAt: Date.now() + payload.expiresInSeconds * 1000,
    });
    void appendAudit('grant.created', {
      grantId: grant.id,
      clientId: origin,
      maxPerOperation: caps.maxPerOperation,
      maxPerWindow: caps.maxPerWindow,
      windowSeconds: caps.windowSeconds,
      approvalThreshold: caps.approvalThreshold,
    });
    await clearPendingGrantRequest();
    return { grantId: grant.id };
  },

  /**
   * Resolves a pending grant request.
   *
   * Privileged (router): only our own UI surface may create or refuse a grant.
   * `approve` wakes the awaiting `vap.grant.request` handler, which creates the
   * grant; `deny` wakes it to throw USER_REJECTED.
   */
  'vap.grant.resolve': async (payload) => {
    const pending = await getPendingGrantRequest();
    if (pending === null || pending.id !== payload.id) {
      throw new ProtocolError('BAD_REQUEST', 'No pending grant request with that id.');
    }

    // VAP-01: a grant cannot be created without PIN or WebAuthn confirmation.
    // The gate decides which method applies; the PIN value is verified here, at
    // the authorization boundary, before the waiter settles — a failed check
    // leaves the grant uncreated.
    if (payload.action === 'approve') {
      const status = await getSecurityStatus();
      // Build the attempt without a `pin` key when absent (exactOptionalPropertyTypes
      // forbids passing `undefined` to an optional property).
      const attempt: { pin?: string; webauthn: boolean } = {
        webauthn: payload.webauthn === true,
      };
      if (payload.pin !== undefined) attempt.pin = payload.pin;
      const confirmation = requireGrantConfirmation(status, attempt);
      if (!confirmation.ok) {
        throw new ProtocolError('BAD_REQUEST', confirmation.reason);
      }
      if (status.pinEnabled) {
        const { ok } = await verifyUserPin(payload.pin as string);
        if (!ok) {
          throw new ProtocolError('BAD_REQUEST', 'Incorrect PIN. The grant was not created.');
        }
      }
    }

    const settled = resolveGrantApproval(payload.id, payload.action);
    await clearPendingGrantRequest();
    if (!settled) {
      console.warn('[veilpay] grant request resolved after its waiter was lost');
    }
    return { ok: true };
  },

  /** Reads the pending grant request, or null. Mirrors `x402.pending`. */
  'vap.grant.pending': async () => {
    const pending = await getPendingGrantRequest();
    if (pending === null) return null;
    return {
      id: pending.id,
      origin: pending.origin,
      requestedCaps: pending.requestedCaps,
      expiresInSeconds: pending.expiresInSeconds,
      createdAt: pending.createdAt,
    };
  },

  'account.exportKey': async (payload) => {
    const state = await vault.getState();
    if (state !== 'unlocked') {
      throw new ProtocolError('VAULT_LOCKED', 'Unlock the wallet first.');
    }
    const hexKey = await vault.withAccount(payload.chain, payload.index, async (account) => {
      const bytes = account.privateKey;
      let hex = '';
      for (const b of bytes) {
        hex += b.toString(16).padStart(2, '0');
      }
      return hex;
    });
    // Get the address separately.
    const addr = await vault.getAccountAddress(payload.chain, payload.index);
    return { privateKey: hexKey, address: addr.address };
  },

  'solana.connect': async (_payload, ctx) => {
    const state = await vault.getState();
    if (state !== 'unlocked') {
      throw new ProtocolError('VAULT_LOCKED', 'Unlock the wallet first.');
    }
    const origin = ctx.pageOrigin;
    if (origin === null) {
      throw new ProtocolError('ORIGIN_DENIED', 'Could not verify the requesting origin.');
    }
    const accounts = await vault.getAllAccountAddresses(0);
    const solana = accounts.find((a) => a.chain === 'solana');
    if (!solana) {
      throw new ProtocolError('BAD_REQUEST', 'No Solana account found.');
    }
    // No auto-grant: only return the public key if this origin has already been
    // explicitly approved (matching the EVM requestAccounts behaviour). New
    // origins get a pending connection request surfaced to the popup.
    const approved = await getApprovedAddresses(origin);
    if (!approved.includes(solana.address)) {
      await setPendingConnection({
        origin,
        requestedAccounts: [{ chain: 'solana', address: solana.address }],
        createdAt: Date.now(),
      });
      void openApprovalSurface();
      throw new ProtocolError('CONNECT_PENDING', 'Awaiting approval for this origin.');
    }
    return { publicKey: solana.address };
  },

  'solana.signTransaction': async (payload, ctx) => {
    const origin = ctx.pageOrigin;
    if (origin === null) {
      throw new ProtocolError('ORIGIN_DENIED', 'Could not verify the requesting origin.');
    }
    const approved = await getApprovedAddresses(origin);
    if (approved.length === 0) {
      throw new ProtocolError('ORIGIN_DENIED', 'No accounts approved for this origin.');
    }

    // The dapp's serialized transaction names the signer; pick a wallet account
    // that is both approved and a required signer of this transaction.
    let parsed: {
      message: Uint8Array;
      accountKeys: string[];
      numRequiredSignatures: number;
      feePayerIndex: number;
    } | null = null;
    try {
      parsed = parseSolanaTransaction(payload.transaction);
    } catch {
      throw new ProtocolError('BAD_REQUEST', 'Could not parse the Solana transaction.');
    }
    const signerAddress = parsed.accountKeys[parsed.feePayerIndex];
    if (signerAddress === undefined) {
      throw new ProtocolError('BAD_REQUEST', 'Solana transaction has no fee payer.');
    }
    if (!approved.includes(signerAddress)) {
      throw new ProtocolError(
        'ORIGIN_DENIED',
        'Transaction signer is not approved for this origin.'
      );
    }
    const accountIndex = await findSolanaAccountIndex(signerAddress);
    if (accountIndex === null) {
      throw new ProtocolError('BAD_REQUEST', 'Transaction signer is not a wallet account.');
    }

    // Park the request until a human decides, then sign with the vault key.
    const id = crypto.randomUUID();
    await setPendingApproval({
      id,
      kind: 'sign',
      origin,
      address: signerAddress,
      message: payload.transaction,
      createdAt: Date.now(),
    });
    void openApprovalSurface();

    let decision;
    try {
      decision = await waitForApproval(id);
    } catch (cause) {
      if (cause instanceof VaultLockedApprovalError) {
        throw new ProtocolError('VAULT_LOCKED', cause.message);
      }
      throw cause;
    }
    if (decision === 'deny') {
      throw new ProtocolError('USER_REJECTED', 'User rejected the signature request.');
    }

    return vault.withAccount('solana', accountIndex, async (account) => {
      const signed = signSolanaTransaction(payload.transaction, account.privateKey, signerAddress);
      return { signature: signed.signature, signedTransaction: signed.signedTransaction };
    });
  },

  'solana.signMessage': async (payload, ctx) => {
    const origin = ctx.pageOrigin;
    if (origin === null) {
      throw new ProtocolError('ORIGIN_DENIED', 'Could not verify the requesting origin.');
    }
    const approved = await getApprovedAddresses(origin);
    if (approved.length === 0) {
      throw new ProtocolError('ORIGIN_DENIED', 'No accounts approved for this origin.');
    }
    if (!approved.includes(payload.address)) {
      throw new ProtocolError('ORIGIN_DENIED', 'Signing address is not approved for this origin.');
    }
    const accountIndex = await findSolanaAccountIndex(payload.address);
    if (accountIndex === null) {
      throw new ProtocolError('BAD_REQUEST', 'Signing address is not a wallet account.');
    }

    // Park the request until a human decides, then sign with the vault key.
    const id = crypto.randomUUID();
    await setPendingApproval({
      id,
      kind: 'sign',
      origin,
      address: payload.address,
      message: payload.message,
      createdAt: Date.now(),
    });
    void openApprovalSurface();

    let decision;
    try {
      decision = await waitForApproval(id);
    } catch (cause) {
      if (cause instanceof VaultLockedApprovalError) {
        throw new ProtocolError('VAULT_LOCKED', cause.message);
      }
      throw cause;
    }
    if (decision === 'deny') {
      throw new ProtocolError('USER_REJECTED', 'User rejected the signature request.');
    }

    return vault.withAccount('solana', accountIndex, async (account) => {
      let message: Uint8Array;
      try {
        message = base58.decode(payload.message);
      } catch {
        throw new ProtocolError('BAD_REQUEST', 'Message is not valid base58.');
      }
      const { signature } = signSolanaMessage(message, account.privateKey);
      return { signature, publicKey: account.address };
    });
  },

  /**
   * Testnet faucet — requests free testnet funds for a chain address.
   *
   * Solana and Stellar are automatable from the SW (RPC requestAirdrop and
   * Friendbot). EVM needs a human + CAPTCHA (Sepolia public faucets), so the
   * handler returns faucet URLs the UI can open. No key material leaves the SW;
   * the address alone is enough.
   */
  'faucet.request': async (payload) => {
    const result = await requestTestnetFaucet(payload.chain, payload.address);
    if (!result.ok) {
      throw new ProtocolError('BAD_REQUEST', result.error);
    }
    const response: { ok: true; txHash?: string; faucetUrl?: string } = { ok: true };
    if ('txHash' in result && result.txHash !== undefined) response.txHash = result.txHash;
    // EVM/Solana fallbacks return an external faucet URL; the UI opens it in a
    // new tab where the user completes any CAPTCHA to receive funds.
    if ('faucetUrl' in result && result.faucetUrl !== undefined) {
      response.faucetUrl = result.faucetUrl;
    }
    return response;
  },

  'wc.pair': async (payload) => {
    const client = await getWalletConnectClient();
    await client.pair(payload.uri);
    return { ok: true };
  },

  'wc.proposal.pending': async () => {
    const proposal = await getPendingWcProposal();
    if (!proposal) return null;
    // Map WalletConnect's namespace types to the simpler protocol shape.
    const mapNamespace = (ns: {
      chains?: string[];
      methods: string[];
      events: string[];
    }): { chains: string[]; methods: string[]; events: string[] } => ({
      chains: ns.chains ?? [],
      methods: ns.methods,
      events: ns.events,
    });
    const requiredNamespaces: Record<
      string,
      { chains: string[]; methods: string[]; events: string[] }
    > = {};
    for (const [key, value] of Object.entries(proposal.requiredNamespaces)) {
      requiredNamespaces[key] = mapNamespace(value);
    }
    let optionalNamespaces:
      | Record<string, { chains: string[]; methods: string[]; events: string[] }>
      | undefined;
    if (proposal.optionalNamespaces) {
      optionalNamespaces = {};
      for (const [key, value] of Object.entries(proposal.optionalNamespaces)) {
        optionalNamespaces[key] = mapNamespace(value);
      }
    }
    const result: {
      id: number;
      name: string;
      url: string;
      requiredNamespaces: Record<string, { chains: string[]; methods: string[]; events: string[] }>;
      optionalNamespaces?: Record<
        string,
        { chains: string[]; methods: string[]; events: string[] }
      >;
      expiry: number;
      createdAt: number;
    } = {
      id: proposal.id,
      name: proposal.proposer?.metadata?.name ?? 'Unknown dapp',
      url: proposal.proposer?.metadata?.url ?? '',
      requiredNamespaces,
      expiry: proposal.expiryTimestamp,
      createdAt: Date.now(),
    };
    if (optionalNamespaces !== undefined) {
      result.optionalNamespaces = optionalNamespaces;
    }
    return result;
  },

  'wc.proposal.approve': async (payload) => {
    const client = await getWalletConnectClient();
    await client.approveProposal(payload.proposalId, payload.accounts);
    return { ok: true };
  },

  'wc.proposal.reject': async (payload) => {
    const client = await getWalletConnectClient();
    await client.rejectProposal(payload.proposalId);
    return { ok: true };
  },

  'wc.session.list': async () => {
    const client = await getWalletConnectClient();
    const sessions = client.getSessions();
    return sessions.map((s) => {
      const accounts = Object.values(s.namespaces ?? {}).flatMap((ns) => ns?.accounts ?? []);
      return {
        topic: s.topic,
        name: s.peer?.metadata?.name ?? 'WalletConnect dapp',
        url: s.peer?.metadata?.url ?? '',
        accounts,
        createdAt: Date.now(),
        expiry: new Date(s.expiry * 1000).toISOString(),
      };
    });
  },

  'wc.session.disconnect': async (payload) => {
    const client = await getWalletConnectClient();
    await client.disconnect(payload.topic);
    return { ok: true };
  },

  'wc.request.pending': async () => {
    const req = await getPendingWcRequest();
    if (!req) return null;
    return {
      topic: req.topic,
      requestId: req.requestId,
      chainId: req.chainId,
      method: req.request?.method ?? 'unknown',
      hint: requestHint(req.request?.method, req.request?.params),
      createdAt: req.createdAt,
    };
  },

  'wc.request.resolve': async (payload) => {
    const req = await getPendingWcRequest();
    if (!req) return { ok: false };
    const client = await getWalletConnectClient();
    if (payload.action === 'deny') {
      await client.respondError(req.topic, req.requestId, {
        code: 4001,
        message: 'User rejected the request.',
      });
      await clearPendingWcRequest();
      return { ok: true };
    }
    // Approve: delegate to the same signing/broadcasting path used by the
    // in-page EIP-1193 provider. This keeps key handling in the background and
    // reuses the existing approval UX.
    await resolveWcRequest(req);
    await clearPendingWcRequest();
    return { ok: true };
  },

  'agent.status': async () => agentBridgeStatus(),

  /**
   * Pairs the agent bridge. Privileged (router), because the stored token is a
   * standing spending authority: anything that can read it may spend within the
   * user's grant caps without a per-payment prompt.
   */
  'agent.configure': async (payload) => {
    const config: Parameters<typeof saveAgentBridgeConfig>[0] = {
      mode: payload.mode,
      baseUrl: payload.baseUrl.replace(/\/$/, ''),
      token: payload.token,
      pairedAt: Date.now(),
    };
    if (payload.walletId !== undefined) config.walletId = payload.walletId;
    await saveAgentBridgeConfig(config);
    await restartAgentBridge();
    void appendAudit('agent.paired', { mode: payload.mode, endpoint: config.baseUrl });
    return { ok: true };
  },

  /**
   * Registers this wallet with a relay and starts polling it.
   *
   * The relay issues a wallet secret (stored here, never returned) and a short
   * pairing code (returned for the user to enter on the AI-client side).
   */
  'agent.relay.register': async (payload) => {
    const baseUrl = payload.baseUrl.replace(/\/$/, '');
    let response: Response;
    try {
      response = await fetch(`${baseUrl}/wallet/register`, { method: 'POST' });
    } catch {
      throw new ProtocolError('BAD_REQUEST', `Could not reach the relay at ${baseUrl}.`);
    }
    if (!response.ok) {
      throw new ProtocolError(
        'BAD_REQUEST',
        `The relay refused registration (HTTP ${response.status}).`
      );
    }

    const body = (await response.json()) as unknown;
    if (typeof body !== 'object' || body === null) {
      throw new ProtocolError('BAD_REQUEST', 'The relay returned a malformed registration.');
    }
    const record = body as Record<string, unknown>;
    const { walletId, secret } = record;
    if (typeof walletId !== 'string' || typeof secret !== 'string') {
      throw new ProtocolError('BAD_REQUEST', 'The relay returned an incomplete registration.');
    }

    await saveAgentBridgeConfig({
      mode: 'relay',
      baseUrl,
      token: secret,
      walletId,
      pairedAt: Date.now(),
    });
    await restartAgentBridge();
    void appendAudit('agent.paired', { mode: 'relay', endpoint: baseUrl });

    // The wallet id rides in the path, so the URL the user pastes carries its own
    // identity and the client's OAuth discovery does the rest — nothing to type.
    // The URL is universal — the same for every user — so the pairing code is
    // what binds an AI client's OAuth grant to this wallet when the user enters
    // it on the relay's consent page.
    const pairing = record.pairing;
    if (
      typeof pairing !== 'object' ||
      pairing === null ||
      typeof (pairing as Record<string, unknown>).code !== 'string' ||
      typeof (pairing as Record<string, unknown>).expiresAt !== 'number'
    ) {
      throw new ProtocolError('BAD_REQUEST', 'The relay returned an incomplete pairing code.');
    }

    return {
      mcpUrl: `${baseUrl}/mcp`,
      walletId,
      pairingCode: (pairing as Record<string, unknown>).code as string,
      pairingCodeExpiresAt: (pairing as Record<string, unknown>).expiresAt as number,
    };
  },

  'agent.relay.pairing-code': async () => {
    const config = await loadAgentBridgeConfig();
    if (config?.mode !== 'relay' || config.walletId === undefined) {
      throw new ProtocolError(
        'BAD_REQUEST',
        'Connect the hosted relay before requesting a pairing code.'
      );
    }
    const response = await fetch(`${config.baseUrl}/wallet/pairing-code`, {
      method: 'POST',
      headers: {
        'x-veilpay-wallet': config.walletId,
        'x-veilpay-secret': config.token,
      },
    });
    if (!response.ok) {
      throw new ProtocolError(
        'BAD_REQUEST',
        `The relay refused a pairing code (HTTP ${response.status}).`
      );
    }
    const body = (await response.json()) as unknown;
    if (typeof body !== 'object' || body === null) {
      throw new ProtocolError('BAD_REQUEST', 'The relay returned a malformed pairing code.');
    }
    const record = body as Record<string, unknown>;
    if (typeof record.code !== 'string' || typeof record.expiresAt !== 'number') {
      throw new ProtocolError('BAD_REQUEST', 'The relay returned an incomplete pairing code.');
    }
    return { pairingCode: record.code, pairingCodeExpiresAt: record.expiresAt };
  },

  'agent.disable': async () => {
    stopAgentBridge();
    await clearAgentBridgeConfig();
    void appendAudit('agent.unpaired', {});
    return { ok: true };
  },
};

/** Decimal places used to convert human-readable token amounts to base units. */
const CHAIN_DECIMALS: Record<ChainId, number> = {
  evm: 18, // wei
  solana: 9, // lamports
  stellar: 7, // stroops (all Stellar assets use 7 decimals by convention)
};

/** Human-readable summary of a WalletConnect RPC request for the user. */
function requestHint(method: string | undefined, params: unknown[] | undefined): string {
  if (method === 'eth_sendTransaction' || method === 'eth_signTransaction') {
    const tx =
      Array.isArray(params) && params[0] && typeof params[0] === 'object'
        ? (params[0] as Record<string, unknown>)
        : undefined;
    const to = typeof tx?.to === 'string' ? tx.to.slice(0, 10) + '…' + tx.to.slice(-4) : 'unknown';
    return `Send transaction to ${to}`;
  }
  if (method === 'personal_sign') {
    const bytes = params && params[0];
    const size =
      typeof bytes === 'string'
        ? (bytes.startsWith('0x') ? bytes.length - 2 : bytes.length) / 2
        : 0;
    return `Sign a ${Math.round(size)}-byte message`;
  }
  if (method === 'eth_signTypedData' || method === 'eth_signTypedData_v4') {
    return 'Sign structured (typed) data';
  }
  return `Sign request (${method ?? 'unknown'})`;
}

/**
 * Fulfills an approved WalletConnect session request by delegating to the same
 * EVM signing/broadcasting path the in-page provider uses. Key handling stays
 * in the background inside `vault.withAccount`; only the signature or tx hash
 * is returned to WalletConnect.
 */
async function resolveWcRequest(req: {
  topic: string;
  requestId: number;
  chainId: string;
  request: { method: string; params: unknown[] };
}): Promise<void> {
  const client = await getWalletConnectClient();

  switch (req.request.method) {
    case 'eth_sendTransaction': {
      const tx =
        Array.isArray(req.request.params) && req.request.params[0]
          ? (req.request.params[0] as Record<string, unknown>)
          : null;
      if (!tx || typeof tx.from !== 'string') {
        throw new ProtocolError('BAD_REQUEST', 'WalletConnect transaction is missing a sender.');
      }
      const accountIndex = await findEvmAccountIndex(tx.from);
      if (accountIndex === null) {
        throw new ProtocolError('ORIGIN_DENIED', 'Sender is not a wallet account.');
      }
      const value =
        typeof tx.value === 'string' && tx.value.length > 0 ? normalizeWei(tx.value) : 0n;
      const to = typeof tx.to === 'string' && tx.to.length > 0 ? tx.to : undefined;
      const data =
        typeof tx.data === 'string' && tx.data.length > 0 ? hexToBytesStrict(tx.data) : undefined;

      const hash = await vault.withAccount('evm', accountIndex, async (account) => {
        const service = createChainService('evm');
        const source = new RpcFeeSource();
        const target = to ?? account.address;
        const [nonce, fees] = await Promise.all([
          service.getSequence(account.address),
          estimateTransferFee(source, account.address, target, value, data),
        ]);
        const unsigned: UnsignedEvmTransaction = {
          chainId: EVM_CHAIN_ID,
          nonce,
          maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
          maxFeePerGas: fees.maxFeePerGas,
          gasLimit: fees.gasLimit,
          to: target,
          value,
        };
        if (data !== undefined) unsigned.data = data;
        const signed = signTransaction(unsigned, account.privateKey);
        if (signed.from.toLowerCase() !== account.address.toLowerCase()) {
          throw new Error('Signer address does not match the derived account.');
        }
        return service.sendTransaction(signed.raw);
      });

      await client.respondResult(req.topic, req.requestId, hash);
      return;
    }

    case 'personal_sign': {
      if (!Array.isArray(req.request.params)) {
        throw new ProtocolError('BAD_REQUEST', 'personal_sign expects [message, address].');
      }
      const [message, address] = req.request.params as [string | undefined, string | undefined];
      if (typeof message !== 'string' || typeof address !== 'string') {
        throw new ProtocolError('BAD_REQUEST', 'personal_sign expects [message, address].');
      }
      const accountIndex = await findEvmAccountIndex(address);
      if (accountIndex === null) {
        throw new ProtocolError('ORIGIN_DENIED', 'Signing address is not a wallet account.');
      }
      const signature = await vault.withAccount('evm', accountIndex, async (account) => {
        const { signature: sig } = signPersonalMessage(
          hexToBytesStrict(message),
          account.privateKey
        );
        return sig;
      });
      await client.respondResult(req.topic, req.requestId, signature);
      return;
    }

    // eth_signTypedData(_v4) and eth_sign are not yet wired to the approval
    // UI. Fail cleanly rather than respond with a misleading empty signature.
    default:
      throw new ProtocolError(
        'BAD_REQUEST',
        `WalletConnect method ${req.request.method} is not supported yet.`
      );
  }
}

/**
 * Converts a human-readable decimal amount ("0.5") into base units for a token
 * (wei / lamports / stroops). The fractional input is scaled with BigInt math,
 * never floating point, so `0.001` cannot lose precision.
 *
 * `decimals` is the resolved token precision (native per-chain by default, or
 * the token's on-chain `decimals()` / mint decimals for ERC20/SPL).
 *
 * The input has already passed the `NativeDecimal` protocol schema (digits with
 * an optional fraction), so this only needs to handle well-formed decimals.
 */
function parseTransferAmount(
  decimal: string,
  chain: ChainId,
  kind: string,
  decimalsOverride?: number
): bigint {
  const decimals = decimalsOverride ?? CHAIN_DECIMALS[chain];
  try {
    return decimalAmountToBaseUnits(decimal, decimals);
  } catch {
    // RangeError from an oversized base amount.
    throw new ProtocolError('BAD_REQUEST', `Amount for ${kind} is too large.`);
  }
}

/**
 * Normalized internal descriptor for which token is being sent, after the
 * protocol's `token`/legacy `asset` fields are reconciled.
 */
type TokenDescriptor =
  | { kind: 'native' }
  | { kind: 'stellar-issued'; code: string; issuer: string }
  | { kind: 'erc20'; address: string }
  | { kind: 'spl'; mint: string };

/** Symbol of the native asset on each chain. */
const NATIVE_SYMBOL: Record<ChainId, string> = {
  evm: 'ETH',
  solana: 'SOL',
  stellar: 'XLM',
};

/** Reconciles the protocol's `token` (new) and `asset` (legacy Stellar) into a `TokenDescriptor`. */
function normalizeToken(
  token: TokenInputType | undefined,
  asset: StellarAssetInput | undefined
): TokenDescriptor {
  // Preferred: the new `token` field.
  if (token !== undefined) {
    switch (token.kind) {
      case 'native':
        return { kind: 'native' };
      case 'stellar-issued':
        return { kind: 'stellar-issued', code: token.code, issuer: token.issuer };
      case 'erc20':
        return { kind: 'erc20', address: token.address };
      case 'spl':
        return { kind: 'spl', mint: token.mint };
      default:
        throw new ProtocolError('BAD_REQUEST', 'Unsupported token kind.');
    }
  }
  // Back-compat: legacy `asset` (Stellar native/issued).
  if (asset !== undefined && asset.type === 'issued') {
    return { kind: 'stellar-issued', code: asset.code, issuer: asset.issuer };
  }
  // No token/asset, or a native `asset` — native across every chain.
  return { kind: 'native' };
}

/**
 * Resolves a token's decimal precision and the sender's spendable balance for
 * it, by reading on-chain metadata when a non-native token is selected.
 * Returns the decimals (for conversion), the spendable balance in base units,
 * and a display symbol. Throws INSUFFICIENT_BALANCE is NOT raised here; the
 * caller compares amount+fee against `spendable`.
 */
async function resolveToken(
  chain: ChainId,
  descriptor: TokenDescriptor,
  address: string
): Promise<{ decimals: number; spendable: bigint; symbol: string }> {
  const service = createChainService(chain, await resolveRpcUrl(chain, TESTNET_ENDPOINTS[chain]));

  // Native token: precision + balance come straight from the chain.
  if (descriptor.kind === 'native') {
    const decimals = CHAIN_DECIMALS[chain];
    const spendable = await service.getBalance(address);
    return { decimals, spendable, symbol: NATIVE_SYMBOL[chain] };
  }

  if (descriptor.kind === 'stellar-issued') {
    // Stellar issued assets are always 7 decimals; balance read from Horizon.
    const spendable =
      typeof service.getAssetBalance === 'function'
        ? await service.getAssetBalance(address, descriptor.code, descriptor.issuer)
        : 0n;
    return { decimals: 7, spendable, symbol: descriptor.code };
  }

  if (descriptor.kind === 'erc20') {
    if (
      typeof service.erc20Decimals !== 'function' ||
      typeof service.erc20BalanceOf !== 'function'
    ) {
      throw new ProtocolError('BAD_REQUEST', 'EVM token support unavailable.');
    }
    const [decimals, balance] = await Promise.all([
      service.erc20Decimals(descriptor.address),
      service.erc20BalanceOf(descriptor.address, address),
    ]);
    return { decimals, spendable: balance, symbol: 'ERC20' };
  }

  // spl
  if (typeof service.mintDecimals !== 'function') {
    throw new ProtocolError('BAD_REQUEST', 'Solana token support unavailable.');
  }
  const [decimals, spendable] = await Promise.all([
    service.mintDecimals(descriptor.mint),
    service.tokenBalance ? service.tokenBalance(address, descriptor.mint) : Promise.resolve(0n),
  ]);
  return { decimals, spendable, symbol: 'SPL' };
}

/**
 * Reads the current Stellar base fee (stroops) from the configured Horizon
 * endpoint, falling back to the official testnet gateway. Uses the chain
 * service so endpoint rotation, timeouts, and custom networks all apply.
 */
async function fetchStellarBaseFee(): Promise<bigint> {
  const service = createChainService('stellar', await resolveStellarEndpoints());
  return service.getBaseFee ? service.getBaseFee() : 100n;
}

/**
 * Resolves the Stellar Horizon endpoints, honoring a user-configured custom
 * network (tried first) with the official testnet gateway as automatic
 * fallback inside `StellarService`.
 */
async function resolveStellarEndpoints(): Promise<string[]> {
  const custom = await resolveRpcUrl('stellar', TESTNET_ENDPOINTS.stellar);
  const endpoints: string[] = [];
  if (custom.length > 0) endpoints.push(custom);
  return endpoints;
}

/**
 * Parses an EVM quantity (EIP-1193 passes values as hex, e.g. "0xde0b6b3a...")
 * into a bigint. Rejects garbage with BAD_REQUEST.
 */
function normalizeWei(quantity: string): bigint {
  try {
    if (/^0x[0-9a-fA-F]+$/.test(quantity)) {
      return BigInt(quantity);
    }
    if (/^[0-9]+$/.test(quantity)) {
      return BigInt(quantity);
    }
  } catch {
    // fall through to the protocol error
  }
  throw new ProtocolError('BAD_REQUEST', `Invalid value quantity "${quantity}".`);
}

/**
 * Parses a 0x-prefixed hex string into bytes. Used for calldata and signed
 * messages, where a non-hex input is a caller bug, not a display concern.
 */
function hexToBytesStrict(hex: string): Uint8Array {
  const clean = hex.replace(/^0x/, '');
  if (!/^[0-9a-fA-F]*$/.test(clean) || clean.length % 2 !== 0) {
    throw new ProtocolError('BAD_REQUEST', `Invalid hex string "${hex}".`);
  }
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i += 1) {
    out[i] = Number.parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

/**
 * Picks the sender for a dapp transaction: the dapp's `from` when it names an
 * approved account, otherwise the first approved EVM address.
 */
async function pickApprovedEvmAddress(
  from: string | undefined,
  approved: string[]
): Promise<string> {
  const evmApproved = approved.filter((addr) => addr.startsWith('0x'));
  if (evmApproved.length === 0) {
    throw new ProtocolError('ORIGIN_DENIED', 'No EVM account approved for this origin.');
  }
  if (from === undefined || from.length === 0) {
    return evmApproved[0]!;
  }
  if (!evmApproved.some((addr) => addr.toLowerCase() === from.toLowerCase())) {
    throw new ProtocolError(
      'ORIGIN_DENIED',
      'The requested sender is not approved for this origin.'
    );
  }
  return from;
}

/**
 * Finds the account index whose EVM address matches, or null. Dapps reference
 * accounts by address; signing needs the vault index.
 */
async function findEvmAccountIndex(address: string): Promise<number | null> {
  const target = address.toLowerCase();
  // The wallet currently derives a single account set at index 0; scanning a
  // few indexes keeps the helper correct if account switching is added later.
  for (let index = 0; index < 8; index += 1) {
    const accounts = await vault.getAllAccountAddresses(index);
    const evm = accounts.find((a) => a.chain === 'evm' && a.address.toLowerCase() === target);
    if (evm !== undefined) return evm.index;
  }
  return null;
}

/**
 * Finds the account index whose Solana address matches (base58 is
 * case-sensitive, so no normalization here), or null.
 */
async function findSolanaAccountIndex(address: string): Promise<number | null> {
  for (let index = 0; index < 8; index += 1) {
    const accounts = await vault.getAllAccountAddresses(index);
    const solana = accounts.find((a) => a.chain === 'solana' && a.address === address);
    if (solana !== undefined) return solana.index;
  }
  return null;
}

/**
 * Builds, signs, and broadcasts a transfer for a given chain.
 *
 * Extracted so `tx.transfer` can wrap the whole chain-specific switch in a lock
 * guard: every branch derives inside `vault.withAccount`, which throws
 * `VaultLocked` when the session has expired, and callers decide how to surface
 * that. Signing occurs inside the callback so the private key never leaves the
 * service worker.
 */
async function buildAndBroadcast(
  payload: {
    chain: ChainId;
    index: number;
    to: string;
    amount: string;
    asset?: StellarAssetInput | undefined;
  },
  amount: bigint,
  descriptor: TokenDescriptor,
  decimals: number,
  spendable: bigint
): Promise<{ chain: ChainId; from: string; to: string; amountNative: string; hash: string }> {
  switch (payload.chain) {
    case 'evm': {
      return vault.withAccount('evm', payload.index, async (account) => {
        const service = createChainService(
          'evm',
          await resolveRpcUrl('evm', TESTNET_ENDPOINTS.evm)
        );
        const source = new RpcFeeSource();

        const isErc20 = descriptor.kind === 'erc20';
        const data =
          isErc20 && descriptor.kind === 'erc20'
            ? erc20TransferCalldata(payload.to, amount)
            : undefined;
        const feeEstimateTarget =
          isErc20 && descriptor.kind === 'erc20' ? descriptor.address : payload.to;

        const [nonce, fees] = await Promise.all([
          service.getSequence(account.address),
          estimateTransferFee(source, account.address, feeEstimateTarget, amount, data),
        ]);

        // Surfaces a low spendable balance as a clear client error BEFORE any
        // broadcast. Native sends must cover amount + fee in wei; ERC20 token
        // sends must cover the token amount (the wei fee is drawn from the
        // sender's native balance separately at submit).
        if (isErc20 ? spendable < amount : spendable < amount + fees.totalFeeWei) {
          throw new ProtocolError(
            'INSUFFICIENT_BALANCE',
            isErc20
              ? 'Insufficient token balance for this amount.'
              : 'Insufficient balance for the amount plus network fee.'
          );
        }

        // For a plain EVM value transfer the recipient is `to` and the value is
        // the amount. For an ERC20 send we target the contract with the token
        // `transfer` calldata and a zero native value.
        const unsigned: UnsignedEvmTransaction =
          isErc20 && descriptor.kind === 'erc20'
            ? {
                chainId: EVM_CHAIN_ID,
                nonce,
                maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
                maxFeePerGas: fees.maxFeePerGas,
                gasLimit: fees.gasLimit,
                to: descriptor.address,
                value: 0n,
                data: erc20TransferCalldata(payload.to, amount),
              }
            : {
                chainId: EVM_CHAIN_ID,
                nonce,
                maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
                maxFeePerGas: fees.maxFeePerGas,
                gasLimit: fees.gasLimit,
                to: payload.to,
                value: amount,
              };

        const signed = signTransaction(unsigned, account.privateKey);

        if (signed.from.toLowerCase() !== account.address.toLowerCase()) {
          throw new Error('Signer address does not match the derived account.');
        }

        const hash = await service.sendTransaction(signed.raw);

        return {
          chain: 'evm',
          from: account.address,
          to: payload.to,
          amountNative: amount.toString(),
          hash,
        };
      });
    }
    case 'solana': {
      return vault.withAccount('solana', payload.index, async (account) => {
        const blockhash = await fetchSolanaBlockhash();
        const service = createChainService(
          'solana',
          await resolveRpcUrl('solana', TESTNET_ENDPOINTS.solana)
        );

        if (descriptor.kind === 'spl') {
          const mint = descriptor.mint;
          // Find the sender's funded token account, or inert-transfer directly.
          const source =
            typeof service.tokenAccount === 'function'
              ? await service.tokenAccount(account.address, mint)
              : null;
          if (source === null) {
            throw new ProtocolError('BAD_REQUEST', 'You have no token account for this SPL mint.');
          }
          // The recipient must hold or first receive the ATA; derive it for the send target.
          const dest = deriveAssociatedTokenAddress(payload.to, mint);
          // The spendable (token) balance is already passed in from resolveToken.
          if (spendable < amount) {
            throw new ProtocolError('INSUFFICIENT_BALANCE', 'Insufficient token balance.');
          }
          const unsigned: UnsignedSolanaSplTransfer = {
            from: account.address,
            source,
            mint,
            dest,
            amount,
            decimals,
            blockhash,
          };
          const signed = signSolanaSplTransfer(unsigned, account.privateKey);
          if (signed.from !== account.address) {
            throw new Error('Signer address does not match the derived account.');
          }
          const hash = await service.sendTransaction(signed.raw);
          return {
            chain: 'solana',
            from: account.address,
            to: payload.to,
            amountNative: amount.toString(),
            hash,
          };
        }

        // Native SOL transfer.
        const lamportBalance = await service.getBalance(account.address);
        const lamportFee = await service.estimateGas({});
        if (lamportBalance < amount + lamportFee) {
          throw new ProtocolError(
            'INSUFFICIENT_BALANCE',
            'Insufficient SOL balance for the amount plus fee.'
          );
        }

        const unsigned: UnsignedSolanaTransfer = {
          from: account.address,
          to: payload.to,
          lamports: amount,
          blockhash,
        };
        const signed = signSolanaTransfer(unsigned, account.privateKey);

        if (signed.from !== account.address) {
          throw new Error('Signer address does not match the derived account.');
        }
        const hash = await service.sendTransaction(signed.raw);

        return {
          chain: 'solana',
          from: account.address,
          to: payload.to,
          amountNative: amount.toString(),
          hash,
        };
      });
    }
    case 'stellar': {
      return vault.withAccount('stellar', payload.index, async (account) => {
        const service = createChainService('stellar', await resolveStellarEndpoints());

        // Only native-XLM sends require the sender be funded: an unfunded
        // account cannot hold XLM to pay the base reserve. Sending an issued
        // asset self-creates the account with the native minimum (the source
        // must still hold 1 XLM reserve, enforced on-chain at submit).
        const fee = Number((await service.getBaseFee?.()) ?? 100n);
        const isStellarIssued = descriptor.kind === 'stellar-issued';
        if (!isStellarIssued) {
          if (
            typeof service.isFunded === 'function' &&
            !(await service.isFunded(account.address))
          ) {
            throw new ProtocolError(
              'BAD_REQUEST',
              'This Stellar address has not been funded on testnet yet. Use "Get testnet funds" first.'
            );
          }
          // Pre-submit spendable check so a low balance surfaces as a clear
          // client error instead of Horizon's opaque op_underfunded. For native
          // XLM the spendable balance (stroops) was resolved up front; the relayer
          // still enforces the on-chain minimum at submit for issued assets.
          if (spendable < amount + BigInt(fee)) {
            throw new ProtocolError(
              'INSUFFICIENT_BALANCE',
              'Insufficient XLM balance for the amount plus fee.'
            );
          }
        }

        const sequence = await service.getSequence(account.address);

        const asset =
          isStellarIssued && descriptor.kind === 'stellar-issued'
            ? { type: 'issued' as const, code: descriptor.code, issuer: descriptor.issuer }
            : { type: 'native' as const };

        const unsigned: UnsignedStellarPayment = {
          from: account.address,
          to: payload.to,
          amount,
          asset,
          sequence,
          fee,
        };
        const signed = signStellarPayment(unsigned, account.privateKey);

        if (signed.from !== account.address) {
          throw new Error('Signer address does not match the derived account.');
        }

        const hash = await service.sendTransaction(signed.raw);

        return {
          chain: 'stellar',
          from: account.address,
          to: payload.to,
          amountNative: amount.toString(),
          hash,
        };
      });
    }
    default:
      throw new ProtocolError('BAD_REQUEST', 'Unsupported chain.');
  }
}

/**
 * Fetches a recent blockhash from the Solana Devnet RPC.
 * The blockhash is required to build a valid transaction.
 */
async function fetchSolanaBlockhash(): Promise<Uint8Array> {
  const rpcUrl = await resolveRpcUrl('solana', TESTNET_ENDPOINTS.solana);
  const response = await fetch(rpcUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'getLatestBlockhash',
      params: [{ commitment: 'confirmed' }],
    }),
  });
  if (!response.ok) {
    throw new Error(`Solana RPC getLatestBlockhash: HTTP ${response.status}`);
  }
  const data = (await response.json()) as unknown;
  if (
    typeof data !== 'object' ||
    data === null ||
    !('result' in data) ||
    typeof (data as Record<string, unknown>).result !== 'object' ||
    (data as Record<string, unknown>).result === null
  ) {
    throw new Error('Solana RPC getLatestBlockhash returned invalid response.');
  }
  const result = (data as { result: { value?: { blockhash?: string } } }).result;
  const blockhash = result?.value?.blockhash;
  if (typeof blockhash !== 'string' || blockhash.length === 0) {
    throw new Error('Solana RPC getLatestBlockhash: no blockhash in response.');
  }
  return base58.decode(blockhash);
}

// ---------------------------------------------------------------------------
// Agent bridge (MCP)
// ---------------------------------------------------------------------------

/**
 * Grants are keyed by client id. This is deliberately not an origin: the bridge
 * is a local process, not a page, and giving it its own key means revoking it
 * cannot affect any website's access.
 */
const AGENT_CLIENT_ID = 'mcp:veilpay';

let agentLoop: AgentBridgeLoop | null = null;

function stopAgentBridge(): void {
  agentLoop?.stop();
  agentLoop = null;
}

async function agentBridgeStatus() {
  const config = await loadAgentBridgeConfig();
  return {
    enabled: config !== null,
    mode: config?.mode ?? null,
    endpoint: config?.baseUrl ?? null,
    paired: config !== null,
    connected: agentLoop?.connected() ?? false,
    lastPollAt: agentLoop?.lastPollAt() ?? null,
  };
}

/** Starts the poll loop if the user has paired. Replaces any running loop. */
async function restartAgentBridge(): Promise<void> {
  stopAgentBridge();
  const config = await loadAgentBridgeConfig();
  if (config === null) return;
  agentLoop = startAgentBridgeLoop(config, (request) =>
    executeAgentTool(request.tool, request.args)
  );
}

function asChain(value: unknown): ChainId {
  if (value === 'evm' || value === 'solana' || value === 'stellar') return value;
  throw new ProtocolError('BAD_REQUEST', 'Unsupported chain.');
}

/** Dispatches one bridge tool call. Throws to report a failure to the agent. */
async function executeAgentTool(tool: string, args: Record<string, unknown>): Promise<unknown> {
  switch (tool) {
    case 'status': {
      const state = await vault.getState();
      return { unlocked: state === 'unlocked', testnetOnly: true };
    }
    case 'accounts': {
      const accounts = await vault.getAllAccountAddresses(0);
      return accounts.map((account) => ({ chain: account.chain, address: account.address }));
    }
    case 'balance': {
      const chain = asChain(args.chain);
      const address =
        typeof args.address === 'string' && args.address.length > 0
          ? args.address
          : (await vault.getAccountAddress(chain, 0)).address;
      const service = createChainService(
        chain,
        await resolveRpcUrl(chain, TESTNET_ENDPOINTS[chain])
      );
      const balance = await service.getBalance(address);
      return {
        chain,
        address,
        balance: balance.toString(),
        decimals: CHAIN_DECIMALS[chain],
        symbol: NATIVE_SYMBOL[chain],
      };
    }
    case 'grants.list':
      return listGrants();
    case 'grants.revoke': {
      if (typeof args.id !== 'string' || args.id.length === 0) {
        throw new ProtocolError('BAD_REQUEST', 'A grant id is required.');
      }
      await revokeGrant(args.id);
      return { ok: true };
    }
    case 'send':
      return executeAgentSend(args);
    default:
      throw new ProtocolError('BAD_REQUEST', `Unknown agent tool "${tool}".`);
  }
}

/**
 * Settles an agent-initiated native transfer.
 *
 * The authorisation model is the important part: an agent may act autonomously
 * only inside a grant's caps. Without a grant, or above the approval threshold,
 * the payment parks and a human decides. That is what stops a prompt-injected
 * agent from draining the wallet — the LLM asks, the wallet authorises.
 */
async function executeAgentSend(args: Record<string, unknown>): Promise<unknown> {
  const chain = asChain(args.chain);
  const to = args.to;
  const amountText = args.amount;

  if (typeof to !== 'string' || to.length === 0) {
    throw new ProtocolError('BAD_REQUEST', 'A recipient address is required.');
  }
  if (typeof amountText !== 'string' || amountText.length === 0) {
    throw new ProtocolError('BAD_REQUEST', 'An amount is required.');
  }
  if ((await vault.getState()) !== 'unlocked') {
    throw new ProtocolError('VAULT_LOCKED', 'Unlock Veilpay before sending.');
  }

  const account = (await vault.getAccountAddress(chain, 0)).address;
  const decimals = CHAIN_DECIMALS[chain];
  const amount = parseTransferAmount(amountText, chain, 'agent.send');
  if (amount <= 0n) {
    throw new ProtocolError('BAD_REQUEST', 'Amount must be greater than zero.');
  }

  const service = createChainService(chain, await resolveRpcUrl(chain, TESTNET_ENDPOINTS[chain]));
  const spendable = await service.getBalance(account);

  const broadcast = () =>
    buildAndBroadcast(
      { chain, index: 0, to, amount: amountText },
      amount,
      { kind: 'native' },
      decimals,
      spendable
    );

  const grant = await getActiveGrantByOrigin(AGENT_CLIENT_ID);
  if (grant !== null) {
    const window = await loadSpendWindow(grant);
    const decision = requiresApproval(
      grant,
      { type: 'native.transfer', amount, chain, recipient: to },
      BigInt(window.amountSpent)
    );

    if (decision.action === 'deny') {
      void appendAudit('op.denied', {
        clientId: AGENT_CLIENT_ID,
        chain,
        amount: amount.toString(),
        recipient: to,
        grantId: grant.id,
        reason: decision.reason,
      });
      throw new ProtocolError('BAD_REQUEST', `Denied by the spending grant (${decision.reason}).`);
    }

    if (decision.action === 'auto') {
      const result = await broadcast();
      await recordSpend(grant, amount);
      void appendAudit('op.settled', {
        clientId: AGENT_CLIENT_ID,
        chain,
        amount: amount.toString(),
        recipient: to,
        grantId: grant.id,
        approvedBy: 'grant',
        hash: result.hash,
      });
      return { hash: result.hash, chain, to, amount: amountText };
    }
    // 'required' means above the threshold — fall through to the human prompt.
  }

  if (!allowPrompt(AGENT_CLIENT_ID)) {
    throw new ProtocolError(
      'PROMPT_RATE_LIMITED',
      'Too many approval requests. Wait a minute and try again.'
    );
  }

  const id = crypto.randomUUID();
  await setPendingApproval({
    id,
    kind: 'tx',
    origin: AGENT_CLIENT_ID,
    address: account,
    to,
    value: amount.toString(),
    symbol: NATIVE_SYMBOL[chain],
    decimals,
    createdAt: Date.now(),
  });
  void openApprovalSurface();

  let decision;
  try {
    decision = await waitForApproval(id);
  } catch (cause) {
    if (cause instanceof VaultLockedApprovalError) {
      throw new ProtocolError('VAULT_LOCKED', cause.message);
    }
    throw cause;
  }
  if (decision === 'deny') {
    throw new ProtocolError('USER_REJECTED', 'The user declined the payment.');
  }

  const result = await broadcast();
  void appendAudit('op.approved', {
    clientId: AGENT_CLIENT_ID,
    chain,
    amount: amount.toString(),
    recipient: to,
    approvedBy: 'user',
  });
  void appendAudit('op.settled', {
    clientId: AGENT_CLIENT_ID,
    chain,
    amount: amount.toString(),
    recipient: to,
    approvedBy: 'user',
    hash: result.hash,
  });
  return { hash: result.hash, chain, to, amount: amountText };
}

const INTERNAL_CHANNEL = 'veilpay:internal';

interface InternalMessage {
  channel: typeof INTERNAL_CHANNEL;
  kind: string;
  result?: unknown;
}

/**
 * Control-plane traffic from our own surfaces, kept off the request bus.
 *
 * These carry no user request and have no `Request` envelope, so they must be
 * routed before `dispatch` ever sees them.
 */
function isInternalMessage(value: unknown): value is InternalMessage {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as Record<string, unknown>).channel === INTERNAL_CHANNEL &&
    typeof (value as Record<string, unknown>).kind === 'string'
  );
}

/**
 * Handles a control message.
 *
 * The sender check is not ceremony. A content script can post any object it
 * likes, and without it a page could write a forged `viable` capability into
 * storage and have the wallet advertise a proving path that does not exist.
 * The payload is validated even though it comes from our own offscreen document,
 * because a malformed write would silently poison the cached D3 answer.
 */
async function handleInternalMessage(
  message: InternalMessage,
  sender: chrome.runtime.MessageSender
): Promise<{ ok: boolean }> {
  if (sender.id !== chrome.runtime.id || sender.tab !== undefined) {
    return { ok: false };
  }
  if (message.kind !== 'spike:zk-result') {
    return { ok: false };
  }

  const parsed = ZkCapability.safeParse(message.result);
  if (!parsed.success) {
    console.error('[veilpay] the D3 spike reported a malformed capability');
    return { ok: false };
  }

  await writeMeta(ZK_CAPABILITY_KEY, parsed.data);
  await chrome.offscreen.closeDocument().catch(() => undefined);
  return { ok: true };
}

/**
 * The single entry point for every inbound message.
 *
 * There were previously two `onMessage` listeners — one for requests, one for the
 * spike result — and both fired for every message while both returned `true`. The
 * offscreen document's report was therefore also handed to `dispatch`, failed
 * validation, and answered BAD_REQUEST while the real handler ran anyway. One
 * listener with an explicit channel check removes that race.
 */
// Startup marker. If you do not see this in chrome://extensions -> service
// worker console, the SW bundle did not evaluate — check for errors above it.
console.info('[veilpay] service worker module evaluating');
let firstMessage = true;
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (firstMessage) {
    firstMessage = false;
    console.info('[veilpay] service worker received its first message');
  }
  if (isInternalMessage(message)) {
    handleInternalMessage(message, sender).then(sendResponse, (cause: unknown) => {
      console.error('[veilpay] internal message failed', cause);
      sendResponse({ ok: false });
    });
    return true;
  }

  dispatch(message, sender, handlers).then(sendResponse, (cause: unknown) => {
    // dispatch already flattens handler errors; this only fires if dispatch
    // itself breaks, which would be a bug rather than a rejected request.
    console.error('[veilpay] dispatch failed', cause);
    sendResponse({
      id: '00000000-0000-0000-0000-000000000000',
      ok: false,
      error: { code: 'INTERNAL', message: 'The wallet could not complete that request.' },
    });
  });
  return true; // keep the channel open for the async response
});
console.info('[veilpay] service worker ready, message listener registered');

/**
 * Idle relock.
 *
 * A `setTimeout` would die with the worker, so the check is driven by an alarm.
 * One minute is the smallest interval Chrome reliably honours; the vault itself
 * enforces the exact deadline, so the alarm only needs to poke it.
 */
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== IDLE_ALARM) return;
  void vault.getState(); // relocks internally once the deadline has passed
});

function ensureIdleAlarm(): void {
  chrome.alarms.create(IDLE_ALARM, { periodInMinutes: 1 });
}

chrome.runtime.onInstalled.addListener(() => {
  ensureIdleAlarm();
  void runZkSpikeOnce();
  void initWalletConnect();
  void restartAgentBridge();
  buildContextMenu();
});

chrome.runtime.onStartup.addListener(() => {
  ensureIdleAlarm();
  // Retried on every startup. If the offscreen document never reported — crash,
  // closed early, browser quit mid-probe — the capability stays unwritten, and
  // without this the D3 question would never be measured again.
  void runZkSpikeOnce();
  void initWalletConnect();
  void restartAgentBridge();
  buildContextMenu();
});

/**
 * D3 spike, executed once and cached.
 *
 * snarkjs needs a DOM and can run long, so the probe lives in an offscreen
 * document rather than here. The result is persisted because a service-worker
 * restart must not re-run a multi-second measurement.
 */
async function runZkSpikeOnce(): Promise<void> {
  if ((await readMeta<ZkCapability>(ZK_CAPABILITY_KEY)) !== undefined) return;

  try {
    await chrome.offscreen.createDocument({
      url: 'offscreen.html',
      reasons: [chrome.offscreen.Reason.WORKERS],
      justification: 'Measure whether Groth16 proving is possible under the MV3 CSP.',
    });
  } catch (cause) {
    // Already-existing document is fine; anything else means we cannot measure.
    const message = cause instanceof Error ? cause.message : String(cause);
    if (!message.includes('Only a single offscreen')) {
      await writeMeta(ZK_CAPABILITY_KEY, {
        status: 'unavailable',
        wasmCompileWorks: false,
        snarkjsImportWorks: false,
        proofGenerationWorks: null,
        proofElapsedMs: null,
        failureReason: `Offscreen document unavailable: ${message}`,
        measuredAt: Date.now(),
      } satisfies ZkCapability);
      return;
    }
  }
}

// ---------------------------------------------------------------------------
// Context menu
// ---------------------------------------------------------------------------

const ADDRESS_RE = /0x[a-fA-F0-9]{40}/;

function buildContextMenu(): void {
  if (chrome.contextMenus === undefined) return;
  chrome.contextMenus.removeAll();
  chrome.contextMenus.create({
    id: 'veilpay-send',
    title: 'Send to this address',
    contexts: ['selection'],
    documentUrlPatterns: ['*://*/*'],
  });
  chrome.contextMenus.create({
    id: 'veilpay-copy',
    title: 'Copy address to Veilpay',
    contexts: ['selection'],
    documentUrlPatterns: ['*://*/*'],
  });
  chrome.contextMenus.create({
    id: 'veilpay-lock',
    title: 'Lock Veilpay wallet',
    contexts: ['selection', 'page'],
    documentUrlPatterns: ['*://*/*'],
  });
}

// Guarded: without the `contextMenus` permission this namespace is undefined,
// and a bare module-scope call here would crash the service worker at
// evaluation (the boot regression we fixed). Degrade to no context menu.
if (chrome.contextMenus?.onClicked !== undefined) {
  chrome.contextMenus.onClicked.addListener(async (info) => {
    const selection = info.selectionText ?? '';
    const match = selection.match(ADDRESS_RE);
    const address = match?.[0] ?? '';

    switch (info.menuItemId) {
      case 'veilpay-send': {
        if (!address) {
          console.warn('[veilpay] Context menu send: no address found in selection.');
          return;
        }
        // Open the popup with the send target pre-filled.
        // The popup reads the URL fragment to pre-fill the send form.
        await chrome.tabs.create({
          url: `chrome-extension://${chrome.runtime.id}/popup.html#send=${address}`,
        });
        break;
      }
      case 'veilpay-copy': {
        // Copy the full selection text to the system clipboard.
        await navigator.clipboard.writeText(selection).catch(() => {
          // Fallback for contexts where clipboard API is unavailable.
          const textarea = document.createElement('textarea');
          textarea.value = selection;
          document.body.appendChild(textarea);
          textarea.select();
          document.execCommand('copy');
          document.body.removeChild(textarea);
        });
        break;
      }
      case 'veilpay-lock': {
        await vault.lock();
        break;
      }
    }
  });
}

console.info('[veilpay] service worker ready');

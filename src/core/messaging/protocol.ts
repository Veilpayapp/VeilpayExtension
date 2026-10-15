import { z } from 'zod';
import { X402Challenge } from '@/core/x402/types';
// Type-only on purpose: `grant.ts` imports `GrantCaps` (a value) from this
// module, so making this a value import would re-introduce a circular module
// graph that fails at evaluation time with a TDZ ReferenceError (the previous
// black-screen regression). Keep it type-only.
import type { Grant } from '@/core/vap/grant';

/**
 * The single message contract between every extension context.
 *
 * Rules:
 *  - Every message is validated with Zod at the receiving boundary. A malformed
 *    message from a compromised content script must never reach handler logic.
 *  - Secrets never travel over this bus. No mnemonics, no private keys, no
 *    decrypted vault material. Signing happens in the background; only the
 *    signature comes back.
 *  - `origin` is stamped by the receiver from `chrome.runtime.MessageSender`,
 *    never trusted from the payload.
 */

export const MessageSource = z.enum([
  'popup',
  'options',
  'sidepanel',
  'content',
  'inpage',
  'offscreen',
]);
export type MessageSource = z.infer<typeof MessageSource>;

/** Mirrors `Chain` in `@/core/vault/key-derivation`, declared here so the wire
 * contract stays self-contained and independently validatable. */
export const ChainId = z.enum(['evm', 'solana', 'stellar']);
export type ChainId = z.infer<typeof ChainId>;

/** Discriminant for every request the background service worker accepts. */
export const RequestKind = z.enum([
  'ping',
  'vault.status',
  'session.lock',
  'zk.capability',
  'accounts.list',
  'account.balance',
  'indexer.history',
  'tx.estimate',
  'tx.transfer',
  'vault.create',
  'vault.unlock',
  'vault.reset',
  'mnemonic.generate',
  'security.status',
  'security.pin.setup',
  'security.pin.verify',
  'security.webauthn.setup',
  'security.webauthn.challenge',
  'eth.chainId',
  'eth.requestAccounts',
  'eth.accounts',
  'eth.sendTransaction',
  'eth.switchChain',
  'personal.sign',
  'eth.rpc',
  'eth.signTypedData',
  'permissions.list',
  'permissions.grant',
  'permissions.revoke',
  'permissions.pending',
  'permissions.connection',
  'tx.pending',
  'tx.resolve',
  'x402.pay',
  'x402.resolve',
  'x402.pending',
  'vap.grants.list',
  'vap.grant.revoke',
  'vap.grant.request',
  'vap.grant.resolve',
  'vap.grant.pending',
  'account.exportKey',
  'solana.connect',
  'solana.signTransaction',
  'solana.signMessage',
  'faucet.request',
  'wc.pair',
  'wc.proposal.pending',
  'wc.proposal.approve',
  'wc.proposal.reject',
  'wc.session.list',
  'wc.session.disconnect',
  'wc.request.pending',
  'wc.request.resolve',
  'agent.status',
  'agent.configure',
  'agent.relay.register',
  'agent.relay.pairing-code',
  'agent.disable',
  'networks.list',
  'networks.selected',
  'networks.select',
  'networks.custom.add',
  'networks.custom.remove',
  'tokens.list',
  'tokens.add',
  'tokens.remove',
  'tokens.balances',
  'stellar.stealth.meta',
  'stellar.stealth.publish',
  'stellar.stealth.scan',
  'stellar.stealth.claim',
  'spp.status',
  'spp.register',
  'spp.deposit',
  'spp.transfer',
  'spp.withdraw',
]);
export type RequestKind = z.infer<typeof RequestKind>;

/**
 * Surfaces the extension itself owns, as opposed to anything running in a page.
 *
 * A passphrase has to reach the background somehow — the user types it into the
 * popup — so it necessarily crosses this bus. What must never happen is a page
 * or content script being able to send the same message. `PRIVILEGED_KINDS`
 * below is enforced by the router against the Chrome-supplied sender, so a
 * compromised content script cannot create, unlock, or destroy a vault even if
 * it forges `source`.
 */
export const EXTENSION_SOURCES: readonly MessageSource[] = [
  'popup',
  'options',
  'sidepanel',
] as const;

/** Kinds that carry a secret or perform an irreversible act. */
export const PRIVILEGED_KINDS: readonly RequestKind[] = [
  'vault.create',
  'vault.unlock',
  'vault.reset',
  'mnemonic.generate',
  // Signs with the vault's private key and broadcasts. Funds move, so it must
  // originate from our own UI — never from a page that merely claims to be it.
  'tx.transfer',
  // The PIN crosses the message bus and configures attestation, so it must
  // originate from our own surfaces.
  'security.pin.setup',
  'security.pin.verify',
  // Returns the raw private key for a chain account. Same threat profile as
  // `mnemonic.generate` — the single most sensitive kind on the bus — so it must
  // never be reachable from a compromised content script, the offscreen
  // document, or any non-extension-owned sender.
  'account.exportKey',
  // Mutates the per-origin approval store. A page that can write here grants
  // itself (or a target origin) standing access to the wallet's addresses, so
  // it is restricted to our own surfaces too.
  'permissions.grant',
  'permissions.revoke',
  // Resolving a pending dapp connection persists a grant (on approve), so it is
  // a privileged mutation exactly like `permissions.grant`. Only our own UI
  // surface may decide that.
  'permissions.connection',
  // Resolving a pending dapp transaction or signature request moves funds or
  // signs with the vault's key, so it is a privileged mutation like
  // `permissions.connection`. Only our own UI surface may decide that.
  'tx.resolve',
  // Resolving a pending x402 payment signs a payment payload with the vault's
  // key, so it is privileged exactly like `tx.resolve`. Only our own UI surface
  // may decide that.
  'x402.resolve',
  // Revoking a VAP grant removes an origin's standing payment authority, so it
  // mutates the authorization store exactly like `permissions.revoke`. Only our
  // own surfaces may do it.
  'vap.grant.revoke',
  // Resolving a pending grant request persists a standing grant, so it is a
  // privileged mutation like `permissions.connection`. Only our own UI surface
  // may decide it.
  'vap.grant.resolve',
  // Enumerating the full wallet address set across every chain reveals which
  // addresses the wallet holds. Restricted to our own surfaces so a compromised
  // page cannot harvest them.
  'accounts.list',
  // Pairing the agent bridge stores a token that lets a local process spend
  // within the user's grant caps. That is a standing spending authority, so it
  // is privileged exactly like `vap.grant.resolve` — only our own UI may set it,
  // never a page, content script, or the offscreen document.
  'agent.configure',
  'agent.relay.register',
  'agent.relay.pairing-code',
  'agent.disable',
  // Switching the active network changes where balances are read from and
  // where funds are broadcast — a page must never be able to redirect sends
  // onto its own RPC. Only our own surfaces may switch or register custom
  // RPC endpoints (a malicious custom network is the same attack).
  'networks.select',
  'networks.custom.add',
  'networks.custom.remove',
  // Adding a token can broadcast a Stellar trustline signed with the vault
  // key and records standing metadata the send path trusts; only our own
  // surfaces may do it, never a page.
  'tokens.add',
  'tokens.remove',
  // Stealth publish/claim derive keys from the vault and broadcast; scan
  // derives the wallet's own view/spend keys. All three require an unlocked
  // vault and must never be reachable from a page.
  'stellar.stealth.publish',
  'stellar.stealth.scan',
  'stellar.stealth.claim',
  // SPP (privacy pool) ops read the wallet's private pool balance, derive the
  // pool keys from a vault-signed message, and move funds through the pool.
  // Every one of them requires the unlocked vault and the wallet's own UI.
  'spp.status',
  'spp.register',
  'spp.deposit',
  'spp.transfer',
  'spp.withdraw',
] as const;

export function isPrivilegedKind(kind: RequestKind): boolean {
  return PRIVILEGED_KINDS.includes(kind);
}

const baseEnvelope = z.object({
  /** Correlates a response to its request. Generated by the sender. */
  id: z.string().uuid(),
  source: MessageSource,
  /** Bumped whenever the wire format changes incompatibly. */
  v: z.literal(1),
});

export const PingRequest = baseEnvelope.extend({
  kind: z.literal('ping'),
  payload: z.object({ sentAt: z.number().int().nonnegative() }),
});

export const VaultStatusRequest = baseEnvelope.extend({
  kind: z.literal('vault.status'),
  payload: z.object({}),
});

export const SessionLockRequest = baseEnvelope.extend({
  kind: z.literal('session.lock'),
  payload: z.object({}),
});

export const ZkCapabilityRequest = baseEnvelope.extend({
  kind: z.literal('zk.capability'),
  payload: z.object({}),
});

export const AccountsListRequest = baseEnvelope.extend({
  kind: z.literal('accounts.list'),
  payload: z.object({ accountIndex: z.number().int().nonnegative() }),
});

export const AccountBalanceRequest = baseEnvelope.extend({
  kind: z.literal('account.balance'),
  payload: z.object({ chain: ChainId, address: z.string().min(1) }),
});

/**
 * Transaction history from the Veilpay indexer. Runs in the service worker
 * (which holds host permissions, so extension pages never hit CORS on the
 * backend) and crosses the bus to the UI.
 */
export const IndexerHistoryRequest = baseEnvelope.extend({
  kind: z.literal('indexer.history'),
  payload: z.object({
    chain: ChainId,
    address: z.string().min(1),
    limit: z.number().int().positive().max(100).default(20),
  }),
});

/**
 * Passphrase minimum is enforced again in the vault; this bound only rejects
 * obvious junk early. The maximum exists because PBKDF2 hashes the input to
 * block size anyway, and an unbounded string is a free denial-of-service.
 */
const Passphrase = z.string().min(1).max(1024);

/** A non-negative integer as a decimal string (`bigint` cannot cross the bus). */
const Decimal = z.string().regex(/^\d+$/, 'Amount must be a non-negative integer.');
const MaxUint256 = 2n ** 256n - 1n;

/**
 * A non-negative, fractional decimal amount as a string, in human-readable
 * token units (e.g. "0.5" for half an XLM/ETH/SOL). The background converts to
 * base units using the chain's decimals. Unlike `NativeAmount` this allows a
 * fractional part, so the send form can accept "0.001" instead of requiring
 * the caller to pre-compute base units.
 */
const NativeDecimal = z
  .string()
  .regex(/^(0|[1-9]\d*)(\.\d+)?$/, 'Amount must be a non-negative decimal number.')
  .refine(
    (value) => {
      // Bound the magnitude so conversion cannot overflow a uint256 base amount.
      // Guard the BigInt math: zod runs this refine even when the regex above
      // failed, so a non-numeric input must yield `false`, not throw.
      const m = /^(0|[1-9]\d*)(?:\.(\d+))?$/.exec(value);
      if (m === null) return false;
      const whole = m[1] ?? '0';
      const frac = m[2] ?? '';
      const scaleRequired = frac.length;
      if (scaleRequired > 30) return false;
      let scaled: bigint;
      try {
        scaled = BigInt(whole) * 10n ** BigInt(scaleRequired) + BigInt(frac || '0');
      } catch {
        return false;
      }
      return scaled <= MaxUint256;
    },
    { message: 'Amount is outside the representable range.' }
  );

/**
 * A Stellar asset to pay in. Defaults to native XLM. An issued token is
 * identified by its asset code and issuer address so the payment op is built
 * with the correct ASSET_TYPE_CREDIT_ALPHANUM4/12.
 */
const StellarAsset = z
  .object({
    type: z.literal('native'),
  })
  .or(
    z.object({
      type: z.literal('issued'),
      /** Asset code, 1–12 chars (ASCII). */
      code: z.string().regex(/^[A-Za-z0-9]{1,12}$/),
      /** Issuer Stellar strkey (G...). */
      issuer: z.string().regex(/^G[A-Z2-7]{55}$/),
    })
  );
export type StellarAssetInput = z.infer<typeof StellarAsset>;

/**
 * Which token a send is denominated in. Spanning all three chains:
 *   - `native` — XLM / ETH / SOL;
 *   - `stellar-issued` — a Stellar asset (code + issuer);
 *   - `erc20` — an EVM ERC20 contract address;
 *   - `spl` — a Solana SPL token mint (base58).
 * The background resolves `decimals` and the spendable balance for the chosen
 * token, then converts the human-readable `amount` to base units.
 */
const TokenInput = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('native') }),
  z.object({
    kind: z.literal('stellar-issued'),
    /** Asset code, 1–12 chars (ASCII). */
    code: z.string().regex(/^[A-Za-z0-9]{1,12}$/),
    /** Issuer Stellar strkey (G...). */
    issuer: z.string().regex(/^G[A-Z2-7]{55}$/),
  }),
  z.object({
    kind: z.literal('erc20'),
    /** ERC20 contract address (0x + 40 hex). */
    address: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
  }),
  z.object({
    kind: z.literal('spl'),
    /** SPL token mint, base58 encoded. */
    mint: z.string().min(32).max(44),
  }),
]);
export type TokenInputType = z.infer<typeof TokenInput>;

export const VaultCreateRequest = baseEnvelope.extend({
  kind: z.literal('vault.create'),
  payload: z.object({
    mnemonic: z.string().min(1).max(1024),
    passphrase: Passphrase,
  }),
});

export const VaultUnlockRequest = baseEnvelope.extend({
  kind: z.literal('vault.unlock'),
  payload: z.object({ passphrase: Passphrase }),
});

/** Destructive. The UI must confirm before sending this. */
export const VaultResetRequest = baseEnvelope.extend({
  kind: z.literal('vault.reset'),
  payload: z.object({
    /** Literal typed by the user, checked again in the handler. */
    confirmation: z.literal('DELETE'),
  }),
});

export const MnemonicGenerateRequest = baseEnvelope.extend({
  kind: z.literal('mnemonic.generate'),
  payload: z.object({ strength: z.union([z.literal(128), z.literal(256)]) }),
});

/**
 * VAP grant caps. Declared here so the wire contract stays self-contained and
 * independently validatable (same reasoning as `ChainId`); `grant.ts` imports
 * and re-exports it, so domain code keeps one source of truth.
 */
export const GrantCaps = z.object({
  /** Hard ceiling per single operation, in base units (wei). */
  maxPerOperation: Decimal,
  /** Rolling-window ceiling, in base units (wei). */
  maxPerWindow: Decimal,
  /** Window length in seconds (1 min – 1 year). */
  windowSeconds: z.number().int().min(60).max(31_536_000),
  /** Above this amount, force user approval even in autonomous mode. */
  approvalThreshold: Decimal,
  /** Operation types this grant permits. */
  allowedOps: z.array(z.enum(['x402.pay', 'native.transfer'])).min(1),
  /** Chains payments may settle on. */
  allowedChains: z.array(ChainId).min(1),
  /** Allowed recipients; empty = any (discouraged but simple). */
  allowlist: z.array(z.string()),
});
export type GrantCaps = z.infer<typeof GrantCaps>;

/** Shared body for the two transfer kinds. `amount` is in human-readable units. */
const TransferPayload = {
  chain: ChainId,
  /** BIP-44 account index whose key signs the transfer. */
  index: z.number().int().nonnegative(),
  /** Chain-specific address (EVM hex, Solana base58, Stellar strkey). */
  to: z.string().min(1),
  /** Amount in human-readable token units (e.g. "0.5"). Converted to base units in the background. */
  amount: NativeDecimal,
  /**
   * Asset to pay in. `native` (default), a Stellar issued asset, an ERC20
   * contract, or an SPL mint. Back-compat: the legacy `asset` field (Stellar
   * native/issued) is still accepted and normalized to `token`.
   */
  asset: StellarAsset.optional(),
  token: TokenInput.optional(),
};

export const TxEstimateRequest = baseEnvelope.extend({
  kind: z.literal('tx.estimate'),
  payload: z.object(TransferPayload),
});

/** Builds, signs, and broadcasts a transfer. Irreversible once mined. */
export const TxTransferRequest = baseEnvelope.extend({
  kind: z.literal('tx.transfer'),
  payload: z.object({
    ...TransferPayload,
    /**
     * Optional Stellar transaction memo (MEMO_TEXT). Max 28 bytes once UTF-8
     * encoded — Stellar's on-chain limit. Only Stellar transfers attach it;
     * other chains reject the field rather than silently dropping it.
     */
    memo: z.string().max(28).optional(),
    /**
     * Stellar privacy payment: pay the recipient through a one-time stealth
     * address derived from their published meta-address, so the payment is
     * unlinkable on-chain. Requires the recipient to have published a
     * meta-address (manage_data `vpstealth`); the transfer fails with a clear
     * error if they have not. Incompatible with a text memo (the 32-byte
     * announcement rides in MEMO_HASH). Other chains reject the flag.
     */
    private: z.boolean().optional(),
  }),
});

const SecurityPinRequest = z.object({ pin: z.string().min(1).max(128) });

export const SecurityStatusRequest = baseEnvelope.extend({
  kind: z.literal('security.status'),
  payload: z.object({}),
});

export const SecurityPinSetupRequest = baseEnvelope.extend({
  kind: z.literal('security.pin.setup'),
  payload: SecurityPinRequest,
});

export const SecurityPinVerifyRequest = baseEnvelope.extend({
  kind: z.literal('security.pin.verify'),
  payload: SecurityPinRequest,
});

export const SecurityWebauthnSetupRequest = baseEnvelope.extend({
  kind: z.literal('security.webauthn.setup'),
  payload: z.object({}),
});

/**
 * Starts a WebAuthn authentication ceremony: the UI presents the returned
 * challenge to the authenticator and reports success via the resolve path.
 */
export const SecurityWebauthnChallengeRequest = baseEnvelope.extend({
  kind: z.literal('security.webauthn.challenge'),
  payload: z.object({}),
});

// ── EIP-1193 dapp provider ────────────────────────────────────────────────

export const EthChainIdRequest = baseEnvelope.extend({
  kind: z.literal('eth.chainId'),
  payload: z.object({}),
});

export const EthRequestAccountsRequest = baseEnvelope.extend({
  kind: z.literal('eth.requestAccounts'),
  payload: z.object({ origin: z.string().optional() }),
});

export const EthAccountsRequest = baseEnvelope.extend({
  kind: z.literal('eth.accounts'),
  payload: z.object({ origin: z.string().optional() }),
});

export const EthSendTransactionRequest = baseEnvelope.extend({
  kind: z.literal('eth.sendTransaction'),
  payload: z.object({
    origin: z.string().optional(),
    tx: z.object({
      /**
       * Sender. Optional because dapps routinely omit it and expect the wallet
       * to substitute its selected/approved account.
       */
      from: z.string().optional(),
      to: z.string().optional(),
      value: z.string().optional(),
      data: z.string().optional(),
      gas: z.string().optional(),
      gasPrice: z.string().optional(),
      maxFeePerGas: z.string().optional(),
      maxPriorityFeePerGas: z.string().optional(),
    }),
  }),
});

export const PersonalSignRequest = baseEnvelope.extend({
  kind: z.literal('personal.sign'),
  payload: z.object({
    origin: z.string().optional(),
    address: z.string(),
    /** Hex-encoded message to sign. */
    message: z.string(),
  }),
});

/**
 * Read-only EVM JSON-RPC passthrough for dapps.
 *
 * Dapps read balances, nonces, blocks, and call contracts through the injected
 * provider the moment they connect. The method is checked against an allowlist
 * in the background before it reaches the node, so this cannot be used to sign
 * or broadcast anything — only to read.
 */
export const EthRpcRequest = baseEnvelope.extend({
  kind: z.literal('eth.rpc'),
  payload: z.object({
    method: z.string().min(1),
    params: z.array(z.unknown()).default([]),
  }),
});

/**
 * EIP-712 typed-data signing (`eth_signTypedData_v4` in the provider).
 *
 * `typedData` is the dapp-supplied `{ types, domain, primaryType, message }`
 * object, forwarded verbatim so the user can review it and the background can
 * hash it per EIP-712. It must be JSON-serializable, which the message bus
 * already guarantees.
 */
export const EthSignTypedDataRequest = baseEnvelope.extend({
  kind: z.literal('eth.signTypedData'),
  payload: z.object({
    origin: z.string().optional(),
    address: z.string(),
    typedData: z.unknown(),
  }),
});

export const EthSwitchChainRequest = baseEnvelope.extend({
  kind: z.literal('eth.switchChain'),
  payload: z.object({
    origin: z.string().optional(),
    /** Hex chain id, e.g. "0xaa36a7" (Sepolia). */
    chainId: z.string(),
  }),
});

// ── Per-origin permissions ─────────────────────────────────────────────────

export const PermissionsListRequest = baseEnvelope.extend({
  kind: z.literal('permissions.list'),
  payload: z.object({}),
});

export const PermissionsGrantRequest = baseEnvelope.extend({
  kind: z.literal('permissions.grant'),
  payload: z.object({
    origin: z.string(),
    addresses: z.array(z.string()),
  }),
});

export const PermissionsRevokeRequest = baseEnvelope.extend({
  kind: z.literal('permissions.revoke'),
  payload: z.object({ origin: z.string() }),
});

export const PermissionsPendingRequest = baseEnvelope.extend({
  kind: z.literal('permissions.pending'),
  payload: z.object({}),
});

/** Resolves a pending dapp connection request. `action: 'approve'` persists a
 * grant; `'deny'` just clears the pending record. */
export const PermissionsConnectionRequest = baseEnvelope.extend({
  kind: z.literal('permissions.connection'),
  payload: z.object({
    origin: z.string(),
    /**
     * Only meaningful when `action === 'approve'`: the addresses to grant.
     * Drawn from the wallet's own accounts so the page cannot inject arbitrary
     * addresses, but verified by the handler against the vault.
     */
    addresses: z.array(z.string()),
    action: z.enum(['approve', 'deny']),
  }),
});

/**
 * Pending dapp transaction / signature approval.
 *
 * A dapp's `eth.sendTransaction` or `personal.sign` request that needs a human
 * decision is parked here (in the background) until the user approves or
 * rejects it from an extension surface. Mirrors `permissions.pending`.
 */
export const TxPendingRequest = baseEnvelope.extend({
  kind: z.literal('tx.pending'),
  payload: z.object({}),
});

/** Resolves a pending dapp transaction / signature request. */
export const TxResolveRequest = baseEnvelope.extend({
  kind: z.literal('tx.resolve'),
  payload: z.object({
    /** The pending request's id (from `tx.pending`). */
    id: z.string().min(1),
    action: z.enum(['approve', 'deny']),
  }),
});

// ── x402 agent payments ───────────────────────────────────────────────────

/**
 * A page submits an x402 challenge it received from a server's 402 response.
 *
 * The background validates the challenge, parks a pending payment request, opens
 * the approval surface, and — on user approval — signs a payment payload and
 * returns the `X-PAYMENT` header value the page replays. The challenge shape is
 * defined in `@/core/x402/types` and referenced here so the wire contract and
 * the signing module cannot drift apart.
 */
export const X402PayRequest = baseEnvelope.extend({
  kind: z.literal('x402.pay'),
  payload: z.object({
    challenge: X402Challenge,
  }),
});

/** Resolves a pending x402 payment. Privileged: only our own UI surface. */
export const X402ResolveRequest = baseEnvelope.extend({
  kind: z.literal('x402.resolve'),
  payload: z.object({
    /** The pending request's id (from `x402.pending`). */
    id: z.string().min(1),
    action: z.enum(['approve', 'deny']),
  }),
});

/** Reads the current pending x402 payment, if any. */
export const X402PendingRequest = baseEnvelope.extend({
  kind: z.literal('x402.pending'),
  payload: z.object({}),
});

// ── VAP grants ────────────────────────────────────────────────────────────

/** Lists active grants (for display in settings and agent surfaces). */
export const VapGrantsListRequest = baseEnvelope.extend({
  kind: z.literal('vap.grants.list'),
  payload: z.object({}),
});

/** Revokes a grant by id. Privileged: only our own surfaces may do it. */
export const VapGrantRevokeRequest = baseEnvelope.extend({
  kind: z.literal('vap.grant.revoke'),
  payload: z.object({ id: z.string().min(1) }),
});

/**
 * A page requests a grant. Always prompts — grant negotiation is never silent.
 * Caps come from the page but are validated and shown verbatim in the overlay.
 */
export const VapGrantRequestRequest = baseEnvelope.extend({
  kind: z.literal('vap.grant.request'),
  payload: z.object({
    caps: GrantCaps,
    /** Requested lifetime in seconds; the handler caps it at 90 days. */
    expiresInSeconds: z.number().int().positive().max(7_776_000),
  }),
});

/** Resolves a pending grant request. Privileged: only our own UI surface. */
export const VapGrantResolveRequest = baseEnvelope.extend({
  kind: z.literal('vap.grant.resolve'),
  payload: z.object({
    id: z.string().min(1),
    action: z.enum(['approve', 'deny']),
    /**
     * PIN required when approving and a PIN is configured (VAP-01). Carried
     * over the bus only from our own UI surface (the resolve kind is
     * privileged), verified by the background before the grant is created.
     */
    pin: z.string().max(128).optional(),
    /**
     * True when the UI completed a WebAuthn passkey ceremony for this approval.
     * Required when WebAuthn is enabled and no PIN is configured (VAP-01).
     * The ceremony runs in the UI context (`navigator.credentials` is not
     * available in the service worker); this flag travels the privileged
     * resolve kind, so a page cannot forge it.
     */
    webauthn: z.boolean().optional(),
  }),
});

/** Reads the current pending grant request, if any. */
export const VapGrantPendingRequest = baseEnvelope.extend({
  kind: z.literal('vap.grant.pending'),
  payload: z.object({}),
});

export const AccountExportKeyRequest = baseEnvelope.extend({
  kind: z.literal('account.exportKey'),
  payload: z.object({
    chain: ChainId,
    index: z.number().int().nonnegative(),
  }),
});

// ── Solana dapp provider ─────────────────────────────────────────────────

export const SolanaConnectRequest = baseEnvelope.extend({
  kind: z.literal('solana.connect'),
  payload: z.object({ origin: z.string().optional() }),
});

export const SolanaSignTransactionRequest = baseEnvelope.extend({
  kind: z.literal('solana.signTransaction'),
  payload: z.object({
    origin: z.string().optional(),
    /** Base58-encoded transaction. */
    transaction: z.string(),
  }),
});

export const SolanaSignMessageRequest = baseEnvelope.extend({
  kind: z.literal('solana.signMessage'),
  payload: z.object({
    origin: z.string().optional(),
    address: z.string(),
    /** Base58-encoded message to sign. */
    message: z.string(),
  }),
});

/** Requests testnet funds for a chain address (faucet, from the SW). */
export const FaucetRequest = baseEnvelope.extend({
  kind: z.literal('faucet.request'),
  payload: z.object({
    chain: ChainId,
    /** Chain-specific address is enough; the faucet does not need the key. */
    address: z.string().min(1),
  }),
});

/**
 * WalletConnect pairing and session management.
 *
 * These flow through the same typed, Zod-validated bus as every other request.
 * `wc.pair` carries a WC URI pasted from a dapp's QR code / deep link;
 * proposals and session requests arrive over the relay and are surfaced to the
 * approval surface via the pending stores, exactly like dapp connection requests.
 */
export const WcPairRequest = baseEnvelope.extend({
  kind: z.literal('wc.pair'),
  payload: z.object({
    /** A `wc:` URI from a dapp QR code or deep link. */
    uri: z.string().regex(/^wc:/),
  }),
});

export const WcProposalPendingRequest = baseEnvelope.extend({
  kind: z.literal('wc.proposal.pending'),
  payload: z.object({}),
});

export const WcProposalApproveRequest = baseEnvelope.extend({
  kind: z.literal('wc.proposal.approve'),
  payload: z.object({
    proposalId: z.number().int().positive(),
    /** Addresses to grant the dapp. First approved EVM account when empty. */
    accounts: z.array(z.string()).default([]),
  }),
});

export const WcProposalRejectRequest = baseEnvelope.extend({
  kind: z.literal('wc.proposal.reject'),
  payload: z.object({
    proposalId: z.number().int().positive(),
  }),
});

export const WcSessionListRequest = baseEnvelope.extend({
  kind: z.literal('wc.session.list'),
  payload: z.object({}),
});

export const WcSessionDisconnectRequest = baseEnvelope.extend({
  kind: z.literal('wc.session.disconnect'),
  payload: z.object({
    topic: z.string().min(1),
  }),
});

export const WcRequestPendingRequest = baseEnvelope.extend({
  kind: z.literal('wc.request.pending'),
  payload: z.object({}),
});

export const WcRequestResolveRequest = baseEnvelope.extend({
  kind: z.literal('wc.request.resolve'),
  payload: z.object({
    action: z.enum(['approve', 'deny']),
  }),
});

/**
 * Agent bridge — lets an MCP server (Claude, etc.) request payments.
 *
 * The extension cannot be reached inbound, so it long-polls a localhost bridge
 * the MCP server exposes. These kinds manage that pairing; the payments
 * themselves flow through the same grant and approval machinery as any dapp.
 */
export const AgentStatusRequest = baseEnvelope.extend({
  kind: z.literal('agent.status'),
  payload: z.object({}),
});

export const AgentConfigureRequest = baseEnvelope.extend({
  kind: z.literal('agent.configure'),
  payload: z.object({
    mode: z.enum(['local', 'relay']),
    /** Origin only: `http://127.0.0.1:8765` or `https://relay.example`. */
    baseUrl: z.string().min(1).max(2048),
    /** Local: pairing token. Relay: the wallet secret issued at registration. */
    token: z.string().min(16).max(256),
    /** Relay only: identifies this wallet's queue on the server. */
    walletId: z.string().min(1).max(128).optional(),
  }),
});

/**
 * Registers this wallet with a relay. The relay answers with a short pairing
 * code the user enters where they configured the AI client, plus the wallet
 * secret this extension stores for the connection.
 */
export const AgentRelayRegisterRequest = baseEnvelope.extend({
  kind: z.literal('agent.relay.register'),
  payload: z.object({
    baseUrl: z.string().min(1).max(2048),
  }),
});

export const AgentRelayPairingCodeRequest = baseEnvelope.extend({
  kind: z.literal('agent.relay.pairing-code'),
  payload: z.object({
    /** True when a human asked for the code (button click) rather than the
     * panel's automatic refresh: a manual ask may bypass the self-recovery
     * cooldown, so the click always heals a relay that restarted. */
    manual: z.boolean().optional(),
  }),
});

export const AgentDisableRequest = baseEnvelope.extend({
  kind: z.literal('agent.disable'),
  payload: z.object({}),
});

// ── Network selection ─────────────────────────────────────────────────────

/**
 * A network the UI can render: the registry's public summary (no closures,
 * since `explorerTx` cannot cross the message bus).
 */
export const NetworkSummary = z.object({
  id: z.string().min(1),
  chain: ChainId,
  kind: z.enum(['mainnet', 'testnet']),
  name: z.string().min(1),
  symbol: z.string().min(1),
  rpcUrls: z.array(z.string().url()),
  chainId: z.number().int().positive().optional(),
  explorerTx: z.string().url().optional(),
  faucet: z.boolean(),
});
export type NetworkSummary = z.infer<typeof NetworkSummary>;

export const NetworksListRequest = baseEnvelope.extend({
  kind: z.literal('networks.list'),
  payload: z.object({
    /** Filter to one chain; omit to list every selectable network. */
    chain: ChainId.optional(),
  }),
});

export const NetworksSelectedRequest = baseEnvelope.extend({
  kind: z.literal('networks.selected'),
  payload: z.object({}),
});

export const NetworksSelectRequest = baseEnvelope.extend({
  kind: z.literal('networks.select'),
  payload: z.object({
    chain: ChainId,
    /** Preset id ('evm:sepolia') or custom id ('custom:My node'). */
    networkId: z.string().min(1),
  }),
});

export const NetworksCustomAddRequest = baseEnvelope.extend({
  kind: z.literal('networks.custom.add'),
  payload: z.object({
    chain: ChainId,
    /** Display name; unique across the custom list. */
    name: z.string().min(1).max(64),
    rpcUrl: z.string().url(),
    /** EVM only: EIP-155 chain id the network signs with. */
    chainId: z.number().int().positive().optional(),
    explorerUrl: z.string().url().optional(),
  }),
});

export const NetworksCustomRemoveRequest = baseEnvelope.extend({
  kind: z.literal('networks.custom.remove'),
  payload: z.object({
    name: z.string().min(1).max(64),
  }),
});

// ── Custom tokens (MetaMask-style add-token) ───────────────────────────────

/** A registered custom token, as it crosses the bus. */
export const CustomToken = z.object({
  id: z.string().min(1),
  chain: ChainId,
  kind: z.enum(['erc20', 'spl', 'stellar-issued']),
  address: z.string().optional(),
  code: z.string().optional(),
  issuer: z.string().optional(),
  symbol: z.string().min(1).max(32),
  name: z.string().max(128).optional(),
  decimals: z.number().int().min(0).max(255),
  addedAt: z.number().int().nonnegative(),
});
export type CustomToken = z.infer<typeof CustomToken>;

export const TokensListRequest = baseEnvelope.extend({
  kind: z.literal('tokens.list'),
  payload: z.object({
    chain: ChainId.optional(),
  }),
});

/**
 * Registers a custom token.
 *
 * - EVM: the contract's `decimals()`/`symbol()` are read from the chain and
 *   override any caller-supplied values;
 * - Solana: the mint's decimals byte is read from the chain;
 * - Stellar: an issued asset (code + issuer). `createTrustline` (default
 *   true) broadcasts a CHANGE_TRUST op so the account can actually hold it.
 */
export const TokensAddRequest = baseEnvelope.extend({
  kind: z.literal('tokens.add'),
  payload: z.object({
    chain: ChainId,
    /** EVM contract address / Solana mint. */
    contract: z.string().optional(),
    /** Stellar asset code. */
    code: z.string().regex(/^[A-Za-z0-9]{1,12}$/).optional(),
    /** Stellar issuer strkey. */
    issuer: z.string().regex(/^G[A-Z2-7]{55}$/).optional(),
    /** Optional display overrides when the chain cannot supply them. */
    symbol: z.string().min(1).max(32).optional(),
    name: z.string().max(128).optional(),
    /** Stellar: broadcast the trustline (default true). */
    createTrustline: z.boolean().optional(),
  }),
});

export const TokensRemoveRequest = baseEnvelope.extend({
  kind: z.literal('tokens.remove'),
  payload: z.object({
    id: z.string().min(1),
  }),
});

export const TokensBalancesRequest = baseEnvelope.extend({
  kind: z.literal('tokens.balances'),
  payload: z.object({
    chain: ChainId,
    address: z.string().min(1),
  }),
});

// ── Stellar privacy payments (pXLM stealth) ────────────────────────────────

/**
 * Resolves a recipient's published stealth meta-address — the public
 * {spendPub, viewPub} pair a Veilpay wallet writes into its account data.
 * Read-only; anyone may look it up, exactly like a public address.
 */
export const StellarStealthMetaRequest = baseEnvelope.extend({
  kind: z.literal('stellar.stealth.meta'),
  payload: z.object({
    /** The recipient's ordinary Stellar address (G...). */
    address: z.string().regex(/^G[A-Z2-7]{55}$/),
  }),
});

/**
 * Publishes THIS wallet's stealth meta-address onto its Stellar account
 * (manage_data `vpstealth`), so payers can derive private one-time addresses
 * for it. Privileged: signs with the vault key.
 */
export const StellarStealthPublishRequest = baseEnvelope.extend({
  kind: z.literal('stellar.stealth.publish'),
  payload: z.object({}),
});

/**
 * Scans recent network transactions for stealth payments THIS wallet can
 * recover (the Monero-style view-key scan). Privileged: derives the wallet's
 * view/spend keys, which requires the unlocked vault.
 */
export const StellarStealthScanRequest = baseEnvelope.extend({
  kind: z.literal('stellar.stealth.scan'),
  payload: z.object({}),
});

/**
 * Sweeps a found one-time account into the wallet's ordinary Stellar
 * account, signing with the derived one-time key. Privileged.
 */
export const StellarStealthClaimRequest = baseEnvelope.extend({
  kind: z.literal('stellar.stealth.claim'),
  payload: z.object({
    /** The announcement transaction's hash (from `stellar.stealth.scan`). */
    txHash: z.string().min(1),
  }),
});

// ── Stellar Private Payments (SPP privacy pool, pXLM) ─────────────────────

/**
 * Pool status for the wallet: private balance, registration state, and the
 * deployment summary the UI needs to render the privacy surface.
 *
 * All SPP kinds are privileged — they read the wallet's private pool state and
 * move funds, and the pool keys are derived from a vault-signed message.
 */
export const SppStatusRequest = baseEnvelope.extend({
  kind: z.literal('spp.status'),
  payload: z.object({}),
});

/** Registers the wallet's pool public keys on-chain (public key registry). */
export const SppRegisterRequest = baseEnvelope.extend({
  kind: z.literal('spp.register'),
  payload: z.object({}),
});

/** Shields XLM into the privacy pool (creates private notes). */
export const SppDepositRequest = baseEnvelope.extend({
  kind: z.literal('spp.deposit'),
  payload: z.object({
    /** Amount in stroops (XLM's 10⁻⁷ base unit), as a decimal string. */
    amountStroops: Decimal,
  }),
});

/** Sends a private transfer inside the pool to a registered recipient. */
export const SppTransferRequest = baseEnvelope.extend({
  kind: z.literal('spp.transfer'),
  payload: z.object({
    /** Recipient's ordinary Stellar address (G…); must have registered keys. */
    to: z.string().regex(/^G[A-Z2-7]{55}$/),
    /** Amount in stroops, as a decimal string. */
    amountStroops: Decimal,
  }),
});

/** Unshields private notes back to the wallet's public XLM balance. */
export const SppWithdrawRequest = baseEnvelope.extend({
  kind: z.literal('spp.withdraw'),
  payload: z.object({
    /** Amount in stroops, as a decimal string. */
    amountStroops: Decimal,
  }),
});

export const Request = z.discriminatedUnion('kind', [
  PingRequest,
  VaultStatusRequest,
  SessionLockRequest,
  ZkCapabilityRequest,
  AccountsListRequest,
  AccountBalanceRequest,
  IndexerHistoryRequest,
  TxEstimateRequest,
  TxTransferRequest,
  VaultCreateRequest,
  VaultUnlockRequest,
  VaultResetRequest,
  MnemonicGenerateRequest,
  SecurityStatusRequest,
  SecurityPinSetupRequest,
  SecurityPinVerifyRequest,
  SecurityWebauthnSetupRequest,
  SecurityWebauthnChallengeRequest,
  EthChainIdRequest,
  EthRequestAccountsRequest,
  EthAccountsRequest,
  EthSendTransactionRequest,
  EthSwitchChainRequest,
  PersonalSignRequest,
  EthRpcRequest,
  EthSignTypedDataRequest,
  PermissionsListRequest,
  PermissionsGrantRequest,
  PermissionsRevokeRequest,
  PermissionsPendingRequest,
  PermissionsConnectionRequest,
  TxPendingRequest,
  TxResolveRequest,
  X402PayRequest,
  X402ResolveRequest,
  X402PendingRequest,
  VapGrantsListRequest,
  VapGrantRevokeRequest,
  VapGrantRequestRequest,
  VapGrantResolveRequest,
  VapGrantPendingRequest,
  AccountExportKeyRequest,
  SolanaConnectRequest,
  SolanaSignTransactionRequest,
  SolanaSignMessageRequest,
  FaucetRequest,
  WcPairRequest,
  WcProposalPendingRequest,
  WcProposalApproveRequest,
  WcProposalRejectRequest,
  WcSessionListRequest,
  WcSessionDisconnectRequest,
  WcRequestPendingRequest,
  WcRequestResolveRequest,
  AgentStatusRequest,
  AgentConfigureRequest,
  AgentRelayRegisterRequest,
  AgentRelayPairingCodeRequest,
  AgentDisableRequest,
  NetworksListRequest,
  NetworksSelectedRequest,
  NetworksSelectRequest,
  NetworksCustomAddRequest,
  NetworksCustomRemoveRequest,
  TokensListRequest,
  TokensAddRequest,
  TokensRemoveRequest,
  TokensBalancesRequest,
  StellarStealthMetaRequest,
  StellarStealthPublishRequest,
  StellarStealthScanRequest,
  StellarStealthClaimRequest,
  SppStatusRequest,
  SppRegisterRequest,
  SppDepositRequest,
  SppTransferRequest,
  SppWithdrawRequest,
]);
export type Request = z.infer<typeof Request>;

export const VaultState = z.enum(['uninitialized', 'locked', 'unlocked']);
export type VaultState = z.infer<typeof VaultState>;

/**
 * Outcome of the D3 spike, as a single discriminant.
 *
 * This exists because a bare `proofGenerationWorks: false` conflates two results
 * that demand opposite responses: "the CSP refuses to run snarkjs" means shielded
 * transactions move to Phase 5, while "we have not vendored the circuit
 * artifacts" means we have not measured this tier at all. Storing only the
 * boolean made the highest-risk decision in the plan unanswerable from the
 * recorded evidence.
 */
export const ZkProbeStatus = z.enum([
  /** WASM compiled, snarkjs imported, and a real Groth16 proof completed. */
  'viable',
  /** WASM or the snarkjs module graph was refused. ZK cannot run in-extension. */
  'blocked-csp',
  /** snarkjs loaded, but proving errored. A circuit or version problem, not CSP. */
  'proof-failed',
  /** Circuit artifacts absent, so the proving tier was never exercised. Unknown. */
  'untested-artifacts',
  /** The probe itself could not run, so nothing at all was measured. */
  'unavailable',
]);
export type ZkProbeStatus = z.infer<typeof ZkProbeStatus>;

export const ZkCapability = z.object({
  status: ZkProbeStatus,
  wasmCompileWorks: z.boolean(),
  snarkjsImportWorks: z.boolean(),
  /** Null when proving was never attempted, which is not the same as `false`. */
  proofGenerationWorks: z.boolean().nullable(),
  /** Wall-clock of a completed proof, for the Phase 3 latency budget. */
  proofElapsedMs: z.number().int().nonnegative().nullable(),
  /** Present when something failed, for the D3 write-up. */
  failureReason: z.string().nullable(),
  measuredAt: z.number().int().nonnegative(),
});
export type ZkCapability = z.infer<typeof ZkCapability>;

export const ResponseOk = z.object({
  id: z.string().uuid(),
  ok: z.literal(true),
  data: z.unknown(),
});

export const ResponseErr = z.object({
  id: z.string().uuid(),
  ok: z.literal(false),
  error: z.object({
    code: z.enum([
      'BAD_REQUEST',
      'UNKNOWN_KIND',
      'VAULT_LOCKED',
      'INTERNAL',
      'ORIGIN_DENIED',
      // A dapp requested accounts but no approval exists yet; the wallet has
      // opened its approval UI. The dapp should surface "awaiting approval" and
      // retry — the pending request resolves to a grant (or stays denied).
      'CONNECT_PENDING',
      // The user explicitly rejected a dapp transaction or signature request.
      'USER_REJECTED',
      // A dapp transaction/signature request aged out before a human decided.
      'APPROVAL_TIMEOUT',
      // The dapp asked to switch to an EVM chain this wallet does not support.
      // Maps to EIP-1193 error 4902 ("Unrecognized chain").
      'CHAIN_UNSUPPORTED',
      // An x402 challenge failed validation (expired, replayed, mismatched
      // origin, malformed) and was rejected before any signing.
      'X402_INVALID_CHALLENGE',
      // The origin has triggered too many approval prompts in a rolling minute.
      // Consent-fatigue defense (spec §9).
      'PROMPT_RATE_LIMITED',
      // The chain/node rejected a broadcast (e.g. insufficient funds).
      // Message carries the display-safe node reason.
      'TX_REJECTED',
      // The wallet itself rejected a send before broadcast because the
      // spendable balance (in base units) is below the amount plus fee.
      'INSUFFICIENT_BALANCE',
    ]),
    /** Safe for display. Never contains key material or stack traces. */
    message: z.string(),
  }),
});

export const Response = z.union([ResponseOk, ResponseErr]);
export type Response = z.infer<typeof Response>;

/** Maps each request kind to the shape of its `data` on success. */
export interface ResponseData {
  ping: { sentAt: number; receivedAt: number; roundTripHint: number };
  'vault.status': { state: VaultState; unlockedUntil: number | null };
  'session.lock': { state: VaultState };
  'zk.capability': ZkCapability | null;
  'accounts.list': Array<{
    chain: ChainId;
    index: number;
    address: string;
    path: string;
  }>;
  /** `balance` is a decimal string: `bigint` cannot cross the message bus. */
  'account.balance': { chain: ChainId; address: string; balance: string };
  /** Indexer transaction history. `source` distinguishes live vs cached. */
  'indexer.history': {
    transactions: Array<{
      hash: string;
      chain: ChainId;
      block: number;
      timestamp: string;
      from: string;
      to: string;
      amount: string;
      fee: string;
      status: 'confirmed' | 'pending' | 'failed';
    }>;
    nextCursor: string | null;
    source: 'remote' | 'cache';
  };
  /** Fee preview for a transfer. Fee is in base units (stroops / lamports / wei). Nothing is broadcast. */
  'tx.estimate': {
    chain: ChainId;
    /** Sender address that would sign. */
    from: string;
    /** Total fee in base units. */
    feeNative: string;
    gasLimit: string;
    /** Asset code being sent, for Stellar issued tokens. */
    assetCode?: string;
    /** Decimal places of the chosen token (18 ETH, ERC20 decimals(), 9 SOL/SPL, 7 XLM). */
    decimals: number;
    /** Spendable token balance for the sender, in base units (string of a bigint). */
    spendableBalance: string;
    /** Display symbol of the chosen token (e.g. "USDC"); falls back to native symbol. */
    symbol?: string;
  };
  /** A transfer that was built, signed, and broadcast. */
  'tx.transfer': {
    chain: ChainId;
    from: string;
    to: string;
    /** Amount moved, in base units (wei / lamports / stroops). */
    amountNative: string;
    /** Transaction hash, once broadcast. */
    hash: string;
    /** Decimal places of the token that was sent. */
    decimals: number;
    /** True for a Stellar stealth payment: `to` is a one-time address. */
    private?: boolean;
  };
  'vault.create': { state: VaultState };
  'vault.unlock': { state: VaultState; unlockedUntil: number | null };
  'vault.reset': { state: VaultState };
  /**
   * A freshly generated phrase, returned once for the user to write down.
   * It is not persisted anywhere until `vault.create` is called with it.
   */
  'mnemonic.generate': { mnemonic: string };
  'security.status': { pinEnabled: boolean; webauthnEnabled: boolean };
  'security.pin.setup': { ok: boolean };
  'security.pin.verify': { ok: boolean };
  'security.webauthn.setup': { ok: boolean };
  /** Challenge hex for a WebAuthn ceremony, with the registered credential id. */
  'security.webauthn.challenge': { credentialId: string; challenge: string };
  /** Hex-encoded chain ID, e.g. "0xaa36a7" (Sepolia). */
  'eth.chainId': { chainId: string };
  /** Array of hex addresses the origin has permission to use. */
  'eth.requestAccounts': { accounts: string[] };
  'eth.accounts': { accounts: string[] };
  /** Transaction hash for a broadcast tx. */
  'eth.sendTransaction': { hash: string };
  /** Confirms the switch; the wallet emits `chainChanged` on success. */
  'eth.switchChain': { chainId: string };
  /** Signature as hex string. */
  'personal.sign': { signature: string };
  /** Result of a read-only EVM RPC passthrough (JSON-serializable). */
  'eth.rpc': { result: unknown };
  /** EIP-712 signature (65-byte `r || s || v` hex) for typed data. */
  'eth.signTypedData': { signature: string };
  'permissions.list': Array<{
    origin: string;
    addresses: string[];
    createdAt: number;
    lastUsedAt: number;
  }>;
  'permissions.grant': { ok: boolean };
  'permissions.revoke': { ok: boolean };
  'permissions.pending': {
    origin: string;
    requestedAccounts: { chain: string; address: string }[];
    createdAt: number;
  } | null;
  'permissions.connection': { ok: boolean };
  /** The pending dapp transaction/signature request awaiting approval, if any. */
  'tx.pending': {
    id: string;
    /** What the dapp asked to do: broadcast a transaction or sign a message. */
    kind: 'tx' | 'sign';
    /** Origin that requested the operation (the Chrome-stamped page origin). */
    origin: string;
    /** Address that would sign / is being signed. */
    address: string;
    /** For kind 'tx': recipient address. */
    to?: string;
    /** For kind 'tx': value in wei (decimal string). */
    value?: string;
    /** For kind 'tx': hex-encoded calldata, or undefined for a plain transfer. */
    data?: string;
    /** For kind 'sign': the hex-encoded message to sign. */
    message?: string;
    /** Display symbol for `value` (e.g. "SOL"); absent means ETH. */
    symbol?: string;
    /** Decimals for `value`; absent means 18. */
    decimals?: number;
    /** When the request was registered, so the UI can age it out. */
    createdAt: number;
  } | null;
  'tx.resolve': { ok: boolean };
  /** The `X-PAYMENT` header value the page replays with its request. */
  'x402.pay': { paymentHeader: string };
  'x402.resolve': { ok: boolean };
  /** The pending x402 payment request awaiting a human decision, if any. */
  'x402.pending': {
    id: string;
    origin: string;
    challenge: X402Challenge;
    createdAt: number;
  } | null;
  /** Active VAP grants, for settings and agent surfaces. */
  'vap.grants.list': Grant[];
  'vap.grant.revoke': { ok: boolean };
  'vap.grant.request': { grantId: string };
  'vap.grant.resolve': { ok: boolean };
  'vap.grant.pending': {
    id: string;
    origin: string;
    requestedCaps: GrantCaps;
    expiresInSeconds: number;
    createdAt: number;
  } | null;
  'account.exportKey': { privateKey: string; address: string };
  /** Solana provider. */
  'solana.connect': { publicKey: string };
  /** Signed transaction in base58. */
  'solana.signTransaction': { signature: string; signedTransaction: string };
  /** Signed message. */
  'solana.signMessage': { signature: string; publicKey: string };
  'faucet.request': { ok: boolean; txHash?: string; faucetUrl?: string };
  /** A WalletConnect pair() was accepted; the proposal may follow async. */
  'wc.pair': { ok: boolean };
  /** Pending WalletConnect session proposal awaiting approval, if any. */
  'wc.proposal.pending': {
    id: number;
    /** Display name of the requesting dapp. */
    name: string;
    /** Dapp origin/URL, for the user to verify. */
    url: string;
    /** Requested chain namespaces, e.g. `{"eip155": [...chains]}`. */
    requiredNamespaces: Record<string, { chains: string[]; methods: string[]; events: string[] }>;
    /** Optional chain namespaces, when present. */
    optionalNamespaces?: Record<string, { chains: string[]; methods: string[]; events: string[] }>;
    expiry: number;
    createdAt: number;
  } | null;
  'wc.proposal.approve': { ok: boolean };
  'wc.proposal.reject': { ok: boolean };
  /** Active WalletConnect sessions. */
  'wc.session.list': Array<{
    topic: string;
    /** Display name of the connected dapp. */
    name: string;
    /** Dapp origin/URL. */
    url: string;
    /** Connected account addresses. */
    accounts: string[];
    /** When the session was established. */
    createdAt: number;
    /** ISO expiry timestamp. */
    expiry: string;
  }>;
  'wc.session.disconnect': { ok: boolean };
  /** Pending WalletConnect session request awaiting approval, if any. */
  'wc.request.pending': {
    topic: string;
    requestId: number;
    chainId: string;
    method: string;
    /** Human-readable hint of what the dapp asked (e.g. signed message length). */
    hint: string;
    createdAt: number;
  } | null;
  'wc.request.resolve': { ok: boolean };
  /** Agent bridge pairing state. Never returns the token itself. */
  'agent.status': {
    /** True once a token and endpoint are stored. */
    enabled: boolean;
    mode: 'local' | 'relay' | null;
    /** The endpoint the extension polls (port implied for local). */
    endpoint: string | null;
    paired: boolean;
    /** Whether the bridge answered the most recent poll. */
    connected: boolean;
    /** Epoch ms of the last successful poll, or null. */
    lastPollAt: number | null;
  };
  'agent.configure': { ok: boolean };
  /** Relay registration: the single public URL shared by all Veilpay users. */
  'agent.relay.register': {
    mcpUrl: string;
    walletId: string;
    pairingCode: string;
    pairingCodeExpiresAt: number;
  };
  'agent.relay.pairing-code': { pairingCode: string; pairingCodeExpiresAt: number };
  'agent.disable': { ok: boolean };
  /** Selectable networks (presets + the user's custom RPCs), optionally per chain. */
  'networks.list': NetworkSummary[];
  /** Currently selected network id per chain. */
  'networks.selected': Record<string, string>;
  /** Whether the selection was applied. False when the id does not resolve. */
  'networks.select': { ok: boolean };
  /** Whether the custom network was added. False on a duplicate name. */
  'networks.custom.add': { ok: boolean };
  'networks.custom.remove': { ok: boolean };
  /** Registered custom tokens, optionally filtered to a chain. */
  'tokens.list': CustomToken[];
  /** The registered token, plus the trustline tx hash when one was created. */
  'tokens.add': { token: CustomToken; trustlineHash?: string };
  'tokens.remove': { ok: boolean };
  /** Base-unit balances of every registered token for one address. */
  'tokens.balances': Array<{ id: string; balance: string }>;

  // ── Stellar privacy payments (pXLM stealth) ──────────────────────────────
  /** The recipient's published stealth meta-address (hex keys), or null. */
  'stellar.stealth.meta': { spendPub: string; viewPub: string } | null;
  /** The manage_data broadcast that published the meta-address. */
  'stellar.stealth.publish': { txHash: string; alreadyPublished: boolean };
  /**
   * Stealth payments this wallet can recover: each pairs the announcement
   * transaction with the one-time address it funded and that balance.
   */
  'stellar.stealth.scan': Array<{
    txHash: string;
    oneTimeAddress: string;
    /** Claimable balance in stroops (a decimal string; bigint can't cross the bus). */
    amountStroops: string;
    createdAt: string;
  }>;
  /** The account-merge sweep that claimed a stealth payment. */
  'stellar.stealth.claim': { txHash: string };

  // ── Stellar Private Payments (SPP privacy pool, pXLM) ─────────────────────

  /** Pool status: private balance, registration, and deployment summary. */
  'spp.status': {
    /** The pool this wallet talks to (contract id, C…). */
    poolContractId: string;
    /** Token symbol the pool wraps ("pXLM" presentation is UI-side). */
    assetSymbol: string;
    /** Spendable private balance in stroops (decimal string of a bigint). */
    balanceStroops: string;
    /** Whether the wallet's pool public keys are registered on-chain. */
    registered: boolean;
    /** Whether the local indexer needs a historical-sync bootnode. */
    bootnodeRequired: boolean;
    /** Latest ledger the local pool index has ingested. */
    syncedLedger: number;
    /** Epoch ms of the status read. */
    readAt: number;
  };
  /** The public key registry transaction hash. */
  'spp.register': { txHash: string };
  /** The deposit result: transaction hash plus pool-internal details. */
  'spp.deposit': { txHash: string; amountStroops: string };
  /** The private transfer result: transaction hash (amount/recipient stay private). */
  'spp.transfer': { txHash: string; amountStroops: string };
  /** The withdraw result: transaction hash plus pool-internal details. */
  'spp.withdraw': { txHash: string; amountStroops: string };
}

export function newId(): string {
  return crypto.randomUUID();
}

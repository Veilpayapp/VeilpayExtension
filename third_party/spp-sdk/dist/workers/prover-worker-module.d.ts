/* tslint:disable */
/* eslint-disable */

export class Account {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    /**
     * Locally derived ASP membership blinding for this account.
     */
    aspSecret(): Promise<string>;
    /**
     * Derive the ASP membership tree leaf for this account's stored keys.
     *
     * For explicit inputs without a session, use the free
     * [`derive_asp_user_leaf`](super::derive_asp_user_leaf) export.
     */
    deriveAspUserLeaf(): Promise<string>;
    /**
     * Derive and persist this account's privacy keys. Idempotent.
     */
    derivePrivacyKeys(): Promise<UserPublicKeys>;
    /**
     * Whether this account's public keys are registered on-chain.
     */
    isRegistered(): Promise<boolean>;
    /**
     * Open a private pool session for this account.
     */
    pool(options: any): Promise<PrivatePool>;
    /**
     * Portfolio balances across all enabled pools in the deployment.
     */
    portfolio(): Promise<PortfolioBalance[]>;
    /**
     * Locally derived note and encryption public keys for this account.
     */
    privacyKeys(): Promise<UserPublicKeys>;
    /**
     * Register this account's public keys on the deployment-wide registry.
     */
    registerPublicKeys(): Promise<string>;
    /**
     * Notes for this account across all pools (newest first).
     */
    userNotes(limit: number): Promise<UserNoteSummary[]>;
    /**
     * The account that signs and pays. May differ from [`Self::user_address`]
     * when the note owner delegates signing to another account.
     */
    readonly signerAddress: string;
    /**
     * The account that owns the notes.
     */
    readonly userAddress: string;
}

export class AspMembership {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    readonly admin: string;
    readonly capacity: bigint;
    readonly contractId: string;
    readonly contractType: string;
    readonly ledger: number;
    readonly levels: number;
    readonly nextIndex: string;
    readonly root: string;
    readonly usedSlots: string;
}

export class AspNonMembership {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    readonly admin: string;
    readonly contractId: string;
    readonly contractType: string;
    readonly isEmpty: boolean;
    readonly ledger: number;
    readonly root: string;
}

export class AssetDescriptor {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    readonly code: string | undefined;
    readonly contractId: string | undefined;
    readonly issuer: string | undefined;
    readonly kind: string;
    readonly symbol: string | undefined;
}

/**
 * Baby JubJub curve point (BN254 field coordinates).
 */
export class BabyJubJubPoint {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    readonly x: string;
    readonly y: string;
}

/**
 * Deployment-scoped browser SDK runtime: native [`NativeClient`] plus worker
 * handles.
 */
export class Client {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    /**
     * Bind a wallet signer and return an [`Account`] session.
     *
     * `signer` may sign for an account other than the note owner
     * (`user_address`); that session signs and pays while the owner holds
     * the notes — build it with the desired `signerAddress` beforehand.
     * Call [`Account::derive_privacy_keys`] to derive and store the owner's
     * privacy keys.
     */
    account(user_address: string, signer: SignerHandle): Promise<Account>;
    /**
     * On-chain state for all enabled pools plus shared ASP contracts.
     */
    allContractsData(): Promise<ContractsStateData>;
    /**
     * On-chain ASP membership and non-membership state.
     */
    aspState(): Promise<ContractsStateData>;
    /**
     * Start background contract-event sync into local storage.
     *
     * No-op if already started on this instance. After
     * [`Self::stop_background_sync`], call again to respawn. A fatal indexer
     * exit leaves the slot set — use a new [`Client`] to recover.
     */
    backgroundSync(): Promise<void>;
    /**
     * Deployment config used by this client (contract addresses, pools,
     * network).
     */
    contractConfig(): ContractConfig;
    /**
     * Build the client from an already spawned, configured and pinged
     * prover, and a storage handle.
     */
    static new(rpc_url: string, storage: StorageHandle, prover: ProverHandle, contract_config: any, bootnode_url?: string | null): Promise<Client>;
    /**
     * Recent deployment activity (pool events, registry registrations, ASP
     * updates).
     */
    operationalFeed(limit: number): Promise<OperationalFeedItem[]>;
    /**
     * Look up a recipient's registered note and encryption public keys.
     */
    recipientLookup(address: string): Promise<RecipientLookup>;
    /**
     * Request the background indexer to exit (wakes its idle wait).
     *
     * Call before rebuilding this [`Client`] so a new instance does not race
     * the old loop on the same storage DB. Also runs from [`Drop`].
     */
    stopBackgroundSync(): void;
    /**
     * Catch local storage up to the current chain tip for the deployment.
     */
    sync(): Promise<void>;
    /**
     * Verify a selective-disclosure receipt without a wallet session.
     */
    verifySelectiveDisclosure(receipt_json: string, expected_vk_hash: string): Promise<DisclosureVerificationReport>;
}

export class ContractConfig {
    free(): void;
    [Symbol.dispose](): void;
    constructor(value: any);
    /**
     * Plain JSON object matching `deployments.json` (for round-trip input).
     */
    toJSON(): any;
    readonly admin: string;
    readonly asp_membership: string;
    readonly asp_non_membership: string;
    readonly deployer: string;
    readonly kdf_domain: string;
    readonly network: string;
    readonly networkPassphrase: string | undefined;
    readonly pools: PoolConfigEntry[];
    readonly public_key_registry: string;
    readonly rpcUrl: string | undefined;
    readonly verifiers: VerifierEntry[];
}

export class ContractsStateData {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    readonly aspMembership: AspMembership;
    readonly aspNonMembership: AspNonMembership;
    readonly pools: PoolInfo[];
}

export class DisclosureCircuitMetadata {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    readonly levels: number;
    readonly nNotes: number;
    readonly name: string;
    readonly vkHash: string;
}

export class DisclosureContext {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    readonly authorityIdentityPayloadHex: string;
    readonly authorityLabel: string;
    readonly contextNonce: string;
    readonly network: string;
    readonly poolAddress: string;
    readonly purpose: string;
}

export class DisclosurePublicInputs {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    /**
     * Decimal strings, matching the receipt's `toJSON` amount format.
     */
    readonly amounts: string[];
    readonly extContextHash: string;
    readonly noteCommitments: string[];
    readonly nullifiers: string[];
    readonly roots: string[];
}

export class DisclosureReceipt {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    /**
     * Plain JSON object for `JSON.stringify` / receipt export and
     * verification.
     */
    toJSON(): any;
    readonly circuit: DisclosureCircuitMetadata;
    readonly context: DisclosureContext;
    readonly issuedAt: string;
    readonly proofCompressedHex: string;
    readonly publicInputs: DisclosurePublicInputs;
    readonly version: number;
}

export class DisclosureRequest {
    free(): void;
    [Symbol.dispose](): void;
    static fromValue(value: any): DisclosureRequest;
    constructor(selected_commitments: string[], authority_label: string, authority_identity_payload_hex: string, purpose: string, context_nonce: string);
}

export class DisclosureVerificationReport {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    readonly contextVerified: boolean;
    readonly knownRootStatus: boolean;
    readonly nullifiersUnspent: boolean;
    readonly proofVerified: boolean;
    readonly spentNullifierIndices: Array<any>;
}

/**
 * GVK ciphertext attached to a note commitment event.
 */
export class GlobalViewKeyCiphertext {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    readonly c1: string;
    readonly c2: string;
    readonly c3: string;
    readonly r: BabyJubJubPoint;
}

/**
 * Cursor over decrypted pool transacts for admin audit.
 *
 * Holds the admin view private key for its lifetime; drop the cursor when
 * finished rather than retaining it longer than needed.
 */
export class GvkAudit {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    /**
     * Fetch and audit the next transaction, or `null` when exhausted.
     */
    nextTx(): Promise<any>;
}

export class OperationalFeedItem {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    readonly body: string;
    readonly contractId: string | undefined;
    readonly kind: string;
    readonly ledger: number;
    readonly poolContractId: string | undefined;
    readonly title: string;
    readonly txType: string | undefined;
}

export class PoolConfigEntry {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    readonly asset: AssetDescriptor;
    readonly deploymentLedger: number;
    readonly enabled: boolean;
    readonly gvkAuthorityPubKey: BabyJubJubPoint | undefined;
    readonly gvkMode: string;
    readonly policyFlags: string[];
    readonly poolContractId: string;
    readonly tokenContractId: string;
}

/**
 * Estimate returned by [`crate::PrivatePool::estimate`].
 */
export class PoolEstimate {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    readonly txCount: number;
}

/**
 * Result of pool transact flows (`deposit`, `transfer`, `withdraw`, …).
 */
export class PoolExecuteResult {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    /**
     * Plain JSON object with `message`/`code` omitted when absent.
     */
    toJSON(): any;
    readonly code: number | undefined;
    readonly hashes: string[];
    readonly message: string | undefined;
    /**
     * `"ok"`, `"failed"`, or `"aspNotReady"`.
     */
    readonly status: string;
}

export class PoolInfo {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    readonly admin: string;
    readonly adminViewKey: BabyJubJubPoint | undefined;
    readonly aspMembership: string;
    readonly aspNonMembership: string;
    readonly contractId: string;
    readonly contractType: string;
    readonly gvkMode: number | undefined;
    readonly ledger: number;
    readonly maximumDepositAmount: string;
    readonly merkleCapacity: bigint;
    readonly merkleCurrentRootIndex: number | undefined;
    readonly merkleLevels: number;
    readonly merkleNextIndex: string;
    readonly merkleRoot: string | undefined;
    readonly policyFlags: string[];
    readonly token: string;
    readonly totalCommitments: string;
    readonly verifier: string;
}

export class PoolOptions {
    free(): void;
    [Symbol.dispose](): void;
    static fromValue(value: any): PoolOptions;
    constructor(pool_contract: string);
    readonly poolContract: string;
}

/**
 * One pool balance row from [`crate::Account::portfolio`].
 */
export class PortfolioBalance {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    /**
     * Stroops as a decimal string.
     */
    readonly amount: string;
    readonly noteCount: number;
    readonly poolContractId: string;
    readonly tokenContractId: string;
    readonly tokenLabel: string;
}

/**
 * Per-pool session for deposits, transfers, and withdrawals.
 */
export class PrivatePool {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    /**
     * Open an admin audit cursor for this pool.
     *
     * `globalViewPrivateKeyHex` is the admin authority scalar as a
     * `0x`-prefixed field hex string. Requires a pool-gvk deployment with
     * GVK enabled.
     */
    audit(global_view_private_key_hex: string): Promise<GvkAudit>;
    /**
     * Balance in stroops (`bigint` in JS).
     */
    balance(): Promise<bigint>;
    /**
     * Deposit tokens. `amount` is stroops (`bigint` in JS).
     */
    deposit(amount: bigint): Promise<PoolExecuteResult>;
    /**
     * Generate a selective-disclosure proof for a note commitment.
     *
     * Returns `undefined` when the account must register at the ASP before
     * disclosing; check with `== null`.
     */
    disclose(req: DisclosureRequest): Promise<DisclosureReceipt | undefined>;
    /**
     * Estimate how many on-chain transactions a spend of `amount` stroops
     * would require.
     */
    estimate(amount: bigint): Promise<PoolEstimate>;
    /**
     * User notes for this pool (commitments, amounts, spent status).
     */
    notes(): Promise<UserNoteSummary[]>;
    tokenDecimals(): Promise<number>;
    /**
     * Low-level pool `transact` call. See SDK [`Transact`] for field
     * semantics.
     */
    transact(config: any): Promise<PoolExecuteResult>;
    /**
     * Transfer privately. `recipient` is a Stellar `G...` address.
     */
    transfer(recipient: string, amount: bigint): Promise<PoolExecuteResult>;
    /**
     * Transfer privately to explicit recipient keys (note + encryption hex).
     */
    transferToKeys(note_public_key_hex: string, encryption_public_key_hex: string, amount: bigint): Promise<PoolExecuteResult>;
    verifyDisclosure(receipt: DisclosureReceipt, expected_vk_hash: string): Promise<DisclosureVerificationReport>;
    /**
     * Withdraw to `recipient`, or the connected wallet when omitted.
     */
    withdraw(amount: bigint, recipient?: string | null): Promise<PoolExecuteResult>;
}

/**
 * Prover worker bridge — main-thread ↔ worker I/O for Groth16 proving.
 */
export class ProverBridge {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    configureCircuitsBase(base_url: string, lock_json: string): Promise<void>;
    /**
     * New handle to the same prover worker.
     */
    fork(): ProverBridge;
    ping(): Promise<void>;
    static spawn(prover_worker_url: string): ProverBridge;
    toHandle(): ProverHandle;
}

/**
 * Handle [`crate::client::Client::new`] takes.
 */
export class ProverHandle {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
}

export class PublicKeyEntry {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    readonly address: string;
    readonly encryptionKey: string;
    readonly ledger: number;
    readonly noteKey: string;
}

export class RecipientLookup {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    readonly entry: PublicKeyEntry | undefined;
    readonly networkTipLedger: number;
    readonly registryFullySynced: boolean;
    readonly registryLastFullyIndexedLedger: number;
}

/**
 * Handle [`crate::client::Client::account`] takes.
 */
export class SignerHandle {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
}

/**
 * Owns a set of registered worker sinks; unregisters them on drop.
 */
export class SinkRegistration {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
}

/**
 * Storage worker bridge — main-thread ↔ worker I/O for local persistence.
 * Open once per page, [`StorageBridge::fork`] for extra handles.
 */
export class Storage {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    /**
     * Raw storage-worker RPC. Request/response shapes match the worker
     * protocol (externally tagged enums, e.g. `{ "DisclaimerState": "G..."
     * }`).
     */
    call(request: any, timeout_ms?: number | null): Promise<any>;
    /**
     * New handle to the same storage worker (shared `spp.db`).
     */
    fork(): Storage;
    /**
     * Spawn the storage worker and verify it is ready.
     *
     * Call once per page session. Use [`StorageBridge::fork`] for additional
     * handles (e.g. app code alongside [`crate::Client`]).
     */
    static open(options: any): Promise<Storage>;
    /**
     * Forks and pings before converting to a [`StorageHandle`].
     */
    toHandle(): Promise<StorageHandle>;
}

/**
 * Handle [`crate::client::Client::new`] takes.
 */
export class StorageHandle {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
}

/**
 * Compact note view returned by [`crate::Account::user_notes`] and
 * [`crate::PrivatePool::notes`].
 */
export class UserNoteSummary {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    /**
     * Stroops as a decimal string.
     */
    readonly amount: string;
    readonly createdAtLedger: number;
    readonly gvkCiphertext: GlobalViewKeyCiphertext | undefined;
    /**
     * Pool commitment (`0x` field hex).
     */
    readonly id: string;
    readonly leafIndex: number;
    readonly poolContractId: string;
    readonly spent: boolean;
}

/**
 * Locally derived note and encryption public keys for an account.
 */
export class UserPublicKeys {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    readonly encryptionPublicKey: string;
    readonly notePublicKey: string;
}

export class VerifierEntry {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    readonly address: string;
    readonly suffix: string;
}

export class VerifyDisclosureOptions {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    static fromValue(value: any): VerifyDisclosureOptions;
}

/**
 * Wallet adapter invoked from WASM (`FreighterSigner` or any object with the
 * three sign methods).
 */
export class WalletSigner {
    free(): void;
    [Symbol.dispose](): void;
    constructor(signer: any, network_passphrase: string, signer_address: string);
    toHandle(): SignerHandle;
}

/**
 * Probe whether the wallet RPC needs a historical-sync bootnode.
 *
 * Does not take or resolve a bootnode URL — callers supply that via
 * [`crate::Client::new`] after checking storage / prompting the user.
 */
export function bootnodeRequired(rpc_url: string, storage: StorageHandle, contract_config: any): Promise<boolean>;

/**
 * Configure the SDK telemetry settings (log level, sink targets, buffer sizes,
 * etc.).
 *
 * If telemetry has not been initialized yet, this function will initialize it
 * with the specified config (or defaults). If telemetry has already been
 * initialized, this will dynamically update runtime settings (log level and
 * sensitive log reveal).
 *
 * TS signature:
 * ```typescript
 * export function configureTelemetry(config?: {
 *   level?: string;
 *   sink?: "console" | "ringBuffer" | "both";
 *   ringBufferBytes?: number;
 *   revealSensitive?: boolean;
 * }): void;
 * ```
 */
export function configureTelemetry(config: any): void;

/**
 * Whether this build supports debug/trace logging and Tier-1 sensitive
 * reveal. Both are compiled out when `debug_assertions` is off (the
 * production `release` profile); the UI should hide or disable the
 * corresponding settings in that case.
 */
export function debugLogsEnabled(): boolean;

/**
 * Derive the ASP membership tree leaf from explicit public inputs.
 */
export function deriveAspUserLeaf(note_public_key: string, membership_blinding: string): string;

/**
 * Return recent formatted log output aggregated from the in-memory ring
 * buffers of the main thread and the storage/prover worker isolates.
 */
export function dump_recent_logs(): Promise<string>;

/**
 * Parse token units into unsigned base units without rounding.
 */
export function parseTokenAmount(value: string, decimals: number): bigint;

/**
 * Read token precision without opening a wallet session.
 */
export function readTokenDecimals(rpc_url: string, token_contract: string): Promise<number>;

/**
 * Register a storage and/or prover bridge as a telemetry sink. Consumes the
 * bridges — call `.toHandle()` first if you still need them afterward.
 *
 * Returns a handle that owns the registration: call `.free()` on it (or let
 * it be garbage-collected) once the corresponding client is done, so the
 * sink is unregistered instead of lingering forever.
 */
export function registerTelemetrySinks(storage?: Storage | null, prover?: ProverBridge | null): SinkRegistration;

/**
 * Replace the active log level filter with `level`.
 *
 * `level` must be a bare level name such as `"info"`, `"debug"`, or
 * `"trace"` (target directives like `"crate=debug"` are not supported).
 */
export function set_log_level(level: string): void;

/**
 * Verify a selective-disclosure receipt with no wallet, no local storage,
 * and no [`Client`] instance — just an RPC URL and an already-configured
 * [`ProverHandle`]. Skips the OPFS/SQLite storage worker entirely, since
 * verification never reads local state.
 */
export function verifySelectiveDisclosure(rpc_url: string, prover: ProverHandle, receipt_json: string, expected_vk_hash: string, options: any): Promise<DisclosureVerificationReport>;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly rust_sqlite_wasm_abort: () => void;
    readonly rust_sqlite_wasm_assert_fail: (a: number, b: number, c: number, d: number) => void;
    readonly rust_sqlite_wasm_calloc: (a: number, b: number) => number;
    readonly rust_sqlite_wasm_malloc: (a: number) => number;
    readonly rust_sqlite_wasm_free: (a: number) => void;
    readonly rust_sqlite_wasm_getentropy: (a: number, b: number) => number;
    readonly rust_sqlite_wasm_localtime: (a: number) => number;
    readonly rust_sqlite_wasm_realloc: (a: number, b: number) => number;
    readonly sqlite3_os_end: () => number;
    readonly sqlite3_os_init: () => number;
    readonly __wbg_account_free: (a: number, b: number) => void;
    readonly __wbg_aspmembership_free: (a: number, b: number) => void;
    readonly __wbg_aspnonmembership_free: (a: number, b: number) => void;
    readonly __wbg_assetdescriptor_free: (a: number, b: number) => void;
    readonly __wbg_babyjubjubpoint_free: (a: number, b: number) => void;
    readonly __wbg_client_free: (a: number, b: number) => void;
    readonly __wbg_contractconfig_free: (a: number, b: number) => void;
    readonly __wbg_contractsstatedata_free: (a: number, b: number) => void;
    readonly __wbg_disclosurecircuitmetadata_free: (a: number, b: number) => void;
    readonly __wbg_disclosurecontext_free: (a: number, b: number) => void;
    readonly __wbg_disclosurepublicinputs_free: (a: number, b: number) => void;
    readonly __wbg_disclosurereceipt_free: (a: number, b: number) => void;
    readonly __wbg_disclosurerequest_free: (a: number, b: number) => void;
    readonly __wbg_disclosureverificationreport_free: (a: number, b: number) => void;
    readonly __wbg_globalviewkeyciphertext_free: (a: number, b: number) => void;
    readonly __wbg_gvkaudit_free: (a: number, b: number) => void;
    readonly __wbg_operationalfeeditem_free: (a: number, b: number) => void;
    readonly __wbg_poolconfigentry_free: (a: number, b: number) => void;
    readonly __wbg_poolestimate_free: (a: number, b: number) => void;
    readonly __wbg_poolexecuteresult_free: (a: number, b: number) => void;
    readonly __wbg_poolinfo_free: (a: number, b: number) => void;
    readonly __wbg_pooloptions_free: (a: number, b: number) => void;
    readonly __wbg_portfoliobalance_free: (a: number, b: number) => void;
    readonly __wbg_privatepool_free: (a: number, b: number) => void;
    readonly __wbg_proverbridge_free: (a: number, b: number) => void;
    readonly __wbg_proverhandle_free: (a: number, b: number) => void;
    readonly __wbg_publickeyentry_free: (a: number, b: number) => void;
    readonly __wbg_recipientlookup_free: (a: number, b: number) => void;
    readonly __wbg_sinkregistration_free: (a: number, b: number) => void;
    readonly __wbg_storage_free: (a: number, b: number) => void;
    readonly __wbg_usernotesummary_free: (a: number, b: number) => void;
    readonly __wbg_userpublickeys_free: (a: number, b: number) => void;
    readonly __wbg_verifydisclosureoptions_free: (a: number, b: number) => void;
    readonly __wbg_walletsigner_free: (a: number, b: number) => void;
    readonly account_aspSecret: (a: number) => number;
    readonly account_deriveAspUserLeaf: (a: number) => number;
    readonly account_derivePrivacyKeys: (a: number) => number;
    readonly account_isRegistered: (a: number) => number;
    readonly account_pool: (a: number, b: number) => number;
    readonly account_portfolio: (a: number) => number;
    readonly account_privacyKeys: (a: number) => number;
    readonly account_registerPublicKeys: (a: number) => number;
    readonly account_signerAddress: (a: number, b: number) => void;
    readonly account_userAddress: (a: number, b: number) => void;
    readonly account_userNotes: (a: number, b: number) => number;
    readonly aspmembership_admin: (a: number, b: number) => void;
    readonly aspmembership_capacity: (a: number) => bigint;
    readonly aspmembership_contractId: (a: number, b: number) => void;
    readonly aspmembership_contractType: (a: number, b: number) => void;
    readonly aspmembership_ledger: (a: number) => number;
    readonly aspmembership_levels: (a: number) => number;
    readonly aspmembership_nextIndex: (a: number, b: number) => void;
    readonly aspmembership_root: (a: number, b: number) => void;
    readonly aspmembership_usedSlots: (a: number, b: number) => void;
    readonly aspnonmembership_admin: (a: number, b: number) => void;
    readonly aspnonmembership_contractId: (a: number, b: number) => void;
    readonly aspnonmembership_contractType: (a: number, b: number) => void;
    readonly aspnonmembership_isEmpty: (a: number) => number;
    readonly aspnonmembership_ledger: (a: number) => number;
    readonly aspnonmembership_root: (a: number, b: number) => void;
    readonly assetdescriptor_code: (a: number, b: number) => void;
    readonly assetdescriptor_contractId: (a: number, b: number) => void;
    readonly assetdescriptor_issuer: (a: number, b: number) => void;
    readonly assetdescriptor_kind: (a: number, b: number) => void;
    readonly assetdescriptor_symbol: (a: number, b: number) => void;
    readonly babyjubjubpoint_x: (a: number, b: number) => void;
    readonly babyjubjubpoint_y: (a: number, b: number) => void;
    readonly bootnodeRequired: (a: number, b: number, c: number, d: number) => number;
    readonly client_account: (a: number, b: number, c: number, d: number) => number;
    readonly client_allContractsData: (a: number) => number;
    readonly client_aspState: (a: number) => number;
    readonly client_backgroundSync: (a: number) => number;
    readonly client_contractConfig: (a: number) => number;
    readonly client_new: (a: number, b: number, c: number, d: number, e: number, f: number, g: number) => number;
    readonly client_operationalFeed: (a: number, b: number) => number;
    readonly client_recipientLookup: (a: number, b: number, c: number) => number;
    readonly client_stopBackgroundSync: (a: number) => void;
    readonly client_sync: (a: number) => number;
    readonly client_verifySelectiveDisclosure: (a: number, b: number, c: number, d: number, e: number) => number;
    readonly configureTelemetry: (a: number, b: number) => void;
    readonly contractconfig_admin: (a: number, b: number) => void;
    readonly contractconfig_asp_membership: (a: number, b: number) => void;
    readonly contractconfig_asp_non_membership: (a: number, b: number) => void;
    readonly contractconfig_deployer: (a: number, b: number) => void;
    readonly contractconfig_kdf_domain: (a: number, b: number) => void;
    readonly contractconfig_network: (a: number, b: number) => void;
    readonly contractconfig_networkPassphrase: (a: number, b: number) => void;
    readonly contractconfig_new: (a: number, b: number) => void;
    readonly contractconfig_pools: (a: number, b: number) => void;
    readonly contractconfig_public_key_registry: (a: number, b: number) => void;
    readonly contractconfig_rpcUrl: (a: number, b: number) => void;
    readonly contractconfig_toJSON: (a: number, b: number) => void;
    readonly contractconfig_verifiers: (a: number, b: number) => void;
    readonly contractsstatedata_aspMembership: (a: number) => number;
    readonly contractsstatedata_aspNonMembership: (a: number) => number;
    readonly contractsstatedata_pools: (a: number, b: number) => void;
    readonly debugLogsEnabled: () => number;
    readonly deriveAspUserLeaf: (a: number, b: number, c: number, d: number, e: number) => void;
    readonly disclosurecircuitmetadata_levels: (a: number) => number;
    readonly disclosurecircuitmetadata_nNotes: (a: number) => number;
    readonly disclosurecircuitmetadata_name: (a: number, b: number) => void;
    readonly disclosurecircuitmetadata_vkHash: (a: number, b: number) => void;
    readonly disclosurecontext_authorityIdentityPayloadHex: (a: number, b: number) => void;
    readonly disclosurecontext_authorityLabel: (a: number, b: number) => void;
    readonly disclosurecontext_contextNonce: (a: number, b: number) => void;
    readonly disclosurecontext_network: (a: number, b: number) => void;
    readonly disclosurecontext_poolAddress: (a: number, b: number) => void;
    readonly disclosurecontext_purpose: (a: number, b: number) => void;
    readonly disclosurepublicinputs_amounts: (a: number, b: number) => void;
    readonly disclosurepublicinputs_extContextHash: (a: number, b: number) => void;
    readonly disclosurepublicinputs_noteCommitments: (a: number, b: number) => void;
    readonly disclosurepublicinputs_nullifiers: (a: number, b: number) => void;
    readonly disclosurepublicinputs_roots: (a: number, b: number) => void;
    readonly disclosurereceipt_circuit: (a: number) => number;
    readonly disclosurereceipt_context: (a: number) => number;
    readonly disclosurereceipt_issuedAt: (a: number, b: number) => void;
    readonly disclosurereceipt_proofCompressedHex: (a: number, b: number) => void;
    readonly disclosurereceipt_publicInputs: (a: number) => number;
    readonly disclosurereceipt_toJSON: (a: number, b: number) => void;
    readonly disclosurereceipt_version: (a: number) => number;
    readonly disclosurerequest_fromValue: (a: number, b: number) => void;
    readonly disclosurerequest_new: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: number, k: number) => void;
    readonly disclosureverificationreport_contextVerified: (a: number) => number;
    readonly disclosureverificationreport_knownRootStatus: (a: number) => number;
    readonly disclosureverificationreport_nullifiersUnspent: (a: number) => number;
    readonly disclosureverificationreport_proofVerified: (a: number) => number;
    readonly disclosureverificationreport_spentNullifierIndices: (a: number) => number;
    readonly dump_recent_logs: () => number;
    readonly globalviewkeyciphertext_c1: (a: number, b: number) => void;
    readonly globalviewkeyciphertext_c2: (a: number, b: number) => void;
    readonly globalviewkeyciphertext_c3: (a: number, b: number) => void;
    readonly globalviewkeyciphertext_r: (a: number) => number;
    readonly gvkaudit_nextTx: (a: number) => number;
    readonly operationalfeeditem_body: (a: number, b: number) => void;
    readonly operationalfeeditem_contractId: (a: number, b: number) => void;
    readonly operationalfeeditem_kind: (a: number, b: number) => void;
    readonly operationalfeeditem_ledger: (a: number) => number;
    readonly operationalfeeditem_poolContractId: (a: number, b: number) => void;
    readonly operationalfeeditem_title: (a: number, b: number) => void;
    readonly operationalfeeditem_txType: (a: number, b: number) => void;
    readonly parseTokenAmount: (a: number, b: number, c: number, d: number) => void;
    readonly poolconfigentry_asset: (a: number) => number;
    readonly poolconfigentry_deploymentLedger: (a: number) => number;
    readonly poolconfigentry_enabled: (a: number) => number;
    readonly poolconfigentry_gvkAuthorityPubKey: (a: number) => number;
    readonly poolconfigentry_gvkMode: (a: number, b: number) => void;
    readonly poolconfigentry_policyFlags: (a: number, b: number) => void;
    readonly poolconfigentry_poolContractId: (a: number, b: number) => void;
    readonly poolconfigentry_tokenContractId: (a: number, b: number) => void;
    readonly poolestimate_txCount: (a: number) => number;
    readonly poolexecuteresult_code: (a: number) => number;
    readonly poolexecuteresult_hashes: (a: number, b: number) => void;
    readonly poolexecuteresult_message: (a: number, b: number) => void;
    readonly poolexecuteresult_status: (a: number, b: number) => void;
    readonly poolexecuteresult_toJSON: (a: number, b: number) => void;
    readonly poolinfo_admin: (a: number, b: number) => void;
    readonly poolinfo_adminViewKey: (a: number) => number;
    readonly poolinfo_aspMembership: (a: number, b: number) => void;
    readonly poolinfo_aspNonMembership: (a: number, b: number) => void;
    readonly poolinfo_contractId: (a: number, b: number) => void;
    readonly poolinfo_contractType: (a: number, b: number) => void;
    readonly poolinfo_gvkMode: (a: number) => number;
    readonly poolinfo_ledger: (a: number) => number;
    readonly poolinfo_maximumDepositAmount: (a: number, b: number) => void;
    readonly poolinfo_merkleCapacity: (a: number) => bigint;
    readonly poolinfo_merkleCurrentRootIndex: (a: number) => number;
    readonly poolinfo_merkleLevels: (a: number) => number;
    readonly poolinfo_merkleNextIndex: (a: number, b: number) => void;
    readonly poolinfo_merkleRoot: (a: number, b: number) => void;
    readonly poolinfo_policyFlags: (a: number, b: number) => void;
    readonly poolinfo_token: (a: number, b: number) => void;
    readonly poolinfo_totalCommitments: (a: number, b: number) => void;
    readonly poolinfo_verifier: (a: number, b: number) => void;
    readonly pooloptions_fromValue: (a: number, b: number) => void;
    readonly pooloptions_new: (a: number, b: number) => number;
    readonly pooloptions_poolContract: (a: number, b: number) => void;
    readonly portfoliobalance_amount: (a: number, b: number) => void;
    readonly portfoliobalance_noteCount: (a: number) => number;
    readonly portfoliobalance_poolContractId: (a: number, b: number) => void;
    readonly portfoliobalance_tokenContractId: (a: number, b: number) => void;
    readonly portfoliobalance_tokenLabel: (a: number, b: number) => void;
    readonly privatepool_audit: (a: number, b: number, c: number) => number;
    readonly privatepool_balance: (a: number) => number;
    readonly privatepool_deposit: (a: number, b: bigint, c: bigint) => number;
    readonly privatepool_disclose: (a: number, b: number) => number;
    readonly privatepool_estimate: (a: number, b: bigint, c: bigint) => number;
    readonly privatepool_notes: (a: number) => number;
    readonly privatepool_tokenDecimals: (a: number) => number;
    readonly privatepool_transact: (a: number, b: number) => number;
    readonly privatepool_transfer: (a: number, b: number, c: number, d: bigint, e: bigint) => number;
    readonly privatepool_transferToKeys: (a: number, b: number, c: number, d: number, e: number, f: bigint, g: bigint) => number;
    readonly privatepool_verifyDisclosure: (a: number, b: number, c: number, d: number) => number;
    readonly privatepool_withdraw: (a: number, b: bigint, c: bigint, d: number, e: number) => number;
    readonly proverbridge_configureCircuitsBase: (a: number, b: number, c: number, d: number, e: number) => number;
    readonly proverbridge_fork: (a: number) => number;
    readonly proverbridge_ping: (a: number) => number;
    readonly proverbridge_spawn: (a: number, b: number) => number;
    readonly proverbridge_toHandle: (a: number) => number;
    readonly publickeyentry_address: (a: number, b: number) => void;
    readonly publickeyentry_encryptionKey: (a: number, b: number) => void;
    readonly publickeyentry_ledger: (a: number) => number;
    readonly publickeyentry_noteKey: (a: number, b: number) => void;
    readonly readTokenDecimals: (a: number, b: number, c: number, d: number) => number;
    readonly recipientlookup_entry: (a: number) => number;
    readonly recipientlookup_networkTipLedger: (a: number) => number;
    readonly recipientlookup_registryFullySynced: (a: number) => number;
    readonly recipientlookup_registryLastFullyIndexedLedger: (a: number) => number;
    readonly registerTelemetrySinks: (a: number, b: number) => number;
    readonly set_log_level: (a: number, b: number, c: number) => void;
    readonly storage_call: (a: number, b: number, c: number) => number;
    readonly storage_fork: (a: number) => number;
    readonly storage_open: (a: number) => number;
    readonly storage_toHandle: (a: number) => number;
    readonly usernotesummary_amount: (a: number, b: number) => void;
    readonly usernotesummary_createdAtLedger: (a: number) => number;
    readonly usernotesummary_gvkCiphertext: (a: number) => number;
    readonly usernotesummary_id: (a: number, b: number) => void;
    readonly usernotesummary_leafIndex: (a: number) => number;
    readonly usernotesummary_poolContractId: (a: number, b: number) => void;
    readonly usernotesummary_spent: (a: number) => number;
    readonly userpublickeys_encryptionPublicKey: (a: number, b: number) => void;
    readonly userpublickeys_notePublicKey: (a: number, b: number) => void;
    readonly verifySelectiveDisclosure: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number) => number;
    readonly verifydisclosureoptions_fromValue: (a: number, b: number) => void;
    readonly walletsigner_new: (a: number, b: number, c: number, d: number, e: number, f: number) => void;
    readonly walletsigner_toHandle: (a: number) => number;
    readonly main: (a: number, b: number) => number;
    readonly __wbg_verifierentry_free: (a: number, b: number) => void;
    readonly __wbg_storagehandle_free: (a: number, b: number) => void;
    readonly __wbg_signerhandle_free: (a: number, b: number) => void;
    readonly verifierentry_address: (a: number, b: number) => void;
    readonly verifierentry_suffix: (a: number, b: number) => void;
    readonly __wasm_bindgen_func_elem_1085: (a: number, b: number, c: number, d: number) => void;
    readonly __wasm_bindgen_func_elem_1150: (a: number, b: number, c: number, d: number) => void;
    readonly __wasm_bindgen_func_elem_5135: (a: number, b: number, c: number) => void;
    readonly __wasm_bindgen_func_elem_869: (a: number, b: number) => void;
    readonly __wbindgen_export: (a: number, b: number) => number;
    readonly __wbindgen_export2: (a: number, b: number, c: number, d: number) => number;
    readonly __wbindgen_export3: (a: number) => void;
    readonly __wbindgen_export4: (a: number, b: number, c: number) => void;
    readonly __wbindgen_export5: (a: number, b: number) => void;
    readonly __wbindgen_add_to_stack_pointer: (a: number) => number;
    readonly __wbindgen_start: () => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;

/**
 * Instantiates the given `module`, which can either be bytes or
 * a precompiled `WebAssembly.Module`.
 *
 * @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
 *
 * @returns {InitOutput}
 */
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
 * If `module_or_path` is {RequestInfo} or {URL}, makes a request and
 * for everything else, calls `WebAssembly.instantiate` directly.
 *
 * @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
 *
 * @returns {Promise<InitOutput>}
 */
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;

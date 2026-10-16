/**
 * The pinned SPP (Stellar Private Payments) deployment this wallet talks to.
 *
 * SPP is a privacy-pool system: XLM is deposited into a Soroban pool contract
 * and spent as private notes (UTXO-style commitments) with Groth16 proofs —
 * the Nethermind "Stellar Private Payments" reference implementation, running
 * as a developer preview on Stellar testnet.
 *
 * The contract ids below are a deployment WE published (a fresh blocklist-only
 * native-XLM pool), because the reference deployment's event history has aged
 * out of the public RPC's retention window — a fresh client cannot sync it
 * without a bootnode. Deploying our own keeps the wallet self-contained: RPC
 * event history covers the full pool lifetime, so no bootnode is needed.
 *
 * The SDK runtime and circuit artifacts that pair with this deployment ship
 * as static extension assets (built and vendored under `third_party/spp-sdk`
 * and `third_party/spp-circuits`; see `scripts/copy-spp-assets.mjs`). They
 * are built from the SAME source tree as the deployed contracts, with the
 * committed ceremony keys whose verification keys are baked into the
 * on-chain verifier.
 */

/** Network identity of the SPP deployment. */
export const SPP_NETWORK_PASSPHRASE = 'Test SDF Network ; September 2015';

/** Public Soroban RPC for the SPP deployment. */
export const SPP_RPC_URL = 'https://soroban-testnet.stellar.org';

/**
 * A pool entry in the deployment config, as the SDK deserializes it.
 */
export interface SppPoolConfig {
  poolContractId: string;
  tokenContractId: string;
  deploymentLedger: number;
  enabled: boolean;
  policyFlags: string[];
  asset: { kind: 'native' | 'classic' | 'contract'; code?: string; issuer?: string };
}

/**
 * The deployments.json shape the SDK consumes. Identifiers are pinned here so
 * a compromised network response cannot redirect pool operations to attacker
 * contracts.
 */
export interface SppContractConfig {
  network: string;
  /** Informational derivation-domain label (registry-stored, display-only). */
  kdf_domain: string;
  deployer: string;
  admin: string;
  asp_membership: string;
  asp_non_membership: string;
  verifiers: Record<string, string>;
  public_key_registry: string;
  pools: SppPoolConfig[];
  /** Network identity; the SDK validates it against the RPC. */
  networkPassphrase: string;
  /** Default RPC for the deployment. */
  rpcUrl: string;
}

/**
 * Deeply freezes the deployment config.
 *
 * Every contract id is a compile-time literal, so a compromised network
 * response cannot redirect pool operations — but a runtime bug (or injected
 * code) mutating the shared object could. Freezing makes any such write
 * fail loudly instead of silently repointing money movement.
 */
function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    Object.freeze(value);
    for (const key of Object.keys(value as Record<string, unknown>)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
  }
  return value;
}

export const SPP_CONTRACT_CONFIG: SppContractConfig = deepFreeze({
  network: 'testnet',
  kdf_domain: 'Veilpay',
  deployer: 'GAZTPL3VGFXJZSR6JOP67EEJRBVNZVQ2WF2HJ5GAPK6E74LDW524NHV7',
  admin: 'GAZTPL3VGFXJZSR6JOP67EEJRBVNZVQ2WF2HJ5GAPK6E74LDW524NHV7',
  asp_membership: 'CDZYZTSO23R6QITJUUJ566PUYB3UAU5T3YTHMBB3QYAWT32L5DVO4BLB',
  asp_non_membership: 'CDWL3BEDZB43LB5RGLTSIQR3DCMPI3S6KDJKAPQMUV43GN4W3YUXR5MF',
  verifiers: {
    B: 'CBLHX5IFJ5OOSETSEDLSSVYVGVEK7RLHO5Z37K74CKDAAUPX5JOWI72C',
  },
  public_key_registry: 'CDG3G37527D6BT62BSZJKM3QFBL7NDONOLMOSKH2RHDNE7XCKP7L4ZSU',
  pools: [
    {
      poolContractId: 'CALMZTI56TEDERLWXZJOS5TAN4QN2B36NAJK26MWKND4H5IG4NLPWEJ2',
      tokenContractId: 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC',
      deploymentLedger: 5166775,
      enabled: true,
      policyFlags: ['blocklist'],
      asset: {
        kind: 'native',
      },
    },
  ],
  networkPassphrase: SPP_NETWORK_PASSPHRASE,
  rpcUrl: SPP_RPC_URL,
});

/** The pool the wallet operates on (the deployment's single enabled pool). */
export const SPP_POOL_CONTRACT_ID: string = SPP_CONTRACT_CONFIG.pools[0]!.poolContractId;

/** Display symbol for the pooled asset presentation ("private XLM"). */
export const SPP_ASSET_SYMBOL = 'pXLM';

/**
 * The exact string the SDK asks the wallet to sign to derive the pool's
 * privacy keys ("Privacy Pool Key Derivation [v2] (<kdf_domain>)" — the
 * template is baked into the vendored SDK's WASM, the domain is OUR config's
 * `kdf_domain`). The signer bridge signs this message and NOTHING else: the
 * signature IS the note secret's seed, so an arbitrary-message oracle would
 * hand out account-ownership proofs (SEP-53 verifiable) for any string an
 * attacker chose.
 */
export const SPP_KEY_DERIVATION_MESSAGE: string = `Privacy Pool Key Derivation [v2] (${SPP_CONTRACT_CONFIG.kdf_domain})`;

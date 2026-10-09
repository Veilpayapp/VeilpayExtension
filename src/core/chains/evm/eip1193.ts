/**
 * EIP-1193 chain-switching helpers.
 *
 * The wallet supports the EVM networks in the registry (mainnets and
 * testnets — see `src/core/networks`). `wallet_switchEthereumChain` persists
 * the requested registry network when one matches the chain id, or fails with
 * EIP-1193 error 4902 ("Unrecognized chain") — the signal dapps use to prompt
 * for `wallet_addEthereumChain`, which is unsupported here and fails with
 * 4200.
 */

/** EIP-1193 error codes (https://eips.ethereum.org/EIPS/eip-1193#errors). */
export const EIP1193 = {
  /** The requested method is not implemented by the provider. */
  UNSUPPORTED_METHOD: 4200,
  /** The chain the dapp asked to switch to is not recognized. */
  UNRECOGNIZED_CHAIN: 4902,
} as const;

/**
 * Maps our protocol's string error codes to EIP-1193 numeric codes.
 * Returns the numeric code, or undefined for codes with no EIP-1193 mapping.
 */
export function eip1193CodeFor(protocolCode: string): number | undefined {
  switch (protocolCode) {
    case 'CHAIN_UNSUPPORTED':
      return EIP1193.UNRECOGNIZED_CHAIN;
    case 'UNKNOWN_KIND':
      return EIP1193.UNSUPPORTED_METHOD;
    default:
      return undefined;
  }
}

/** Builds an EIP-1193-compatible error object (dapps branch on `error.code`). */
export function eip1193Error(code: number, message: string): Error & { code: number } {
  const err = new Error(message) as Error & { code: number };
  err.code = code;
  return err;
}

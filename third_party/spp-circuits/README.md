# Vendored SPP circuit artifacts

Compiled circuit artifacts for Stellar Private Payments, pinned to the
on-chain testnet deployment this wallet uses (`src/core/spp/deployment.ts`).

Source: [NethermindEth/stellar-private-payments](https://github.com/NethermindEth/stellar-private-payments)
`deployments/testnet/circuit_keys/` — the committed "local" ceremony whose
verification keys are baked into the deployed Groth16 verifier contracts.
Fingerprints are pinned by that repo's `deployments/testnet/circuits.json`.

The npm package `stellar-private-payments` bundles a DIFFERENT ceremony in
`dist/circuits/`; serving those artifacts would produce proofs the pool's
on-chain verifiers reject, which is why these files are vendored here and
`scripts/copy-spp-assets.mjs` copies them into the build.

Licensing: the compiled circuits incorporate iden3/circomlib (LGPL-3.0). See
`NOTICE.txt` and `LGPL-3.0.txt`; the corresponding source is offered via
`source-bundle.tar.gz` copied next to these files in the built package.

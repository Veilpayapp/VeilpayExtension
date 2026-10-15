# Vendored SPP web SDK

The Stellar Private Payments browser runtime, **built from source** rather
than taken from npm. The build lives here because:

1. **The npm package (0.1.0) predates the current contract storage layout.**
   The published wasm fails against current-main pool contracts with
   "missing required contract keys" — the pool moved its config into the
   contract instance after 0.1.0 shipped.
2. **The circuit artifacts in the npm package are a different ceremony** than
   the committed `deployments/testnet/circuit_keys` our on-chain verifiers
   were deployed with; proofs made with those keys are rejected on-chain.

The vendored build is compiled from the same source tree the deployed
contracts were built from, with the committed ceremony keys, so the client,
contracts, and proving artifacts are one coherent set.

## Layout

- `js/` — the SDK entry (`js/index.js`) plus its TypeScript declarations
  (staged by the build into `js/types/`).
- `dist/` — wasm-bindgen glue, the main-thread wasm, the storage and prover
  workers, and license texts. `dist/circuits/` is NOT included here; the
  extension pins its own subset (see `../spp-circuits/`).

## Build (reproducing)

From a clone of
[NethermindEth/stellar-private-payments](https://github.com/NethermindEth/stellar-private-payments)
at the commit used for the deployment (plus the patch below):

```sh
rustup target add wasm32-unknown-unknown
cargo install wasm-bindgen-cli --version 0.2.126 --locked --force
make circuits                    # r1cs artifacts; deterministic, hash-pinned by circuits.json
CC_wasm32_unknown_unknown=clang-18 bash sdk/web/scripts/build.sh
```

`clang-18` (or newer) is required: Debian's clang 14 cannot compile the
sqlite-wasm-rs C shim. The build auto-downloads binaryen `version_131`.

The built `js/` + `dist/` trees (minus `dist/circuits/`) are copied here.

## Local patch: topics filter

`sdk/native/src/chain/rpc.rs` — `get_contract_events` passed
`topics: [["**"]]` to Soroban `getEvents`, but the SDF public RPC returns
ZERO events for any `topics` filter (even a single-segment `*`), so the
upstream wildcard matched nothing: the background indexer ingested no events,
registry lookups always missed, and notes sent by other wallets could never
be scanned. The patch passes an empty topics list (no topic filtering),
which is what the wildcard intended. Look for `VEILPAY PATCH` in the file.

## Licensing

The SDK is Apache-2.0 (`dist/LICENSE.txt`). The circuit artifacts it pairs
with incorporate iden3/circomlib (LGPL-3.0) — see `../spp-circuits/`.

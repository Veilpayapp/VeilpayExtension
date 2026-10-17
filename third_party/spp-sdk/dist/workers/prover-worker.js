import init from './prover-worker-module.js';
globalThis.__STELLAR_PRIVATE_PAYMENTS_CIRCUITS_BASE__ =
  new URL('../circuits/', import.meta.url).href;
await init();

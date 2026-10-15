import { defineManifest } from '@crxjs/vite-plugin';

/**
 * Manifest V3 — deliberately minimal permissions.
 *
 * Rejected on purpose (see 0_PLAN_INDEX.md and 8_SECURITY_MODEL.md):
 *   - "<all_urls>"  : an extension compromise would read every page you visit
 *   - "webRequest"  : not needed; x402 detection uses a fetch/XHR shim on activeTab
 *   - "tabs"        : activeTab covers the click-initiated flows we support
 *
 * Every entry below must stay justified in writing.
 */
export default defineManifest({
  manifest_version: 3,
  name: 'Veilpay',
  short_name: 'Veilpay',
  description:
    'Self-custody multi-chain wallet with native agent payments and x402 support. Mainnets and testnets.',
  version: '0.0.1',
  minimum_chrome_version: '116',

  action: {
    default_title: 'Veilpay',
    default_popup: 'popup.html',
  },

  options_page: 'options.html',

  side_panel: {
    default_path: 'sidepanel.html',
  },

  background: {
    service_worker: 'src/background/index.ts',
    type: 'module',
  },

  content_scripts: [
    {
      // Injected everywhere so dapps (Uniswap, Aave, any site) can discover
      // Veilpay through EIP-6963 and the injected `window.ethereum` provider.
      // The shim itself holds no secrets; every privileged action still requires
      // an explicit per-origin grant and a user approval in the wallet UI.
      matches: ['http://*/*', 'https://*/*'],
      js: ['src/content/index.ts'],
      run_at: 'document_start',
      all_frames: false,
    },
  ],

  web_accessible_resources: [
    {
      // Only the bundled artifacts. Listing the `.ts` source here made Vite copy
      // the raw file into the package, and injecting it failed with a MIME error
      // (Chrome serves `.ts` as octet-stream, which module scripts reject).
      resources: ['assets/*'],
      matches: ['http://*/*', 'https://*/*'],
    },
  ],

  permissions: [
    'storage', // settings only; secrets live in encrypted IndexedDB
    'activeTab', // click-initiated access to the current page, nothing wider
    'alarms', // session idle timeout ticks while the SW is asleep
    'sidePanel', // full-height wallet surface
    'offscreen', // snarkjs / WASM host document (D3 spike)
    'contextMenus', // right-click send/copy/lock menu. REQUIRED: without it
    // chrome.contextMenus is undefined in the service worker and the module
    // crashes at evaluation, which hangs every popup request (the SW registers
    // onMessage then dies). This permission is what makes the SW boot at all.
  ],

  host_permissions: [
    // ── EVM: mainnets and testnets ──────────────────────────────────────
    // publicnode.com hosts every publicnode preset (Ethereum, Base, Polygon,
    // Arbitrum, Optimism, BNB, Avalanche + their testnets); one wildcard
    // entry covers the whole family and each subdomain is a public, keyless
    // RPC endpoint.
    'https://*.publicnode.com/*',
    // 1rpc.io covers Ethereum mainnet and Polygon (https://1rpc.io/eth, /matic).
    'https://1rpc.io/*',
    'https://sepolia.gateway.tenderly.co/*',
    // ── Solana: mainnet, devnet, testnet ─────────────────────────────────
    'https://api.devnet.solana.com/*',
    'https://api.testnet.solana.com/*',
    'https://api.mainnet.solana.com/*',
    // ── Stellar: mainnet and testnet ─────────────────────────────────────
    'https://horizon.stellar.org/*',
    'https://horizon-testnet.stellar.org/*',
    'https://friendbot.stellar.org/*', // testnet faucet (Stellar SDF)
    // Soroban RPC for the SPP privacy pool (Nethermind testnet deployment;
    // the offscreen SPP host reads it — extension pages are CORS-scoped, and
    // host permissions are what lift that for our own surfaces only).
    'https://soroban-testnet.stellar.org/*',
    'https://veilpay-qzz1.onrender.com/*', // transaction indexer backend
    // The local agent bridge. Loopback only, and every request carries a
    // pairing token, so this grants no access to anything off this machine.
    'http://127.0.0.1/*',
  ],

  // A hosted agent relay is a user-supplied https origin. Granting every site
  // up front would defeat the point of keeping permissions minimal, so the
  // origin is requested at the moment of pairing and only for that origin.
  optional_host_permissions: ['https://*/*'],

  content_security_policy: {
    // 'wasm-unsafe-eval' is the whole question behind D3. No 'unsafe-eval'.
    extension_pages:
      "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'; worker-src 'self'",
  },

  icons: {
    16: 'icons/icon-16.png',
    48: 'icons/icon-48.png',
    128: 'icons/icon-128.png',
  },
});

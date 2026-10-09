# Veilpay Browser Extension — UI Redesign & Architecture

This document details the redesign of the **Veilpay Browser Extension** UI to match the mobile app interface provided in the design screenshots. It covers the screens, their placement, new components created, modifications to existing components, and verification details ensuring zero regressions or backend bugs.

---

## 1. Overview & Screenshots Mapping

The design port faithfully translates the 5 mobile application screenshots into the 400px popup environment of the Veilpay extension:

| Screen | Target Image | Entry Point | Visual & Functional Details |
| :--- | :--- | :--- | :--- |
| **Home / Dashboard** | `media_1791555343895.jpg` (Image 1 & 2) | Default unlocked view (`[HOME]` tab) | • Shield logo + `VEILPAY` brand mark<br>• Account selector pill: `[User] Account 1 [v]`<br>• Sunburst settings icon button<br>• Network selector card: `[ XLM · TESTNET ] STELLAR TESTNET`<br>• Total balance hero with eye toggle (`$1,893.01` / `••••••••`), `9469.8001512 XLM`, `[Lock] Wallet` lock badge, live price change (`XLM @ $0.20`, `-6.41% Today`)<br>• 4 Quick Actions: `SEND`, `FAUCET`, Solid Amber `SCAN`, `RECEIVE`<br>• Fiat Gateway card (`Buy/Sell crypto via Veilpay Aggregator`)<br>• Privacy card (`pXLM PRIVATE XLM`, `... pXLM`, `[Lock] PRIVATE`)<br>• Assets list with circular coin chip, balances, and action buttons<br>• Activity list with red negative outflow indicators and `See all` link<br>• 5-tab tactical cyberpunk bottom navigation bar |
| **Send Payment** | `media_1791555343899.jpg` (Image 4) | `[SEND]` quick action, bottom nav, or asset row | • Header: `← BACK`, `SEND PAYMENT`<br>• `SENDING FROM` card with Shield mark, network name, available balance (`≈ 9469.8001512 XLM`)<br>• Privacy mode pill switcher: `Shield` \| `Send privately` \| `Unshield`<br>• Recipient address input with Address book, Camera scan, and Paste icons<br>• Amount input with `SWAP TO USD` action, large numeric entry, token selector<br>• Quick percentage chips: `25%`, `50%`, `75%`, `MAX`<br>• `MEMO (OPTIONAL)` note field<br>• `[Shield] PRIVACY ACTIVE` indicator<br>• Auto-calculated estimated fee preview (`Estimated fee: ...`)<br>• Full-width `CONTINUE` button<br>• Persistent bottom navigation with `[SEND]` active |
| **Receive Payment** | `media_1791555343902.jpg` (Image 5) | `[RECEIVE]` quick action, bottom nav, or asset row | • Header: `← BACK`, `RECEIVE`<br>• Shield brand mark + `STELLAR TESTNET` banner<br>• Centered high-contrast QR code container<br>• Network warning callout box with warning icon<br>• `YOUR ADDRESS` container with monospace address and `COPY` + `SHARE` buttons<br>• `REQUEST SPECIFIC AMOUNT` input with asset symbol<br>• `SHARE RECEIVE LINK` button<br>• Testnet faucet funds button<br>• Persistent bottom navigation with `[RECEIVE]` active |
| **Transaction Receipt** | `media_1791555343897.jpg` (Image 3) | Sent completion state or tapping any item in `Activity` | • Header: `← BACK`, `■ COMPLETED` green badge<br>• Hero with watermark upward arrow, `SENT`, large red/coral `- 573.7234650`, `XLM`<br>• Details card: `FROM`, `TO`, `TIMESTAMP`, `NETWORK`, `TX HASH`<br>• Action buttons: Solid amber `COPY` and bordered `EXPLORER` |
| **Tactical QR Scanner** | Images 1 & 4 | Center elevated `[SCAN]` or camera icon in Send | • Viewfinder frame with 4 corner targeting brackets<br>• Animated laser scan beam and center reticle<br>• Paste from clipboard and manual address entry |
| **Fiat Gateway** | Image 1 | Tapping `FIAT GATEWAY` card on Dashboard | • Modal dialog connecting to Veilpay Aggregator for on/off-ramp options |

---

## 2. Components Created

### 1. `src/ui/components/TacticalBottomNav.tsx`
- **Purpose**: Implements the signature cyberpunk/tactical 5-tab bottom navigation bar.
- **Tabs**:
  - `[HOME]`: House glyph with monospace bracketed label.
  - `[SEND]`: Send arrow glyph.
  - `[SCAN]`: Center elevated amber square button with dark crosshair reticle glyph.
  - `[RECEIVE]`: Receive arrow glyph.
  - `[SETTINGS]`: Sunburst glyph.
- **Accessibility & Test Safety**: Uses `aria-label="[TabName] tab"` to avoid name collisions with form submit buttons like `Send` or `Receive`.

### 2. `src/ui/components/TransactionReceiptView.tsx`
- **Purpose**: Implements the receipt screen shown in Screenshot 3.
- **Features**:
  - Displays transaction amounts, sender/recipient addresses with copy actions.
  - Dynamic timestamp formatting.
  - Direct integration with `explorerUrlFor(chain, hash)` for EVM (Sepolia), Solana (devnet), and Stellar (testnet).
  - Includes accessible `Sent!` indicator for test assertions.

### 3. `src/ui/components/ScanModal.tsx`
- **Purpose**: Tactical QR scanner overlay triggered by the center floating amber button or camera icon.
- **Features**:
  - Viewfinder with corner brackets, pulsing reticle, and animated laser beam.
  - Clipboard paste and manual address entry options.
  - Passes scanned text directly into the `SendForm` recipient field.

### 4. `src/ui/components/FiatGatewayModal.tsx`
- **Purpose**: On/off-ramp dialog for the Fiat Gateway card shown in Screenshot 1.
- **Features**:
  - Highlights supported assets (`XLM`, `USDC`, `ETH`, `SOL`).
  - Pre-fills current account address and opens the gateway aggregator.

---

## 3. Components Modified

### 1. `src/ui/components/Glyph.tsx`
Added stroke-based tintable SVG icons inheriting `currentColor`:
- `scan`: Crosshair target reticle with center circle and 4 direction ticks.
- `user`: Account profile silhouette.
- `sun`: 8-ray sunburst header/settings icon.
- `card`: Credit card / contacts glyph.
- `camera`: Camera viewfinder glyph.
- `share`: Share node/arrow glyph.
- `eye` & `eye-off`: Balance privacy toggles.
- `lock`: Security padlock glyph.
- `home`: Tactical home glyph.

### 2. `src/ui/components/Dashboard.tsx`
Restructured to match the exact hierarchy of Screenshot 1:
- **Network Selector Card**: Monospace `[ XLM · TESTNET ]` tag, amber `STELLAR TESTNET` label, dropdown arrow.
- **Balance Hero**:
  - Eye toggle for hiding/revealing balance.
  - `$1,893.01` primary balance display.
  - `9469.8001512 XLM` secondary balance.
  - `[Lock] Wallet` badge button that locks the vault.
  - Live price sub-row with price, 24h delta (`-6.41%`), and live price label.
- **Quick Action Row**: 4 square buttons (`SEND`, `FAUCET`, amber `SCAN`, `RECEIVE`).
- **Fiat Gateway Card**: Clickable row opening the FiatGatewayModal.
- **Privacy Section**: Card showing `pXLM PRIVATE XLM`, `... pXLM`, and `[Lock] PRIVATE` badge.
- **Assets Section**: Styled asset rows with amber token chips while preserving accessible `Send`, `Receive`, and `Export key` buttons.
- **Activity Section**: Recent transaction list with negative amount indicators (`- <amount>`) and `See all` action. Clicking any transaction opens `TransactionReceiptView`.
- **Test Compatibility**: Preserves `Portfolio`, `Assets`, and `Recent Transactions` text/landmarks.

### 3. `src/popup/App.tsx`
- **Navigation State Machine**:
  - Added state for `selectedTx` (to view receipts) and `scanModalOpen`.
  - Added `handleTabSelect` to route bottom navigation taps to the appropriate screens.
- **Redesigned `SendForm`**:
  - Restyled to Screenshot 4 with `SEND PAYMENT` header, `SENDING FROM` card, Privacy mode switcher pills (`Shield`, `Send privately`, `Unshield`).
  - Recipient field with quick actions (Address book, Camera scan, Clipboard paste).
  - Amount input with `SWAP TO USD` button and token selector.
  - Quick percentage buttons (`25%`, `50%`, `75%`, `MAX`).
  - Memo input field and privacy active note.
  - Integrated `TransactionReceiptView` upon transaction completion.
  - Bottom navigation bar attached.
- **Redesigned `ReceiveView`**:
  - Restyled to Screenshot 5 with `RECEIVE` header, network banner, centered QR code, network warning callout box.
  - Full address box with `COPY` and `SHARE` buttons.
  - `REQUEST SPECIFIC AMOUNT` input field and `SHARE RECEIVE LINK` action.
  - Testnet faucet button and bottom navigation bar attached.
- **Main Unlocked Shell**:
  - Added brand header with `BrandLogo`, uppercase `VEILPAY`, `Account 1` pill, and settings sunburst button.
  - Mounted `TacticalBottomNav` and `ScanModal`.

---

## 4. Backend & Security Surface Safety

- **Zero Backend Changes**: No modifications made to `src/core/vault/`, `src/core/chains/`, `src/core/messaging/`, or `src/core/x402/`.
- **Security Overlays Untouched**: All 4 security surfaces (`ConnectionApproval`, `TransactionApproval`, `X402Approval`, and `GrantApproval`) remain identical and untouched.
- **Storage & State Integrity**: Protocol message schemas, key derivation, and Zustand store actions (`estimateTransfer`, `sendTransfer`, `requestFaucet`, etc.) operate without changes.

---

## 5. Verification & Test Results

The changes have been thoroughly verified with the test suite and build pipeline:

1. **TypeScript Typecheck**:
   ```bash
   npm run typecheck
   ```
   *Result*: **Passed with 0 errors**.

2. **Full Test Suite**:
   ```bash
   npm test
   ```
   *Result*: **64 test files passed (64/64), 513 tests passed (513/513)**.
   - Preserves all accessibility tests (`a11y.test.tsx` axe-core audits).
   - Preserves all component and integration tests (`popup.test.tsx`, `sidepanel.test.tsx`, `transaction-history.test.tsx`).

3. **Production Extension Build**:
   ```bash
   npm run build
   ```
   *Result*: **Vite bundle created cleanly in `dist/` ready to load in Chrome**.

# wealth-dashboard-skill.md — Wealth Tracker

> Claude context file. Read this before making any changes to this project.

Last updated: Jun 2026

---

## What This Project Is

A personal wealth tracking dashboard for Vishal Parwani.
- **Live URL:** https://wealth.vishalparwani.com
- **GitHub:** https://github.com/vishal-parwani/Wealth (private repo, GitHub Pages paid plan)
- **Stack:** Vanilla JS + HTML + CSS — no frameworks, no bundlers, no build step
- **Auth:** Firebase Auth — Google + Apple Sign-in (same email = same dashboard)
- **Storage:** Firebase Firestore, doc keyed by **email** (`dashboards/{email}`), UID fallback
- **Hosting:** GitHub Pages (push to `main` = instant deploy)

---

## File Map

| File | Role |
|------|------|
| `index.html` | App shell — tab bar, all panel divs, script/CDN imports, boot sequence (`_bootPortfolio`) |
| `styles.css` | All CSS; uses CSS variables (`--bg`, `--text`, `--border`, etc.). Single breakpoint `@media(max-width:700px)` |
| `firebase-init.js` | Firebase config, auth flow (Google + Apple), `saveSection()`, `saveSectionImmediate()`, `loadAllState()` |
| `portfolio.js` | Asset data model + CRUD for all modules (MF, stocks, gold, silver, RE, EPF, NPS); `getPortfolioValues()`, `getAssetCashflows()` |
| `price-tracker.js` | Live gold/silver polling (`ptPoll` every `PT_MS`=2500ms) → sets `LIVE.goldRate`/`LIVE.silverRate`; duty/GST landed-price config; Live Prices tab UI |
| `summary.js` | Summary tab — net worth totals, donut chart, desktop table / mobile cards, history chart, snapshots |
| `watchlist.js` | Watchlist tab — MF + stock watchlist with return columns |
| `nse-stocks.js` | Static Nifty 500 list `{ symbol, name, sector }` — search source for stock add |
| `export.js` | Excel export via SheetJS (all asset classes → multi-sheet workbook) |
| `utils.js` | Shared: `formatINR()`, `formatINRFull()`, `toast()`, `computeCAGR()`, `computeXIRR()`, proxy constants |

---

## Architecture

### Auth & Data Flow
1. `firebase-init.js` initialises Firebase (with offline persistence) and `initAuth()` resolves with the signed-in user
2. On sign-in, the dashboard doc is keyed by **email** (`DASH_KEY = user.email`), falling back to `user.uid` only if no email — so Google + Apple logins with the same email share one document
3. `loadAllState()` fetches the full Firestore doc
4. Each module (portfolio, watchlist, etc.) hydrates from the loaded state
5. Saves are debounced 1.2s via `saveSection(section, data)` → Firestore `merge: true`; `saveSectionImmediate()` skips the debounce for small/important writes (e.g. price settings)

### Boot Sequence (`index.html` → `_bootPortfolio`)
1. `loadAllState()` → `initWatchlist` / `initPortfolio`
2. `initPriceTracker(allData)` kicks off polling and **returns the first poll's promise**
3. Boot **awaits** that first poll (bounded to 4s) before the first `renderSummary()` — so live gold/silver rates are present on first paint. This gives **zero stale-rate flash and zero corrective re-render** (a known past pain point)
4. `PT_booted` flag is set `true` just before the first render; `ptPoll` only re-renders the summary as a one-time safety net if the first poll failed and rates arrive later

### Module Pattern
Each asset module (MF, stocks, gold etc.) follows this pattern:
- Data lives in the `P` object in `portfolio.js`
- `pSave()` persists the entire `P` object under the `portfolio` section
- `pLoad(data)` hydrates `P` from Firestore on load
- Live prices are cached in the `LIVE` object (in-memory, per session)

### Live Price Sources
| Asset | Source | Notes |
|-------|--------|-------|
| Mutual Funds | MF API (public) | NAV cached in `LIVE.mfNav` |
| Stocks (NSE) | Yahoo Finance via proxy | proxy constant in `utils.js` |
| Gold / Silver | `price-tracker.js` poll | TradingView scanner (primary) + Yahoo Finance futures (fallback) for XAU/XAG + USD-INR; applies import duty + GST to get landed ₹/g. Sets `LIVE.goldRate` / `LIVE.silverRate` |

> **Important:** `fetchGoldPrice()` / `fetchSilverPrice()` in `portfolio.js` are thin stubs that just return `LIVE.goldRate` / `LIVE.silverRate`. The actual fetching/computation lives in `price-tracker.js`. These rates are **only** populated by the async poll — never seeded from saved data — so any code that needs them at render time must account for the poll not having completed (the boot sequence handles this by awaiting the first poll).

### Tab System
- Tabs defined in `index.html` as `data-tab` buttons + `.tab-panel` divs; `switchTab(name)` calls `TAB_RENDERERS[name]`
- Active module list controlled by `activeModules` (from Firestore config); empty/none = all active
- Summary tab aggregates values from all active modules via `getPortfolioValues()`
- Default active tab on load is **Summary**

### Responsive Layout (desktop table ⇄ mobile cards)
Single breakpoint: `@media(max-width:700px)`. Several views render **both** layouts and toggle via CSS — don't try to remove one in JS:
- **Summary:** `.summary-row` holds the pie + a `.summary-table-wrap` (desktop table) + `.asset-summary-grid` (mobile cards/tiles). Desktop shows the table, hides the grid; mobile flips it. `.summary-row` uses `align-items:stretch` so the pie box matches the table height.
- **Gold / Silver:** `renderGold`/`renderSilver` build `rowPairs` of `{mobile, desktop}` via `renderMetalRow` (mobile expandable row) and `renderMetalTableRow` (desktop `<tr>`). Emits a `.metal-table-wrap` table (desktop) + `.metal-rows` (mobile).
- In `.portfolio-table`, data/header cells are right-aligned; only `.left` cells go left. Total/`tfoot` cells must match their column's alignment.

### EPF Module
- Transactions are typed: `contribution` (employee + employer amounts) or `withdrawal` (amount + optional `balanceBefore`).
- Withdrawal accounting (`getPortfolioValues`): if `balanceBefore` is given, the withdrawal is split **pro-rata** into principal-returned vs realised-gain (`principalFrac = contribSoFar / balanceBefore`). Invested basis is netted down by principal returned (`epfNetInvested = contrib − principalReturned`); the gain portion shows as realised. If `balanceBefore` is blank, the whole withdrawal is treated as principal return.
- Withdrawals are positive inflows in `getAssetCashflows` for XIRR.

### XIRR / CAGR (`utils.js`)
- `computeXIRR(cashflows)` uses Newton's method with a **bisection fallback** and a sanity cap (max 10,000%). Newton can diverge to spurious roots on quick buy/sell pairs and report absurd rates — the fallback/cap returns a real root or `null` (`—`) instead. Don't "simplify" this back to pure Newton.
- `computeCAGR(invested, current, purchaseDate)` returns `null` if held < 30 days.

---

## Key Conventions

- **Currency:** Always use `formatINR(value)` from `utils.js` — handles Cr/L compact display
- **Saving:** Always use `saveSection(sectionName, data)` — never write directly to Firestore
- **Toast notifications:** Use `toast('message')` for user feedback
- **No ES modules:** All files use global scope — script load order in `index.html` matters
- **CSS variables:** Use existing `--bg`, `--bg1`, `--text`, `--text2`, `--text3`, `--border` variables for theming consistency

---

## How to Make Changes

### Adding a new asset module
1. Add tab button and panel div in `index.html`; register it in `ALL_MODULES` and `TAB_RENDERERS`
2. Add the module to the parallel `ASSET_LABELS` / `ASSET_COLORS` / `ASSET_KEYS` / `ASSET_TABS` arrays in `summary.js` (keep them index-aligned)
3. Add data structure to `P` object in `portfolio.js`; include in save/load and in `getPortfolioValues()` + `getAssetCashflows()`
4. Wire up UI render functions following existing module pattern (desktop table + mobile cards if it's a list view)
5. Include in `export.js` for Excel export

### Modifying live price logic
- Stock prices: edit the fetch logic calling the proxy in `portfolio.js` / `watchlist.js`
- Gold/silver: edit `price-tracker.js` (`ptPoll`, `ptFetchMetal`, `ptLanded`); duty/GST settings persist to Firestore (`price_settings`). Do NOT add a separate fetch in `portfolio.js` — keep `fetchGoldPrice`/`fetchSilverPrice` as stubs over `LIVE.*`
- MF NAV: uses public MF API — NAVs cached in `LIVE.mfNav`

### Deploying
- Push to `main` branch → GitHub Pages auto-deploys within ~1 minute
- No build step required

---

## Firebase & Security

- Firestore rules are keyed by **email** with a UID fallback (documented at the top of `firebase-init.js`):
  ```
  match /dashboards/{docId} {
    allow read, write: if request.auth != null && (
      (request.auth.token.email != null && docId == request.auth.token.email) ||
      (request.auth.token.email == null && docId == request.auth.uid)
    );
  }
  ```
- Firebase project: `wealth-vishalparwani`
- Firebase web config (incl. `apiKey`) is hardcoded in `firebase-init.js`. **This is public-safe by design** — Firebase web API keys are not secrets; access is protected by Firestore rules + authorized domains. The key in use is the domain-restricted one. If GitHub secret-scanning flags it, that's a false positive — dismiss it.

---

## Things to Be Careful About

- **Script load order** in `index.html` is critical — `firebase-init.js` before `portfolio.js` before `price-tracker.js`/`summary.js`. All files share global scope (no ES modules), so top-level `let`/`const` in one classic script (e.g. `PT_booted` in `price-tracker.js`) are reachable from the inline boot script.
- **Summary stale rates / flicker** is a recurring trap. The correct behavior is: await the first price poll before the first summary render (zero stale, zero flicker). Do NOT re-introduce an unconditional `renderSummary()` inside `ptPoll` — that caused a flicker-every-2.5s regression. The only summary re-render in `ptPoll` is gated behind `PT_booted && ratesWereMissing` as a failure safety net.
- **Safari/Apple sign-in** uses popup (not redirect) — do not change this; redirect breaks due to ITP.
- **Legacy migration** logic in `firebase-init.js` handles old UUID-based keys — do not remove.

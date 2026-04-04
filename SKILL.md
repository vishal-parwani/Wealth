# SKILL.md — Wealth Tracker

> Claude context file. Read this before making any changes to this project.

Last updated: Apr 2026

---

## What This Project Is

A personal wealth tracking dashboard for Vishal Parwani.
- **Live URL:** https://wealth.vishalparwani.com
- **GitHub:** https://github.com/vishal-parwani/Wealth
- **Stack:** Vanilla JS + HTML + CSS — no frameworks, no bundlers, no build step
- **Auth:** Firebase Google Sign-in
- **Storage:** Firebase Firestore (`dashboards/{userId}`)
- **Hosting:** GitHub Pages (push to `main` = instant deploy)

---

## File Map

| File | Role |
|------|------|
| `index.html` | App shell — tab bar, all panel divs, script/CDN imports |
| `styles.css` | All CSS; uses CSS variables (`--bg`, `--text`, `--border`, etc.) |
| `firebase-init.js` | Firebase config, auth flow, `saveSection()`, `loadAllState()` |
| `portfolio.js` | Asset data model + CRUD for all modules (MF, stocks, gold, silver, RE, EPF, NPS) |
| `summary.js` | Summary tab — net worth totals, donut chart, history chart, snapshots |
| `watchlist.js` | Watchlist tab — MF + stock watchlist with return columns |
| `nse-stocks.js` | Static Nifty 500 list `{ symbol, name, sector }` — search source for stock add |
| `export.js` | Excel export via SheetJS (all asset classes → multi-sheet workbook) |
| `utils.js` | Shared: `formatINR()`, `toast()`, `CF_PROXY` constant |

---

## Architecture

### Auth & Data Flow
1. `firebase-init.js` initialises Firebase and calls `initAuth()`
2. On sign-in, `DASH_KEY = user.uid`, `DASH_REF = db.collection('dashboards').doc(uid)`
3. `loadAllState()` fetches the full Firestore doc
4. Each module (portfolio, watchlist, etc.) hydrates from the loaded state
5. Saves are debounced 1.2s via `saveSection(section, data)` → Firestore `merge: true`

### Module Pattern
Each asset module (MF, stocks, gold etc.) follows this pattern:
- Data lives in the `P` object in `portfolio.js`
- `pSave()` persists the entire `P` object under the `portfolio` section
- `pLoad(data)` hydrates `P` from Firestore on load
- Live prices are cached in the `LIVE` object (in-memory, per session)

### Live Price Sources
| Asset | Source | Notes |
|-------|--------|-------|
| Mutual Funds | MF API (public) | NAV cached in `localStorage` (`mfd_nav`) |
| Stocks (NSE) | Yahoo Finance via Cloudflare Worker | `CF_PROXY` in `utils.js` |
| Gold / Silver | GoldAPI.io | Key stored in Firestore; fallback hardcoded in `portfolio.js` |

### Tab System
- Tabs defined in `index.html` as `data-tab` buttons + `.tab-panel` divs
- Active module list controlled by `ACTIVE_MODULES` (from Firestore config); `null` = all active
- Summary tab aggregates values from all active modules via `getPortfolioValues()`

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
1. Add tab button and panel div in `index.html`
2. Add module data key to `ACTIVE_MODULES` list and `ASSET_*` arrays in `summary.js`
3. Add data structure to `P` object in `portfolio.js`; include in `pSave()` and `pLoad()`
4. Wire up UI render functions following existing module pattern
5. Include in `export.js` for Excel export

### Modifying live price logic
- Stock prices: edit the fetch logic calling `CF_PROXY` in `portfolio.js` / `watchlist.js`
- Gold/silver: GoldAPI key can be overridden via the ⚙ settings button (saves to Firestore)
- MF NAV: uses public MF API — cache management via `getNavCache()` / `saveNavCache()` in `firebase-init.js`

### Deploying
- Push to `main` branch → GitHub Pages auto-deploys within ~1 minute
- No build step required

---

## Firebase & Security

- Firestore rules must allow: `read, write: if request.auth != null && request.auth.uid == userId`
- Firebase project: `wealth-vishalparwani`
- Firebase config is hardcoded in `firebase-init.js` (public-safe — protected by Firestore rules)
- GoldAPI key is stored in Firestore (not in source code) — fetched at runtime

---

## Things to Be Careful About

- **Script load order** in `index.html` is critical — `firebase-init.js` must load before `portfolio.js`, which must load before `summary.js` etc.
- **Safari sign-in** uses popup (not redirect) — do not change this; redirect breaks due to ITP
- **`localStorage`** is used only for MF NAV cache — not for user data
- **Legacy migration** logic in `firebase-init.js` handles old UUID-based keys — do not remove

# Wealth Dashboard

Personal wealth-tracking PWA (vanilla JS + Firebase), deployed via GitHub Pages.
No build step, no framework — every `.js` file is a plain script loaded by `index.html`.

> ⚠️ This repo is PUBLIC (GitHub Pages). Never commit credentials, service-account
> keys, tokens, or personal data. Operational details (Firestore paths, auth setup,
> publishing workflow) live in the private Claude memory, not in this file.

## Running locally

Use the Browser tool with `.claude/launch.json` (`wealth-dashboard` → python http.server
on port 3456). The app requires Google/Apple sign-in for any data, so most tabs can't be
exercised without the user's session — verify data-layer changes with standalone Node/
Python harnesses against real API data instead (extract the function from the source
file and stub `fetch`).

## Module map

| File | Purpose |
|---|---|
| `index.html` | All markup: tabs, panels, modals, script includes |
| `firebase-init.js` | Firebase config/auth, Firestore load/save helpers, localStorage caches |
| `summary.js` / `portfolio.js` | Summary + holdings (MF, stocks, gold, silver, real estate, EPF, NPS) |
| `watchlist.js` | Fund/stock watchlist; NAV stats from api.mfapi.in (see gotchas) |
| `stock-reports.js` | Research tab (Stocks + Funds sub-tabs) — see `STOCK-REPORTS.md` |
| `price-tracker.js` | Live price feeds (Yahoo via CORS proxy) |
| `export.js` | Excel export (SheetJS) |
| `wealth-dashboard-skill.md` | Fuller architecture notes |

## Conventions & gotchas

- **AMFI NAV history (api.mfapi.in) has one entry per *declared* NAV** (~248/yr for
  equity funds, ~daily for liquid/overnight). Never index the array by "days" — look up
  by date and annualise over actual elapsed days (see `fetchNav` in `watchlist.js`).
- **localStorage caches**: computed NAV stats persist under a versioned key
  (`mfd_nav_v2`). If you change the return-computation logic, bump the key version so
  stale values are discarded on every client.
- **Research reports** are standalone HTML files with machine-readable `<meta>` tags
  (spec in `STOCK-REPORTS.md`). Authored copies are archived under `Stock Reports/`;
  the app itself reads them from Firestore, so committing alone does NOT make a report
  appear in the app.
- Fund reports should carry the AMFI `scheme` code so the viewer shows live NAV, and
  ratings must map onto the app's rating families (buy / accumulate / watch /
  speculative / avoid — see `srRatingFamily`).
- **Agent sessions: always merge completed work to `main`** (and push) — the app
  deploys from `main` via GitHub Pages, so work left on a feature branch never goes
  live. Don't wait for a PR or ask; merge once the change is done and verified.
- Commit style: short imperative subject prefixed by module, e.g.
  `Watchlist: fix NAV return windows`, `Fund report: Helios Mid Cap (HELIOSMID)`.
- **Publishing reports to Firestore** (agent sessions): authenticate with the
  service-account key. Resolution order: local path on the owner's Mac (documented in
  private memory) → `/sessions/*/mnt/AI Oversight/Automations/wealth-service-account.json`
  (mounted sessions) → `$WEALTH_SA_KEY` env var (cloud environments; write it to a temp
  file and `gcloud auth activate-service-account --key-file=…`). The key itself is never
  in this repo.

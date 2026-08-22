# Research tab (Stocks + Funds)

A library + viewer for research reports, split into two sub-tabs: **Stocks** and
**Funds**. Reports are **authored elsewhere** (in a Claude chat, using the v1.1
template) and exported as standalone HTML. This tab stores them, lists them, renders
them, and keeps live market data next to each one. No LLM call, no API key — the only
external calls are public price/NAV lookups.

## Fund / NFO reports

Fund reports evaluate a scheme — especially an **NFO**, where the fund itself has no
track record yet, so the signal is the **fund manager's history**. A fund report carries
`<meta name="type" content="fund">` plus fund meta (below). The app then:

- Pulls **live trailing returns (1/3/5Y CAGR)** for the manager's existing funds from
  `api.mfapi.in` (no key) — shown as a live panel in the viewer and a "Mgr track" column
  in the list. This is the manager's performance history, always fresh.
- Shows the fund's **live NAV vs its ₹10 launch** once it has an AMFI scheme code; until
  then the row shows the **NFO status** (open / closes-date).
- Uses the same three ratings as stocks: `Buy` / `Hold` / `Sell`. Fund-specific
  nuance (SIP vs lump sum, wait-for-track-record) belongs in the report body, not
  the rating.

### Fund report meta tags

```html
<meta name="type"     content="fund">
<meta name="ticker"   content="ICICIMAAFOF">     <!-- id slug; else derived from name -->
<meta name="name"     content="ICICI Prudential Multi-Asset Active FoF">
<meta name="amc"      content="ICICI Prudential Mutual Fund">
<meta name="category" content="Multi-Asset FoF (Active)">
<meta name="manager"  content="Dharmesh Kakkad, Manish Banthia, …">
<meta name="rating"   content="Buy">
<meta name="generated" content="2026-07-10">
<meta name="price"    content="10">              <!-- NFO NAV -->
<meta name="scheme"   content="">                <!-- AMFI code for live NAV; empty for an NFO -->
<meta name="nfoclose" content="2026-07-14">
<meta name="benchmark" content="55% Nifty 200 TRI + 35% Debt + 7% Gold + 3% Silver">
<!-- pipe-list of the manager's existing funds → live returns; "AMFIcode:Label" -->
<meta name="managerfunds" content="120334:ICICI Pru Multi-Asset|120586:ICICI Pru Large Cap|…">
```

Find AMFI scheme codes at `https://api.mfapi.in/mf/search?q=<fund name>`. Once the NFO
lists and gets its own code, add it to `scheme` and **Replace** the report to switch the
row from NFO-status to live NAV.

---

## Stock reports

Reports are authored elsewhere and keep a live price next to each one via a stock price lookup.

## What it does

- **Lists** every saved report: ticker, name, sector, colour-coded rating badge,
  generated date, live price + drift vs the report's generation price, a "verify" dot
  (report flagged approximate data), and a "stale" badge (generated > 3 months ago).
- **Search / filter / sort** by ticker/name, sector, rating family, verify-only.
- **Live prices** auto-fetch on tab open (⟳ Prices to refresh). Source: Yahoo Finance
  via the app's existing CORS proxy (`.NS`, falling back to `.BO`), ~15-min delayed.
- **Viewer** renders the full report HTML in a sandboxed iframe — split pane on desktop,
  new tab on mobile — with a private note you can edit.

## How to add a report

1. In a Claude chat, generate the report using **template v1.1**
   (`stock-research-template.v1.1.html`) and export it as standalone HTML.
2. In the app → **Stock Reports** tab → **+ Add Report**.
3. Either **upload** the `.html` file or **paste** its HTML.
4. The app validates it, previews the parsed meta (ticker / name / sector / rating /
   gen price), and you click **Save report**. It's stored, listed, and opened.

### The report must carry v1.1 `<meta>` tags

The importer reads these machine-readable tags from the report's `<head>`:

```html
<meta name="ticker"    content="COFORGE">
<meta name="exchange"  content="NSE">
<meta name="sector"    content="IT Services">
<meta name="rating"    content="Hold">
<meta name="risk"      content="high">   <!-- optional; omit for ordinary risk -->
<meta name="generated" content="2026-06-25">   <!-- YYYY-MM-DD -->
<meta name="price"     content="1480.40">       <!-- price at generation -->
<meta name="name"      content="Coforge Limited"> <!-- optional; else <title> -->
```

`ticker`, `generated`, and a numeric `price` are **required** — the importer rejects
anything missing them with a clear message. Older v1.0 exports have no meta tags; add
the block above (or regenerate with v1.1) before importing.

## Updating a report (analysis refresh)

When you regenerate a report with fresh fundamentals/news, use **Replace report** (row
menu ⋯, or the button in the viewer). It overwrites the HTML, rating, gen price and date
**while preserving the record's id, your personal note, and any price override**. Live
price re-fetch is separate and mechanical — it never modifies the stored report, so each
report stays a clean snapshot as authored.

## Small-cap / SME tickers (price override)

Some SME tickers (e.g. NSE SME names) don't resolve on Yahoo/Google Finance. For those,
row menu ⋯ → **Price override**:

- **Custom Yahoo symbol** — point the report at a specific symbol incl. suffix
  (`.NS` for NSE, `.BO` for BSE — BSE uses the numeric scrip code, e.g. `543399.BO`).
- **Manual price** — pin a price with an "as of" date. It shows an **M** marker and is
  not auto-refreshed.

If neither the ticker nor an override resolves, the row shows **n/a** and relies on the
report's embedded generation price. Overrides persist and survive a report replace.

## Cross-link with holdings

On the **Stocks** tab, any holding whose ticker matches a saved report shows a small
"▤ research" pill; clicking it opens that report.

## Storage & data model

Reports live in a Firestore subcollection, one doc per report:
`dashboards/{email}/reports/{id}` (id = lower-case ticker). Fields:

| field | notes |
|-------|-------|
| `ticker`, `exchange`, `name`, `sector`, `rating` | parsed from meta |
| `ratingFamily` | `buy` \| `hold` \| `sell` → badge colour |
| `risk` | `high` \| `''` → renders a separate "high risk" tag beside the badge |
| `genPrice` | price embedded in the report at generation |
| `generatedAt` | YYYY-MM-DD from meta |
| `hasGaps` | drives the amber "verify" dot |
| `personalNote` | your note; preserved on replace |
| `priceOverride` | `{ symbol }` or `{ price, asOf }` or `null` |
| `html` | the full report source |

Live price is **not** stored — it's fetched at view time and compared against `genPrice`.

### Firestore rule (one-time)

The reports subcollection needs a rule mirroring the parent dashboard doc:

```
match /dashboards/{docId}/reports/{reportId} {
  allow read, write: if request.auth != null && (
    (request.auth.token.email != null && docId == request.auth.token.email) ||
    (request.auth.token.email == null && docId == request.auth.uid)
  );
}
```

## Files

- `stock-reports.js` — data layer (CRUD, meta parser), list UI, viewer, import modal,
  price feed, override modal, Stocks cross-link.
- `index.html` — tab button, panel, import + override modals, module registration.
- `styles.css` — everything under the `STOCK REPORTS TAB` comment.

## Template v2 (current — start from `Stock Reports/_TEMPLATE-v2.html`)

Fixed section order:

1. **Key data grid** — share price, 52W range, market cap, dividend yield, TTM P/E,
   P/BV, net debt, debt/equity, and 6-month average daily volume + turnover.
   For a company listed less than six months, use the whole listed history and
   say so — the app shows a live version of the same figure under its chart.
2. **Verdict** — the sentence that decides the call, then evidence, then counter-argument
3. **Broker estimates** — named brokers, targets, % vs spot, date; plus forward P/E
4. *(no price-chart section)* — the app draws a live 1-year chart directly above
   the report. v1 and early-v2 reports carry a "Share price — 1 year" heading and
   an empty slot; the viewer strips both at display time, so don't add one.
5. **Financials** — an *annual* table (2–3 years) and a *separate* last-4-quarters table.
   Annual-only hides sequential margin reversals, which is usually where the story is.
6. **Latest news** — last 3 months, top 5, each with a date and why it matters
7. **Corporate governance** — 5-quarter promoter / FII / DII / public shareholding table
   (read the *direction*, not the level), then promoter, management and board profiles
8. **Business** — nature, peer table, moat (or plainly: none), confirmed order book
9. **Risks** → 10. **What would change the rating** → 11. **Sources**

Mutual fund holdings carry the **top 5 by value held**, then every remaining
holder inside a collapsed `<details class="fundlist">` block — one click opens the
full list without burying the page. Drop the block entirely when there are five
holders or fewer. The PDF export forces every `<details>` open, so a downloaded
report always carries the complete list.

Conventions: superscript `d` marks a derived figure, an "unreconciled" chip marks
conflicting sources, grey `n/a` marks data that could not be sourced. Never invent a
number to fill a cell.

Styling: light paper (`#fcfcfa`), serif headings, system sans body, tabular numerals,
all system fonts — the report renders inside a sandboxed iframe with no network.

# Stock Reports tab

A library + viewer for equity research reports. Reports are **authored elsewhere**
(in a Claude chat, using the v1.1 template) and exported as standalone HTML. This tab
stores them, lists them, renders them, and keeps a live price next to each one. No
LLM call, no API key — the only external call is a stock price lookup.

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
<meta name="rating"    content="Watch / Accumulate on Weakness">
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
| `ratingFamily` | `buy` \| `accumulate` \| `watch` \| `speculative` \| `avoid` → badge colour |
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

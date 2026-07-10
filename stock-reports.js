// ════════════════════════════════════════════════════════
//  STOCK REPORTS MODULE — data layer
//  Stores standalone research-report HTML (template v1.1) in a
//  Firestore subcollection: dashboards/{email}/reports/{id}.
//  One doc per report (full HTML fits well under the 1MB doc cap).
//  Meta fields are parsed from the report's own <meta> tags on import.
//  Live prices come later (phase 6) via the existing Yahoo CF_PROXY.
//
//  Firestore rules required (same predicate as the parent doc):
//    match /dashboards/{docId}/reports/{reportId} {
//      allow read, write: if request.auth != null && (
//        (request.auth.token.email != null && docId == request.auth.token.email) ||
//        (request.auth.token.email == null && docId == request.auth.uid)
//      );
//    }
// ════════════════════════════════════════════════════════

// Module state — prefixed SR_ to avoid clashing with other globals
let SR_reports = [];      // [{id, ticker, exchange, name, sector, rating, ratingFamily, genPrice, generatedAt, hasGaps, personalNote, priceOverride, html}]
let SR_loaded  = false;
let SR_lastErr = null;

function srColl() {
  if (!DASH_REF) throw new Error('Not signed in');
  return DASH_REF.collection('reports');
}

// ── Rating → family (drives badge colour) ───────────────
// Order matters: first match wins. "avoid"/"sell" checked before "buy"
// so "Avoid — do not buy" lands in the avoid family. Fund verbs
// (subscribe/sip/wait/thematic) map onto the same five families.
function srRatingFamily(rating) {
  const r = String(rating || '').toLowerCase();
  if (/\bavoid\b|\bsell\b|\bexit\b/.test(r))                          return 'avoid';
  if (/speculat|thematic/.test(r))                                    return 'speculative';
  if (/\bwatch\b|\bhold\b|priced.for.perfection|neutral|\bwait\b/.test(r)) return 'watch';
  if (/accumulate|\bsip\b/.test(r))                                   return 'accumulate';
  if (/\bbuy\b|subscribe/.test(r))                                    return 'buy';
  return 'watch';
}

function srSlug(s) {
  return String(s || '').replace(/[^a-z0-9]+/gi, '').toUpperCase().slice(0, 28) || 'FUND';
}

// Parse the pipe-separated managerfunds meta: "code:Name|code:Name" → [{code,name}]
function srParseManagerFunds(raw) {
  return String(raw || '').split('|').map(s => s.trim()).filter(Boolean).map(s => {
    const i = s.indexOf(':');
    return i < 0 ? { code: s.trim(), name: s.trim() } : { code: s.slice(0, i).trim(), name: s.slice(i + 1).trim() };
  }).filter(x => x.code);
}

// ── Parse + validate a v1.1 report HTML ─────────────────
// Returns { ok:true, meta:{...} } or { ok:false, error:'…' }.
// Required meta tags: ticker, generated, price. Others degrade gracefully.
function srParseReportHtml(html) {
  if (!html || html.length < 200) return { ok: false, error: 'File is empty or too small to be a report.' };
  let doc;
  try {
    doc = new DOMParser().parseFromString(html, 'text/html');
  } catch (e) {
    return { ok: false, error: 'Could not parse HTML: ' + e.message };
  }
  const meta = name => doc.querySelector(`meta[name="${name}"]`)?.getAttribute('content')?.trim() || '';

  const type   = (meta('type') || 'stock').toLowerCase();
  const isFund = type === 'fund';

  // Name: prefer explicit meta, else <title>, else first <h1>
  const name = meta('name') || meta('company')
    || (doc.querySelector('title')?.textContent || '').split(/[|—–-]/)[0].trim()
    || doc.querySelector('h1')?.textContent?.trim()
    || meta('ticker').toUpperCase() || 'Untitled';

  // Identifier: stocks require a ticker; funds accept ticker or slugified name.
  const ticker = (meta('ticker').toUpperCase()) || (isFund ? srSlug(name) : '');
  if (!ticker) return { ok: false, error: 'Not a v1.1 research report — missing <meta name="ticker">.' };

  const generated = meta('generated');
  const priceRaw  = meta('price').replace(/[₹,\s]/g, '');
  const genPrice  = parseFloat(priceRaw);
  if (!generated) return { ok: false, error: 'Report is missing <meta name="generated"> (generation date).' };
  if (!Number.isFinite(genPrice)) {
    return { ok: false, error: isFund
      ? 'Fund report is missing a numeric <meta name="price"> (NFO NAV, e.g. 10).'
      : 'Report is missing a numeric <meta name="price">.' };
  }

  const rating = meta('rating') || 'Unrated';
  const gapsMeta = meta('hasgaps') || meta('has-gaps') || meta('gaps');
  const hasGaps  = gapsMeta
    ? /^(true|yes|1)$/i.test(gapsMeta)
    : /data-verify|class="verify|⚠ verify/i.test(html);

  const base = {
    type,
    ticker,
    exchange: (meta('exchange') || 'NSE').toUpperCase(),
    name,
    sector: meta('category') || meta('sector') || '—',   // category is the fund's "sector"
    rating,
    ratingFamily: srRatingFamily(rating),
    genPrice,
    generatedAt: generated,       // ISO yyyy-mm-dd as authored
    hasGaps,
  };

  if (isFund) {
    Object.assign(base, {
      amc:          meta('amc') || '—',
      manager:      meta('manager') || '—',
      scheme:       meta('scheme') || '',            // AMFI code for live NAV ('' for an NFO)
      benchmark:    meta('benchmark') || '',
      nfoClose:     meta('nfoclose') || meta('nfo-close') || '',
      managerFunds: srParseManagerFunds(meta('managerfunds') || meta('manager-funds')),
    });
  }

  return { ok: true, meta: base };
}

// ── CRUD ────────────────────────────────────────────────

async function srLoadReports() {
  try {
    const snap = await srColl().get();
    SR_reports = snap.docs.map(d => ({ id: d.id, type: 'stock', ...d.data() }));  // legacy records = stock
    // Newest generated first
    SR_reports.sort((a, b) => String(b.generatedAt).localeCompare(String(a.generatedAt)));
    SR_loaded  = true;
    SR_lastErr = null;
  } catch (e) {
    console.warn('Stock reports load failed', e);
    SR_lastErr = e.message;
    SR_loaded  = true;   // loaded (with error) — render can show the message
  }
  return SR_reports;
}

// Import (add or replace). `html` is the full report source.
// On replace, personalNote and priceOverride are preserved.
async function srImportReport(html) {
  const parsed = srParseReportHtml(html);
  if (!parsed.ok) throw new Error(parsed.error);
  const m  = parsed.meta;
  const id = m.ticker.toLowerCase();
  const existing = SR_reports.find(r => r.id === id);
  const rec = {
    ...m,
    personalNote:  existing?.personalNote  || '',
    priceOverride: existing?.priceOverride || null,   // { symbol } or { price, asOf }
    importedAt: new Date().toISOString(),
    html,
  };
  await srColl().doc(id).set(rec);
  const i = SR_reports.findIndex(r => r.id === id);
  if (i >= 0) SR_reports[i] = { id, ...rec }; else SR_reports.unshift({ id, ...rec });
  SR_reports.sort((a, b) => String(b.generatedAt).localeCompare(String(a.generatedAt)));
  return { id, replaced: !!existing };
}

// Patch small fields (note, price override) without rewriting the HTML
async function srUpdateReport(id, patch) {
  await srColl().doc(id).update(patch);
  const r = SR_reports.find(r => r.id === id);
  if (r) Object.assign(r, patch);
}

async function srDeleteReport(id) {
  await srColl().doc(id).delete();
  SR_reports = SR_reports.filter(r => r.id !== id);
}

// ── Helpers used by the UI (phase 4) ────────────────────

const SR_STALE_DAYS = 92;   // ~3 months → "stale" badge

function srIsStale(r) {
  const t = new Date(r.generatedAt).getTime();
  return Number.isFinite(t) && (Date.now() - t) / 86400000 > SR_STALE_DAYS;
}

// ── View state ──────────────────────────────────────────

let SR_view = { kind: 'stock', q: '', sector: '', family: '', verifyOnly: false, sortKey: 'generatedAt', sortDir: -1, openId: null };

const SR_FAMILY_LABEL = { buy: 'Buy', accumulate: 'Accumulate', watch: 'Watch / Hold', speculative: 'Speculative', avoid: 'Avoid' };

function srFmtDate(iso) {
  const t = new Date(iso);
  return Number.isFinite(t.getTime())
    ? t.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: '2-digit' })
    : esc(String(iso));
}

function srFmtPrice(n) {
  return Number.isFinite(n) ? n.toLocaleString('en-IN', { maximumFractionDigits: n < 100 ? 2 : 0 }) : '—';
}

function srRatingBadge(r) {
  return `<span class="sr-badge sr-badge-${esc(r.ratingFamily || 'watch')}" title="${esc(r.rating)}">${esc(r.rating)}</span>`;
}

function srFlags(r) {
  return (r.hasGaps ? ' <span class="sr-dot" title="Report contains approximate data — verify before acting"></span>' : '')
       + (srIsStale(r) ? ' <span class="sr-stale" title="Generated over 3 months ago — consider re-importing a fresh report">stale</span>' : '');
}

// ── Live price feed (Yahoo Finance via the shared CF_PROXY) ──
// SR_prices[id] = { price, changePct, asOf, manual? , na? }.  Never stored on
// the report record — fetched at view time and compared against genPrice, so
// the report itself stays a clean snapshot as authored.
let SR_prices    = {};
let SR_pricesAsOf = null;
let SR_pricesLoading = false;

// Fetch a single Yahoo symbol (e.g. "COFORGE.NS"). Returns {price, changePct} or null.
async function srFetchQuote(symbol) {
  try {
    const yf = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=5d`;
    const r  = await fetch(`${CF_PROXY}?url=${encodeURIComponent(yf)}`, { cache: 'no-store' });
    if (!r.ok) return null;
    const meta = (await r.json())?.chart?.result?.[0]?.meta;
    const price = meta?.regularMarketPrice;
    if (!Number.isFinite(price)) return null;
    const prev = meta.chartPreviousClose ?? meta.previousClose ?? null;
    return { price, changePct: prev ? ((price - prev) / prev) * 100 : null };
  } catch (e) { return null; }
}

// Resolve one report's live price, honouring a manual/symbol override.
async function srFetchReportPrice(r) {
  const ov = r.priceOverride;
  if (ov && Number.isFinite(ov.price)) {
    return { price: ov.price, changePct: null, asOf: ov.asOf || null, manual: true };
  }
  // Candidate Yahoo symbols: explicit override symbol wins; else ticker on its
  // own exchange first, then the other Indian exchange as a fallback.
  const candidates = ov && ov.symbol
    ? [ov.symbol]
    : (r.exchange === 'BSE' ? [`${r.ticker}.BO`, `${r.ticker}.NS`] : [`${r.ticker}.NS`, `${r.ticker}.BO`]);
  for (const sym of candidates) {
    const q = await srFetchQuote(sym);
    if (q) return { ...q, asOf: Date.now(), symbol: sym };
  }
  return { na: true };
}

// ── Fund live data (NAV + manager track record via mfapi.in, no key) ──
// SR_navHist caches each AMFI scheme's full NAV history so a manager's funds
// are fetched once and reused across reports.
let SR_navHist = {};

async function srFetchNavHistory(code) {
  if (!code) return null;
  if (SR_navHist[code]) return SR_navHist[code];
  try {
    const r = await fetch(`https://api.mfapi.in/mf/${encodeURIComponent(code)}`, { cache: 'no-store' });
    if (!r.ok) return null;
    const d = await r.json();
    const pts = (d.data || [])
      .map(x => [new Date(x.date.split('-').reverse().join('-')), parseFloat(x.nav)])
      .filter(p => p[1] > 0 && !isNaN(p[0]))
      .sort((a, b) => a[0] - b[0]);
    if (!pts.length) return null;
    SR_navHist[code] = { pts, name: d?.meta?.scheme_name || null };
    return SR_navHist[code];
  } catch (e) { return null; }
}

// Trailing CAGR (% p.a.) over `years`, using the closest NAV on/before the target date.
function srCagr(pts, years) {
  if (!pts || !pts.length) return null;
  const [ld, ln] = pts[pts.length - 1];
  const target = new Date(ld.getTime() - years * 365.25 * 86400000);
  let base = null;
  for (let i = pts.length - 1; i >= 0; i--) { if (pts[i][0] <= target) { base = pts[i]; break; } }
  if (!base) return null;
  const yrs = (ld - base[0]) / (365.25 * 86400000);
  if (yrs < years * 0.6) return null;   // not enough history for this window
  return (Math.pow(ln / base[1], 1 / yrs) - 1) * 100;
}

// Resolve a fund report's live data: current NAV (if the fund has an AMFI code
// yet) + trailing returns for each of the manager's existing funds.
async function srFetchFundData(r) {
  let nav = null, navAsOf = null;
  if (r.scheme) {
    const h = await srFetchNavHistory(r.scheme);
    if (h) { nav = h.pts[h.pts.length - 1][1]; navAsOf = h.pts[h.pts.length - 1][0].getTime(); }
  }
  const mgr = [];
  for (const mf of (r.managerFunds || [])) {
    const h = await srFetchNavHistory(mf.code);
    const pts = h?.pts || null;
    mgr.push({
      name: mf.name || h?.name || mf.code, code: mf.code,
      r1: srCagr(pts, 1), r3: srCagr(pts, 3), r5: srCagr(pts, 5),
      nav: pts ? pts[pts.length - 1][1] : null,
    });
  }
  const avg = win => {
    const xs = mgr.map(m => m[win]).filter(Number.isFinite);
    return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
  };
  return { fund: true, nav, navAsOf, mgr, avg5: avg('r5'), avg3: avg('r3'), na: !r.scheme && !mgr.length };
}

// Refresh live data for every loaded report (stocks → price, funds → NAV/returns).
async function srRefreshPrices() {
  if (SR_pricesLoading || !SR_reports.length) return;
  SR_pricesLoading = true;
  const btn = document.getElementById('sr-refresh-prices');
  if (btn) { btn.disabled = true; btn.classList.add('spin'); }
  try {
    await Promise.all(SR_reports.map(async r => {
      SR_prices[r.id] = (r.type === 'fund') ? await srFetchFundData(r) : await srFetchReportPrice(r);
    }));
    SR_pricesAsOf = Date.now();
  } finally {
    SR_pricesLoading = false;
    renderStockReports();
  }
}

// The manager-track signal for a fund row: avg 5Y (fallback 3Y) across manager funds.
function srMgrTrackCell(r) {
  const p = SR_prices[r.id];
  if (!p) return '<span class="sr-na">…</span>';
  const v = Number.isFinite(p.avg5) ? p.avg5 : p.avg3;
  const win = Number.isFinite(p.avg5) ? '5Y' : '3Y';
  if (!Number.isFinite(v)) return '<span class="sr-na">—</span>';
  return `<span class="${v >= 0 ? 'sr-up' : 'sr-dn'}">${v >= 0 ? '+' : ''}${v.toFixed(1)}%</span> <span class="sr-sub">${win} avg</span>`;
}

// The status/NAV cell for a fund row.
function srFundStatusCell(r) {
  const p = SR_prices[r.id];
  if (r.scheme && p && Number.isFinite(p.nav)) {
    const drift = ((p.nav - r.genPrice) / r.genPrice) * 100;
    return `<span class="sr-now">₹${p.nav.toFixed(2)}</span> <span class="${drift >= 0 ? 'sr-up' : 'sr-dn'}">${drift >= 0 ? '+' : ''}${drift.toFixed(1)}%</span>`;
  }
  if (r.nfoClose) {
    const cd = new Date(r.nfoClose);
    const open = Number.isFinite(cd.getTime()) && cd >= new Date(new Date().toDateString());
    return `<span class="sr-nfo${open ? '' : ' closed'}">${open ? 'NFO · closes ' + srFmtDate(r.nfoClose) : 'NFO closed'}</span>`;
  }
  return '<span class="sr-nfo">NFO</span>';
}

function srLivePrice(r) {
  const p = SR_prices[r.id];
  return p && Number.isFinite(p.price) ? p.price : null;
}

function srDriftCells(r) {
  const p = SR_prices[r.id];
  const gen = `<span class="sr-gen">${srFmtPrice(r.genPrice)}</span>`;
  const naCell = { genNow: `${gen}<span class="sr-arrow">→</span><span class="sr-na">n/a</span>`, drift: '<span class="sr-na">—</span>' };
  if (!p) {  // not fetched yet
    return { genNow: `${gen}<span class="sr-arrow">→</span><span class="sr-na">…</span>`, drift: '<span class="sr-na">—</span>' };
  }
  if (!Number.isFinite(p.price)) return naCell;
  const pct = ((p.price - r.genPrice) / r.genPrice) * 100;
  const cls = pct >= 0 ? 'sr-up' : 'sr-dn';
  const nowMark = p.manual ? ' <span class="sr-manual" title="Manual price override">M</span>' : '';
  return {
    genNow: `${gen}<span class="sr-arrow">→</span><span class="sr-now">${srFmtPrice(p.price)}</span>${nowMark}`,
    drift: `<span class="${cls}">${pct >= 0 ? '+' : ''}${pct.toFixed(1)}%</span>`,
  };
}

function srFiltered() {
  const q = SR_view.q.trim().toLowerCase();
  let rows = SR_reports.filter(r =>
    ((r.type || 'stock') === SR_view.kind) &&
    (!q || r.ticker.toLowerCase().includes(q) || String(r.name).toLowerCase().includes(q)
        || String(r.manager || '').toLowerCase().includes(q) || String(r.amc || '').toLowerCase().includes(q)) &&
    (!SR_view.sector || r.sector === SR_view.sector) &&
    (!SR_view.family || r.ratingFamily === SR_view.family) &&
    (!SR_view.verifyOnly || r.hasGaps)
  );
  const k = SR_view.sortKey, dir = SR_view.sortDir;
  rows.sort((a, b) => {
    const av = a[k], bv = b[k];
    const c = typeof av === 'number' && typeof bv === 'number' ? av - bv : String(av ?? '').localeCompare(String(bv ?? ''));
    return c * dir;
  });
  return rows;
}

// ── List ────────────────────────────────────────────────

function srDrawList(wrap) {
  const isFund = SR_view.kind === 'fund';
  const subtabs = `
    <div class="sr-subtabs">
      <button class="sr-sub ${!isFund ? 'on' : ''}" data-kind="stock">Stocks</button>
      <button class="sr-sub ${isFund ? 'on' : ''}" data-kind="fund">Funds</button>
    </div>`;
  const wireSubtabs = () => wrap.querySelectorAll('.sr-sub').forEach(b => b.addEventListener('click', () => {
    if (b.dataset.kind === SR_view.kind) return;
    SR_view.kind = b.dataset.kind;
    SR_view.q = ''; SR_view.sector = ''; SR_view.family = ''; SR_view.verifyOnly = false;
    SR_view.sortKey = 'generatedAt'; SR_view.sortDir = -1;
    srDrawList(wrap);
  }));
  const addLabel = document.getElementById('btn-add-report');
  if (addLabel) addLabel.textContent = isFund ? '+ Add Fund Report' : '+ Add Stock Report';

  if (SR_lastErr) {
    wrap.innerHTML = subtabs + `<div class="empty-state">Couldn't load reports: ${esc(SR_lastErr)}<br>
      <small>If this mentions permissions, the Firestore rule for the reports subcollection may be missing.</small></div>`;
    wireSubtabs();
    return;
  }

  const inKind = SR_reports.filter(r => (r.type || 'stock') === SR_view.kind);
  const sectors  = [...new Set(inKind.map(r => r.sector).filter(s => s && s !== '—'))].sort();
  const families = [...new Set(inKind.map(r => r.ratingFamily))];
  const rows = srFiltered();
  const arrow = k => SR_view.sortKey === k ? (SR_view.sortDir > 0 ? ' ▲' : ' ▼') : '';

  let tableHtml, cardsHtml;
  if (isFund) {
    tableHtml = `
      <table class="portfolio-table">
        <thead><tr>
          <th class="left sr-sort" data-k="name">Fund / AMC${arrow('name')}</th>
          <th class="left sr-sort" data-k="sector">Category${arrow('sector')}</th>
          <th class="left">Manager</th>
          <th class="left sr-sort" data-k="ratingFamily">Rating${arrow('ratingFamily')}</th>
          <th class="left">Mgr track*</th>
          <th class="left">Status / NAV</th>
          <th></th>
        </tr></thead>
        <tbody>${rows.map(r => `
          <tr class="sr-row" data-id="${esc(r.id)}">
            <td class="left"><div class="sr-tik">${esc(r.name)}</div><div class="sr-sub">${esc(r.amc || '')}</div></td>
            <td class="left">${esc(r.sector)}</td>
            <td class="left">${esc(r.manager || '—')}</td>
            <td class="left">${srRatingBadge(r)}</td>
            <td class="left">${srMgrTrackCell(r)}</td>
            <td class="left">${srFundStatusCell(r)}${srFlags(r)}</td>
            <td class="sr-menu-cell"><button class="sr-menu-btn" data-id="${esc(r.id)}" title="Actions" aria-label="Row actions">⋯</button></td>
          </tr>`).join('')}</tbody>
      </table>`;
    cardsHtml = rows.map(r => `
      <div class="sr-card sr-row" data-id="${esc(r.id)}">
        <div class="sr-card-top"><span class="sr-tik">${esc(r.name)}${srFlags(r)}</span><span class="sr-card-right">${srRatingBadge(r)}<button class="sr-menu-btn" data-id="${esc(r.id)}" title="Actions" aria-label="Row actions">⋯</button></span></div>
        <div class="sr-card-mid">
          <span class="sr-sub">${esc(r.amc || '')} · ${esc(r.sector)} · ${esc(r.manager || '')}</span>
          <span>${srFundStatusCell(r)}</span>
        </div>
        <div class="sr-card-mid"><span class="sr-sub">Mgr track</span><span>${srMgrTrackCell(r)}</span></div>
      </div>`).join('');
  } else {
    tableHtml = `
      <table class="portfolio-table">
        <thead><tr>
          <th class="left sr-sort" data-k="ticker">Ticker${arrow('ticker')}</th>
          <th class="left sr-sort" data-k="name">Name / Sector${arrow('name')}</th>
          <th class="left sr-sort" data-k="ratingFamily">Rating${arrow('ratingFamily')}</th>
          <th class="sr-sort" data-k="genPrice">Gen → Now${arrow('genPrice')}</th>
          <th>Drift</th>
          <th class="left sr-sort" data-k="generatedAt">Report${arrow('generatedAt')}</th>
          <th></th>
        </tr></thead>
        <tbody>${rows.map(r => {
          const d = srDriftCells(r);
          return `<tr class="sr-row" data-id="${esc(r.id)}">
            <td class="left"><span class="sr-tik">${esc(r.ticker)}</span></td>
            <td class="left"><div>${esc(r.name)}</div><div class="sr-sub">${esc(r.sector)}</div></td>
            <td class="left">${srRatingBadge(r)}</td>
            <td>${d.genNow}</td>
            <td>${d.drift}</td>
            <td class="left">${srFmtDate(r.generatedAt)}${srFlags(r)}</td>
            <td class="sr-menu-cell"><button class="sr-menu-btn" data-id="${esc(r.id)}" title="Actions" aria-label="Row actions">⋯</button></td>
          </tr>`;
        }).join('')}</tbody>
      </table>`;
    cardsHtml = rows.map(r => {
      const d = srDriftCells(r);
      return `<div class="sr-card sr-row" data-id="${esc(r.id)}">
        <div class="sr-card-top"><span class="sr-tik">${esc(r.ticker)}${srFlags(r)}</span><span class="sr-card-right">${srRatingBadge(r)}<button class="sr-menu-btn" data-id="${esc(r.id)}" title="Actions" aria-label="Row actions">⋯</button></span></div>
        <div class="sr-card-mid">
          <span class="sr-sub">${esc(r.name)} · ${esc(r.sector)} · ${srFmtDate(r.generatedAt)}</span>
          <span>${d.genNow} ${d.drift}</span>
        </div>
      </div>`;
    }).join('');
  }

  const refreshLabel = isFund ? '⟳ NAV' : '⟳ Prices';
  const asOfLabel = SR_pricesAsOf
    ? 'as of ' + new Date(SR_pricesAsOf).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' }) + (isFund ? ' · AMFI/mfapi.in' : ' · Yahoo Finance (~15 min delay)')
    : '';

  wrap.innerHTML = subtabs + (!inKind.length
    ? `<div class="empty-state">No ${isFund ? 'fund' : 'stock'} reports yet.<br>
        <small>Author one in a Claude chat (${isFund ? 'Fund' : 'Stock'} template v1.1), then click <strong>${isFund ? '+ Add Fund Report' : '+ Add Stock Report'}</strong> to import it.</small></div>`
    : `
    <div class="sr-filterbar">
      <input type="text" id="sr-q" placeholder="${isFund ? 'Search fund, AMC or manager…' : 'Search ticker or name…'}" autocomplete="off" spellcheck="false" value="${esc(SR_view.q)}">
      <select id="sr-sector">
        <option value="">${isFund ? 'All categories' : 'All sectors'}</option>
        ${sectors.map(s => `<option value="${esc(s)}" ${SR_view.sector === s ? 'selected' : ''}>${esc(s)}</option>`).join('')}
      </select>
      <select id="sr-family">
        <option value="">All ratings</option>
        ${families.map(f => `<option value="${esc(f)}" ${SR_view.family === f ? 'selected' : ''}>${SR_FAMILY_LABEL[f] || esc(f)}</option>`).join('')}
      </select>
      <label class="sr-verify-tgl"><input type="checkbox" id="sr-verify" ${SR_view.verifyOnly ? 'checked' : ''}> <span class="sr-dot"></span> verify only</label>
      <button class="btn btn-sm sr-refresh-btn" id="sr-refresh-prices" title="Re-fetch live data">${refreshLabel}</button>
      <span class="sr-asof">${asOfLabel}</span>
    </div>
    ${rows.length ? `<div class="portfolio-table-wrap sr-table-wrap">${tableHtml}</div><div class="sr-cards">${cardsHtml}</div>`
      : '<div class="empty-state">No reports match these filters.</div>'}
  `);

  wireSubtabs();
  if (!inKind.length) return;

  // Filters re-render; search keeps focus + caret position
  const qEl = document.getElementById('sr-q');
  qEl.addEventListener('input', () => {
    SR_view.q = qEl.value;
    const pos = qEl.selectionStart;
    srDrawList(wrap);
    const q2 = document.getElementById('sr-q');
    q2.focus(); q2.setSelectionRange(pos, pos);
  });
  document.getElementById('sr-sector').addEventListener('change', e => { SR_view.sector = e.target.value; srDrawList(wrap); });
  document.getElementById('sr-family').addEventListener('change', e => { SR_view.family = e.target.value; srDrawList(wrap); });
  document.getElementById('sr-verify').addEventListener('change', e => { SR_view.verifyOnly = e.target.checked; srDrawList(wrap); });
  wrap.querySelectorAll('.sr-sort').forEach(th => th.addEventListener('click', () => {
    const k = th.dataset.k;
    if (SR_view.sortKey === k) SR_view.sortDir *= -1; else { SR_view.sortKey = k; SR_view.sortDir = k === 'generatedAt' ? -1 : 1; }
    srDrawList(wrap);
  }));
  document.getElementById('sr-refresh-prices').addEventListener('click', srRefreshPrices);
  wrap.querySelectorAll('.sr-menu-btn').forEach(b => b.addEventListener('click', e => {
    e.stopPropagation();
    srShowRowMenu(b, b.dataset.id);
  }));
  // Row/card body opens the report; the ⋯ button (its own handler) does not
  wrap.querySelectorAll('.sr-row').forEach(el => el.addEventListener('click', e => {
    if (e.target.closest('.sr-menu-btn, .sr-rowmenu')) return;
    srOpenReport(el.dataset.id);
  }));

  // Auto-fetch prices the first time the list is shown after a load
  if (!SR_pricesAsOf && !SR_pricesLoading && SR_reports.length) srRefreshPrices();
}

// ── Row actions menu (⋯) ────────────────────────────────

function srCloseRowMenu() {
  document.querySelector('.sr-rowmenu')?.remove();
  document.removeEventListener('click', srCloseRowMenu);
}

function srShowRowMenu(btn, id) {
  const open = document.querySelector('.sr-rowmenu');
  srCloseRowMenu();
  if (open && open.dataset.id === id) return;   // toggle off
  const r = SR_reports.find(x => x.id === id);
  if (!r) return;
  const menu = document.createElement('div');
  menu.className = 'sr-rowmenu';
  menu.dataset.id = id;
  const hasOverride = !!r.priceOverride;
  const overrideItem = r.type === 'fund' ? '' :
    `<button data-act="override">Price override…<small>${hasOverride ? 'currently set — edit or clear' : 'custom Yahoo symbol or manual price'}</small></button>`;
  menu.innerHTML = `
    <button data-act="open">Open report</button>
    <button data-act="replace">Replace report<small>re-import updated HTML · keeps your note</small></button>
    ${overrideItem}
    <button data-act="note">Edit note</button>
    <button data-act="delete" class="danger">Delete</button>`;
  document.body.appendChild(menu);
  const b = btn.getBoundingClientRect();
  menu.style.top  = `${window.scrollY + b.bottom + 4}px`;
  menu.style.left = `${window.scrollX + Math.min(b.left, window.innerWidth - 230)}px`;
  menu.addEventListener('click', e => {
    const act = e.target.closest('button')?.dataset.act;
    if (!act) return;
    srCloseRowMenu();
    if (act === 'open')     srOpenReport(id);
    if (act === 'replace')  srOpenImportModal(r.ticker);
    if (act === 'override') srOpenOverrideModal(id);
    if (act === 'note')     srOpenNoteEditor(id);
    if (act === 'delete')   srConfirmDelete(id);
  });
  // Defer so this same click doesn't immediately close it
  setTimeout(() => document.addEventListener('click', srCloseRowMenu), 0);
}

// Lightweight note editor (row menu entry) — reuses the viewer note field when open
function srOpenNoteEditor(id) {
  const r = SR_reports.find(x => x.id === id);
  if (!r) return;
  const val = window.prompt(`Note for ${r.ticker} (private, kept on replace):`, r.personalNote || '');
  if (val === null) return;
  srUpdateReport(id, { personalNote: val.trim() }).then(() => { toast('Note saved ✓'); renderStockReports(); })
    .catch(e => toast('Could not save note: ' + e.message));
}

function srConfirmDelete(id) {
  const r = SR_reports.find(x => x.id === id);
  if (!r) return;
  if (!window.confirm(`Delete the ${r.ticker} report? This removes the stored HTML and your note.`)) return;
  srDeleteReport(id).then(() => { toast('Report deleted'); delete SR_prices[id]; if (SR_view.openId === id) SR_view.openId = null; renderStockReports(); })
    .catch(e => toast('Delete failed: ' + e.message));
}

// ── Viewer ──────────────────────────────────────────────

function srOpenReport(id) {
  const r = SR_reports.find(x => x.id === id);
  if (!r) return;
  // Mobile: open the report in its own tab (full-screen, own dark theme)
  if (window.matchMedia('(max-width:700px)').matches) {
    const url = URL.createObjectURL(new Blob([r.html], { type: 'text/html' }));
    window.open(url, '_blank');
    setTimeout(() => URL.revokeObjectURL(url), 60000);
    return;
  }
  SR_view.openId = id;
  renderStockReports();
}

function srCloseViewer() {
  SR_view.openId = null;
  renderStockReports();
}

// Live manager-track panel (funds) — app-rendered from mfapi.in so it's always
// fresh, sitting above the authored report snapshot.
function srFundLivePanel(r) {
  const p = SR_prices[r.id];
  if (!p || !p.fund) return '<div class="sr-fund-live"><div class="sr-fl-hd">Fund manager — track record</div><div class="sr-sub" style="padding:8px 2px">Loading live NAV data…</div></div>';
  const fmt = v => Number.isFinite(v) ? `<span class="${v >= 0 ? 'sr-up' : 'sr-dn'}">${v >= 0 ? '+' : ''}${v.toFixed(1)}%</span>` : '<span class="sr-na">—</span>';
  const rowsHtml = (p.mgr || []).map(m => `
    <tr><td class="left">${esc(m.name)}</td><td>${fmt(m.r1)}</td><td>${fmt(m.r3)}</td><td>${fmt(m.r5)}</td></tr>`).join('');
  const avg = Number.isFinite(p.avg5) ? `${p.avg5.toFixed(1)}% (5Y)` : (Number.isFinite(p.avg3) ? `${p.avg3.toFixed(1)}% (3Y)` : '—');
  return `
    <div class="sr-fund-live">
      <div class="sr-fl-hd">Fund manager — track record <span class="sr-live-chip">LIVE · mfapi.in</span></div>
      <div class="sr-sub" style="margin-bottom:6px">${esc(r.manager || '')}${p.mgr?.length ? ` · trailing CAGR of ${p.mgr.length} existing fund(s) run by this team` : ''}</div>
      ${p.mgr?.length ? `<div class="sr-fl-tablewrap"><table class="sr-fl-table">
        <thead><tr><th class="left">Existing fund</th><th>1Y</th><th>3Y</th><th>5Y</th></tr></thead>
        <tbody>${rowsHtml}</tbody>
      </table></div>
      <div class="sr-fl-foot">Avg across funds: <strong>${avg}</strong> · the fund itself is an NFO with no record yet — you're underwriting the manager.</div>`
      : '<div class="sr-sub">No manager funds listed in this report.</div>'}
    </div>`;
}

function srDrawViewer(wrap, r) {
  const isFund = r.type === 'fund';
  const minis = srFiltered().map(x => `
    <div class="sr-mini ${x.id === r.id ? 'on' : ''}" data-id="${esc(x.id)}">
      <div><span class="sr-tik">${esc(isFund ? x.name : x.ticker)}</span><div class="sr-sub">${esc(x.sector)}</div></div>
      <div class="sr-mini-drift">${isFund ? srMgrTrackCell(x) : srDriftCells(x).drift}</div>
    </div>`).join('');

  const headMetric = isFund
    ? `<span class="sr-viewer-drift">NAV ₹${srFmtPrice(r.genPrice)} → ${srFundStatusCell(r)}</span>`
    : `<span class="sr-viewer-drift">gen ₹${srFmtPrice(r.genPrice)}<span class="sr-arrow">→</span>${srDriftCells(r).drift}</span>`;

  wrap.innerHTML = `
    <div class="sr-split">
      <div class="sr-split-list">${minis}</div>
      <div class="sr-viewer">
        <div class="sr-viewer-hd">
          <button class="btn btn-sm" id="sr-back">← List</button>
          <span class="sr-viewer-name">${esc(r.name)}</span>
          ${srRatingBadge(r)}
          ${headMetric}
          ${srFlags(r)}
          <span class="sr-viewer-spacer"></span>
          <button class="btn btn-sm" id="sr-replace" title="Import an updated HTML — keeps your note">Replace</button>
          <button class="btn btn-sm" id="sr-newtab">Open in new tab ↗</button>
        </div>
        ${isFund ? `<div id="sr-fund-live-slot">${srFundLivePanel(r)}</div>` : ''}
        <iframe class="sr-frame" sandbox="allow-scripts allow-popups" title="Research report: ${esc(r.name)}"></iframe>
        <div class="sr-note">
          <label for="sr-note-input">My note <span class="sr-sub">(private — kept when the report is replaced)</span></label>
          <textarea id="sr-note-input" rows="2" placeholder="e.g. wait for Q1 results before adding…">${esc(r.personalNote || '')}</textarea>
          <button class="btn btn-sm" id="sr-note-save">Save note</button>
        </div>
      </div>
    </div>`;

  // srcdoc via property assignment — avoids HTML-escaping the whole report in the template
  wrap.querySelector('.sr-frame').srcdoc = r.html;

  // If a fund's live data isn't cached yet, fetch it and refresh just the panel.
  if (isFund && !SR_prices[r.id]) {
    srFetchFundData(r).then(d => {
      SR_prices[r.id] = d;
      const slot = document.getElementById('sr-fund-live-slot');
      if (slot && SR_view.openId === r.id) slot.innerHTML = srFundLivePanel(r);
    });
  }

  document.getElementById('sr-back').addEventListener('click', srCloseViewer);
  document.getElementById('sr-replace').addEventListener('click', () => srOpenImportModal(r.ticker));
  document.getElementById('sr-newtab').addEventListener('click', () => {
    const url = URL.createObjectURL(new Blob([r.html], { type: 'text/html' }));
    window.open(url, '_blank');
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  });
  document.getElementById('sr-note-save').addEventListener('click', async () => {
    const val = document.getElementById('sr-note-input').value.trim();
    try {
      await srUpdateReport(r.id, { personalNote: val });
      toast('Note saved ✓');
    } catch (e) { toast('Could not save note: ' + e.message); }
  });
  wrap.querySelectorAll('.sr-mini').forEach(el => el.addEventListener('click', () => {
    if (el.dataset.id !== r.id) srOpenReport(el.dataset.id);
  }));
}

// ── Import modal ────────────────────────────────────────

let SR_impHtml   = null;   // current candidate HTML (validated)
let SR_impMeta   = null;   // its parsed meta
let SR_impExpect = null;   // ticker expected (Replace flow from viewer) or null

function srImpPreviewEl() { return document.getElementById('sr-imp-preview'); }

function srImpReset() {
  SR_impHtml = null; SR_impMeta = null;
  srImpPreviewEl().innerHTML = '';
  document.getElementById('sr-imp-save').disabled = true;
  document.getElementById('sr-paste').value = '';
  document.getElementById('sr-file').value = '';
  document.getElementById('sr-drop-name').textContent = 'accepts a single .html file';
}

function srOpenImportModal(expectTicker) {
  SR_impExpect = expectTicker || null;
  document.getElementById('sr-imp-title').textContent =
    SR_impExpect ? `Replace report — ${SR_impExpect}` : 'Add Report';
  srImpReset();
  document.getElementById('sr-import-modal').style.display = 'flex';
}

function srCloseImportModal() {
  document.getElementById('sr-import-modal').style.display = 'none';
}

// Validate candidate HTML and show the parsed-meta preview
function srImpCandidate(html, sourceLabel) {
  const box = srImpPreviewEl();
  const saveBtn = document.getElementById('sr-imp-save');
  SR_impHtml = null; SR_impMeta = null;
  saveBtn.disabled = true;

  const parsed = srParseReportHtml(html);
  if (!parsed.ok) {
    box.innerHTML = `<div class="sr-imp-box sr-imp-err">✕ ${esc(parsed.error)}</div>`;
    return;
  }
  const m = parsed.meta;
  if (SR_impExpect && m.ticker !== SR_impExpect) {
    box.innerHTML = `<div class="sr-imp-box sr-imp-err">✕ This report is for <strong>${esc(m.ticker)}</strong>, but you're replacing <strong>${esc(SR_impExpect)}</strong>. Use + Add Report for a new ticker.</div>`;
    return;
  }
  SR_impHtml = html; SR_impMeta = m;
  const existing = SR_reports.find(r => r.id === m.ticker.toLowerCase());
  const isFund = m.type === 'fund';
  const metaRows = isFund ? `
        <tr><td>Fund</td><td><strong>${esc(m.name)}</strong></td></tr>
        <tr><td>AMC / Category</td><td>${esc(m.amc || '—')} · ${esc(m.sector)}</td></tr>
        <tr><td>Manager</td><td>${esc(m.manager || '—')}</td></tr>
        <tr><td>Rating</td><td>${srRatingBadge(m)}</td></tr>
        <tr><td>NFO NAV / scheme</td><td>₹${srFmtPrice(m.genPrice)} · ${m.scheme ? 'AMFI ' + esc(m.scheme) : 'NFO (no code yet)'}</td></tr>
        <tr><td>Manager funds (live)</td><td>${m.managerFunds?.length ? m.managerFunds.length + ' scheme code(s) → live returns' : 'none'}</td></tr>
        <tr><td>Data gaps</td><td>${m.hasGaps ? 'yes — will show the <span class="sr-dot"></span> verify dot' : 'none flagged'}</td></tr>`
    : `
        <tr><td>Ticker</td><td><strong>${esc(m.ticker)}</strong> · ${esc(m.exchange)}</td></tr>
        <tr><td>Name</td><td>${esc(m.name)}</td></tr>
        <tr><td>Sector</td><td>${esc(m.sector)}</td></tr>
        <tr><td>Rating</td><td>${srRatingBadge(m)}</td></tr>
        <tr><td>Generated</td><td>${srFmtDate(m.generatedAt)} · gen price ₹${srFmtPrice(m.genPrice)}</td></tr>
        <tr><td>Data gaps</td><td>${m.hasGaps ? 'yes — will show the <span class="sr-dot"></span> verify dot' : 'none flagged'}</td></tr>`;
  box.innerHTML = `
    <div class="sr-imp-box sr-imp-ok">
      <div class="sr-imp-okhdr">✓ Valid ${isFund ? 'fund' : 'stock'} report${sourceLabel ? ' · ' + esc(sourceLabel) : ''}</div>
      <table class="sr-imp-meta">${metaRows}</table>
    </div>
    ${existing ? `<div class="sr-imp-box sr-imp-warn"><strong>Replace mode:</strong> a report for <strong>${esc(existing.name)}</strong> from ${srFmtDate(existing.generatedAt)} already exists. Saving updates the report — your personal note is kept.</div>` : ''}`;
  saveBtn.disabled = false;
}

function srInitImportUI() {
  const modal = document.getElementById('sr-import-modal');
  if (!modal) return;

  document.getElementById('btn-add-report')?.addEventListener('click', () => srOpenImportModal(null));
  document.getElementById('sr-imp-cancel').addEventListener('click', srCloseImportModal);
  modal.addEventListener('click', e => { if (e.target === modal) srCloseImportModal(); });

  // Upload / Paste mode switch
  modal.querySelectorAll('.sr-imp-tab').forEach(btn => btn.addEventListener('click', () => {
    modal.querySelectorAll('.sr-imp-tab').forEach(b => b.classList.toggle('active', b === btn));
    const paste = btn.dataset.mode === 'paste';
    document.getElementById('sr-imp-upload').style.display = paste ? 'none' : '';
    document.getElementById('sr-imp-paste').style.display  = paste ? '' : 'none';
  }));

  // File pick + drag-drop
  const drop = document.getElementById('sr-drop');
  const file = document.getElementById('sr-file');
  const readFile = f => {
    if (!f) return;
    document.getElementById('sr-drop-name').textContent = f.name;
    const rd = new FileReader();
    rd.onload = () => srImpCandidate(String(rd.result), f.name);
    rd.readAsText(f);
  };
  drop.addEventListener('click', () => file.click());
  file.addEventListener('change', () => readFile(file.files[0]));
  drop.addEventListener('dragover', e => { e.preventDefault(); drop.classList.add('over'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('over'));
  drop.addEventListener('drop', e => {
    e.preventDefault(); drop.classList.remove('over');
    readFile(e.dataTransfer.files?.[0]);
  });

  // Paste — validate as they type (debounced)
  let pt;
  document.getElementById('sr-paste').addEventListener('input', e => {
    clearTimeout(pt);
    pt = setTimeout(() => srImpCandidate(e.target.value, 'pasted'), 300);
  });

  // Save
  document.getElementById('sr-imp-save').addEventListener('click', async () => {
    if (!SR_impHtml) return;
    const btn = document.getElementById('sr-imp-save');
    btn.disabled = true; btn.textContent = 'Saving…';
    try {
      const { id, replaced } = await srImportReport(SR_impHtml);
      srCloseImportModal();
      toast(replaced ? 'Report replaced ✓' : 'Report added ✓');
      srOpenReport(id);                    // list + open, per the flow
    } catch (e) {
      toast('Import failed: ' + e.message);
      console.warn('Report import failed', e);
    } finally {
      btn.disabled = false; btn.textContent = 'Save report';
    }
  });
}

// ── Price override modal (SME fallback) ─────────────────

let SR_ovId = null;

function srOpenOverrideModal(id) {
  const r = SR_reports.find(x => x.id === id);
  if (!r) return;
  SR_ovId = id;
  const ov = r.priceOverride || {};
  const modal = document.getElementById('sr-ov-modal');
  document.getElementById('sr-ov-title').textContent = `Price override — ${r.ticker}`;
  const mode = Number.isFinite(ov.price) ? 'manual' : 'symbol';
  modal.querySelector(`input[name="sr-ov-mode"][value="${mode}"]`).checked = true;
  document.getElementById('sr-ov-symbol').value = ov.symbol || '';
  document.getElementById('sr-ov-price').value  = Number.isFinite(ov.price) ? ov.price : '';
  document.getElementById('sr-ov-asof').value   = ov.asOf && /^\d{4}-\d{2}-\d{2}$/.test(ov.asOf) ? ov.asOf : new Date().toISOString().slice(0, 10);
  document.getElementById('sr-ov-clear').style.display = r.priceOverride ? '' : 'none';
  srOvSyncMode();
  modal.style.display = 'flex';
}

function srOvSyncMode() {
  const manual = document.querySelector('input[name="sr-ov-mode"]:checked')?.value === 'manual';
  document.getElementById('sr-ov-symbol-row').style.display = manual ? 'none' : '';
  document.getElementById('sr-ov-manual-row').style.display = manual ? '' : 'none';
}

function srInitOverrideUI() {
  const modal = document.getElementById('sr-ov-modal');
  if (!modal) return;
  modal.addEventListener('click', e => { if (e.target === modal) modal.style.display = 'none'; });
  document.getElementById('sr-ov-cancel').addEventListener('click', () => modal.style.display = 'none');
  modal.querySelectorAll('input[name="sr-ov-mode"]').forEach(el => el.addEventListener('change', srOvSyncMode));

  document.getElementById('sr-ov-clear').addEventListener('click', async () => {
    if (!SR_ovId) return;
    await srUpdateReport(SR_ovId, { priceOverride: null });
    modal.style.display = 'none';
    toast('Override cleared');
    delete SR_prices[SR_ovId];
    SR_prices[SR_ovId] = await srFetchReportPrice(SR_reports.find(r => r.id === SR_ovId));
    renderStockReports();
  });

  document.getElementById('sr-ov-save').addEventListener('click', async () => {
    if (!SR_ovId) return;
    const manual = document.querySelector('input[name="sr-ov-mode"]:checked').value === 'manual';
    let override;
    if (manual) {
      const price = parseFloat(document.getElementById('sr-ov-price').value);
      if (!Number.isFinite(price) || price <= 0) { toast('Enter a valid price'); return; }
      override = { price, asOf: document.getElementById('sr-ov-asof').value || null };
    } else {
      const symbol = document.getElementById('sr-ov-symbol').value.trim();
      if (!symbol) { toast('Enter a Yahoo symbol (e.g. AIMTRON.NS)'); return; }
      override = { symbol };
    }
    await srUpdateReport(SR_ovId, { priceOverride: override });
    modal.style.display = 'none';
    SR_prices[SR_ovId] = await srFetchReportPrice(SR_reports.find(r => r.id === SR_ovId));
    toast('Override saved ✓');
    renderStockReports();
  });
}

// ── Cross-link into the Stocks tab ──────────────────────
// Lets the Stocks holdings table show a "research" pill for any ticker we
// hold a report on, linking straight into the viewer. Kept dependency-free:
// portfolio.js only calls these if they exist.

let SR_ensureStarted = false;

// Load reports once in the background (e.g. when Stocks renders before the
// Reports tab was ever opened), then run onLoaded exactly once.
function srEnsureReportsLoaded(onLoaded) {
  if (SR_loaded || SR_ensureStarted) return;
  SR_ensureStarted = true;
  srLoadReports().then(() => { if (onLoaded) onLoaded(); });
}

function srReportFor(symbol) {
  if (!symbol) return null;
  const t = String(symbol).toUpperCase();
  return SR_reports.find(r => r.ticker === t) || null;
}

// Small pill for the Stocks table; '' when no report exists for that symbol.
function srCrossLinkBadge(symbol) {
  const r = srReportFor(symbol);
  if (!r) return '';
  return ` <span class="sr-xlink sr-badge-${esc(r.ratingFamily)}" onclick="event.stopPropagation();srGotoReport('${esc(r.id)}')" title="Open research report — ${esc(r.rating)}">▤ research</span>`;
}

// Switch to the Reports tab and open a specific report.
function srGotoReport(id) {
  if (typeof window._switchTab === 'function') window._switchTab('reports');
  SR_view.openId = id;
  renderStockReports();
}

// ── Public API ──────────────────────────────────────────

function initStockReports() {
  // Data loads lazily on first tab open (keeps boot fast); nothing to hydrate
  // from the main dashboard doc — reports live in their own subcollection.
  srInitImportUI();
  srInitOverrideUI();
}

function renderStockReports() {
  const wrap = document.getElementById('sr-content');
  if (!wrap) return;
  const draw = () => {
    const open = SR_view.openId && SR_reports.find(x => x.id === SR_view.openId);
    if (open) srDrawViewer(wrap, open); else { SR_view.openId = null; srDrawList(wrap); }
  };
  if (SR_loaded) { draw(); return; }
  wrap.innerHTML = '<div class="empty-state">Loading…</div>';
  srLoadReports().then(draw);
}

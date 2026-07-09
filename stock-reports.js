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
// so "Avoid — do not buy" lands in the avoid family.
function srRatingFamily(rating) {
  const r = String(rating || '').toLowerCase();
  if (/\bavoid\b|\bsell\b|\bexit\b/.test(r))                return 'avoid';
  if (/speculat/.test(r))                                   return 'speculative';
  if (/\bwatch\b|\bhold\b|priced.for.perfection|neutral/.test(r)) return 'watch';
  if (/accumulate/.test(r))                                 return 'accumulate';
  if (/\bbuy\b/.test(r))                                    return 'buy';
  return 'watch';
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

  const ticker = meta('ticker').toUpperCase();
  if (!ticker) return { ok: false, error: 'Not a v1.1 research report — missing <meta name="ticker">.' };

  const generated = meta('generated');
  const priceRaw  = meta('price').replace(/[₹,\s]/g, '');
  const genPrice  = parseFloat(priceRaw);
  if (!generated) return { ok: false, error: 'Report is missing <meta name="generated"> (generation date).' };
  if (!Number.isFinite(genPrice)) return { ok: false, error: 'Report is missing a numeric <meta name="price">.' };

  // Company name: prefer explicit meta, else <title>, else first <h1>
  const name = meta('name') || meta('company')
    || (doc.querySelector('title')?.textContent || '').split(/[|—–-]/)[0].trim()
    || doc.querySelector('h1')?.textContent?.trim()
    || ticker;

  const rating = meta('rating') || 'Unrated';
  // hasGaps: explicit meta wins; else detect the template's verify markers
  const gapsMeta = meta('hasgaps') || meta('has-gaps') || meta('gaps');
  const hasGaps  = gapsMeta
    ? /^(true|yes|1)$/i.test(gapsMeta)
    : /data-verify|class="verify|⚠ verify/i.test(html);

  return {
    ok: true,
    meta: {
      ticker,
      exchange: (meta('exchange') || 'NSE').toUpperCase(),
      name,
      sector: meta('sector') || '—',
      rating,
      ratingFamily: srRatingFamily(rating),
      genPrice,
      generatedAt: generated,       // ISO yyyy-mm-dd as authored
      hasGaps,
    },
  };
}

// ── CRUD ────────────────────────────────────────────────

async function srLoadReports() {
  try {
    const snap = await srColl().get();
    SR_reports = snap.docs.map(d => ({ id: d.id, ...d.data() }));
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

// ── Public API ──────────────────────────────────────────

function initStockReports() {
  // Data loads lazily on first tab open (keeps boot fast); nothing to hydrate
  // from the main dashboard doc — reports live in their own subcollection.
}

function renderStockReports() {
  const wrap = document.getElementById('sr-content');
  if (!wrap) return;
  const draw = () => {
    if (SR_lastErr) {
      wrap.innerHTML = `<div class="empty-state">Couldn't load reports: ${esc(SR_lastErr)}<br>
        <small>If this mentions permissions, the Firestore rule for the reports subcollection may be missing.</small></div>`;
      return;
    }
    if (!SR_reports.length) {
      wrap.innerHTML = `<div class="empty-state">No reports yet.<br>
        <small>Generate a report in a Claude research chat (template v1.1), then import its HTML here.</small></div>`;
      return;
    }
    // Phase 3 placeholder list — full table UI lands in phase 4
    wrap.innerHTML = `<div class="empty-state">${SR_reports.length} report(s) loaded — list UI coming in the next phase.</div>`;
  };
  if (SR_loaded) { draw(); return; }
  wrap.innerHTML = '<div class="empty-state">Loading…</div>';
  srLoadReports().then(draw);
}

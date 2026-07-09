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

// ── View state ──────────────────────────────────────────

let SR_view = { q: '', sector: '', family: '', verifyOnly: false, sortKey: 'generatedAt', sortDir: -1, openId: null };

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

// Live prices land in phase 6 (Yahoo proxy). Until then this returns null → "—".
function srLivePrice(r) {
  return null;
}

function srDriftCells(r) {
  const live = srLivePrice(r);
  const gen  = `<span class="sr-gen">${srFmtPrice(r.genPrice)}</span>`;
  if (live == null) return { genNow: `${gen}<span class="sr-arrow">→</span><span class="sr-na">—</span>`, drift: '<span class="sr-na">—</span>' };
  const pct = ((live - r.genPrice) / r.genPrice) * 100;
  const cls = pct >= 0 ? 'sr-up' : 'sr-dn';
  return {
    genNow: `${gen}<span class="sr-arrow">→</span><span class="sr-now">${srFmtPrice(live)}</span>`,
    drift: `<span class="${cls}">${pct >= 0 ? '+' : ''}${pct.toFixed(1)}%</span>`,
  };
}

function srFiltered() {
  const q = SR_view.q.trim().toLowerCase();
  let rows = SR_reports.filter(r =>
    (!q || r.ticker.toLowerCase().includes(q) || String(r.name).toLowerCase().includes(q)) &&
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
  if (SR_lastErr) {
    wrap.innerHTML = `<div class="empty-state">Couldn't load reports: ${esc(SR_lastErr)}<br>
      <small>If this mentions permissions, the Firestore rule for the reports subcollection may be missing.</small></div>`;
    return;
  }
  if (!SR_reports.length) {
    wrap.innerHTML = `<div class="empty-state">No reports yet.<br>
      <small>Generate a report in a Claude research chat (template v1.1), then click <strong>+ Add Report</strong> to import its HTML.</small></div>`;
    return;
  }

  const sectors  = [...new Set(SR_reports.map(r => r.sector).filter(s => s && s !== '—'))].sort();
  const families = [...new Set(SR_reports.map(r => r.ratingFamily))];
  const rows = srFiltered();
  const arrow = k => SR_view.sortKey === k ? (SR_view.sortDir > 0 ? ' ▲' : ' ▼') : '';

  const desktopRows = rows.map(r => {
    const d = srDriftCells(r);
    return `<tr class="sr-row" data-id="${esc(r.id)}">
      <td class="left"><span class="sr-tik">${esc(r.ticker)}</span></td>
      <td class="left"><div>${esc(r.name)}</div><div class="sr-sub">${esc(r.sector)}</div></td>
      <td class="left">${srRatingBadge(r)}</td>
      <td>${d.genNow}</td>
      <td>${d.drift}</td>
      <td class="left">${srFmtDate(r.generatedAt)}${srFlags(r)}</td>
    </tr>`;
  }).join('');

  const cards = rows.map(r => {
    const d = srDriftCells(r);
    return `<div class="sr-card sr-row" data-id="${esc(r.id)}">
      <div class="sr-card-top"><span class="sr-tik">${esc(r.ticker)}${srFlags(r)}</span>${srRatingBadge(r)}</div>
      <div class="sr-card-mid">
        <span class="sr-sub">${esc(r.name)} · ${esc(r.sector)} · ${srFmtDate(r.generatedAt)}</span>
        <span>${d.genNow} ${d.drift}</span>
      </div>
    </div>`;
  }).join('');

  wrap.innerHTML = `
    <div class="sr-filterbar">
      <input type="text" id="sr-q" placeholder="Search ticker or name…" autocomplete="off" spellcheck="false" value="${esc(SR_view.q)}">
      <select id="sr-sector">
        <option value="">All sectors</option>
        ${sectors.map(s => `<option value="${esc(s)}" ${SR_view.sector === s ? 'selected' : ''}>${esc(s)}</option>`).join('')}
      </select>
      <select id="sr-family">
        <option value="">All ratings</option>
        ${families.map(f => `<option value="${esc(f)}" ${SR_view.family === f ? 'selected' : ''}>${SR_FAMILY_LABEL[f] || esc(f)}</option>`).join('')}
      </select>
      <label class="sr-verify-tgl"><input type="checkbox" id="sr-verify" ${SR_view.verifyOnly ? 'checked' : ''}> <span class="sr-dot"></span> verify only</label>
    </div>
    ${rows.length ? `
    <div class="portfolio-table-wrap sr-table-wrap">
      <table class="portfolio-table">
        <thead><tr>
          <th class="left sr-sort" data-k="ticker">Ticker${arrow('ticker')}</th>
          <th class="left sr-sort" data-k="name">Name / Sector${arrow('name')}</th>
          <th class="left sr-sort" data-k="ratingFamily">Rating${arrow('ratingFamily')}</th>
          <th class="sr-sort" data-k="genPrice">Gen → Now${arrow('genPrice')}</th>
          <th>Drift</th>
          <th class="left sr-sort" data-k="generatedAt">Report${arrow('generatedAt')}</th>
        </tr></thead>
        <tbody>${desktopRows}</tbody>
      </table>
    </div>
    <div class="sr-cards">${cards}</div>`
    : '<div class="empty-state">No reports match these filters.</div>'}
  `;

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
  wrap.querySelectorAll('.sr-row').forEach(el => el.addEventListener('click', () => srOpenReport(el.dataset.id)));
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

function srDrawViewer(wrap, r) {
  const d = srDriftCells(r);
  const minis = srFiltered().map(x => `
    <div class="sr-mini ${x.id === r.id ? 'on' : ''}" data-id="${esc(x.id)}">
      <div><span class="sr-tik">${esc(x.ticker)}</span><div class="sr-sub">${esc(x.sector)}</div></div>
      <div class="sr-mini-drift">${srDriftCells(x).drift}</div>
    </div>`).join('');

  wrap.innerHTML = `
    <div class="sr-split">
      <div class="sr-split-list">${minis}</div>
      <div class="sr-viewer">
        <div class="sr-viewer-hd">
          <button class="btn btn-sm" id="sr-back">← List</button>
          <span class="sr-viewer-name">${esc(r.name)}</span>
          ${srRatingBadge(r)}
          <span class="sr-viewer-drift">gen ₹${srFmtPrice(r.genPrice)}<span class="sr-arrow">→</span>${d.drift}</span>
          ${srFlags(r)}
          <span class="sr-viewer-spacer"></span>
          <button class="btn btn-sm" id="sr-newtab">Open in new tab ↗</button>
        </div>
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

  document.getElementById('sr-back').addEventListener('click', srCloseViewer);
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

// ── Public API ──────────────────────────────────────────

function initStockReports() {
  // Data loads lazily on first tab open (keeps boot fast); nothing to hydrate
  // from the main dashboard doc — reports live in their own subcollection.
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

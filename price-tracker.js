// ════════════════════════════════════════════════════════
//  PRICE TRACKER MODULE
//  Polls TradingView scanner (fallback: Yahoo Finance) every 2.5 s for
//  XAU/USD, XAG/USD, and USD/INR.  Computes India import landed prices
//  (BCD 5% + AIDC 1% = 6% on CIF) and writes:
//    LIVE.goldRate   = 24K landed ₹/g
//    LIVE.silverRate = 999 landed ₹/g
//  Also re-renders the Gold / Silver tabs if currently active.
// ════════════════════════════════════════════════════════

const PT_TROY   = 31.1035;
const PT_MS     = 2500;
const PT_DUTY   = 0.06;
const PT_PROXY  = 'https://damp-bar-b442ok.r24rp9hgxh.workers.dev';
const PT_TV     = 'https://scanner.tradingview.com/symbol';

const PT_CFG = {
  gold:   {
    tvSym: 'OANDA:XAUUSD', yfTick: 'GC=F',  apiLabel: 'XAU/USD',
    srcPrimary:  'OANDA:XAUUSD · OANDA XAU/USD via TradingView scanner. Unofficial API.',
    srcFallback: 'Yahoo Finance GC=F · COMEX Gold Futures (fallback).',
    grades: [{ label:'24K', f:1 }, { label:'22K', f:22/24 }, { label:'18K', f:18/24 }],
    liveKey: 'goldRate',
    cssColor: 'var(--pt-gold)',
  },
  silver: {
    tvSym: 'TVC:SILVER',   yfTick: 'SI=F',   apiLabel: 'XAG/USD',
    srcPrimary:  'TVC:SILVER · XAG/USD silver index via TradingView scanner. Unofficial API.',
    srcFallback: 'Yahoo Finance SI=F · COMEX Silver Futures (fallback).',
    grades: [{ label:'999', f:1 }, { label:'950', f:0.950 }, { label:'925', f:0.925 }],
    liveKey: 'silverRate',
    cssColor: 'var(--pt-silver)',
  },
};

// Module state — prefixed PT_ to avoid clashing with portfolio.js globals
let PT_mode      = 'gold';   // 'gold' | 'silver'
let PT_timer     = null;
let PT_cache     = { gold: null, silver: null, inr: null };
let PT_ticks     = 0;
let PT_t0        = Date.now();
let PT_lastErr   = null;

// ── Low-level fetchers ──────────────────────────────────

async function ptTv(symbol) {
  const url = `${PT_TV}?symbol=${encodeURIComponent(symbol)}&fields=close%2Cchange%2Cchange_abs&no_404=1`;
  const r = await fetch(url, { cache: 'no-store' });
  if (!r.ok) throw new Error(`TV ${symbol} ${r.status}`);
  const d = await r.json();
  if (d.close == null) throw new Error(`TV ${symbol}: no data`);
  return { price: d.close, changeAbs: d.change_abs ?? null, changePct: d.change ?? null };
}

async function ptYf(ticker) {
  const yUrl = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?interval=1d&range=5d`;
  const r = await fetch(`${PT_PROXY}?url=${encodeURIComponent(yUrl)}`, { cache: 'no-store' });
  if (!r.ok) throw new Error(`YF ${ticker} ${r.status}`);
  const d    = await r.json();
  const meta = d?.chart?.result?.[0]?.meta;
  if (!meta?.regularMarketPrice) throw new Error(`YF ${ticker}: no price`);
  const price = meta.regularMarketPrice;
  const prev  = meta.chartPreviousClose ?? meta.previousClose ?? null;
  return {
    price,
    changeAbs: prev ? price - prev : null,
    changePct: prev ? ((price - prev) / prev) * 100 : null,
  };
}

async function ptFetchMetal(cfg) {
  try {
    const d = await ptTv(cfg.tvSym);
    return { ...d, src: cfg.srcPrimary };
  } catch(e) { console.warn('PT:', e.message); }
  const d = await ptYf(cfg.yfTick);
  return { ...d, src: cfg.srcFallback };
}

async function ptFetchInr() {
  try   { return await ptTv('FX_IDC:USDINR'); }
  catch { return await ptYf('USDINR=X'); }
}

// ── Calculations ────────────────────────────────────────

function ptLanded(metalUsd, usdInr, cfg) {
  const perGram = (metalUsd * usdInr) / PT_TROY;
  return cfg.grades.map(g => ({ label: g.label, price: perGram * g.f * (1 + PT_DUTY) }));
}

// ── Formatters (pt-scoped to avoid conflicts) ───────────

function ptInr(n, dec = 0) {
  return '₹' + n.toLocaleString('en-IN', { minimumFractionDigits: dec, maximumFractionDigits: dec });
}

function ptUsd(n, dec = 0) {
  return '$' + n.toLocaleString('en-US', { minimumFractionDigits: dec, maximumFractionDigits: dec });
}

function ptChg(abs, pct, pfx = '') {
  if (abs == null || pct == null) return '';
  const cls  = abs >= 0 ? 'pt-pos' : 'pt-neg';
  const sign = abs >= 0 ? '+' : '−';
  const ap   = Math.round(Math.abs(abs)).toLocaleString();
  const pp   = (pct >= 0 ? '+' : '') + pct.toFixed(2) + '%';
  return `<span class="${cls}">${sign}${pfx}${ap} · ${pp}</span>`;
}

// ── Poll ────────────────────────────────────────────────

async function ptPoll() {
  try {
    const [gold, silver, inr] = await Promise.all([
      ptFetchMetal(PT_CFG.gold),
      ptFetchMetal(PT_CFG.silver),
      ptFetchInr(),
    ]);

    PT_cache.gold   = gold;
    PT_cache.silver = silver;
    PT_cache.inr    = inr;
    PT_ticks++;
    PT_lastErr = null;

    // ── Feed Gold / Silver tabs ──
    LIVE.goldRate   = ptLanded(gold.price,   inr.price, PT_CFG.gold)[0].price;   // 24K
    LIVE.silverRate = ptLanded(silver.price, inr.price, PT_CFG.silver)[0].price; // 999

    // Re-render those tabs if currently visible
    if (document.getElementById('tab-gold')?.classList.contains('active'))   renderGold();
    if (document.getElementById('tab-silver')?.classList.contains('active')) renderSilver();

    // Re-render tracker tab if visible
    if (document.getElementById('tab-prices')?.classList.contains('active')) ptDraw();

  } catch(e) {
    PT_lastErr = e.message;
    console.error('Price tracker poll error:', e);
    if (document.getElementById('tab-prices')?.classList.contains('active')) ptDraw();
  }
}

// ── Draw tracker card ───────────────────────────────────

function ptDraw() {
  const wrap = document.getElementById('pt-content');
  if (!wrap) return;

  const cfg    = PT_CFG[PT_mode];
  const metal  = PT_cache[PT_mode];
  const inr    = PT_cache.inr;
  const isGold = PT_mode === 'gold';

  const timeStr = new Date().toLocaleTimeString('en-IN', { hour12: true });
  const avgTick = PT_ticks > 1
    ? ((Date.now() - PT_t0) / PT_ticks / 1000).toFixed(1)
    : (PT_MS / 1000).toFixed(1);

  const dotCls    = PT_lastErr ? 'pt-dot pt-dot-err' : 'pt-dot pt-dot-live';
  const statusMsg = PT_lastErr
    ? `Error · ${timeStr} · ${PT_lastErr}`
    : `Live ${isGold ? 'XAU' : 'XAG'} + USD/INR (poll) · ${timeStr} · ~${avgTick}s tick`;

  const landedHTML = (metal && inr)
    ? ptLanded(metal.price, inr.price, cfg).map(r =>
        `<div class="pt-lr">
          <span class="pt-karat">${r.label}</span>
          <span class="pt-lprice">${ptInr(r.price)}/g</span>
        </div>`).join('')
    : `<div class="pt-lr"><span class="pt-karat">—</span><span class="pt-lprice">Loading…</span></div>`;

  wrap.innerHTML = `
    <div class="pt-card">
      <div class="pt-hdr">
        <div>
          <div class="pt-title">${isGold ? 'Gold' : 'Silver'} price tracker</div>
          <div class="pt-sub">Live ${isGold ? 'XAU' : 'XAG'}/USD + USD/INR · India import landed</div>
        </div>
        <label class="pt-toggle" title="Switch Gold / Silver">
          <input type="checkbox" id="pt-tog" ${isGold ? 'checked' : ''}>
          <span class="pt-tog-slider"></span>
        </label>
      </div>

      <div class="pt-status"><span class="${dotCls}"></span>${statusMsg}</div>

      <!-- ① Landed prices — hero section -->
      <div class="pt-import">
        <div class="pt-imp-hdr">₹ / g · India Import Landed</div>
        <div class="pt-imp-rows">${landedHTML}</div>
        <div class="pt-imp-duty">BCD 5.00% + AIDC 1.00% → 6.00% on CIF</div>
      </div>

      <!-- ② USD/INR — compact card -->
      <div class="pt-pc pt-pc-sm">
        <div class="pt-pc-lbl">USD / INR</div>
        <div class="pt-pc-val pt-pc-val-sm">${inr ? ptInr(inr.price, 2) + ' / $1' : '—'}</div>
        <div class="pt-pc-chg">${inr ? ptChg(inr.changeAbs, inr.changePct) : ''}</div>
      </div>

      <!-- ③ XAU/USD — small footer line -->
      <div class="pt-metal-footer">
        <span class="pt-metal-footer-lbl">${cfg.apiLabel}</span>
        <span class="pt-metal-footer-val" style="color:${cfg.cssColor}">${metal ? ptUsd(metal.price) + ' / tr oz' : '—'}</span>
        <span class="pt-metal-footer-chg">${metal ? ptChg(metal.changeAbs, metal.changePct, '$') : ''}</span>
        <span class="pt-metal-footer-src">${metal?.src ?? ''}</span>
      </div>

      <details class="pt-method">
        <summary>Methodology</summary>
        <div class="pt-method-body">
          <p><strong>Gold</strong> — OANDA:XAUUSD via TradingView CFD scanner; fallback Yahoo GC=F.
             <strong>Silver</strong> — TVC:SILVER via TradingView scanner (XAG/silver index); fallback Yahoo SI=F.</p>
          <p><strong>USD/INR</strong> — FX_IDC:USDINR via TradingView scanner; fallback Yahoo USDINR=X.</p>
          <p>India duty defaults: gold &amp; silver each <strong>5% BCD + 1% AIDC</strong> on CIF.
             Landed prices feed the Gold &amp; Silver holding tabs. Polls every ~2.5 s. Illustrative only. 1 troy oz = 31.1035 g.</p>
        </div>
      </details>
    </div>`;

  // Re-attach toggle (innerHTML nukes old listeners)
  document.getElementById('pt-tog')?.addEventListener('change', e => {
    PT_mode = e.target.checked ? 'gold' : 'silver';
    ptDraw();
  });
}

// ── Public API ──────────────────────────────────────────

function renderPriceTracker() {
  const wrap = document.getElementById('pt-content');
  if (!wrap) return;
  if (PT_cache.gold) { ptDraw(); return; }
  wrap.innerHTML = '<div style="padding:32px;text-align:center;color:var(--text3)">Connecting…</div>';
}

function initPriceTracker() {
  PT_t0 = Date.now();
  ptPoll();                             // immediate first tick
  PT_timer = setInterval(ptPoll, PT_MS);
}

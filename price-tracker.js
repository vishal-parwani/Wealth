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
const PT_PROXY  = 'https://damp-bar-b442ok.r24rp9hgxh.workers.dev';
const PT_TV     = 'https://scanner.tradingview.com/symbol';
const PT_DUTY_DEFAULT = {
  gold:   { bcd: 5, aidc: 1, gst: 3 },
  silver: { bcd: 5, aidc: 1, gst: 3 },
};

function ptPickDuty(p) {
  const pick = (v, d) => Number.isFinite(+v) ? +v : d;
  return {
    gold:   { bcd: pick(p?.gold?.bcd,   5), aidc: pick(p?.gold?.aidc,   1), gst: pick(p?.gold?.gst,   3) },
    silver: { bcd: pick(p?.silver?.bcd, 5), aidc: pick(p?.silver?.aidc, 1), gst: pick(p?.silver?.gst, 3) },
  };
}

function ptInitSettings(allData) {
  const saved = allData?.price_settings;
  if (saved?.duty) {
    PT_duty  = ptPickDuty(saved.duty);
    PT_gstOn = saved.gstOn !== undefined ? !!saved.gstOn : true;
  } else {
    // Migrate from localStorage if present, then clear
    try {
      const raw = localStorage.getItem('pt_duty_v1');
      if (raw) { PT_duty = ptPickDuty(JSON.parse(raw)); localStorage.removeItem('pt_duty_v1'); }
      const gst = localStorage.getItem('pt_gst_on_v1');
      if (gst !== null) { PT_gstOn = gst === '1'; localStorage.removeItem('pt_gst_on_v1'); }
    } catch {}
    ptSaveSettings();
  }
}

function ptSaveSettings() {
  saveSection('price_settings', { duty: PT_duty, gstOn: PT_gstOn });
}

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
let PT_duty      = structuredClone(PT_DUTY_DEFAULT);
let PT_gstOn     = true;
let PT_settingsOpen = false;
let PT_methodOpen   = false;

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

function ptDutyFactor(mode) {
  const d = PT_duty[mode] || { bcd: 0, aidc: 0, gst: 0 };
  const customs = 1 + (Number(d.bcd) || 0) / 100 + (Number(d.aidc) || 0) / 100;
  const gst     = PT_gstOn ? (1 + (Number(d.gst) || 0) / 100) : 1;
  return customs * gst;
}

function ptLanded(metalUsd, usdInr, cfg, mode) {
  const perGram = (metalUsd * usdInr) / PT_TROY;
  const factor  = ptDutyFactor(mode);
  return cfg.grades.map(g => ({ label: g.label, price: perGram * g.f * factor }));
}

function ptRefreshDownstream() {
  if (PT_cache.gold && PT_cache.inr)
    LIVE.goldRate = ptLanded(PT_cache.gold.price, PT_cache.inr.price, PT_CFG.gold, 'gold')[0].price;
  if (PT_cache.silver && PT_cache.inr)
    LIVE.silverRate = ptLanded(PT_cache.silver.price, PT_cache.inr.price, PT_CFG.silver, 'silver')[0].price;
  if (document.getElementById('tab-gold')?.classList.contains('active'))   renderGold?.();
  if (document.getElementById('tab-silver')?.classList.contains('active')) renderSilver?.();
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
    LIVE.goldRate   = ptLanded(gold.price,   inr.price, PT_CFG.gold,   'gold')[0].price;   // 24K
    LIVE.silverRate = ptLanded(silver.price, inr.price, PT_CFG.silver, 'silver')[0].price; // 999

    // Re-render those tabs if currently visible
    if (document.getElementById('tab-gold')?.classList.contains('active'))   renderGold();
    if (document.getElementById('tab-silver')?.classList.contains('active')) renderSilver();

    // Re-render tracker tab if visible (skip while user is editing settings)
    if (document.getElementById('tab-prices')?.classList.contains('active') && !PT_settingsOpen) ptDraw();

  } catch(e) {
    PT_lastErr = e.message;
    console.error('Price tracker poll error:', e);
    if (document.getElementById('tab-prices')?.classList.contains('active') && !PT_settingsOpen) ptDraw();
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
    ? ptLanded(metal.price, inr.price, cfg, PT_mode).map(r =>
        `<div class="pt-lr">
          <span class="pt-karat">${r.label}</span>
          <span class="pt-lprice">${ptInr(r.price)}/g</span>
        </div>`).join('')
    : `<div class="pt-lr"><span class="pt-karat">—</span><span class="pt-lprice">Loading…</span></div>`;

  const duty       = PT_duty[PT_mode];
  const bcdN       = +duty.bcd  || 0;
  const aidcN      = +duty.aidc || 0;
  const gstN       = +duty.gst  || 0;
  const customsPct = bcdN + aidcN;
  const effectivePct = PT_gstOn
    ? ((1 + customsPct / 100) * (1 + gstN / 100) - 1) * 100
    : customsPct;
  const dutyLine = PT_gstOn
    ? `BCD ${bcdN.toFixed(2)}% + AIDC ${aidcN.toFixed(2)}% + GST ${gstN.toFixed(2)}% → ${effectivePct.toFixed(2)}% on CIF`
    : `BCD ${bcdN.toFixed(2)}% + AIDC ${aidcN.toFixed(2)}% → ${customsPct.toFixed(2)}% on CIF · GST off`;
  const retailHdr = PT_gstOn ? '₹ / g · India Retail (Incl GST)' : '₹ / g · India Retail (Excl GST)';

  const settingsHTML = PT_settingsOpen ? `
    <div class="pt-settings">
      <div class="pt-settings-hdr">${isGold ? 'Gold' : 'Silver'} import duty + GST</div>
      <div class="pt-settings-row">
        <label>BCD %<input type="number" step="0.01" min="0" id="pt-bcd" value="${duty.bcd}"></label>
        <label>AIDC %<input type="number" step="0.01" min="0" id="pt-aidc" value="${duty.aidc}"></label>
        <label>GST %<input type="number" step="0.01" min="0" id="pt-gst" value="${duty.gst}"></label>
      </div>
      <div class="pt-settings-actions">
        <button type="button" id="pt-duty-save" class="pt-btn">Save</button>
      </div>
    </div>` : '';

  wrap.innerHTML = `
    <div class="pt-card">
      <div class="pt-hdr">
        <div>
          <div class="pt-title">${isGold ? 'Gold' : 'Silver'} price tracker</div>
          <div class="pt-sub">Live ${isGold ? 'XAU' : 'XAG'}/USD + USD/INR · ${PT_gstOn ? 'India retail (incl GST)' : 'India retail (excl GST)'}</div>
        </div>
        <div class="pt-hdr-actions">
          <button type="button" id="pt-gear" class="pt-gear" title="Edit import duty" aria-label="Settings">⚙</button>
          <label class="pt-toggle" title="Switch Gold / Silver">
            <input type="checkbox" id="pt-tog" ${isGold ? 'checked' : ''}>
            <span class="pt-tog-slider"></span>
          </label>
        </div>
      </div>
      ${settingsHTML}

      <div class="pt-status"><span class="${dotCls}"></span>${statusMsg}</div>

      <!-- ① Retail prices — hero section -->
      <div class="pt-import">
        <div class="pt-imp-hdr">
          <span>${retailHdr}</span>
          <label class="pt-gst-toggle" title="Toggle GST">
            <span class="pt-gst-lbl">GST</span>
            <input type="checkbox" id="pt-gst-tog" ${PT_gstOn ? 'checked' : ''}>
            <span class="pt-gst-slider"></span>
          </label>
        </div>
        <div class="pt-imp-rows">${landedHTML}</div>
        <div class="pt-imp-duty">${dutyLine}</div>
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

      <details class="pt-method" id="pt-method" ${PT_methodOpen ? 'open' : ''}>
        <summary>Methodology</summary>
        <div class="pt-method-body">
          <p><strong>Gold</strong> — OANDA:XAUUSD via TradingView CFD scanner; fallback Yahoo GC=F.
             <strong>Silver</strong> — TVC:SILVER via TradingView scanner (XAG/silver index); fallback Yahoo SI=F.</p>
          <p><strong>USD/INR</strong> — FX_IDC:USDINR via TradingView scanner; fallback Yahoo USDINR=X.</p>
          <p>${isGold ? 'Gold' : 'Silver'} retail uses <strong>${bcdN.toFixed(2)}% BCD + ${aidcN.toFixed(2)}% AIDC</strong> on CIF${PT_gstOn ? `, then <strong>${gstN.toFixed(2)}% GST</strong> on (CIF + duty)` : ' (GST currently off)'}.
             Rates editable via the ⚙ button. Retail prices feed the Gold &amp; Silver holding tabs. Polls every ~2.5 s. Illustrative only. 1 troy oz = 31.1035 g.</p>
        </div>
      </details>
    </div>`;

  // Re-attach toggle (innerHTML nukes old listeners)
  document.getElementById('pt-tog')?.addEventListener('change', e => {
    PT_mode = e.target.checked ? 'gold' : 'silver';
    ptDraw();
  });

  document.getElementById('pt-gear')?.addEventListener('click', () => {
    PT_settingsOpen = !PT_settingsOpen;
    ptDraw();
  });

  document.getElementById('pt-duty-save')?.addEventListener('click', () => {
    const bcd  = parseFloat(document.getElementById('pt-bcd')?.value);
    const aidc = parseFloat(document.getElementById('pt-aidc')?.value);
    const gst  = parseFloat(document.getElementById('pt-gst')?.value);
    if (Number.isFinite(bcd))  PT_duty[PT_mode].bcd  = bcd;
    if (Number.isFinite(aidc)) PT_duty[PT_mode].aidc = aidc;
    if (Number.isFinite(gst))  PT_duty[PT_mode].gst  = gst;
    ptSaveSettings();
    PT_settingsOpen = false;
    ptRefreshDownstream();
    ptDraw();
  });

  document.getElementById('pt-gst-tog')?.addEventListener('change', e => {
    PT_gstOn = !!e.target.checked;
    ptSaveSettings();
    ptRefreshDownstream();
    ptDraw();
  });

  // Track methodology open state so the live re-render doesn't snap it shut
  document.getElementById('pt-method')?.addEventListener('toggle', e => {
    PT_methodOpen = e.target.open;
  });
}

// ── Public API ──────────────────────────────────────────

function renderPriceTracker() {
  const wrap = document.getElementById('pt-content');
  if (!wrap) return;
  if (PT_cache.gold) { ptDraw(); return; }
  wrap.innerHTML = '<div style="padding:32px;text-align:center;color:var(--text3)">Connecting…</div>';
}

function initPriceTracker(allData) {
  ptInitSettings(allData || {});
  PT_t0 = Date.now();
  ptPoll();                             // immediate first tick
  PT_timer = setInterval(ptPoll, PT_MS);
}

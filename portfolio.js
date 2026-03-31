// ════════════════════════════════════════════════════════
//  PORTFOLIO MODULE — MF Holdings, Stocks, Gold, RE, EPF, NPS
// ════════════════════════════════════════════════════════

let P = {
  mf_holdings: [],
  stocks: [],
  gold: [],
  silver: [],
  real_estate: [],
  epf: { currentBalance:0, interestRate:8.15, lastUpdated:'', transactions:[] },
  nps: { currentValue:0, scheme:'', fundManager:'', lastUpdated:'', transactions:[] },
  mf_sales: [],
  stock_sales: [],
  gold_sales: [],
  silver_sales: []
};

// Live prices cache (in-memory, refreshed per session)
let LIVE = {
  mfNav: {},       // schemeCode -> { nav, date }
  stocks: {},      // 'SYMBOL.NSE' -> price
  goldRate: null,  // price per gram (24K 999)
  silverRate: null // price per gram (999 fine silver)
};

// GoldAPI.io key — default hardcoded, can be overridden via ⚙ API Key button (saves to Firestore)
let GOLDAPI_KEY = 'goldapi-kpklsmn22z55a-io';

// Active modules — set by boot script from Firestore config; null means all active
let ACTIVE_MODULES = null;

function pSave() {
  saveSection('portfolio', {
    mf_holdings: P.mf_holdings,
    stocks: P.stocks,
    gold: P.gold,
    silver: P.silver,
    real_estate: P.real_estate,
    epf: P.epf,
    nps: P.nps,
    mf_sales: P.mf_sales,
    stock_sales: P.stock_sales,
    gold_sales: P.gold_sales,
    silver_sales: P.silver_sales
  });
}

function pLoad(data) {
  const d = data?.portfolio || {};
  P.mf_holdings  = d.mf_holdings  || [];
  P.stocks       = d.stocks       || [];
  P.gold         = d.gold         || [];
  P.silver       = d.silver       || [];
  P.real_estate  = d.real_estate  || [];
  P.epf = {
    currentBalance: d.epf?.currentBalance || 0,
    interestRate:   d.epf?.interestRate   || 8.15,
    lastUpdated:    d.epf?.lastUpdated    || '',
    transactions:   d.epf?.transactions   || []
  };
  P.nps = {
    currentValue: d.nps?.currentValue || 0,
    scheme:       d.nps?.scheme       || '',
    fundManager:  d.nps?.fundManager  || '',
    lastUpdated:  d.nps?.lastUpdated  || '',
    transactions: d.nps?.transactions || []
  };
  P.mf_sales     = d.mf_sales     || [];
  P.stock_sales  = d.stock_sales  || [];
  P.gold_sales   = d.gold_sales   || [];
  P.silver_sales = d.silver_sales || [];
}

// ── LIVE PRICE FETCHERS ───────────────────────────────

async function fetchMFNav(schemeCode) {
  if (LIVE.mfNav[schemeCode] && !LIVE.mfNav[schemeCode].loading) return LIVE.mfNav[schemeCode];
  try {
    const r = await fetch('https://api.mfapi.in/mf/' + schemeCode);
    if (!r.ok) return null;
    const d = await r.json();
    if (d.status !== 'SUCCESS' || !d.data?.length) return null;
    const result = { nav: parseFloat(d.data[0].nav), date: d.data[0].date };
    LIVE.mfNav[schemeCode] = result;
    return result;
  } catch(e) { return null; }
}

const CF_PROXY = 'https://damp-bar-b442ok.r24rp9hgxh.workers.dev';

async function fetchStockPrice(symbol, exchange) {
  const key = symbol + '.' + exchange;
  if (LIVE.stocks[key] != null) return LIVE.stocks[key];
  try {
    const suffix = exchange === 'BSE' ? '.BO' : '.NS';
    const yfUrl = `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}${suffix}?interval=1d&range=1d`;
    const r = await fetch(`${CF_PROXY}?url=${encodeURIComponent(yfUrl)}`);
    if (!r.ok) return null;
    const d = await r.json();
    const price = d?.chart?.result?.[0]?.meta?.regularMarketPrice;
    if (price) LIVE.stocks[key] = price;
    return price || null;
  } catch(e) { return null; }
}

async function fetchGoldPrice() {
  if (LIVE.goldRate != null) return LIVE.goldRate;

  // Primary: GoldAPI.io — returns exact 24K INR/gram
  if (GOLDAPI_KEY) {
    try {
      const r = await fetch('https://www.goldapi.io/api/XAU/INR', {
        headers: { 'x-access-token': GOLDAPI_KEY, 'Content-Type': 'application/json' }
      });
      if (r.ok) {
        const d = await r.json();
        if (d.price_gram_24k && d.price_gram_24k > 100) {
          // Apply 10% Indian premium (import duty ~6% + GST 3% + local spread ~1%)
          const INDIA_PREMIUM = 1.10;
          LIVE.goldRate = d.price_gram_24k * INDIA_PREMIUM;
          LIVE.gold22k = (d.price_gram_22k || d.price_gram_24k * (22/24)) * INDIA_PREMIUM;
          LIVE.gold18k = (d.price_gram_18k || d.price_gram_24k * (18/24)) * INDIA_PREMIUM;
          return LIVE.goldRate;
        }
      }
    } catch(e) { console.warn('GoldAPI.io fetch failed:', e); }
  }

  // Fallback 1: MCX symbols via Yahoo Finance (works during Indian market hours)
  for (const [sym, xform] of [
    ['GOLDPETAL.MCX', p => p > 100 ? p : null],
    ['GOLD.MCX',      p => p > 1000 ? (p/10)*(999/995) : null]
  ]) {
    try {
      const r = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?interval=1d&range=5d`);
      if (r.ok) {
        const d = await r.json();
        const price = d?.chart?.result?.[0]?.meta?.regularMarketPrice;
        if (price) { const adj = xform(price); if (adj) { LIVE.goldRate = adj; return adj; } }
      }
    } catch(e) {}
  }

  // Fallback 2: GC=F (USD/troy oz) × USDINR=X ÷ 31.1035 → INR/gram 24K999
  try {
    const [gcR, fxR] = await Promise.all([
      fetch('https://query1.finance.yahoo.com/v8/finance/chart/GC%3DF?interval=1d&range=5d'),
      fetch('https://query1.finance.yahoo.com/v8/finance/chart/USDINR%3DX?interval=1d&range=5d')
    ]);
    if (gcR.ok && fxR.ok) {
      const gc = await gcR.json(), fx = await fxR.json();
      const gcPrice = gc?.chart?.result?.[0]?.meta?.regularMarketPrice;
      const usdinr  = fx?.chart?.result?.[0]?.meta?.regularMarketPrice;
      if (gcPrice && usdinr) { LIVE.goldRate = (gcPrice / 31.1035) * usdinr; return LIVE.goldRate; }
    }
  } catch(e) {}
  return null;
}

async function fetchSilverPrice() {
  if (LIVE.silverRate != null) return LIVE.silverRate;
  if (GOLDAPI_KEY) {
    try {
      const r = await fetch('https://www.goldapi.io/api/XAG/INR', {
        headers: { 'x-access-token': GOLDAPI_KEY, 'Content-Type': 'application/json' }
      });
      if (r.ok) {
        const d = await r.json();
        // price_gram for silver (999 fine) or calculate from troy oz price
        const pricePerGram = d.price_gram || (d.price ? d.price / 31.1035 : null);
        if (pricePerGram && pricePerGram > 0) {
          const INDIA_PREMIUM = 1.10;
          LIVE.silverRate = pricePerGram * INDIA_PREMIUM;
          return LIVE.silverRate;
        }
      }
    } catch(e) { console.warn('Silver price fetch failed:', e); }
  }
  return null;
}

const PURITY_FACTOR = { '24K': 1.0, '22K': 22/24, '18K': 18/24 };
const SILVER_PURITY_FACTOR = { '999': 1.0, '925': 0.925, '800': 0.800 };

// ── PORTFOLIO SUMMARY VALUES (for summary.js) ─────────
async function getPortfolioValues() {
  // Fetch all needed prices
  const mfPromises = [...new Set(P.mf_holdings.map(h=>h.schemeCode))].map(fetchMFNav);
  const stockPromises = P.stocks.map(s=>fetchStockPrice(s.symbol,s.exchange));
  const [goldRate, silverRate] = await Promise.all([fetchGoldPrice(), fetchSilverPrice(), ...mfPromises, ...stockPromises]);

  let mfTotal=0, mfInvested=0;
  P.mf_holdings.forEach(h=>{
    const nav = LIVE.mfNav[h.schemeCode];
    mfInvested += parseFloat(h.invested)||0;
    if (nav?.nav) mfTotal += (parseFloat(h.units)||0) * nav.nav;
    else mfTotal += parseFloat(h.invested)||0;
  });

  let stocksTotal=0, stocksInvested=0;
  P.stocks.forEach(s=>{
    const price = LIVE.stocks[s.symbol+'.'+s.exchange];
    stocksInvested += (parseFloat(s.avgPrice)||0) * (parseFloat(s.quantity)||0);
    if (price) stocksTotal += (parseFloat(s.quantity)||0) * price;
    else stocksTotal += stocksInvested;
  });

  let goldTotal=0, goldInvested=0;
  P.gold.forEach(g=>{
    goldInvested += parseFloat(g.purchasePrice)||0;
    if (goldRate) {
      goldTotal += (parseFloat(g.weightGrams)||0) * (PURITY_FACTOR[g.purity]||1) * goldRate;
    } else {
      goldTotal += parseFloat(g.purchasePrice)||0;
    }
  });

  let silverTotal=0, silverInvested=0;
  P.silver.forEach(s=>{
    silverInvested += parseFloat(s.purchasePrice)||0;
    if (silverRate) {
      silverTotal += (parseFloat(s.weightGrams)||0) * (SILVER_PURITY_FACTOR[s.purity]||1) * silverRate;
    } else {
      silverTotal += parseFloat(s.purchasePrice)||0;
    }
  });

  let reTotal=0, reInvested=0;
  P.real_estate.forEach(r=>{
    reInvested += parseFloat(r.purchasePrice)||0;
    reTotal += parseFloat(r.currentValue)||parseFloat(r.purchasePrice)||0;
  });

  const epfBalance = parseFloat(P.epf.currentBalance)||0;
  const epfContrib = P.epf.transactions
    .filter(t=>t.type==='contribution')
    .reduce((s,t)=>s+(parseFloat(t.employeeAmount)||0)+(parseFloat(t.employerAmount)||0),0);
  const npsValue   = parseFloat(P.nps.currentValue)||0;
  const npsContrib = P.nps.transactions
    .reduce((s,t)=>s+(parseFloat(t.amount)||0),0);

  const mfRealised     = P.mf_sales.reduce((s,x) => s + x.gainAmount, 0);
  const stocksRealised = P.stock_sales.reduce((s,x) => s + x.gainAmount, 0);
  const goldRealised   = P.gold_sales.reduce((s,x) => s + x.gainAmount, 0);
  const silverRealised = P.silver_sales.reduce((s,x) => s + x.gainAmount, 0);

  return {
    mf:         { current: mfTotal,     invested: mfInvested,     realised: mfRealised },
    stocks:     { current: stocksTotal, invested: stocksInvested, realised: stocksRealised },
    gold:       { current: goldTotal,   invested: goldInvested,   realised: goldRealised },
    silver:     { current: silverTotal, invested: silverInvested, realised: silverRealised },
    real_estate:{ current: reTotal,     invested: reInvested,     realised: 0 },
    epf:        { current: epfBalance,  invested: epfContrib,     realised: 0 },
    nps:        { current: npsValue,    invested: npsContrib,     realised: 0 },
    total:      mfTotal + stocksTotal + goldTotal + silverTotal + reTotal + epfBalance + npsValue
  };
}

// ── CASHFLOWS FOR XIRR (called by summary.js) ─────────
function getAssetCashflows(key, currentValue) {
  const today = new Date().toISOString().slice(0,10);
  let flows = [];
  if (key === 'mf') {
    P.mf_holdings.forEach(h => {
      const inv = parseFloat(h.invested)||0;
      if (h.purchaseDate && inv>0) flows.push({amount:-inv, date:h.purchaseDate});
    });
  } else if (key === 'stocks') {
    P.stocks.forEach(s => {
      const inv = (parseFloat(s.quantity)||0)*(parseFloat(s.avgPrice)||0);
      if (s.purchaseDate && inv>0) flows.push({amount:-inv, date:s.purchaseDate});
    });
  } else if (key === 'gold') {
    P.gold.forEach(g => {
      const inv = parseFloat(g.purchasePrice)||0;
      if (g.purchaseDate && inv>0) flows.push({amount:-inv, date:g.purchaseDate});
    });
  } else if (key === 'silver') {
    P.silver.forEach(s => {
      const inv = parseFloat(s.purchasePrice)||0;
      if (s.purchaseDate && inv>0) flows.push({amount:-inv, date:s.purchaseDate});
    });
  } else if (key === 'real_estate') {
    P.real_estate.forEach(r => {
      const inv = parseFloat(r.purchasePrice)||0;
      if (r.purchaseDate && inv>0) flows.push({amount:-inv, date:r.purchaseDate});
    });
  } else if (key === 'epf') {
    P.epf.transactions.filter(t=>t.type==='contribution').forEach(t => {
      const total = (parseFloat(t.employeeAmount)||0)+(parseFloat(t.employerAmount)||0);
      if (total>0 && t.date) flows.push({amount:-total, date:t.date});
    });
  } else if (key === 'nps') {
    P.nps.transactions.forEach(t => {
      const amt = parseFloat(t.amount)||0;
      if (amt>0 && t.date) flows.push({amount:-amt, date:t.date});
    });
  }
  // Add sale inflows as positive cash flows
  if (key === 'mf') {
    P.mf_sales.forEach(s => { if (s.saleDate && s.saleAmount > 0) flows.push({ amount: +s.saleAmount, date: s.saleDate }); });
  } else if (key === 'stocks') {
    P.stock_sales.forEach(s => { if (s.saleDate && s.saleAmount > 0) flows.push({ amount: +s.saleAmount, date: s.saleDate }); });
  } else if (key === 'gold') {
    P.gold_sales.forEach(s => { if (s.saleDate && s.saleAmount > 0) flows.push({ amount: +s.saleAmount, date: s.saleDate }); });
  } else if (key === 'silver') {
    P.silver_sales.forEach(s => { if (s.saleDate && s.saleAmount > 0) flows.push({ amount: +s.saleAmount, date: s.saleDate }); });
  }
  if (flows.length>0 && currentValue>0) {
    flows.sort((a,b)=>a.date.localeCompare(b.date));
    flows.push({amount:currentValue, date:today});
  }
  return flows;
}

function getRealisedGain(key) {
  if (key === 'mf')     return P.mf_sales.reduce((s,x) => s + x.gainAmount, 0);
  if (key === 'stocks') return P.stock_sales.reduce((s,x) => s + x.gainAmount, 0);
  if (key === 'gold')   return P.gold_sales.reduce((s,x) => s + x.gainAmount, 0);
  if (key === 'silver') return P.silver_sales.reduce((s,x) => s + x.gainAmount, 0);
  return 0;
}

// ── MF HOLDINGS ───────────────────────────────────────
async function renderMFHoldings() {
  const el = document.getElementById('mf-holdings-content');
  if (!el) return;

  // Fetch NAVs
  const codes = [...new Set(P.mf_holdings.map(h=>h.schemeCode))];
  await Promise.all(codes.map(fetchMFNav));

  const activeHoldings = P.mf_holdings.filter(h => (parseFloat(h.units)||0) > 0.0001);

  if (activeHoldings.length === 0 && P.mf_sales.length === 0) {
    el.innerHTML = '<div class="empty-state">No MF holdings yet — click <strong>+ Add Fund</strong> to get started.</div>';
    return;
  }

  let totalInvested=0, totalCurrent=0;
  const rows = activeHoldings.map((h,i)=>{
    const nav = LIVE.mfNav[h.schemeCode];
    const currentNav = nav?.nav;
    const units = parseFloat(h.units)||0;
    const invested = parseFloat(h.invested)||0;
    const currentVal = currentNav ? units * currentNav : null;
    const gain = currentVal != null ? currentVal - invested : null;
    const gainPct = (gain != null && invested > 0) ? (gain/invested)*100 : null;
    const cagr = computeCAGR(invested, currentVal, h.purchaseDate);
    totalInvested += invested;
    if (currentVal) totalCurrent += currentVal;
    return `<tr>
      <td class="left fund-num">${i+1}</td>
      <td class="left"><div class="fund-name" title="${esc(h.name)}">${esc(h.name)}</div>
        <div style="font-size:.7rem;color:var(--text3)">${esc(h.schemeCode)}</div></td>
      <td>${formatINR(invested)}</td>
      <td>${currentNav ? '₹ '+parseFloat(currentNav).toFixed(1) : '<span class="chip-n">—</span>'}</td>
      <td>${units > 0 ? units.toFixed(1) : '—'}</td>
      <td>${currentVal ? formatINR(currentVal) : '<span class="chip-n">—</span>'}</td>
      <td>${gain != null ? `<span style="color:${gain>=0?'var(--green)':'var(--red)'}">${gain>=0?'+':''}${formatINRFull(gain)}</span>` : '—'}</td>
      <td>${gainChip(gainPct)}</td>
      <td>${cagr != null ? cagrChip(cagr, false) : '<span class="chip-n">—</span>'}</td>
      <td><div class="fund-btns">
        <button class="fnd-btn" onclick="openMFModal('${esc(h.id)}')">✎</button>
        <button class="sell-btn" onclick="openMFSellModal('${esc(h.id)}')">Sell</button>
        <button class="fnd-btn del" onclick="deleteMFHolding('${esc(h.id)}')">✕</button>
      </div></td>
    </tr>`;
  }).join('');

  const totalGain = totalCurrent - totalInvested;
  const totalGainPct = totalInvested > 0 ? (totalGain/totalInvested)*100 : 0;

  el.innerHTML = `
    <div class="portfolio-table-wrap">
      <table class="portfolio-table">
        <thead><tr>
          <th class="left" style="width:30px"></th>
          <th class="left" style="min-width:200px">Fund Name</th>
          <th>Invested</th><th>NAV</th><th>Units</th>
          <th>Current Value</th><th>Notional Gain</th><th>Gain%</th><th>CAGR</th>
          <th style="width:80px"></th>
        </tr></thead>
        <tbody>${rows}</tbody>
        <tfoot><tr class="totals-row">
          <td colspan="2" class="left"><strong>Total</strong></td>
          <td><strong>${formatINR(totalInvested)}</strong></td>
          <td colspan="2"></td>
          <td><strong>${formatINR(totalCurrent)}</strong></td>
          <td><strong style="color:${totalGain>=0?'var(--green)':'var(--red)'}">${totalGain>=0?'+':''}${formatINRFull(totalGain)}</strong></td>
          <td>${gainChip(totalGainPct)}</td>
          <td colspan="2"></td>
        </tr></tfoot>
      </table>
    </div>
    ${renderSoldSection('mf', P.mf_sales)}`;
}

// MF Modal ─────────────────────────────────────────────
let mfEditId = null;
let mfSelFund = null;  // { schemeCode, name }
let mfModalNav = null; // nav value for the selected date

function closeMFModal() {
  document.getElementById('mf-modal').style.display = 'none';
  mfEditId = null; mfSelFund = null; mfModalNav = null;
}

function openMFModal(editId = null) {
  mfEditId = editId;
  mfSelFund = null; mfModalNav = null;
  const h = editId ? P.mf_holdings.find(x=>x.id===editId) : null;
  document.getElementById('mf-modal-title').textContent = editId ? 'Edit MF Holding' : 'Add MF Holding';
  document.getElementById('mf-modal-search').value = '';
  document.getElementById('mf-modal-results').style.display = 'none';
  document.getElementById('mf-modal-results').innerHTML = '';
  document.getElementById('mf-nav-info').style.display = 'none';
  document.getElementById('mf-nav-info').textContent = '';
  document.getElementById('mf-calc-note').textContent = '';
  document.getElementById('mf-modal-invested').value = h?.invested || '';
  document.getElementById('mf-modal-units').value    = h?.units    || '';
  document.getElementById('mf-modal-date').value     = h?.purchaseDate || '';

  if (editId && h) {
    mfSelFund = { schemeCode: h.schemeCode, name: h.name };
    document.getElementById('mf-search-section').style.display = 'none';
    document.getElementById('mf-disp-name').textContent = h.name;
    document.getElementById('mf-disp-code').textContent = 'Scheme Code: ' + h.schemeCode;
    document.getElementById('mf-fund-display').style.display = '';
    document.getElementById('mf-date-section').style.display = '';
    document.getElementById('mf-amounts-section').style.display = '';
  } else {
    document.getElementById('mf-search-section').style.display = '';
    document.getElementById('mf-fund-display').style.display = 'none';
    document.getElementById('mf-date-section').style.display = 'none';
    document.getElementById('mf-amounts-section').style.display = 'none';
  }
  document.getElementById('mf-modal').style.display = 'flex';
  if (!editId) setTimeout(()=>document.getElementById('mf-modal-search').focus(),80);
}

// Fund search within modal
let _mfSearchTimer;
document.getElementById('mf-modal-search').addEventListener('input', function() {
  const q = this.value.trim();
  const res = document.getElementById('mf-modal-results');
  clearTimeout(_mfSearchTimer);
  if (!q) { res.style.display = 'none'; return; }
  _mfSearchTimer = setTimeout(async () => {
    if (!allFunds.length) {
      res.innerHTML = '<div style="padding:14px;text-align:center;color:var(--text3);font-size:.82rem">Loading fund list…</div>';
      res.style.display = '';
      await loadFundList();
    }
    const words = q.toLowerCase().split(/\s+/).filter(Boolean);
    const hits = allFunds.filter(f => {
      const n = f.schemeName.toLowerCase();
      return words.every(w => n.includes(w));
    }).slice(0, 40);
    if (!hits.length) {
      res.innerHTML = '<div style="padding:14px;text-align:center;color:var(--text3);font-size:.82rem">No results</div>';
    } else {
      res.innerHTML = hits.map(f => `<div class="sr-item mf-msr" data-code="${esc(f.schemeCode)}" data-name="${esc(f.schemeName)}">
        <div class="sr-name">${hlText(f.schemeName, q)}</div>
        <div class="sr-code">${esc(f.schemeCode)}</div>
      </div>`).join('');
      res.querySelectorAll('.mf-msr').forEach(item => {
        item.addEventListener('mousedown', e => e.preventDefault());
        item.addEventListener('click', () => mfSelectFund(item.dataset.code, item.dataset.name));
      });
    }
    res.style.display = '';
  }, 200);
});
document.getElementById('mf-modal-search').addEventListener('blur', () => {
  setTimeout(() => { document.getElementById('mf-modal-results').style.display = 'none'; }, 150);
});

function mfSelectFund(code, name) {
  mfSelFund = { schemeCode: code, name };
  document.getElementById('mf-modal-results').style.display = 'none';
  document.getElementById('mf-modal-search').value = '';
  document.getElementById('mf-disp-name').textContent = name;
  document.getElementById('mf-disp-code').textContent = 'Scheme Code: ' + code;
  document.getElementById('mf-fund-display').style.display = '';
  document.getElementById('mf-date-section').style.display = '';
  setTimeout(() => document.getElementById('mf-modal-date').focus(), 80);
}

document.getElementById('mf-change-fund').addEventListener('click', () => {
  mfSelFund = null; mfModalNav = null;
  document.getElementById('mf-fund-display').style.display = 'none';
  document.getElementById('mf-date-section').style.display = 'none';
  document.getElementById('mf-amounts-section').style.display = 'none';
  document.getElementById('mf-search-section').style.display = '';
  document.getElementById('mf-modal-search').value = '';
  document.getElementById('mf-modal-search').focus();
});

// Date change → fetch NAV for that date
document.getElementById('mf-modal-date').addEventListener('change', async function() {
  this.blur();
  const date = this.value;
  if (!date || !mfSelFund) {
    document.getElementById('mf-amounts-section').style.display = '';
    return;
  }
  const info = document.getElementById('mf-nav-info');
  info.textContent = 'Fetching NAV…'; info.style.color = 'var(--text3)'; info.style.display = '';
  mfModalNav = null;
  try {
    const r = await fetch('https://api.mfapi.in/mf/' + mfSelFund.schemeCode);
    if (r.ok) {
      const d = await r.json();
      if (d.status === 'SUCCESS' && d.data?.length) {
        // mfapi dates are DD-MM-YYYY; find nearest on or before purchase date
        const toYMD = s => s.split('-').reverse().join('-');
        const bestEntry = d.data.find(e => toYMD(e.date) <= date);
        if (bestEntry) {
          mfModalNav = parseFloat(bestEntry.nav);
          info.textContent = `NAV on ${bestEntry.date}: ₹${mfModalNav.toFixed(4)}`;
          info.style.color = 'var(--accent)';
        } else {
          info.textContent = 'NAV not available for this date'; info.style.color = 'var(--text3)';
        }
      }
    }
  } catch(e) { info.textContent = 'Could not fetch NAV'; info.style.color = 'var(--red)'; }
  document.getElementById('mf-amounts-section').style.display = '';
  // Auto-fill if only one value already entered
  mfAutoFill('invested');
  setTimeout(() => document.getElementById('mf-modal-invested').focus(), 80);
});

function mfAutoFill(changed) {
  if (!mfModalNav) return;
  const amtEl   = document.getElementById('mf-modal-invested');
  const unitEl  = document.getElementById('mf-modal-units');
  const note    = document.getElementById('mf-calc-note');
  const amt  = parseFloat(amtEl.value);
  const units= parseFloat(unitEl.value);
  if (changed === 'invested' && !isNaN(amt) && amt > 0) {
    unitEl.value = (amt / mfModalNav).toFixed(3);
    note.textContent = `Units = ₹${amt} ÷ NAV ${mfModalNav.toFixed(4)}`;
  } else if (changed === 'units' && !isNaN(units) && units > 0) {
    amtEl.value = (units * mfModalNav).toFixed(2);
    note.textContent = `Amount = ${units} × NAV ${mfModalNav.toFixed(4)}`;
  }
}
document.getElementById('mf-modal-invested').addEventListener('input', () => mfAutoFill('invested'));
document.getElementById('mf-modal-units').addEventListener('input',    () => mfAutoFill('units'));

document.getElementById('mf-modal-cancel').addEventListener('click', closeMFModal);
document.getElementById('mf-modal').addEventListener('click', e => { if(e.target===e.currentTarget) closeMFModal(); });
document.getElementById('mf-modal').addEventListener('keydown', e => { if(e.key==='Escape') { e.stopPropagation(); closeMFModal(); } });
document.getElementById('mf-modal-confirm').addEventListener('click', () => {
  if (!mfSelFund && !mfEditId) { toast('Please search and select a fund'); return; }
  const date = document.getElementById('mf-modal-date').value;
  if (!date) { toast('Please enter a purchase date'); return; }
  let units    = parseFloat(document.getElementById('mf-modal-units').value);
  let invested = parseFloat(document.getElementById('mf-modal-invested').value);
  if (isNaN(units) && isNaN(invested)) { toast('Please enter units or amount invested'); return; }
  // Compute missing from NAV
  if (mfModalNav) {
    if (isNaN(units) || units <= 0) units = invested / mfModalNav;
    if (isNaN(invested) || invested <= 0) invested = units * mfModalNav;
  }
  if (isNaN(units) || isNaN(invested) || units <= 0 || invested <= 0) { toast('Please enter valid amount or units'); return; }
  if (mfEditId) {
    const h = P.mf_holdings.find(x=>x.id===mfEditId);
    if (h) { h.units=units; h.invested=invested; h.purchaseDate=date; }
  } else {
    P.mf_holdings.push({ id:newId(), name:mfSelFund.name, schemeCode:mfSelFund.schemeCode, units, invested, purchaseDate:date });
  }
  const code = mfSelFund?.schemeCode;
  pSave(); closeMFModal();
  if (code) LIVE.mfNav[code] = null;
  renderMFHoldings(); toast('Saved ✓');
});
document.getElementById('btn-add-mf').addEventListener('click', ()=>openMFModal());

function deleteMFHolding(id) {
  if (!confirm('Remove this holding?')) return;
  P.mf_holdings = P.mf_holdings.filter(h=>h.id!==id);
  pSave(); renderMFHoldings(); toast('Removed');
}

// ── STOCKS ────────────────────────────────────────────
async function renderStocks() {
  const el = document.getElementById('stocks-content');
  if (!el) return;

  // Fetch prices
  await Promise.all(P.stocks.map(s=>fetchStockPrice(s.symbol,s.exchange)));

  const activeStocks = P.stocks.filter(s => (parseFloat(s.quantity)||0) > 0.0001);

  if (activeStocks.length === 0 && P.stock_sales.length === 0) {
    el.innerHTML = '<div class="empty-state">No stocks yet — click <strong>+ Add Stock</strong> to get started.</div>';
    return;
  }

  let totalInvested=0, totalCurrent=0;
  const rows = activeStocks.map((s,i)=>{
    const price = LIVE.stocks[s.symbol+'.'+s.exchange];
    const qty   = parseFloat(s.quantity)||0;
    const avg   = parseFloat(s.avgPrice)||0;
    const invested = qty * avg;
    const current  = price ? qty * price : null;
    const gain     = current != null ? current - invested : null;
    const gainPct  = (gain != null && invested > 0) ? (gain/invested)*100 : null;
    totalInvested += invested;
    if (current) totalCurrent += current;
    return `<tr>
      <td class="left fund-num">${i+1}</td>
      <td class="left"><strong>${esc(s.name)}</strong></td>
      <td><span class="ticker-chip">${esc(s.symbol)}.${esc(s.exchange)}</span></td>
      <td>${qty}</td>
      <td>${formatINR(avg, false)}</td>
      <td>${formatINR(invested)}</td>
      <td>${price ? formatINR(price, false) : '<span class="chip-n">—</span>'}</td>
      <td>${current ? formatINR(current) : '<span class="chip-n">—</span>'}</td>
      <td>${gain != null ? `<span style="color:${gain>=0?'var(--green)':'var(--red)'}">${gain>=0?'+':''}${formatINRFull(gain)}</span>` : '—'}</td>
      <td>${gainChip(gainPct)}</td>
      <td><div class="fund-btns">
        <button class="fnd-btn" onclick="openStockModal('${esc(s.id)}')">✎</button>
        <button class="sell-btn" onclick="openStockSellModal('${esc(s.id)}')">Sell</button>
        <button class="fnd-btn del" onclick="deleteStock('${esc(s.id)}')">✕</button>
      </div></td>
    </tr>`;
  }).join('');

  const totalGain = totalCurrent - totalInvested;
  const totalGainPct = totalInvested > 0 ? (totalGain/totalInvested)*100 : 0;

  el.innerHTML = `
    <div class="portfolio-table-wrap">
      <table class="portfolio-table">
        <thead><tr>
          <th class="left" style="width:30px"></th>
          <th class="left" style="min-width:160px">Stock</th>
          <th>Symbol</th><th>Qty</th><th>Avg Cost</th>
          <th>Invested</th><th>CMP</th><th>Current Value</th>
          <th>Notional Gain</th><th>Gain%</th>
          <th style="width:80px"></th>
        </tr></thead>
        <tbody>${rows}</tbody>
        <tfoot><tr class="totals-row">
          <td colspan="5" class="left"><strong>Total</strong></td>
          <td><strong>${formatINR(totalInvested)}</strong></td>
          <td></td>
          <td><strong>${formatINR(totalCurrent)}</strong></td>
          <td><strong style="color:${totalGain>=0?'var(--green)':'var(--red)'}">${totalGain>=0?'+':''}${formatINRFull(totalGain)}</strong></td>
          <td>${gainChip(totalGainPct)}</td>
          <td></td>
        </tr></tfoot>
      </table>
    </div>
    ${renderSoldSection('stocks', P.stock_sales)}`;
}

let stockEditId = null;
function openStockModal(editId = null) {
  stockEditId = editId;
  const s = editId ? P.stocks.find(x=>x.id===editId) : null;
  document.getElementById('stock-modal-title').textContent = editId ? 'Edit Stock' : 'Add Stock';
  document.getElementById('stock-modal-name').value     = s?.name || '';
  document.getElementById('stock-modal-symbol').value   = s?.symbol || '';
  document.getElementById('stock-modal-exchange').value = s?.exchange || 'NSE';
  document.getElementById('stock-modal-qty').value      = s?.quantity || '';
  document.getElementById('stock-modal-price').value    = s?.avgPrice || '';
  document.getElementById('stock-modal-date').value     = s?.purchaseDate || '';
  document.getElementById('stock-modal').style.display  = 'flex';
}
document.getElementById('stock-modal-cancel').addEventListener('click', ()=> document.getElementById('stock-modal').style.display='none');
document.getElementById('stock-modal').addEventListener('click', e=>{ if(e.target===e.currentTarget) document.getElementById('stock-modal').style.display='none'; });
document.getElementById('stock-modal-confirm').addEventListener('click', ()=>{
  const name     = document.getElementById('stock-modal-name').value.trim();
  const symbol   = document.getElementById('stock-modal-symbol').value.trim().toUpperCase();
  const exchange = document.getElementById('stock-modal-exchange').value;
  const qty      = parseFloat(document.getElementById('stock-modal-qty').value);
  const price    = parseFloat(document.getElementById('stock-modal-price').value);
  const date     = document.getElementById('stock-modal-date').value;
  if (!name || !symbol || isNaN(qty) || isNaN(price)) { toast('Please fill all required fields'); return; }
  if (stockEditId) {
    const s = P.stocks.find(x=>x.id===stockEditId);
    if (s) { s.name=name; s.symbol=symbol; s.exchange=exchange; s.quantity=qty; s.avgPrice=price; s.purchaseDate=date; }
  } else {
    P.stocks.push({ id:newId(), name, symbol, exchange, quantity:qty, avgPrice:price, purchaseDate:date });
  }
  pSave(); document.getElementById('stock-modal').style.display='none';
  LIVE.stocks[symbol+'.'+exchange] = null; // force refresh
  renderStocks(); toast('Saved ✓');
});
document.getElementById('btn-add-stock').addEventListener('click', ()=>openStockModal());

function deleteStock(id) {
  if (!confirm('Remove this stock?')) return;
  P.stocks = P.stocks.filter(s=>s.id!==id);
  pSave(); renderStocks(); toast('Removed');
}

// ── GOLD ──────────────────────────────────────────────
async function renderGold() {
  const el = document.getElementById('gold-content');
  if (!el) return;

  const goldRate = await fetchGoldPrice();

  // Show current rate
  const rateEl = document.getElementById('gold-rate-display');
  if (rateEl) {
    rateEl.textContent = goldRate
      ? `24K 999: ${formatINRFull(goldRate)}/g  (spot + 10% Indian premium)`
      : 'Price unavailable — click ↻ Refresh Rate to enter manually';
  }

  const activeGold = P.gold.filter(g => (parseFloat(g.weightGrams)||0) > 0.0001);

  if (activeGold.length === 0 && P.gold_sales.length === 0) {
    el.innerHTML = '<div class="empty-state">No gold holdings yet — click <strong>+ Add Gold</strong> to get started.</div>';
    return;
  }

  let totalPurchase=0, totalCurrent=0;
  const weightByPurity = {}; // { '24K': 10.5, '22K': 5, ... }
  const rows = activeGold.map((g,i)=>{
    const purchased = parseFloat(g.purchasePrice)||0;
    const weight    = parseFloat(g.weightGrams)||0;
    const factor    = PURITY_FACTOR[g.purity] || 1;
    const current   = goldRate ? weight * factor * goldRate : null;
    const gain      = current != null ? current - purchased : null;
    const gainPct   = (gain != null && purchased > 0) ? (gain/purchased)*100 : null;
    totalPurchase += purchased;
    if (current) totalCurrent += current;
    weightByPurity[g.purity] = (weightByPurity[g.purity] || 0) + weight;
    return `<tr>
      <td class="left fund-num">${i+1}</td>
      <td class="left">${esc(g.description)}</td>
      <td>${weight}g</td>
      <td><span class="ticker-chip">${esc(g.purity)}</span></td>
      <td>${formatINR(purchased)}</td>
      <td>${current ? formatINR(current) : '<span class="chip-n">—</span>'}</td>
      <td>${gain != null ? `<span style="color:${gain>=0?'var(--green)':'var(--red)'}">${gain>=0?'+':''}${formatINRFull(gain)}</span>` : '—'}</td>
      <td>${gainChip(gainPct)}</td>
      <td><div class="fund-btns">
        <button class="fnd-btn" onclick="openGoldModal('${esc(g.id)}')">✎</button>
        <button class="sell-btn" onclick="openGoldSellModal('${esc(g.id)}')">Sell</button>
        <button class="fnd-btn del" onclick="deleteGold('${esc(g.id)}')">✕</button>
      </div></td>
    </tr>`;
  }).join('');

  const totalGain = totalCurrent - totalPurchase;
  const totalGainPct = totalPurchase > 0 ? (totalGain/totalPurchase)*100 : 0;

  el.innerHTML = `
    <div class="portfolio-table-wrap">
      <table class="portfolio-table">
        <thead><tr>
          <th class="left" style="width:30px"></th>
          <th class="left" style="min-width:160px">Description</th>
          <th>Weight</th><th>Purity</th>
          <th>Purchase Price</th><th>Current Value</th>
          <th>Notional Gain</th><th>Gain%</th>
          <th style="width:80px"></th>
        </tr></thead>
        <tbody>${rows}</tbody>
        <tfoot><tr class="totals-row">
          <td colspan="2" class="left"><strong>Total</strong></td>
          <td class="left" style="font-size:.78rem;color:var(--text2)">
            ${['24K','22K','18K'].filter(p=>weightByPurity[p]).map(p=>`<span style="white-space:nowrap">${weightByPurity[p].toFixed(2).replace(/\.?0+$/,'')}g ${p}</span>`).join('<br>')}
          </td>
          <td></td>
          <td><strong>${formatINR(totalPurchase)}</strong></td>
          <td><strong>${formatINR(totalCurrent)}</strong></td>
          <td><strong style="color:${totalGain>=0?'var(--green)':'var(--red)'}">${totalGain>=0?'+':''}${formatINRFull(totalGain)}</strong></td>
          <td>${gainChip(totalGainPct)}</td>
          <td></td>
        </tr></tfoot>
      </table>
    </div>
    ${renderSoldSection('gold', P.gold_sales)}`;
}

let goldEditId = null;
function openGoldModal(editId = null) {
  goldEditId = editId;
  const g = editId ? P.gold.find(x=>x.id===editId) : null;
  document.getElementById('gold-modal-title').textContent  = editId ? 'Edit Gold' : 'Add Gold';
  document.getElementById('gold-modal-desc').value         = g?.description || '';
  document.getElementById('gold-modal-weight').value       = g?.weightGrams || '';
  document.getElementById('gold-modal-purity').value       = g?.purity || '22K';
  document.getElementById('gold-modal-purchase').value     = g?.purchasePrice || '';
  document.getElementById('gold-modal-date').value         = g?.purchaseDate || '';
  document.getElementById('gold-modal').style.display      = 'flex';
}
document.getElementById('gold-modal-cancel').addEventListener('click', ()=> document.getElementById('gold-modal').style.display='none');
document.getElementById('gold-modal').addEventListener('click', e=>{ if(e.target===e.currentTarget) document.getElementById('gold-modal').style.display='none'; });
document.getElementById('gold-modal-confirm').addEventListener('click', ()=>{
  const desc    = document.getElementById('gold-modal-desc').value.trim();
  const weight  = parseFloat(document.getElementById('gold-modal-weight').value);
  const purity  = document.getElementById('gold-modal-purity').value;
  const purchase= parseFloat(document.getElementById('gold-modal-purchase').value);
  const gdate = document.getElementById('gold-modal-date').value;
  if (!desc || isNaN(weight) || isNaN(purchase)) { toast('Please fill all required fields'); return; }
  if (goldEditId) {
    const g = P.gold.find(x=>x.id===goldEditId);
    if (g) { g.description=desc; g.weightGrams=weight; g.purity=purity; g.purchasePrice=purchase; g.purchaseDate=gdate; }
  } else {
    P.gold.push({ id:newId(), description:desc, weightGrams:weight, purity, purchasePrice:purchase, purchaseDate:gdate });
  }
  pSave(); document.getElementById('gold-modal').style.display='none';
  LIVE.goldRate = null; // force refresh
  renderGold(); toast('Saved ✓');
});
document.getElementById('btn-add-gold').addEventListener('click', ()=>openGoldModal());

// ↻ Refresh Rate — fetch API price, let user override with local rate
document.getElementById('btn-refresh-gold').addEventListener('click', async () => {
  LIVE.goldRate = null; // force re-fetch
  toast('Fetching gold rate…');
  const apiRate = await fetchGoldPrice();
  const suggestion = apiRate ? Math.round(apiRate) : '';
  const msg = apiRate
    ? `API (international spot) rate: ₹${Math.round(apiRate).toLocaleString('en-IN')}/g\n\nIndian retail prices include import duty and are typically 8–12% higher.\n\nEnter the rate you want to use (₹/gram for 24K 999):`
    : 'Could not fetch API rate. Enter gold rate manually (₹/gram for 24K 999):';
  const input = prompt(msg, suggestion);
  if (input === null) return; // cancelled
  const rate = parseFloat(input);
  if (isNaN(rate) || rate < 100) { toast('Invalid rate'); return; }
  LIVE.goldRate = rate;
  renderGold(); toast(`Rate set to ₹${rate.toLocaleString('en-IN')}/g ✓`);
});

// ⚙ API Key button — update GoldAPI.io key and save to Firestore
document.getElementById('btn-gold-api-key').addEventListener('click', () => {
  const current = GOLDAPI_KEY || '';
  const key = prompt('Enter your GoldAPI.io key (free at goldapi.io):', current);
  if (key === null) return; // cancelled
  GOLDAPI_KEY = key.trim();
  saveSection('config', { goldApiKey: GOLDAPI_KEY });
  LIVE.goldRate = null; // force re-fetch with new key
  renderGold(); toast('API key saved ✓');
});

function deleteGold(id) {
  if (!confirm('Remove this gold holding?')) return;
  P.gold = P.gold.filter(g=>g.id!==id);
  pSave(); renderGold(); toast('Removed');
}

// ── REAL ESTATE ───────────────────────────────────────
function renderRealEstate() {
  const el = document.getElementById('realestate-content');
  if (!el) return;

  if (P.real_estate.length === 0) {
    el.innerHTML = '<div class="empty-state">No properties yet — click <strong>+ Add Property</strong> to get started.</div>';
    return;
  }

  let totalCost=0, totalCurrent=0;
  const rows = P.real_estate.map((r,i)=>{
    const cost    = parseFloat(r.purchasePrice)||0;
    const current = parseFloat(r.currentValue)||cost;
    const gain    = current - cost;
    const gainPct = cost > 0 ? (gain/cost)*100 : 0;
    const cagr    = computeCAGR(cost, current, r.purchaseDate);
    totalCost += cost; totalCurrent += current;
    return `<tr>
      <td class="left fund-num">${i+1}</td>
      <td class="left"><strong>${esc(r.name)}</strong>
        ${r.notes?`<div style="font-size:.7rem;color:var(--text3)">${esc(r.notes)}</div>`:''}
      </td>
      <td class="left">${esc(r.location)}</td>
      <td>${r.purchaseDate||'—'}</td>
      <td>${formatINR(cost)}</td>
      <td>${formatINR(current)}</td>
      <td><span style="color:${gain>=0?'var(--green)':'var(--red)'}">${gain>=0?'+':''}${formatINRFull(gain)}</span></td>
      <td>${gainChip(gainPct)}</td>
      <td>${cagr!=null?cagrChip(cagr,false):'—'}</td>
      <td><div class="fund-btns">
        <button class="fnd-btn" onclick="openREModal('${esc(r.id)}')">✎</button>
        <button class="fnd-btn del" onclick="deleteRE('${esc(r.id)}')">✕</button>
      </div></td>
    </tr>`;
  }).join('');

  const totalGain = totalCurrent - totalCost;
  el.innerHTML = `
    <div class="portfolio-table-wrap">
      <table class="portfolio-table">
        <thead><tr>
          <th class="left" style="width:30px"></th>
          <th class="left" style="min-width:160px">Property</th>
          <th class="left">Location</th>
          <th>Purchase Date</th><th>Cost</th><th>Current Value</th>
          <th>Gain/Loss</th><th>Gain%</th><th>CAGR</th>
          <th style="width:60px"></th>
        </tr></thead>
        <tbody>${rows}</tbody>
        <tfoot><tr class="totals-row">
          <td colspan="4" class="left"><strong>Total</strong></td>
          <td><strong>${formatINR(totalCost)}</strong></td>
          <td><strong>${formatINR(totalCurrent)}</strong></td>
          <td><strong style="color:${totalGain>=0?'var(--green)':'var(--red)'}">${totalGain>=0?'+':''}${formatINRFull(totalGain)}</strong></td>
          <td colspan="3"></td>
        </tr></tfoot>
      </table>
    </div>`;
}

let reEditId = null;
function openREModal(editId = null) {
  reEditId = editId;
  const r = editId ? P.real_estate.find(x=>x.id===editId) : null;
  document.getElementById('re-modal-title').textContent   = editId ? 'Edit Property' : 'Add Property';
  document.getElementById('re-modal-name').value          = r?.name || '';
  document.getElementById('re-modal-location').value      = r?.location || '';
  document.getElementById('re-modal-date').value          = r?.purchaseDate || '';
  document.getElementById('re-modal-purchase').value      = r?.purchasePrice || '';
  document.getElementById('re-modal-current').value       = r?.currentValue || '';
  document.getElementById('re-modal-notes').value         = r?.notes || '';
  document.getElementById('re-modal').style.display       = 'flex';
}
document.getElementById('re-modal-cancel').addEventListener('click', ()=> document.getElementById('re-modal').style.display='none');
document.getElementById('re-modal').addEventListener('click', e=>{ if(e.target===e.currentTarget) document.getElementById('re-modal').style.display='none'; });
document.getElementById('re-modal-confirm').addEventListener('click', ()=>{
  const name     = document.getElementById('re-modal-name').value.trim();
  const location = document.getElementById('re-modal-location').value.trim();
  const date     = document.getElementById('re-modal-date').value;
  const purchase = parseFloat(document.getElementById('re-modal-purchase').value);
  const current  = parseFloat(document.getElementById('re-modal-current').value);
  const notes    = document.getElementById('re-modal-notes').value.trim();
  if (!name || isNaN(purchase)) { toast('Please fill all required fields'); return; }
  if (reEditId) {
    const r = P.real_estate.find(x=>x.id===reEditId);
    if (r) { r.name=name; r.location=location; r.purchaseDate=date; r.purchasePrice=purchase; r.currentValue=current||purchase; r.notes=notes; }
  } else {
    P.real_estate.push({ id:newId(), name, location, purchaseDate:date, purchasePrice:purchase, currentValue:current||purchase, notes });
  }
  pSave(); document.getElementById('re-modal').style.display='none';
  renderRealEstate(); toast('Saved ✓');
});
document.getElementById('btn-add-re').addEventListener('click', ()=>openREModal());

function deleteRE(id) {
  if (!confirm('Remove this property?')) return;
  P.real_estate = P.real_estate.filter(r=>r.id!==id);
  pSave(); renderRealEstate(); toast('Removed');
}

// ── EPF ───────────────────────────────────────────────
function renderEPF() {
  const el = document.getElementById('epf-content');
  if (!el) return;
  const balance = parseFloat(P.epf.currentBalance)||0;
  const contrib = P.epf.transactions.filter(t=>t.type==='contribution')
    .reduce((s,t)=>s+(parseFloat(t.employeeAmount)||0)+(parseFloat(t.employerAmount)||0),0);
  const gain    = balance - contrib;
  const gainPct = contrib>0 ? (gain/contrib)*100 : 0;
  const flows   = getAssetCashflows('epf', balance);
  const xirr    = computeXIRR(flows);
  const cagr    = flows.length>=2 ? computeCAGR(contrib, balance, flows[0].date) : null;

  const txnRows = [...P.epf.transactions]
    .sort((a,b)=>b.date.localeCompare(a.date))
    .map(t => {
      const emp   = parseFloat(t.employeeAmount)||0;
      const empr  = parseFloat(t.employerAmount)||0;
      const total = t.type==='contribution' ? emp+empr : parseFloat(t.amount)||0;
      return `<tr>
        <td class="left">${t.date}</td>
        <td class="left">${t.type==='contribution'?'Contribution':'Interest Credit'}</td>
        <td>${t.type==='contribution'?formatINR(emp,false):'—'}</td>
        <td>${t.type==='contribution'?formatINR(empr,false):'—'}</td>
        <td>${t.type==='interest'?formatINR(parseFloat(t.amount)||0,false):'—'}</td>
        <td><strong>${formatINR(total,false)}</strong></td>
        <td><div class="row-btns">
          <button class="row-btn" onclick="openEPFTxnModal('${t.id}')">✎</button>
          <button class="row-btn del" onclick="deleteEPFTxn('${t.id}')">✕</button>
        </div></td>
      </tr>`;
    }).join('') || '<tr><td colspan="7" style="text-align:center;padding:18px;color:var(--text3);font-style:italic">No transactions yet — click + Transaction to add</td></tr>';

  el.innerHTML = `
    <div class="asset-cards-grid" style="margin-bottom:16px">
      <div class="asset-card">
        <div class="asset-card-header">
          <span class="asset-card-title">EPF</span>
          <span class="asset-card-sub">Employee Provident Fund</span>
        </div>
        <div class="asset-card-body">
          <div class="card-row"><span class="card-row-label">Total Contribution</span><span class="card-row-value">${formatINR(contrib)}</span></div>
          <div class="card-row"><span class="card-row-label">Current Balance</span><span class="card-row-value">${formatINR(balance)}</span></div>
          <div class="card-row"><span class="card-row-label">Gain</span>
            <strong style="color:${gain>=0?'var(--green)':'var(--red)'}">
              ${gain>=0?'+':''}${formatINR(gain)} ${gainChip(gainPct)}
            </strong>
          </div>
          <div class="card-row"><span class="card-row-label">CAGR</span>${cagrChip(cagr, false)}</div>
          <div class="card-row"><span class="card-row-label">XIRR</span>${xirrChip(xirr, false)}</div>
          <div class="card-row"><span class="card-row-label">Interest Rate</span><span class="card-row-value">${P.epf.interestRate||'—'}%</span></div>
          <div class="card-row"><span class="card-row-label">Last Updated</span><span class="card-row-value">${P.epf.lastUpdated||'—'}</span></div>
        </div>
        <div class="asset-card-footer">
          <button class="btn btn-sm" onclick="openEPFModal()">✎ Update Balance</button>
          <button class="btn btn-primary btn-sm" onclick="openEPFTxnModal()" style="margin-left:8px">+ Transaction</button>
        </div>
      </div>
    </div>
    <div class="portfolio-table-wrap">
      <div style="padding:12px 16px;font-weight:600;font-size:.82rem;border-bottom:1px solid var(--border);display:flex;justify-content:space-between;align-items:center">
        Transactions
        <span style="font-size:.74rem;color:var(--text3);font-weight:400">${P.epf.transactions.length} entries</span>
      </div>
      <table class="portfolio-table">
        <thead><tr>
          <th class="left">Date</th><th class="left">Type</th>
          <th>Employee</th><th>Employer</th><th>Interest</th><th>Total</th>
          <th style="width:60px"></th>
        </tr></thead>
        <tbody>${txnRows}</tbody>
      </table>
    </div>`;
}

// ── NPS ───────────────────────────────────────────────
function renderNPS() {
  const el = document.getElementById('nps-content');
  if (!el) return;
  const value   = parseFloat(P.nps.currentValue)||0;
  const contrib = P.nps.transactions.reduce((s,t)=>s+(parseFloat(t.amount)||0),0);
  const gain    = value - contrib;
  const gainPct = contrib>0 ? (gain/contrib)*100 : 0;
  const flows   = getAssetCashflows('nps', value);
  const xirr    = computeXIRR(flows);
  const cagr    = flows.length>=2 ? computeCAGR(contrib, value, flows[0].date) : null;

  const txnRows = [...P.nps.transactions]
    .sort((a,b)=>b.date.localeCompare(a.date))
    .map(t => `<tr>
      <td class="left">${t.date}</td>
      <td><strong>${formatINR(parseFloat(t.amount)||0,false)}</strong></td>
      <td><div class="row-btns">
        <button class="row-btn" onclick="openNPSTxnModal('${t.id}')">✎</button>
        <button class="row-btn del" onclick="deleteNPSTxn('${t.id}')">✕</button>
      </div></td>
    </tr>`).join('') || '<tr><td colspan="3" style="text-align:center;padding:18px;color:var(--text3);font-style:italic">No transactions yet — click + Transaction to add</td></tr>';

  el.innerHTML = `
    <div class="asset-cards-grid" style="margin-bottom:16px">
      <div class="asset-card">
        <div class="asset-card-header">
          <span class="asset-card-title">NPS</span>
          <span class="asset-card-sub">National Pension System</span>
        </div>
        <div class="asset-card-body">
          <div class="card-row"><span class="card-row-label">Total Contribution</span><span class="card-row-value">${formatINR(contrib)}</span></div>
          <div class="card-row"><span class="card-row-label">Current Value</span><span class="card-row-value">${formatINR(value)}</span></div>
          <div class="card-row"><span class="card-row-label">Gain</span>
            <strong style="color:${gain>=0?'var(--green)':'var(--red)'}">
              ${gain>=0?'+':''}${formatINR(gain)} ${gainChip(gainPct)}
            </strong>
          </div>
          <div class="card-row"><span class="card-row-label">CAGR</span>${cagrChip(cagr, false)}</div>
          <div class="card-row"><span class="card-row-label">XIRR</span>${xirrChip(xirr, false)}</div>
          <div class="card-row"><span class="card-row-label">Scheme</span><span class="card-row-value">${esc(P.nps.scheme)||'—'}</span></div>
          <div class="card-row"><span class="card-row-label">Fund Manager</span><span class="card-row-value">${esc(P.nps.fundManager)||'—'}</span></div>
          <div class="card-row"><span class="card-row-label">Last Updated</span><span class="card-row-value">${P.nps.lastUpdated||'—'}</span></div>
        </div>
        <div class="asset-card-footer">
          <button class="btn btn-sm" onclick="openNPSModal()">✎ Update Balance</button>
          <button class="btn btn-primary btn-sm" onclick="openNPSTxnModal()" style="margin-left:8px">+ Transaction</button>
        </div>
      </div>
    </div>
    <div class="portfolio-table-wrap">
      <div style="padding:12px 16px;font-weight:600;font-size:.82rem;border-bottom:1px solid var(--border);display:flex;justify-content:space-between;align-items:center">
        Transactions
        <span style="font-size:.74rem;color:var(--text3);font-weight:400">${P.nps.transactions.length} entries</span>
      </div>
      <table class="portfolio-table">
        <thead><tr>
          <th class="left">Date</th><th>Amount</th>
          <th style="width:60px"></th>
        </tr></thead>
        <tbody>${txnRows}</tbody>
      </table>
    </div>`;
}

// EPF Balance Modal
function openEPFModal() {
  document.getElementById('epf-balance').value = P.epf.currentBalance || '';
  document.getElementById('epf-rate').value    = P.epf.interestRate   || '8.15';
  document.getElementById('epf-date').value    = P.epf.lastUpdated    || '';
  document.getElementById('epf-modal').style.display = 'flex';
}
document.getElementById('epf-modal-cancel').addEventListener('click', ()=> document.getElementById('epf-modal').style.display='none');
document.getElementById('epf-modal').addEventListener('click', e=>{ if(e.target===e.currentTarget) document.getElementById('epf-modal').style.display='none'; });
document.getElementById('epf-modal-confirm').addEventListener('click', ()=>{
  P.epf.currentBalance = parseFloat(document.getElementById('epf-balance').value)||0;
  P.epf.interestRate   = parseFloat(document.getElementById('epf-rate').value)||0;
  P.epf.lastUpdated    = document.getElementById('epf-date').value;
  pSave(); document.getElementById('epf-modal').style.display='none';
  renderEPF(); toast('Saved ✓');
});

// EPF Transaction Modal
let epfTxnEditId = null;
function openEPFTxnModal(editId = null) {
  epfTxnEditId = editId;
  const t = editId ? P.epf.transactions.find(x=>x.id===editId) : null;
  document.getElementById('epf-txn-title').textContent   = editId ? 'Edit EPF Transaction' : 'Add EPF Transaction';
  document.getElementById('epf-txn-date').value          = t?.date || '';
  document.getElementById('epf-txn-type').value          = t?.type || 'contribution';
  document.getElementById('epf-txn-emp').value           = t?.employeeAmount || '';
  document.getElementById('epf-txn-employer').value      = t?.employerAmount || '';
  document.getElementById('epf-txn-interest').value      = t?.amount || '';
  toggleEPFTxnFields(t?.type || 'contribution');
  document.getElementById('epf-txn-modal').style.display = 'flex';
}
function toggleEPFTxnFields(type) {
  document.getElementById('epf-txn-contribution-wrap').style.display = type==='contribution' ? '' : 'none';
  document.getElementById('epf-txn-interest-wrap').style.display     = type==='interest'     ? '' : 'none';
}
document.getElementById('epf-txn-type').addEventListener('change', e=>toggleEPFTxnFields(e.target.value));
document.getElementById('epf-txn-cancel').addEventListener('click', ()=> document.getElementById('epf-txn-modal').style.display='none');
document.getElementById('epf-txn-modal').addEventListener('click', e=>{ if(e.target===e.currentTarget) document.getElementById('epf-txn-modal').style.display='none'; });
document.getElementById('epf-txn-confirm').addEventListener('click', ()=>{
  const date = document.getElementById('epf-txn-date').value;
  const type = document.getElementById('epf-txn-type').value;
  if (!date) { toast('Please enter a date'); return; }
  let txn;
  if (type === 'contribution') {
    const emp  = parseFloat(document.getElementById('epf-txn-emp').value)||0;
    const empr = parseFloat(document.getElementById('epf-txn-employer').value)||0;
    if (emp<=0 && empr<=0) { toast('Enter at least one amount'); return; }
    txn = { id:epfTxnEditId||newId(), date, type, employeeAmount:emp, employerAmount:empr };
  } else {
    const amt = parseFloat(document.getElementById('epf-txn-interest').value)||0;
    if (amt<=0) { toast('Enter interest amount'); return; }
    txn = { id:epfTxnEditId||newId(), date, type:'interest', amount:amt };
  }
  if (epfTxnEditId) {
    const idx = P.epf.transactions.findIndex(x=>x.id===epfTxnEditId);
    if (idx>=0) P.epf.transactions[idx] = txn;
  } else {
    P.epf.transactions.push(txn);
  }
  P.epf.transactions.sort((a,b)=>a.date.localeCompare(b.date));
  pSave(); document.getElementById('epf-txn-modal').style.display='none';
  renderEPF(); toast('Saved ✓');
});
function deleteEPFTxn(id) {
  if (!confirm('Remove this transaction?')) return;
  P.epf.transactions = P.epf.transactions.filter(t=>t.id!==id);
  pSave(); renderEPF(); toast('Removed');
}

// NPS Balance Modal
function openNPSModal() {
  document.getElementById('nps-value').value   = P.nps.currentValue || '';
  document.getElementById('nps-scheme').value  = P.nps.scheme       || '';
  document.getElementById('nps-manager').value = P.nps.fundManager  || '';
  document.getElementById('nps-date').value    = P.nps.lastUpdated  || '';
  document.getElementById('nps-modal').style.display = 'flex';
}
document.getElementById('nps-modal-cancel').addEventListener('click', ()=> document.getElementById('nps-modal').style.display='none');
document.getElementById('nps-modal').addEventListener('click', e=>{ if(e.target===e.currentTarget) document.getElementById('nps-modal').style.display='none'; });
document.getElementById('nps-modal-confirm').addEventListener('click', ()=>{
  P.nps.currentValue  = parseFloat(document.getElementById('nps-value').value)||0;
  P.nps.scheme        = document.getElementById('nps-scheme').value.trim();
  P.nps.fundManager   = document.getElementById('nps-manager').value.trim();
  P.nps.lastUpdated   = document.getElementById('nps-date').value;
  pSave(); document.getElementById('nps-modal').style.display='none';
  renderNPS(); toast('Saved ✓');
});

// NPS Transaction Modal
let npsTxnEditId = null;
function openNPSTxnModal(editId = null) {
  npsTxnEditId = editId;
  const t = editId ? P.nps.transactions.find(x=>x.id===editId) : null;
  document.getElementById('nps-txn-title').textContent   = editId ? 'Edit NPS Transaction' : 'Add NPS Transaction';
  document.getElementById('nps-txn-date').value          = t?.date   || '';
  document.getElementById('nps-txn-amount').value        = t?.amount || '';
  document.getElementById('nps-txn-modal').style.display = 'flex';
}
document.getElementById('nps-txn-cancel').addEventListener('click', ()=> document.getElementById('nps-txn-modal').style.display='none');
document.getElementById('nps-txn-modal').addEventListener('click', e=>{ if(e.target===e.currentTarget) document.getElementById('nps-txn-modal').style.display='none'; });
document.getElementById('nps-txn-confirm').addEventListener('click', ()=>{
  const date = document.getElementById('nps-txn-date').value;
  const amt  = parseFloat(document.getElementById('nps-txn-amount').value)||0;
  if (!date || amt<=0) { toast('Please fill all fields'); return; }
  const txn = { id:npsTxnEditId||newId(), date, amount:amt };
  if (npsTxnEditId) {
    const idx = P.nps.transactions.findIndex(x=>x.id===npsTxnEditId);
    if (idx>=0) P.nps.transactions[idx] = txn;
  } else {
    P.nps.transactions.push(txn);
  }
  P.nps.transactions.sort((a,b)=>a.date.localeCompare(b.date));
  pSave(); document.getElementById('nps-txn-modal').style.display='none';
  renderNPS(); toast('Saved ✓');
});
function deleteNPSTxn(id) {
  if (!confirm('Remove this transaction?')) return;
  P.nps.transactions = P.nps.transactions.filter(t=>t.id!==id);
  pSave(); renderNPS(); toast('Removed');
}

// ── SOLD SECTION HELPERS ──────────────────────────────

function toggleSold(key) {
  const el = document.getElementById('sold-' + key);
  const btn = document.getElementById('sold-toggle-' + key);
  if (!el) return;
  const isOpen = el.style.display !== 'none';
  el.style.display = isOpen ? 'none' : '';
  btn.textContent = btn.textContent.replace(isOpen ? '▼' : '▶', isOpen ? '▶' : '▼');
}

function renderSoldSection(key, sales) {
  if (!sales || !sales.length) return '';
  const totalGain       = sales.reduce((s, x) => s + x.gainAmount, 0);
  const totalSaleAmount = sales.reduce((s, x) => s + x.saleAmount, 0);
  const totalCostBasis  = sales.reduce((s, x) => s + x.costBasis, 0);
  const gainCls = totalGain >= 0 ? 'chip chip-g' : 'chip chip-r';
  const gainStr = (totalGain >= 0 ? '+' : '') + formatINR(totalGain);

  let rows = '';
  if (key === 'mf') {
    rows = sales.map(s => `<tr>
      <td class="left">${esc(s.fundName)}<div style="font-size:.72rem;color:var(--text3)">${esc(s.schemeCode)}</div></td>
      <td>${s.saleDate}</td>
      <td>${parseFloat(s.unitsSold).toFixed(1)}</td>
      <td>${s.saleNav ? '₹ '+parseFloat(s.saleNav).toFixed(1) : '—'}</td>
      <td>${formatINR(s.saleAmount)}</td>
      <td>${formatINR(s.costBasis)}</td>
      <td><span style="color:${s.gainAmount>=0?'var(--green)':'var(--red)'}">${s.gainAmount>=0?'+':''}${formatINRFull(s.gainAmount)}</span></td>
      <td>${gainChip((s.gainAmount/s.costBasis)*100)}</td>
      <td><button class="fnd-btn del" onclick="deleteMFSale('${s.id}')">✕</button></td>
    </tr>`).join('');
    return `<div class="sold-section">
      <button class="sold-toggle" id="sold-toggle-mf" onclick="toggleSold('mf')">▶ Sold Holdings (${sales.length}) &nbsp;·&nbsp; Realised: <span class="${gainCls}">${gainStr}</span></button>
      <div id="sold-mf" style="display:none">
        <table class="portfolio-table" style="margin-top:0">
          <thead><tr><th class="left">Fund</th><th>Sale Date</th><th>Units</th><th>Sale NAV</th><th>Sale Amount</th><th>Cost Basis</th><th>Realised Gain</th><th>Gain%</th><th></th></tr></thead>
          <tbody>${rows}</tbody>
          <tfoot><tr class="totals-row">
            <td class="left" colspan="4"><strong>Total</strong></td>
            <td><strong>${formatINR(totalSaleAmount)}</strong></td>
            <td><strong>${formatINR(totalCostBasis)}</strong></td>
            <td><strong style="color:${totalGain>=0?'var(--green)':'var(--red)'}">${totalGain>=0?'+':''}${formatINRFull(totalGain)}</strong></td>
            <td colspan="2"></td>
          </tr></tfoot>
        </table>
      </div>
    </div>`;
  }
  if (key === 'stocks') {
    rows = sales.map(s => `<tr>
      <td class="left">${esc(s.stockName)}<div style="font-size:.72rem;color:var(--text3)">${esc(s.symbol)} · ${esc(s.exchange)}</div></td>
      <td>${s.saleDate}</td>
      <td>${s.qtySold}</td>
      <td>${formatINR(s.salePricePerShare, false)}</td>
      <td>${formatINR(s.saleAmount)}</td>
      <td>${formatINR(s.costBasis)}</td>
      <td><span style="color:${s.gainAmount>=0?'var(--green)':'var(--red)'}">${s.gainAmount>=0?'+':''}${formatINRFull(s.gainAmount)}</span></td>
      <td>${gainChip((s.gainAmount/s.costBasis)*100)}</td>
      <td><button class="fnd-btn del" onclick="deleteStockSale('${s.id}')">✕</button></td>
    </tr>`).join('');
    return `<div class="sold-section">
      <button class="sold-toggle" id="sold-toggle-stocks" onclick="toggleSold('stocks')">▶ Sold Holdings (${sales.length}) &nbsp;·&nbsp; Realised: <span class="${gainCls}">${gainStr}</span></button>
      <div id="sold-stocks" style="display:none">
        <table class="portfolio-table" style="margin-top:0">
          <thead><tr><th class="left">Stock</th><th>Sale Date</th><th>Qty</th><th>Price/Share</th><th>Sale Amount</th><th>Cost Basis</th><th>Realised Gain</th><th>Gain%</th><th></th></tr></thead>
          <tbody>${rows}</tbody>
          <tfoot><tr class="totals-row">
            <td class="left" colspan="4"><strong>Total</strong></td>
            <td><strong>${formatINR(totalSaleAmount)}</strong></td>
            <td><strong>${formatINR(totalCostBasis)}</strong></td>
            <td><strong style="color:${totalGain>=0?'var(--green)':'var(--red)'}">${totalGain>=0?'+':''}${formatINRFull(totalGain)}</strong></td>
            <td colspan="2"></td>
          </tr></tfoot>
        </table>
      </div>
    </div>`;
  }
  if (key === 'gold') {
    rows = sales.map(s => `<tr>
      <td class="left">${esc(s.description)}</td>
      <td>${s.saleDate}</td>
      <td>${parseFloat(s.weightSold).toFixed(2)}g</td>
      <td><span class="ticker-chip">${esc(s.purity)}</span></td>
      <td>${formatINR(s.salePricePerGram, false)}/g</td>
      <td>${formatINR(s.saleAmount)}</td>
      <td>${formatINR(s.costBasis)}</td>
      <td><span style="color:${s.gainAmount>=0?'var(--green)':'var(--red)'}">${s.gainAmount>=0?'+':''}${formatINRFull(s.gainAmount)}</span></td>
      <td>${gainChip((s.gainAmount/s.costBasis)*100)}</td>
      <td><button class="fnd-btn del" onclick="deleteGoldSale('${s.id}')">✕</button></td>
    </tr>`).join('');
    return `<div class="sold-section">
      <button class="sold-toggle" id="sold-toggle-gold" onclick="toggleSold('gold')">▶ Sold Holdings (${sales.length}) &nbsp;·&nbsp; Realised: <span class="${gainCls}">${gainStr}</span></button>
      <div id="sold-gold" style="display:none">
        <table class="portfolio-table" style="margin-top:0">
          <thead><tr><th class="left">Description</th><th>Sale Date</th><th>Weight</th><th>Purity</th><th>Rate/g</th><th>Sale Amount</th><th>Cost Basis</th><th>Realised Gain</th><th>Gain%</th><th></th></tr></thead>
          <tbody>${rows}</tbody>
          <tfoot><tr class="totals-row">
            <td class="left" colspan="5"><strong>Total</strong></td>
            <td><strong>${formatINR(totalSaleAmount)}</strong></td>
            <td><strong>${formatINR(totalCostBasis)}</strong></td>
            <td><strong style="color:${totalGain>=0?'var(--green)':'var(--red)'}">${totalGain>=0?'+':''}${formatINRFull(totalGain)}</strong></td>
            <td colspan="2"></td>
          </tr></tfoot>
        </table>
      </div>
    </div>`;
  }
  if (key === 'silver') {
    rows = sales.map(s => `<tr>
      <td class="left">${esc(s.description)}</td>
      <td>${s.saleDate}</td>
      <td>${parseFloat(s.weightSold).toFixed(2)}g</td>
      <td><span class="ticker-chip">${esc(s.purity)}</span></td>
      <td>${formatINR(s.salePricePerGram, false)}/g</td>
      <td>${formatINR(s.saleAmount)}</td>
      <td>${formatINR(s.costBasis)}</td>
      <td><span style="color:${s.gainAmount>=0?'var(--green)':'var(--red)'}">${s.gainAmount>=0?'+':''}${formatINRFull(s.gainAmount)}</span></td>
      <td>${gainChip((s.gainAmount/s.costBasis)*100)}</td>
      <td><button class="fnd-btn del" onclick="deleteSilverSale('${s.id}')">✕</button></td>
    </tr>`).join('');
    return `<div class="sold-section">
      <button class="sold-toggle" id="sold-toggle-silver" onclick="toggleSold('silver')">▶ Sold Holdings (${sales.length}) &nbsp;·&nbsp; Realised: <span class="${gainCls}">${gainStr}</span></button>
      <div id="sold-silver" style="display:none">
        <table class="portfolio-table" style="margin-top:0">
          <thead><tr><th class="left">Description</th><th>Sale Date</th><th>Weight</th><th>Purity</th><th>Rate/g</th><th>Sale Amount</th><th>Cost Basis</th><th>Realised Gain</th><th>Gain%</th><th></th></tr></thead>
          <tbody>${rows}</tbody>
          <tfoot><tr class="totals-row">
            <td class="left" colspan="5"><strong>Total</strong></td>
            <td><strong>${formatINR(totalSaleAmount)}</strong></td>
            <td><strong>${formatINR(totalCostBasis)}</strong></td>
            <td><strong style="color:${totalGain>=0?'var(--green)':'var(--red)'}">${totalGain>=0?'+':''}${formatINRFull(totalGain)}</strong></td>
            <td colspan="2"></td>
          </tr></tfoot>
        </table>
      </div>
    </div>`;
  }
  return '';
}

// ── MF SELL MODAL ─────────────────────────────────────

let mfSellHoldingId = null;
let mfSellNav = null;

function openMFSellModal(holdingId) {
  mfSellHoldingId = holdingId;
  mfSellNav = null;
  const h = P.mf_holdings.find(x => x.id === holdingId);
  if (!h) return;
  document.getElementById('mf-sell-fund-name').textContent = h.name;
  document.getElementById('mf-sell-code').textContent = 'Code: ' + h.schemeCode;
  document.getElementById('mf-sell-max').textContent = parseFloat(h.units).toFixed(3);
  document.getElementById('mf-sell-date').value = new Date().toISOString().slice(0,10);
  document.getElementById('mf-sell-nav-info').textContent = 'Fetching today\'s NAV…';
  document.getElementById('mf-sell-units').value = '';
  document.getElementById('mf-sell-units').max = h.units;
  document.getElementById('mf-sell-amount').value = '';
  document.getElementById('mf-sell-modal').style.display = 'flex';
  // Auto-fetch today's NAV
  document.getElementById('mf-sell-date').dispatchEvent(new Event('change'));
}

document.getElementById('mf-sell-date').addEventListener('change', async function() {
  this.blur();
  const date = this.value;
  if (!date || !mfSellHoldingId) return;
  const h = P.mf_holdings.find(x => x.id === mfSellHoldingId);
  if (!h) return;
  const info = document.getElementById('mf-sell-nav-info');
  info.textContent = 'Fetching NAV…';
  mfSellNav = null;
  try {
    const r = await fetch('https://api.mfapi.in/mf/' + h.schemeCode);
    if (r.ok) {
      const d = await r.json();
      if (d.status === 'SUCCESS' && d.data?.length) {
        const toYMD = s => s.split('-').reverse().join('-');
        const entry = d.data.find(e => toYMD(e.date) <= date);
        if (entry) {
          mfSellNav = parseFloat(entry.nav);
          info.textContent = `NAV on ${entry.date}: ₹${mfSellNav.toFixed(4)}`;
          info.style.color = 'var(--accent)';
          mfSellAutoCalc();
        } else {
          info.textContent = 'NAV not available for this date';
        }
      }
    }
  } catch(e) { info.textContent = 'Could not fetch NAV'; }
});

function mfSellAutoCalc() {
  if (!mfSellNav) return;
  const units = parseFloat(document.getElementById('mf-sell-units').value);
  if (!isNaN(units) && units > 0) {
    document.getElementById('mf-sell-amount').value = (units * mfSellNav).toFixed(2);
  }
}
document.getElementById('mf-sell-units').addEventListener('input', mfSellAutoCalc);

document.getElementById('mf-sell-cancel').addEventListener('click', () => document.getElementById('mf-sell-modal').style.display = 'none');
document.getElementById('mf-sell-modal').addEventListener('click', e => { if (e.target === e.currentTarget) document.getElementById('mf-sell-modal').style.display = 'none'; });
document.getElementById('mf-sell-modal').addEventListener('keydown', e => { if(e.key==='Escape') { e.stopPropagation(); document.getElementById('mf-sell-modal').style.display='none'; } });

document.getElementById('mf-sell-confirm').addEventListener('click', () => {
  const h = P.mf_holdings.find(x => x.id === mfSellHoldingId);
  if (!h) return;
  const date = document.getElementById('mf-sell-date').value;
  const units = parseFloat(document.getElementById('mf-sell-units').value);
  const amount = parseFloat(document.getElementById('mf-sell-amount').value);
  if (!date) { toast('Enter sale date'); return; }
  if (isNaN(units) || units <= 0) { toast('Enter units sold'); return; }
  if (units > h.units) { toast(`Cannot exceed ${parseFloat(h.units).toFixed(3)} units`); return; }
  if (isNaN(amount) || amount <= 0) { toast('Enter sale amount'); return; }

  const costPerUnit = h.invested / h.units;
  const costBasis = costPerUnit * units;
  const gainAmount = amount - costBasis;

  P.mf_sales.push({
    id: newId(), holdingId: h.id, fundName: h.name, schemeCode: h.schemeCode,
    saleDate: date, unitsSold: units, saleNav: mfSellNav || 0,
    saleAmount: amount, costBasis, gainAmount
  });

  h.invested -= costBasis;
  h.units -= units;

  pSave();
  document.getElementById('mf-sell-modal').style.display = 'none';
  renderMFHoldings();
  toast('Sale recorded ✓');
});

function deleteMFSale(id) {
  if (!confirm('Remove this sale? The units will be restored to the holding.')) return;
  const sale = P.mf_sales.find(x => x.id === id);
  if (!sale) return;
  const h = P.mf_holdings.find(x => x.id === sale.holdingId);
  if (h) { h.units += sale.unitsSold; h.invested += sale.costBasis; }
  P.mf_sales = P.mf_sales.filter(x => x.id !== id);
  pSave(); renderMFHoldings(); toast('Sale removed');
}

// ── STOCK SELL MODAL ──────────────────────────────────

let stockSellId = null;

function openStockSellModal(stockId) {
  stockSellId = stockId;
  const s = P.stocks.find(x => x.id === stockId);
  if (!s) return;
  const cachedPrice = LIVE.stocks[s.symbol + '.' + s.exchange];
  document.getElementById('stock-sell-name').textContent = s.name;
  document.getElementById('stock-sell-symbol').textContent = s.symbol + ' · ' + s.exchange;
  document.getElementById('stock-sell-max').textContent = s.quantity;
  document.getElementById('stock-sell-date').value = new Date().toISOString().slice(0,10);
  document.getElementById('stock-sell-price').value = cachedPrice ? cachedPrice.toFixed(2) : '';
  document.getElementById('stock-sell-qty').value = s.quantity;
  document.getElementById('stock-sell-amount').value = '';
  stockSellAutoCalc();
  document.getElementById('stock-sell-modal').style.display = 'flex';
}

function stockSellAutoCalc() {
  const qty = parseFloat(document.getElementById('stock-sell-qty').value);
  const price = parseFloat(document.getElementById('stock-sell-price').value);
  if (!isNaN(qty) && !isNaN(price)) {
    document.getElementById('stock-sell-amount').value = (qty * price).toFixed(2);
  }
}
document.getElementById('stock-sell-qty').addEventListener('input', stockSellAutoCalc);
document.getElementById('stock-sell-price').addEventListener('input', stockSellAutoCalc);

document.getElementById('stock-sell-cancel').addEventListener('click', () => document.getElementById('stock-sell-modal').style.display = 'none');
document.getElementById('stock-sell-modal').addEventListener('click', e => { if (e.target === e.currentTarget) document.getElementById('stock-sell-modal').style.display = 'none'; });

document.getElementById('stock-sell-confirm').addEventListener('click', () => {
  const s = P.stocks.find(x => x.id === stockSellId);
  if (!s) return;
  const date = document.getElementById('stock-sell-date').value;
  const qty = parseFloat(document.getElementById('stock-sell-qty').value);
  const price = parseFloat(document.getElementById('stock-sell-price').value);
  const amount = parseFloat(document.getElementById('stock-sell-amount').value);
  if (!date) { toast('Enter sale date'); return; }
  if (isNaN(qty) || qty <= 0) { toast('Enter qty sold'); return; }
  if (qty > s.quantity) { toast(`Cannot exceed ${s.quantity} shares`); return; }
  if (isNaN(amount) || amount <= 0) { toast('Enter sale amount'); return; }

  const costPerShare = s.avgPrice;
  const costBasis = costPerShare * qty;
  const gainAmount = amount - costBasis;

  P.stock_sales.push({
    id: newId(), stockId: s.id, stockName: s.name, symbol: s.symbol, exchange: s.exchange,
    saleDate: date, qtySold: qty, salePricePerShare: price,
    saleAmount: amount, costBasis, gainAmount
  });

  s.quantity -= qty;

  pSave();
  document.getElementById('stock-sell-modal').style.display = 'none';
  renderStocks();
  toast('Sale recorded ✓');
});

function deleteStockSale(id) {
  if (!confirm('Remove this sale? The shares will be restored.')) return;
  const sale = P.stock_sales.find(x => x.id === id);
  if (!sale) return;
  const s = P.stocks.find(x => x.id === sale.stockId);
  if (s) {
    s.quantity += sale.qtySold;
  } else {
    P.stocks.push({ id: sale.stockId, name: sale.stockName, symbol: sale.symbol, exchange: sale.exchange, quantity: sale.qtySold, avgPrice: sale.costBasis / sale.qtySold, purchaseDate: '' });
  }
  P.stock_sales = P.stock_sales.filter(x => x.id !== id);
  pSave(); renderStocks(); toast('Sale removed');
}

// ── GOLD SELL MODAL ───────────────────────────────────

let goldSellId = null;
let goldSellRate = null;

function openGoldSellModal(goldId) {
  goldSellId = goldId;
  goldSellRate = LIVE.goldRate;
  const g = P.gold.find(x => x.id === goldId);
  if (!g) return;
  document.getElementById('gold-sell-desc').textContent = g.description;
  document.getElementById('gold-sell-purity').textContent = g.purity;
  document.getElementById('gold-sell-max').textContent = g.weightGrams + 'g';
  document.getElementById('gold-sell-date').value = new Date().toISOString().slice(0,10);
  document.getElementById('gold-sell-rate').value = goldSellRate ? Math.round(goldSellRate) : '';
  document.getElementById('gold-sell-weight').value = g.weightGrams;
  document.getElementById('gold-sell-rate-info').textContent = goldSellRate ? `Current rate: ₹${Math.round(goldSellRate).toLocaleString('en-IN')}/g` : '';
  goldSellAutoCalc();
  document.getElementById('gold-sell-modal').style.display = 'flex';
}

document.getElementById('gold-sell-date').addEventListener('change', async function() {
  this.blur();
  const date = this.value;
  if (!date || !GOLDAPI_KEY) { goldSellRate = LIVE.goldRate; goldSellAutoCalc(); return; }
  const info = document.getElementById('gold-sell-rate-info');
  info.textContent = 'Fetching rate…';
  try {
    const dateStr = date.replace(/-/g, '');
    const r = await fetch(`https://www.goldapi.io/api/XAU/INR/${dateStr}`, {
      headers: { 'x-access-token': GOLDAPI_KEY }
    });
    if (r.ok) {
      const d = await r.json();
      if (d.price_gram_24k) {
        goldSellRate = d.price_gram_24k * 1.10;
        info.textContent = `Rate on ${date}: ₹${Math.round(goldSellRate).toLocaleString('en-IN')}/g`;
        document.getElementById('gold-sell-rate').value = Math.round(goldSellRate);
        goldSellAutoCalc();
        return;
      }
    }
  } catch(e) {}
  goldSellRate = LIVE.goldRate;
  info.textContent = goldSellRate ? `Using current rate: ₹${Math.round(goldSellRate).toLocaleString('en-IN')}/g` : 'Rate unavailable';
  document.getElementById('gold-sell-rate').value = goldSellRate ? Math.round(goldSellRate) : '';
  goldSellAutoCalc();
});

function goldSellAutoCalc() {
  const weight = parseFloat(document.getElementById('gold-sell-weight').value);
  const rate = parseFloat(document.getElementById('gold-sell-rate').value);
  if (!isNaN(weight) && !isNaN(rate)) {
    document.getElementById('gold-sell-amount').value = Math.round(weight * rate);
  }
}
document.getElementById('gold-sell-weight').addEventListener('input', goldSellAutoCalc);
document.getElementById('gold-sell-rate').addEventListener('input', goldSellAutoCalc);

document.getElementById('gold-sell-cancel').addEventListener('click', () => document.getElementById('gold-sell-modal').style.display = 'none');
document.getElementById('gold-sell-modal').addEventListener('click', e => { if (e.target === e.currentTarget) document.getElementById('gold-sell-modal').style.display = 'none'; });

document.getElementById('gold-sell-confirm').addEventListener('click', () => {
  const g = P.gold.find(x => x.id === goldSellId);
  if (!g) return;
  const date = document.getElementById('gold-sell-date').value;
  const weight = parseFloat(document.getElementById('gold-sell-weight').value);
  const rate = parseFloat(document.getElementById('gold-sell-rate').value);
  const amount = parseFloat(document.getElementById('gold-sell-amount').value);
  if (!date) { toast('Enter sale date'); return; }
  if (isNaN(weight) || weight <= 0) { toast('Enter weight sold'); return; }
  if (weight > g.weightGrams) { toast(`Cannot exceed ${g.weightGrams}g`); return; }
  if (isNaN(amount) || amount <= 0) { toast('Enter sale amount'); return; }

  const costPerGram = g.purchasePrice / g.weightGrams;
  const costBasis = costPerGram * weight;
  const gainAmount = amount - costBasis;

  P.gold_sales.push({
    id: newId(), goldId: g.id, description: g.description, purity: g.purity,
    saleDate: date, weightSold: weight, salePricePerGram: rate,
    saleAmount: amount, costBasis, gainAmount
  });

  g.purchasePrice -= costBasis;
  g.weightGrams -= weight;
  if (g.weightGrams <= 0.0001) {
    P.gold = P.gold.filter(x => x.id !== g.id);
  }

  pSave();
  document.getElementById('gold-sell-modal').style.display = 'none';
  renderGold();
  toast('Sale recorded ✓');
});

function deleteGoldSale(id) {
  if (!confirm('Remove this sale? The weight will be restored.')) return;
  const sale = P.gold_sales.find(x => x.id === id);
  if (!sale) return;
  const g = P.gold.find(x => x.id === sale.goldId);
  if (g) { g.weightGrams += sale.weightSold; g.purchasePrice += sale.costBasis; }
  else {
    P.gold.push({ id: sale.goldId, description: sale.description, purity: sale.purity, weightGrams: sale.weightSold, purchasePrice: sale.costBasis, purchaseDate: '' });
  }
  P.gold_sales = P.gold_sales.filter(x => x.id !== id);
  pSave(); renderGold(); toast('Sale removed');
}

// ── SILVER ────────────────────────────────────────────
async function renderSilver() {
  const el = document.getElementById('silver-content');
  if (!el) return;

  const silverRate = await fetchSilverPrice();

  const activeSilver = P.silver.filter(s => (parseFloat(s.weightGrams)||0) > 0.0001);

  if (activeSilver.length === 0 && P.silver_sales.length === 0) {
    el.innerHTML = '<div class="empty-state">No silver holdings yet — click <strong>+ Add Silver</strong> to get started.</div>';
    return;
  }

  let totalPurchase=0, totalCurrent=0;
  const weightByPurity = {};
  const rows = activeSilver.map((s,i)=>{
    const purchased = parseFloat(s.purchasePrice)||0;
    const weight    = parseFloat(s.weightGrams)||0;
    const factor    = SILVER_PURITY_FACTOR[s.purity] || 1;
    const current   = silverRate ? weight * factor * silverRate : null;
    const gain      = current != null ? current - purchased : null;
    const gainPct   = (gain != null && purchased > 0) ? (gain/purchased)*100 : null;
    totalPurchase += purchased;
    if (current) totalCurrent += current;
    weightByPurity[s.purity] = (weightByPurity[s.purity] || 0) + weight;
    return `<tr>
      <td class="left fund-num">${i+1}</td>
      <td class="left">${esc(s.description)}</td>
      <td>${weight}g</td>
      <td><span class="ticker-chip">${esc(s.purity)}</span></td>
      <td>${formatINR(purchased)}</td>
      <td>${current ? formatINR(current) : '<span class="chip-n">—</span>'}</td>
      <td>${gain != null ? `<span style="color:${gain>=0?'var(--green)':'var(--red)'}">${gain>=0?'+':''}${formatINRFull(gain)}</span>` : '—'}</td>
      <td>${gainChip(gainPct)}</td>
      <td><div class="fund-btns">
        <button class="fnd-btn" onclick="openSilverModal('${esc(s.id)}')">✎</button>
        <button class="sell-btn" onclick="openSilverSellModal('${esc(s.id)}')">Sell</button>
        <button class="fnd-btn del" onclick="deleteSilver('${esc(s.id)}')">✕</button>
      </div></td>
    </tr>`;
  }).join('');

  const totalGain = totalCurrent - totalPurchase;
  const totalGainPct = totalPurchase > 0 ? (totalGain/totalPurchase)*100 : 0;
  const rateInfo = silverRate ? `999 fine: ${formatINRFull(silverRate)}/g (spot + 10% Indian premium)` : 'Price unavailable';

  el.innerHTML = `
    <div class="gold-rate-banner" style="background:linear-gradient(135deg,#f0f0f0,#f8f8f8);border-color:#c0c0c0">
      <div><div class="gold-rate-label" style="color:#666">Silver Rate</div>
      <div class="gold-rate-value" style="color:#444">${silverRate ? '₹ '+Math.round(silverRate).toLocaleString('en-IN') : '—'}/g</div>
      <div class="gold-rate-sub">${rateInfo}</div></div>
    </div>
    <div class="portfolio-table-wrap">
      <table class="portfolio-table">
        <thead><tr>
          <th class="left" style="width:30px"></th>
          <th class="left" style="min-width:160px">Description</th>
          <th>Weight</th><th>Purity</th>
          <th>Purchase Price</th><th>Current Value</th>
          <th>Notional Gain</th><th>Gain%</th>
          <th style="width:80px"></th>
        </tr></thead>
        <tbody>${rows}</tbody>
        <tfoot><tr class="totals-row">
          <td colspan="2" class="left"><strong>Total</strong></td>
          <td class="left" style="font-size:.78rem;color:var(--text2)">
            ${['999','925','800'].filter(p=>weightByPurity[p]).map(p=>`<span style="white-space:nowrap">${weightByPurity[p].toFixed(2).replace(/\.?0+$/,'')}g ${p}</span>`).join('<br>')}
          </td>
          <td></td>
          <td><strong>${formatINR(totalPurchase)}</strong></td>
          <td><strong>${formatINR(totalCurrent)}</strong></td>
          <td><strong style="color:${totalGain>=0?'var(--green)':'var(--red)'}">${totalGain>=0?'+':''}${formatINRFull(totalGain)}</strong></td>
          <td>${gainChip(totalGainPct)}</td>
          <td></td>
        </tr></tfoot>
      </table>
    </div>
    ${renderSoldSection('silver', P.silver_sales)}`;
}

let silverEditId = null;
function openSilverModal(editId = null) {
  silverEditId = editId;
  const s = editId ? P.silver.find(x=>x.id===editId) : null;
  document.getElementById('silver-modal-title').textContent = editId ? 'Edit Silver' : 'Add Silver';
  document.getElementById('silver-modal-desc').value     = s?.description || '';
  document.getElementById('silver-modal-weight').value   = s?.weightGrams || '';
  document.getElementById('silver-modal-purity').value   = s?.purity || '999';
  document.getElementById('silver-modal-purchase').value = s?.purchasePrice || '';
  document.getElementById('silver-modal-date').value     = s?.purchaseDate || '';
  document.getElementById('silver-modal').style.display  = 'flex';
}
document.getElementById('silver-modal-cancel').addEventListener('click', ()=> document.getElementById('silver-modal').style.display='none');
document.getElementById('silver-modal').addEventListener('click', e=>{ if(e.target===e.currentTarget) document.getElementById('silver-modal').style.display='none'; });
document.getElementById('silver-modal-confirm').addEventListener('click', ()=>{
  const desc     = document.getElementById('silver-modal-desc').value.trim();
  const weight   = parseFloat(document.getElementById('silver-modal-weight').value);
  const purity   = document.getElementById('silver-modal-purity').value;
  const purchase = parseFloat(document.getElementById('silver-modal-purchase').value);
  const sdate    = document.getElementById('silver-modal-date').value;
  if (!desc || isNaN(weight) || isNaN(purchase)) { toast('Please fill all required fields'); return; }
  if (silverEditId) {
    const s = P.silver.find(x=>x.id===silverEditId);
    if (s) { s.description=desc; s.weightGrams=weight; s.purity=purity; s.purchasePrice=purchase; s.purchaseDate=sdate; }
  } else {
    P.silver.push({ id:newId(), description:desc, weightGrams:weight, purity, purchasePrice:purchase, purchaseDate:sdate });
  }
  pSave(); document.getElementById('silver-modal').style.display='none';
  LIVE.silverRate = null;
  renderSilver(); toast('Saved ✓');
});
document.getElementById('btn-add-silver').addEventListener('click', ()=>openSilverModal());
document.getElementById('btn-refresh-silver').addEventListener('click', async () => {
  LIVE.silverRate = null;
  toast('Fetching silver rate…');
  const rate = await fetchSilverPrice();
  renderSilver();
  if (rate) toast(`Silver rate: ₹ ${Math.round(rate).toLocaleString('en-IN')}/g ✓`);
  else toast('Could not fetch silver rate');
});

function deleteSilver(id) {
  if (!confirm('Remove this silver holding?')) return;
  P.silver = P.silver.filter(s=>s.id!==id);
  pSave(); renderSilver(); toast('Removed');
}

// ── SILVER SELL MODAL ─────────────────────────────────

let silverSellId = null;
let silverSellRate = null;

function openSilverSellModal(silverId) {
  silverSellId = silverId;
  silverSellRate = LIVE.silverRate;
  const s = P.silver.find(x => x.id === silverId);
  if (!s) return;
  document.getElementById('silver-sell-desc').textContent = s.description;
  document.getElementById('silver-sell-purity').textContent = s.purity;
  document.getElementById('silver-sell-max').textContent = s.weightGrams + 'g';
  document.getElementById('silver-sell-date').value = new Date().toISOString().slice(0,10);
  document.getElementById('silver-sell-rate').value = silverSellRate ? Math.round(silverSellRate) : '';
  document.getElementById('silver-sell-weight').value = s.weightGrams;
  document.getElementById('silver-sell-rate-info').textContent = silverSellRate ? `Current rate: ₹ ${Math.round(silverSellRate).toLocaleString('en-IN')}/g` : '';
  silverSellAutoCalc();
  document.getElementById('silver-sell-modal').style.display = 'flex';
}

function silverSellAutoCalc() {
  const weight = parseFloat(document.getElementById('silver-sell-weight').value);
  const rate = parseFloat(document.getElementById('silver-sell-rate').value);
  if (!isNaN(weight) && !isNaN(rate)) {
    document.getElementById('silver-sell-amount').value = Math.round(weight * rate);
  }
}
document.getElementById('silver-sell-weight').addEventListener('input', silverSellAutoCalc);
document.getElementById('silver-sell-rate').addEventListener('input', silverSellAutoCalc);

document.getElementById('silver-sell-cancel').addEventListener('click', () => document.getElementById('silver-sell-modal').style.display = 'none');
document.getElementById('silver-sell-modal').addEventListener('click', e => { if (e.target === e.currentTarget) document.getElementById('silver-sell-modal').style.display = 'none'; });
document.getElementById('silver-sell-modal').addEventListener('keydown', e => { if(e.key==='Escape') { e.stopPropagation(); document.getElementById('silver-sell-modal').style.display='none'; } });

document.getElementById('silver-sell-confirm').addEventListener('click', () => {
  const s = P.silver.find(x => x.id === silverSellId);
  if (!s) return;
  const date = document.getElementById('silver-sell-date').value;
  const weight = parseFloat(document.getElementById('silver-sell-weight').value);
  const rate = parseFloat(document.getElementById('silver-sell-rate').value);
  const amount = parseFloat(document.getElementById('silver-sell-amount').value);
  if (!date) { toast('Enter sale date'); return; }
  if (isNaN(weight) || weight <= 0) { toast('Enter weight sold'); return; }
  if (weight > s.weightGrams) { toast(`Cannot exceed ${s.weightGrams}g`); return; }
  if (isNaN(amount) || amount <= 0) { toast('Enter sale amount'); return; }

  const costPerGram = s.purchasePrice / s.weightGrams;
  const costBasis = costPerGram * weight;
  const gainAmount = amount - costBasis;

  P.silver_sales.push({
    id: newId(), silverId: s.id, description: s.description, purity: s.purity,
    saleDate: date, weightSold: weight, salePricePerGram: rate,
    saleAmount: amount, costBasis, gainAmount
  });

  s.purchasePrice -= costBasis;
  s.weightGrams -= weight;
  if (s.weightGrams <= 0.0001) {
    P.silver = P.silver.filter(x => x.id !== s.id);
  }

  pSave();
  document.getElementById('silver-sell-modal').style.display = 'none';
  renderSilver();
  toast('Sale recorded ✓');
});

function deleteSilverSale(id) {
  if (!confirm('Remove this sale? The weight will be restored.')) return;
  const sale = P.silver_sales.find(x => x.id === id);
  if (!sale) return;
  const s = P.silver.find(x => x.id === sale.silverId);
  if (s) { s.weightGrams += sale.weightSold; s.purchasePrice += sale.costBasis; }
  else {
    P.silver.push({ id: sale.silverId, description: sale.description, purity: sale.purity, weightGrams: sale.weightSold, purchasePrice: sale.costBasis, purchaseDate: '' });
  }
  P.silver_sales = P.silver_sales.filter(x => x.id !== id);
  pSave(); renderSilver(); toast('Sale removed');
}

// Dismiss date picker on selection
document.querySelectorAll('input[type=date]').forEach(el => {
  el.addEventListener('change', function() { this.blur(); });
});

function initPortfolio(allData) {
  pLoad(allData);
  // Load saved API key from Firestore (overrides hardcoded default if user updated it)
  if (allData?.config?.goldApiKey) GOLDAPI_KEY = allData.config.goldApiKey;
}

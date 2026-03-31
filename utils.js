// ════════════════════════════════════════════════════════
//  UTILS — shared helpers
// ════════════════════════════════════════════════════════

function formatINR(n, compact = true) {
  if (n == null || isNaN(n)) return '—';
  const abs = Math.abs(n);
  if (compact) {
    if (abs >= 1e7) return '₹ ' + (n / 1e7).toFixed(2) + ' Cr';
    if (abs >= 1e5) return '₹ ' + (n / 1e5).toFixed(1) + ' L';
  }
  return '₹ ' + Math.round(n).toLocaleString('en-IN');
}

function formatINRFull(n) {
  if (n == null || isNaN(n)) return '—';
  return '₹ ' + Math.round(n).toLocaleString('en-IN');
}

function esc(s) {
  return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}

let _tt;
function toast(msg, ms = 2500) {
  const el = document.getElementById('toast');
  if (!el) return;
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(_tt);
  _tt = setTimeout(() => el.classList.remove('show'), ms);
}

function newId() {
  return crypto.randomUUID ? crypto.randomUUID() : 'id' + Date.now().toString(36) + Math.random().toString(36).slice(2);
}

function gainChip(val) {
  if (val == null || isNaN(val)) return '<span class="chip-n">—</span>';
  const pos = val >= 0;
  return `<span class="chip ${pos ? 'chip-g' : 'chip-r'}">${pos ? '+' : ''}${parseFloat(val).toFixed(2)}%</span>`;
}

function cagrChip(val, loading) {
  if (loading) return '<span class="sk" style="width:44px"></span>';
  if (val == null || isNaN(val)) return '<span class="chip-n">—</span>';
  const c = val >= 18 ? 'chip-g' : val >= 10 ? 'chip-a' : 'chip-r';
  return `<span class="chip ${c}">${parseFloat(val).toFixed(2)}%</span>`;
}

function retChip(val, loading) {
  if (loading) return '<span class="sk" style="width:40px"></span>';
  if (val == null || isNaN(val)) return '<span class="chip-n">—</span>';
  const c = val >= 0 ? 'chip-pct-pos' : 'chip-pct-neg';
  return `<span class="chip-pct ${c}">${val >= 0 ? '+' : ''}${parseFloat(val).toFixed(2)}%</span>`;
}

function totalRetChip(val, loading) {
  if (loading) return '<span class="sk" style="width:44px"></span>';
  if (val == null || isNaN(val)) return '<span class="chip-n">—</span>';
  const c = val >= 0 ? 'chip-pct-pos' : 'chip-pct-neg';
  return `<span class="chip-pct ${c}">${val >= 0 ? '+' : ''}${parseFloat(val).toFixed(1)}%</span>`;
}

function hlText(str, q) {
  const i = str.toLowerCase().indexOf(q.toLowerCase());
  if (i < 0) return esc(str);
  return esc(str.slice(0, i)) + '<strong>' + esc(str.slice(i, i + q.length)) + '</strong>' + esc(str.slice(i + q.length));
}

function computeCAGR(invested, current, purchaseDateStr) {
  if (!purchaseDateStr || !invested || !current || invested <= 0) return null;
  const days = (Date.now() - new Date(purchaseDateStr).getTime()) / 86400000;
  if (days < 30) return null;
  return (Math.pow(current / invested, 365 / days) - 1) * 100;
}

function fmtNav(v) { return v != null ? '₹ ' + parseFloat(v).toFixed(1) : '—'; }

function computeXIRR(cashflows) {
  // cashflows: [{amount, date}] — negative = outflow, positive = inflow
  if (!cashflows || cashflows.length < 2) return null;
  if (!cashflows.some(c => c.amount < 0)) return null;
  if (!cashflows.some(c => c.amount > 0)) return null;
  const ms   = cashflows.map(c => new Date(c.date).getTime());
  const vals = cashflows.map(c => c.amount);
  const t0   = ms[0];
  const yr   = 365.25 * 86400000;
  function xnpv(r) {
    return vals.reduce((s,v,i) => s + v / Math.pow(1+r, (ms[i]-t0)/yr), 0);
  }
  function dxnpv(r) {
    return vals.reduce((s,v,i) => {
      const y = (ms[i]-t0)/yr;
      return y === 0 ? s : s - y*v / Math.pow(1+r, y+1);
    }, 0);
  }
  let r = 0.1;
  for (let i = 0; i < 300; i++) {
    const f = xnpv(r), df = dxnpv(r);
    if (Math.abs(df) < 1e-12) break;
    const step = f/df;
    r -= step;
    if (r <= -1) r = -0.9999;
    if (Math.abs(step) < 1e-10) break;
  }
  return (isFinite(r) && r > -1) ? r * 100 : null;
}

function xirrChip(val, loading) {
  if (loading) return '<span class="sk" style="width:44px"></span>';
  if (val == null || isNaN(val)) return '<span class="chip-n">—</span>';
  const c = val >= 18 ? 'chip-g' : val >= 10 ? 'chip-a' : 'chip-r';
  return `<span class="chip ${c}">${val >= 0 ? '+' : ''}${parseFloat(val).toFixed(2)}%</span>`;
}

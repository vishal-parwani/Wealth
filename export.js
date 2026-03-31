// ════════════════════════════════════════════════════════
//  EXPORT MODULE — Excel export via SheetJS
// ════════════════════════════════════════════════════════

function exportToExcel() {
  if (typeof XLSX === 'undefined') { toast('Excel library not loaded yet, try again'); return; }

  const wb = XLSX.utils.book_new();
  const today = new Date().toISOString().slice(0,10);

  // ── Helper: append sheet safely ──
  function addSheet(name, rows) {
    const ws = XLSX.utils.aoa_to_sheet(rows);
    // Auto-width: set col widths based on max content length
    const maxLen = rows.reduce((acc, row) => {
      row.forEach((cell, i) => {
        const len = String(cell ?? '').length;
        if (!acc[i] || len > acc[i]) acc[i] = len;
      });
      return acc;
    }, []);
    ws['!cols'] = maxLen.map(w => ({ wch: Math.min(Math.max(w + 2, 8), 50) }));
    XLSX.utils.book_append_sheet(wb, ws, name);
  }

  // ── 1. Summary ──────────────────────────────────────
  {
    const rows = [
      ['Wealth Tracker Export', today],
      [],
      ['Asset Class', 'Invested (₹)', 'Current Value (₹)', 'Notional Gain (₹)', 'Gain %', 'Realised Gain (₹)'],
    ];
    const labels = ['Mutual Funds','Stocks','Gold','Silver','Real Estate','EPF','NPS'];
    const keys   = ['mf','stocks','gold','silver','real_estate','epf','nps'];
    keys.forEach((k, i) => {
      const inv = _sumInvested(k);
      const cur = _sumCurrent(k);
      const gain = cur - inv;
      const gainPct = inv > 0 ? ((gain / inv) * 100).toFixed(2) : '';
      const realised = _sumRealised(k);
      rows.push([labels[i], Math.round(inv), Math.round(cur), Math.round(gain), gainPct ? +gainPct : '', Math.round(realised)]);
    });
    addSheet('Summary', rows);
  }

  // ── 2. MF Holdings ──────────────────────────────────
  {
    const rows = [['Fund Name', 'Scheme Code', 'Units', 'Invested (₹)', 'Purchase Date']];
    P.mf_holdings.filter(h => (parseFloat(h.units)||0) > 0.0001).forEach(h => {
      rows.push([h.name, h.schemeCode, parseFloat(h.units), Math.round(parseFloat(h.invested)), h.purchaseDate || '']);
    });
    addSheet('MF Holdings', rows);
  }

  // ── 3. Stocks ───────────────────────────────────────
  {
    const rows = [['Name', 'Symbol', 'Exchange', 'Quantity', 'Avg Price (₹)', 'Invested (₹)', 'Purchase Date']];
    P.stocks.filter(s => (parseFloat(s.quantity)||0) > 0.0001).forEach(s => {
      const qty = parseFloat(s.quantity), avg = parseFloat(s.avgPrice);
      rows.push([s.name, s.symbol, s.exchange, qty, avg, Math.round(qty * avg), s.purchaseDate || '']);
    });
    addSheet('Stocks', rows);
  }

  // ── 4. Gold ─────────────────────────────────────────
  {
    const rows = [['Description', 'Purity', 'Weight (g)', 'Purchase Price (₹)', 'Purchase Date']];
    P.gold.filter(g => (parseFloat(g.weightGrams)||0) > 0.0001).forEach(g => {
      rows.push([g.description, g.purity, parseFloat(g.weightGrams), Math.round(parseFloat(g.purchasePrice)), g.purchaseDate || '']);
    });
    addSheet('Gold', rows);
  }

  // ── 5. Silver ───────────────────────────────────────
  {
    const rows = [['Description', 'Purity', 'Weight (g)', 'Purchase Price (₹)', 'Purchase Date']];
    P.silver.filter(s => (parseFloat(s.weightGrams)||0) > 0.0001).forEach(s => {
      rows.push([s.description, s.purity, parseFloat(s.weightGrams), Math.round(parseFloat(s.purchasePrice)), s.purchaseDate || '']);
    });
    addSheet('Silver', rows);
  }

  // ── 6. Real Estate ──────────────────────────────────
  {
    const rows = [['Property', 'Location', 'Purchase Price (₹)', 'Current Value (₹)', 'Purchase Date', 'Notes']];
    P.real_estate.forEach(r => {
      rows.push([r.name, r.location || '', Math.round(parseFloat(r.purchasePrice)), Math.round(parseFloat(r.currentValue)||parseFloat(r.purchasePrice)), r.purchaseDate || '', r.notes || '']);
    });
    addSheet('Real Estate', rows);
  }

  // ── 7. EPF ──────────────────────────────────────────
  {
    const rows = [
      ['Current Balance (₹)', Math.round(P.epf.currentBalance)],
      ['Interest Rate (%)', P.epf.interestRate],
      ['Last Updated', P.epf.lastUpdated || ''],
      [],
      ['Date', 'Type', 'Employee Contribution (₹)', 'Employer Contribution (₹)', 'Interest (₹)']
    ];
    (P.epf.transactions || []).forEach(t => {
      if (t.type === 'contribution') {
        rows.push([t.date, 'Contribution', Math.round(parseFloat(t.employeeAmount)||0), Math.round(parseFloat(t.employerAmount)||0), '']);
      } else {
        rows.push([t.date, 'Interest', '', '', Math.round(parseFloat(t.interestAmount)||0)]);
      }
    });
    addSheet('EPF', rows);
  }

  // ── 8. NPS ──────────────────────────────────────────
  {
    const rows = [
      ['Current Value (₹)', Math.round(P.nps.currentValue)],
      ['Scheme', P.nps.scheme || ''],
      ['Fund Manager', P.nps.fundManager || ''],
      ['Last Updated', P.nps.lastUpdated || ''],
      [],
      ['Date', 'Amount (₹)']
    ];
    (P.nps.transactions || []).forEach(t => {
      rows.push([t.date, Math.round(parseFloat(t.amount)||0)]);
    });
    addSheet('NPS', rows);
  }

  // ── 9. Sales (all assets) ───────────────────────────
  {
    const rows = [['Asset', 'Description / Fund', 'Sale Date', 'Units / Weight / Qty', 'Sale Amount (₹)', 'Cost Basis (₹)', 'Realised Gain (₹)', 'Gain %']];
    P.mf_sales.forEach(s => {
      const pct = s.costBasis > 0 ? ((s.gainAmount / s.costBasis) * 100).toFixed(2) : '';
      rows.push(['MF', s.fundName, s.saleDate, parseFloat(s.unitsSold), Math.round(s.saleAmount), Math.round(s.costBasis), Math.round(s.gainAmount), pct ? +pct : '']);
    });
    P.stock_sales.forEach(s => {
      const pct = s.costBasis > 0 ? ((s.gainAmount / s.costBasis) * 100).toFixed(2) : '';
      rows.push(['Stock', s.stockName + ' (' + s.symbol + ')', s.saleDate, s.qtySold, Math.round(s.saleAmount), Math.round(s.costBasis), Math.round(s.gainAmount), pct ? +pct : '']);
    });
    P.gold_sales.forEach(s => {
      const pct = s.costBasis > 0 ? ((s.gainAmount / s.costBasis) * 100).toFixed(2) : '';
      rows.push(['Gold', s.description + ' (' + s.purity + ')', s.saleDate, parseFloat(s.weightSold) + 'g', Math.round(s.saleAmount), Math.round(s.costBasis), Math.round(s.gainAmount), pct ? +pct : '']);
    });
    P.silver_sales.forEach(s => {
      const pct = s.costBasis > 0 ? ((s.gainAmount / s.costBasis) * 100).toFixed(2) : '';
      rows.push(['Silver', s.description + ' (' + s.purity + ')', s.saleDate, parseFloat(s.weightSold) + 'g', Math.round(s.saleAmount), Math.round(s.costBasis), Math.round(s.gainAmount), pct ? +pct : '']);
    });
    addSheet('Sales', rows);
  }

  // ── 10. Watchlist ───────────────────────────────────
  {
    const rows = [['Category', 'Fund Name', 'Scheme Code', 'Opinion', 'Allocation %']];
    (WL.categories || []).forEach(cat => {
      (cat.funds || []).forEach(f => {
        rows.push([cat.name, f.name, f.schemeCode, f.opinion || '', f.diversification || '']);
      });
    });
    addSheet('Watchlist', rows);
  }

  // ── Download ──────────────────────────────────────
  XLSX.writeFile(wb, `wealth-tracker-${today}.xlsx`);
  toast('Exported ✓');
}

// Helpers to compute totals from P data (sync, no live prices needed)
function _sumInvested(key) {
  if (key === 'mf')         return P.mf_holdings.reduce((s,h) => s+(parseFloat(h.invested)||0), 0);
  if (key === 'stocks')     return P.stocks.reduce((s,h) => s+(parseFloat(h.quantity)||0)*(parseFloat(h.avgPrice)||0), 0);
  if (key === 'gold')       return P.gold.reduce((s,h) => s+(parseFloat(h.purchasePrice)||0), 0);
  if (key === 'silver')     return P.silver.reduce((s,h) => s+(parseFloat(h.purchasePrice)||0), 0);
  if (key === 'real_estate')return P.real_estate.reduce((s,h) => s+(parseFloat(h.purchasePrice)||0), 0);
  if (key === 'epf')        return P.epf.transactions.filter(t=>t.type==='contribution').reduce((s,t)=>s+(parseFloat(t.employeeAmount)||0)+(parseFloat(t.employerAmount)||0),0);
  if (key === 'nps')        return P.nps.transactions.reduce((s,t)=>s+(parseFloat(t.amount)||0),0);
  return 0;
}
function _sumCurrent(key) {
  // For export we use invested as current (no live prices in export context)
  if (key === 'epf')        return parseFloat(P.epf.currentBalance)||0;
  if (key === 'nps')        return parseFloat(P.nps.currentValue)||0;
  if (key === 'real_estate')return P.real_estate.reduce((s,r)=>s+(parseFloat(r.currentValue)||parseFloat(r.purchasePrice)||0),0);
  return _sumInvested(key); // fallback: use invested when live prices not available
}
function _sumRealised(key) {
  if (key === 'mf')     return P.mf_sales.reduce((s,x)=>s+x.gainAmount,0);
  if (key === 'stocks') return P.stock_sales.reduce((s,x)=>s+x.gainAmount,0);
  if (key === 'gold')   return P.gold_sales.reduce((s,x)=>s+x.gainAmount,0);
  if (key === 'silver') return P.silver_sales.reduce((s,x)=>s+x.gainAmount,0);
  return 0;
}

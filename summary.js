// ════════════════════════════════════════════════════════
//  SUMMARY MODULE — net worth, charts, snapshots
// ════════════════════════════════════════════════════════

let summaryChart = null;
let historyChart = null;

const ASSET_LABELS  = ['Mutual Funds','Stocks','Gold','Silver','Real Estate','EPF','NPS'];
const ASSET_COLORS  = ['#5b7fa6','#82a882','#c8a882','#b0b0b0','#8295a8','#a882a0','#9082a8'];
const ASSET_KEYS    = ['mf','stocks','gold','silver','real_estate','epf','nps'];
const ASSET_TABS    = ['mf','stocks','gold','silver','realestate','epf','nps'];

async function renderSummary() {
  const el = document.getElementById('summary-content');
  if (!el) return;

  el.innerHTML = '<div style="padding:40px;text-align:center;color:var(--text3)">Loading portfolio values…</div>';

  // Filter to only active modules
  const activeSet = ACTIVE_MODULES ? new Set(ACTIVE_MODULES) : new Set(ASSET_TABS);
  const idx    = ASSET_TABS.map((t,i) => activeSet.has(t) ? i : -1).filter(i => i >= 0);
  const labels = idx.map(i => ASSET_LABELS[i]);
  const colors = idx.map(i => ASSET_COLORS[i]);
  const keys   = idx.map(i => ASSET_KEYS[i]);
  const tabs   = idx.map(i => ASSET_TABS[i]);

  let values;
  try { values = await getPortfolioValues(); }
  catch(e) { el.innerHTML = '<div class="empty-state">Could not load portfolio data.</div>'; return; }

  const totalInvested = keys.reduce((s,k)=>s+(values[k]?.invested||0),0);
  const totalCurrent  = keys.reduce((s,k)=>s+(values[k]?.current||0),0);
  const totalGain     = totalCurrent - totalInvested;
  const totalGainPct  = totalInvested > 0 ? (totalGain/totalInvested)*100 : 0;

  // Pie chart data
  const pieData = keys.map(k=>values[k]?.current||0);

  // Per-asset CAGR + XIRR
  const assetMetrics = keys.map(k => {
    const v = values[k];
    const flows = getAssetCashflows(k, v.current);
    const xirr  = computeXIRR(flows);
    const cagr  = flows.length >= 2 ? computeCAGR(v.invested, v.current, flows[0].date) : null;
    return { xirr, cagr };
  });

  // Summary table rows
  const tableRows = keys.map((k,i)=>{
    const v = values[k];
    const notionalGain = (v.current||0) - (v.invested||0);
    const notionalGainPct = v.invested > 0 ? (notionalGain/v.invested)*100 : 0;
    const realisedGain = v.realised || 0;
    const { xirr, cagr } = assetMetrics[i];
    return `<tr style="cursor:pointer" onclick="document.querySelector('.tab-btn[data-tab=${tabs[i]}]')?.click()">
      <td class="left">
        <span class="dot" style="background:${colors[i]}"></span>
        ${labels[i]}
      </td>
      <td>${formatINR(v.invested)}</td>
      <td>${formatINR(v.current)}</td>
      <td style="color:${notionalGain>=0?'var(--green)':'var(--red)'}">${notionalGain>=0?'+':''}${formatINR(notionalGain)}</td>
      <td>${gainChip(notionalGainPct)}</td>
      <td style="color:${realisedGain>=0?'var(--green)':'var(--red)'}">${realisedGain!==0?(realisedGain>=0?'+':'')+formatINR(realisedGain):'—'}</td>
      <td>${cagrChip(cagr, false)}</td>
      <td>${xirrChip(xirr, false)}</td>
    </tr>`;
  }).join('');

  // Load snapshots
  const snapshots = await loadSnapshots();

  el.innerHTML = `
    <div class="summary-grid">
      <!-- Net Worth Card -->
      <div class="networth-card">
        <div class="networth-label">Total Net Worth</div>
        <div class="networth-value">${formatINR(totalCurrent)}</div>
        <div class="networth-sub">
          <span style="color:var(--text2)">Invested: ${formatINR(totalInvested)}</span>
          <span class="chip ${totalGain>=0?'chip-g':'chip-r'}" style="margin-left:10px">
            ${totalGain>=0?'+':''}${formatINR(totalGain)} (${totalGainPct.toFixed(2)}%)
          </span>
        </div>
      </div>

      <!-- Pie Chart + Table -->
      <div class="summary-row">
        <div class="pie-wrap">
          <canvas id="summary-pie" width="220" height="220"></canvas>
        </div>
        <div class="summary-table-wrap">
          <table class="portfolio-table">
            <thead><tr>
              <th class="left">Asset Class</th>
              <th>Invested</th><th>Current Value</th>
              <th>Notional Gain</th><th>Gain%</th><th>Realised Gain</th><th>CAGR</th><th>XIRR</th>
            </tr></thead>
            <tbody>${tableRows}</tbody>
            <tfoot><tr class="totals-row">
              <td class="left"><strong>Total</strong></td>
              <td><strong>${formatINR(totalInvested)}</strong></td>
              <td><strong>${formatINR(totalCurrent)}</strong></td>
              <td><strong style="color:${totalGain>=0?'var(--green)':'var(--red)'}">
                ${totalGain>=0?'+':''}${formatINR(totalGain)}
              </strong></td>
              <td>${gainChip(totalGainPct)}</td>
              <td></td><td></td><td></td>
            </tr></tfoot>
          </table>
        </div>
      </div>

      <!-- History Chart -->
      ${snapshots.length > 1 ? `
      <div class="history-card">
        <div class="history-header">
          <h3 class="section-title">Net Worth Over Time</h3>
        </div>
        <canvas id="history-chart" height="100"></canvas>
      </div>` : ''}

      <!-- Snapshot info + Export -->
      <div class="snapshot-row">
        <span style="font-size:.78rem;color:var(--text3)">
          ${snapshots.length} snapshot${snapshots.length!==1?'s':''} saved &nbsp;·&nbsp; auto-saved on 1st of each month
        </span>
        <button class="btn btn-sm" id="btn-export-excel" style="margin-left:auto">⬇ Export to Excel</button>
      </div>
    </div>`;

  // Draw pie chart
  const pieCtx = document.getElementById('summary-pie')?.getContext('2d');
  if (pieCtx) {
    if (summaryChart) summaryChart.destroy();
    summaryChart = new Chart(pieCtx, {
      type: 'doughnut',
      data: {
        labels: labels,
        datasets: [{ data: pieData, backgroundColor: colors, borderWidth: 2, borderColor: '#fff' }]
      },
      options: {
        plugins: {
          legend: { position: 'right', labels: { font: { size: 11 }, boxWidth: 12, padding: 10 } },
          tooltip: {
            callbacks: {
              label: ctx => ' ' + ctx.label + ': ' + formatINR(ctx.raw)
            }
          }
        },
        cutout: '55%'
      }
    });
  }

  // Draw history chart
  if (snapshots.length > 1) {
    const histCtx = document.getElementById('history-chart')?.getContext('2d');
    if (histCtx) {
      if (historyChart) historyChart.destroy();
      const labels = snapshots.map(s=>s.date);
      const datasets = [
        { label:'Total', data: snapshots.map(s=>s.total), borderColor:'#5b7fa6', backgroundColor:'rgba(91,127,166,.12)', fill:true, tension:.3, pointRadius:3 },
        ...keys.map((k,i)=>({
          label: labels[i],
          data: snapshots.map(s=>s[k]||0),
          borderColor: colors[i],
          backgroundColor: 'transparent',
          tension:.3, pointRadius:2,
          borderWidth: 1.5
        }))
      ];
      historyChart = new Chart(histCtx, {
        type: 'line',
        data: { labels, datasets },
        options: {
          responsive: true,
          plugins: {
            legend: { position: 'bottom', labels: { font:{ size:10 }, boxWidth:10 } },
            tooltip: { callbacks: { label: ctx => ' '+ctx.dataset.label+': '+formatINR(ctx.raw) } }
          },
          scales: {
            y: { ticks: { callback: v=>formatINR(v) } }
          }
        }
      });
    }
  }

  // Export button
  document.getElementById('btn-export-excel')?.addEventListener('click', exportToExcel);


  // Auto-snapshot: save on the 1st of each month, after 9 AM, once per month
  const now = new Date();
  const today = now.toISOString().slice(0,10);
  const isFirstOfMonth = now.getDate() === 1;
  const isPastNineAM   = now.getHours() >= 9;
  const thisMonth = today.slice(0, 7); // YYYY-MM
  const alreadySavedThisMonth = snapshots.some(s => s.date.slice(0, 7) === thisMonth);
  if (isFirstOfMonth && isPastNineAM && !alreadySavedThisMonth) {
    autoSaveSnapshot(values, today, snapshots).catch(()=>{});
  }
}

// ── SNAPSHOTS ─────────────────────────────────────────
async function loadSnapshots() {
  try {
    const snap = await DASH_REF.get();
    return snap.exists ? (snap.data().snapshots || []) : [];
  } catch(e) { return []; }
}

async function autoSaveSnapshot(values, today, existingSnapshots) {
  const snapshot = {
    date: today,
    mf:          Math.round(values.mf?.current          || 0),
    stocks:      Math.round(values.stocks?.current      || 0),
    gold:        Math.round(values.gold?.current        || 0),
    silver:      Math.round(values.silver?.current      || 0),
    real_estate: Math.round(values.real_estate?.current || 0),
    epf:         Math.round(values.epf?.current         || 0),
    nps:         Math.round(values.nps?.current         || 0),
    total:       Math.round(values.total || 0)
  };
  const filtered = existingSnapshots.filter(s => s.date !== today);
  filtered.push(snapshot);
  const trimmed = filtered.sort((a,b) => a.date.localeCompare(b.date)).slice(-100);
  await DASH_REF.set({ snapshots: trimmed }, { merge: true });
}

function initSummary() {
  // Nothing to preload — renderSummary fetches fresh data
}

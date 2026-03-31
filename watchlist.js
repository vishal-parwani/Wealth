// ════════════════════════════════════════════════════════
//  WATCHLIST MODULE
// ════════════════════════════════════════════════════════

const ALL_COLS = [
  { id:'ret1d',  label:'1D Ret',   labelTotal:'1D Ret',   group:'returns', defaultOn:true,  sortKey:'ret1d'  },
  { id:'ret1w',  label:'1W Ret',   labelTotal:'1W Ret',   group:'returns', defaultOn:true,  sortKey:'ret1w'  },
  { id:'ret1m',  label:'1M Ret',   labelTotal:'1M Ret',   group:'returns', defaultOn:true,  sortKey:'ret1m'  },
  { id:'ret6m',  label:'6M Ret',   labelTotal:'6M Ret',   group:'returns', defaultOn:true,  sortKey:'ret6m'  },
  { id:'nav1y',  label:'1Y CAGR',  labelTotal:'1Y Total', group:'returns', defaultOn:true,  sortKey:'nav1y'  },
  { id:'nav3y',  label:'3Y CAGR',  labelTotal:'3Y Total', group:'returns', defaultOn:true,  sortKey:'nav3y'  },
  { id:'nav5y',  label:'5Y CAGR',  labelTotal:'5Y Total', group:'returns', defaultOn:true,  sortKey:'nav5y'  },
  { id:'navAll', label:'All Time', labelTotal:'All Time', group:'returns', defaultOn:true,  sortKey:'navAll' },
  { id:'nav',    label:'NAV',      labelTotal:'NAV',      group:'other',   defaultOn:true,  sortKey:'nav'    },
  { id:'opinion',label:'Opinion',  labelTotal:'Opinion',  group:'other',   defaultOn:true,  sortKey:'opinion'},
];
const CAT_COLORS = ['#c8a882','#82a882','#8295a8','#a882a0','#9082a8','#a8a264','#82a8a5','#b08060'];

let WL = {
  categories:[], navCache:{}, lastRefresh:null, colVisible:{},
  globalSort:{col:null,dir:1}, returnMode:'cagr',
  stocks: [], stockPrices: {}, stockLastRefresh: null
};
let _wlUid = Date.now();
function wlUid() { return 'c'+(++_wlUid)+'_'+Math.random().toString(36).slice(2,5); }
function wlInitCols() { ALL_COLS.forEach(c => { WL.colVisible[c.id] = c.defaultOn; }); }

function wlSave() {
  saveNavCache(WL.navCache);
  saveSection('watchlist', {
    categories: WL.categories,
    colVisible: WL.colVisible,
    globalSort: WL.globalSort,
    returnMode: WL.returnMode,
    lastRefresh: WL.lastRefresh,
    stocks: WL.stocks,
    stockLastRefresh: WL.stockLastRefresh
  });
}

function wlLoadState(data) {
  WL.navCache = getNavCache();
  // Support both old format (root-level categories) and new (under 'watchlist')
  const p = data?.watchlist || (data?.categories ? data : null);
  if (p) {
    WL.categories = (p.categories||[]).map(c=>({
      id:c.id, name:c.name, collapsed:!!c.collapsed,
      sortCol:c.sortCol||null, sortDir:c.sortDir||1,
      funds:(c.funds||[]).map(f=>({
        schemeCode:String(f.schemeCode), name:f.name,
        opinion:f.opinion||'', diversification:f.diversification||''
      }))
    }));
    WL.colVisible  = p.colVisible||{};
    WL.globalSort  = p.globalSort||{col:null,dir:1};
    WL.returnMode  = p.returnMode||'cagr';
    WL.lastRefresh = p.lastRefresh||null;
    WL.stocks = p.stocks || [];
    WL.stockLastRefresh = p.stockLastRefresh || null;
  }
  ALL_COLS.forEach(c => { if (WL.colVisible[c.id]===undefined) WL.colVisible[c.id]=c.defaultOn; });
}

// ── MFAPI ──────────────────────────────────────────────
// Use search endpoint instead of loading all ~14k funds (too large for Safari fetch)
async function searchFunds(query) {
  try {
    const r = await fetch('https://api.mfapi.in/mf/search?q=' + encodeURIComponent(query));
    if (r.ok) return await r.json();
  } catch(e) { console.warn('Fund search failed', e); }
  return [];
}

async function fetchNav(schemeCode) {
  try {
    const r = await fetch('https://api.mfapi.in/mf/'+schemeCode);
    if (!r.ok) return null;
    const d = await r.json();
    if (d.status!=='SUCCESS'||!d.data?.length) return null;
    const data = d.data;
    const nav = parseFloat(data[0].nav);
    function cagr(days){
      const i=Math.min(days,data.length-1);
      if(i<Math.round(days*0.85)) return null;
      const old=parseFloat(data[i].nav);
      if(!old||old<=0) return null;
      return (Math.pow(nav/old,365/days)-1)*100;
    }
    function pct(days){
      if(data.length<=days) return null;
      const old=parseFloat(data[days].nav);
      if(!old||old<=0) return null;
      return (nav/old-1)*100;
    }
    function totalRet(days){
      const i=Math.min(days,data.length-1);
      if(i<Math.round(days*0.85)) return null;
      const old=parseFloat(data[i].nav);
      if(!old||old<=0) return null;
      return (nav/old-1)*100;
    }
    const oldest=parseFloat(data[data.length-1].nav);
    const totalDays=data.length-1;
    const navAllCagr=(oldest>0&&totalDays>30)?(Math.pow(nav/oldest,365/totalDays)-1)*100:null;
    const navAllTotal=(oldest>0&&totalDays>30)?(nav/oldest-1)*100:null;
    return {
      nav, date:data[0].date,
      nav1y:cagr(365), nav3y:cagr(1095), nav5y:cagr(1825),
      navAllCagr, navAllTotal,
      tot1y:totalRet(365), tot3y:totalRet(1095), tot5y:totalRet(1825),
      ret1d:pct(1), ret1w:pct(7), ret1m:pct(30), ret6m:pct(182)
    };
  } catch(e) { return null; }
}

async function refreshNav(forceAll) {
  const codes=[];
  WL.categories.forEach(c=>c.funds.forEach(f=>{
    const cached=WL.navCache[f.schemeCode];
    if(forceAll||!cached||cached.loading) codes.push(f.schemeCode);
  }));
  if(!codes.length){ wlRenderAll(); updateRefreshLabel(); return; }
  const unique=[...new Set(codes)];
  unique.forEach(c=>{ WL.navCache[c]={loading:true}; });
  wlRenderAll();
  await Promise.all(unique.map(async code=>{
    const d=await fetchNav(code);
    WL.navCache[code]=d;
  }));
  WL.lastRefresh=new Date().toISOString();
  wlSave(); wlRenderAll(); updateRefreshLabel();
}

function updateRefreshLabel() {
  const el=document.getElementById('refresh-ts');
  if(!el) return;
  if(!WL.lastRefresh){ el.textContent='Never refreshed'; return; }
  const d=new Date(WL.lastRefresh);
  el.textContent='Updated '+d.toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'})+', '+d.toLocaleDateString([],{day:'numeric',month:'short'});
}

// ── PILL TOGGLE ───────────────────────────────────────
function updatePillUI() {
  const isTotal=WL.returnMode==='total';
  const track=document.getElementById('pill-toggle');
  if(!track) return;
  track.classList.toggle('on',isTotal);
  document.getElementById('pill-lbl-cagr').classList.toggle('active',!isTotal);
  document.getElementById('pill-lbl-total').classList.toggle('active',isTotal);
}
document.getElementById('pill-toggle').addEventListener('click',()=>{
  WL.returnMode=WL.returnMode==='cagr'?'total':'cagr';
  wlSave(); updatePillUI(); wlRenderAll();
});

// ── SEARCH ────────────────────────────────────────────
const elSearch=document.getElementById('search-input');
const elResults=document.getElementById('search-results');
const elClear=document.getElementById('search-clear');
let searchTimer;

elSearch.addEventListener('input',()=>{
  const q=elSearch.value.trim();
  elClear.style.display=q?'block':'none';
  clearTimeout(searchTimer);
  if(!q){ elResults.classList.remove('open'); return; }
  searchTimer=setTimeout(()=>doSearch(q),220);
});
elClear.addEventListener('click',()=>{ elSearch.value=''; elClear.style.display='none'; elResults.classList.remove('open'); });
document.addEventListener('click',e=>{ if(!document.getElementById('search-wrap').contains(e.target)) elResults.classList.remove('open'); });

async function doSearch(q) {
  elResults.innerHTML='<div class="sr-no-result">Searching…</div>';
  elResults.classList.add('open');
  const hits = await searchFunds(q);
  if (!hits.length) {
    elResults.innerHTML='<div class="sr-no-result">No results found</div>';
    return;
  }
  elResults.innerHTML=hits.map(f=>`
    <div class="sr-item">
      <div style="flex:1;min-width:0">
        <div class="sr-name">${hlText(f.schemeName,q)}</div>
        <div class="sr-code">${esc(f.schemeCode)}</div>
      </div>
      <button class="btn-add-sr" data-code="${esc(f.schemeCode)}" data-name="${esc(f.schemeName)}">+ Add</button>
    </div>`).join('');
  elResults.querySelectorAll('.btn-add-sr').forEach(btn=>
    btn.addEventListener('click',e=>{ e.stopPropagation(); openAddModal(btn.dataset.code,btn.dataset.name); })
  );
  elResults.classList.add('open');
}

// ── SETTINGS ──────────────────────────────────────────
function buildSettings() {
  function makeToggle(col) {
    const lbl=WL.returnMode==='total'?col.labelTotal:col.label;
    return `<div class="col-toggle"><label><input type="checkbox" data-colid="${col.id}" ${WL.colVisible[col.id]?'checked':''}> ${lbl}</label></div>`;
  }
  document.getElementById('col-toggles-returns').innerHTML=ALL_COLS.filter(c=>c.group==='returns').map(makeToggle).join('');
  document.getElementById('col-toggles-other').innerHTML=ALL_COLS.filter(c=>c.group==='other').map(makeToggle).join('');
  document.querySelectorAll('#settings-panel input[type=checkbox]').forEach(cb=>{
    cb.addEventListener('change',()=>{ WL.colVisible[cb.dataset.colid]=cb.checked; wlSave(); wlRenderAll(); });
  });
}
document.getElementById('btn-settings').addEventListener('click',()=>{
  document.getElementById('settings-panel').classList.add('open');
  document.getElementById('settings-overlay').classList.add('open');
  buildSettings();
});
document.getElementById('settings-close').addEventListener('click',closeSettings);
document.getElementById('settings-overlay').addEventListener('click',closeSettings);
function closeSettings(){
  document.getElementById('settings-panel').classList.remove('open');
  document.getElementById('settings-overlay').classList.remove('open');
}

// ── ADD MODAL ─────────────────────────────────────────
let pendingFund=null;
function openAddModal(code,name) {
  pendingFund={schemeCode:String(code),name:String(name)};
  document.getElementById('add-modal-sub').textContent=name;
  const sel=document.getElementById('add-cat-sel');
  sel.innerHTML='';
  WL.categories.forEach(c=>sel.add(new Option(c.name,c.id)));
  sel.add(new Option('+ Create new category','__new__'));
  sel.add(new Option('Uncategorised','__uncat__'));
  sel.value=WL.categories.length?WL.categories[0].id:'__uncat__';
  document.getElementById('add-new-wrap').classList.remove('visible');
  document.getElementById('add-new-name').value='';
  document.getElementById('add-modal').style.display='flex';
  elResults.classList.remove('open');
}
document.getElementById('add-cat-sel').addEventListener('change',function(){
  const wrap=document.getElementById('add-new-wrap');
  if(this.value==='__new__'){ wrap.classList.add('visible'); document.getElementById('add-new-name').focus(); }
  else { wrap.classList.remove('visible'); }
});
document.getElementById('add-cancel').addEventListener('click',closeAdd);
document.getElementById('add-modal').addEventListener('click',e=>{ if(e.target===e.currentTarget) closeAdd(); });
function closeAdd(){ document.getElementById('add-modal').style.display='none'; pendingFund=null; }

document.getElementById('add-confirm').addEventListener('click',()=>{
  if(!pendingFund) return;
  const sel=document.getElementById('add-cat-sel');
  let catId=sel.value;
  if(catId==='__new__'){
    const nm=document.getElementById('add-new-name').value.trim();
    if(!nm){ toast('Enter a category name'); document.getElementById('add-new-name').focus(); return; }
    catId=wlCreateCat(nm);
  } else if(catId==='__uncat__'){
    catId=wlEnsureUncat();
  }
  const cat=WL.categories.find(c=>c.id===catId);
  if(!cat){ toast('Category not found'); return; }
  if(cat.funds.find(f=>f.schemeCode===pendingFund.schemeCode)){ toast('Fund already in this category'); return; }
  cat.funds.push({schemeCode:pendingFund.schemeCode,name:pendingFund.name,opinion:'',diversification:''});
  const code=pendingFund.schemeCode;
  if(!WL.navCache[code]||!WL.navCache[code].nav) WL.navCache[code]={loading:true};
  wlSave(); closeAdd(); wlRenderAll(); toast('Fund added ✓');
  fetchNav(code).then(d=>{ WL.navCache[code]=d||null; wlSave(); wlRenderAll(); });
});

function wlCreateCat(name){
  const cat={id:wlUid(),name,collapsed:false,sortCol:null,sortDir:1,funds:[]};
  WL.categories.push(cat); return cat.id;
}
function wlEnsureUncat(){
  let c=WL.categories.find(c=>c.id==='uncat');
  if(!c){ c={id:'uncat',name:'Uncategorised',collapsed:false,sortCol:null,sortDir:1,funds:[]}; WL.categories.push(c); }
  return c.id;
}

// ── MOVE MODAL ────────────────────────────────────────
let movePending=null;
function openMoveModal(fromCatId,schemeCode){
  const fromCat=WL.categories.find(c=>c.id===fromCatId);
  const fund=fromCat?.funds.find(f=>f.schemeCode===schemeCode);
  if(!fromCat||!fund) return;
  movePending={fromCatId,schemeCode};
  document.getElementById('move-modal-sub').textContent=fund.name;
  const sel=document.getElementById('move-cat-sel');
  sel.innerHTML='';
  WL.categories.filter(c=>c.id!==fromCatId).forEach(c=>sel.add(new Option(c.name,c.id)));
  sel.add(new Option('+ Create new category','__new__'));
  document.getElementById('move-new-wrap').classList.remove('visible');
  document.getElementById('move-new-name').value='';
  document.getElementById('move-modal').style.display='flex';
}
document.getElementById('move-cat-sel').addEventListener('change',function(){
  const wrap=document.getElementById('move-new-wrap');
  if(this.value==='__new__'){ wrap.classList.add('visible'); document.getElementById('move-new-name').focus(); }
  else { wrap.classList.remove('visible'); }
});
document.getElementById('move-cancel').addEventListener('click',closeMove);
document.getElementById('move-modal').addEventListener('click',e=>{ if(e.target===e.currentTarget) closeMove(); });
function closeMove(){ document.getElementById('move-modal').style.display='none'; movePending=null; }

document.getElementById('move-confirm').addEventListener('click',()=>{
  if(!movePending) return;
  const {fromCatId,schemeCode}=movePending;
  let toCatId=document.getElementById('move-cat-sel').value;
  if(toCatId==='__new__'){
    const nm=document.getElementById('move-new-name').value.trim();
    if(!nm){ toast('Enter a category name'); document.getElementById('move-new-name').focus(); return; }
    toCatId=wlCreateCat(nm);
  }
  const fromCat=WL.categories.find(c=>c.id===fromCatId);
  const toCat=WL.categories.find(c=>c.id===toCatId);
  if(!fromCat||!toCat) return;
  const idx=fromCat.funds.findIndex(f=>f.schemeCode===schemeCode);
  if(idx<0) return;
  const [fund]=fromCat.funds.splice(idx,1);
  if(!toCat.funds.find(f=>f.schemeCode===schemeCode)) toCat.funds.push(fund);
  wlSave(); wlRenderAll(); closeMove(); toast('Fund moved ✓');
});

// ── DELETE CATEGORY MODAL ─────────────────────────────
let delCatPending=null;
function deleteCat(catId){
  const cat=WL.categories.find(c=>c.id===catId);
  if(!cat) return;
  if(cat.funds.length===0){
    WL.categories=WL.categories.filter(c=>c.id!==catId);
    wlSave(); wlRenderAll(); toast('Category deleted'); return;
  }
  delCatPending=catId;
  document.getElementById('del-cat-title').textContent='Delete "'+cat.name+'"';
  document.getElementById('del-cat-sub').textContent='This category has '+cat.funds.length+' fund'+(cat.funds.length!==1?'s':'')+'. What would you like to do with them?';
  const sel=document.getElementById('del-cat-move-sel');
  sel.innerHTML='';
  WL.categories.filter(c=>c.id!==catId).forEach(c=>sel.add(new Option(c.name,c.id)));
  sel.add(new Option('+ Create new category','__new__'));
  document.getElementById('del-new-wrap').classList.remove('visible');
  document.getElementById('del-new-name').value='';
  document.querySelector('input[name="del-cat-action"][value="move"]').checked=true;
  document.getElementById('del-move-target').style.display='block';
  document.getElementById('del-cat-modal').style.display='flex';
}
document.querySelectorAll('input[name="del-cat-action"]').forEach(radio=>{
  radio.addEventListener('change',()=>{
    document.getElementById('del-move-target').style.display=
      document.querySelector('input[name="del-cat-action"]:checked').value==='move'?'block':'none';
  });
});
document.getElementById('del-cat-move-sel').addEventListener('change',function(){
  const wrap=document.getElementById('del-new-wrap');
  if(this.value==='__new__'){ wrap.classList.add('visible'); document.getElementById('del-new-name').focus(); }
  else { wrap.classList.remove('visible'); }
});
document.getElementById('del-cat-cancel').addEventListener('click',closeDelCat);
document.getElementById('del-cat-modal').addEventListener('click',e=>{ if(e.target===e.currentTarget) closeDelCat(); });
function closeDelCat(){ document.getElementById('del-cat-modal').style.display='none'; delCatPending=null; }

document.getElementById('del-cat-confirm').addEventListener('click',()=>{
  if(!delCatPending) return;
  const action=document.querySelector('input[name="del-cat-action"]:checked').value;
  const cat=WL.categories.find(c=>c.id===delCatPending);
  if(!cat){ closeDelCat(); return; }
  if(action==='move'){
    let toCatId=document.getElementById('del-cat-move-sel').value;
    if(toCatId==='__new__'){
      const nm=document.getElementById('del-new-name').value.trim();
      if(!nm){ toast('Enter a category name'); document.getElementById('del-new-name').focus(); return; }
      toCatId=wlCreateCat(nm);
    }
    const toCat=WL.categories.find(c=>c.id===toCatId);
    if(!toCat){ toast('Target category not found'); return; }
    cat.funds.forEach(f=>{ if(!toCat.funds.find(ef=>ef.schemeCode===f.schemeCode)) toCat.funds.push(f); });
    toast('Funds moved, category deleted');
  } else { toast('Category deleted'); }
  WL.categories=WL.categories.filter(c=>c.id!==delCatPending);
  wlSave(); wlRenderAll(); closeDelCat();
});

// ── CATEGORY OPS ──────────────────────────────────────
function catUp(catId){
  const i=WL.categories.findIndex(c=>c.id===catId);
  if(i<=0) return;
  [WL.categories[i-1],WL.categories[i]]=[WL.categories[i],WL.categories[i-1]];
  wlSave(); wlRenderAll();
}
function catDown(catId){
  const i=WL.categories.findIndex(c=>c.id===catId);
  if(i<0||i>=WL.categories.length-1) return;
  [WL.categories[i],WL.categories[i+1]]=[WL.categories[i+1],WL.categories[i]];
  wlSave(); wlRenderAll();
}
function toggleCollapse(catId){
  const cat=WL.categories.find(c=>c.id===catId);
  if(cat){ cat.collapsed=!cat.collapsed; wlSave(); wlRenderAll(); }
}
function renameCat(catId,name){ const cat=WL.categories.find(c=>c.id===catId); if(cat&&name.trim()){ cat.name=name.trim(); wlSave(); } }

// ── FUND OPS ──────────────────────────────────────────
function deleteFund(catId,schemeCode){
  const cat=WL.categories.find(c=>c.id===catId);
  if(!cat) return;
  const fund=cat.funds.find(f=>f.schemeCode===schemeCode);
  if(!fund) return;
  const short=fund.name.length>55?fund.name.slice(0,55)+'…':fund.name;
  if(!confirm('Remove "'+short+'"?')) return;
  cat.funds=cat.funds.filter(f=>f.schemeCode!==schemeCode);
  wlSave(); wlRenderAll(); toast('Fund removed');
}
function setOpinion(catId,sc,val,sel){
  const cat=WL.categories.find(c=>c.id===catId);
  const f=cat?.funds.find(f=>f.schemeCode===sc);
  if(!f) return; f.opinion=val; wlSave();
  sel.className='op-sel'+(val==='Strong Yes'?' op-strong':val==='Ok'?' op-ok':'');
}
// ── SORT ──────────────────────────────────────────────
function wlGlobalSort(col){
  if(WL.globalSort.col===col){ WL.globalSort.dir*=-1; }
  else { WL.globalSort.col=col; WL.globalSort.dir=-1; }
  const dir=WL.globalSort.dir;
  WL.categories.forEach(cat=>{
    cat.sortCol=col; cat.sortDir=dir;
    cat.funds.sort((a,b)=>{
      const na=WL.navCache[a.schemeCode]||{}, nb=WL.navCache[b.schemeCode]||{};
      let av,bv;
      if(col==='name'){ av=a.name.toLowerCase(); bv=b.name.toLowerCase(); }
      else if(col==='nav'){ av=parseFloat(na.nav)||0; bv=parseFloat(nb.nav)||0; }
      else if(col==='nav1y'){ av=parseFloat(WL.returnMode==='total'?(na.tot1y??na.nav1y):na.nav1y)||0; bv=parseFloat(WL.returnMode==='total'?(nb.tot1y??nb.nav1y):nb.nav1y)||0; }
      else if(col==='nav3y'){ av=parseFloat(WL.returnMode==='total'?(na.tot3y??na.nav3y):na.nav3y)||0; bv=parseFloat(WL.returnMode==='total'?(nb.tot3y??nb.nav3y):nb.nav3y)||0; }
      else if(col==='nav5y'){ av=parseFloat(WL.returnMode==='total'?(na.tot5y??na.nav5y):na.nav5y)||0; bv=parseFloat(WL.returnMode==='total'?(nb.tot5y??nb.nav5y):nb.nav5y)||0; }
      else if(col==='navAll'){ av=parseFloat(WL.returnMode==='total'?na.navAllTotal:na.navAllCagr)||0; bv=parseFloat(WL.returnMode==='total'?nb.navAllTotal:nb.navAllCagr)||0; }
      else if(['ret1d','ret1w','ret1m','ret6m'].includes(col)){ av=parseFloat(na[col])||0; bv=parseFloat(nb[col])||0; }
      else if(col==='opinion'){ const o={'Strong Yes':2,'Ok':1,'':0}; av=o[a.opinion]??0; bv=o[b.opinion]??0; }
      else { av=0; bv=0; }
      return av<bv?-dir:av>bv?dir:0;
    });
  });
  wlSave(); wlRenderAll();
}

// ── RENDER ────────────────────────────────────────────
function wlVisCols(){ return ALL_COLS.filter(c=>WL.colVisible[c.id]); }
function wlGetColLabel(c){ return WL.returnMode==='total'?c.labelTotal:c.label; }

function wlRenderAll(){
  const hasCats=WL.categories.length>0;
  document.getElementById('wl-no-cats').style.display=hasCats?'none':'block';
  document.getElementById('table-wrap').style.display=hasCats?'block':'none';
  if(!hasCats) return;
  const vc=wlVisCols();
  const isTotal=WL.returnMode==='total';
  const gs=WL.globalSort;
  const theadRow=document.getElementById('thead-row');
  const minWidths={ret1d:68,ret1w:68,ret1m:68,ret6m:68,nav1y:74,nav3y:74,nav5y:74,navAll:74,nav:68,opinion:90,div:72};

  let thHtml=`<th class="left no-sort" style="padding-left:10px;min-width:30px;width:30px"></th>`
    +`<th class="left col-name sortable${gs.col==='name'?' sorted':''}" data-sort="name" style="min-width:180px">Fund Name <span class="sort-arr">${gs.col==='name'?(gs.dir===1?'▲':'▼'):'▾'}</span></th>`;
  vc.forEach(c=>{
    const isSorted=gs.col===c.sortKey;
    const arrow=isSorted?(gs.dir===1?'▲':'▼'):'▾';
    const mw=minWidths[c.id]||74;
    thHtml+=`<th class="sortable${isSorted?' sorted':''}" data-sort="${c.sortKey}" data-col="${c.id}" style="min-width:${mw}px">${wlGetColLabel(c)} <span class="sort-arr">${arrow}</span></th>`;
  });
  thHtml+=`<th class="no-sort" style="width:44px"></th>`;
  theadRow.innerHTML=thHtml;
  theadRow.querySelectorAll('th.sortable').forEach(th=>{
    th.addEventListener('click',()=>wlGlobalSort(th.dataset.sort));
  });

  const tbody=document.getElementById('tbody');
  let html='';
  const totalCols=3+vc.length;
  WL.categories.forEach((cat,idx)=>{
    const color=CAT_COLORS[idx%CAT_COLORS.length];
    html+=`
    <tr class="cat-group-row${cat.collapsed?' collapsed':''}" data-catid="${esc(cat.id)}">
      <td colspan="${totalCols}" style="padding:0">
        <div class="cat-group-inner" data-ev="toggle" data-cat="${esc(cat.id)}">
          <div class="cat-dot" style="background:${color}"></div>
          <input class="cat-name-edit" value="${esc(cat.name)}" data-ev="rename" data-cat="${esc(cat.id)}">
          <span class="cat-count">${cat.funds.length} fund${cat.funds.length!==1?'s':''}</span>
          <span class="cat-chevron">▾</span>
          <div class="cat-menu-wrap">
            <button class="cat-menu-btn" data-ev="cat-menu" data-cat="${esc(cat.id)}" title="Options">⋯</button>
            <div class="cat-menu-dropdown" id="cat-menu-${esc(cat.id)}">
              <button class="cat-menu-item" data-ev="cat-up"  data-cat="${esc(cat.id)}">↑ Move up</button>
              <button class="cat-menu-item" data-ev="cat-down" data-cat="${esc(cat.id)}">↓ Move down</button>
              <div class="cat-menu-sep"></div>
              <button class="cat-menu-item danger" data-ev="del-cat" data-cat="${esc(cat.id)}">🗑 Delete</button>
            </div>
          </div>
        </div>
      </td>
    </tr>`;
    if(cat.funds.length===0){
      html+=`<tr class="cat-empty-row" data-catid="${esc(cat.id)}"${cat.collapsed?' style="display:none"':''}>
        <td colspan="${totalCols}">No funds yet — search and add funds above</td></tr>`;
    } else {
      cat.funds.forEach((f,i)=>{
        const nav=WL.navCache[f.schemeCode];
        const loading=nav?.loading===true;
        const noData=!nav||nav.loading;
        const dynTd=vc.map(c=>{
          const cid=c.id; let cell='';
          if(cid==='nav'){
            cell=loading?'<span class="sk" style="width:52px"></span>':nav?.nav!=null?`<span class="nav-val">${fmtNav(nav.nav)}</span>`:'<span class="chip-n">—</span>';
          } else if(cid==='nav1y'){
            if(isTotal) cell=totalRetChip(noData?null:(nav?.tot1y??nav?.nav1y),loading);
            else cell=cagrChip(noData?null:nav?.nav1y,loading);
          } else if(cid==='nav3y'){
            if(isTotal) cell=totalRetChip(noData?null:nav?.tot3y,loading);
            else cell=cagrChip(noData?null:nav?.nav3y,loading);
          } else if(cid==='nav5y'){
            if(isTotal) cell=totalRetChip(noData?null:nav?.tot5y,loading);
            else cell=cagrChip(noData?null:nav?.nav5y,loading);
          } else if(cid==='navAll'){
            if(isTotal) cell=totalRetChip(noData?null:nav?.navAllTotal,loading);
            else cell=cagrChip(noData?null:nav?.navAllCagr,loading);
          } else if(['ret1d','ret1w','ret1m','ret6m'].includes(cid)){
            cell=retChip(noData?null:nav?.[cid],loading);
          } else if(cid==='opinion'){
            const opCls=f.opinion==='Strong Yes'?'op-strong':f.opinion==='Ok'?'op-ok':'';
            cell=`<select class="op-sel ${opCls}" data-ev="opinion" data-cat="${esc(cat.id)}" data-code="${esc(f.schemeCode)}">
              <option value=""${f.opinion===''?' selected':''}>—</option>
              <option value="Ok"${f.opinion==='Ok'?' selected':''}>Ok</option>
              <option value="Strong Yes"${f.opinion==='Strong Yes'?' selected':''}>Strong Yes</option>
            </select>`;
          }
          return `<td data-col="${cid}">${cell}</td>`;
        }).join('');
        html+=`
    <tr class="cat-fund-row data-row" data-catid="${esc(cat.id)}"${cat.collapsed?' style="display:none"':''}>
      <td class="left fund-num" style="padding-left:10px">${i+1}</td>
      <td class="left col-name"><div class="fund-name" title="${esc(f.name)}">${esc(f.name)}</div></td>
      ${dynTd}
      <td>
        <div class="fund-menu-wrap">
          <button class="fund-menu-btn" data-ev="fund-menu" data-cat="${esc(cat.id)}" data-code="${esc(f.schemeCode)}" title="Options">⋯</button>
          <div class="fund-menu-dropdown" id="fmenu-${esc(cat.id)}-${esc(f.schemeCode)}">
            <button class="fund-menu-item" data-ev="add-to-portfolio" data-cat="${esc(cat.id)}" data-code="${esc(f.schemeCode)}" data-name="${esc(f.name)}">+ Add to Portfolio</button>
            <div class="fund-menu-sep"></div>
            <button class="fund-menu-item" data-ev="move" data-cat="${esc(cat.id)}" data-code="${esc(f.schemeCode)}">⇄ Move</button>
            <div class="fund-menu-sep"></div>
            <button class="fund-menu-item danger" data-ev="del-fund" data-cat="${esc(cat.id)}" data-code="${esc(f.schemeCode)}">✕ Remove</button>
          </div>
        </div>
      </td>
    </tr>`;
      });
    }
  });
  tbody.innerHTML=html;
  wlBindEvents();
  updateRefreshLabel();
}

function wlBindEvents(){
  const tbody=document.getElementById('tbody');
  tbody.querySelectorAll('[data-ev]').forEach(el=>{
    const ev=el.dataset.ev, catId=el.dataset.cat, code=el.dataset.code;
    if(ev==='toggle'){
      el.addEventListener('click',e=>{
        if(e.target.tagName==='INPUT'||e.target.tagName==='BUTTON'||e.target.closest('.cat-menu-wrap')||e.target.closest('button')) return;
        toggleCollapse(catId);
      });
    } else if(ev==='rename'){
      el.addEventListener('mousedown',e=>e.stopPropagation());
      el.addEventListener('click',e=>e.stopPropagation());
      el.addEventListener('change',()=>renameCat(catId,el.value));
      el.addEventListener('blur',()=>renameCat(catId,el.value));
      el.addEventListener('keydown',e=>{ if(e.key==='Enter') el.blur(); });
    } else if(ev==='cat-menu'){
      el.addEventListener('click',e=>{
        e.stopPropagation();
        const drop=document.getElementById('cat-menu-'+catId);
        const isOpen=drop.classList.contains('open');
        closeAllCatMenus();
        if(!isOpen) drop.classList.add('open');
      });
    } else if(ev==='cat-up')  { el.addEventListener('click',e=>{ e.stopPropagation(); closeAllCatMenus(); catUp(catId); }); }
      else if(ev==='cat-down'){ el.addEventListener('click',e=>{ e.stopPropagation(); closeAllCatMenus(); catDown(catId); }); }
      else if(ev==='del-cat') { el.addEventListener('click',e=>{ e.stopPropagation(); closeAllCatMenus(); deleteCat(catId); }); }
      else if(ev==='opinion') { el.addEventListener('change',()=>setOpinion(catId,code,el.value,el)); }
      else if(ev==='fund-menu'){
        el.addEventListener('click',e=>{
          e.stopPropagation();
          const dropId='fmenu-'+catId+'-'+code;
          const drop=document.getElementById(dropId);
          document.querySelectorAll('.fund-menu-dropdown.open').forEach(d=>{ if(d!==drop) d.classList.remove('open'); });
          drop?.classList.toggle('open');
        });
      }
      else if(ev==='add-to-portfolio') {
        el.addEventListener('click',()=>{
          const nav=WL.navCache[code];
          document.querySelectorAll('.fund-menu-dropdown.open').forEach(d=>d.classList.remove('open'));
          openWlAddToPortfolio('mf', code, null, el.dataset.name, nav?.nav);
        });
      }
      else if(ev==='move')    { el.addEventListener('click',()=>{ document.querySelectorAll('.fund-menu-dropdown.open').forEach(d=>d.classList.remove('open')); openMoveModal(catId,code); }); }
      else if(ev==='del-fund'){ el.addEventListener('click',()=>{ document.querySelectorAll('.fund-menu-dropdown.open').forEach(d=>d.classList.remove('open')); deleteFund(catId,code); }); }
  });
}

function closeAllCatMenus(){
  document.querySelectorAll('.cat-menu-dropdown.open,.fund-menu-dropdown.open').forEach(d=>d.classList.remove('open'));
}

// ── TOP BUTTONS ───────────────────────────────────────
document.getElementById('btn-new-cat').addEventListener('click',()=>{
  const name=prompt('New category name:');
  if(name&&name.trim()){ wlCreateCat(name.trim()); wlSave(); wlRenderAll(); }
});
document.getElementById('btn-refresh').addEventListener('click',()=>{
  WL.navCache={}; wlSave(); toast('Refreshing all data…'); refreshNav(true);
});
document.addEventListener('click',e=>{
  if(!e.target.closest('.cat-menu-wrap')) closeAllCatMenus();
});
document.addEventListener('keydown',e=>{
  if(e.key!=='Escape') return;
  closeAllCatMenus(); closeSettings();
  if(document.getElementById('mf-modal')?.style.display!=='none') closeMFModal();
  else if(document.getElementById('mf-sell-modal')?.style.display!=='none') document.getElementById('mf-sell-modal').style.display='none';
  else if(document.getElementById('stock-sell-modal')?.style.display!=='none') document.getElementById('stock-sell-modal').style.display='none';
  else if(document.getElementById('gold-sell-modal')?.style.display!=='none') document.getElementById('gold-sell-modal').style.display='none';
  else if(document.getElementById('silver-sell-modal')?.style.display!=='none') document.getElementById('silver-sell-modal').style.display='none';
  else if(document.getElementById('add-modal').style.display!=='none') closeAdd();
  else if(document.getElementById('move-modal').style.display!=='none') closeMove();
  else if(document.getElementById('del-cat-modal').style.display!=='none') closeDelCat();
});

// ── MOBILE RIBBON (watchlist actions) ─────────────────
document.getElementById('ribbon-search').addEventListener('click',()=>{
  switchTab('watchlist');
  document.getElementById('mobile-search-overlay').classList.add('open');
  document.getElementById('mobile-search-input').focus();
});
document.getElementById('ribbon-refresh').addEventListener('click',()=>{
  WL.navCache={}; wlSave(); toast('Refreshing…'); refreshNav(true);
});
document.getElementById('ribbon-settings').addEventListener('click',()=>{
  document.getElementById('settings-panel').classList.add('open');
  document.getElementById('settings-overlay').classList.add('open');
  buildSettings();
});
document.getElementById('mobile-search-cancel').addEventListener('click',closeMobileSearch);
function closeMobileSearch(){
  document.getElementById('mobile-search-overlay').classList.remove('open');
  document.getElementById('mobile-search-input').value='';
  document.getElementById('mobile-search-results').innerHTML='';
}
let _mobileSearchTimer = null;
document.getElementById('mobile-search-input').addEventListener('input',function(){
  const q=this.value.trim();
  const res=document.getElementById('mobile-search-results');
  if(!q){ res.innerHTML=''; return; }
  clearTimeout(_mobileSearchTimer);
  res.innerHTML='<div style="padding:24px;text-align:center;color:var(--text3);font-size:.85rem">Searching…</div>';
  _mobileSearchTimer = setTimeout(async ()=>{
  const hits = await searchFunds(q);
  if(!hits.length){
    res.innerHTML='<div style="padding:24px;text-align:center;color:var(--text3);font-size:.85rem">No results found</div>';
  } else {
    res.innerHTML=hits.map(f=>`
      <div class="msr-item">
        <div style="flex:1;min-width:0">
          <div class="msr-name">${hlText(f.schemeName,q)}</div>
          <div class="msr-code">${esc(f.schemeCode)}</div>
        </div>
        <button class="btn-add-sr" data-code="${esc(f.schemeCode)}" data-name="${esc(f.schemeName)}">+ Add</button>
      </div>`).join('');
    res.querySelectorAll('.btn-add-sr').forEach(btn=>{
      const doAdd = e => { e.stopPropagation(); e.preventDefault(); closeMobileSearch(); openAddModal(btn.dataset.code,btn.dataset.name); };
      btn.addEventListener('click', doAdd);
      btn.addEventListener('touchend', doAdd);
    });
  }
  }, 300);
});
document.getElementById('mobile-add-cat').addEventListener('click',()=>{
  closeSettings();
  const name=prompt('New category name:');
  if(name&&name.trim()){ wlCreateCat(name.trim()); wlSave(); wlRenderAll(); }
});

async function initWatchlist(allData) {
  wlLoadState(allData);
  updatePillUI();
  wlRenderAll();
  updateRefreshLabel();
  renderStockWatchlist();
  await refreshNav(false);
}

// ── SUBTAB SWITCHING ──────────────────────────────────
document.querySelectorAll('.subtab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    const target = btn.dataset.subtab;
    document.querySelectorAll('.subtab-btn').forEach(b => b.classList.toggle('active', b === btn));
    document.querySelectorAll('.subtab-panel').forEach(p => p.classList.toggle('active', p.id === target));
  });
});

// ── STOCK PRICE FETCHING ──────────────────────────────
async function fetchStockPrice(symbol, exchange) {
  const ticker = symbol + (exchange === 'NSE' ? '.NS' : '.BO');
  try {
    const r = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${ticker}?interval=1d&range=3y`);
    if (!r.ok) return null;
    const d = await r.json();
    const res = d.chart?.result?.[0];
    if (!res) return null;
    const meta = res.meta;
    const cmp = meta.regularMarketPrice;
    const prev = meta.chartPreviousClose || meta.previousClose;
    const ret1d = prev ? (cmp / prev - 1) * 100 : null;
    const w52high = meta.fiftyTwoWeekHigh;
    const w52low = meta.fiftyTwoWeekLow;
    // Historical prices for period returns
    const closes = res.indicators?.quote?.[0]?.close || [];
    const times = res.timestamp || [];
    function retAtDays(days) {
      const cutoff = Date.now() / 1000 - days * 86400;
      const idx = times.findLastIndex(t => t <= cutoff);
      if (idx < 0) return null;
      const old = closes[idx];
      if (!old || old <= 0) return null;
      return (cmp / old - 1) * 100;
    }
    return {
      cmp, ret1d, w52high, w52low,
      ret1m: retAtDays(30), ret3m: retAtDays(91), ret6m: retAtDays(182),
      ret1y: retAtDays(365), ret3y: retAtDays(1095),
      date: new Date().toISOString()
    };
  } catch(e) { return null; }
}

async function refreshStockWatchlist(forceAll) {
  if (!WL.stocks.length) { renderStockWatchlist(); return; }
  WL.stocks.forEach(s => {
    if (forceAll || !WL.stockPrices[s.symbol]) WL.stockPrices[s.symbol] = { loading: true };
  });
  renderStockWatchlist();
  await Promise.all(WL.stocks.map(async s => {
    const d = await fetchStockPrice(s.symbol, s.exchange);
    WL.stockPrices[s.symbol] = d;
  }));
  WL.stockLastRefresh = new Date().toISOString();
  wlSave(); renderStockWatchlist();
}

document.getElementById('btn-refresh-wl-stocks').addEventListener('click', () => refreshStockWatchlist(true));

// ── STOCK SEARCH ──────────────────────────────────────
const elStockSearch = document.getElementById('stock-search-input');
const elStockResults = document.getElementById('stock-search-results');
const elStockClear = document.getElementById('stock-search-clear');
let stockSearchTimer;

elStockSearch.addEventListener('input', () => {
  const q = elStockSearch.value.trim();
  elStockClear.style.display = q ? 'block' : 'none';
  clearTimeout(stockSearchTimer);
  if (!q) { elStockResults.classList.remove('open'); return; }
  stockSearchTimer = setTimeout(() => doStockSearch(q), 300);
});
elStockClear.addEventListener('click', () => {
  elStockSearch.value = ''; elStockClear.style.display = 'none'; elStockResults.classList.remove('open');
});
document.addEventListener('click', e => {
  if (!document.getElementById('stock-search-wrap')?.contains(e.target)) elStockResults.classList.remove('open');
});

async function doStockSearch(q) {
  try {
    elStockResults.innerHTML = '<div class="sr-no-result">Searching…</div>';
    elStockResults.classList.add('open');
    const r = await fetch(`https://query1.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(q)}&quotesCount=10&newsCount=0&enableFuzzyQuery=false&region=IN`);
    if (!r.ok) throw new Error('Search failed');
    const d = await r.json();
    const hits = (d.quotes || []).filter(q => (q.exchange === 'NSI' || q.exchange === 'BSE' || q.quoteType === 'EQUITY') && q.symbol);
    if (!hits.length) {
      elStockResults.innerHTML = '<div class="sr-no-result">No results. Try ticker symbol (e.g. RELIANCE, INFY)</div>';
      return;
    }
    elStockResults.innerHTML = hits.slice(0, 15).map(h => {
      const sym = h.symbol.replace('.NS','').replace('.BO','');
      const exch = h.symbol.endsWith('.BO') ? 'BSE' : 'NSE';
      return `<div class="sr-item">
        <div style="flex:1;min-width:0">
          <div class="sr-name">${esc(h.longname || h.shortname || sym)}</div>
          <div class="sr-code">${esc(sym)} · ${exch}</div>
        </div>
        <button class="btn-add-sr" data-sym="${esc(sym)}" data-exch="${esc(exch)}" data-name="${esc(h.longname || h.shortname || sym)}">+ Add</button>
      </div>`;
    }).join('');
    elStockResults.querySelectorAll('.btn-add-sr').forEach(btn => {
      const doAdd = e => {
        e.stopPropagation(); e.preventDefault();
        elStockResults.classList.remove('open');
        addStockToWatchlist(btn.dataset.sym, btn.dataset.exch, btn.dataset.name);
      };
      btn.addEventListener('click', doAdd);
      btn.addEventListener('touchend', doAdd);
    });
    elStockResults.classList.add('open');
  } catch(e) {
    elStockResults.innerHTML = '<div class="sr-no-result">Search failed. Check connection.</div>';
  }
}

function addStockToWatchlist(symbol, exchange, name) {
  if (WL.stocks.find(s => s.symbol === symbol && s.exchange === exchange)) {
    toast('Stock already in watchlist'); return;
  }
  WL.stocks.push({ symbol, exchange, name });
  wlSave(); renderStockWatchlist(); toast('Stock added ✓');
  fetchStockPrice(symbol, exchange).then(d => {
    WL.stockPrices[symbol] = d;
    wlSave(); renderStockWatchlist();
  });
}

// ── STOCK WATCHLIST RENDER ────────────────────────────
function renderStockWatchlist() {
  const hasStocks = WL.stocks.length > 0;
  const noEl = document.getElementById('wl-stocks-no-items');
  const wrapEl = document.getElementById('stock-table-wrap');
  if (!noEl || !wrapEl) return;
  noEl.style.display = hasStocks ? 'none' : 'block';
  wrapEl.style.display = hasStocks ? 'block' : 'none';
  if (!hasStocks) return;

  const tsEl = document.getElementById('stock-refresh-ts');
  if (tsEl && WL.stockLastRefresh) {
    const d = new Date(WL.stockLastRefresh);
    tsEl.textContent = 'Updated ' + d.toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'}) + ', ' + d.toLocaleDateString([], {day:'numeric',month:'short'});
  }

  const tbody = document.getElementById('stock-wl-tbody');
  tbody.innerHTML = WL.stocks.map(s => {
    const p = WL.stockPrices[s.symbol];
    const loading = p?.loading === true;
    const noData = !p || p.loading;
    function retChipLocal(v) { return retChip(noData ? null : v, loading); }
    function priceCell(v) {
      if (loading) return '<span class="sk" style="width:60px"></span>';
      if (v == null) return '<span class="chip-n">—</span>';
      return `<span class="nav-val">₹ ${Math.round(v).toLocaleString('en-IN')}</span>`;
    }
    return `<tr data-sym="${esc(s.symbol)}" data-exch="${esc(s.exchange)}">
      <td class="left">
        <div style="font-size:.85rem;font-weight:500">${esc(s.name)}</div>
        <div style="font-size:.73rem;color:var(--text3)">${esc(s.symbol)} · ${esc(s.exchange)}</div>
      </td>
      <td>${priceCell(noData ? null : p?.cmp)}</td>
      <td>${retChipLocal(p?.ret1d)}</td>
      <td>${retChipLocal(p?.ret1m)}</td>
      <td>${retChipLocal(p?.ret3m)}</td>
      <td>${retChipLocal(p?.ret6m)}</td>
      <td>${retChipLocal(p?.ret1y)}</td>
      <td>${retChipLocal(p?.ret3y)}</td>
      <td>${loading ? '<span class="sk" style="width:60px"></span>' : (p?.w52high != null ? `<span style="font-size:.82rem">₹ ${Math.round(p.w52high).toLocaleString('en-IN')}</span>` : '<span class="chip-n">—</span>')}</td>
      <td>${loading ? '<span class="sk" style="width:60px"></span>' : (p?.w52low != null ? `<span style="font-size:.82rem">₹ ${Math.round(p.w52low).toLocaleString('en-IN')}</span>` : '<span class="chip-n">—</span>')}</td>
      <td>
        <div class="fund-menu-wrap">
          <button class="fund-menu-btn" data-ev="stock-wl-menu" data-sym="${esc(s.symbol)}" data-exch="${esc(s.exchange)}" title="Options">⋯</button>
          <div class="fund-menu-dropdown" id="swl-menu-${esc(s.symbol)}">
            <button class="fund-menu-item" data-ev="stock-wl-add-portfolio" data-sym="${esc(s.symbol)}" data-exch="${esc(s.exchange)}" data-name="${esc(s.name)}">+ Add to Portfolio</button>
            <div class="fund-menu-sep"></div>
            <button class="fund-menu-item danger" data-ev="stock-wl-remove" data-sym="${esc(s.symbol)}" data-exch="${esc(s.exchange)}">🗑 Remove</button>
          </div>
        </div>
      </td>
    </tr>`;
  }).join('');

  // Event delegation for the tbody
  tbody.addEventListener('click', e => {
    const btn = e.target.closest('[data-ev]');
    if (!btn) return;
    const ev = btn.dataset.ev;
    const sym = btn.dataset.sym;
    const exch = btn.dataset.exch;
    const name = btn.dataset.name;
    if (ev === 'stock-wl-menu') {
      const dropdown = document.getElementById('swl-menu-' + sym);
      document.querySelectorAll('.fund-menu-dropdown.open').forEach(d => { if (d !== dropdown) d.classList.remove('open'); });
      dropdown?.classList.toggle('open');
      e.stopPropagation();
    } else if (ev === 'stock-wl-remove') {
      if (!confirm('Remove ' + sym + ' from watchlist?')) return;
      WL.stocks = WL.stocks.filter(s => !(s.symbol === sym && s.exchange === exch));
      delete WL.stockPrices[sym];
      wlSave(); renderStockWatchlist(); toast('Removed');
    } else if (ev === 'stock-wl-add-portfolio') {
      openWlAddToPortfolio('stock', sym, exch, name, WL.stockPrices[sym]?.cmp);
    }
  });
}

// ── ADD TO PORTFOLIO MODAL ────────────────────────────
let wlAtpPending = null;

function openWlAddToPortfolio(type, codeOrSym, exchange, name, currentPrice) {
  wlAtpPending = { type, codeOrSym, exchange, name };
  document.getElementById('wl-atp-fund-name').textContent = name;
  // Set today's date
  const today = new Date().toISOString().slice(0,10);
  document.getElementById('wl-atp-date').value = today;
  // Pre-fill price
  const priceEl = document.getElementById('wl-atp-price');
  priceEl.value = currentPrice ? currentPrice.toFixed(type === 'mf' ? 4 : 2) : '';
  // Show/hide units row (only for MF)
  document.getElementById('wl-atp-units-row').style.display = type === 'mf' ? '' : 'none';
  document.getElementById('wl-atp-amount').value = '';
  document.getElementById('wl-atp-units').value = '';
  document.getElementById('wl-atp-units-note').textContent = '';
  document.getElementById('wl-add-to-portfolio-modal').style.display = 'flex';
}

// Bidirectional auto-fill for MF (amount ↔ units via NAV)
document.getElementById('wl-atp-amount').addEventListener('input', () => {
  if (!wlAtpPending || wlAtpPending.type !== 'mf') return;
  const nav = parseFloat(document.getElementById('wl-atp-price').value);
  const amt = parseFloat(document.getElementById('wl-atp-amount').value);
  if (nav > 0 && amt > 0) {
    document.getElementById('wl-atp-units').value = (amt / nav).toFixed(3);
    document.getElementById('wl-atp-units-note').textContent = '(auto)';
  }
});
document.getElementById('wl-atp-units').addEventListener('input', () => {
  if (!wlAtpPending || wlAtpPending.type !== 'mf') return;
  const nav = parseFloat(document.getElementById('wl-atp-price').value);
  const units = parseFloat(document.getElementById('wl-atp-units').value);
  if (nav > 0 && units > 0) {
    document.getElementById('wl-atp-amount').value = Math.round(nav * units);
    document.getElementById('wl-atp-units-note').textContent = '';
  }
});

document.getElementById('wl-atp-cancel').addEventListener('click', () => {
  document.getElementById('wl-add-to-portfolio-modal').style.display = 'none';
  wlAtpPending = null;
});
document.getElementById('wl-add-to-portfolio-modal').addEventListener('click', e => {
  if (e.target === e.currentTarget) {
    document.getElementById('wl-add-to-portfolio-modal').style.display = 'none';
    wlAtpPending = null;
  }
});

document.getElementById('wl-atp-confirm').addEventListener('click', () => {
  if (!wlAtpPending) return;
  const { type, codeOrSym, exchange, name } = wlAtpPending;
  const date = document.getElementById('wl-atp-date').value;
  const price = parseFloat(document.getElementById('wl-atp-price').value);
  const amount = parseFloat(document.getElementById('wl-atp-amount').value);

  if (!date) { toast('Please select a date'); return; }
  if (!price || price <= 0) { toast('Please enter a valid price'); return; }
  if (!amount || amount <= 0) { toast('Please enter amount invested'); return; }

  if (type === 'mf') {
    const units = parseFloat(document.getElementById('wl-atp-units').value) || (amount / price);
    // Add to P.mf_holdings
    P.mf_holdings.push({
      schemeCode: codeOrSym,
      name,
      date,
      nav: price,
      units: parseFloat(units.toFixed(3)),
      invested: Math.round(amount)
    });
    pSave();
    toast('Added to MF Holdings ✓');
  } else {
    // Add to P.stocks
    P.stocks.push({
      name,
      symbol: codeOrSym,
      exchange: exchange || 'NSE',
      date,
      price,
      qty: Math.round(amount / price),
      invested: Math.round(amount)
    });
    pSave();
    toast('Added to Stocks ✓');
  }

  document.getElementById('wl-add-to-portfolio-modal').style.display = 'none';
  wlAtpPending = null;
});

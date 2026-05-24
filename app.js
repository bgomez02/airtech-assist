// ══ APP.JS — Lógica Principal — AirTech Assist ══
// Estado, Firebase, Gantt, Modales, Roles, Planificación


// ══ SUPABASE STORAGE — almacenamiento de archivos ══
// Las credenciales se leen de config.js (no está en el repo)
const _cfg = window.APP_CONFIG || {};
const SB_DEFAULT_URL = _cfg.supabaseUrl  || '';
const SB_DEFAULT_KEY = _cfg.supabaseKey  || '';

let SUPABASE_URL = localStorage.getItem('airtechassist_sb_url') || SB_DEFAULT_URL;
let SUPABASE_KEY = localStorage.getItem('airtechassist_sb_key') || SB_DEFAULT_KEY;
// Auto-save defaults if not set
if(SB_DEFAULT_URL && !localStorage.getItem('airtechassist_sb_url')) localStorage.setItem('airtechassist_sb_url', SB_DEFAULT_URL);
if(SB_DEFAULT_KEY && !localStorage.getItem('airtechassist_sb_key')) localStorage.setItem('airtechassist_sb_key', SB_DEFAULT_KEY);
const SB_BUCKET = _cfg.supabaseBucket || localStorage.getItem('airtechassist_sb_bucket') || 'files';

function sbConfigured(){ return SUPABASE_URL && SUPABASE_KEY; }

function saveSBConfig(){
  const u = document.getElementById('sb-url-inp').value.trim().replace(/\/$/,'');
  const k = document.getElementById('sb-key-inp').value.trim();
  if(!u||!k){ toast('⚠ Completa URL y Key de Supabase', true); return; }
  if(k.length < 100){ toast('⚠ La key parece muy corta — pega el anon key completo (empieza con eyJ...)', true); return; }
  SUPABASE_URL = u; SUPABASE_KEY = k;
  localStorage.setItem('airtechassist_sb_url', u);
  localStorage.setItem('airtechassist_sb_key', k);
  console.log('[Supabase] Saved — URL:', u, '| Key prefix:', k.substring(0,20)+'...');
  document.getElementById('sb-config-panel').style.display='none';
  document.getElementById('sb-status-bar').style.display='flex';
  document.getElementById('sb-project-name').textContent = u.replace('https://','').split('.')[0];
  toast('✅ Supabase configurado — ya puedes subir archivos');
}

function clearSBConfig(){
  localStorage.removeItem('airtechassist_sb_url'); localStorage.removeItem('airtechassist_sb_key');
  SUPABASE_URL=''; SUPABASE_KEY='';
  document.getElementById('sb-config-panel').style.display='block';
  document.getElementById('sb-status-bar').style.display='none';
}

// ── Ensure Supabase bucket exists (creates it if not) ──
async function ensureBucket(sbUrl, key){
  // Try to create bucket (idempotent — ignores error if already exists)
  try{
    await fetch(`${sbUrl}/storage/v1/bucket`, {
      method: 'POST',
      headers:{
        'Authorization':'Bearer '+key,
        'apikey': key,
        'Content-Type':'application/json'
      },
      body: JSON.stringify({id:SB_BUCKET, name:SB_BUCKET, public:true})
    });
    // 200 = created, 409 = already exists — both OK
  }catch(e){ console.log('[Supabase] Bucket check done'); }
}

// ── Upload file to Supabase Storage ──
async function uploadToSupabase(file, folder){
  const key   = localStorage.getItem('airtechassist_sb_key') || SB_DEFAULT_KEY;
  const sbUrl = (localStorage.getItem('airtechassist_sb_url') || SB_DEFAULT_URL).replace(/\/$/,'');

  // Create bucket if needed
  await ensureBucket(sbUrl, key);

  const safe = file.name.replace(/[^a-zA-Z0-9._-]/g,'_');
  const path = `${folder}/${Date.now()}_${safe}`;
  const uploadUrl = `${sbUrl}/storage/v1/object/${SB_BUCKET}/${path}`;

  console.log('[Supabase] Uploading:', file.name, '→', path);

  // Use FormData — most compatible across browsers and iOS
  const fd = new FormData();
  fd.append('', file, file.name);

  const resp = await fetch(uploadUrl, {
    method : 'POST',
    headers: {
      'Authorization': 'Bearer ' + key,
      'apikey'       : key,
      'x-upsert'     : 'true'
      // No Content-Type here — browser sets it automatically with boundary for FormData
    },
    body: fd
  });

  if(!resp.ok){
    const errText = await resp.text();
    console.error('[Supabase] Upload failed:', resp.status, errText);
    // If FormData failed, try raw binary as fallback
    const resp2 = await fetch(uploadUrl, {
      method : 'POST',
      headers:{
        'Authorization': 'Bearer '+key,
        'apikey'       : key,
        'Content-Type' : file.type||'application/octet-stream',
        'x-upsert'     : 'true'
      },
      body: file
    });
    if(!resp2.ok){
      const err2 = await resp2.text();
      throw new Error('Supabase error '+resp2.status+': '+err2.substring(0,200));
    }
  }

  const publicUrl = `${sbUrl}/storage/v1/object/public/${SB_BUCKET}/${path}`;
  console.log('[Supabase] ✅ Uploaded:', publicUrl);
  return { url: publicUrl, path };
}

// ══ FASE 1 SEGURIDAD — Auth real + hashing + rate limiting + audit ══
// Valores leídos de config.js (no está en el repo — ver config.example.js)
const SUPERADMIN_NAME  = (_cfg.superadminName  || '').toUpperCase();
const SUPERADMIN_EMAIL = _cfg.superadminEmail  || '';
const SUPERADMIN_UID   = _cfg.superadminUid    || '';
const ADMIN_PASSWORDS  = [];  // ya no se usan contraseñas en texto plano

// ── SHA-256 via Web Crypto API (sin librerías externas) ──
async function sha256(str){
  const buf=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(str));
  return Array.from(new Uint8Array(buf)).map(b=>b.toString(16).padStart(2,'0')).join('');
}

// ── Rate Limiting — máx 5 intentos, bloqueo 30 segundos ──
const RL_MAX=5, RL_MS=30000;
function rlKey(n){ return 'rl_'+n.toLowerCase().trim(); }
function checkRL(name){
  const raw=sessionStorage.getItem(rlKey(name));
  if(!raw) return {ok:true};
  const d=JSON.parse(raw);
  if(d.lockUntil&&Date.now()<d.lockUntil){
    const s=Math.ceil((d.lockUntil-Date.now())/1000);
    return {ok:false,msg:`🔒 Demasiados intentos. Espera ${s} segundos.`};
  }
  if(d.attempts>=RL_MAX){
    const lu=Date.now()+RL_MS;
    sessionStorage.setItem(rlKey(name),JSON.stringify({...d,lockUntil:lu}));
    return {ok:false,msg:'🔒 Demasiados intentos. Espera 30 segundos.'};
  }
  return {ok:true};
}
function failRL(name){
  const key=rlKey(name), raw=sessionStorage.getItem(key);
  const d=raw?JSON.parse(raw):{attempts:0,lockUntil:null};
  d.attempts=(d.attempts||0)+1;
  if(d.attempts>=RL_MAX) d.lockUntil=Date.now()+RL_MS;
  sessionStorage.setItem(key,JSON.stringify(d));
}
function clearRL(name){ sessionStorage.removeItem(rlKey(name)); }

// ── Audit Log — registra cada login en Firestore ──
async function auditLog(action,details){
  if(!window.FB) return;
  if(!planCfg().auditLog) return; // no audit log en plan gratis/básico
  try{
    await FB.db.collection(AIRLINE_ID).doc('audit').collection('logs').add({
      action, ...details,
      timestamp:Date.now(),
      timeStr:new Date().toLocaleString('es-DO'),
      ua:navigator.userAgent.substring(0,120)
    });
  }catch(e){console.warn('Audit log error:',e);}
}

// ══ PLAN DE SUSCRIPCIÓN ══════════════════════════════════════════
const PLAN_CONFIG = {
  free: {
    name:'Gratis', emoji:'🆓',
    maxBases:1, maxAircraft:5, maxUsers:3, historyDays:7,
    auditLog:false, export:false,
    tabs:['gantt'],
  },
  basic: {
    name:'Básico', emoji:'⭐',
    maxBases:2, maxAircraft:15, maxUsers:10, historyDays:30,
    auditLog:false, export:true,
    tabs:['gantt','demand','staff','users','plan','schedule','flights','catalog','dashboard'],
  },
  pro: {
    name:'Pro', emoji:'🚀',
    maxBases:Infinity, maxAircraft:Infinity, maxUsers:Infinity, historyDays:Infinity,
    auditLog:true, export:true,
    tabs:['gantt','demand','staff','users','plan','schedule','flights','catalog','dashboard','mcc'],
  },
};

let _activePlan = null; // plan cargado desde Firestore del cliente
function currentPlan(){ return _activePlan || (window.APP_CONFIG?.plan||'pro'); }
function planCfg(){ return PLAN_CONFIG[currentPlan()]||PLAN_CONFIG.pro; }
function planAllowsTab(tab){ return planCfg().tabs.includes(tab); }

const PLAN_FEATURE_NAMES = {
  demand:'Análisis de Demanda', staff:'Gestión de Roster', users:'Control de Usuarios',
  plan:'Planificación', schedule:'Horarios', flights:'Módulo de Vuelos',
  catalog:'Catálogo de Tareas', dashboard:'Dashboard Analítico', mcc:'Control MCC Multi-Base',
  export:'Exportación PDF / Excel', bases:'múltiples bases', aircraft:'más aeronaves', maxUsers:'más usuarios',
};

function showUpgradeModal(feature){
  const cfg=planCfg();
  const featName=PLAN_FEATURE_NAMES[feature]||feature;
  const required=currentPlan()==='free'?'basic':'pro';
  const reqCfg=PLAN_CONFIG[required];
  document.getElementById('upgrade-feature-name').textContent=featName;
  document.getElementById('upgrade-current-plan').textContent=cfg.emoji+' '+cfg.name;
  document.getElementById('upgrade-required-plan').textContent=reqCfg.emoji+' '+reqCfg.name;
  document.getElementById('modal-upgrade').style.display='flex';
}
function closeUpgradeModal(){
  document.getElementById('modal-upgrade').style.display='none';
}

function applyPlanGates(){
  const cfg=planCfg();
  // Gate tabs not included in this plan
  ['demand','staff','users','plan','schedule','flights','catalog','dashboard','mcc'].forEach(t=>{
    const el=document.getElementById('TAB-'+t);
    if(el && !cfg.tabs.includes(t)) el.style.display='none';
  });
  // Gate export buttons
  if(!cfg.export){
    ['btn-pdf','btn-excel','gantt-pdf-row'].forEach(id=>{
      const el=document.getElementById(id); if(el) el.style.display='none';
    });
  }
  // Show plan badge in header
  const badge=document.getElementById('plan-badge');
  if(badge){
    const colors={free:'background:#f0fdf4;color:#166534;border:1px solid #86efac',basic:'background:#eff6ff;color:#1e40af;border:1px solid #bfdbfe',pro:'background:#f5f3ff;color:#6d28d9;border:1px solid #c4b5fd'};
    badge.style.cssText=`font-size:10px;font-weight:700;padding:3px 9px;border-radius:20px;${colors[currentPlan()]||colors.pro}`;
    badge.textContent=cfg.emoji+' '+cfg.name;
  }
}

// ══ AIRLINE & STATIONS ══════════════════════════════════════════
// Preservar clientId seteado por URL ?client= antes de que cargara app.js
let AIRLINE_ID = window.AIRLINE_ID || _cfg.airlineId || 'airtechassist';
window.AIRLINE_ID = AIRLINE_ID;
window._station = '';
let loginStation = '';

function setClientId(id){
  if(!id) return;
  AIRLINE_ID = id;
  window.AIRLINE_ID = id;
  sessionStorage.setItem('airtechassist_client', id);
}

// Stations — se cargan desde Firestore; sin defaults hardcodeados
let stations = [];
// Returns the active station code; falls back to first configured station.
// Never returns '' — callers should guard on the result being truthy for writes.
function activeStation(){ return window._station || stations[0]?.code || ''; }

function renderStationTabs(containerId){
  const c=document.getElementById(containerId);
  if(!c) return;
  c.innerHTML='';
  const cols=Math.min(stations.length,4);
  c.style.gridTemplateColumns=`repeat(${cols},1fr)`;
  stations.forEach((s,i)=>{
    const d=document.createElement('div');
    d.className='role-tab'+(i===0?' active':'');
    d.id=(containerId==='station-selector'?'stab-':'rep-stab-')+s.code;
    d.onclick=()=>containerId==='station-selector'?setStation(s.code):repSetStation(s.code);
    d.style.cssText='font-size:13px;padding:10px 6px;cursor:pointer';
    d.innerHTML=`${s.flag||'🛫'}<br><span style="font-size:10px">${s.code} — ${s.name}</span>`;
    c.appendChild(d);
  });
  // default to first station
  if(stations.length) setStation(stations[0].code);
}

// ══ MATRÍCULAS ══
let aircraft = []; // loaded from Firestore config/aircraft

async function loadAircraft(){
  if(!window.FB) return;
  try {
    const snap = await FB.db.collection(AIRLINE_ID).doc('config')
      .collection('aircraft').orderBy('reg').get();
    if(snap.docs.length > 0){
      aircraft = snap.docs.map(d => ({id:d.id, ...d.data()})).filter(a=>a.active!==false);
    }
  } catch(e) {
    console.warn('loadAircraft:', e.message);
    aircraft = [];
  }
  populateAircraftSelects();
}

function populateAircraftSelects(){
  const selects = ['fm-ac','pm-ac','rep-ac','db-ac-filter'].map(id => document.getElementById(id));
  selects.forEach(sel => {
    if(!sel) return;
    const prev = sel.value;
    const first = sel.options[0];
    sel.innerHTML = '';
    sel.appendChild(first);
    aircraft.forEach(a => {
      const opt = document.createElement('option');
      opt.value = a.reg;
      // Show MSN if available
      let label = a.reg;
      if(a.model) label += ' · ' + a.model;
      if(a.msn)   label += ' (MSN ' + a.msn + ')';
      opt.textContent = label;
      opt.title = 'Matrícula: ' + a.reg + (a.msn ? ' · MSN: ' + a.msn : '');
      sel.appendChild(opt);
    });
    if(prev) sel.value = prev;
  });
}

async function saveAircraft(reg, model, active=true, msn=''){
  if(!reg) return;
  reg = reg.trim().toUpperCase();
  const isNew = !aircraft.find(a=>a.reg===reg);
  if(isNew && aircraft.length >= planCfg().maxAircraft){
    showUpgradeModal('aircraft');
    return;
  }
  const data = {reg, model:model||'', active, updatedAt:Date.now()};
  if(msn && msn.trim()) data.msn = msn.trim();
  await FB.db.collection(AIRLINE_ID).doc('config').collection('aircraft')
    .doc(reg).set(data, {merge:true});
  await loadAircraft();
  toast('✅ ' + reg + ' guardada');
}

async function deleteAircraft(reg){
  if(!confirm('¿Eliminar matrícula ' + reg + '? No afecta OTs existentes.')) return;
  await FB.db.collection(AIRLINE_ID).doc('config').collection('aircraft').doc(reg).delete();
  await loadAircraft();
  toast('Matrícula ' + reg + ' eliminada');
}

function renderAircraftManager(){
  const wrap = document.getElementById('aircraft-manager-list');
  if(!wrap) return;
  if(!aircraft.length){
    wrap.innerHTML = '<div style="color:#94a3b8;font-size:12px;padding:8px">No hay matrículas. Agrega la primera.</div>';
    return;
  }
  wrap.innerHTML = aircraft.map(a => {
    const isSuper = currentRole==='superadmin';
    return `<div style="display:flex;align-items:center;gap:8px;padding:7px 0;border-bottom:1px solid #f1f5f9;flex-wrap:wrap">
      <span style="font-weight:700;font-family:monospace;min-width:68px;color:#0f2a66;font-size:13px">${esc(a.reg)}</span>
      <span style="color:#64748b;font-size:11px;min-width:120px">${esc(a.model||'—')}</span>
      <div style="display:flex;align-items:center;gap:4px;min-width:160px">
        <span style="font-size:10px;color:#94a3b8">MSN:</span>
        ${isSuper
          ? `<input type="text" value="${esc(a.msn||'')}" placeholder="Sin MSN"
              style="width:90px;border:1px solid #e2e8f0;border-radius:6px;padding:2px 6px;font-size:11px;font-family:monospace"
              onchange="saveAircraft('${esc(a.reg)}','${esc(a.model||'')}',${a.active!==false},this.value).then(()=>renderAircraftManager())">`
          : `<span style="font-family:monospace;font-size:11px;color:#374151;font-weight:600">${esc(a.msn||'—')}</span>`
        }
      </div>
      <span style="font-size:10px;padding:2px 8px;border-radius:10px;background:${a.active!==false?'#dcfce7':'#fee2e2'};color:${a.active!==false?'#166534':'#dc2626'}">${a.active!==false?'Activa':'Inactiva'}</span>
      ${isSuper?`<button onclick="deleteAircraft('${esc(a.reg)}')" style="background:none;border:none;color:#dc2626;cursor:pointer;font-size:14px;margin-left:auto" title="Eliminar">🗑</button>`:''}
    </div>`;
  }).join('');
}

async function loadStations(){
  if(!window.FB) return;
  try{
    const snap=await FB.db.collection(AIRLINE_ID).doc('config').collection('stations').orderBy('code').get();
    if(snap.docs.length>0){
      stations=snap.docs.map(d=>({code:d.id,...d.data()})).filter(s=>s.active!==false);
    }
  }catch(e){ console.warn('loadStations:', e); }
  renderStationTabs('station-selector');
  renderStationTabs('rep-station-selector');
  buildRepStationSelector();
  populateStationDropdowns();
  loadAircraft(); // reload aircraft when stations change
}

function buildRepStationSelector(){
  // already handled by renderStationTabs for rep-station-selector
}

function populateStationDropdowns(){
  // Populate #schedule-station (full list)
  const schedSel = document.getElementById('schedule-station');
  if(schedSel){
    const prev = schedSel.value;
    schedSel.innerHTML = '';
    stations.forEach(s=>{
      const o = document.createElement('option');
      o.value = s.code;
      o.textContent = s.code + (s.name ? ' — ' + s.name : '');
      schedSel.appendChild(o);
    });
    if([...schedSel.options].some(o=>o.value===prev)) schedSel.value=prev;
  }
  // Populate #um-station (user modal): keep "Todas las bases" first, then stations
  const umSel = document.getElementById('um-station');
  if(umSel){
    const prevUm = umSel.value;
    umSel.innerHTML = '<option value="AMBAS">🌐 Todas las bases</option>';
    stations.forEach(s=>{
      const o = document.createElement('option');
      o.value = s.code;
      o.textContent = s.code + (s.name ? ' — ' + s.name : '');
      umSel.appendChild(o);
    });
    if([...umSel.options].some(o=>o.value===prevUm)) umSel.value=prevUm;
  }
}

function setStation(s){
  loginStation = s;
  stations.forEach(st=>{
    const el=document.getElementById('stab-'+st.code);
    if(el) el.classList.toggle('active', st.code===s);
  });
}

function switchStation(s){
  if(s === window._station) return;
  window._station = s;
  sessionStorage.setItem('airtechassist_station', s);
  document.getElementById('station-badge').textContent = s;
  const st = stations.find(x=>x.code===s);
  const swBtn = document.getElementById('station-switcher-btn');
  if(swBtn) swBtn.textContent = (st?.flag||'🛫')+' '+s;
  // Update API sync station label if visible
  const stLbl = document.getElementById('api-sync-station-lbl');
  if(stLbl) stLbl.textContent = s;
  // Clear local state before resubscribing
  techs=[]; tasks=[]; history=[]; documents=[];
  subscribeAll();
  loadFlights(s);   // reload flights for new station → updates Gantt
  toast('📍 Cambiado a base ' + s);
}

function showStationPicker(){
  const others=stations.filter(s=>s.code!==window._station);
  if(!others.length){ toast('Solo hay una base configurada'); return; }
  if(others.length===1){
    const s=others[0];
    if(confirm('¿Cambiar a base '+s.code+' — '+s.name+'?\n\nSe cargarán los datos de '+s.code+'.')) switchStation(s.code);
    return;
  }
  // Multiple stations — show picker
  const list=others.map((s,i)=>`${i+1}. ${s.flag||'🛫'} ${s.code} — ${s.name}`).join('\n');
  const input=prompt('Selecciona base (escribe el código):\n\n'+list+'\n\nCódigo actual: '+window._station);
  if(!input) return;
  const found=stations.find(s=>s.code===input.trim().toUpperCase());
  if(found) switchStation(found.code);
  else toast('⚠ Código de base no válido', true);
}

// ══ ROLE STATE ══
let currentRole = null; // 'admin' | 'tech'
let currentUserName = '';
let loginRole = 'admin';

function setLoginRole(r){ loginRole=r; } // compat

async function doLogin(){
  const nameRaw=(document.getElementById('login-name').value||'').trim().toUpperCase();
  const cred=(document.getElementById('login-pin').value||'').trim();
  const err=document.getElementById('login-err');
  const btn=document.getElementById('login-btn-main');
  if(!nameRaw){ err.textContent='⚠ Ingresa tu nombre completo'; return; }
  if(!cred){ err.textContent='⚠ Ingresa tu contraseña o PIN'; return; }

  // Rate limit check
  const rl=checkRL(nameRaw);
  if(!rl.ok){ err.textContent=rl.msg; return; }

  err.textContent=''; btn.textContent='Verificando...'; btn.disabled=true;

  try{
    // ── SUPERADMIN: Firebase Auth email + contraseña ──
    if(nameRaw===SUPERADMIN_NAME){
      try{
        await firebase.auth().signInWithEmailAndPassword(SUPERADMIN_EMAIL, cred);
        clearRL(nameRaw);
        await auditLog('login_ok',{name:nameRaw,role:'superadmin',station:loginStation});
        _loginSuccess(nameRaw,'superadmin'); return;
      }catch(e){
        failRL(nameRaw);
        await auditLog('login_fail',{name:nameRaw,reason:e.code,station:loginStation});
        if(e.code==='auth/wrong-password'||e.code==='auth/invalid-credential'){
          err.textContent='❌ Contraseña incorrecta.';
        } else if(e.code==='auth/too-many-requests'){
          err.textContent='🔒 Demasiados intentos. Cuenta bloqueada temporalmente por Firebase.';
        } else {
          err.textContent='❌ '+e.message;
        }
        btn.textContent='Ingresar'; btn.disabled=false; return;
      }
    }

    // ── ADMIN DE CLIENTE: Firebase Auth email + contraseña ──
    if(nameRaw.includes('@')){
      try{
        const uc=await firebase.auth().signInWithEmailAndPassword(nameRaw, cred);
        const uid=uc.user.uid;
        // Resolver clientId desde el registro global
        const reg=await FB.db.collection('registry').doc(uid).get();
        if(!reg.exists){ err.textContent='❌ Cuenta no configurada. Contacta soporte.'; btn.textContent='Ingresar'; btn.disabled=false; return; }
        setClientId(reg.data().clientId);
        // Leer perfil del usuario
        const uDoc=await FB.db.collection(AIRLINE_ID).doc('config').collection('users').doc(uid).get();
        const uData=uDoc.exists?uDoc.data():{};
        const name=uData.name||nameRaw.split('@')[0].toUpperCase();
        const role=uData.role==='superadmin'?'superadmin':(uData.role==='supervisor'||uData.role==='admin')?'supervisor':'tech';
        if(!loginStation) loginStation=stations[0]?.code||'';
        clearRL(nameRaw);
        await auditLog('login_ok',{name,role,station:loginStation});
        _loginSuccess(name,role); return;
      }catch(e){
        failRL(nameRaw);
        if(e.code==='auth/wrong-password'||e.code==='auth/invalid-credential') err.textContent='❌ Contraseña incorrecta.';
        else if(e.code==='auth/too-many-requests') err.textContent='🔒 Demasiados intentos. Intenta más tarde.';
        else err.textContent='❌ '+e.message;
        btn.textContent='Ingresar'; btn.disabled=false; return;
      }
    }

    // ── Código de empresa para usuarios PIN ──
    const clientInput=(document.getElementById('login-client')?.value||'').trim().toLowerCase();
    if(clientInput) setClientId(clientInput);

    // ── SUPERVISORES Y TÉCNICOS: Firestore + PIN hasheado ──
    if(!window.FB||!window.FB.USERS){
      err.textContent='Sin conexión Firebase';
      btn.textContent='Ingresar'; btn.disabled=false; return;
    }
    const pinHash=await sha256(cred);
    const snap=await window.FB.USERS().where('active','==',true).get();
    const users=snap.docs.map(d=>({id:d.id,...d.data()}));
    // Soporta PIN hasheado (nuevo) y PIN texto plano (migración de usuarios existentes)
    const match=users.find(u=>{
      if(!u||!u.name) return false;  // skip docs with missing name
      if(u.name.toUpperCase()!==nameRaw) return false;
      const sp=String(u.pinHash||u.pin||'');
      return sp===pinHash||sp===cred;
    });
    if(!match){
      failRL(nameRaw);
      await auditLog('login_fail',{name:nameRaw,reason:'wrong_pin',station:loginStation});
      err.textContent='❌ Nombre o PIN incorrecto. Contacta a tu supervisor.';
      btn.textContent='Ingresar'; btn.disabled=false; return;
    }
    if(match&&match.station&&match.station!=='AMBAS'&&match.station!==loginStation){
      err.textContent=`⚠ Tu acceso es solo para ${match.station}. Selecciona esa base.`;
      btn.textContent='Ingresar'; btn.disabled=false; return;
    }
    clearRL(nameRaw);
    const mappedRole=match.role==='superadmin'?'superadmin':
      (match.role==='supervisor'||match.role==='admin')?'supervisor':
      match.role==='mcc'?'mcc':'tech';
    await auditLog('login_ok',{name:match.name,role:mappedRole,station:loginStation});
    _loginSuccess(match.name,mappedRole);
  }catch(e){
    console.error('Login error:',e);
    err.textContent='Error: '+e.message;
    btn.textContent='Ingresar'; btn.disabled=false;
  }
}

function _loginSuccess(name,role){
  currentRole=role; currentUserName=name;
  window._station=loginStation;
  sessionStorage.setItem('airtechassist_role',role);
  sessionStorage.setItem('airtechassist_name',name);
  sessionStorage.setItem('airtechassist_station',loginStation);
  sessionStorage.setItem('airtechassist_client',AIRLINE_ID);
  document.getElementById('login-screen').style.display='none';
  document.getElementById('main-app').style.display='block';
  const sb=document.getElementById('station-badge');
  const sw=document.getElementById('station-switcher-btn');
  if(sb) sb.textContent=loginStation;
  const _st=stations.find(s=>s.code===loginStation);
  if(sw) sw.textContent=(_st?.flag||'🛫')+' '+loginStation;
  // Aplicar rol inmediatamente (sin plan aún) para mostrar tabs correctas
  applyRole(); initPlanTab();
  // Cargar nombre de aerolínea y plan desde Firestore
  FB.db.collection(AIRLINE_ID).doc('config').get().then(d=>{
    const planMap={'Gratis':'free','Básico':'basic','Pro':'pro','free':'free','basic':'basic','pro':'pro'};
    if(d.exists){
      if(d.data().plan) _activePlan = planMap[d.data().plan] || d.data().plan;
      if(d.data().airlineName) window._airlineName = d.data().airlineName;
    }
    initPlanTab();
  }).catch(()=>{});
  initSupabaseUI(); subscribeAll(); subscribeUsers(); renderGantt(); loadTaskCatalog(); loadAircraft(); loadFlights(window._station); loadTailAssignments(); loadShiftDefs();
  // Pre-load current month schedule for auto-assign
  const _now=new Date(); const _mkey=_now.getFullYear()+'-'+String(_now.getMonth()+1).padStart(2,'0'); loadSchedule(_mkey, activeStation());
  const btn=document.getElementById('login-btn-main');
  if(btn){ btn.textContent='Ingresar'; btn.disabled=false; }
}

function detectSuperAdmin(name){
  const hint=document.getElementById('login-superadmin-hint');
  const pin=document.getElementById('login-pin');
  const clientWrap=document.getElementById('login-client-wrap');
  if(name.trim().toUpperCase()===SUPERADMIN_NAME){
    if(hint) hint.style.display='block';
    if(pin) pin.placeholder='Contraseña de tu correo '+SUPERADMIN_EMAIL;
    if(clientWrap) clientWrap.style.display='none';
  } else {
    if(hint) hint.style.display='none';
    if(clientWrap) clientWrap.style.display='';
  }
}

function detectLoginMode(val){
  const isEmail = val.includes('@');
  const modeHint = document.getElementById('login-mode-hint');
  const superHint = document.getElementById('login-superadmin-hint');
  const pin = document.getElementById('login-pin');
  if(isEmail && val.trim().toUpperCase()!==SUPERADMIN_NAME){
    if(modeHint) modeHint.style.display='block';
    if(superHint) superHint.style.display='none';
    if(pin) pin.placeholder='Contraseña de tu cuenta';
  } else {
    if(modeHint) modeHint.style.display='none';
    if(pin) pin.placeholder='Contraseña o PIN de acceso';
  }
}

function showForgotPassword(){
  const p=document.getElementById('forgot-panel');
  if(p) p.style.display=p.style.display==='none'?'block':'none';
}

async function sendPasswordReset(){
  const email=(document.getElementById('forgot-email')?.value||'').trim();
  const msg=document.getElementById('forgot-msg');
  if(!email){ if(msg) msg.textContent='Ingresa tu email.'; return; }
  try{
    await firebase.auth().sendPasswordResetEmail(email);
    if(msg){ msg.style.color='#166534'; msg.textContent='Enlace enviado. Revisa tu correo.'; }
  }catch(e){
    if(msg){ msg.style.color='#dc2626'; msg.textContent='Email no encontrado.'; }
  }
}

function doLogout(){
  // Force back to gantt tab before logout — prevents role leakage
  try{ switchTab('gantt'); }catch(_){}
  sessionStorage.removeItem('airtechassist_role');sessionStorage.removeItem('airtechassist_name');
  sessionStorage.removeItem('airtechassist_station');
  currentRole=null;currentUserName='';
  document.getElementById('main-app').style.display='none';
  document.getElementById('login-screen').style.display='flex';
  document.getElementById('login-pin').value='';
  document.getElementById('login-name').value='';
  document.getElementById('login-err').textContent='';
  detectSuperAdmin('');
}

function initSupabaseUI(){
  // Always hide config panel — credentials are pre-configured
  document.getElementById('sb-config-panel').style.display='none';
  document.getElementById('sb-status-bar').style.display='flex';
  document.getElementById('sb-project-name').textContent =
    (SUPABASE_URL||SB_DEFAULT_URL).replace('https://','').split('.')[0];
}

function applyRole(){
  const isSuperAdmin = currentRole==='superadmin';
  const isSupervisor = currentRole==='supervisor';
  const isTech       = currentRole==='tech';
  const isMCC        = currentRole==='mcc';
  const canManageOT  = isSuperAdmin||isSupervisor;
  const canManageUsers = isSuperAdmin;

  // Nueva OT button
  document.getElementById('btn-nueva-ot').style.display=canManageOT?'flex':'none';

  // Tech banner (solo para técnicos)
  document.getElementById('tech-banner').style.display=isTech?'flex':'none';

  // MCC: ocultar tabs no relevantes, solo mostrar MCC
  const tabGantt=document.getElementById('TAB-gantt');
  const tabDemand=document.getElementById('TAB-demand');
  const tabStaff=document.getElementById('TAB-staff');
  if(isMCC){
    if(tabGantt)  tabGantt.style.display='none';
    if(tabDemand) tabDemand.style.display='none';
    if(tabStaff)  tabStaff.style.display='none';
  } else {
    if(tabGantt)  tabGantt.style.display='';
    if(tabDemand) tabDemand.style.display='';
    if(tabStaff)  tabStaff.style.display='';
  }

  // Roster — agregar técnico
  const btnAddTech=document.getElementById('btn-add-tech');
  if(btnAddTech) btnAddTech.style.display=canManageOT?'flex':'none';
  document.getElementById('th-del').textContent='';

  // Documentos — subir archivos (elemento eliminado con VIEW-docs)
  const _upZone=document.getElementById('upload-zone-wrap');
  if(_upZone) _upZone.style.display=canManageOT?'block':'none';

  const btnAuto=document.getElementById('btn-autoassign');
  if(btnAuto) btnAuto.style.display=canManageOT?'flex':'none';
  // Pestaña Horarios — todos los roles autenticados pueden verla
  const tabSched=document.getElementById('TAB-schedule');
  if(tabSched) tabSched.style.display='';
  const tabFlights=document.getElementById('TAB-flights');
  if(tabFlights) tabFlights.style.display='';
  // btn-add-flight is created dynamically in switchTab('flights')
  const btnUpSched=document.getElementById('btn-upload-schedule');
  if(btnUpSched) btnUpSched.style.display=currentRole==='superadmin'?'flex':'none';
  const btnSavSched=document.getElementById('btn-save-schedule');
  if(btnSavSched) btnSavSched.style.display=currentRole==='superadmin'?'flex':'none';

  // Pestaña Dashboard — supervisor y superadmin
  const tabDash=document.getElementById('TAB-dashboard');
  if(tabDash) tabDash.style.display=canManageOT?'':'none';
  const tabMcc=document.getElementById('TAB-mcc');
  if(tabMcc) tabMcc.style.display=(isSuperAdmin||isMCC)?'':'none';

  // Pestaña Usuarios — solo superadmin
  const tabUsers=document.getElementById('TAB-users');
  if(tabUsers) tabUsers.style.display=canManageUsers?'':'none';

  // Pestaña Clientes — solo el superadmin de la plataforma (bgomez)
  const tabPlatform=document.getElementById('TAB-platform');
  const isPlatformAdmin = isSuperAdmin && AIRLINE_ID==='airtechassist';
  if(tabPlatform) tabPlatform.style.display=isPlatformAdmin?'':'none';
  const btnAddUser=document.getElementById('btn-add-user');
  if(btnAddUser) btnAddUser.style.display=canManageUsers?'flex':'none';

  // PDF report — supervisor y superadmin
  const btnPdf=document.getElementById('btn-pdf');
  if(btnPdf) btnPdf.style.display=canManageOT?'flex':'none';
  const ganttPdfRow=document.getElementById('gantt-pdf-row');
  if(ganttPdfRow) ganttPdfRow.style.display=canManageOT?'flex':'none';

  // Excel export — todos
  const btnExcel=document.getElementById('btn-excel');
  if(btnExcel) btnExcel.style.display='flex';

  // ── Force away from restricted tabs if role doesn't have access ──
  if(!canManageUsers){
    const usersView=document.getElementById('VIEW-users');
    if(usersView&&usersView.classList.contains('on')){
      try{ switchTab('gantt'); }catch(_){}
    }
  }
  if(!canManageOT){
    // techs can't accidentally stay on a write-only view
  }

  // Role badge
  const badges={
    superadmin:'<span class="role-badge" style="background:#7c3aed;color:#fff">👑 Super Admin: '+esc(currentUserName)+'</span>',
    supervisor:'<span class="role-badge" style="background:#dbeafe;color:#1e40af">🔑 Supervisor: '+esc(currentUserName)+'</span>',
    mcc:       '<span class="role-badge" style="background:#f5f3ff;color:#6d28d9;border:1.5px solid #c4b5fd">🌐 MCC: '+esc(currentUserName)+'</span>',
    tech:      '<span class="role-badge role-tech">👷 Técnico: '+esc(currentUserName)+'</span>',
  };
  document.getElementById('role-indicator').innerHTML = badges[currentRole]||badges.tech;
  initPlanTab();
  applyPlanGates();
}

// ══ SONIDOS — 4 tonos distintos estilo Boeing ══
function playSound(type){
  try{
    const ctx=new(window.AudioContext||window.webkitAudioContext)();
    const tone=(f,s,d,v=0.09,w='sine')=>{
      const o=ctx.createOscillator(),g=ctx.createGain();
      o.type=w; o.frequency.setValueAtTime(f,s);
      g.gain.setValueAtTime(v,s);
      g.gain.exponentialRampToValueAtTime(0.0001,s+d);
      o.connect(g); g.connect(ctx.destination);
      o.start(s); o.stop(s+d);
    };
    const n=ctx.currentTime;
    if(type==='new_ot'){
      // Nueva OT — doble tono Boeing ascendente
      tone(554.37,n,0.55); tone(659.25,n+0.30,0.75);
    } else if(type==='arrival'){
      // Llegada — DING-DONG-DING triple grave→agudo
      tone(392.00,n,0.30,0.12);
      tone(523.25,n+0.28,0.30,0.12);
      tone(659.25,n+0.56,0.50,0.10);
    } else if(type==='pre_departure'){
      // 10 min para salida — doble bip ambar suave
      tone(440.00,n,0.20,0.10);
      tone(440.00,n+0.25,0.20,0.10);
      tone(493.88,n+0.50,0.40,0.08);
    } else if(type==='departure'){
      // Hora de salida — alerta urgente descendente
      tone(880.00,n,0.15,0.14,'square');
      tone(783.99,n+0.18,0.15,0.13,'square');
      tone(659.25,n+0.36,0.20,0.12,'square');
      tone(523.25,n+0.56,0.35,0.10,'square');
    } else if(type==='delivered'){
      // Entregada — confirmacion positiva ascendente
      tone(523.25,n,0.20,0.10);
      tone(659.25,n+0.18,0.20,0.10);
      tone(783.99,n+0.36,0.40,0.12);
    }
  }catch(e){console.warn('Audio error:',e);}
}
function boeingChime(){ playSound('new_ot'); }

// ── Alertas por tiempo — se revisan cada 30 seg ──
let firedAlerts=JSON.parse(sessionStorage.getItem('airtechassist_alerts')||'{}');
function saveFiredAlerts(){ try{sessionStorage.setItem('airtechassist_alerts',JSON.stringify(firedAlerts));}catch(_){} }

function checkTimeAlerts(){
  if(!tasks||!tasks.length||!selectedDate) return;
  const now=new Date();
  const today=localDateStr(now);
  if(selectedDate!==today) return;
  const nowMin=now.getHours()*60+now.getMinutes();

  const getEtdDate=t=>{
    if(!t.taskDays||t.taskDays===0) return t.taskDate;
    const d=new Date(t.taskDate+'T12:00:00');
    d.setDate(d.getDate()+(t.taskDays||0));
    return localDateStr(d);
  };

  // ── Alerta de LLEGADA: solo la PRÓXIMA aeronave pendiente cuyo ETA aún no ha pasado
  // Ordena por gs ascendente y toma la primera cuyo gs >= nowMin - 2 (dentro de ventana)
  const pendingArrivals=tasks
    .filter(t=>t.taskDate===today&&t.status!=='entregada'&&t.status!=='reported')
    .sort((a,b)=>(a.gs||0)-(b.gs||0));
  const nextArrival=pendingArrivals.find(t=>(t.gs||0)>=nowMin-2);
  if(nextArrival){
    const gs=nextArrival.gs||0;
    if(!firedAlerts[nextArrival.id+'_arr']&&Math.abs(nowMin-gs)<=1){
      firedAlerts[nextArrival.id+'_arr']=true; saveFiredAlerts();
      playSound('arrival');
      showAlertBanner('arrival',nextArrival.ac,'ETA '+hhmm(gs)+' — aeronave en tierra');
      toast('✈ '+nextArrival.ac+' llegando — ETA '+hhmm(gs));
    }
  }

  // ── Alerta de SALIDA: solo la PRÓXIMA aeronave pendiente cuyo ETD aún no ha pasado
  const pendingDepartures=tasks
    .filter(t=>t.status!=='entregada'&&t.status!=='reported'&&getEtdDate(t)===today)
    .sort((a,b)=>(a.ge||0)-(b.ge||0));
  const nextDeparture=pendingDepartures.find(t=>(t.ge||0)>=nowMin-2);
  if(nextDeparture){
    const ge=nextDeparture.ge||0;
    // 10 min antes de salida
    if(!firedAlerts[nextDeparture.id+'_pre']&&ge>10&&Math.abs(nowMin-(ge-10))<=1){
      firedAlerts[nextDeparture.id+'_pre']=true; saveFiredAlerts();
      playSound('pre_departure');
      showAlertBanner('warning',nextDeparture.ac,'Faltan 10 min para ETD '+hhmm(ge));
      toast('⚠ '+nextDeparture.ac+' — 10 min para ETD '+hhmm(ge));
    }
    // Hora exacta de salida
    if(!firedAlerts[nextDeparture.id+'_dep']&&Math.abs(nowMin-ge)<=1){
      firedAlerts[nextDeparture.id+'_dep']=true; saveFiredAlerts();
      playSound('departure');
      showAlertBanner('danger',nextDeparture.ac,'ETD '+hhmm(ge)+' — ¡HORA DE SALIR!');
      toast('🚨 '+nextDeparture.ac+' — HORA DE SALIDA ETD '+hhmm(ge));
    }
  }
}

// ── Banner flotante de alerta ──
let _alertTimer=null;
function showAlertBanner(type,ac,msg){
  let el=document.getElementById('alert-banner');
  if(!el){ el=document.createElement('div'); el.id='alert-banner'; document.body.appendChild(el); }
  const cfg={
    arrival: {tc:'#166534',bg:'#dcfce7',border:'#22c55e',icon:'✈'},
    warning: {tc:'#92400e',bg:'#fffbeb',border:'#f59e0b',icon:'⚠️'},
    danger:  {tc:'#7f1d1d',bg:'#fee2e2',border:'#ef4444',icon:'🚨'}
  }[type]||{tc:'#1e293b',bg:'#fff',border:'#e2e8f0',icon:'ℹ️'};
  el.style.cssText=`position:fixed;top:70px;left:50%;transform:translateX(-50%);z-index:9998;background:${cfg.bg};border:2px solid ${cfg.border};border-radius:12px;padding:12px 20px;display:flex;align-items:center;gap:10px;font-size:13px;font-weight:600;color:${cfg.tc};box-shadow:0 8px 30px rgba(0,0,0,.25);max-width:360px;animation:slideDown .3s ease`;
  el.innerHTML=`<span style="font-size:24px">${cfg.icon}</span><div><div style="font-size:14px;font-weight:700">${esc(ac)}</div><div style="font-size:11px;opacity:.85">${esc(msg)}</div></div><button onclick="this.parentElement.style.display='none'" style="margin-left:10px;background:none;border:none;cursor:pointer;font-size:18px;color:${cfg.tc};opacity:.5;padding:0">✕</button>`;
  if(_alertTimer) clearTimeout(_alertTimer);
  _alertTimer=setTimeout(()=>{if(el)el.style.display='none';},8000);
}

// ══ STATE ══
let tasks=[], techs=[], history=[], documents=[];
let ganttPlanes = {}; // { taskId: { plane, eta, etd, ABOVE, RISE } } — animated aircraft per row
let formTechs=[], drag=null, TW=600, FB=null, currentUser=null;
let selectedDate=localDateStr();  // local date — avoids UTC shift
let editingTaskId=null, pendingFile=null;

// ══ TURNOS CONFIGURABLES ══
const SHIFT_COLORS = ['#3b82f6','#f59e0b','#8b5cf6','#22c55e','#ef4444','#ec4899','#14b8a6'];
const SHIFT_EMOJIS = ['🌅','🌇','🌙','☀️','🌆','🌃','🌄'];
let shiftDefs = [
  {id:'A', name:'Turno A', start:'05:00', end:'14:00', color:'#3b82f6', emoji:'🌅'},
  {id:'B', name:'Turno B', start:'13:00', end:'22:00', color:'#f59e0b', emoji:'🌇'},
  {id:'C', name:'Turno C', start:'21:00', end:'05:00', color:'#8b5cf6', emoji:'🌙'},
];

async function loadShiftDefs(){
  if(!window.FB) return;
  try{
    const snap=await FB.db.collection(AIRLINE_ID).doc('config').get();
    const d=snap.data();
    if(d?.shifts && Array.isArray(d.shifts) && d.shifts.length>0){
      shiftDefs=d.shifts;
    }
  }catch(e){ console.warn('loadShiftDefs:',e); }
  buildShiftBands();
  renderShiftEditor();
}

async function saveShiftDefs(){
  if(!window.FB) return;
  // Collect from form
  const rows=document.querySelectorAll('#shift-defs-list .shift-def-row');
  const updated=[];
  rows.forEach(row=>{
    const id   =row.dataset.id;
    const name =(row.querySelector('.sd-name')?.value||'').trim().toUpperCase()||id;
    const start=(row.querySelector('.sd-start')?.value||'').trim();
    const end  =(row.querySelector('.sd-end')?.value||'').trim();
    const color=(row.querySelector('.sd-color')?.value||'#3b82f6');
    const emoji=(row.querySelector('.sd-emoji')?.value||'⏰').trim()||'⏰';
    if(id&&start&&end) updated.push({id,name,start,end,color,emoji});
  });
  if(!updated.length){ toast('Agrega al menos un turno',true); return; }
  try{
    await FB.db.collection(AIRLINE_ID).doc('config').set({shifts:updated},{merge:true});
    shiftDefs=updated;
    buildShiftBands();
    renderStaff();
    toast('✅ Turnos guardados');
  }catch(e){ toast('Error: '+e.message,true); }
}

function addShiftDef(){
  const idx=shiftDefs.length;
  const color=SHIFT_COLORS[idx%SHIFT_COLORS.length];
  const emoji=SHIFT_EMOJIS[idx%SHIFT_EMOJIS.length];
  const id=String.fromCharCode(65+idx); // A, B, C, D…
  shiftDefs.push({id,name:'Turno '+id,start:'06:00',end:'14:00',color,emoji});
  renderShiftEditor();
}

function removeShiftDef(id){
  if(shiftDefs.length<=1){ toast('Debe haber al menos un turno',true); return; }
  shiftDefs=shiftDefs.filter(s=>s.id!==id);
  renderShiftEditor();
}

function renderShiftEditor(){
  const list=document.getElementById('shift-defs-list');
  if(!list) return;
  list.innerHTML='';
  shiftDefs.forEach(sh=>{
    const row=document.createElement('div');
    row.className='shift-def-row';
    row.dataset.id=sh.id;
    row.style.cssText='display:flex;gap:6px;align-items:center;background:#fff;border:1px solid #bae6fd;border-radius:8px;padding:8px 10px;flex-wrap:wrap';
    row.innerHTML=`
      <span style="font-size:11px;font-weight:700;color:#0369a1;min-width:20px">${sh.id}</span>
      <input class="fi sd-name" value="${esc(sh.name)}" placeholder="Nombre" style="width:110px;padding:4px 8px;font-size:11px" title="Nombre del turno">
      <input class="fi sd-emoji" value="${sh.emoji||'⏰'}" placeholder="🌅" style="width:42px;padding:4px 6px;font-size:16px;text-align:center" maxlength="2" title="Emoji">
      <span style="font-size:10px;color:#64748b">Inicio</span>
      <input type="time" class="fi sd-start" value="${sh.start}" style="width:90px;padding:4px 6px;font-size:12px" title="Hora de inicio">
      <span style="font-size:10px;color:#64748b">Fin</span>
      <input type="time" class="fi sd-end" value="${sh.end}" style="width:90px;padding:4px 6px;font-size:12px" title="Hora de fin">
      <input type="color" class="sd-color" value="${sh.color}" style="width:32px;height:32px;border:none;border-radius:6px;cursor:pointer;padding:2px" title="Color en el Gantt">
      <button onclick="removeShiftDef('${sh.id}')" style="background:#fee2e2;border:none;color:#dc2626;border-radius:6px;padding:4px 8px;cursor:pointer;font-size:12px" title="Eliminar turno">✕</button>
    `;
    list.appendChild(row);
  });
}

// ══ TÉCNICOS POR BASE ══
// No default techs — each installation adds its own staff via Roster
function getDefaultTechs(){ return []; }

// ══ UTILS ══
const uid   =()=>Math.random().toString(36).slice(2,9);
// ── Local date (not UTC) — avoids timezone shift issues ──
function localDateStr(d=new Date()){
  const y=d.getFullYear();
  const m=String(d.getMonth()+1).padStart(2,'0');
  const dy=String(d.getDate()).padStart(2,'0');
  return `${y}-${m}-${dy}`;
}
const snap5 =m=>Math.round(m/5)*5;
const hhmm  =m=>{const s=((m%1440)+1440)%1440;return`${String(Math.floor(s/60)).padStart(2,'0')}:${String(s%60).padStart(2,'0')}`;};
const toMin =s=>{const[h,m]=(s||'00:00').split(':').map(Number);return h*60+m;};
const fdur  =m=>{const h=Math.floor(m/60),mn=m%60;return`${h}h${mn?' '+mn+'m':''}`;};
const pct   =m=>(m/1440*100).toFixed(4)+'%';
const esc   =s=>String(s??'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
const fmtSz =b=>b>1048576?(b/1048576).toFixed(1)+' MB':b>1024?(b/1024).toFixed(0)+' KB':b+' B';
const fmtDt =ts=>ts?new Date(ts).toLocaleDateString('es-DO',{day:'2-digit',month:'short',year:'numeric'}):'';
const fmtDateLong=d=>{try{return new Date(d+'T12:00:00').toLocaleDateString('es-DO',{weekday:'long',year:'numeric',month:'long',day:'numeric'});}catch(_){return d;}};
const fileIcon=name=>{const e=(name||'').split('.').pop().toLowerCase();if(e==='pdf')return{icon:'📄',cls:'pdf'};if(['doc','docx'].includes(e))return{icon:'📝',cls:'doc'};if(['xls','xlsx'].includes(e))return{icon:'📊',cls:'xls'};if(['png','jpg','jpeg','gif'].includes(e))return{icon:'🖼️',cls:'img'};return{icon:'📎',cls:'other'};};

let tTimer;
function toast(msg,err=false){const el=document.getElementById('toast-el');el.textContent=msg;el.style.display='block';el.style.background=err?'#dc2626':'#1e293b';clearTimeout(tTimer);tTimer=setTimeout(()=>el.style.display='none',4000);}
function setStatus(live,txt){document.getElementById('status-dot').className=live?'dot-live':'dot-off';document.getElementById('status-txt').textContent=txt;}

// ══ CLOCK & TIME LINE ══
function updateClock(){
  const now=new Date();
  const hh=String(now.getHours()).padStart(2,'0'),mm=String(now.getMinutes()).padStart(2,'0');
  document.getElementById('clock').textContent=`🕐 ${hh}:${mm}`;
  updateTimeLine();
}
function updateTimeLine(){
  const tl=document.getElementById('time-line');
  const lbl=document.getElementById('time-line-label');
  if(!tl) return;
  const today=localDateStr(new Date());
  const isToday=selectedDate===today;
  tl.style.display=isToday?'block':'none';
  if(!isToday) return;
  const now=new Date(), mins=now.getHours()*60+now.getMinutes();
  const hh=String(now.getHours()).padStart(2,'0'),mm=String(now.getMinutes()).padStart(2,'0');
  tl.style.left=pct(mins);
  if(lbl)lbl.textContent=`${hh}:${mm}`;
  updateAllPlanes(); // reposition all animated aircraft
}
setInterval(()=>{
  updateClock();
  checkTimeAlerts();
},30000);
// Also check on initial load after 3 seconds
setTimeout(checkTimeAlerts, 3000);

// ── Online / Offline detection ──
function updateOnlineStatus(){
  const badge=document.getElementById('offline-badge');
  const dot=document.getElementById('status-dot');
  if(!navigator.onLine){
    if(badge){ badge.style.display='flex'; }
    toast('📵 Sin conexión — usando datos en caché',false);
  } else {
    if(badge){ badge.style.display='none'; }
    if(dot&&dot.className==='dot-live') toast('🌐 Conexión restaurada — sincronizando...',false);
  }
}
window.addEventListener('online',  updateOnlineStatus);
window.addEventListener('offline', updateOnlineStatus);
// Check immediately on load
setTimeout(updateOnlineStatus, 2000);

// ══ DATE ══
function onDateChange(){
  selectedDate=document.getElementById('date-filter').value;
  renderGantt();
  kpis(); // update tech shift count for new date
  // Always update demand chart and history regardless of active tab
  try{ renderDemand(); }catch(_){}
  try{ renderHistory(); }catch(_){}
  if(document.getElementById('VIEW-staff').classList.contains('on')) renderStaff();
  // Sync MCC if open
  if(document.getElementById('VIEW-mcc')?.classList.contains('on')){
    mccSelectedDate=selectedDate;
    const mccDateEl=document.getElementById('mcc-date-filter');
    if(mccDateEl) mccDateEl.value=selectedDate;
    renderMCC();
  }
}
function changeDay(o){
  const d=new Date(selectedDate+'T12:00:00');
  if(o===0){selectedDate=localDateStr();}
  else{d.setDate(d.getDate()+o);selectedDate=localDateStr(d);}
  document.getElementById('date-filter').value=selectedDate;
  renderGantt();
  kpis();
  if(document.getElementById('VIEW-staff').classList.contains('on')) renderStaff();
  if(document.getElementById('VIEW-mcc')?.classList.contains('on')){
    mccSelectedDate=selectedDate;
    const mccDateEl=document.getElementById('mcc-date-filter');
    if(mccDateEl) mccDateEl.value=selectedDate;
    renderMCC();
  }
}
function dayTasks(){
  // OTs del día seleccionado
  const autoGen = tasks.filter(t=>t.autoGenerated);
  if(autoGen.length) console.log('[Gantt] autoGenerated tasks in memory:', autoGen.length, autoGen.map(t=>t.taskDate+'/'+t.ac));
  const direct = tasks.filter(t=>t.taskDate===selectedDate);

  // OTs de días anteriores que continúan en el día seleccionado:
  //   - taskDays > 0 → ETD es en un día posterior
  //   - O start+dur > 1440 → cruzan medianoche (overnight sin taskDays)
  const prev = new Date(selectedDate+'T12:00:00');
  prev.setDate(prev.getDate()-1);
  const prevDate = localDateStr(prev);

  const carryOver = tasks.filter(t=>{
    if(t.taskDate===selectedDate) return false;
    const tBase = new Date(t.taskDate+'T12:00:00');
    const sSel  = new Date(selectedDate+'T12:00:00');
    const diffDays = Math.round((sSel - tBase)/(1000*60*60*24));
    if(diffDays <= 0) return false;
    const effectiveDays = t.taskDays>0 ? t.taskDays : (t.start+t.dur>1440 ? 1 : 0);
    return diffDays <= effectiveDays;
  }).map(t=>{
    const carryOverDay = Math.round(
      (new Date(selectedDate+'T12:00:00') - new Date(t.taskDate+'T12:00:00'))/(1000*60*60*24)
    );
    const dayOffset = carryOverDay * 1440;
    const maintenanceEndOnDay = (t.start + t.dur) - dayOffset;
    const maintDone = maintenanceEndOnDay <= 0; // mantenimiento ya terminó en día anterior
    const adjDur = maintDone ? 0 : Math.max(10, Math.min(maintenanceEndOnDay, t.ge));
    return {
      ...t,
      _carryOver: true,
      _carryOverDay: carryOverDay,
      _maintDone: maintDone,
      start: 0,
      dur: adjDur
    };
  });

  return [...direct, ...carryOver].sort((a,b)=>(a.ge||0)-(b.ge||0));
}

// ══ FIREBASE ══
let _unsubs = []; // Firestore unsubscribe handles

function subscribeAll(){
  const st = window._station;
  if(!st){ console.warn('subscribeAll: no station set'); return; }
  _unsubs.forEach(u=>{try{u();}catch(_){}});
  _unsubs=[];
  techs=[]; tasks=[]; history=[]; documents=[]; activeReports=[];

  _unsubs.push(FB.onSnapshot(FB.TECHS(st),snap=>{
    techs=snap.docs.map(d=>({id:d.id,...d.data()}));
    techs.sort((a,b)=>a.name.localeCompare(b.name));
    if(document.getElementById('VIEW-staff').classList.contains('on'))renderStaff();
    kpis();
  }));

  _unsubs.push(FB.onSnapshot(FB.TASKS(st),snap=>{
    tasks=snap.docs.map(d=>({id:d.id,...d.data()}));
    renderGantt();
    if(document.getElementById('VIEW-demand').classList.contains('on')){renderDemand();renderHistory();}
    if(document.getElementById('VIEW-dashboard')?.classList.contains('on') && typeof renderDashboard==='function') renderDashboard();
    saveSnap();
  }));

  _unsubs.push(FB.onSnapshot(FB.HIST(st),snap=>{
    history=snap.docs.map(d=>({id:d.id,...d.data()}));
    history.sort((a,b)=>a.date.localeCompare(b.date));
  }));

  _unsubs.push(FB.onSnapshot(FB.DOCS(st),snap=>{
    documents=snap.docs.map(d=>({id:d.id,...d.data()}));
    documents.sort((a,b)=>b.uploadedAt-a.uploadedAt);
  }));

  loadNotifConfig(st);

  // ── Plans listener ──
  _unsubs.push(FB.onSnapshot(FB.PLANS(st),snap=>{
    plans=snap.docs.map(d=>({id:d.id,...d.data()}));
    plans.sort((a,b)=>(a.dueDate||'').localeCompare(b.dueDate||''));
    if(document.getElementById('VIEW-plan')?.classList.contains('on')) renderPlan();
  }));

  // ── Reports listener ──
  _unsubs.push(FB.onSnapshot(FB.REPORTS(st),snap=>{
    const prev=activeReports.map(r=>r.id);
    const allActive=snap.docs.map(d=>({id:d.id,...d.data()})).filter(r=>!r.resolved);
    // Notificaciones: disparar para CUALQUIER reporte nuevo, sin importar fecha
    allActive.forEach(r=>{
      if(!prev.includes(r.id)){
        playSound('departure');
        showAlertBanner('danger', r.ac, '⚠ REPORTE: '+r.message.substring(0,60));
        toast('🚨 Reporte en '+r.ac+': '+r.message.substring(0,50), false);
        sendAlerts(r); // ← alertas automáticas
      }
    });
    // activeReports: solo los del día seleccionado (para barras y tarjetas en Gantt)
    activeReports=allActive.filter(r=>r.dateStr===selectedDate);
    if(document.getElementById('VIEW-gantt').classList.contains('on')) renderGantt();
  }));
}

(function wait(){if(window.FB){FB=window.FB;initFB();}else setTimeout(wait,80);})();

// Timeout: si Firebase no responde en 8s, mostrar diagnóstico
const fbTimeout=setTimeout(()=>{
  const errEl=document.getElementById('loader-err');
  const errMsg=document.getElementById('loader-err-msg');
  const domEl=document.getElementById('loader-domain');
  const spin=document.getElementById('loader-spin');
  if(errEl){
    errEl.style.display='block';
    if(spin)spin.style.display='none';
    if(domEl)domEl.textContent=window.location.hostname;
    // Check if Firebase even loaded
    if(typeof firebase === 'undefined'){
      errMsg.textContent='⚠ Los scripts de Firebase no cargaron. Verifica tu conexión a internet y recarga.';
    } else if(!window.FB){
      errMsg.textContent='⚠ Firebase se cargó pero no se inicializó. Recarga la página.';
    } else {
      errMsg.textContent='Timeout esperando Firebase Auth (20s). Dominio: '+window.location.hostname+'. Revisa la consola del navegador (F12) para ver el error exacto.';
    }
  }
},20000);

function initFB(){
  function _tryAnonSignIn(){
    FB.signInAnonymously().catch(e=>{
      clearTimeout(fbTimeout);
      setStatus(false,'Error auth');
      const errEl=document.getElementById('loader-err');
      const errMsg=document.getElementById('loader-err-msg');
      const spin=document.getElementById('loader-spin');
      // Specific message for anonymous auth disabled
      if(e.code==='auth/admin-restricted-operation' || e.code==='auth/operation-not-allowed'){
        if(errEl){ errEl.style.display='block'; spin.style.display='none';
          errMsg.textContent='⚠ Activa Autenticación Anónima en Firebase Console → Authentication → Sign-in method → Anonymous'; }
        return;
      }
      if(errEl){ errEl.style.display='block'; spin.style.display='none';
        errMsg.textContent='signInAnonymously falló: '+e.code+' — '+e.message; }
    });
  }
  FB.onAuthStateChanged(null,async user=>{
    // No user at all — sign in anonymously (first load or signed out)
    if(!user){ _tryAnonSignIn(); return; }

    clearTimeout(fbTimeout); // Firebase conectó OK
    currentUser=user;
    document.getElementById('uid-label').textContent='ID: '+user.uid.slice(0,8)+'…';
    setStatus(true,'Conectado — tiempo real');
    document.getElementById('loader').classList.add('hide');

    // Restaurar o resolver clientId ANTES de cargar datos
    const savedClient=sessionStorage.getItem('airtechassist_client');
    if(savedClient){
      setClientId(savedClient);
    } else if(!user.isAnonymous){
      // Usuario email-auth — buscar clientId en el registro global
      try{
        const reg=await FB.db.collection('registry').doc(user.uid).get();
        if(reg.exists) setClientId(reg.data().clientId);
      }catch(e){ console.warn('[Auth] registry lookup:', e.message); }
    }

    // Check session
    const savedRole=sessionStorage.getItem('airtechassist_role');
    const savedName=sessionStorage.getItem('airtechassist_name');
    const rawStation=sessionStorage.getItem('airtechassist_station');
    // Validate saved station still exists — fall back to first available
    const validStation = (rawStation && stations.find(s=>s.code===rawStation))
      ? rawStation
      : (stations[0]?.code || '');
    if(rawStation && rawStation!==validStation){
      // Saved station no longer exists — clear it
      sessionStorage.removeItem('airtechassist_station');
    }
    const savedStation = validStation;
    if(savedRole&&savedName){
      // Superadmin requires email auth. If still anonymous, clear cache → force re-login.
      if(savedRole==='superadmin' && user.isAnonymous){
        sessionStorage.removeItem('airtechassist_role');
        sessionStorage.removeItem('airtechassist_name');
        document.getElementById('login-screen').style.display='flex';
      } else {
        loginStation=savedStation;
        _loginSuccess(savedName, savedRole);
      }
    } else {
      document.getElementById('login-screen').style.display='flex';
    }

    document.getElementById('date-filter').value=selectedDate;
    buildAxis(); buildShiftBands(); updateClock();
    loadStations(); // dynamic stations from Firestore
    // subscribeAll() is called by _loginSuccess once the user has a valid role
  });
}

// ══ TABS ══
function switchTab(n){
  if(n!=='platform' && !planAllowsTab(n)){ showUpgradeModal(n); return; }
  ['gantt','demand','staff','users','plan','mcc','catalog','dashboard','schedule','flights','platform'].forEach(v=>{
    const view=document.getElementById('VIEW-'+v);
    const tab=document.getElementById('TAB-'+v);
    if(view) view.classList.toggle('on',v===n);
    if(tab)  tab.classList.toggle('on',v===n);
  });
  if(n==='demand')    {renderDemand();renderHistory();}
  if(n==='staff')     renderStaff();
  if(n==='users')     setTimeout(()=>{renderUsers();renderNotifConfig();renderAircraftManager();},100);
  if(n==='dashboard') setTimeout(()=>{ if(typeof renderDashboard==='function') renderDashboard(); else setTimeout(()=>renderDashboard(),500); },80);
  if(n==='mcc'){initMCC();setTimeout(()=>renderMCC(),100);}
  if(n==='plan')    { initPlanTab(); setTimeout(()=>renderPlan(),50); }
  if(n==='schedule'){ setTimeout(()=>{ if(typeof renderScheduleView==='function') renderScheduleView(); },50); }
  if(n==='flights'){
    setTimeout(()=>{
      const canAdd = currentRole==='superadmin'; // Solo superadmin crea vuelos
      // Try wrap first, then fallback to injecting next to subtitle
      let wrap = document.getElementById('btn-add-flight-wrap');
      if(!wrap){
        // Create wrap next to flights-subtitle
        const sub = document.getElementById('flights-subtitle');
        if(sub && sub.parentNode){
          wrap = document.createElement('span');
          wrap.id = 'btn-add-flight-wrap';
          sub.parentNode.parentNode.querySelector('div:last-child')?.appendChild(wrap);
        }
      }
      if(canAdd){
        // Remove existing button if any
        const existing = document.getElementById('btn-add-flight');
        if(existing) existing.remove();
        // Create fresh button
        const btn = document.createElement('button');
        btn.id = 'btn-add-flight';
        btn.onclick = () => openFlightModal(null);
        btn.style.cssText = 'display:inline-flex;align-items:center;gap:6px;background:#0f2a66;color:#fff;border:none;padding:8px 16px;border-radius:8px;font-size:13px;font-weight:700;cursor:pointer';
        btn.textContent = '✈️ + Nuevo vuelo';
        if(wrap) wrap.appendChild(btn);
        else {
          // Last resort: append to the flights card header
          const card = document.querySelector('#VIEW-flights .card > div:first-child');
          if(card) card.appendChild(btn);
        }
        // Show API sync bar for superadmin
        const syncBar = document.getElementById('flight-sync-bar');
        if(syncBar) syncBar.style.display='block';
        // Set date default and station label
        const apiDate = document.getElementById('api-sync-date');
        if(apiDate && !apiDate.value) apiDate.value = selectedDate;
        const stLbl = document.getElementById('api-sync-station-lbl');
        if(stLbl) stLbl.textContent = window._station || '—';
      } else {
        const syncBar = document.getElementById('flight-sync-bar');
        if(syncBar) syncBar.style.display='none';
      }
      renderFlightsView();
    },100);
  }
  if(n==='platform') loadPlatformClients();
}

// ══ KPIs ══
function kpis(){
  const dt=dayTasks(),hrs=demandHrs();
  document.getElementById('kv1').textContent=dt.length;
  document.getElementById('kv2').textContent=new Set(dt.map(t=>t.ac)).size;
  // Count techs on shift for selected date, broken down by shift
  const todayDate = selectedDate || localDateStr();
  const [_y,_m,_d] = todayDate.split('-').map(Number);
  const _monthKey = _y+'-'+String(_m).padStart(2,'0');
  const _station = activeStation();
  const _schedKey = _monthKey+'-'+_station;
  const _schedData = scheduleData[_schedKey];

  const kv3El = document.getElementById('kv3');
  const kv3ShiftEl = document.getElementById('kv3-shifts'); // new breakdown element

  if(_schedData && _schedData.personnel){
    // Count by shift for this day
    const shiftCount = {A:0, B:0, C:0, ADM:0, OFF:0};
    _schedData.personnel.forEach(p => {
      const day = p.schedule?.[String(_d)];
      const code = day?.code||'';
      const base = code[0]||'';
      if(!day||!day.working) { shiftCount.OFF++; return; }
      if(base==='A') shiftCount.A++;
      else if(base==='B') shiftCount.B++;
      else if(base==='C') shiftCount.C++;
      else if(code==='ADM') shiftCount.ADM++;
      else shiftCount.OFF++;
    });
    // Also count only maintenance techs (those in roster) for reference
    const rosterOnShift = techs.filter(t=>{
      const person = _schedData.personnel.find(p=>{
        const pn=p.name.toUpperCase().trim(), tn=(t.name||'').toUpperCase().trim();
        return pn===tn||pn.includes(tn)||tn.includes(pn);
      });
      if(!person) return false;
      const day = person.schedule?.[String(_d)];
      return day?.working===true;
    });
    // Use shiftCount sum as primary (most accurate - direct from schedule)
    const total = shiftCount.A+shiftCount.B+shiftCount.C+shiftCount.ADM;
    if(kv3El){
      kv3El.textContent = total+' / '+techs.length;
      kv3El.title = 'En turno hoy — A:'+shiftCount.A+' B:'+shiftCount.B+' C:'+shiftCount.C+(shiftCount.ADM?' ADM:'+shiftCount.ADM:'');
    }
    // Show breakdown badges
    if(kv3ShiftEl){
      kv3ShiftEl.innerHTML = 
        (shiftCount.A?'<span style="background:#dbeafe;color:#1e40af;padding:1px 6px;border-radius:8px;font-size:10px;font-weight:700">A:'+shiftCount.A+'</span> ':'') +
        (shiftCount.B?'<span style="background:#fef9c3;color:#92400e;padding:1px 6px;border-radius:8px;font-size:10px;font-weight:700">B:'+shiftCount.B+'</span> ':'') +
        (shiftCount.C?'<span style="background:#f3e8ff;color:#6b21a8;padding:1px 6px;border-radius:8px;font-size:10px;font-weight:700">C:'+shiftCount.C+'</span> ':'') +
        (shiftCount.ADM?'<span style="background:#dcfce7;color:#166534;padding:1px 6px;border-radius:8px;font-size:10px;font-weight:700">ADM:'+shiftCount.ADM+'</span>':'');
    }
  } else {
    // No schedule loaded
    if(kv3El){ kv3El.textContent = techs.length; kv3El.title='Sin horario cargado'; }
    if(kv3ShiftEl) kv3ShiftEl.innerHTML = '<span style="font-size:9px;color:#94a3b8">sin horario</span>';
  }
  document.getElementById('kv4').textContent=Math.max(...hrs,0);
  const c=dt.filter(t=>hasConflict(t,dt)).length;
  const el=document.getElementById('kv5');el.textContent=c;el.style.color=c>0?'#a32d2d':'#2a6040';
  document.getElementById('date-count').textContent=dt.length+' vuelo'+(dt.length!==1?'s':'');
  // AOG count
  const aogList=dt.filter(t=>t.aog);
  const aogEl=document.getElementById('kv-aog');
  const aogCard=document.getElementById('kpi-aog');
  if(aogEl){
    aogEl.textContent=aogList.length;
    if(aogCard) aogCard.style.display=aogList.length>0?'':'none';
  }
  // Unassigned hours
  const unassigned=totalUnassignedHours();
  const kv6=document.getElementById('kv6');
  if(kv6){
    kv6.textContent=unassigned%1===0?unassigned+'h':unassigned.toFixed(1)+'h';
    kv6.style.color=unassigned>20?'#166534':unassigned>10?'#b45309':'#dc2626';
  }
}
function hasConflict(t,all){const s=t.start,e=s+t.dur;return(t.staff||[]).some(tid=>all.some(o=>{if(o.id===t.id)return false;if(!(o.staff||[]).includes(tid))return false;return s<(o.start+o.dur)&&e>o.start;}));}
// ── Hours assigned per technician for the selected day ──
function techAssignedHours(){
  const dt=dayTasks();
  const assigned={};
  dt.forEach(t=>{
    const durHrs=t.dur/60;
    (t.staff||[]).forEach(id=>{
      assigned[id]=(assigned[id]||0)+durHrs;
    });
    if(t.gaseo)    assigned[t.gaseo]   =(assigned[t.gaseo]   ||0)+0.5;   // +30 min
    if(t.despacho) assigned[t.despacho]=(assigned[t.despacho]||0)+0.25;  // +15 min
  });
  return assigned;
}

// ── Total unassigned hours — solo los técnicos que trabajan ese día ──
function totalUnassignedHours(){
  const dt=dayTasks();
  const assigned=techAssignedHours();
  // Collect unique tech IDs that appear in at least one OT today
  const activeTechIds=new Set();
  dt.forEach(t=>(t.staff||[]).forEach(id=>activeTechIds.add(id)));
  // Sum remaining hours only for those techs
  let total=0;
  activeTechIds.forEach(id=>{
    const tech=techs.find(t=>t.id===id);
    if(!tech) return;
    const worked=assigned[id]||0;
    const remaining=Math.max(0,(tech.hours||0)-worked);
    total+=remaining;
  });
  return total;
}

function demandHrs(){const h=Array(24).fill(0);dayTasks().forEach(t=>{for(let i=0;i<24;i++)if(t.start<(i+1)*60&&(t.start+t.dur)>i*60)h[i]+=t.staff.length;});return h;}
async function saveSnap(){
  if(!FB)return;
  try{
    const h=demandHrs(),d=selectedDate||localDateStr(),st=activeStation();
    const data={date:d,hrs:[...h],tasks:dayTasks().map(t=>({ac:t.ac,wo:t.wo,start:hhmm(t.start),end:hhmm(t.start+t.dur),staff:t.staff.length})),updatedAt:Date.now()};
    await FB.db.collection(AIRLINE_ID).doc(st).collection('history').doc(d).set(data,{merge:true});
  }catch(e){console.warn('saveSnap:',e);}
}

// ══ AXIS ══
function buildAxis(){const el=document.getElementById('gaxis');el.innerHTML='';for(let i=0;i<=24;i++){const s=document.createElement('span');s.style.left=pct(i*60);s.textContent=(i<10?'0':'')+i;el.appendChild(s);}}
function buildShiftBands(){
  const el=document.getElementById('shift-bands');
  if(!el) return;
  el.innerHTML='';
  function hexToRgba(hex,a){
    const r=parseInt(hex.slice(1,3),16),g=parseInt(hex.slice(3,5),16),b=parseInt(hex.slice(5,7),16);
    return `rgba(${r},${g},${b},${a})`;
  }
  shiftDefs.forEach(sh=>{
    const s=timeStrToMin(sh.start), e=timeStrToMin(sh.end);
    const c=hexToRgba(sh.color||'#3b82f6',.25);
    if(e>s){
      // Same day
      const d=document.createElement('div');
      d.style.cssText=`position:absolute;top:0;bottom:0;left:${pct(s)};width:${pct(e-s)};background:${c}`;
      el.appendChild(d);
    } else {
      // Overnight: two segments
      const d1=document.createElement('div');
      d1.style.cssText=`position:absolute;top:0;bottom:0;left:${pct(s)};width:${pct(1440-s)};background:${c}`;
      el.appendChild(d1);
      const d2=document.createElement('div');
      d2.style.cssText=`position:absolute;top:0;bottom:0;left:0;width:${pct(e)};background:${c}`;
      el.appendChild(d2);
    }
  });
}
function timeStrToMin(t){ if(!t) return 0; const [h,m]=(t||'00:00').split(':').map(Number); return h*60+(m||0); }
function mTW(){const ax=document.getElementById('gaxis');if(ax)TW=ax.offsetWidth||620;}

// ══ AIRCRAFT TRAJECTORY ANIMATION ══════════════════════════════════════════
// Adds an approach / on-ground / departure plane icon to each Gantt row.
// The plane rises 30 px above the track, touches the amber gslot at ETA
// and climbs back to sky level 45 min after ETD.
const TRAJ_ABOVE = 32;  // px the plane flies above the gslot centre
const TRAJ_YGND  = 27;  // gslot centre from trackWrap top = 8px padding-top + 38/2 track height
const TRAJ_RISE  = 45;  // minutes of approach / departure trajectory
const TRAJ_YSKY  = TRAJ_YGND - TRAJ_ABOVE; // = -5 (above trackWrap top)

function addFlightPlane(task, trackWrap){
  const eta = task.gs;
  const etd = task.ge;
  if(!eta || !etd || etd <= eta) return;

  const ns = 'http://www.w3.org/2000/svg';

  // ── Container (sibling of .track, covers full trackWrap) ──
  const wrap = document.createElement('div');
  wrap.id = 'PLTRAJ_' + task.id;
  wrap.style.cssText = 'position:absolute;top:0;left:0;right:0;bottom:0;pointer-events:none;overflow:visible;z-index:8';

  // ── SVG trajectory lines ──
  // SVG is positioned so y=0 is at TRAJ_YSKY (sky) and y=TRAJ_ABOVE is gslot level
  const svgH = TRAJ_ABOVE + 28;
  const svg  = document.createElementNS(ns,'svg');
  svg.style.cssText = `position:absolute;top:${TRAJ_YSKY}px;left:0;width:100%;height:${svgH}px;overflow:visible;pointer-events:none`;

  const xA1 = ((eta - TRAJ_RISE) / 1440 * 100).toFixed(3) + '%';
  const xA2 = (eta               / 1440 * 100).toFixed(3) + '%';
  const xD1 = (etd               / 1440 * 100).toFixed(3) + '%';
  const xD2 = ((etd + TRAJ_RISE) / 1440 * 100).toFixed(3) + '%';
  const yTop = 0;
  const yGnd = TRAJ_ABOVE; // in SVG coords (sky→gslot)

  const mkLine = (x1,y1,x2,y2) => {
    const l = document.createElementNS(ns,'line');
    l.setAttribute('x1',x1); l.setAttribute('y1',y1);
    l.setAttribute('x2',x2); l.setAttribute('y2',y2);
    l.setAttribute('stroke','#64748b');
    l.setAttribute('stroke-width','1.5');
    l.setAttribute('stroke-dasharray','5,4');
    l.setAttribute('opacity','0.65');
    return l;
  };
  svg.appendChild(mkLine(xA1, yTop, xA2, yGnd));  // approach
  svg.appendChild(mkLine(xD1, yGnd, xD2, yTop));  // departure

  // Small ETA / ETD tick marks
  const mkTick = (xPct, label) => {
    const g = document.createElementNS(ns,'g');
    const line = document.createElementNS(ns,'line');
    line.setAttribute('x1', xPct); line.setAttribute('y1', yGnd - 4);
    line.setAttribute('x2', xPct); line.setAttribute('y2', yGnd + 4);
    line.setAttribute('stroke','#f59e0b'); line.setAttribute('stroke-width','1.5');
    const txt = document.createElementNS(ns,'text');
    txt.setAttribute('x', xPct); txt.setAttribute('y', yGnd - 6);
    txt.setAttribute('text-anchor','middle');
    txt.setAttribute('font-size','7');
    txt.setAttribute('font-family','monospace');
    txt.setAttribute('fill','#f59e0b');
    txt.setAttribute('font-weight','700');
    txt.textContent = label;
    g.appendChild(line); g.appendChild(txt);
    return g;
  };
  svg.appendChild(mkTick(xA2, 'ETA'));
  svg.appendChild(mkTick(xD1, 'ETD'));

  wrap.appendChild(svg);

  // ── Plane badge (circle + icon, high-contrast) ──
  const plane = document.createElement('div');
  plane.style.cssText = [
    'position:absolute',
    'width:20px','height:20px',
    'border-radius:50%',
    'background:#1e40af',
    'color:#fff',
    'font-size:11px',
    'line-height:20px',
    'text-align:center',
    'box-shadow:0 2px 6px rgba(0,0,0,.45)',
    'border:1.5px solid rgba(255,255,255,.7)',
    'transition:left .6s linear,top .6s linear,transform .4s ease,background .3s ease',
    'pointer-events:none',
    'display:none',
    'z-index:20',
    'user-select:none',
  ].join(';');
  plane.textContent = '✈';
  wrap.appendChild(plane);

  trackWrap.style.position = 'relative';
  trackWrap.style.overflow  = 'visible';
  trackWrap.appendChild(wrap);

  ganttPlanes[task.id] = { plane, eta, etd };
  updateSinglePlane(task.id);
}

function updateSinglePlane(taskId){
  const p = ganttPlanes[taskId];
  if(!p) return;
  const { plane, eta, etd, wrap } = p;

  // Only animate on today's date
  if(selectedDate !== localDateStr(new Date())){ plane.style.display='none'; return; }

  const now    = new Date();
  const nowMin = now.getHours()*60 + now.getMinutes();
  const approachStart = eta  - TRAJ_RISE;
  const departureEnd  = etd  + TRAJ_RISE;

  if(nowMin < approachStart || nowMin > departureEnd){ plane.style.display='none'; return; }

  // ── Measure real gslot y-centre relative to wrap ──
  // wrap is position:absolute inside trackWrap; gslot is inside .track inside trackWrap.
  // We measure the gslot element position so we don't need to assume padding/height values.
  const gslotEl = document.getElementById('GS' + taskId);
  const wrapEl  = wrap;
  let gndY = TRAJ_YGND; // fallback to constant if DOM not ready yet
  if(gslotEl && wrapEl){
    const gr  = gslotEl.getBoundingClientRect();
    const wr  = wrapEl.getBoundingClientRect();
    gndY = (gr.top + gr.height / 2) - wr.top; // gslot centre relative to wrap top
  }
  const skyY = gndY - TRAJ_ABOVE;
  const HALF = 10; // half of 20px badge

  plane.style.display = 'block';
  let xPct, yPx, angle;

  if(nowMin <= eta){
    // ── Approaching — blue badge, nose down ──
    const prog = (nowMin - approachStart) / TRAJ_RISE;
    xPct  = (approachStart + TRAJ_RISE * prog) / 1440 * 100;
    yPx   = skyY + (gndY - skyY) * prog - HALF;
    angle = 32;
    plane.style.background = '#1e40af';
  } else if(nowMin <= etd){
    // ── On ground — orange badge, level ──
    const prog = (nowMin - eta) / Math.max(etd - eta, 1);
    xPct  = (eta + (etd - eta) * prog) / 1440 * 100;
    yPx   = gndY - HALF;
    angle = 0;
    plane.style.background = '#c2410c'; // deep orange, contrasts amber gslot
  } else {
    // ── Departing — green badge, nose up ──
    const prog = (nowMin - etd) / TRAJ_RISE;
    xPct  = (etd + TRAJ_RISE * prog) / 1440 * 100;
    yPx   = gndY - (gndY - skyY) * prog - HALF;
    angle = -32;
    plane.style.background = '#15803d';
  }

  plane.style.left      = `calc(${xPct.toFixed(3)}% - ${HALF}px)`;
  plane.style.top       = `${yPx.toFixed(1)}px`;
  plane.style.transform = `rotate(${angle}deg)`;
  plane.style.opacity   = '1';
}

function updateAllPlanes(){
  Object.keys(ganttPlanes).forEach(updateSinglePlane);
}

// ══ GANTT — layout en 3 columnas separadas ══
function renderGantt(){
  mTW();
  ganttPlanes = {}; // reset animated planes for this render
  const isAdmin=(currentRole==='superadmin'||currentRole==='supervisor'||currentRole==='admin');
  const dt=dayTasks();
  document.getElementById('gantt-date-lbl').textContent=fmtDateLong(selectedDate);

  const ganttRows=document.getElementById('gantt-rows');
  ganttRows.innerHTML='';

  updateTimeLine();

  if(!dt.length){
    ganttRows.innerHTML=`<div style="text-align:center;padding:32px;color:#94a3b8;font-size:12px">Sin órdenes para <strong>${selectedDate}</strong>.${isAdmin?' Haz clic en <strong>+ Nueva OT</strong>.':''}</div>`;
    kpis(); return;
  }

  dt.forEach(t=>{
    const conf=hasConflict(t,dt), bc=t.status==='entregada'?'#6b7280':t.aog?'#7f1d1d':conf?'#dc2626':'#0f2a66';

    // For carry-over: start=0, dur=ge already set in dayTasks()
    const barStart = t.start;
    const barDur   = t.dur;
    const slotStart = t._carryOver ? 0    : t.gs;
    const slotEnd   = t._carryOver ? t.ge : t.ge;
    const bL=pct(barStart), bW=t._maintDone ? '0%' : pct(Math.max(barDur,10));
    const gL=pct(slotStart), gW=pct(Math.max(slotEnd-slotStart,0));
    const buf = t._carryOver ? 0 : t.ge-(t.start+t.dur);
    const names=(t.staff||[]).map(id=>techs.find(s=>s.id===id)?.name?.split(' ')[0]).filter(Boolean).join(', ');
    const gaseoN=t.gaseo?techs.find(s=>s.id===t.gaseo)?.name?.split(' ')[0]||'—':'—';
    const despN=t.despacho?techs.find(s=>s.id===t.despacho)?.name?.split(' ')[0]||'—':'—';
    const outW=(t.start<t.gs||(t.start+t.dur)>t.ge);
    const hasCmt=!!(t.comments&&t.comments.trim());

    // ─ ROW WRAPPER — keeps info + track + actions aligned ─
    const rowWrap=document.createElement('div');
    rowWrap.style.cssText='display:flex;align-items:flex-start;margin-bottom:4px;border-radius:8px;padding:2px 0';
    rowWrap.addEventListener('mouseenter',()=>rowWrap.style.background='#f8fafc');
    rowWrap.addEventListener('mouseleave',()=>rowWrap.style.background='');

    // ─ INFO (fixed 210px) ─
    const firstTech=(t.staff&&t.staff.length)?techs.find(s=>s.id===t.staff[0]):null;
    const firstTechName=firstTech?firstTech.name.split(' ').slice(0,2).join(' '):'—';
    const gaseoFullN=t.gaseo?techs.find(s=>s.id===t.gaseo)?.name?.split(' ').slice(0,2).join(' ')||'—':'—';
    const despFullN=t.despacho?techs.find(s=>s.id===t.despacho)?.name?.split(' ').slice(0,2).join(' ')||'—':'—';
    const infoDiv=document.createElement('div');
    infoDiv.style.cssText='width:210px;flex-shrink:0;padding-right:10px;padding-top:8px;min-width:0';
    const station = activeStation();
    // Look up flight info from flightsData if OT doesn't have it
    let _arrOrigin=t.arrOrigin||'', _depDest=t.depDest||'', _arrFlt=t.arrFlt||'', _depFlt=t.depFlt||'';
    // Pre-calculate delay for this task (used in route badge + status label)
    let _taskLate = false;
    if(t.status==='entregada' && t.deliveredAt && t.ge){
      const _dm = t.deliveredAt.match(/(\d{1,2}):(\d{2})(?:\s*(a\.?\s*m\.?|p\.?\s*m\.?))?/i);
      if(_dm){
        let _dh=parseInt(_dm[1]),_dmi=parseInt(_dm[2]);
        if(_dm[3]&&/p/i.test(_dm[3])&&_dh!==12)_dh+=12;
        if(_dm[3]&&!/p/i.test(_dm[3])&&_dh===12)_dh=0;
        _taskLate = (_dh*60+_dmi) > t.ge;
      }
    }
    if((!_arrOrigin||!_depDest) && t.ac && flightsData && flightsData.length){
      const dow = new Date((t.taskDate||selectedDate)+'T12:00:00').getDay();
      const fl = flightsData.find(f=>f.ac===t.ac && (!f.days||!f.days.length||f.days.includes(dow)));
      if(fl){
        if(!_arrOrigin) _arrOrigin = fl.origin||'';
        if(!_depDest)   _depDest   = fl.dest||'';
        if(!_arrFlt)    _arrFlt    = fl.number||'';
        if(!_depFlt)    _depFlt    = fl.number||'';
      }
    }
    const routeHtml = (_arrOrigin||_depDest)?`<div style="font-size:10px;color:#64748b;display:flex;align-items:center;gap:3px;margin:2px 0 1px">
      ${_arrOrigin?'<span style="background:#eff6ff;color:#1e40af;padding:1px 5px;border-radius:4px;font-weight:700">'+esc(_arrOrigin)+'</span><span style="color:#cbd5e1">→</span>':''}
      <span style="background:#f0fdf4;color:#166534;padding:1px 5px;border-radius:4px;font-weight:700">${esc(station)}</span>
      ${_depDest?'<span style="color:#cbd5e1">→</span><span style="background:#eff6ff;color:#1e40af;padding:1px 5px;border-radius:4px;font-weight:700">'+esc(_depDest)+'</span>':''}
    </div>`:'';
    infoDiv.innerHTML=`
      <div style="font-weight:700;font-size:13px;display:flex;align-items:center;gap:4px;flex-wrap:wrap">
        ${esc(t.ac)}
        ${t.aog?'<span style="background:#dc2626;color:#fff;font-size:8px;font-weight:700;padding:2px 6px;border-radius:4px">🚨 AOG</span>':''}
        ${conf?'<span style="background:#fee2e2;color:#b91c1c;font-size:8px;font-weight:600;padding:2px 4px;border-radius:4px">⚠ CONFLICTO</span>':''}
        ${outW&&!(t.taskDays>0)?'<span style="font-size:8px;color:#b45309;font-weight:600">⏱ fuera slot</span>':''}
        ${t.taskDays>0?`<span style="font-size:8px;color:#d97706;font-weight:700;background:#fffbeb;padding:1px 5px;border-radius:4px">🕐 +${t.taskDays}d</span>`:''}
        ${t._carryOver?`<span style="font-size:8px;color:#7c3aed;font-weight:700;background:#f5f3ff;padding:1px 5px;border-radius:4px">↩ cont. día anterior</span>`:''}
      </div>
      ${(_arrOrigin||_depDest)?`<div style="display:flex;align-items:center;gap:3px;margin-top:4px;flex-wrap:wrap">
        ${_arrOrigin?`<span style="background:#dbeafe;color:#1e40af;padding:1px 7px;border-radius:4px;font-weight:800;font-size:11px;font-family:monospace">${esc(_arrOrigin)}</span><span style="color:#94a3b8;margin:0 2px">→</span>`:''}
        <span style="background:#0f2a66;color:#fff;padding:1px 7px;border-radius:4px;font-weight:800;font-size:11px;font-family:monospace">${esc(activeStation())}</span>
        ${_depDest?`<span style="color:#94a3b8;margin:0 2px">→</span><span style="background:${_taskLate?'#fef2f2':'#dbeafe'};color:${_taskLate?'#dc2626':'#1e40af'};padding:1px 7px;border-radius:4px;font-weight:800;font-size:11px;font-family:monospace">${esc(_depDest)}</span>`:''}</div>`:''}
      <div style="font-size:9px;color:#94a3b8;margin-top:1px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(t.wo)}</div>
      <div style="font-size:9px;color:#475569;margin-top:3px;line-height:1.6">
        <div style="display:flex;align-items:center;gap:4px"><span style="color:#64748b;font-size:8px;font-weight:600;min-width:12px">🔧</span><span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(firstTechName)}</span></div>
        <div style="display:flex;align-items:center;gap:4px"><span style="color:#64748b;font-size:8px;font-weight:600;min-width:12px">⛽</span><span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(gaseoFullN)}</span></div>
        <div style="display:flex;align-items:center;gap:4px"><span style="color:#64748b;font-size:8px;font-weight:600;min-width:12px">✈</span><span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(despFullN)}</span></div>
      </div>
      <div id="M${t.id}" style="font-size:9px;color:${conf?'#dc2626':'#94a3b8'};margin-top:2px">${conf?'⚠ Cruce · '+fdur(t.dur):t._maintDone?'✅ Mant. terminado · ETD '+hhmm(t.ge):t._carryOver?fdur(t.dur)+' restante':fdur(t.dur)+' · buf:'+buf+'m'}</div>
      ${(()=>{
        if(t.status!=='entregada'&&t.status!=='reported') return '';
        let delayBadge='';
        if(t.status==='entregada'&&t.deliveredAt){
          const _m=t.deliveredAt.match(/(\d{1,2}):(\d{2})(?:\s*(a\.?\s*m\.?|p\.?\s*m\.?))?/i);
          if(_m){let _h=parseInt(_m[1]),_min=parseInt(_m[2]);if(_m[3]){const _pm=/p/i.test(_m[3]);if(_pm&&_h!==12)_h+=12;if(!_pm&&_h===12)_h=0;}const _d=_h*60+_min-t.ge;if(_d>0)delayBadge=` +${fdur(_d)}`;}
        }
        const _isLate = _taskLate;
        const _bg = t.status==='entregada' ? (_isLate ? '#fef2f2' : '#dcfce7') : '#fffbeb';
        const _cl = t.status==='entregada' ? (_isLate ? '#dc2626' : '#166534') : '#92400e';
        const _lbl = t.status==='entregada' ? (_isLate ? 'Retrasado' : 'Entregada') : 'Reportada';
        const _ic  = t.status==='entregada' ? (_isLate ? '⚠️' : '✅') : '⚠️';
        return `<div style="font-size:9px;font-weight:700;color:${_cl};margin-top:2px;background:${_bg};padding:2px 7px;border-radius:10px;display:inline-block">${_ic} ${_lbl}${t.deliveredAt?' '+t.deliveredAt:''}${delayBadge}</div>`;
      })()}`;
    rowWrap.appendChild(infoDiv);

    // ─ TRACK (flex:1) ─
    const trackWrap=document.createElement('div');
    trackWrap.style.cssText='flex:1;min-width:0;padding-top:8px;position:relative;overflow:visible';
    trackWrap.innerHTML=`
      <div class="track" id="TR${t.id}" style="overflow:hidden">
        <div class="${t.aog?'gslot aog':'gslot'}" id="GS${t.id}" style="left:${gL};width:${
          t._carryOver
            ? gW                              // carry-over: de 0 hasta ETD del día actual
            : t.taskDays>0
              ? `calc(100% - ${gL})`          // primer día multi-day: llena hasta el fin
              : gW                            // mismo día: ancho normal
        }">
          ${t.taskDays>0&&!t._carryOver?`<div style="position:absolute;right:4px;top:50%;transform:translateY(-50%);background:rgba(245,158,11,.8);color:#fff;font-size:9px;font-weight:700;padding:1px 5px;border-radius:4px;white-space:nowrap">→ +${t.taskDays}d</div>`:''}
          ${t._carryOver?`<div style="position:absolute;left:4px;top:50%;transform:translateY(-50%);background:rgba(245,158,11,.8);color:#fff;font-size:9px;font-weight:700;padding:1px 5px;border-radius:4px;white-space:nowrap">← hasta ${hhmm(slotEnd)}</div>`:''}
        </div>
        <div class="bar" id="B${t.id}" style="left:${bL};width:${bW};background:${bc}${t.aog?';border:2px solid #dc2626':''}">
          <div class="bar-body" data-id="${t.id}" data-act="mv" ${isAdmin?'':'style="cursor:default"'}>
            <span class="bar-grip" ${isAdmin?'':'style="display:none"'}>⠿</span>
            <span class="bar-lbl" id="BL${t.id}">${esc(names||t.staff.length+' téc.')}${(gaseoN&&gaseoN!=='—')||( despN&&despN!=='—')?` · ⛽${esc(gaseoN!=='—'?gaseoN.split(' ')[0]:'')} ✈${esc(despN!=='—'?despN.split(' ')[0]:'')}`:''}</span>
          </div>
          ${isAdmin?`<div class="bar-rz" data-id="${t.id}" data-act="rz"><div class="rz-dot"></div><div class="rz-dot"></div><div class="rz-dot"></div></div>`:''}
        </div>
      </div>
      <!-- Mobile info panel (tap on track to toggle) -->
      <div id="MINFO${t.id}" style="display:none;background:#f1f5f9;border-radius:8px;padding:8px 10px;margin-top:6px;font-size:11px;color:#334155;line-height:1.8">
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:2px 12px">
          <div><span style="color:#94a3b8;font-size:10px">ETA</span> <strong>${hhmm(t.gs)}</strong></div>
          <div><span style="color:#94a3b8;font-size:10px">ETD</span> <strong>${hhmm(t.ge)}</strong></div>
          <div><span style="color:#94a3b8;font-size:10px">Inicio</span> <strong>${hhmm(t.start)}</strong></div>
          <div><span style="color:#94a3b8;font-size:10px">Fin mant.</span> <strong>${hhmm(t.start+t.dur)}</strong></div>
          <div style="grid-column:1/-1"><span style="color:#94a3b8;font-size:10px">Duración</span> <strong>${fdur(t.dur)}</strong></div>
          <div style="grid-column:1/-1"><span style="color:#94a3b8;font-size:10px">🔧 Técnico</span> <strong>${esc(firstTechName)}${t.staff&&t.staff.length>1?' +'+( t.staff.length-1)+' más':''}</strong></div>
          <div style="grid-column:1/-1"><span style="color:#94a3b8;font-size:10px">⛽ Gaseo</span> <strong>${esc(gaseoFullN)}</strong></div>
          <div style="grid-column:1/-1"><span style="color:#94a3b8;font-size:10px">✈ Despacho</span> <strong>${esc(despFullN)}</strong></div>
          ${t.taskDays>0?`<div style="grid-column:1/-1;color:#d97706;font-weight:600">🕐 +${t.taskDays} día${t.taskDays>1?'s':''} en tierra</div>`:''}
          ${t.comments?`<div style="grid-column:1/-1;color:#92400e;font-size:10px">💬 ${esc(t.comments)}</div>`:''}
        </div>
      </div>
      <!-- Files row -->
      <div id="FILES${t.id}" style="display:flex;flex-wrap:wrap;gap:4px;align-items:center;margin-top:5px"></div>
      <!-- Comment + foto en misma fila -->
      <input type="file" id="PHOTO-INP${t.id}" accept="image/*" capture="environment" style="display:none"
        onchange="commentPhotoSelected('${t.id}',this)">
      <div style="display:flex;align-items:flex-start;gap:6px;margin-top:4px">
        <textarea id="CMT${t.id}" rows="2" class="comment-inp ${hasCmt?'has-val':''}"
          placeholder="💬 Comentario${!isAdmin?' ('+esc(currentUserName)+')':''}..."
          onchange="saveComment('${t.id}',this.value)"
          style="flex:1;min-width:0"
        >${esc(t.comments||'')}</textarea>
        <div style="display:flex;flex-direction:column;align-items:center;gap:3px;flex-shrink:0">
          <button type="button" onclick="document.getElementById('PHOTO-INP${t.id}').click()"
            title="Adjuntar foto de evidencia"
            style="width:38px;height:38px;border:1.5px dashed #93c5fd;border-radius:8px;background:#eff6ff;color:#1e40af;font-size:17px;cursor:pointer;display:flex;align-items:center;justify-content:center;padding:0;flex-shrink:0">
            📷
          </button>
          ${t.commentPhotoUrl
            ?`<a href="${t.commentPhotoUrl}" target="_blank" rel="noopener" title="Ver foto adjunta" style="display:block;position:relative">
                <img src="${t.commentPhotoUrl}" style="width:38px;height:38px;object-fit:cover;border-radius:7px;border:2px solid #3b82f6;display:block">
                <button onclick="event.preventDefault();removeCommentPhoto('${t.id}')" style="position:absolute;top:-5px;right:-5px;width:14px;height:14px;border-radius:50%;background:#dc2626;color:#fff;border:none;font-size:8px;cursor:pointer;line-height:1;padding:0;display:flex;align-items:center;justify-content:center">✕</button>
              </a>`
            :`<span id="PHOTO-LBL${t.id}" style="font-size:9px;color:#94a3b8;text-align:center;line-height:1.2"></span>`}
        </div>
      </div>`;
    rowWrap.appendChild(trackWrap);
    addFlightPlane(t, trackWrap); // ✈ approach / ground / departure animation

    // ─ ACTIONS (fixed 80px) ─
    const actDiv=document.createElement('div');
    actDiv.style.cssText='width:80px;flex-shrink:0;display:flex;flex-direction:column;gap:4px;padding-top:8px;align-items:center;margin-bottom:3px';
    const isDone = t.status==='entregada';
    // Deliver button — visible to ALL roles
    // Re-enable Entregar if task has active report (reported status = needs re-delivery)
    const hasActiveReport = activeReports.some(r=>r.ac===t.ac&&!r.resolved&&r.dateStr===t.taskDate);
    const isReported = t.status==='reported';
    const isAOGTask = !!t.aog;
    const deliverBtn=document.createElement('button');
    if(isAOGTask){
      deliverBtn.className='btn-deliver';
      deliverBtn.title='Liberar AOG — marcar aeronave como disponible';
      deliverBtn.innerHTML='🔧 Liberar AOG';
      deliverBtn.style.cssText='border-color:#9d174d;color:#9d174d;font-weight:700';
      deliverBtn.onclick=()=>deliverAircraft(t.id, t.ac);
    } else if(isDone && !isReported && !hasActiveReport){
      deliverBtn.className='btn-deliver done';
      deliverBtn.title='Entregada a las '+(t.deliveredAt||'')+' por '+(t.deliveredBy||'');
      deliverBtn.innerHTML='✅ Entregada';
    } else if(isReported || hasActiveReport){
      deliverBtn.className='btn-deliver';
      deliverBtn.title='Re-entregar — hay un reporte activo';
      deliverBtn.innerHTML='🔧 Re-entregar';
      deliverBtn.style.cssText='animation:blink 1.5s infinite;border-color:#dc2626;color:#dc2626';
      deliverBtn.onclick=()=>deliverAircraft(t.id, t.ac);
    } else {
      deliverBtn.className='btn-deliver';
      deliverBtn.title='Marcar como entregada por mantenimiento';
      deliverBtn.innerHTML='🔧 Entregar';
      deliverBtn.onclick=()=>deliverAircraft(t.id, t.ac);
    }
    actDiv.appendChild(deliverBtn);

    if(isAdmin){
      const editBtn=document.createElement('button');
      editBtn.className='editbtn'; editBtn.title='Editar';
      editBtn.innerHTML='✏️'; editBtn.onclick=()=>openModal(t.id);
      const delBtn=document.createElement('button');
      delBtn.className='delbtn'; delBtn.title='Eliminar';
      delBtn.innerHTML='✕'; delBtn.onclick=()=>delTask(t.id);
      actDiv.appendChild(editBtn);
      // Quick ETA/ETD edit button (clock icon)
      if(currentRole==='superadmin'||currentRole==='supervisor'||currentRole==='admin'){
        const timeBtn=document.createElement('button');
        timeBtn.title='Cambiar ETA/ETD';
        timeBtn.innerHTML='🕐';
        timeBtn.style.cssText='background:none;border:none;cursor:pointer;font-size:14px;opacity:.6;padding:2px 4px';
        timeBtn.onclick=()=>quickEditTimes(t.id, t.ac);
        actDiv.appendChild(timeBtn);
      }
      actDiv.appendChild(delBtn);
    }
    rowWrap.appendChild(actDiv);
    ganttRows.appendChild(rowWrap);
  });

  // Events drag (solo admin)
  if(isAdmin){
    document.querySelectorAll('[data-act]').forEach(el=>el.addEventListener('mousedown',startDrag));
  }
  // Inject report cards + blink effect
  // Re-filter by selected date each render (date may have changed)
  const todayReports=activeReports.filter(r=>r.dateStr===selectedDate&&!r.resolved);
  dt.forEach(t=>{
    const taskReports=todayReports.filter(r=>r.taskId?r.taskId===t.id:r.ac===t.ac);
    const bar=document.getElementById('B'+t.id);
    // Blink bar if there's an active report
    if(bar){
      if(taskReports.length>0){
        bar.classList.add('bar-blink');
        bar.style.background='#dc2626';
      } else {
        bar.classList.remove('bar-blink');
      }
    }
    // Show report cards below the comment textarea
    if(taskReports.length>0){
      const cmt=document.getElementById('CMT'+t.id);
      if(cmt&&cmt.parentElement){
        taskReports.forEach(r=>{
          const card=document.createElement('div');
          card.className='report-card';
          card.innerHTML=`<div class="report-card-icon">🚨</div>
            <div class="report-card-body">
              <div class="report-card-msg">${esc(r.message)}</div>
              <div class="report-card-meta">Por ${esc(r.reportedBy)} · ${esc(r.timeStr||'')} · ${esc(r.dateStr||'')}</div>
            </div>
            ${(currentRole==='superadmin'||currentRole==='supervisor')?`<button class="report-resolve-btn" onclick="resolveReport('${r.id}')">✓ Resolver</button>`:''}`;
          cmt.parentElement.appendChild(card);
        });
      }
    }
    // Show delivery history
    if(t.deliveryHistory&&t.deliveryHistory.length>0){
      const filesDiv=document.getElementById('FILES'+t.id);
      if(filesDiv){
        const histEl=document.createElement('div');
        histEl.style.cssText='font-size:9px;color:#64748b;margin-top:3px;width:100%';
        histEl.innerHTML=t.deliveryHistory.map(h=>`<span style="background:#f1f5f9;padding:1px 6px;border-radius:8px;margin-right:3px">✅ ${esc(h.deliveredAt)} por ${esc(h.deliveredBy)}</span>`).join('');
        filesDiv.parentElement.appendChild(histEl);
      }
    }
  });

  // Inject file buttons safely (avoids URL escaping in template literals)
  dt.forEach(t=>{
    const filesDiv=document.getElementById('FILES'+t.id);
    if(filesDiv){
      filesDiv.innerHTML='';
      const atts=t.attachments||[];
      if(atts.length===0){
        if(isAdmin){
          const empty=document.createElement('span');
          empty.style.cssText='font-size:9px;color:#cbd5e1;white-space:nowrap';
          empty.textContent='Sin archivos';
          filesDiv.appendChild(empty);
        }
      } else {
        atts.forEach(f=>{
          const a=document.createElement('a');
          a.href='#';
          a.className='ot-file-btn '+getFileBtnCls(f.name);
          a.title='Descargar: '+f.name;
          a.addEventListener('click',e=>{
            e.preventDefault();
            e.stopPropagation();
            downloadOTFile(f.url, f.name);
          });
          const icon=document.createTextNode(getFileIconEmoji(f.name)+' ');
          const span=document.createElement('span');
          span.style.cssText='max-width:90px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap';
          span.textContent=f.name;
          a.appendChild(icon);
          a.appendChild(span);
          filesDiv.appendChild(a);
        });
      }
    }
  });

  // Tooltips (todos)
  dt.forEach(t=>{
    const bar=document.getElementById('B'+t.id);
    if(bar){
      // Desktop: hover tooltip
      bar.addEventListener('mouseenter',e=>showBarTip(e,t.id));
      bar.addEventListener('mousemove',e=>posTip(e,'bar-tooltip-global'));
      bar.addEventListener('mouseleave',()=>hideTip('bar-tooltip-global'));
    }
    // Mobile: tap anywhere on the track row to toggle info panel
    const trackEl=document.getElementById('TR'+t.id);
    if(trackEl){
      trackEl.addEventListener('touchend',e=>{
        if(drag) return;
        // only toggle if touch didn't move much (not a scroll)
        const t0=e.changedTouches[0];
        if(Math.abs(t0.clientX-(trackEl._touchStartX||t0.clientX))>10) return;
        e.preventDefault();
        const minfo=document.getElementById('MINFO'+t.id);
        if(!minfo) return;
        const isOpen=minfo.style.display!=='none';
        document.querySelectorAll('[id^="MINFO"]').forEach(el=>el.style.display='none');
        minfo.style.display=isOpen?'none':'block';
      });
      trackEl.addEventListener('touchstart',e=>{
        trackEl._touchStartX=e.touches[0].clientX;
      },{passive:true});
    }
    const gs=document.getElementById('GS'+t.id);
    if(gs){gs.addEventListener('mouseenter',e=>showGsTip(e,t.id));gs.addEventListener('mousemove',e=>posTip(e,'gslot-tip-global'));gs.addEventListener('mouseleave',()=>hideTip('gslot-tip-global'));}
    const cmt=document.getElementById('CMT'+t.id);
    if(cmt){
      const r=()=>{cmt.style.height='auto';cmt.style.height=Math.min(cmt.scrollHeight,120)+'px';};
      r();
      cmt.addEventListener('input',r);
      cmt.addEventListener('input',()=>cmt.classList.toggle('has-val',cmt.value.trim().length>0));
    }
  });
  kpis();
  // Position all plane badges now that rows are in the DOM
  requestAnimationFrame(updateAllPlanes);
}

// ══ TOOLTIPS ══
function posTip(e,id){const tip=document.getElementById(id);if(!tip||tip.style.display==='none')return;const vw=window.innerWidth,vh=window.innerHeight,tw=tip.offsetWidth||280,th=tip.offsetHeight||200;let x=e.clientX+14,y=e.clientY-10;if(x+tw>vw-10)x=e.clientX-tw-14;if(y+th>vh-10)y=vh-th-10;if(y<10)y=10;tip.style.left=x+'px';tip.style.top=y+'px';}
function showGsTip(e,id){const t=dayTasks().find(x=>x.id===id);if(!t)return;const tip=document.getElementById('gslot-tip-global');tip.textContent=`🛬 ETA ${hhmm(t.gs)}  ·  🛫 ETD ${hhmm(t.ge)}  ·  ⏱ ${fdur(t.ge-t.gs)}`;tip.style.display='block';posTip(e,'gslot-tip-global');}
function showBarTip(e,id){
  const t=dayTasks().find(x=>x.id===id);if(!t)return;
  const tip=document.getElementById('bar-tooltip-global');
  const sl=(t.staff||[]).map(sid=>{const s=techs.find(x=>x.id===sid);return s?`<div class="tt-tech"><div class="tt-dot"></div><span style="flex:1">${esc(s.name)}</span><span style="color:#94a3b8;margin-left:8px;white-space:nowrap">${s.role}·${s.hours}h·${s.shift}</span></div>`:''}).join('');
  const gN=t.gaseo?techs.find(s=>s.id===t.gaseo)?.name||'—':'—';
  const dN=t.despacho?techs.find(s=>s.id===t.despacho)?.name||'—':'—';
  tip.innerHTML=`<h4>✈ ${esc(t.ac)}</h4>
    <div class="tt-row"><span>Orden WO</span><span>${esc(t.wo)}</span></div>
    <div class="tt-row"><span>ETA</span><span>${hhmm(t.gs)}</span></div>
    <div class="tt-row"><span>ETD</span><span>${hhmm(t.ge)}</span></div>
    <div class="tt-row"><span>Inicio manto.</span><span>${hhmm(t.start)}</span></div>
    <div class="tt-row"><span>Fin manto.</span><span>${hhmm(t.start+t.dur)}</span></div>
    <div class="tt-row"><span>Duración manto.</span><span>${fdur(t.dur)}</span></div>
    ${t.taskDays>0?`<div class="tt-row"><span>⏱ Tiempo en tierra</span><span style="color:#f59e0b;font-weight:700">+${t.taskDays} día${t.taskDays>1?'s':''} (ETD→${hhmm(t.ge)} día +${t.taskDays})</span></div>`:`<div class="tt-row"><span>Buffer</span><span>${t.ge-(t.start+t.dur)} min</span></div>`}
    <div class="tt-row"><span>⛽ Gaseo</span><span>${esc(gN)}</span></div>
    <div class="tt-row"><span>✈ Despacho</span><span>${esc(dN)}</span></div>
    ${t.comments?`<div class="tt-div"></div><div style="font-size:10px;color:#fbbf24;font-weight:600;margin-bottom:3px">💬 COMENTARIO</div><div style="font-size:10px;color:#e2e8f0;line-height:1.5">${esc(t.comments)}</div>`:''}
    <div class="tt-div"></div>
    <div style="font-size:10px;color:#94a3b8;margin-bottom:5px;font-weight:600">TÉCNICOS (${(t.staff||[]).length})</div>
    ${sl||'<span style="color:#64748b;font-size:10px">Sin técnicos</span>'}`;
  tip.style.display='block';posTip(e,'bar-tooltip-global');
}
function hideTip(id){const tip=document.getElementById(id);if(tip)tip.style.display='none';}
async function saveComment(id,val){
  if(!FB)return;
  const data={comments:val};
  if(currentRole==='tech') data.commentBy=currentUserName;
  await FB.db.collection(AIRLINE_ID).doc(activeStation()).collection('tasks').doc(id).update(data);
}

async function commentPhotoSelected(id, input){
  const file=input.files[0];
  if(!file) return;
  const lbl=document.getElementById('PHOTO-LBL'+id);
  if(lbl){ lbl.textContent='⏳ Subiendo...'; lbl.style.color='#f59e0b'; }
  try{
    const {url}=await uploadToSupabase(file,`${activeStation()}/comments`);
    await FB.db.collection(AIRLINE_ID).doc(activeStation()).collection('tasks').doc(id).update({
      commentPhotoUrl:url,
      commentPhotoBy:currentUserName,
    });
    toast('📷 Foto adjuntada al comentario');
  }catch(e){
    if(lbl){ lbl.textContent='❌ Error al subir foto'; lbl.style.color='#dc2626'; }
    console.error('Photo upload error:',e);
  }
}

async function removeCommentPhoto(id){
  if(!FB)return;
  await FB.db.collection(AIRLINE_ID).doc(activeStation()).collection('tasks').doc(id).update({
    commentPhotoUrl:'',commentPhotoBy:''
  });
  toast('🗑 Foto eliminada');
}

// ══ DRAG (admin only) ══
function startDrag(e){
  if(currentRole==='tech')return; // técnicos no pueden arrastrar barras
  e.preventDefault(); hideTip('bar-tooltip-global');
  const id=e.currentTarget.dataset.id,act=e.currentTarget.dataset.act;
  const t=dayTasks().find(x=>x.id===id);if(!t)return;
  mTW(); drag={act,id,s0:t.start,d0:t.dur,mx0:e.clientX};
  document.body.style.cursor=act==='mv'?'grabbing':'ew-resize';
  document.body.style.userSelect='none';
}
document.addEventListener('mousemove',e=>{
  if(!drag)return;
  const dx=e.clientX-drag.mx0,dm=snap5((dx/TW)*1440);
  let ns=drag.s0,nd=drag.d0;
  if(drag.act==='mv')ns=Math.max(0,Math.min(1380,drag.s0+dm));
  else nd=Math.max(15,Math.min(1440-drag.s0,snap5(drag.d0+dm)));
  const bar=document.getElementById('B'+drag.id),lbl=document.getElementById('BL'+drag.id),meta=document.getElementById('M'+drag.id);
  if(!bar)return;
  bar.style.left=pct(ns);bar.style.width=pct(Math.max(nd,10));
  bar.style.background='#1e40af';bar.style.boxShadow='0 3px 14px rgba(30,64,175,.35)';
  if(lbl)lbl.textContent=hhmm(ns)+' – '+hhmm(ns+nd);
  if(meta)meta.textContent='↔ '+hhmm(ns)+' → '+hhmm(ns+nd)+'  ('+fdur(nd)+')';
  let tip=bar.querySelector('.rz-tip-el');
  if(drag.act==='rz'){if(!tip){tip=document.createElement('div');tip.className='rz-tip-el';bar.appendChild(tip);}tip.textContent=fdur(nd);}else if(tip)tip.remove();
});
document.addEventListener('mouseup',async e=>{
  if(!drag)return;
  const dx=e.clientX-drag.mx0,dm=snap5((dx/TW)*1440);
  let ns=drag.s0,nd=drag.d0;
  if(drag.act==='mv')ns=Math.max(0,Math.min(1380,drag.s0+dm));
  else nd=Math.max(15,Math.min(1440-drag.s0,snap5(drag.d0+dm)));
  const id=drag.id; drag=null;
  document.body.style.cursor=''; document.body.style.userSelect='';
  if(FB)await FB.db.collection(AIRLINE_ID).doc(activeStation()).collection('tasks').doc(id).update({start:ns,dur:nd});
  toast('✈ Horario actualizado');
});
// ══ REPORTS — anomaly reporting (no login required) ══
let activeReports = [];
let plans = [];
let repStation = '';

// ── Foto de evidencia en reportes públicos ──
let repPhotoFile = null;

function repPhotoSelected(input){
  const file = input.files[0];
  if(!file) return;
  repPhotoFile = file;
  const url = URL.createObjectURL(file);
  document.getElementById('rep-photo-thumb').src = url;
  document.getElementById('rep-photo-preview').style.display = 'flex';
  document.getElementById('rep-photo-name').textContent = file.name;
}
function repPhotoRemove(){
  repPhotoFile = null;
  document.getElementById('rep-photo-input').value = '';
  document.getElementById('rep-photo-preview').style.display = 'none';
  document.getElementById('rep-photo-thumb').src = '';
  document.getElementById('rep-photo-name').textContent = '';
}

function repTypeChange(val){
  const isAnomaly=val==='anomaly';
  const anomalyLbl=document.getElementById('rep-type-anomaly');
  const pilotLbl=document.getElementById('rep-type-pilot');
  if(anomalyLbl) anomalyLbl.style.cssText=`display:flex;align-items:center;gap:8px;padding:10px 12px;border:2px solid ${isAnomaly?'#0f2a66':'#e2e8f0'};border-radius:8px;cursor:pointer;background:${isAnomaly?'#eff6ff':'#f8fafc'}`;
  if(pilotLbl)   pilotLbl.style.cssText=  `display:flex;align-items:center;gap:8px;padding:10px 12px;border:2px solid ${!isAnomaly?'#3b82f6':'#e2e8f0'};border-radius:8px;cursor:pointer;background:${!isAnomaly?'#eff6ff':'#f8fafc'}`;
  const nameLbl=document.getElementById('rep-name-lbl');
  const msgLbl=document.getElementById('rep-msg-lbl');
  const msgEl=document.getElementById('rep-msg');
  if(nameLbl) nameLbl.textContent=isAnomaly?'Tu nombre':'Nombre del piloto / capitán';
  if(msgLbl)  msgLbl.textContent=isAnomaly?'Descripción del reporte / anomalía':'Mensaje al MCC';
  if(msgEl)   msgEl.placeholder=isAnomaly?'Describe detalladamente la anomalía encontrada...':'Ej: Flap derecho con ruido inusual en aproximación, solicito revisión antes de próximo vuelo...';
}

function openReport(){
  document.getElementById('login-screen').style.display='none';
  document.getElementById('report-screen').style.display='flex';
  document.getElementById('rep-err').textContent='';
  document.getElementById('rep-ac').value = window._prefilledAC || '';
  document.getElementById('rep-name').value='';
  document.getElementById('rep-msg').value='';
  repPhotoRemove();
}
function closeReport(){
  document.getElementById('report-screen').style.display='none';
  document.getElementById('login-screen').style.display='flex';
}
function repSetStation(s){
  repStation=s;
  stations.forEach(st=>{
    const el=document.getElementById('rep-stab-'+st.code);
    if(el) el.classList.toggle('active',st.code===s);
  });
}

async function submitReport(){
  const ac=document.getElementById('rep-ac').value;
  const name=(document.getElementById('rep-name').value||'').trim().toUpperCase()||'ANÓNIMO';
  const msg=(document.getElementById('rep-msg').value||'').trim();
  const err=document.getElementById('rep-err');
  const btn=document.getElementById('rep-submit-btn');
  if(!ac){ err.textContent='⚠ Selecciona la aeronave'; return; }
  if(!msg||msg.length<5){ err.textContent='⚠ Describe la anomalía (mínimo 5 caracteres)'; return; }
  err.textContent=''; btn.textContent='Enviando...'; btn.disabled=true;
  try{
    if(!window.FB){ err.textContent='Sin conexión. Intenta de nuevo.'; btn.textContent='📤 Enviar reporte'; btn.disabled=false; return; }
    if(!firebase.auth().currentUser) await firebase.auth().signInAnonymously();

    const now=new Date();
    const nowMins=now.getHours()*60+now.getMinutes();
    const today=localDateStr(now);

    // ── Encontrar la OT correcta para este reporte ──
    // Si la línea de tiempo ya pasó el ETD de la aeronave, asignar a la PRÓXIMA ETA
    const allTasksSnap=await FB.db.collection(AIRLINE_ID).doc(repStation).collection('tasks')
      .where('ac','==',ac).get();
    const allTasks=allTasksSnap.docs.map(d=>({id:d.id,ref:d.ref,...d.data()}));

    // Ordenar por fecha + ETD ascendente
    allTasks.sort((a,b)=>{
      if(a.taskDate!==b.taskDate) return a.taskDate.localeCompare(b.taskDate);
      return (a.ge||0)-(b.ge||0);
    });

    // Tarea activa: hoy, ETD aún no pasó (nowMins <= ge)
    let targetTask = allTasks.find(t=>t.taskDate===today&&(t.ge||0)>=nowMins);
    // Si ya pasó el ETD de todas las de hoy → próxima futura
    if(!targetTask) targetTask = allTasks.find(t=>t.taskDate>today);
    // Fallback: última de hoy aunque ya haya salido
    if(!targetTask) targetTask = allTasks.filter(t=>t.taskDate===today).pop();

    const repType=document.querySelector('input[name="rep-type"]:checked')?.value||'anomaly';

    // Subir foto de evidencia si fue adjuntada
    let photoUrl='';
    if(repPhotoFile){
      btn.textContent='Subiendo foto...';
      try{
        const up=await uploadToSupabase(repPhotoFile,`${repStation}/reports`);
        photoUrl=up.url||'';
      }catch(e){ console.warn('Photo upload failed:',e); }
    }

    const reportData={
      ac, message:msg, reportedBy:name,
      type:repType,
      station:repStation,
      timestamp:Date.now(),
      timeStr:now.toLocaleTimeString('es-DO',{hour:'2-digit',minute:'2-digit'}),
      dateStr:targetTask?.taskDate||today,
      taskId:targetTask?.id||'',
      resolved:false,
      ...(photoUrl?{photoUrl}:{}),
    };
    await FB.db.collection(AIRLINE_ID).doc(repStation).collection('reports').add(reportData);

    // Si la tarea objetivo estaba entregada → regresarla a "reportada"
    if(targetTask){
      const t=targetTask;
      if(t.status==='entregada'){
        const hist=t.deliveryHistory||[];
        hist.push({deliveredBy:t.deliveredBy||'—',deliveredAt:t.deliveredAt||'—',reportedAt:reportData.timeStr});
        await targetTask.ref.update({status:'reported',deliveryHistory:hist,deliveredBy:'',deliveredAt:''});
      }
    }

    const isPilotMsg=repType==='pilot';
    const assignedTo=targetTask
      ? `OT del ${targetTask.taskDate===today?'hoy':'próximo '+targetTask.taskDate} · ETD ${targetTask.ge!=null?hhmm(targetTask.ge):'—'}`
      : 'sin OT asignada';

    document.getElementById('report-screen').innerHTML=`
      <div class="report-box" style="text-align:center">
        <div style="font-size:56px;margin-bottom:12px">✅</div>
        <div style="font-weight:700;font-size:18px;color:#166534;margin-bottom:8px">${isPilotMsg?'📡 Mensaje enviado al MCC':'✅ Reporte enviado'}</div>
        <div style="font-size:13px;color:#334155;margin-bottom:4px">Aeronave: <strong>${esc(ac)}</strong></div>
        <div style="font-size:11px;color:#64748b;margin-bottom:16px">Asignado a: ${esc(assignedTo)}</div>
        <div style="font-size:12px;color:#64748b;margin-bottom:20px">El equipo técnico fue notificado en tiempo real.</div>
        <button onclick="document.getElementById('report-screen').style.display='none';document.getElementById('login-screen').style.display='flex';"
          class="btn btn-blue" style="width:100%;justify-content:center;padding:12px;font-size:14px">← Volver al login</button>
      </div>`;
  }catch(e){
    err.textContent='Error: '+e.message;
    btn.textContent='📤 Enviar reporte'; btn.disabled=false;
    console.error('Report error:',e);
  }
}

// ══ SISTEMA DE ALERTAS AUTOMÁTICAS ══
let notifConfig={enabled:false,emailjsServiceId:'',emailjsTemplateId:'',emailjsPublicKey:'',emails:[],phones:[]};

async function loadNotifConfig(st){
  if(!FB) return;
  try{
    const snap=await FB.db.collection(AIRLINE_ID).doc(st).collection('config').doc('notifications').get();
    if(snap.exists) notifConfig={...notifConfig,...snap.data()};
    renderNotifConfig();
  }catch(e){console.warn('notif config:',e);}
}

function renderNotifConfig(){
  const card=document.getElementById('notif-config-card');
  if(card) card.style.display=currentRole==='superadmin'?'block':'none';
  const f=(id,val)=>{const el=document.getElementById(id);if(el)el.value=val||'';};
  f('notif-svc',notifConfig.emailjsServiceId);
  f('notif-tpl',notifConfig.emailjsTemplateId);
  f('notif-key',notifConfig.emailjsPublicKey);
  f('notif-emails',(notifConfig.emails||[]).join('\n'));
  f('notif-phones',(notifConfig.phones||[]).join('\n'));
  const cb=document.getElementById('notif-enabled');
  if(cb) cb.checked=!!notifConfig.enabled;
}

async function saveNotifConfig(){
  if(!FB){toast('⚠ Sin conexión',true);return;}
  const st=activeStation();
  await FB.db.collection(AIRLINE_ID).doc(st).collection('config').doc('notifications').set(notifConfig);
  document.getElementById('notif-status').textContent='✅ Guardado '+new Date().toLocaleTimeString('es-DO',{hour:'2-digit',minute:'2-digit'});
  toast('✅ Configuración de alertas guardada');
}

async function sendAlerts(report){
  if(!notifConfig.enabled) return;
  const _st=report.station||activeStation();
  const msg=`*🚨 ALERTA MANTENIMIENTO - AIRTECH ASSIST*\n--------------------\n*Aeronave:* ${report.ac||'—'}\n*Base:* ${_st}\n*Hora del reporte:* ${report.timeStr||'—'}\n*Reportado por:* ${report.reportedBy||'—'}\n--------------------\n*ANOMALIA DETECTADA:*\n${report.message||'—'}\n--------------------\n_AirTech Assist - Ground Operations_\n_Mensaje automatico - no responder._`;

  // ── Email via EmailJS ──
  if(notifConfig.emailjsPublicKey&&notifConfig.emailjsServiceId&&notifConfig.emailjsTemplateId&&(notifConfig.emails||[]).length){
    try{
      emailjs.init({publicKey:notifConfig.emailjsPublicKey});
      const params={ac:report.ac||'—',station:report.station||window._station||'—',time:report.timeStr||'—',reporter:report.reportedBy||'—',message:report.message||'—'};
      for(const to of notifConfig.emails){
        await emailjs.send(notifConfig.emailjsServiceId,notifConfig.emailjsTemplateId,{...params,to_email:to});
      }
      toast('📧 Email enviado al gerente');
    }catch(e){console.warn('EmailJS error:',e);toast('⚠ Error enviando email: '+e.text,true);}
  }

  // ── WhatsApp — mostrar botones en banner ──
  if((notifConfig.phones||[]).length){
    const enc=encodeURIComponent(msg);
    showWhatsAppButtons(notifConfig.phones,enc);
  }
}

function showWhatsAppButtons(phones,enc){
  const existing=document.getElementById('wa-alert-bar');
  if(existing) existing.remove();
  const bar=document.createElement('div');
  bar.id='wa-alert-bar';
  bar.style.cssText='position:fixed;bottom:16px;right:16px;z-index:9999;display:flex;flex-direction:column;gap:6px;max-width:260px';
  phones.forEach(ph=>{
    const btn=document.createElement('a');
    btn.href=`https://wa.me/${ph.replace(/[^0-9]/g,'')}?text=${enc}`;
    btn.target='_blank';
    btn.rel='noopener';
    btn.style.cssText='display:flex;align-items:center;gap:8px;background:#25d366;color:#fff;padding:10px 14px;border-radius:12px;font-size:12px;font-weight:700;text-decoration:none;box-shadow:0 4px 16px rgba(37,211,102,.4)';
    btn.innerHTML=`<span style="font-size:18px">📱</span><div><div style="font-size:11px;opacity:.85">Notificar gerente</div><div>${ph}</div></div>`;
    const close=document.createElement('button');
    close.innerHTML='✕';
    close.style.cssText='margin-left:auto;background:none;border:none;color:#fff;font-size:14px;cursor:pointer;opacity:.7;padding:0 0 0 6px';
    close.onclick=e=>{e.preventDefault();bar.remove();};
    btn.appendChild(close);
    bar.appendChild(btn);
  });
  document.body.appendChild(bar);
  // Auto-dismiss after 60s
  setTimeout(()=>{if(document.getElementById('wa-alert-bar'))bar.remove();},60000);
}

async function testNotifAlert(){
  if(!notifConfig.emailjsPublicKey&&!(notifConfig.phones||[]).length){
    toast('⚠ Configura al menos un email o WhatsApp',true);return;
  }
  await sendAlerts({ac:'HI1099',station:activeStation(),timeStr:new Date().toLocaleTimeString('es-DO',{hour:'2-digit',minute:'2-digit'}),reportedBy:'PRUEBA SISTEMA',message:'Esta es una alerta de prueba del sistema Airtech Assist. Si recibes este mensaje, las alertas están funcionando correctamente.'});
  toast('🧪 Alerta de prueba enviada');
}

async function resolveReport(reportId){
  if(!FB) return;
  const st=activeStation();
  await FB.db.collection(AIRLINE_ID).doc(st).collection('reports').doc(reportId).update({resolved:true, resolvedAt:Date.now(), resolvedBy:currentUserName});
  toast('✅ Reporte resuelto');
}

// ── Mark aircraft as delivered by maintenance ──
// ── Delivery modal state ──
let _deliveryTaskId = null;
let _deliveryAc = null;
let _deliveryTaskStates = {};

async function deliverAircraft(id, ac){
  if(!FB) return;
  _deliveryTaskId = id;
  _deliveryAc = ac;
  _deliveryTaskStates = {};
  const t = tasks.find(x=>x.id===id);
  const infoEl = document.getElementById('delivery-ac-info');
  if(infoEl && t){
    infoEl.innerHTML = '<strong style="font-size:14px">'+esc(ac)+'</strong> &nbsp; WO: '+esc(t.wo||'—')+'<br><span style="color:#64748b;font-size:11px">ETA '+hhmm(t.gs)+' ETD '+hhmm(t.ge)+'</span>';
  }
  document.getElementById('delivery-modal-title').textContent = 'Entregar ' + ac + ' a operaciones';
  const st = activeStation();
  const relatedPlans = plans.filter(p=>
    p.ac===ac && (t?(p.wo||'').toUpperCase()===(t.wo||'').toUpperCase():true) &&
    p.station===st && p.status!=='done'
  );
  const tasksSection = document.getElementById('delivery-tasks-section');
  const noTasksEl = document.getElementById('delivery-no-tasks');
  const tasksList = document.getElementById('delivery-tasks-list');
  const reasonWrap = document.getElementById('delivery-reason-wrap');
  if(reasonWrap) reasonWrap.style.display='none';
  document.getElementById('delivery-reason-input').value='';
  if(relatedPlans.length){
    tasksSection.style.display='block'; noTasksEl.style.display='none';
    tasksList.innerHTML='';
    relatedPlans.forEach(p=>{
      _deliveryTaskStates[p.id]='pending';
      const prioColor={P1:'#dc2626',P2:'#f59e0b',P3:'#22c55e',DEF:'#7c3aed'}[p.priority||'P2'];
      const row=document.createElement('div');
      row.className='dtask-row'; row.id='dtask-'+p.id;
      const info=document.createElement('div'); info.style.cssText='flex:1;min-width:0';
      info.innerHTML='<div style="display:flex;align-items:center;gap:6px"><span style="background:'+prioColor+'20;color:'+prioColor+';font-size:9px;font-weight:700;padding:1px 6px;border-radius:8px">'+esc(p.code)+'</span><span style="font-size:12px;font-weight:600">'+esc(p.name)+'</span></div>'+(p.estMin?'<div style="font-size:10px;color:#64748b;margin-top:2px">'+fdur(p.estMin)+'</div>':'');
      const btnDone=document.createElement('button'); btnDone.className='dtask-status-btn dtask-btn-done'; btnDone.textContent='Completada';
      const btnUndone=document.createElement('button'); btnUndone.className='dtask-status-btn dtask-btn-undone'; btnUndone.textContent='No realizada';
      btnDone.onclick=()=>{ _deliveryTaskStates[p.id]='done'; row.className='dtask-row done'; btnDone.classList.add('active'); btnUndone.classList.remove('active'); updateDeliveryReason(); };
      btnUndone.onclick=()=>{ _deliveryTaskStates[p.id]='undone'; row.className='dtask-row undone'; btnUndone.classList.add('active'); btnDone.classList.remove('active'); updateDeliveryReason(); };
      row.appendChild(info); row.appendChild(btnDone); row.appendChild(btnUndone);
      tasksList.appendChild(row);
    });
  } else {
    tasksSection.style.display='none'; noTasksEl.style.display='block';
  }
  document.getElementById('modal-delivery').classList.add('open');
}

function updateDeliveryReason(){
  const hasUndone=Object.values(_deliveryTaskStates).some(s=>s==='undone');
  const wrap=document.getElementById('delivery-reason-wrap');
  const lbl=document.getElementById('delivery-reason-lbl');
  if(wrap) wrap.style.display=hasUndone?'block':'none';
  const n=Object.values(_deliveryTaskStates).filter(s=>s==='undone').length;
  if(lbl) lbl.textContent='Motivo de no realizacion ('+n+' tarea'+(n!==1?'s':'')+')';
}

function closeDeliveryModal(){ document.getElementById('modal-delivery').classList.remove('open'); _deliveryTaskId=null; _deliveryAc=null; _deliveryTaskStates={}; }

async function confirmDelivery(){
  if(!_deliveryTaskId||!FB) return;
  const btn=document.getElementById('delivery-confirm-btn');
  btn.textContent='Guardando...'; btn.disabled=true;
  try{
    const st=activeStation();
    const reason=(document.getElementById('delivery-reason-input').value||'').trim();
    const hasUndone=Object.values(_deliveryTaskStates).some(s=>s==='undone');
    if(hasUndone&&!reason){ toast('Escribe el motivo para las tareas no realizadas',true); btn.textContent='Confirmar entrega'; btn.disabled=false; return; }
    const deliveredBy=currentUserName||'—';
    const deliveredAt=new Date().toLocaleTimeString('es-DO',{hour:'2-digit',minute:'2-digit'});
    // Get all plan tasks linked to this OT
    const ot = tasks.find(x=>x.id===_deliveryTaskId);
    // Get plan task IDs from OT's linkedTasks (refreshed from Firestore)
    let linkedTaskIds = (ot?.linkedTasks||[]).map(t=>t.id||t.planId).filter(Boolean);
    // If not in memory, query Firestore for latest OT data
    if(!linkedTaskIds.length && _deliveryTaskId){
      try{
        const otSnap = await FB.db.collection(AIRLINE_ID).doc(st).collection('tasks').doc(_deliveryTaskId).get();
        linkedTaskIds = (otSnap.data()?.linkedTasks||[]).map(t=>t.id||t.planId).filter(Boolean);
        // Last resort: match by AC in plans, then filter by WO in JS
        if(!linkedTaskIds.length && ot?.ac){
          const planSnap = await FB.db.collection(AIRLINE_ID).doc(st).collection('plans')
            .where('ac','==',ot.ac).get();
          const woList = (ot?.wo||'').split(',').map(w=>w.trim()).filter(Boolean);
          linkedTaskIds = planSnap.docs
            .filter(d => {
              if(d.data().status==='done') return false;
              if(!woList.length) return true;
              return woList.some(w => (d.data().wo||'').trim()===w);
            })
            .map(d=>d.id);
        }
      }catch(_){}
    }

    const updates=[];
    // Process tasks with explicit state from delivery modal
    const explicitStates = new Set(Object.keys(_deliveryTaskStates));
    for(const [planId,status] of Object.entries(_deliveryTaskStates)){
      if(status==='done') updates.push(FB.db.collection(AIRLINE_ID).doc(st).collection('plans').doc(planId).update({status:'done',doneByName:deliveredBy,doneTime:deliveredAt,updatedAt:Date.now()}));
      else if(status==='undone') updates.push(FB.db.collection(AIRLINE_ID).doc(st).collection('plans').doc(planId).update({status:'unassigned',unassignReason:reason,unassignedBy:deliveredBy,updatedAt:Date.now()}));
    }
    // Mark remaining linked tasks (not explicitly set) as 'done' on delivery
    for(const planId of linkedTaskIds){
      if(!explicitStates.has(planId)){
        updates.push(FB.db.collection(AIRLINE_ID).doc(st).collection('plans').doc(planId).update({status:'done',doneByName:deliveredBy,doneTime:deliveredAt,updatedAt:Date.now()}));
      }
    }
    await Promise.all(updates);
    const taskSnap=await FB.db.collection(AIRLINE_ID).doc(st).collection('tasks').doc(_deliveryTaskId).get();
    const existingHistory=taskSnap.data()?.deliveryHistory||[];
    existingHistory.push({deliveredBy,deliveredAt});
    await FB.db.collection(AIRLINE_ID).doc(st).collection('tasks').doc(_deliveryTaskId).update({status:'entregada',deliveredBy,deliveredAt,deliveryHistory:existingHistory});
    playSound('delivered');
    toast(_deliveryAc+' entregada por '+deliveredBy+' a las '+deliveredAt);
    closeDeliveryModal();
  }catch(e){ console.error('confirmDelivery error:', e); toast('Error al entregar: '+e.message,true); btn.textContent='Confirmar entrega'; btn.disabled=false; }
}


async function delTask(id){if(currentRole==='tech'){toast('⛔ Sin permisos',true);return;}if(!confirm('¿Eliminar esta OT?'))return;if(!FB)return;await FB.db.collection(AIRLINE_ID).doc(activeStation()).collection('tasks').doc(id).delete();toast('OT eliminada');}

// ══ DEMAND ══
function renderDemand(){const hrs=demandHrs(),maxV=Math.max(...hrs,1);const chart=document.getElementById('dchart');chart.innerHTML='';const xEl=document.getElementById('dxaxis');xEl.innerHTML='';hrs.forEach((v,i)=>{const p=v>0?(v/maxV*100):1.5;const col=v===0?'#e2e8f0':v/maxV>0.75?'#dc2626':v/maxV>0.4?'#2563eb':'#60a5fa';const wrap=document.createElement('div');wrap.className='bar-col';wrap.innerHTML=`<div class="bct">${v} técnico${v!==1?'s':''}</div><div class="bar-fill" style="height:${p}%;background:${col}"></div>`;chart.appendChild(wrap);const lbl=document.createElement('div');lbl.className='x-lbl';lbl.textContent=i%3===0?(i<10?'0':'')+i+'h':'';xEl.appendChild(lbl);});}
function renderHistory(){const el=document.getElementById('history-tbl');if(!history.length){el.innerHTML='<p style="color:#94a3b8;padding:8px;font-size:12px">Sin historial aún.</p>';return;}let h='<table style="width:100%;border-collapse:collapse;font-size:11px"><thead><tr style="background:#f8fafc"><th style="padding:5px 8px;text-align:left;font-size:10px;color:#64748b;white-space:nowrap">Fecha</th>';for(let i=0;i<24;i++)h+=`<th style="padding:4px 2px;text-align:center;font-size:9px;color:#94a3b8">${(i<10?'0':'')+i}</th>`;h+='<th style="padding:4px 6px;font-size:9px;color:#64748b">Pico</th></tr></thead><tbody>';[...history].reverse().slice(0,20).forEach(s=>{h+=`<tr><td style="padding:4px 8px;font-weight:500;white-space:nowrap">${s.date}</td>`;(s.hrs||[]).forEach(v=>{const bg=v===0?'transparent':v<=2?'#dbeafe':v<=4?'#3b82f6':'#1e40af';const col=v<=2?'#1e40af':'#fff';h+=`<td style="padding:3px 2px;text-align:center;background:${bg};color:${col};border-radius:2px;font-weight:${v>0?600:400}">${v||''}</td>`;});h+=`<td style="padding:4px 6px;text-align:center;font-weight:700;color:#0f2a66">${Math.max(...(s.hrs||[0]),0)}</td></tr>`;});h+='</tbody></table>';el.innerHTML=h;}

// ══ ROSTER ══
function renderStaff(){
  const isAdmin=(currentRole==='superadmin'||currentRole==='supervisor'||currentRole==='admin');
  const tb=document.getElementById('stbody');tb.innerHTML='';
  document.getElementById('roster-title').textContent=`👥 Roster de técnicos (${techs.length})`;

  // Show/hide admin controls
  ['btn-add-tech','btn-import-roster','btn-clear-roster'].forEach(id=>{
    const el=document.getElementById(id);
    if(el) el.style.display=isAdmin?'':'none';
  });
  const shiftPanel=document.getElementById('shift-config-panel');
  if(shiftPanel) shiftPanel.style.display=currentRole==='superadmin'?'':'none';
  renderShiftEditor();

  // Build shift dropdown options
  const shiftOpts=shiftDefs.map(sh=>
    `<option value="${sh.id}">${sh.emoji||'⏰'} ${sh.name} (${sh.start}–${sh.end})</option>`
  ).join('');
  // Also populate new-tech-shift select
  const ntShift=document.getElementById('new-tech-shift');
  if(ntShift){ ntShift.innerHTML=shiftOpts; }

  const assigned=techAssignedHours();
  techs.forEach((s,i)=>{
    const tr=document.createElement('tr');
    const rc={FIRMA:'#dbeafe',GASEO:'#dcfce7',DESPACHO:'#fef9c3','NO-FIRMA':'#f0fdf4',ASISTENTE:'#fef3c7'}[s.role]||'#f1f5f9';
    const workedH=assigned[s.id]||0;
    const remaining=Math.max(0,(s.hours||0)-workedH);
    const pct2=s.hours>0?Math.round((remaining/s.hours)*100):0;
    const barColor=pct2>60?'#22c55e':pct2>30?'#f59e0b':'#ef4444';
    const hoursCell=`<td style="min-width:90px">
      <div style="display:flex;align-items:center;gap:6px">
        <div style="flex:1;height:6px;background:#f1f5f9;border-radius:3px;overflow:hidden">
          <div style="width:${pct2}%;height:100%;background:${barColor};border-radius:3px;transition:width .3s"></div>
        </div>
        <span style="font-size:10px;font-weight:700;color:${barColor};white-space:nowrap">${remaining%1===0?remaining:remaining.toFixed(1)}h libre</span>
      </div>
      <div style="font-size:9px;color:#94a3b8;margin-top:1px">${workedH>0?'Asignado: '+(workedH%1===0?workedH:workedH.toFixed(1))+'h':'Sin asignación'}</div>
    </td>`;
    // Shift display: match by ID or by old time-string format
    const shiftLabel=()=>{
      const sd=shiftDefs.find(x=>x.id===s.shift);
      if(sd) return `${sd.emoji||'⏰'} ${sd.name}`;
      return s.shift||'—'; // legacy time string
    };
    // Shift select with current value
    const shiftSelectOpts=shiftDefs.map(sh=>
      `<option value="${sh.id}" ${s.shift===sh.id?'selected':''}>${sh.emoji||'⏰'} ${sh.name} (${sh.start}–${sh.end})</option>`
    ).join('');
    if(isAdmin){
      tr.innerHTML=`
        <td style="color:#94a3b8;font-size:11px;font-weight:600">${i+1}</td>
        <td><input class="editable" value="${esc(s.name)}" onchange="updTech('${s.id}','name',this.value.toUpperCase())" style="min-width:160px;text-transform:uppercase"></td>
        <td><select class="sel-sm" onchange="setRole('${s.id}',this.value)" style="background:${rc}">
          <option value="FIRMA" ${s.role==='FIRMA'?'selected':''}>FIRMA</option>
          <option value="NO-FIRMA" ${s.role==='NO-FIRMA'?'selected':''}>NO-FIRMA</option>
          <option value="ASISTENTE" ${s.role==='ASISTENTE'?'selected':''}>ASISTENTE</option>
          <option value="GASEO" ${s.role==='GASEO'?'selected':''}>⛽ GASEO</option>
          <option value="DESPACHO" ${s.role==='DESPACHO'?'selected':''}>✈ DESPACHO</option>
        </select></td>
        <td><input class="h-inp" type="number" min="0.5" max="24" step="0.5" value="${s.hours}" onchange="updTech('${s.id}','hours',parseFloat(this.value))"></td>
        <td><select class="sel-sm" onchange="updTech('${s.id}','shift',this.value)">${shiftSelectOpts}</select></td>
        ${hoursCell}
        <td><button class="delbtn" onclick="delTech('${s.id}')" title="Eliminar técnico">✕</button></td>`;
    } else {
      tr.innerHTML=`
        <td style="color:#94a3b8;font-size:11px">${i+1}</td>
        <td style="font-weight:500">${esc(s.name)}</td>
        <td><span style="background:${rc};padding:2px 8px;border-radius:20px;font-size:10px;font-weight:600">${s.role}</span></td>
        <td style="text-align:center">${s.hours}h</td>
        <td>${shiftLabel()}</td>
        ${hoursCell}<td></td>`;
    }
    tb.appendChild(tr);
  });
}

function openAddTechForm(){
  const form=document.getElementById('add-tech-form');
  if(form){ form.style.display='block'; document.getElementById('new-tech-name')?.focus(); }
  renderShiftEditor(); // ensure shift options are populated
}

async function confirmAddTech(){
  const name=(document.getElementById('new-tech-name')?.value||'').trim().toUpperCase();
  const role=document.getElementById('new-tech-role')?.value||'FIRMA';
  const shift=document.getElementById('new-tech-shift')?.value||shiftDefs[0]?.id||'A';
  if(!name){ toast('Ingresa el nombre del técnico',true); return; }
  if(!FB) return;
  const defaultHours={FIRMA:6,'NO-FIRMA':3,ASISTENTE:1.5,GASEO:9,DESPACHO:9}[role]||6;
  const station=window._station;
  await FB.db.collection(AIRLINE_ID).doc(station).collection('techs').add({
    name, role, hours:defaultHours, shift, createdAt:Date.now(), createdBy:currentUserName
  });
  document.getElementById('new-tech-name').value='';
  document.getElementById('add-tech-form').style.display='none';
  toast('✅ '+name+' agregado al roster');
}

async function updTech(id,f,v){
  if(currentRole==='tech') return;
  if(!FB) return;
  const st=window._station;
  await FB.db.collection(AIRLINE_ID).doc(st).collection('techs').doc(id).update({[f]:f==='hours'?parseFloat(v):v});
}

async function setRole(id,role){
  if(currentRole==='tech') return;
  const h={FIRMA:6,'NO-FIRMA':3,ASISTENTE:1.5,GASEO:9,DESPACHO:9}[role]||6;
  if(!FB) return;
  const st=window._station;
  await FB.db.collection(AIRLINE_ID).doc(st).collection('techs').doc(id).update({role,hours:h});
  toast('✔ '+role+' → '+h+'h');
}

async function delTech(id){
  if(currentRole==='tech') return;
  if(!confirm('¿Eliminar este técnico del roster?')) return;
  if(!FB) return;
  const st=window._station;
  await FB.db.collection(AIRLINE_ID).doc(st).collection('techs').doc(id).delete();
  toast('Técnico eliminado');
}

async function clearAllTechs(){
  if(currentRole!=='superadmin') return;
  if(!confirm(`⚠️ ¿Borrar TODO el roster de ${window._station}?\n\nEsta acción no se puede deshacer.`)) return;
  if(!FB) return;
  const st=window._station;
  const snap=await FB.db.collection(AIRLINE_ID).doc(st).collection('techs').get();
  const batch=FB.db.batch();
  snap.docs.forEach(d=>batch.delete(d.ref));
  await batch.commit();
  toast('🗑 Roster de '+st+' vaciado — agrega nuevos técnicos');
}

function importRosterExcel(){ document.getElementById('roster-excel-input')?.click(); }

function handleRosterExcel(input){
  const file=input.files[0]; if(!file) return;
  input.value='';
  const reader=new FileReader();
  reader.onload=function(e){
    try{
      const wb=XLSX.read(e.target.result,{type:'binary'});
      const ws=wb.Sheets[wb.SheetNames[0]];
      const raw=XLSX.utils.sheet_to_json(ws,{defval:''});
      if(!raw.length){ toast('Archivo vacío',true); return; }
      function nrm(s){ return String(s).normalize('NFD').replace(/[̀-ͯ]/g,'').replace(/[\s\-]/g,'_').toUpperCase(); }
      const hdrs=Object.keys(raw[0]);
      const find=list=>hdrs.find(h=>list.includes(nrm(h)))||null;
      const colName=find(['NOMBRE','NAME','TECNICO','TECHNICIAN','EMPLEADO','PERSONAL']);
      const colRole=find(['CATEGORIA','ROL','ROLE','CATEGORY','TIPO']);
      const colShift=find(['TURNO','SHIFT','HORARIO']);
      if(!colName){ toast('No se encontró columna NOMBRE',true); return; }
      const rows=raw.map(r=>({
        name:String(r[colName]||'').trim().toUpperCase(),
        role:String(colRole?r[colRole]:'FIRMA').trim().toUpperCase()||'FIRMA',
        shift:String(colShift?r[colShift]:'').trim().toUpperCase()||shiftDefs[0]?.id||'A',
      })).filter(r=>r.name);
      if(!rows.length){ toast('Sin filas válidas',true); return; }
      if(!confirm(`Importar ${rows.length} técnicos al roster de ${window._station}?`)) return;
      const st=window._station;
      const batch=FB.db.batch();
      const defaultH={FIRMA:6,'NO-FIRMA':3,ASISTENTE:1.5,GASEO:9,DESPACHO:9};
      rows.forEach(r=>{
        const ref=FB.db.collection(AIRLINE_ID).doc(st).collection('techs').doc();
        batch.set(ref,{name:r.name,role:r.role,hours:defaultH[r.role]||6,shift:r.shift,createdAt:Date.now(),createdBy:currentUserName});
      });
      batch.commit().then(()=>toast('✅ '+rows.length+' técnicos importados')).catch(err=>toast('Error: '+err.message,true));
    }catch(err){ console.error(err); toast('Error leyendo Excel: '+err.message,true); }
  };
  reader.readAsBinaryString(file);
}

// ══ MODAL OT (admin only) ══
// ══ OT ATTACHMENTS ══
let pendingOTFiles = [];   // [{name, url, type}] — already uploaded
let otAttachUploading = 0; // counter of in-flight uploads

// ── Download / Open file — iOS Safari safe (synchronous) ──
function downloadOTFile(url, filename){
  if(!url){ toast('⚠ Sin URL de archivo',true); return; }

  // Fix old Cloudinary URLs if any
  const finalUrl = url.includes('cloudinary.com')
    ? fixCloudinaryUrl(url, filename) : url;

  // iOS Safari requires window.open to be called SYNCHRONOUSLY
  // from a user gesture (tap). Any await before it blocks the popup.
  // For Supabase public URLs: open directly — browser handles PDF viewing/download
  const newTab = window.open(finalUrl, '_blank');

  // If popup was blocked (some browsers), navigate current tab
  if(!newTab || newTab.closed || typeof newTab.closed === 'undefined'){
    window.location.href = finalUrl;
  }

  toast('📄 Abriendo '+filename+'...');
}

// Fixes Cloudinary URLs — removes fl_attachment transformation (requires paid plan)
// Does NOT change /image/upload/ → /raw/upload/ because file IS stored as image type
function fixCloudinaryUrl(url, filename){
  if(!url) return url;
  // Remove fl_attachment regardless of file type — it needs signed URL on free plan
  let u = url;
  u = u.replace('/upload/fl_attachment/', '/upload/');
  u = u.replace('/upload/fl_attachment', '/upload/');
  return u;
}

function getFileIconEmoji(name){
  const e=(name||'').split('.').pop().toLowerCase();
  if(e==='pdf') return '⬇ 📄';
  if(['doc','docx'].includes(e)) return '⬇ 📝';
  if(['xls','xlsx'].includes(e)) return '⬇ 📊';
  if(['png','jpg','jpeg','gif','webp'].includes(e)) return '⬇ 🖼️';
  return '⬇ 📎';
}
function getFileBtnCls(name){
  const e=(name||'').split('.').pop().toLowerCase();
  if(e==='pdf') return 'pdf';
  if(['xls','xlsx'].includes(e)) return 'xls';
  return '';
}

function handleOTAttach(files){
  if(!files||!files.length) return;
  Array.from(files).forEach(file=>{
    if(file.size>20*1024*1024){ toast('⚠ '+file.name+' supera 20MB',true); return; }
    uploadOTFile(file);
  });
  document.getElementById('fm-attach-input').value='';
}

async function uploadOTFile(file){
  if(!sbConfigured()){
    toast('⚠ Configura Supabase primero (panel verde arriba)',true);
    document.getElementById('sb-config-panel').style.display='block';
    return;
  }
  otAttachUploading++;
  const prog=document.getElementById('fm-attach-progress');
  const lbl=document.getElementById('fm-attach-prog-lbl');
  const fill=document.getElementById('fm-attach-prog-fill');
  prog.style.display='block';
  lbl.textContent='Subiendo '+file.name+'…';
  fill.style.width='5%'; // show activity immediately

  try{
    const st=activeStation();
    const {url,path}=await uploadToSupabase(file, `${st}/ot_files`);
    pendingOTFiles.push({name:file.name, url, type:file.type, path});
    renderOTAttachTags();
    lbl.textContent='✅ '+file.name+' listo';
    fill.style.width='100%';
    if(--otAttachUploading===0) setTimeout(()=>prog.style.display='none',1500);
  }catch(e){
    if(--otAttachUploading===0) prog.style.display='none';
    toast('❌ Error: '+e.message,true);
    console.error('uploadOTFile error:',e);
  }
}

function removeOTFile(idx){
  pendingOTFiles.splice(idx,1);
  renderOTAttachTags();
}

function renderOTAttachTags(){
  const wrap=document.getElementById('fm-attach-tags');
  if(!wrap) return;
  wrap.innerHTML='';
  pendingOTFiles.forEach((f,i)=>{
    const tag=document.createElement('div');
    tag.className='ot-file-tag';
    tag.innerHTML=`${getFileIconEmoji(f.name)} <span style="max-width:130px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${esc(f.name)}">${esc(f.name)}</span><button class="rm" onclick="removeOTFile(${i})">×</button>`;
    wrap.appendChild(tag);
  });
}

// Render existing attachments in modal (when editing)
function renderExistingAttachments(files){
  const wrap=document.getElementById('fm-attachments-list');
  if(!wrap) return;
  wrap.innerHTML='';
  if(!files||!files.length){
    const s=document.createElement('span');
    s.style.cssText='font-size:10px;color:#94a3b8';
    s.textContent='Sin archivos adjuntos aún';
    wrap.appendChild(s);
    return;
  }
  files.forEach(f=>{
    const a=document.createElement('a');
    a.href='#';
    a.className='ot-file-btn '+getFileBtnCls(f.name);
    a.addEventListener('click',e=>{
      e.preventDefault();
      downloadOTFile(f.url, f.name);
    });
    a.title=f.name;
    const icon=document.createTextNode(getFileIconEmoji(f.name)+' ');
    const span=document.createElement('span');
    span.style.cssText='max-width:130px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap';
    span.textContent=f.name;
    a.appendChild(icon);
    a.appendChild(span);
    wrap.appendChild(a);
  });
}

function populateSelects(){const all=[...techs].sort((a,b)=>a.name.localeCompare(b.name));const tsel=document.getElementById('fm-tsel');tsel.innerHTML='<option value="">+ Añadir técnico</option>';all.filter(t=>!['GASEO','DESPACHO'].includes(t.role)).forEach(s=>{const o=document.createElement('option');o.value=s.id;o.textContent=`${s.name}  (${s.role}·${s.hours}h·${s.shift})`;tsel.appendChild(o);});[document.getElementById('fm-gaseo'),document.getElementById('fm-despacho')].forEach(sel=>{sel.innerHTML='<option value="">— Sin asignar —</option>';all.forEach(s=>{const o=document.createElement('option');o.value=s.id;o.textContent=`${s.name}  (${s.shift})`;sel.appendChild(o);});});}

function openModal(taskId){
  if(currentRole==='tech'){toast('⛔ Solo supervisores y admins pueden crear OTs',true);return;}
  editingTaskId=taskId;populateSelects();formTechs=[];
  document.getElementById('fm-tags').innerHTML='';document.getElementById('fm-dur').textContent='';document.getElementById('fm-warn').textContent='';
  // Reset OT attachments
  pendingOTFiles=[];
  document.getElementById('fm-attach-tags').innerHTML='';
  document.getElementById('fm-attach-progress').style.display='none';
  if(taskId){
    const t=tasks.find(x=>x.id===taskId);if(!t)return;
    document.getElementById('modal-title').textContent='✏️ Editar OT';document.getElementById('modal-submit-btn').textContent='💾 Guardar cambios';
    document.getElementById('fm-ac').value=t.ac||'';document.getElementById('fm-wo').value=t.wo||'';
    // Calculate ETD date from taskDate + taskDays
    const etaDate=t.taskDate||selectedDate;
    const etdDateObj=new Date(etaDate+'T12:00:00');
    etdDateObj.setDate(etdDateObj.getDate()+(t.taskDays||0));
    const etdDate=localDateStr(etdDateObj);
    document.getElementById('fm-eta-date').value=etaDate;
    document.getElementById('fm-etd-date').value=etdDate;
    document.getElementById('fm-eta').value=hhmm(t.gs);
    document.getElementById('fm-etd').value=hhmm(t.ge);
    validateWindow();
    document.getElementById('fm-st').value=hhmm(t.start);
    const cap=(t.staff||[]).reduce((a,id)=>{const s=techs.find(x=>x.id===id);return a+(s?.hours||0);},0);
    const nomDur=cap>0?Math.round(t.dur*(cap/6)):t.dur;
    document.getElementById('fm-dh').value=Math.floor(nomDur/60);document.getElementById('fm-dm').value=nomDur%60;
    document.getElementById('fm-gaseo').value=t.gaseo||'';document.getElementById('fm-despacho').value=t.despacho||'';
    const aogChk=document.getElementById('fm-aog'); if(aogChk) aogChk.checked=!!t.aog;
    // Initialize multi-WO field
    initWOField(t.wo||'');
    const setFld=(id,val)=>{const el=document.getElementById(id);if(el)el.value=val||'';};
    setFld('fm-arr-flt',t.arrFlt); setFld('fm-arr-origin',t.arrOrigin);
    setFld('fm-dep-flt',t.depFlt); setFld('fm-dep-dest',t.depDest);
    document.getElementById('fm-comments').value=t.comments||'';
    // Load existing file attachments
    pendingOTFiles = (t.attachments||[]).map(f=>({...f}));
    renderOTAttachTags();
    renderExistingAttachments(t.attachments||[]);
    (t.staff||[]).forEach(id=>{const s=techs.find(x=>x.id===id);if(!s)return;formTechs.push(id);const tag=document.createElement('div');tag.className='tag';tag.id='FT'+id;tag.innerHTML=`${esc(s.name.split(' ')[0])} <button onclick="rmFT('${id}')">×</button>`;document.getElementById('fm-tags').appendChild(tag);});updDurPrev();
  } else {
    document.getElementById('modal-title').textContent='Nueva orden de trabajo';document.getElementById('modal-submit-btn').textContent='☁️ Confirmar y guardar';
    ['fm-ac','fm-wo','fm-gaseo','fm-despacho','fm-comments'].forEach(id=>document.getElementById(id).value='');
    document.getElementById('fm-eta-date').value=selectedDate;
    document.getElementById('fm-etd-date').value=selectedDate;
    document.getElementById('fm-eta').value='07:00';
    document.getElementById('fm-etd').value='14:00';
    document.getElementById('fm-st').value='08:00';
    const aogEl=document.getElementById('fm-aog'); if(aogEl) aogEl.checked=false;
    document.getElementById('fm-dh').value=2;document.getElementById('fm-dm').value=0;
    validateWindow();
  }
  document.getElementById('modal-ot').classList.add('open');
}
function closeModal(){document.getElementById('modal-ot').classList.remove('open');editingTaskId=null;}
// ── Sync ETD date to ETA date when ETA date changes ──
function syncETDDate(){
  const etaDate=document.getElementById('fm-eta-date').value;
  const etdDate=document.getElementById('fm-etd-date');
  if(etdDate&&(!etdDate.value||etdDate.value<etaDate)) etdDate.value=etaDate;
  validateWindow();
}

// ── Calculate taskDays from date diff ──
function getTaskDays(){
  const etaDate=document.getElementById('fm-eta-date').value;
  const etdDate=document.getElementById('fm-etd-date').value;
  if(!etaDate||!etdDate) return 0;
  const a=new Date(etaDate+'T12:00:00'), b=new Date(etdDate+'T12:00:00');
  return Math.max(0, Math.round((b-a)/(1000*60*60*24)));
}

function validateWindow(){
  const eta=toMin(document.getElementById('fm-eta').value||'00:00');
  const etd=toMin(document.getElementById('fm-etd').value||'23:59');
  const st=toMin(document.getElementById('fm-st').value||'00:00');
  const dh=Number(document.getElementById('fm-dh').value)||0;
  const dm=Number(document.getElementById('fm-dm').value)||0;
  const nom=dh*60+dm, end=st+nom;
  const w=document.getElementById('fm-warn');
  const taskDays=getTaskDays();
  const prev=document.getElementById('fm-slot-preview');

  // Show slot preview
  const etaDateVal=document.getElementById('fm-eta-date').value;
  const etdDateVal=document.getElementById('fm-etd-date').value;
  if(etaDateVal&&etdDateVal&&prev){
    const etaFmt=new Date(etaDateVal+'T12:00:00').toLocaleDateString('es-DO',{weekday:'short',day:'2-digit',month:'short'});
    const etdFmt=new Date(etdDateVal+'T12:00:00').toLocaleDateString('es-DO',{weekday:'short',day:'2-digit',month:'short'});
    const samDay=etaDateVal===etdDateVal;
    prev.innerHTML=samDay
      ? `✅ Mismo día · ${hhmm(eta)} → ${hhmm(etd)}`
      : `🌙 <strong>${etaFmt} ${hhmm(eta)}</strong> → <strong>${etdFmt} ${hhmm(etd)}</strong> · ${taskDays} día${taskDays>1?'s':''} en tierra`;
    prev.style.color=samDay?'#166534':'#7c3aed';
  }

  w.style.color='#b45309';
  if(nom>0&&st<eta&&taskDays===0) w.textContent='⚠ Inicio anterior a ETA ('+hhmm(eta)+')';
  else if(nom>0&&end>etd&&taskDays===0) w.textContent='⚠ Fin ('+hhmm(end)+') supera ETD. Ajusta la fecha ETD si sale al día siguiente.';
  else w.textContent='';
  updDurPrev();
}
function addFormTech(sel){const v=sel.value;if(!v||formTechs.includes(v))return;formTechs.push(v);const s=techs.find(x=>x.id===v);const tag=document.createElement('div');tag.className='tag';tag.id='FT'+v;tag.innerHTML=`${esc(s.name.split(' ')[0])} <button onclick="rmFT('${v}')">×</button>`;document.getElementById('fm-tags').appendChild(tag);sel.value='';updDurPrev();}
function rmFT(id){formTechs=formTechs.filter(x=>x!==id);const t=document.getElementById('FT'+id);if(t)t.remove();updDurPrev();}
function updDurPrev(){const dh=Number(document.getElementById('fm-dh').value)||0,dm=Number(document.getElementById('fm-dm').value)||0,nom=dh*60+dm;const cap=formTechs.reduce((a,id)=>{const s=techs.find(x=>x.id===id);return a+(s?.hours||0);},0);const el=document.getElementById('fm-dur');if(nom>0&&cap>0)el.textContent=`Cap: ${cap}h → ajustada: ${fdur(Math.round(nom/(cap/6)))} (nominal: ${fdur(nom)})`;else if(nom>0)el.textContent=`Duración nominal: ${fdur(nom)}`;else el.textContent='';}
document.getElementById('fm-dh').addEventListener('input',updDurPrev);
document.getElementById('fm-dm').addEventListener('input',updDurPrev);
async function submitOT(){
  if(currentRole==='tech'){toast('⛔ Sin permisos para crear OTs',true);return;}
  if(!FB){toast('⚠ Sin conexión',true);return;}
  if(!window._station){toast('⚠ Selecciona una base antes de guardar la OT',true);return;}
  const ac=document.getElementById('fm-ac').value,wo=document.getElementById('fm-wo').value.toUpperCase();
  if(!ac||!wo){toast('⚠ Completa matrícula y código WO',true);return;}
  const st=toMin(document.getElementById('fm-st').value||'08:00');
  const dh=Number(document.getElementById('fm-dh').value)||0,dm=Number(document.getElementById('fm-dm').value)||0;
  const gs=toMin(document.getElementById('fm-eta').value||'07:00'),ge=toMin(document.getElementById('fm-etd').value||'14:00');
  const nom=Math.max(15,dh*60+dm);
  const cap=formTechs.reduce((a,id)=>{const s=techs.find(x=>x.id===id);return a+(s?.hours||0);},0);
  let dur=Math.round(nom/(cap>0?cap/6:1));
  const taskDays=getTaskDays();
  // Use ETA date as taskDate
  const otTaskDate=document.getElementById('fm-eta-date').value||selectedDate;
  const aog=document.getElementById('fm-aog')?.checked||false;
  const wrap=document.getElementById('fm-plan-tasks-wrap');
  const linkedTasksData=wrap?JSON.parse(wrap.dataset.tasks||'[]'):[];
  // If plan tasks linked, use their total estimated time as maintenance duration
  if(linkedTasksData.length > 0){
    // Sum estimated time from ALL linked plan tasks across all WOs
    const planTotal = linkedTasksData.reduce((s,t)=>s+(t.estMin||30),0);
    if(planTotal > 0) dur = planTotal;
    console.log('[OT] Plan tasks:', linkedTasksData.length, 'Total mins:', planTotal);
  }
  const arrFlt  = (document.getElementById('fm-arr-flt')?.value||'').trim().toUpperCase();
  const arrOrigin= (document.getElementById('fm-arr-origin')?.value||'').trim().toUpperCase();
  const depFlt  = (document.getElementById('fm-dep-flt')?.value||'').trim().toUpperCase();
  const depDest = (document.getElementById('fm-dep-dest')?.value||'').trim().toUpperCase();
  const data={ac,wo,start:st,dur,staff:[...formTechs],gs,ge,taskDays,aog,
    arrFlt,arrOrigin,depFlt,depDest,gaseo:document.getElementById('fm-gaseo').value||'',despacho:document.getElementById('fm-despacho').value||'',comments:document.getElementById('fm-comments').value||'',taskDate:otTaskDate,attachments:[...pendingOTFiles],linkedTasks:linkedTasksData};
  try{
    if(editingTaskId){await FB.db.collection(AIRLINE_ID).doc(window._station).collection('tasks').doc(editingTaskId).update(data);toast('💾 OT actualizada: '+wo);}
    else{await FB.addDoc(FB.TASKS(window._station),{...data,createdBy:currentUser?.uid||'anon',createdBy_name:currentUserName,createdAt:Date.now()});boeingChime();toast('☁️ '+wo+' → '+hhmm(st)+' – '+hhmm(st+dur)+'  ('+fdur(dur)+')');}
    closeModal();
  }catch(e){
    console.error('submitOT error:',e);
    toast('❌ Error al guardar OT: '+e.message,true);
  }
}

// ══ DOCS ══
function handleDrop(e){e.preventDefault();document.getElementById('drop-zone').classList.remove('over');handleFiles(e.dataTransfer.files);}
function handleFiles(files){
  if(currentRole==='tech'){toast('⛔ Solo supervisores y admins pueden subir documentos',true);return;}
  if(!files||!files.length)return;
  if(files.length===1){pendingFile=files[0];document.getElementById('doc-file-preview').innerHTML=`${fileIcon(pendingFile.name).icon} <strong>${esc(pendingFile.name)}</strong> &nbsp;(${fmtSz(pendingFile.size)})`;document.getElementById('mdoc-cat').value='General';document.getElementById('mdoc-desc').value='';document.getElementById('mdoc-confirm').onclick=()=>{document.getElementById('modal-doc').classList.remove('open');doUpload(pendingFile,{category:document.getElementById('mdoc-cat').value,description:document.getElementById('mdoc-desc').value});};document.getElementById('modal-doc').classList.add('open');}
  else{Array.from(files).forEach(f=>doUpload(f,{category:'General',description:''}));}
}
async function doUpload(file,meta){
  if(currentRole==='tech')return;
  if(!sbConfigured()){
    toast('⚠ Configura Supabase primero (panel verde arriba)',true);
    document.getElementById('sb-config-panel').style.display='block';
    return;
  }
  if(file.size>50*1024*1024){toast(`⚠ ${file.name} supera 50 MB`,true);return;}
  const pw=document.getElementById('prog-wrap'),pf=document.getElementById('prog-fill'),pl=document.getElementById('prog-lbl');
  pw.style.display='block'; pf.style.width='5%'; pl.textContent=`Subiendo ${file.name}…`;
  const st=activeStation();
  try{
    const {url,path}=await uploadToSupabase(file, `${st}/docs`);
    if(FB)await FB.addDoc(FB.DOCS(st),{
      name:file.name, size:file.size, type:file.type,
      url, path,
      category:meta.category||'General',
      description:meta.description||'',
      uploadedAt:Date.now(), uploadedBy:currentUserName
    });
    pf.style.width='100%';
    setTimeout(()=>pw.style.display='none',800);
    toast(`✅ ${file.name} subido correctamente`);
  }catch(e){
    pw.style.display='none';
    toast('❌ Error subiendo: '+e.message,true);
    console.error('doUpload error:',e);
  }
}
function renderDocs(){
  const isAdmin=(currentRole==='superadmin'||currentRole==='supervisor'||currentRole==='admin');
  const list=document.getElementById('docs-list');list.innerHTML='';
  const cat=document.getElementById('doc-cat-filter')?.value||'';
  const q=(document.getElementById('doc-search')?.value||'').toLowerCase();
  let filtered=documents;
  if(cat)filtered=filtered.filter(d=>d.category===cat);
  if(q)filtered=filtered.filter(d=>(d.name||'').toLowerCase().includes(q)||(d.description||'').toLowerCase().includes(q));
  if(!filtered.length){list.innerHTML='<div style="text-align:center;padding:28px;color:#94a3b8;font-size:12px;grid-column:1/-1">Sin documentos.</div>';return;}
  filtered.forEach(d=>{
    const fi=fileIcon(d.name);const card=document.createElement('div');card.className='doc-card';
    card.innerHTML=`
      <div style="display:flex;align-items:flex-start;gap:10px">
        <div class="doc-icon ${fi.cls}">${fi.icon}</div>
        <div style="flex:1;min-width:0">
          <div style="font-weight:600;font-size:12px;word-break:break-word">${esc(d.name)}</div>
          ${d.description?`<div style="font-size:10px;color:#64748b">${esc(d.description)}</div>`:''}
          <div style="font-size:10px;color:#94a3b8">${fmtSz(d.size||0)} · ${fmtDt(d.uploadedAt)}</div>
          <span class="cat-badge cat-${d.category||'General'}">${d.category||'General'}</span>
        </div>
      </div>
      <div style="display:flex;gap:5px">
        <button class="btn btn-blue" 
          data-url="${d.url}" data-name="${esc(d.name)}"
          onclick="downloadOTFile(this.dataset.url, this.dataset.name)"
          style="flex:1;padding:6px;font-size:11px;justify-content:center">⬇ Descargar</button>
        ${isAdmin?`<button class="delbtn" onclick="delDoc('${d.id}')" title="Eliminar">✕</button>`:''}
      </div>`;
    list.appendChild(card);
  });
}
async function delDoc(id){if(currentRole==='tech')return;if(!confirm('¿Eliminar?'))return;if(!FB)return;await FB.db.collection(AIRLINE_ID).doc(activeStation()).collection('documents').doc(id).delete();toast('🗑 Eliminado');}

// ══ GESTIÓN DE USUARIOS ══
let editingUserId=null;
let allUsers=[];

// Subscribe to users (admin only)
function subscribeUsers(){
  if(!FB||!FB.USERS) return;
  // Just keep local cache in sync — renderUsers does its own fresh fetch
  FB.onSnapshot(FB.USERS(), snap=>{
    allUsers=snap.docs.map(d=>({id:d.id,...d.data()}));
    allUsers.sort((a,b)=>(a.name||'').localeCompare(b.name||''));
  });
}

async function renderUsers(){
  const el=document.getElementById('users-list');
  if(!el) return;
  if(currentRole!=='superadmin'){ el.innerHTML='<div style="color:#94a3b8;padding:16px;text-align:center">⛔ Solo el Super Administrador puede gestionar usuarios</div>'; return; }
  el.innerHTML='<div style="text-align:center;padding:16px;color:#94a3b8;font-size:12px">🔄 Cargando usuarios...</div>';
  loadStationsAdmin(); // show stations while loading users
  try{
    // Fresh fetch every time — never rely on cached array
    const snap=await FB.db.collection(AIRLINE_ID).doc('config').collection('users').get();
    allUsers=snap.docs.map(d=>({id:d.id,...d.data()})).filter(u=>u&&u.name);
    allUsers.sort((a,b)=>(a.name||'').localeCompare(b.name||''));
  }catch(e){ el.innerHTML='<div style="color:#dc2626;padding:16px">Error cargando usuarios: '+e.message+'</div>'; return; }
  if(!allUsers.length){
    el.innerHTML=`<div style="text-align:center;padding:24px;color:#94a3b8;font-size:12px">
      Sin usuarios registrados aún.<br>Clic en <strong>+ Agregar usuario</strong> para agregar supervisores y técnicos.
    </div>
    <div style="background:#f5f3ff;border:1.5px solid #c4b5fd;border-radius:10px;padding:12px 14px;font-size:11px;color:#5b21b6;margin-top:8px">
      <div style="font-weight:700;margin-bottom:4px">👑 Super Administrador (fijo)</div>
      Nombre: <span style="font-family:monospace;font-weight:600">BLADIMIR GOMEZ</span> &nbsp;|&nbsp;
      PIN: <span style="font-family:monospace;background:#1e293b;color:#22c55e;padding:1px 8px;border-radius:10px">0906</span>
    </div>`;
    return;
  }
  el.innerHTML='';

  // Role groups
  const groups = [
    {label:'🔑 Supervisores', roles:['supervisor','admin'], color:'#1e40af', bg:'#eff6ff'},
    {label:'🌐 MCC',          roles:['mcc'],                color:'#6d28d9', bg:'#f5f3ff'},
    {label:'👷 Técnicos',     roles:['tech'],               color:'#166534', bg:'#f0fdf4'},
  ];

  groups.forEach(g=>{
    const members=allUsers.filter(u=>u&&u.name&&u.role&&g.roles.includes(u.role));
    if(!members.length) return;
    const sec=document.createElement('div');
    sec.innerHTML=`<div style="font-size:10px;font-weight:700;color:${g.color};text-transform:uppercase;letter-spacing:.06em;padding:8px 4px 4px;margin-top:8px">${g.label} — ${members.length} persona(s)</div>`;
    members.forEach(u=>{
      const stLbl=stations.find(s=>s.code===u.station)?.code
        ? '📍 '+u.station
        : u.station==='AMBAS'
          ? '🌐 Todas'
          : '🌐 Todas';
      const row=document.createElement('div');
      row.style.cssText=`display:flex;align-items:center;gap:8px;padding:10px 12px;background:${u.active?'#fff':'#f8fafc'};border:1.5px solid ${u.active?'#e2e8f0':'#fca5a5'};border-radius:10px;margin-bottom:6px;${u.active?'':'opacity:.6'}`;
      row.innerHTML=`
        <div style="flex:1;min-width:0">
          <div style="font-weight:700;font-size:13px">${esc(u.name)}</div>
          <div style="display:flex;gap:8px;margin-top:4px;flex-wrap:wrap">
            <span style="background:${g.bg};color:${g.color};font-size:10px;font-weight:600;padding:2px 8px;border-radius:20px">${g.label.split(' ')[0]} ${g.label.split(' ')[1]}</span>
            <span style="background:#f1f5f9;color:#374151;font-size:10px;padding:2px 8px;border-radius:20px">${stLbl}</span>
            <span style="background:#1e293b;color:#22c55e;font-family:monospace;font-size:11px;font-weight:700;padding:2px 10px;border-radius:20px">PIN: ${esc(String(u.pin||'—'))}</span>
            <span style="${u.active?'color:#166534':'color:#dc2626'};font-size:10px;font-weight:600">${u.active?'✅ Activo':'🚫 Desactivado'}</span>
          </div>
        </div>
        <button onclick="editUser('${u.id}')" class="editbtn" title="Editar" style="font-size:16px">✏️</button>
        <button onclick="toggleUserActive('${u.id}',${!u.active})" style="padding:4px 9px;font-size:10px;border-radius:6px;border:1px solid #e2e8f0;background:#fff;cursor:pointer">${u.active?'Desactivar':'Activar'}</button>
        <button onclick="deleteUser('${u.id}')" class="delbtn" title="Eliminar">✕</button>`;
      sec.appendChild(row);
    });
    el.appendChild(sec);
  });

  // Bladimir fixed note
  const note=document.createElement('div');
  note.style.cssText='margin-top:16px;background:#f5f3ff;border:1.5px solid #c4b5fd;border-radius:10px;padding:12px 14px;font-size:11px;color:#5b21b6';
  note.innerHTML=`<div style="font-weight:700;margin-bottom:4px">👑 Super Administrador (fijo — no aparece en la lista)</div>
    <div style="display:flex;gap:8px;flex-wrap:wrap">
      <span style="font-weight:600">Nombre:</span> <span style="font-family:monospace">BLADIMIR GOMEZ</span>
      <span style="font-weight:600;margin-left:8px">PIN:</span> <span style="font-family:monospace;background:#1e293b;color:#22c55e;padding:1px 8px;border-radius:10px">0906</span>
    </div>
    <div style="margin-top:4px;color:#7c3aed">Acceso total — único que puede gestionar usuarios.</div>`;
  el.appendChild(note);
}

function openAddUser(){
  if(!editingUserId && allUsers.filter(u=>u.active!==false).length >= planCfg().maxUsers){
    showUpgradeModal('maxUsers'); return;
  }
  editingUserId=null;
  document.getElementById('user-modal-title').textContent='➕ Agregar usuario';
  document.getElementById('um-name').value='';
  document.getElementById('um-pin').value='';
  document.getElementById('um-role').value='tech';
  document.getElementById('um-station').value='AMBAS';
  document.getElementById('um-active').value='true';
  document.getElementById('um-submit').textContent='💾 Guardar usuario';
  document.getElementById('modal-user').classList.add('open');
}

function editUser(id){
  const u=allUsers.find(x=>x.id===id); if(!u) return;
  editingUserId=id;
  document.getElementById('user-modal-title').textContent='✏️ Editar usuario';
  document.getElementById('um-name').value=u.name||'';
  document.getElementById('um-pin').value=u.pin||'';
  document.getElementById('um-role').value=u.role||'tech';
  document.getElementById('um-station').value=u.station||'AMBAS';
  document.getElementById('um-active').value=String(u.active!==false);
  document.getElementById('um-submit').textContent='💾 Actualizar usuario';
  document.getElementById('modal-user').classList.add('open');
}

function closeUserModal(){ document.getElementById('modal-user').classList.remove('open'); editingUserId=null; }

async function submitUser(){
  if(currentRole!=='superadmin'){ toast('⛔ Solo Bladimir Gomez puede gestionar usuarios',true); return; }
  // Debug: log current Firebase Auth uid (must match Firestore rules)
  const authUser = firebase.auth().currentUser;
  console.log('[Users] Current Firebase auth uid:', authUser?.uid, '| isAnonymous:', authUser?.isAnonymous);
  if(!authUser || authUser.isAnonymous){
    // Superadmin not signed in via email/password → sign in now
    toast('⚠ Reautenticando como superadmin...'); 
    try{
      const pin = prompt('Ingresa tu contraseña de '+SUPERADMIN_EMAIL+' para confirmar:');
      if(!pin) return;
      await firebase.auth().signInWithEmailAndPassword(SUPERADMIN_EMAIL, pin);
      toast('✅ Reautenticado — intenta de nuevo');
    }catch(e){ toast('❌ Error de autenticación: '+e.message, true); }
    return;
  }
  const name=document.getElementById('um-name').value.trim().toUpperCase();
  const pin=document.getElementById('um-pin').value.trim();
  const role=document.getElementById('um-role').value;
  const station=document.getElementById('um-station').value;
  const active=document.getElementById('um-active').value==='true';
  if(!name){ toast('⚠ Ingresa el nombre del usuario',true); return; }
  if(!pin||pin.length<4){ toast('⚠ PIN mínimo 4 dígitos',true); return; }
  if(!/^\d+$/.test(pin)){ toast('⚠ El PIN solo puede tener números',true); return; }
  // Check for duplicate name (other than self)
  const dup=allUsers.find(u=>u&&u.name&&u.name.toUpperCase()===name&&u.id!==editingUserId);
  if(dup){ toast('⚠ Ya existe un usuario con ese nombre',true); return; }
  // Hash PIN before storing (SHA-256) + keep plain for admin display
  const pinHash=await sha256(pin);
  // Ensure all required fields are present — prevents undefined errors on login
  if(!name||!pin||!role||!station){
    toast('⚠ Faltan datos obligatorios', true); return;
  }
  const data={
    name:name.trim().toUpperCase(),
    pin:pin.trim(),
    pinHash,
    role,
    station,
    active,
    updatedAt:Date.now(),
    updatedBy:currentUserName||'superadmin'
  };
  if(!FB||!FB.USERS){ toast('⚠ Sin conexión',true); return; }
  try{
    if(editingUserId){
      await FB.db.collection(AIRLINE_ID).doc('config').collection('users').doc(editingUserId).update(data);
      toast('✅ Usuario actualizado: '+name);
    } else {
      data.createdAt=Date.now(); data.createdBy=currentUserName;
      const ref=await FB.db.collection(AIRLINE_ID).doc('config').collection('users').add(data);
      console.log('[Users] Creado con ID:', ref.id);
      toast('✅ Usuario creado: '+name+' — PIN: '+pin);
    }
    closeUserModal();
    // Force refresh the list
    setTimeout(()=>renderUsers(), 500);
  }catch(e){
    toast('❌ Error guardando: '+e.message, true);
    console.error('[Users] Save error:',e);
  }
}

async function toggleUserActive(id,active){
  if(!FB||currentRole!=='superadmin') return;
  await FB.db.collection(AIRLINE_ID).doc('config').collection('users').doc(id).update({active});
  toast(active?'✅ Usuario activado':'🚫 Usuario desactivado');
  setTimeout(()=>renderUsers(), 400);
}

async function deleteUser(id,btn){
  if(currentRole!=='superadmin'){ toast('⛔ Solo Bladimir Gomez puede eliminar usuarios',true); return; }
  const u=allUsers.find(x=>x.id===id); if(!u) return;
  if(!confirm(`¿Eliminar usuario ${u.name}?\nEsta acción no se puede deshacer.`)) return;
  if(!FB) return;
  await FB.db.collection(AIRLINE_ID).doc('config').collection('users').doc(id).delete();
  toast('🗑 Usuario eliminado: '+u.name);
  setTimeout(()=>renderUsers(), 400);
}

// ══ GESTIÓN DE BASES / STATIONS ══
async function loadStationsAdmin(){
  const el=document.getElementById('stations-list');
  if(!el) return;
  el.innerHTML='';
  stations.forEach(s=>{
    const chip=document.createElement('div');
    chip.style.cssText='display:inline-flex;align-items:center;gap:6px;background:#fff;border:1.5px solid #bfdbfe;border-radius:20px;padding:5px 12px;font-size:12px;font-weight:600';
    chip.innerHTML=`${s.flag||'🛫'} ${s.code} <span style="font-weight:400;color:#64748b">— ${s.name}</span>
      ${currentRole==='superadmin'&&stations.length>1?`<button onclick="deleteStation('${s.code}')" style="background:none;border:none;cursor:pointer;color:#94a3b8;font-size:14px;margin-left:4px">✕</button>`:''}`;
    el.appendChild(chip);
  });
}

function openAddStation(){
  if(currentRole!=='superadmin'){ toast('⛔ Solo Bladimir puede agregar bases',true); return; }
  if(stations.length >= planCfg().maxBases){ showUpgradeModal('bases'); return; }
  const code=prompt('Código IATA de la nueva base (ej: JFK, MIA, STI):');
  if(!code||code.trim().length<2) return;
  const name=prompt('Nombre completo de la base (ej: New York JFK):');
  if(!name) return;
  const flag=prompt('Emoji de bandera o ícono (ej: 🇺🇸 o 🏙️):') || '🛫';
  addStation(code.trim().toUpperCase(), name.trim(), flag.trim());
}

async function addStation(code, name, flag){
  if(!window.FB) return;
  try{
    await FB.db.collection(AIRLINE_ID).doc('config').collection('stations').doc(code).set({
      code, name, flag, active:true, createdAt:Date.now(), createdBy:currentUserName
    });
    // Also seed techs collection so station works immediately
    await loadStations();
    toast('✅ Base '+code+' — '+name+' agregada');
    loadStationsAdmin();
  }catch(e){ toast('❌ Error: '+e.message,true); }
}

async function deleteStation(code){
  if(stations.length<=1){ toast('⚠ Debe quedar al menos una base',true); return; }
  if(!confirm('¿Eliminar la base '+code+'?\n\nNo se borran los datos históricos, solo deja de aparecer en el selector.')) return;
  try{
    await FB.db.collection(AIRLINE_ID).doc('config').collection('stations').doc(code).delete();
    await loadStations();
    toast('🗑 Base '+code+' eliminada del selector');
    loadStationsAdmin();
  }catch(e){ toast('❌ Error: '+e.message,true); }
}

const TASK_CATALOG_DEFAULT = []; // Vacío — importa tu catálogo desde Excel en la pestaña Catálogo

// ══ CATÁLOGO DE TAREAS ══
let taskCatalog = [];

async function loadTaskCatalog(){
  if(!window.FB) return;
  try{
    const snap = await FB.db.collection(AIRLINE_ID).doc('config').collection('taskCatalog').get();
    taskCatalog = snap.docs.map(d=>({id:d.id,...d.data()}));
    taskCatalog.sort((a,b)=>a.code.localeCompare(b.code));
    buildCatalogDatalist();
  }catch(e){ taskCatalog=[]; console.warn('loadTaskCatalog:',e); }
}

function buildCatalogDatalist(){
  const dl=document.getElementById('task-catalog-datalist');
  if(!dl) return;
  dl.innerHTML='';
  taskCatalog.forEach(t=>{
    const opt=document.createElement('option');
    opt.value=t.code;
    const timeStr=t.estMin>0?' ('+Math.floor(t.estMin/60)+'h'+(t.estMin%60?'+':'')+')':'';
    opt.label=(t.name+timeStr).substring(0,70);
    dl.appendChild(opt);
  });
}

function autoFillTaskName(code){
  const hint=document.getElementById('pm-code-hint');
  const nameEl=document.getElementById('pm-name');
  const estH=document.getElementById('pm-est-h');
  const estM=document.getElementById('pm-est-m');
  const t=taskCatalog.find(t=>t.code===code);
  if(t){
    if(nameEl&&!nameEl.value.trim()) nameEl.value=t.name;
    // Auto-fill time from catalog
    if(t.estMin>0){
      const h=Math.floor(t.estMin/60), m=t.estMin%60;
      if(estH) estH.value=h;
      if(estM) estM.value=m;
      if(hint){
        hint.textContent=t.name+' · '+h+'h '+(m<10?'0':'')+m+'m';
        hint.style.color='#166534';
      }
    } else {
      if(hint){ hint.textContent=t.name; hint.style.color='#166534'; }
    }
  } else {
    if(hint) hint.textContent='';
  }
}

function renderTaskCatalog(){
  const el=document.getElementById('task-catalog-list');
  if(!el) return;
  const q=(document.getElementById('catalog-search').value||'').toLowerCase();
  const filtered=q?taskCatalog.filter(t=>t.code.toLowerCase().includes(q)||t.name.toLowerCase().includes(q)):taskCatalog;
  el.innerHTML='';
  const canEdit=(currentRole==='superadmin'||currentRole==='supervisor'||currentRole==='admin');
  filtered.forEach((t,i)=>{
    const row=document.createElement('div');
    row.style.cssText='display:flex;align-items:center;gap:10px;padding:8px 12px;border-bottom:1px solid #f1f5f9;'+(i%2===0?'background:#fff':'background:#f8fafc');
    const codeSpan=document.createElement('span');
    codeSpan.style.cssText='font-family:monospace;font-size:11px;font-weight:700;color:#0f2a66;flex-shrink:0;width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap';
    codeSpan.textContent=t.code;
    codeSpan.title=t.code;
    const nameSpan=document.createElement('span');
    nameSpan.style.cssText='font-size:11px;color:#374151;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap';
    nameSpan.textContent=t.name;
    nameSpan.title=t.name;
    const timeSpan=document.createElement('span');
    timeSpan.style.cssText='font-size:10px;color:#0f2a66;font-weight:700;flex-shrink:0;min-width:48px;text-align:right';
    if(t.estMin>0){ const h=Math.floor(t.estMin/60),m=t.estMin%60; timeSpan.textContent=h+'h'+(m?m+'m':''); }
    else timeSpan.textContent='—';
    row.appendChild(codeSpan);
    row.appendChild(nameSpan);
    row.appendChild(timeSpan);
    if(canEdit){
      const btn=document.createElement('button');
      btn.className='delbtn';
      btn.title='Eliminar';
      btn.textContent='✕';
      btn.onclick=()=>deleteCatalogTask(t.id,t.code);
      row.appendChild(btn);
    }
    el.appendChild(row);
  });
  const cnt=document.getElementById('catalog-count');
  if(cnt) cnt.textContent=filtered.length+' de '+taskCatalog.length+' tareas';
}

async function addCatalogTask(){
  const codeEl=document.getElementById('catalog-new-code');
  const nameEl=document.getElementById('catalog-new-name');
  const code=(codeEl.value||'').trim().toUpperCase();
  const name=(nameEl.value||'').trim().toUpperCase();
  if(!code||!name){ toast('Ingresa codigo y nombre',true); return; }
  if(taskCatalog.find(t=>t.code===code)){ toast('Ese codigo ya existe',true); return; }
  if(!FB) return;
  const estMinNew=parseInt(document.getElementById('catalog-new-est-h')?.value||0)*60+parseInt(document.getElementById('catalog-new-est-m')?.value||0);
  const ref=await FB.db.collection(AIRLINE_ID).doc('config').collection('taskCatalog').add({code,name,estMin:estMinNew,createdAt:Date.now(),createdBy:currentUserName});
  taskCatalog.push({id:ref.id,code,name});
  taskCatalog.sort((a,b)=>a.code.localeCompare(b.code));
  codeEl.value=''; nameEl.value='';
  buildCatalogDatalist();
  renderTaskCatalog();
  toast('Agregada: '+code);
}

async function deleteCatalogTask(id,code){
  if(!confirm('Eliminar '+code+' del catalogo?')) return;
  if(!FB) return;
  if(id&&!id.startsWith('default_')){
    await FB.db.collection(AIRLINE_ID).doc('config').collection('taskCatalog').doc(id).delete();
  }
  taskCatalog=taskCatalog.filter(t=>t.code!==code);
  buildCatalogDatalist();
  renderTaskCatalog();
  toast('Eliminada: '+code);
}

// ── Importar catálogo desde Excel ────────────────────────────────
let _catalogImportRows = [];

function importCatalogExcel(input){
  const file = input.files[0];
  if(!file){ return; }
  input.value = ''; // reset so same file can be re-selected

  const reader = new FileReader();
  reader.onload = function(e){
    try{
      const wb = XLSX.read(e.target.result, {type:'binary'});
      const ws = wb.Sheets[wb.SheetNames[0]];
      const raw = XLSX.utils.sheet_to_json(ws, {defval:''});

      if(!raw.length){ toast('El archivo está vacío',true); return; }

      // Normalise headers: strip accents, spaces, uppercase
      function norm(s){ return String(s).normalize('NFD').replace(/[̀-ͯ]/g,'').replace(/\s+/g,'_').toUpperCase(); }

      const firstRow = raw[0];
      const headers = Object.keys(firstRow);
      // Find column mappings (flexible naming)
      function findCol(keys, candidates){
        for(const c of candidates){
          const found = keys.find(k=>norm(k)===c);
          if(found) return found;
        }
        return null;
      }
      const colCode = findCol(headers,['CODIGO','CODE','TASK_CODE','TASK','CODIGO_DE_TAREA','TASK_NUMBER']);
      const colName = findCol(headers,['NOMBRE','NAME','DESCRIPTION','DESCRIPCION','TASK_NAME','TASK_DESCRIPTION']);
      const colTime = findCol(headers,['TIEMPO_HORAS','HORAS','HOURS','TIME_HRS','MAN_HOURS','MANHOURS','TIEMPO','HRS','ESTIMATED_HOURS','EST_HOURS']);

      if(!colCode || !colName){
        toast('No se encontraron columnas CODIGO y NOMBRE. Verifica el encabezado del Excel.',true);
        return;
      }

      const rows = [];
      const skipped = [];
      raw.forEach((r,i)=>{
        const code = String(r[colCode]||'').trim().toUpperCase();
        const name = String(r[colName]||'').trim().toUpperCase();
        const rawTime = colTime ? String(r[colTime]||'').trim() : '';
        const hours = parseFloat(rawTime.replace(',','.')) || 0;
        const estMin = Math.round(hours * 60);
        if(!code || !name){ skipped.push(i+2); return; }
        rows.push({code, name, estMin});
      });

      if(!rows.length){ toast('No se encontraron filas válidas con CODIGO y NOMBRE',true); return; }

      _catalogImportRows = rows;

      // Count duplicates
      const dupes = rows.filter(r=>taskCatalog.find(t=>t.code===r.code));

      // Build preview table
      const tbl = document.getElementById('catalog-import-table');
      tbl.innerHTML = `
        <div style="display:grid;grid-template-columns:200px 1fr 70px 60px;gap:0;font-weight:700;color:#1e40af;background:#dbeafe;padding:6px 10px;border-radius:6px 6px 0 0;position:sticky;top:0">
          <span>CÓDIGO</span><span>NOMBRE</span><span style="text-align:center">TIEMPO</span><span style="text-align:center">ESTADO</span>
        </div>
      `;
      rows.forEach(r=>{
        const isDupe = !!taskCatalog.find(t=>t.code===r.code);
        const timeStr = r.estMin>0 ? Math.floor(r.estMin/60)+'h'+(r.estMin%60?(r.estMin%60)+'m':'') : '—';
        const row = document.createElement('div');
        row.style.cssText='display:grid;grid-template-columns:200px 1fr 70px 60px;gap:0;padding:5px 10px;border-bottom:1px solid #dbeafe;'+(isDupe?'background:#fef9c3':'');
        row.innerHTML=`
          <span style="font-family:monospace;font-size:10px;font-weight:700;color:#0f2a66;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${r.code}">${r.code}</span>
          <span style="font-size:10px;color:#374151;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;padding:0 6px" title="${r.name}">${r.name}</span>
          <span style="font-size:10px;text-align:center;color:#0f2a66;font-weight:600">${timeStr}</span>
          <span style="font-size:10px;text-align:center;color:${isDupe?'#b45309':'#166534'}">${isDupe?'⚠ Dup':'✓ Nuevo'}</span>
        `;
        tbl.appendChild(row);
      });

      const cntEl = document.getElementById('catalog-import-count');
      cntEl.textContent = rows.length+' tareas encontradas'+(dupes.length?' ('+dupes.length+' ya existen y se omitirán)':'');

      const warnEl = document.getElementById('catalog-import-warn');
      warnEl.textContent = skipped.length ? '⚠ Filas sin código/nombre omitidas: fila(s) '+skipped.join(', ') : '';

      document.getElementById('catalog-import-preview').style.display='block';

    }catch(err){
      console.error('importCatalogExcel:', err);
      toast('Error al leer el Excel: '+err.message, true);
    }
  };
  reader.readAsBinaryString(file);
}

async function confirmCatalogImport(){
  if(!_catalogImportRows.length) return;
  const newRows = _catalogImportRows.filter(r=>!taskCatalog.find(t=>t.code===r.code));
  if(!newRows.length){ toast('Todas las tareas ya existen en el catálogo'); return; }

  const btn = document.querySelector('#catalog-import-preview .btn-green');
  if(btn){ btn.disabled=true; btn.textContent='Importando…'; }

  try{
    // Firestore batch (max 500 per batch)
    const CHUNK = 400;
    for(let i=0;i<newRows.length;i+=CHUNK){
      const batch = FB.db.batch();
      newRows.slice(i,i+CHUNK).forEach(r=>{
        const ref = FB.db.collection(AIRLINE_ID).doc('config').collection('taskCatalog').doc();
        batch.set(ref,{code:r.code,name:r.name,estMin:r.estMin||0,createdAt:Date.now(),createdBy:currentUserName});
        taskCatalog.push({id:ref.id,...r});
      });
      await batch.commit();
    }
    taskCatalog.sort((a,b)=>a.code.localeCompare(b.code));
    buildCatalogDatalist();
    renderTaskCatalog();
    document.getElementById('catalog-import-preview').style.display='none';
    _catalogImportRows=[];
    toast('✅ '+newRows.length+' tareas importadas al catálogo');
  }catch(err){
    console.error('confirmCatalogImport:',err);
    toast('Error al guardar: '+err.message,true);
    if(btn){ btn.disabled=false; btn.textContent='✅ Importar todo'; }
  }
}

// ══ PLANIFICACIÓN ══
let editingPlanId = null;

// ── Filter WO hint based on aircraft ──
function filterPlanWO(){
  const ac=document.getElementById('pm-ac').value;
  const hint=document.getElementById('pm-wo-hint');
  if(!ac||!hint) return;
  const acTasks=tasks.filter(t=>t.ac===ac);
  if(acTasks.length){
    const wos=[...new Set(acTasks.map(t=>t.wo).filter(Boolean))];
    hint.innerHTML='OTs activas: '+wos.map(w=>`<span style="cursor:pointer;color:#0f2a66;font-weight:600;text-decoration:underline" onclick="document.getElementById('pm-wo').value='${w}'">${w}</span>`).join(' · ');
  } else {
    hint.textContent='Sin OTs activas para esta aeronave';
  }
}

function toggleDeferredFields(){
  const p=document.getElementById('pm-priority').value;
  const wrap=document.getElementById('pm-deferred-wrap');
  if(wrap) wrap.style.display=p==='DEF'?'block':'none';
  if(p==='DEF') calcDeferredDays();
}

function calcDeferredDays(){
  const openVal=document.getElementById('pm-def-open').value;
  const daysVal=parseInt(document.getElementById('pm-def-days').value)||0;
  const statusEl=document.getElementById('pm-def-status');
  if(!openVal||!daysVal||!statusEl) return;
  const openDate=new Date(openVal+'T12:00:00');
  const expDate=new Date(openDate);
  expDate.setDate(expDate.getDate()+daysVal);
  const today=new Date(); today.setHours(12,0,0,0);
  const remaining=Math.round((expDate-today)/(1000*60*60*24));
  const dueDateEl=document.getElementById('pm-due-date');
  if(dueDateEl) dueDateEl.value=localDateStr(expDate);
  if(remaining<0){ statusEl.style.background='#fee2e2'; statusEl.style.color='#b91c1c'; statusEl.textContent='VENCIDO hace '+Math.abs(remaining)+' dia(s)'; }
  else if(remaining<=3){ statusEl.style.background='#fff0e6'; statusEl.style.color='#c2410c'; statusEl.textContent='Vence en '+remaining+' dia(s) — URGENTE'; }
  else if(remaining<=7){ statusEl.style.background='#fffbeb'; statusEl.style.color='#92400e'; statusEl.textContent='Quedan '+remaining+' dias'; }
  else { statusEl.style.background='#f0fdf4'; statusEl.style.color='#166534'; statusEl.textContent='Quedan '+remaining+' dias — OK'; }
}


// ══ MULTI-WO TAG SYSTEM ══
let _woList = []; // current WO list in OT modal

function renderWOTags(){
  const tagsEl = document.getElementById('fm-wo-tags');
  const hiddenEl = document.getElementById('fm-wo');
  if(!tagsEl) return;
  tagsEl.innerHTML = _woList.map((wo,i) => 
    '<span style="display:inline-flex;align-items:center;gap:4px;background:#eff6ff;color:#1e40af;'+
    'padding:4px 10px;border-radius:20px;font-size:12px;font-weight:700;font-family:monospace">'+
    wo+'<button onclick="removeWO('+i+')" style="background:none;border:none;color:#94a3b8;cursor:pointer;'+
    'font-size:12px;line-height:1;padding:0 0 0 2px">✕</button></span>'
  ).join('');
  if(hiddenEl) hiddenEl.value = _woList.join(',');
  syncPlanTasks();
}

function addWOTag(){
  const inp = document.getElementById('fm-wo-input');
  if(!inp) return;
  const val = inp.value.trim().toUpperCase();
  if(!val) return;
  // Add multiple WOs separated by comma or space
  val.split(/[, ]+/).forEach(w => {
    w = w.trim();
    if(w && !_woList.includes(w)) _woList.push(w);
  });
  inp.value = '';
  renderWOTags();
}

function removeWO(idx){
  _woList.splice(idx, 1);
  renderWOTags();
}

function initWOField(woValue){
  _woList = woValue ? woValue.split(',').map(w=>w.trim()).filter(Boolean) : [];
  renderWOTags();
}

function syncPlanTasks(){
  const ac=document.getElementById('fm-ac').value;
  // Load plan tasks for ALL WOs in _woList
  const wrap=document.getElementById('fm-plan-tasks-wrap');
  const listEl=document.getElementById('fm-plan-tasks-list');
  const totalEl=document.getElementById('fm-plan-tasks-total');
  if(!wrap||!listEl||!totalEl) return;
  if(!ac||!_woList.length){
    wrap.style.display='none';
    const emEl=document.getElementById('fm-plan-tasks-empty');
    if(emEl) emEl.textContent='Selecciona aeronave y escribe el WO para ver tareas vinculadas';
    return;
  }
  // Match plan tasks for ANY of the WOs in _woList
  const linked=plans.filter(p=>{
    const pac=(p.ac||'').trim();
    const pwo=(p.wo||'').trim().toUpperCase();
    return pac===ac.trim() && _woList.some(w=>w.trim()===pwo);
  });
  const emptyEl=document.getElementById('fm-plan-tasks-empty');
  if(!linked.length){
    wrap.style.display='none';
    if(emptyEl) emptyEl.style.display='block';
    return;
  }
  wrap.style.display='block';
  if(emptyEl) emptyEl.style.display='none';
  listEl.innerHTML='';
  let totalMin=0;
  // Group tasks by WO when multiple WOs
  let lastWO='';
  linked.sort((a,b)=>(a.wo||'').localeCompare(b.wo||'')).forEach(p=>{
    // Add WO header when WO changes
    if(_woList.length > 1 && p.wo !== lastWO){
      const hdr = document.createElement('div');
      hdr.style.cssText='font-size:10px;font-weight:800;color:#1e40af;background:#eff6ff;padding:3px 8px;border-radius:6px;margin:6px 0 3px;font-family:monospace';
      hdr.textContent = p.wo || '—';
      listEl.appendChild(hdr);
      lastWO = p.wo;
    }
    const chip=document.createElement('span');
    const isDone=p.status==='done';
    chip.className='task-chip '+(p.priority||'P2');
    chip.style.opacity=isDone?'0.5':'1';
    chip.title=isDone?'Completada':'Pendiente';
    const prioIcon={P1:'🔴',P2:'🟡',P3:'🟢',DEF:'⏳'}[p.priority||'P2'];
    const est=p.estMin?fdur(p.estMin):'—';
    const doneTag=isDone?'<span style="color:#166534;font-size:9px"> ✓</span>':'';
    chip.innerHTML=prioIcon+' <strong>'+esc(p.code)+'</strong> '+esc(p.name)+doneTag+' <span style="opacity:.7">· '+est+'</span>';
    listEl.appendChild(chip);
    totalMin+=(p.estMin||0);
  });
  const totalH=Math.floor(totalMin/60), totalM=totalMin%60;
  const doneTasks=linked.filter(p=>p.status==='done');
  const pendTasks=linked.filter(p=>p.status!=='done');
  const pendMin=pendTasks.reduce((a,p)=>a+(p.estMin||0),0);
  // Show exact minutes to help verify
  const h=Math.floor(totalMin/60), m=totalMin%60;
  totalEl.innerHTML='Total '+(_woList.length>1?_woList.length+' WOs':'WO')+': <strong>'+h+'h '+(m<10?'0':'')+m+'m</strong> ('+linked.length+' tareas) · Pendientes: '+fdur(pendMin);
  wrap.dataset.totalMin=totalMin; // store raw minutes to avoid H/M conversion errors
  wrap.dataset.totalH=totalH; wrap.dataset.totalM=totalM;
  wrap.dataset.tasks=JSON.stringify(linked.map(p=>({id:p.id,code:p.code,name:p.name,priority:p.priority,estMin:p.estMin,status:p.status,wo:p.wo})));
}

function applyPlanHours(){
  const wrap=document.getElementById('fm-plan-tasks-wrap');
  if(!wrap) return;
  // Use totalMin directly to avoid H/M rounding errors
  const totalMin=parseInt(wrap.dataset.totalMin)||0;
  const h=Math.floor(totalMin/60), m=totalMin%60;
  document.getElementById('fm-dh').value=h;
  document.getElementById('fm-dm').value=m;
  const lbl=document.getElementById('fm-dur-label');
  if(lbl) lbl.textContent=fdur(h*60+m)||'—';
  const etaTime=document.getElementById('fm-eta').value;
  if(etaTime) document.getElementById('fm-st').value=etaTime;
  updDurPrev(); validateWindow();
  toast('Horas aplicadas: '+fdur(totalMin)+' ('+h+'h '+m+'m)');
}

function buildCatalogDatalist(){
  const dl = document.getElementById('task-catalog-datalist');
  if(!dl) return;
  dl.innerHTML = '';
  taskCatalog.forEach(t=>{
    const opt = document.createElement('option');
    opt.value = t.code;
    opt.label = t.name;
    dl.appendChild(opt);
  });
}

function autoFillTaskName(code){
  const hint = document.getElementById('pm-code-hint');
  const nameEl = document.getElementById('pm-name');
  const t = taskCatalog.find(t=>t.code===code);
  if(t){
    if(nameEl&&!nameEl.value) nameEl.value = t.name;
    if(hint) hint.textContent = t.name;
  } else {
    if(hint) hint.textContent = '';
  }
}

function openPlanModal(id){
  editingPlanId=id;
  const today=localDateStr();
  buildCatalogDatalist();
  const techSel=document.getElementById('pm-tech');
  const doneSel=document.getElementById('pm-done-by');
  [techSel,doneSel].forEach(sel=>{
    if(!sel) return;
    sel.innerHTML='<option value="">— Sin asignar —</option>';
    techs.forEach(t=>{const o=document.createElement('option');o.value=t.id;o.textContent=t.name;sel.appendChild(o);});
  });
  if(id){
    const p=plans.find(x=>x.id===id); if(!p) return;
    document.getElementById('plan-modal-title').textContent='Editar tarea';
    document.getElementById('pm-code').value=p.code||'';
    document.getElementById('pm-name').value=p.name||'';
    document.getElementById('pm-ac').value=p.ac||'';
    document.getElementById('pm-wo').value=p.wo||'';
    document.getElementById('pm-due-date').value=p.dueDate||today;
    document.getElementById('pm-due-time').value=p.dueTime||'23:59';
    document.getElementById('pm-est-h').value=Math.floor((p.estMin||60)/60);
    document.getElementById('pm-est-m').value=(p.estMin||60)%60;
    document.getElementById('pm-tech').value=p.techId||'';
    document.getElementById('pm-priority').value=p.priority||'P2';
    document.getElementById('pm-notes').value=p.notes||'';
    document.getElementById('pm-def-open').value=p.defOpen||today;
    document.getElementById('pm-def-days').value=p.defDays||10;
    document.getElementById('pm-done-by').value=p.doneById||'';
    document.getElementById('pm-done-time').value=p.doneTime||'';
    document.getElementById('pm-unassign-reason').value=p.unassignReason||'';
    document.getElementById('pm-completion-wrap').style.display='block';
    toggleDeferredFields(); filterPlanWO();
  } else {
    document.getElementById('plan-modal-title').textContent='Nueva tarea';
    ['pm-code','pm-name','pm-wo','pm-notes','pm-done-time','pm-unassign-reason'].forEach(id=>{ const el=document.getElementById(id); if(el) el.value=''; });
    document.getElementById('pm-ac').value='';
    document.getElementById('pm-due-date').value=today;
    document.getElementById('pm-due-time').value='23:59';
    document.getElementById('pm-est-h').value=0; document.getElementById('pm-est-m').value=0;
    document.getElementById('pm-tech').value=''; document.getElementById('pm-priority').value='P2';
    document.getElementById('pm-def-open').value=today; document.getElementById('pm-def-days').value=10;
    document.getElementById('pm-deferred-wrap').style.display='none';
    document.getElementById('pm-completion-wrap').style.display='none';
  }
  document.getElementById('modal-plan').classList.add('open');
}

function closePlanModal(){ document.getElementById('modal-plan').classList.remove('open'); editingPlanId=null; }

async function submitPlan(){
  const code=(document.getElementById('pm-code').value||'').trim().toUpperCase();
  const name=(document.getElementById('pm-name').value||'').trim();
  const ac=document.getElementById('pm-ac').value;
  const wo=(document.getElementById('pm-wo').value||'').trim().toUpperCase();
  if(!code||!name){ toast('Codigo y nombre son obligatorios',true); return; }
  if(!ac){ toast('Selecciona la aeronave',true); return; }
  if(!wo){ toast('Ingresa el Work Order (WO)',true); return; }
  const estMin=(parseInt(document.getElementById('pm-est-h').value)||0)*60+(parseInt(document.getElementById('pm-est-m').value)||0);
  const techId=document.getElementById('pm-tech').value;
  const techName=techId?(techs.find(t=>t.id===techId)?.name||''):'';
  const doneById=document.getElementById('pm-done-by').value;
  const doneByName=doneById?(techs.find(t=>t.id===doneById)?.name||''):'';
  const doneTime=document.getElementById('pm-done-time').value;
  const unassignReason=(document.getElementById('pm-unassign-reason').value||'').trim();
  const priority=document.getElementById('pm-priority').value||'P2';
  const defOpen=document.getElementById('pm-def-open').value||'';
  const defDays=parseInt(document.getElementById('pm-def-days').value)||0;
  let defExpiry='';
  if(priority==='DEF'&&defOpen&&defDays){ const exp=new Date(defOpen+'T12:00:00'); exp.setDate(exp.getDate()+defDays); defExpiry=localDateStr(exp); }
  let status='pending';
  if(doneById&&doneTime) status='done';
  else if(unassignReason) status='unassigned';
  const data={code,name,ac,wo,dueDate:document.getElementById('pm-due-date').value,dueTime:document.getElementById('pm-due-time').value,estMin:estMin||60,techId,techName,priority,defOpen,defDays,defExpiry,notes:document.getElementById('pm-notes').value||'',status,doneById,doneByName,doneTime,unassignReason,updatedAt:Date.now(),updatedBy:currentUserName,station:activeStation()};
  if(!FB){ toast('Sin conexion',true); return; }
  if(editingPlanId){
    await FB.db.collection(AIRLINE_ID).doc(activeStation()).collection('plans').doc(editingPlanId).update(data);
    toast('Tarea actualizada: '+code);
  } else {
    data.createdAt=Date.now(); data.createdBy=currentUserName;
    await FB.addDoc(FB.PLANS(window._station),data);
    toast('Tarea creada: '+code);
  }
  closePlanModal();
}

async function deletePlan(id){
  if(!confirm('Eliminar esta tarea?')) return;
  await FB.db.collection(AIRLINE_ID).doc(activeStation()).collection('plans').doc(id).delete();
  toast('Tarea eliminada');
}

function renderPlan(){
  const el=document.getElementById('plan-list');
  if(!el) return;
  const prioFilter=document.getElementById('plan-filter-priority')?.value||'';
  const woFilter=(document.getElementById('plan-filter-wo')?.value||'').trim().toUpperCase();
  const canEdit=(currentRole==='superadmin'||currentRole==='supervisor'||currentRole==='admin');
  const st=activeStation();
  let filtered=plans.filter(p=>!p.station||p.station===st);

  // WO filter: show only tasks for that WO (pending only by default)
  if(woFilter){
    filtered=filtered.filter(p=>(p.wo||'').toUpperCase().includes(woFilter));
    // When WO filtered: show pending + unassigned (hide done unless explicitly selected)
    if(prioFilter!=='done' && prioFilter!=='all'){
      filtered=filtered.filter(p=>p.status!=='done');
      // Always show diferidos even if unassigned
    } else if(prioFilter==='done'){
      filtered=filtered.filter(p=>p.status==='done');
    }
  } else {
    // No WO filter: apply priority/status filter
    if(!prioFilter || prioFilter===''){
      // Default: show pending tasks; always include Diferidos (DEL/MEL/CDL)
      filtered=filtered.filter(p=>{
        if(p.status==='done') return false;
        const pr=(p.priority||'').toUpperCase();
        const isDef = pr==='DEF'||pr==='DIFERIDO'||pr==='MEL'||pr==='CDL';
        if(isDef) return true; // Always show diferidos
        return p.status!=='unassigned';
      });
    } else if(prioFilter==='all'){
      // Show everything
    } else if(prioFilter==='done'){
      filtered=filtered.filter(p=>p.status==='done'||p.status==='unassigned');
    } else {
      // Filter by priority (pending only)
      // For DEF (diferido): show all including unassigned
      if(prioFilter==='DEF'){
        // Match 'DEF', 'diferido', 'Diferido', 'MEL', 'CDL' etc
        filtered=filtered.filter(p=>{
          const pr=(p.priority||'').toUpperCase();
          return (pr==='DEF'||pr==='DIFERIDO'||pr==='MEL'||pr==='CDL')&&p.status!=='done';
        });
      } else {
        filtered=filtered.filter(p=>p.priority===prioFilter&&p.status!=='done'&&p.status!=='unassigned');
      }
    }
  }
  if(!filtered.length){
    el.innerHTML='<div style="text-align:center;padding:32px;color:#94a3b8;font-size:12px">Sin tareas'+((prioFilter||woFilter)?' con ese filtro':'')+'.'+(canEdit?' Clic en + Nueva tarea.':'')+'</div>';
    return;
  }
  const now=new Date();
  el.innerHTML='';
  filtered.forEach(p=>{
    const due=p.dueDate?new Date(p.dueDate+'T'+(p.dueTime||'23:59')):null;
    const isOverdue=due&&due<now&&p.status==='pending';
    const prioColor={P1:'#dc2626',P2:'#f59e0b',P3:'#22c55e',DEF:'#7c3aed'}[p.priority||'P2'];
    const _pr=(p.priority||'P2').toUpperCase();
    const prioLabel=_pr==='P1'?'P1 — Alta':_pr==='P2'?'P2 — Media':_pr==='P3'?'P3 — Baja':
      (_pr==='DEF'||_pr==='DIFERIDO'||_pr==='MEL'||_pr==='CDL')?'⏳ Diferido ('+( p.defType||'MEL')+')'
      :'Pendiente';
    const dueFmt=due?due.toLocaleDateString('es-DO',{weekday:'short',day:'2-digit',month:'short',hour:'2-digit',minute:'2-digit'}):'Sin fecha';
    let defBadge='';
    if(p.priority==='DEF'&&p.defExpiry){
      const exp=new Date(p.defExpiry+'T12:00:00');
      const rem=Math.round((exp-now)/(1000*60*60*24));
      const dc=rem<0?'#b91c1c':rem<=3?'#c2410c':rem<=7?'#92400e':'#166534';
      const db=rem<0?'#fee2e2':rem<=3?'#fff0e6':rem<=7?'#fffbeb':'#f0fdf4';
      defBadge='<span style="background:'+db+';color:'+dc+';font-size:10px;font-weight:700;padding:2px 8px;border-radius:20px">'+(rem<0?'VENCIDO':rem+'d restantes')+'</span>';
    }
    let statusBadge='';
    if(p.status==='done') statusBadge='<span class="plan-status ps-done">Completada</span>';
    else if(p.status==='unassigned') statusBadge='<span class="plan-status ps-unassigned">No realizada</span>';
    else if(isOverdue) statusBadge='<span class="plan-status ps-overdue">Vencida</span>';
    else statusBadge='<span class="plan-status ps-pending">Pendiente</span>';
    const card=document.createElement('div');
    card.className='plan-card '+(p.status==='done'?'done':isOverdue?'overdue':'pending');
    // Build header with createElement to avoid quote issues
    const header=document.createElement('div');
    header.style.cssText='display:flex;align-items:flex-start;justify-content:space-between;gap:8px;margin-bottom:8px;flex-wrap:wrap';
    const leftDiv=document.createElement('div');
    leftDiv.style.cssText='display:flex;align-items:center;gap:6px;flex-wrap:wrap';
    const colorBar=document.createElement('div');
    colorBar.style.cssText='width:4px;height:40px;background:'+prioColor+';border-radius:2px;flex-shrink:0';
    leftDiv.appendChild(colorBar);
    const infoDiv=document.createElement('div');
    // Badges row
    const badgesRow=document.createElement('div');
    badgesRow.style.cssText='display:flex;align-items:center;gap:6px;flex-wrap:wrap';
    const codeEl=document.createElement('span');
    codeEl.className='plan-code'; codeEl.textContent=p.code||'';
    badgesRow.appendChild(codeEl);
    if(p.wo){const w=document.createElement('span');w.style.cssText='font-size:10px;background:#f1f5f9;color:#374151;font-family:monospace;padding:1px 7px;border-radius:10px;font-weight:600';w.textContent=p.wo;badgesRow.appendChild(w);}
    if(p.ac){const a=document.createElement('span');a.style.cssText='font-size:10px;background:#dbeafe;color:#1e40af;padding:1px 7px;border-radius:10px;font-weight:600';a.textContent=p.ac;badgesRow.appendChild(a);}
    const prioEl=document.createElement('span');
    prioEl.style.cssText='background:'+prioColor+'20;color:'+prioColor+';font-size:10px;font-weight:700;padding:1px 8px;border-radius:20px';
    prioEl.textContent=prioLabel; badgesRow.appendChild(prioEl);
    if(defBadge) badgesRow.insertAdjacentHTML('beforeend', defBadge);
    badgesRow.insertAdjacentHTML('beforeend',statusBadge);
    infoDiv.appendChild(badgesRow);
    const nameEl=document.createElement('div');
    nameEl.style.cssText='font-weight:700;font-size:13px;margin-top:3px';
    nameEl.textContent=p.name||'';
    infoDiv.appendChild(nameEl);
    leftDiv.appendChild(infoDiv);
    header.appendChild(leftDiv);
    if(canEdit){
      const btns=document.createElement('div');
      btns.style.cssText='display:flex;gap:6px';
      const eb=document.createElement('button');eb.className='editbtn';eb.innerHTML='✏️';eb.onclick=()=>openPlanModal(p.id);
      const db=document.createElement('button');db.className='delbtn';db.innerHTML='✕';db.onclick=()=>deletePlan(p.id);
      btns.appendChild(eb);btns.appendChild(db);header.appendChild(btns);
    }
    card.appendChild(header);
    const meta=document.createElement('div');
    meta.style.cssText='display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:6px;font-size:11px;margin-bottom:8px';
    meta.innerHTML='<div style="color:#64748b">Vence: <strong>'+dueFmt+'</strong></div><div style="color:#64748b">Estimado: <strong>'+(p.estMin?fdur(p.estMin):'—')+'</strong></div><div style="color:#64748b">Asignado: <strong>'+(p.techName||'Sin asignar')+'</strong></div>';
    card.appendChild(meta);
    if(p.notes){const n=document.createElement('div');n.style.cssText='font-size:11px;color:#64748b;background:#f8fafc;padding:6px 10px;border-radius:6px;margin-bottom:6px';n.textContent=p.notes;card.appendChild(n);}
    if(p.status==='done'){const d=document.createElement('div');d.style.cssText='font-size:11px;background:#dcfce7;border:1px solid #86efac;border-radius:8px;padding:7px 10px';d.innerHTML='Completada por <strong>'+(p.doneByName||p.doneById||'—')+'</strong> a las <strong>'+(p.doneTime||'—')+'</strong>';card.appendChild(d);}
    else if(p.status==='unassigned'&&p.unassignReason){const u=document.createElement('div');u.style.cssText='font-size:11px;background:#fee2e2;border:1px solid #fca5a5;border-radius:8px;padding:7px 10px';u.innerHTML='No realizada: '+esc(p.unassignReason);card.appendChild(u);}
    el.appendChild(card);
  });
}

// ── Mark plan task directly (when not linked to OT via linkedTasks) ──
async function markPlanTaskDone(planId, taskCode){
  if(!FB) return;
  const doneBy=currentUserName||'—';
  const doneAt=new Date().toLocaleTimeString('es-DO',{hour:'2-digit',minute:'2-digit'});
  await FB.db.collection(AIRLINE_ID).doc(activeStation()).collection('plans').doc(planId)
    .update({status:'done',doneByName:doneBy,doneTime:doneAt,updatedAt:Date.now()});
  playSound('delivered');
  toast('Tarea '+taskCode+' completada por '+doneBy);
}

async function markPlanTaskUnassigned(planId, taskCode){
  if(!FB) return;
  const reason=prompt('Motivo de no realizacion de la tarea: '+taskCode);
  if(!reason||!reason.trim()) return;
  await FB.db.collection(AIRLINE_ID).doc(activeStation()).collection('plans').doc(planId)
    .update({status:'unassigned',unassignReason:reason.trim(),unassignedBy:currentUserName,updatedAt:Date.now()});
  toast('Tarea '+taskCode+' marcada como no realizada');
}

async function markTaskDone(taskId,taskIdx,taskCode){
  if(!FB) return;
  const t=tasks.find(x=>x.id===taskId); if(!t) return;
  const doneBy=currentUserName||'—';
  const doneAt=new Date().toLocaleTimeString('es-DO',{hour:'2-digit',minute:'2-digit'});
  const updated=[...(t.linkedTasks||[])];
  updated[taskIdx]={...updated[taskIdx],doneBy,doneAt,doneAt_full:Date.now()};
  await FB.db.collection(AIRLINE_ID).doc(activeStation()).collection('tasks').doc(taskId).update({linkedTasks:updated});
  const linked=plans.find(p=>p.code===taskCode&&p.ac===t.ac&&(p.wo||'').toUpperCase()===(t.wo||'').toUpperCase());
  if(linked) await FB.db.collection(AIRLINE_ID).doc(activeStation()).collection('plans').doc(linked.id).update({status:'done',doneByName:doneBy,doneTime:doneAt,updatedAt:Date.now()});
  playSound('delivered');
  toast('Tarea '+taskCode+' completada por '+doneBy);
}

async function markTaskUnassigned(taskId,taskIdx,taskCode){
  if(!FB) return;
  const reason=prompt('Motivo de no realizacion de la tarea: '+taskCode);
  if(!reason||!reason.trim()) return;
  const t=tasks.find(x=>x.id===taskId); if(!t) return;
  const updated=[...(t.linkedTasks||[])];
  updated[taskIdx]={...updated[taskIdx],unassignReason:reason.trim(),unassignedBy:currentUserName,unassignedAt:Date.now()};
  await FB.db.collection(AIRLINE_ID).doc(activeStation()).collection('tasks').doc(taskId).update({linkedTasks:updated});
  const linked=plans.find(p=>p.code===taskCode&&p.ac===t.ac&&(p.wo||'').toUpperCase()===(t.wo||'').toUpperCase());
  if(linked) await FB.db.collection(AIRLINE_ID).doc(activeStation()).collection('plans').doc(linked.id).update({status:'unassigned',unassignReason:reason.trim(),updatedAt:Date.now()});
  toast('Tarea '+taskCode+' marcada como no realizada');
}

function initPlanTab(){
  const tab=document.getElementById('TAB-plan');
  if(tab) tab.style.display='';
  const catTab=document.getElementById('TAB-catalog');
  if(catTab){
    const canSee=(currentRole==='superadmin'||currentRole==='supervisor'||currentRole==='admin'||currentRole==='mcc');
    catTab.style.display=canSee?'':'none';
  }
  // Show/hide add form in catalog
  const addWrap=document.getElementById('catalog-add-wrap');
  if(addWrap){
    const canEdit=(currentRole==='superadmin'||currentRole==='supervisor'||currentRole==='admin');
    addWrap.style.display=canEdit?'block':'none';
  }
  // Show aircraft add button for superadmin
  const acAddWrap=document.getElementById('aircraft-add-wrap');
  if(acAddWrap) acAddWrap.style.display=currentRole==='superadmin'?'block':'none';
  // Render aircraft list when tab loads
  renderAircraftManager();
  const btnAddPlan=document.getElementById('btn-add-plan');
  if(btnAddPlan){
    const canEdit=(currentRole==='superadmin'||currentRole==='supervisor'||currentRole==='admin');
    btnAddPlan.style.display=canEdit?'flex':'none';
  }
}


// ══ HORARIOS ══
let scheduleData = {}; // { 'YYYY-MM': { station: 'PUJ', personnel: [...] } }

const SHIFT_DEF = {
  A:  {label:'A',  s:300,  e:840,  bg:'#dbeafe',clr:'#1e40af'},
  AF: {label:'AF', s:300,  e:840,  bg:'#dbeafe',clr:'#1e40af'},
  AA: {label:'AA', s:300,  e:840,  bg:'#dbeafe',clr:'#1e40af'},
  B:  {label:'B',  s:780,  e:1320, bg:'#fef9c3',clr:'#92400e'},
  BF: {label:'BF', s:780,  e:1320, bg:'#fef9c3',clr:'#92400e'},
  BA: {label:'BA', s:780,  e:1320, bg:'#fef9c3',clr:'#92400e'},
  C:  {label:'C',  s:1260, e:360,  bg:'#f3e8ff',clr:'#6b21a8'},  // overnight
  CF: {label:'CF', s:1260, e:360,  bg:'#f3e8ff',clr:'#6b21a8'},
  CA: {label:'CA', s:1260, e:360,  bg:'#f3e8ff',clr:'#6b21a8'},
  ADM:{label:'ADM',s:480,  e:1020, bg:'#dcfce7',clr:'#166534'},
};
const SHIFT_WORKING = new Set(['A','AF','AA','B','BF','BA','C','CF','CA','ADM']);

async function loadSchedule(month, station){
  const key = month+'-'+station;
  if(scheduleData[key]) return scheduleData[key];
  try {
    const snap = await FB.db.collection(AIRLINE_ID).doc(station)
      .collection('schedules').doc(month).get();
    if(snap.exists) scheduleData[key] = snap.data();
    else scheduleData[key] = null;
  } catch(e) { scheduleData[key] = null; }
  return scheduleData[key];
}

async function saveScheduleToFirestore(){
  const month = document.getElementById('schedule-month').value;
  const station = document.getElementById('schedule-station').value;
  if(!month || !station){ toast('Selecciona mes y base',true); return; }
  const key = month+'-'+station;
  if(!scheduleData[key]){ toast('No hay datos para guardar',true); return; }
  try {
    await FB.db.collection(AIRLINE_ID).doc(station)
      .collection('schedules').doc(month).set(scheduleData[key]);
    toast('✅ Horario guardado en Firestore');
  } catch(e){ toast('❌ Error: '+e.message, true); }
}

async function renderScheduleView(){
  const wrap = document.getElementById('schedule-table-wrap');
  const loading = document.getElementById('schedule-loading');
  if(!wrap) return;
  let month = document.getElementById('schedule-month')?.value;
  const station = document.getElementById('schedule-station')?.value || activeStation();
  if(!month){
    const now = new Date();
    month = now.getFullYear()+'-'+String(now.getMonth()+1).padStart(2,'0');
    const mEl = document.getElementById('schedule-month');
    if(mEl) mEl.value = month;
  }
  if(loading) loading.textContent = 'Cargando horario...';
  const data = await loadSchedule(month, station);
  if(!data || !data.personnel || !data.personnel.length){
    wrap.innerHTML = '<div style="padding:32px;text-align:center;color:#94a3b8;font-size:12px">No hay horario cargado para este mes.<br><small>Importa el archivo Excel del roll de turnos.</small></div>';
    return;
  }
  wrap.innerHTML = ''; // clear loading message
  // Build table
  const [y, m] = month.split('-').map(Number);
  const daysInMonth = new Date(y, m, 0).getDate();
  const today = new Date();
  const todayDay = (today.getFullYear()===y && today.getMonth()+1===m) ? today.getDate() : 0;
  document.getElementById('schedule-subtitle').textContent =
    station + ' · ' + new Date(y,m-1,1).toLocaleDateString('es-DO',{month:'long',year:'numeric'}) +
    ' · ' + data.personnel.length + ' personas';
  // Apply filters
  const filterShift = document.getElementById('schedule-filter-shift')?.value || '';
  const filterToday = document.getElementById('schedule-filter-today')?.checked || false;
  const filterDateEl = document.getElementById('schedule-filter-date');
  const filterDate = filterDateEl?.value || '';

  // Determine which day to highlight/filter
  let filterDay = 0;
  if(filterToday && todayDay) {
    filterDay = todayDay;
    if(filterDateEl) filterDateEl.value = '';
  } else if(filterDate) {
    const fd = new Date(filterDate+'T12:00:00');
    if(fd.getFullYear()===y && fd.getMonth()+1===m) filterDay = fd.getDate();
  }

  // Filter personnel
  let filteredPersonnel = data.personnel.filter(p => {
    // Filter by shift base
    if(filterShift && p.shiftBase !== filterShift) return false;
    // Filter by working on specific day
    if(filterDay > 0){
      const day = p.schedule?.[String(filterDay)];
      if(!day || !day.working) return false;
    }
    return true;
  });

  const filterActive = filterShift || filterDay > 0;
  const filterLabel = filterDay > 0
    ? ` · <span style="color:#22c55e;font-weight:700">${filteredPersonnel.length} en turno ${filterDay>0?'el día '+filterDay:''}</span>`
    : '';
  document.getElementById('schedule-subtitle').innerHTML =
    station + ' · ' + new Date(y,m-1,1).toLocaleDateString('es-DO',{month:'long',year:'numeric'}) +
    ' · ' + filteredPersonnel.length + (filterActive?' personas (filtrado)':' personas') + filterLabel;

  let html = '<table style="border-collapse:collapse;width:100%;font-size:11px;min-width:900px">';
  // Header — show all days or only the filtered day
  html += '<thead><tr>';
  html += '<th style="text-align:left;padding:6px 8px;background:#0f2a66;color:#fff;border-radius:6px 0 0 0;white-space:nowrap;min-width:180px;position:sticky;left:0;z-index:2">Nombre</th>';
  html += '<th style="padding:4px 6px;background:#0f2a66;color:#fff;white-space:nowrap">Cargo</th>';
  html += '<th style="padding:4px 6px;background:#0f2a66;color:#fff">Turno</th>';
  // If filtering by day, show single day column prominently; else all days
  const showDays = filterDay > 0 ? [filterDay] : Array.from({length:daysInMonth},(_,i)=>i+1);
  showDays.forEach(d => {
    const isToday = d===todayDay;
    const isFilter = d===filterDay;
    html += `<th style="padding:4px 3px;background:${isFilter?'#22c55e':isToday?'#dc2626':'#0f2a66'};color:#fff;min-width:${isFilter?'60px':'28px'};text-align:center">${d}${isFilter?' ✓':''}</th>`;
  });
  html += '</tr></thead><tbody>';
  // Group by shift
  const shifts = ['A','B','C','ADM'];
  const grouped = {};
  filteredPersonnel.forEach(p => {
    const base = p.shiftBase || 'X';
    const key = shifts.includes(base) ? base : 'X';
    if(!grouped[key]) grouped[key] = [];
    grouped[key].push(p);
  });
  shifts.forEach(sh => {
    if(!grouped[sh]) return;
    html += `<tr><td colspan="${daysInMonth+3}" style="background:#f1f5f9;padding:4px 8px;font-weight:700;font-size:10px;color:#0f2a66;position:sticky;left:0">Turno ${sh} · ${grouped[sh].length} personas</td></tr>`;
    grouped[sh].forEach((p, idx) => {
      const bg = idx%2===0?'#fff':'#f8fafc';
      html += `<tr style="background:${bg}">`;
      html += `<td style="padding:5px 8px;font-weight:600;white-space:nowrap;position:sticky;left:0;background:${bg};border-right:1px solid #e2e8f0">${esc(p.name)}</td>`;
      html += `<td style="padding:4px 6px;color:#64748b;white-space:nowrap;font-size:10px">${esc(p.role)}</td>`;
      html += `<td style="padding:4px 6px;text-align:center;font-weight:700;color:#0f2a66">${p.shiftBase}</td>`;
      showDays.forEach(d => {
        const day = p.schedule?.[String(d)];
        const code = day?.code || '';
        const sd = SHIFT_DEF[code];
        const isWork = SHIFT_WORKING.has(code);
        const isToday = d===todayDay;
        const isFilter = d===filterDay;
        const cellBg = isFilter
          ? (isWork ? sd?.bg||'#dcfce7' : '#fee2e2')
          : isToday ? (isWork ? sd?.bg||'#e0f2fe' : '#fef2f2')
          : (isWork ? sd?.bg||'#f0fdf4' : (code ? '#f8fafc' : '#fff'));
        const cellClr = sd?.clr || (code ? '#64748b' : '#cbd5e1');
        const cellPad = isFilter ? '5px 4px' : '3px 2px';
        html += `<td style="text-align:center;padding:${cellPad};background:${cellBg};color:${cellClr};font-weight:600;font-size:${isFilter?'11px':'9px'};border:1px solid #f1f5f9">${code||''}</td>`;
      });
      html += '</tr>';
    });
  });
  html += '</tbody></table>';
  wrap.innerHTML = html;
}

// ── Import Excel schedule ──
async function importScheduleExcel(input){
  const file = input.files[0];
  if(!file) return;
  const month = document.getElementById('schedule-month').value;
  const station = document.getElementById('schedule-station').value;
  if(!month || !station){ toast('Selecciona mes y base primero',true); return; }

  // Load SheetJS dynamically if not present
  const doImport = () => new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = e => {
      try {
        const data = new Uint8Array(e.target.result);
        const wb = XLSX.read(data, {type:'array'});
        const ws = wb.Sheets[wb.SheetNames[0]];
        const rows = XLSX.utils.sheet_to_json(ws, {header:1, defval:null});
        resolve(rows);
      } catch(err){ reject(err); }
    };
    reader.onerror = reject;
    reader.readAsArrayBuffer(file);
  });

  const run = async () => {
    try {
      const rows = await doImport();
      const personnel = parseScheduleRows(rows);
      if(!personnel.length){ toast('❌ No se encontró personal en el archivo',true); return; }
      const key = month+'-'+station;
      scheduleData[key] = {month, station, personnel, importedAt: new Date().toISOString()};
      // Force re-render: temporarily clear the key from Firestore cache check
      await renderScheduleView();
      toast('✅ '+personnel.length+' personas importadas. Clic en 💾 Guardar para persistir en Firestore.');
    } catch(err){
      console.error('Import error:', err);
      toast('❌ Error: '+err.message, true);
    }
  };

  if(typeof XLSX === 'undefined'){
    toast('Cargando librería Excel...', true);
    const s = document.createElement('script');
    s.src = 'https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js';
    s.onload = () => run();
    s.onerror = () => toast('❌ No se pudo cargar SheetJS. Verifica tu conexión.',true);
    document.head.appendChild(s);
  } else {
    run();
  }
  input.value = '';
}

function parseScheduleRows(rows){
  const SHIFT_HOURS = {
    A:{s:'05:00',e:'14:00'}, AF:{s:'05:00',e:'14:00'}, AA:{s:'05:00',e:'14:00'},
    B:{s:'13:00',e:'22:00'}, BF:{s:'13:00',e:'22:00'}, BA:{s:'13:00',e:'22:00'},
    C:{s:'21:00',e:'06:00'}, CF:{s:'21:00',e:'06:00'}, CA:{s:'21:00',e:'06:00'},
    ADM:{s:'08:00',e:'17:00'},
  };
  const WORK_CODES = new Set(Object.keys(SHIFT_HOURS));
  let headerIdx = rows.findIndex(r => r[0]==='Nombre');
  if(headerIdx<0) headerIdx = 8;
  const personnel = [];
  for(let i=headerIdx+1; i<rows.length; i++){
    const row = rows[i];
    const name = row[0];
    if(!name || name==='Nombre') continue;
    const role = row[1]||'';
    const shiftRaw = String(row[5]||'').replace('Turno:','').trim();
    const days = row.slice(6, 37);
    const schedule = {};
    days.forEach((code, idx) => {
      if(!code) return;
      const c = String(code).trim().toUpperCase();
      const sh = SHIFT_HOURS[c];
      schedule[String(idx+1)] = {code:c, working:WORK_CODES.has(c), start:sh?.s||null, end:sh?.e||null};
    });
    personnel.push({name:String(name).trim(), role:String(role).trim(), shiftBase:shiftRaw, schedule});
  }
  return personnel;
}

// ── isOnShift: check if tech is working on a given date and time range ──
// Used by auto-assign to only pick techs who are on shift
function isOnShift(techName, dateStr, startMins, endMins){
  const [y, m, d] = dateStr.split('-').map(Number);
  const monthKey = y+'-'+String(m).padStart(2,'0');
  const station = activeStation();
  const key = monthKey+'-'+station;
  const data = scheduleData[key];
  if(!data || !data.personnel) return true; // no schedule = assume available
  const person = data.personnel.find(p => {
    const pn = p.name.toUpperCase().trim();
    const tn = techName.toUpperCase().trim();
    return pn === tn || pn.includes(tn) || tn.includes(pn);
  });
  if(!person) return true; // person not in schedule = assume available
  const day = person.schedule?.[String(d)];
  if(!day || !day.working) return false; // day off
  const sd = SHIFT_DEF[day.code];
  if(!sd) return false;
  // Check overlap: tech shift [sd.s, sd.e] overlaps with task [startMins, endMins]
  const ts = sd.s, te = sd.s > sd.e ? sd.e + 1440 : sd.e; // handle overnight
  const as = startMins, ae = endMins > startMins ? endMins : endMins + 1440;
  return as < te && ae > ts;
}


// ══ EXCEL ══
function xlC(v){return`<Cell><Data ss:Type="String">${esc(String(v??''))}</Data></Cell>`;}
function xlN(v){return`<Cell><Data ss:Type="Number">${isNaN(Number(v))?0:Number(v)}</Data></Cell>`;}
function mkSheet(name,rows){let x=`<Worksheet ss:Name="${esc(name)}"><Table>\n`;rows.forEach(r=>{x+=`<Row>${r.map(c=>typeof c==='number'?xlN(c):xlC(c)).join('')}</Row>\n`;});return x+'</Table></Worksheet>\n';}
// ══ MCC MULTI-BASE ══
let mccStationData={};
let mccUnsubs=[];

function initMCC(){
  mccUnsubs.forEach(u=>{try{u();}catch(_){}});
  mccUnsubs=[];
  mccStationData={};
  stations.forEach(st=>{
    mccStationData[st.code]={tasks:[],reports:[],techs:[]};
    const refresh=()=>{if(document.getElementById('VIEW-mcc')?.classList.contains('on'))renderMCC();};
    mccUnsubs.push(FB.onSnapshot(FB.TASKS(st.code),snap=>{mccStationData[st.code].tasks=snap.docs.map(d=>({id:d.id,...d.data()}));refresh();}));
    mccUnsubs.push(FB.onSnapshot(FB.REPORTS(st.code),snap=>{mccStationData[st.code].reports=snap.docs.map(d=>({id:d.id,...d.data()})).filter(r=>!r.resolved);refresh();}));
    mccUnsubs.push(FB.onSnapshot(FB.TECHS(st.code),snap=>{mccStationData[st.code].techs=snap.docs.map(d=>({id:d.id,...d.data()}));refresh();}));
  });
}

let mccSelectedDate = localDateStr(); // separate date for MCC view

function mccDateChanged(){
  const el=document.getElementById('mcc-date-filter');
  if(el&&el.value) mccSelectedDate=el.value;
  renderMCC();
}

function mccChangeDay(offset){
  if(offset===0){ mccSelectedDate=localDateStr(); }
  else {
    const d=new Date(mccSelectedDate+'T12:00:00');
    d.setDate(d.getDate()+offset);
    mccSelectedDate=localDateStr(d);
  }
  const el=document.getElementById('mcc-date-filter');
  if(el) el.value=mccSelectedDate;
  // Also sync Gantt date
  selectedDate=mccSelectedDate;
  const ganttDateEl=document.getElementById('date-filter');
  if(ganttDateEl) ganttDateEl.value=selectedDate;
  kpis();
  renderMCC();
}

function renderMCC(){
  // Sync date with Gantt if MCC date not manually set
  if(!document.getElementById('mcc-date-filter')?.value) mccSelectedDate=selectedDate||localDateStr();
  // Sync date input
  const dateEl=document.getElementById('mcc-date-filter');
  if(dateEl&&!dateEl.value) dateEl.value=mccSelectedDate;
  const upd=document.getElementById('mcc-last-update');
  if(upd) upd.textContent='Actualizado: '+new Date().toLocaleTimeString('es-DO',{hour:'2-digit',minute:'2-digit'});
  renderMCCStations();
  renderMCCPilotMessages();
}

function renderMCCStations(){
  const grid=document.getElementById('mcc-stations-grid');
  if(!grid) return;
  grid.innerHTML='';
  const todayStr=localDateStr(new Date());
  const mccDate=mccSelectedDate||selectedDate||todayStr;
  const nowMins=new Date().getHours()*60+new Date().getMinutes();
  const isHistorical = mccDate < todayStr;

  stations.forEach(st=>{
    const _mccData=mccStationData[st.code]||{tasks:[],reports:[],techs:[]};
    const allTasks=[..._mccData.tasks];
    const allReports=[..._mccData.reports];
    const d={tasks:allTasks,reports:allReports,techs:_mccData.techs};

    // ── todayTasks: tasks for the selected date ──
    const todayTasks=d.tasks.filter(t=>{
      if(t.taskDate===mccDate) return true;
      // Carry-over multi-day
      if(t.taskDays>0){
        const base=new Date(t.taskDate+'T12:00:00');
        const sel=new Date(mccDate+'T12:00:00');
        const diff=Math.round((sel-base)/(1000*60*60*24));
        return diff>0 && diff<=t.taskDays;
      }
      return false;
    });

    // ── AOG history: AOG tasks that were active on mccDate ──
    // An AOG is "active on a date" if: taskDate <= mccDate AND (not delivered OR delivered after mccDate)
    const aogHistorical=d.tasks.filter(t=>{
      if(!t.aog) return false;
      if(t.taskDate > mccDate) return false; // future AOG
      // If already in todayTasks, don't duplicate
      if(t.taskDate===mccDate) return false;
      return true; // AOG from a previous date still active
    });

    // ── Sort: AOG first, then by ETD ──
    const allVisible=[...todayTasks, ...aogHistorical];
    allVisible.sort((a,b)=>{
      if(a.aog && !b.aog) return -1;
      if(!a.aog && b.aog) return 1;
      return (a.ge||0)-(b.ge||0);
    });

    const anomalies=d.reports.filter(r=>r.type!=='pilot'&&!r.resolved&&(r.dateStr===mccDate||!r.dateStr));
    const pilotMsgs=d.reports.filter(r=>r.type==='pilot'&&!r.resolved);

    const getEtdDate=t=>{
      if(!t.taskDays||t.taskDays===0) return t.taskDate;
      const base=new Date(t.taskDate+'T12:00:00');
      base.setDate(base.getDate()+(t.taskDays||0));
      return localDateStr(base);
    };

    // OTP only from today's tasks (not AOG, not historical)
    const dueTasks=todayTasks.filter(t=>{
      if(t.aog) return false;
      const etd=getEtdDate(t);
      if(etd>todayStr) return false;
      if(etd<todayStr) return true;
      return (t.ge||0)<=nowMins;
    });

    // Calculate OTP properly: on-time = entregada AND NOT late
    const entregadas=dueTasks.filter(t=>t.status==='entregada').length;
    // Check if task was delivered late (deliveredAt > ETD)
    const isTaskLate = (t) => {
      if(t.status!=='entregada'||!t.deliveredAt||!t.ge) return false;
      const m=t.deliveredAt.match(/([0-9]{1,2}):([0-9]{2})(?:[ ]*([ap][.]?[ ]*m[.]?))?/i);
      if(!m) return false;
      let h=parseInt(m[1]),mn=parseInt(m[2]);
      if(m[3]&&/p/i.test(m[3])&&h!==12) h+=12;
      if(m[3]&&!/p/i.test(m[3])&&h===12) h=0;
      return (h*60+mn) > t.ge;
    };
    const demorasList = dueTasks.filter(t=>isTaskLate(t));
    const demorCount = demorasList.length;
    const onTime = entregadas - demorCount; // entregadas on time
    const aogList=d.tasks.filter(t=>!!t.aog && t.taskDate<=mccDate);
    // OTP = on-time deliveries / total due tasks
    const otp=dueTasks.length>0?Math.round((onTime/dueTasks.length)*100):100;
    const hasAlert=anomalies.length>0;
    const hasAOG=aogList.length>0;
    const otpColor=otp>=85?'#22c55e':otp>=70?'#f59e0b':'#ef4444';

    const card=document.createElement('div');
    const cardBorder=hasAOG?'#be185d':hasAlert?'#fca5a5':'#e2e8f0';
    card.style.cssText=`background:#fff;border-radius:14px;padding:18px;border:2px solid ${cardBorder};box-shadow:0 2px 12px rgba(0,0,0,.07)`;

    // Build rows
    const taskRowsHtml=allVisible.map(t=>{
      const etdT=getEtdDate(t);
      const etdPassed=etdT<todayStr||(etdT===todayStr&&(t.ge||0)<=nowMins);
      const isAOG=!!t.aog;
      const isEntregada=t.status==='entregada'&&!isAOG;
      const isReported=t.status==='reported';
      const isLate=etdPassed&&!isEntregada&&!isAOG&&!isHistorical;
      const isHistRow=t.taskDate!==mccDate; // from different date (historical)
      let stBg,stClr,stLabel;
      if(isAOG&&isEntregada){stBg='#6b7280';stClr='#fff';stLabel='🔓 AOG Liberado';}
      else if(isAOG){stBg='#9d174d';stClr='#fff';stLabel='🚨 AOG';}
      else if(isEntregada){stBg='#dcfce7';stClr='#166534';stLabel='✅ Entregada';}
      else if(isReported){stBg='#fee2e2';stClr='#dc2626';stLabel='⚠ Reportada';}
      else if(isLate){stBg='#fef9c3';stClr='#92400e';stLabel='⏰ Retraso';}
      else{stBg='#f1f5f9';stClr='#64748b';stLabel='En trabajo';}
      const hasCmt=!!(t.comments&&t.comments.trim());
      const histLabel=isHistRow?`<span style="font-size:8px;color:#94a3b8;background:#f1f5f9;padding:1px 5px;border-radius:4px">${t.taskDate}</span>`:'';
      const showCdw=!isHistorical&&!isAOG&&!isEntregada&&t.ge!=null&&t.ge>nowMins&&mccDate===todayStr;
      const cdwId=`cdw-${t.id.replace(/\W/g,'')}`;
      const cdwHtml=showCdw?`<span id="${cdwId}" data-cdw-ge="${t.ge}" style="font-size:9px;font-weight:700;padding:2px 7px;border-radius:10px;white-space:nowrap;cursor:default;background:#dbeafe;color:#1e40af">⏱ --:--</span>`:'';
      return `<div style="padding:7px 0;border-top:1px solid #f1f5f9${isHistRow?';opacity:.85':''}">
        <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap">
          <span style="font-weight:800;color:#0f2a66;min-width:56px;font-size:12px">${esc(t.ac)}</span>
          <span style="color:#94a3b8;font-size:10px">${hhmm(t.gs)}→${hhmm(t.ge)}</span>
          <span style="font-size:9px;color:#94a3b8">${esc(t.wo||'')}</span>
          ${histLabel}
          ${cdwHtml}
          <span style="margin-left:auto;background:${stBg};color:${stClr};padding:2px 8px;border-radius:10px;font-weight:700;font-size:10px;white-space:nowrap">${stLabel}</span>
        </div>
        ${hasCmt?`<div style="margin-top:4px;padding:4px 8px;background:#fffbeb;border-radius:6px;border-left:2px solid #f59e0b;font-size:10px;color:#92400e;line-height:1.4">💬 ${esc(t.comments)}</div>`:''}
      </div>`;
    }).join('');

    const aogBanner=hasAOG?`<div style="background:#9d174d;color:#fff;border-radius:8px;padding:8px 12px;margin-bottom:10px;font-size:11px;font-weight:700">
      🚨 AOG: ${aogList.map(t=>esc(t.ac)).join(', ')}
    </div>`:'';;

    const headerBadges=
      (hasAOG?`<span style="background:#9d174d;color:#fff;font-size:10px;font-weight:800;padding:4px 10px;border-radius:20px">🚨 ${aogList.length} AOG</span>`:'')+
      (hasAlert?`<span style="background:#fee2e2;color:#dc2626;font-size:10px;font-weight:800;padding:4px 10px;border-radius:20px">⚠ ${anomalies.length} alerta</span>`:'')+
      (!hasAOG&&!hasAlert?`<span style="background:#dcfce7;color:#166534;font-size:10px;font-weight:700;padding:4px 10px;border-radius:20px">✅ Normal</span>`:'');

    card.innerHTML=`
      <div style="display:flex;align-items:flex-start;justify-content:space-between;margin-bottom:12px">
        <div style="display:flex;align-items:center;gap:10px">
          <span style="font-size:26px">${st.flag||'🏢'}</span>
          <div>
            <div style="font-size:17px;font-weight:900;color:#0f2a66">${st.code}</div>
            <div style="font-size:10px;color:#94a3b8">${st.name||''}</div>
          </div>
        </div>
        <div style="display:flex;gap:6px;flex-wrap:wrap">${headerBadges}</div>
      </div>
      <div style="display:grid;grid-template-columns:repeat(6,1fr);gap:5px;margin-bottom:12px">
        <div style="text-align:center;background:#f8fafc;border-radius:10px;padding:8px 4px">
          <div style="font-size:20px;font-weight:900;color:#0f2a66">${todayTasks.length}</div>
          <div style="font-size:9px;color:#94a3b8">OTs</div>
        </div>
        <div style="text-align:center;background:#dcfce7;border-radius:10px;padding:8px 4px">
          <div style="font-size:20px;font-weight:900;color:#166534">${entregadas}</div>
          <div style="font-size:9px;color:#166534">✓ Entregadas</div>
        </div>
        <div style="text-align:center;background:${demorCount>0?'#fef2f2':'#f8fafc'};border-radius:10px;padding:8px 4px">
          <div style="font-size:20px;font-weight:900;color:${demorCount>0?'#dc2626':'#94a3b8'}">${demorCount}</div>
          <div style="font-size:9px;color:${demorCount>0?'#dc2626':'#94a3b8'}">⏰ Demoras</div>
        </div>
        <div style="text-align:center;background:#f8fafc;border-radius:10px;padding:8px 4px">
          <div style="font-size:20px;font-weight:900;color:${otpColor}">${otp}%</div>
          <div style="font-size:9px;color:#94a3b8">OTP</div>
        </div>
        <div style="text-align:center;background:${hasAOG?'#fce7f3':'#f8fafc'};border-radius:10px;padding:8px 4px">
          <div style="font-size:20px;font-weight:900;color:${hasAOG?'#9d174d':'#94a3b8'}">${aogList.length}</div>
          <div style="font-size:9px;color:#94a3b8">AOG</div>
        </div>
        <div style="text-align:center;background:#f8fafc;border-radius:10px;padding:8px 4px">
          <div style="font-size:20px;font-weight:900;color:#7c3aed">${d.techs.length}</div>
          <div style="font-size:9px;color:#94a3b8">Técnicos</div>
        </div>
      </div>
      ${aogBanner}
      ${pilotMsgs.length?`<div style="background:#eff6ff;border-radius:8px;padding:7px 12px;font-size:10px;color:#1e40af;margin-bottom:10px;font-weight:600">📡 ${pilotMsgs.length} mensaje${pilotMsgs.length>1?'s':''} de piloto</div>`:''}
      <div>${allVisible.length?taskRowsHtml:'<div style="font-size:11px;color:#cbd5e1;text-align:center;padding:12px">Sin operaciones registradas</div>'}</div>
    `;
    grid.appendChild(card);
  });
}


function renderMCCPilotMessages(){
  const wrap=document.getElementById('mcc-pilot-messages');
  const countEl=document.getElementById('mcc-pilot-count');
  if(!wrap) return;

  const all=[];
  stations.forEach(st=>{
    const d=mccStationData[st.code]||{reports:[]};
    d.reports.filter(r=>!r.resolved&&(r.type==='pilot'||r.type==='anomaly')).forEach(r=>all.push({...r,_st:st.code,_flag:st.flag||'🛫'}));
  });
  all.sort((a,b)=>(b.timestamp||0)-(a.timestamp||0));

  if(countEl) countEl.textContent=all.length+' pendiente'+(all.length!==1?'s':'');

  if(!all.length){
    wrap.innerHTML='<div style="text-align:center;padding:28px;color:#cbd5e1;font-size:13px">✅ Sin reportes pendientes</div>';
    return;
  }

  wrap.innerHTML=all.map(r=>{
    const isPilot=r.type==='pilot';
    const borderCol=isPilot?'#3b82f6':'#dc2626';
    const typeBadge=isPilot
      ?'<span style="background:#f0fdf4;color:#166534;font-size:9px;font-weight:700;padding:2px 8px;border-radius:10px">📡 PILOTO</span>'
      :'<span style="background:#fee2e2;color:#dc2626;font-size:9px;font-weight:700;padding:2px 8px;border-radius:10px">🔧 ANOMALÍA</span>';
    const reporterIcon=isPilot?'👨‍✈️':'👷';
    const _al=(window._airlineName||'AirTech Assist').toUpperCase();
    const waText=encodeURIComponent(`${isPilot?`📡 ${_al} — Mensaje de Piloto`:`🔧 ${_al} — Anomalía Técnica`}\n✈ ${r.ac||'—'} · ${r._st} · ${r.timeStr||'—'}\n${reporterIcon} ${r.reportedBy||'—'}:\n${r.message||'—'}`);
    return `<div style="background:#f8fafc;border-radius:10px;padding:14px;margin-bottom:10px;border-left:4px solid ${borderCol}">
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px;flex-wrap:wrap">
        <span style="font-size:16px">${r._flag}</span>
        <span style="font-weight:800;font-size:14px;color:#0f2a66">${esc(r.ac||'—')}</span>
        <span style="background:#dbeafe;color:#1e40af;font-size:9px;font-weight:700;padding:2px 8px;border-radius:10px">${r._st}</span>
        ${typeBadge}
        <span style="font-size:10px;color:#94a3b8">${r.timeStr||'—'} · ${r.dateStr||'—'}</span>
        <span style="margin-left:auto;font-size:11px;font-weight:600;color:#374151">${reporterIcon} ${esc(r.reportedBy||'—')}</span>
      </div>
      <div style="font-size:13px;color:#1e293b;line-height:1.6;margin-bottom:10px;background:#fff;padding:10px 12px;border-radius:8px">${esc(r.message||'')}</div>
      ${r.photoUrl?`<div style="margin-bottom:10px"><a href="${r.photoUrl}" target="_blank" rel="noopener"><img src="${r.photoUrl}" style="max-width:180px;max-height:120px;border-radius:8px;border:2px solid #e2e8f0;object-fit:cover;cursor:pointer" title="Ver foto de evidencia"></a><div style="font-size:9px;color:#94a3b8;margin-top:3px">📷 Foto de evidencia — toca para ampliar</div></div>`:''}
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        <button onclick="resolveMCCMsg('${r.id}','${r._st}')" style="background:#dcfce7;color:#166534;border:1px solid #86efac;padding:5px 14px;border-radius:7px;font-size:11px;font-weight:700;cursor:pointer">✓ Atendido</button>
        <a href="https://wa.me/?text=${waText}" target="_blank" rel="noopener" style="background:#dcfce7;color:#166534;border:1px solid #86efac;padding:5px 14px;border-radius:7px;font-size:11px;font-weight:700;cursor:pointer;text-decoration:none;display:inline-flex;align-items:center;gap:4px">📱 WhatsApp</a>
      </div>
    </div>`;
  }).join('');
}

async function resolveMCCMsg(id,st){
  if(!FB) return;
  await FB.db.collection(AIRLINE_ID).doc(st).collection('reports').doc(id).update({resolved:true,resolvedAt:Date.now(),resolvedBy:currentUserName});
  toast('✅ Mensaje atendido');
}

// ── MCC departure countdown tick (1 s) ──────────────────
function mccCountdownTick(){
  const view=document.getElementById('VIEW-mcc');
  if(!view?.classList.contains('on')) return;
  if(mccSelectedDate!==localDateStr()) return;
  const now=Date.now();
  document.querySelectorAll('[data-cdw-ge]').forEach(el=>{
    const ge=parseInt(el.getAttribute('data-cdw-ge'),10);
    const etd=new Date(); etd.setHours(Math.floor(ge/60),ge%60,0,0);
    const diffMs=etd-now;
    if(diffMs<=0){
      el.textContent='ETD pasado';
      el.style.background='#f1f5f9'; el.style.color='#94a3b8';
      return;
    }
    const diffMins=Math.floor(diffMs/60000);
    const diffSecs=Math.floor((diffMs%60000)/1000);
    const h=Math.floor(diffMins/60), m=diffMins%60;
    el.textContent=h>0
      ?`⏱ ${h}h ${String(m).padStart(2,'0')}m`
      :`⏱ ${String(m).padStart(2,'0')}m ${String(diffSecs).padStart(2,'0')}s`;
    if(diffMins>60)     {el.style.background='#dbeafe';el.style.color='#1e40af';}
    else if(diffMins>30){el.style.background='#dcfce7';el.style.color='#166534';}
    else if(diffMins>15){el.style.background='#fef9c3';el.style.color='#92400e';}
    else                {el.style.background='#fee2e2';el.style.color='#dc2626';}
  });
}
setInterval(mccCountdownTick,1000);

// ── Formulario de reporte desde MCC ──
let mccRepPhotoFile = null;

function mccToggleReportForm(){
  const wrap = document.getElementById('mcc-report-form-wrap');
  const isOpen = wrap.style.display !== 'none';
  wrap.style.display = isOpen ? 'none' : 'block';
  if(!isOpen){
    // Poblar select de bases
    const sel = document.getElementById('mcc-rep-station');
    sel.innerHTML = '<option value="">— Seleccionar base —</option>';
    stations.forEach(st => {
      const o = document.createElement('option');
      o.value = st.code;
      o.textContent = (st.flag||'🛫') + ' ' + st.code;
      sel.appendChild(o);
    });
    // Reset form
    document.getElementById('mcc-rep-ac').value = '';
    document.getElementById('mcc-rep-name').value = currentUserName || '';
    document.getElementById('mcc-rep-msg').value = '';
    document.getElementById('mcc-rep-err').textContent = '';
    mccRepPhotoRemove();
    // Reset radio
    const r = document.querySelector('input[name="mcc-rep-type"][value="anomaly"]');
    if(r){ r.checked = true; mccRepTypeChange('anomaly'); }
  }
}

function mccRepTypeChange(val){
  const isAnomaly = val === 'anomaly';
  const aLbl = document.getElementById('mcc-rep-type-anomaly');
  const pLbl = document.getElementById('mcc-rep-type-pilot');
  if(aLbl) aLbl.style.cssText=`display:flex;align-items:center;gap:8px;padding:10px 12px;border:2px solid ${isAnomaly?'#0f2a66':'#e2e8f0'};border-radius:8px;cursor:pointer;background:${isAnomaly?'#eff6ff':'#f8fafc'}`;
  if(pLbl) pLbl.style.cssText=`display:flex;align-items:center;gap:8px;padding:10px 12px;border:2px solid ${!isAnomaly?'#3b82f6':'#e2e8f0'};border-radius:8px;cursor:pointer;background:${!isAnomaly?'#eff6ff':'#f8fafc'}`;
  const nameLbl = document.getElementById('mcc-rep-name-lbl');
  const msgLbl  = document.getElementById('mcc-rep-msg-lbl');
  if(nameLbl) nameLbl.textContent = isAnomaly ? 'Reportado por (MCC / personal)' : 'Nombre del piloto / capitán';
  if(msgLbl)  msgLbl.textContent  = isAnomaly ? 'Descripción de la anomalía' : 'Mensaje al MCC';
}

function mccRepPhotoSelected(input){
  const file = input.files[0];
  if(!file) return;
  mccRepPhotoFile = file;
  const url = URL.createObjectURL(file);
  document.getElementById('mcc-rep-photo-thumb').src = url;
  document.getElementById('mcc-rep-photo-preview').style.display = 'flex';
}
function mccRepPhotoRemove(){
  mccRepPhotoFile = null;
  const inp = document.getElementById('mcc-rep-photo-input');
  if(inp) inp.value = '';
  const prev = document.getElementById('mcc-rep-photo-preview');
  if(prev) prev.style.display = 'none';
  const thumb = document.getElementById('mcc-rep-photo-thumb');
  if(thumb) thumb.src = '';
}

async function mccSubmitReport(){
  const st   = document.getElementById('mcc-rep-station').value;
  const ac   = document.getElementById('mcc-rep-ac').value;
  const name = (document.getElementById('mcc-rep-name').value||'').trim().toUpperCase()||'MCC';
  const msg  = (document.getElementById('mcc-rep-msg').value||'').trim();
  const err  = document.getElementById('mcc-rep-err');
  const btn  = document.getElementById('mcc-rep-submit-btn');
  const repType = document.querySelector('input[name="mcc-rep-type"]:checked')?.value || 'anomaly';

  if(!st){ err.textContent='⚠ Selecciona la base'; return; }
  if(!ac){ err.textContent='⚠ Selecciona la aeronave'; return; }
  if(!msg||msg.length<5){ err.textContent='⚠ Describe la anomalía (mínimo 5 caracteres)'; return; }

  err.textContent=''; btn.textContent='Enviando...'; btn.disabled=true;
  try{
    if(!firebase.auth().currentUser) await firebase.auth().signInAnonymously();

    const now = new Date();
    const nowMins = now.getHours()*60 + now.getMinutes();
    const today = localDateStr(now);

    // Encontrar la OT correcta (misma lógica que submitReport)
    const allTasksSnap = await FB.db.collection(AIRLINE_ID).doc(st).collection('tasks').where('ac','==',ac).get();
    const allTasks = allTasksSnap.docs.map(d=>({id:d.id,ref:d.ref,...d.data()}));
    allTasks.sort((a,b)=>{
      if(a.taskDate!==b.taskDate) return a.taskDate.localeCompare(b.taskDate);
      return (a.ge||0)-(b.ge||0);
    });
    let targetTask = allTasks.find(t=>t.taskDate===today&&(t.ge||0)>=nowMins);
    if(!targetTask) targetTask = allTasks.find(t=>t.taskDate>today);
    if(!targetTask) targetTask = allTasks.filter(t=>t.taskDate===today).pop();

    // Subir foto si existe
    let photoUrl = '';
    if(mccRepPhotoFile){
      btn.textContent='Subiendo foto...';
      try{
        const up = await uploadToSupabase(mccRepPhotoFile, `${st}/reports`);
        photoUrl = up.url||'';
      }catch(e){ console.warn('MCC photo upload failed:',e); }
    }

    const reportData = {
      ac, message:msg, reportedBy:name,
      type: repType,
      station: st,
      timestamp: Date.now(),
      timeStr: now.toLocaleTimeString('es-DO',{hour:'2-digit',minute:'2-digit'}),
      dateStr: targetTask?.taskDate||today,
      taskId: targetTask?.id||'',
      resolved: false,
      origin: 'mcc',
      ...(photoUrl?{photoUrl}:{}),
    };
    await FB.db.collection(AIRLINE_ID).doc(st).collection('reports').add(reportData);

    toast('✅ Reporte enviado desde MCC');
    mccToggleReportForm(); // cierra el formulario
  }catch(e){
    err.textContent = 'Error: '+e.message;
    console.error('MCC report error:',e);
  }finally{
    btn.textContent='📤 Enviar reporte'; btn.disabled=false;
  }
}

async function generateDailyPDF(){
  const btn=document.getElementById('btn-pdf');
  const origTxt=btn.innerHTML;
  btn.innerHTML='⏳ Generando...'; btn.disabled=true;
  try{
    // Cargar jsPDF + autoTable si no están
    if(!window.jspdf){
      await new Promise((res,rej)=>{const s=document.createElement('script');s.src='https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js';s.onload=res;s.onerror=rej;document.head.appendChild(s);});
      await new Promise((res,rej)=>{const s=document.createElement('script');s.src='https://cdnjs.cloudflare.com/ajax/libs/jspdf-autotable/3.8.2/jspdf.plugin.autotable.min.js';s.onload=res;s.onerror=rej;document.head.appendChild(s);});
    }
    const {jsPDF}=window.jspdf;
    const doc=new jsPDF({orientation:'portrait',unit:'mm',format:'a4'});
    const dt=dayTasks();
    const reps=activeReports.filter(r=>!r.resolved);
    const worked=techAssignedHours();
    const st=activeStation();
    const nowStr=new Date().toLocaleTimeString('es-DO',{hour:'2-digit',minute:'2-digit'});
    const W=210, M=14;
    const NAVY=[15,42,102], WHITE=[255,255,255], GRAY=[100,116,132];
    const LIGHT=[241,245,249], GREEN=[22,163,74], RED=[220,38,38], AMBER=[245,158,11];

    // ── Encabezado ──
    doc.setFillColor(...NAVY); doc.rect(0,0,W,30,'F');
    doc.setTextColor(...WHITE);
    const airlineLbl=(window._airlineName||'AirTech Assist').toUpperCase();
    doc.setFont('helvetica','bold'); doc.setFontSize(15);
    doc.text(`${airlineLbl} — Reporte Ejecutivo Diario`,M,13);
    doc.setFont('helvetica','normal'); doc.setFontSize(8.5);
    doc.text(`${window._airlineName||'AirTech Assist'}  ·  Base ${st}  ·  ${selectedDate}  ·  Generado: ${nowStr}`,M,21);
    doc.text(`Supervisado por: ${currentUserName||'—'}`,W-M,21,{align:'right'});

    let y=40;

    // ── KPIs ──
    const total=dt.length;
    const entregadas=dt.filter(t=>t.status==='entregada').length;
    const pdfNow=new Date(), pdfNowMins=pdfNow.getHours()*60+pdfNow.getMinutes();
    const pdfToday=localDateStr(pdfNow);
    const pdfGetEtdDate=t=>{
      if(!t.taskDays||t.taskDays===0) return t.taskDate;
      const d=new Date(t.taskDate+'T12:00:00'); d.setDate(d.getDate()+(t.taskDays||0)); return localDateStr(d);
    };
    const pdfEtdPassed=t=>{ const e=pdfGetEtdDate(t); return e<pdfToday||(e===pdfToday&&(t.ge||0)<=pdfNowMins); };
    // Parse "HH:MM" or "HH:MM a. m." / "HH:MM p. m." → minutes from midnight
    const parseDeliveredAt=s=>{
      if(!s) return NaN;
      const m=s.match(/(\d{1,2}):(\d{2})(?:\s*(a\.?\s*m\.?|p\.?\s*m\.?))?/i);
      if(!m) return NaN;
      let h=parseInt(m[1]); const min=parseInt(m[2]);
      if(m[3]){ const pm=/p/i.test(m[3]); if(pm&&h!==12)h+=12; if(!pm&&h===12)h=0; }
      return h*60+min;
    };
    // Calcula minutos de demora: positivo = retrasado, null = a tiempo
    const pdfDelay=t=>{
      if(!pdfEtdPassed(t)) return null;
      if(t.status==='entregada'&&t.deliveredAt){
        const delivMins=parseDeliveredAt(t.deliveredAt);
        if(!isNaN(delivMins)){
          const d=delivMins-t.ge;
          return d>0?d:null;
        }
      } else if(t.status!=='entregada'&&t.status!=='reported'){
        const etdDate=pdfGetEtdDate(t);
        if(etdDate===pdfToday){ const d=pdfNowMins-t.ge; return d>0?d:null; }
        if(etdDate<pdfToday){ const minsInDay=(24*60)-t.ge+pdfNowMins; return minsInDay>0?minsInDay:null; }
      }
      return null;
    };
    // Retrasadas = pendientes tarde + entregadas fuera de tiempo
    const retrasadas=dt.filter(t=>pdfEtdPassed(t)&&(
      (t.status!=='entregada'&&t.status!=='reported')||
      (t.status==='entregada'&&pdfDelay(t)!==null)
    )).length;
    const duePdf=dt.filter(t=>pdfEtdPassed(t));
    const otp=duePdf.length>0?Math.round((duePdf.filter(t=>t.status==='entregada').length/duePdf.length)*100):100;
    const kpis=[
      {label:'Total OTs',   val:String(total),        col:NAVY},
      {label:'Entregadas',  val:String(entregadas),   col:GREEN},
      {label:'Retrasadas',  val:String(retrasadas),   col:retrasadas>0?RED:GRAY},
      {label:'Anomalías',   val:String(reps.length),  col:reps.length>0?RED:GRAY},
      {label:'OTP',         val:otp+'%',              col:otp>=85?GREEN:otp>=70?AMBER:RED},
    ];
    const kW=(W-M*2)/kpis.length-2.5;
    kpis.forEach((k,i)=>{
      const x=M+i*(kW+2.5);
      doc.setFillColor(...LIGHT); doc.roundedRect(x,y,kW,20,2,2,'F');
      doc.setFont('helvetica','bold'); doc.setFontSize(17);
      doc.setTextColor(...k.col); doc.text(k.val,x+kW/2,y+13,{align:'center'});
      doc.setFont('helvetica','normal'); doc.setFontSize(7);
      doc.setTextColor(...GRAY); doc.text(k.label,x+kW/2,y+18,{align:'center'});
    });
    y+=28;

    // ── Tabla operaciones ──
    doc.setFont('helvetica','bold'); doc.setFontSize(9); doc.setTextColor(...NAVY);
    doc.text('DETALLE DE OPERACIONES',M,y); y+=3;
    const opRows=dt.map(t=>{
      const names=(t.staff||[]).map(id=>techs.find(s=>s.id===id)?.name?.split(' ')[0]||'').filter(Boolean).join(', ')||'—';
      const gN=t.gaseo?techs.find(s=>s.id===t.gaseo)?.name?.split(' ').slice(0,2).join(' ')||'—':'—';
      const dN=t.despacho?techs.find(s=>s.id===t.despacho)?.name?.split(' ').slice(0,2).join(' ')||'—':'—';
      const late=pdfEtdPassed(t)&&t.status!=='entregada'&&t.status!=='reported';
      const delay=pdfDelay(t);
      const delayStr=delay?fdur(delay):'';
      let est;
      if(t.status==='entregada') est=delay?`Entregada\n+${delayStr} tarde`:'Entregada';
      else if(t.status==='reported') est='Reportada';
      else if(late) est=`Retrasada\n+${delayStr||'?'}`;
      else est='En espera';
      const buf=t.ge-(t.start+t.dur);
      return[t.ac,t.wo||'—',hhmm(t.gs),hhmm(t.ge),hhmm(t.start),hhmm(t.start+t.dur),fdur(t.dur),buf>0?'+'+fdur(buf):'—',names,gN+' / '+dN,est];
    });
    doc.autoTable({
      startY:y,head:[['Matrícula','WO','ETA','ETD','Ini.Mant','Fin.Mant','Duración','Buffer','Técnicos','Gas. / Desp.','Estado / Demora']],
      body:opRows,theme:'striped',
      headStyles:{fillColor:NAVY,textColor:WHITE,fontSize:7,fontStyle:'bold',halign:'center'},
      bodyStyles:{fontSize:6.5,textColor:[30,41,59]},
      columnStyles:{0:{fontStyle:'bold'},10:{fontStyle:'bold',cellWidth:24}},
      margin:{left:M,right:M},
      didParseCell(d){
        if(d.section==='body'&&d.column.index===10){
          const v=String(d.cell.raw||'');
          if(v.includes('Entregada')&&!v.includes('tarde')) d.cell.styles.textColor=GREEN;
          else if(v.includes('tarde')) d.cell.styles.textColor=AMBER;
          else if(v.includes('Reportada')||v.includes('Retrasada')) d.cell.styles.textColor=RED;
        }
      },
    });
    y=doc.lastAutoTable.finalY+8;

    // ── Comentarios por aeronave ──
    const withCmt=dt.filter(t=>t.comments&&t.comments.trim());
    if(withCmt.length){
      if(y>240){doc.addPage();y=14;}
      doc.setFont('helvetica','bold');doc.setFontSize(9);doc.setTextColor(...NAVY);
      doc.text('COMENTARIOS POR AERONAVE',M,y);y+=3;
      doc.autoTable({
        startY:y,
        head:[['Matrícula','ETD','Estado','Demora','Comentario del técnico']],
        body:withCmt.map(t=>{
          const delay=pdfDelay(t);
          const late=pdfEtdPassed(t)&&t.status!=='entregada'&&t.status!=='reported';
          const est=t.status==='entregada'?'Entregada':t.status==='reported'?'Reportada':late?'Retrasada':'En espera';
          return[t.ac,hhmm(t.ge),est,delay?'+'+fdur(delay):'—',t.comments||'—'];
        }),
        theme:'striped',
        headStyles:{fillColor:[30,64,175],textColor:WHITE,fontSize:7,fontStyle:'bold'},
        bodyStyles:{fontSize:7,textColor:[30,41,59]},
        columnStyles:{4:{cellWidth:'auto'},3:{fontStyle:'bold'}},
        margin:{left:M,right:M},
        didParseCell(d){
          if(d.section==='body'){
            if(d.column.index===2){
              const v=String(d.cell.raw||'');
              if(v==='Entregada') d.cell.styles.textColor=GREEN;
              else if(v==='Retrasada'||v==='Reportada') d.cell.styles.textColor=RED;
            }
            if(d.column.index===3&&String(d.cell.raw||'').startsWith('+')){
              d.cell.styles.textColor=RED;
            }
          }
        },
      });
      y=doc.lastAutoTable.finalY+10;
    }

    // ── Tabla personal ──
    if(y>230){doc.addPage();y=14;}
    doc.setFont('helvetica','bold');doc.setFontSize(9);doc.setTextColor(...NAVY);
    doc.text('UTILIZACIÓN DE PERSONAL',M,y);y+=3;
    const techRows=techs
      .filter(t=>!['GASEO','DESPACHO'].includes(t.role)&&(worked[t.id]||0)>0)
      .sort((a,b)=>(worked[b.id]||0)-(worked[a.id]||0))
      .map(t=>{
        const w=worked[t.id]||0;
        const util=t.hours>0?Math.round((w/t.hours)*100):0;
        return[t.name,t.role,t.shift,t.hours+'h',w%1===0?w+'h':w.toFixed(1)+'h',util+'%'];
      });
    if(techRows.length){
      doc.autoTable({
        startY:y,head:[['Técnico','Rol','Turno','Disponible','Trabajado','Utilización']],
        body:techRows,theme:'striped',
        headStyles:{fillColor:NAVY,textColor:WHITE,fontSize:7,fontStyle:'bold'},
        bodyStyles:{fontSize:7,textColor:[30,41,59]},
        margin:{left:M,right:M},
        didParseCell(d){
          if(d.section==='body'&&d.column.index===5){
            const v=parseInt(d.cell.raw)||0;
            d.cell.styles.textColor=v>=80?GREEN:v>=50?AMBER:RED;
          }
        },
      });
      y=doc.lastAutoTable.finalY+10;
    }

    // ── Anomalías ──
    if(reps.length){
      if(y>230){doc.addPage();y=14;}
      doc.setFont('helvetica','bold');doc.setFontSize(9);doc.setTextColor(...RED);
      doc.text('ANOMALÍAS REPORTADAS',M,y);y+=3;
      doc.autoTable({
        startY:y,
        head:[['Matrícula','Hora','Reportado por','Descripción']],
        body:reps.map(r=>[r.ac||'—',r.timeStr||'—',r.reportedBy||'—',r.message||'—']),
        theme:'striped',
        headStyles:{fillColor:RED,textColor:WHITE,fontSize:7,fontStyle:'bold'},
        bodyStyles:{fontSize:7,textColor:[30,41,59]},
        columnStyles:{3:{cellWidth:'auto'}},
        margin:{left:M,right:M},
      });
    }

    // ── Pie de página ──
    const pages=doc.internal.getNumberOfPages();
    for(let i=1;i<=pages;i++){
      doc.setPage(i);
      doc.setDrawColor(...LIGHT);doc.line(M,286,W-M,286);
      doc.setFontSize(7);doc.setTextColor(...GRAY);
      doc.text(`${window._airlineName||'AirTech Assist'} — Ground Operations · Confidencial`,M,291);
      doc.text(`Pág. ${i} de ${pages}`,W-M,291,{align:'right'});
    }

    const fname=`Reporte_${st}_${selectedDate.replace(/-/g,'')}.pdf`;
    doc.save(fname);
    toast(`✅ PDF descargado: ${fname}`);
  }catch(e){
    toast('⚠ Error generando PDF: '+e.message,true);
    console.error(e);
  }finally{
    btn.innerHTML=origTxt; btn.disabled=false;
  }
}

function exportExcel(){
  const dt=dayTasks();
  // Helper: determinar si una OT fue entregada tarde
  const _isLate=(t)=>{
    if(t.status!=='entregada'||!t.deliveredAt||!t.ge) return false;
    const m=t.deliveredAt.match(/([0-9]{1,2}):([0-9]{2})(?:[ ]*([ap][.]?[ ]*m[.]?))?/i);
    if(!m) return false;
    let h=parseInt(m[1]),mn=parseInt(m[2]);
    if(m[3]&&/p/i.test(m[3])&&h!==12) h+=12;
    if(m[3]&&!/p/i.test(m[3])&&h===12) h=0;
    return (h*60+mn)>t.ge;
  };
  const g=[['Fecha','Aeronave','Orden WO','Est. Llegada','Est. Salida','ETA','ETD','Inicio Manto.','Fin Manto.','Duración (min)','# Técnicos','Técnicos','Gaseo','Despacho','Tareas Completadas','Tareas Pendientes','Estado Entrega','Comentarios']];
  dt.forEach(t=>{
    const names=(t.staff||[]).map(id=>techs.find(s=>s.id===id)?.name||'').join(', ');
    const gN=t.gaseo?techs.find(s=>s.id===t.gaseo)?.name||'':'';
    const dN=t.despacho?techs.find(s=>s.id===t.despacho)?.name||'':'';
    // Tareas del plan vinculadas a esta WO
    const woPlans=plans.filter(p=>p.wo===t.wo||p.taskId===t.id);
    const completadas=woPlans.filter(p=>p.status==='done').length;
    const pendientes=woPlans.length-completadas;
    // Estado de entrega
    let estadoEntrega='Pendiente';
    if(t.status==='entregada') estadoEntrega=_isLate(t)?'Con Demora':'A Tiempo';
    else if(t.status==='reported') estadoEntrega='Reportada';
    g.push([
      t.taskDate||selectedDate, t.ac, t.wo,
      t.arrOrigin||'', t.depDest||'',
      hhmm(t.gs), hhmm(t.ge),
      hhmm(t.start), hhmm(t.start+t.dur), t.dur,
      t.staff.length, names, gN, dN,
      completadas, pendientes, estadoEntrega,
      t.comments||''
    ]);
  });
  if(!dt.length)g.push([selectedDate,'Sin OTs','','','','','','','','','','','','','','','','']);
  const hrs=demandHrs();
  const dRows=[['Fecha',...Array.from({length:24},(_,i)=>(i<10?'0':'')+i+':00'),'Pico','# OTs']];
  (history.length?history:[{date:selectedDate,hrs,tasks:[]}]).forEach(s=>dRows.push([s.date,...(s.hrs||[]),Math.max(...(s.hrs||[0]),0),s.tasks?.length||0]));
  const rs=[['#','Nombre','Categoría','Horas','Turno']];techs.forEach((s,i)=>rs.push([i+1,s.name,s.role,s.hours,s.shift]));
  const ht=[['Fecha','Aeronave','Orden WO','Inicio','Fin','# Técnicos','H-Hombre','Gaseo','Despacho','Comentarios']];
  history.forEach(s=>{(s.tasks||[]).forEach(t=>{const[sh,sm]=(t.start||'0:0').split(':').map(Number),[eh,em]=(t.end||'0:0').split(':').map(Number);ht.push([s.date,t.ac,t.wo,t.start,t.end,t.staff,Math.round(((eh*60+em)-(sh*60+sm))/60*t.staff*10)/10,'','','']);});});
  if(ht.length===1)ht.push(['Sin historial','','','','','','','','','']);
  const xml=`<?xml version="1.0" encoding="UTF-8"?><?mso-application progid="Excel.Sheet"?>\n<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet" xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet" xmlns:x="urn:schemas-microsoft-com:office:excel">\n${mkSheet('Gantt '+selectedDate,g)}${mkSheet('Demanda por Hora',dRows)}${mkSheet('Roster',rs)}${mkSheet('Historial OTs',ht)}</Workbook>`;
  const blob=new Blob([xml],{type:'application/vnd.ms-excel;charset=utf-8'});
  const url=URL.createObjectURL(blob),a=document.createElement('a');
  a.href=url;a.download='AirTech_Ops_'+selectedDate+'.xls';
  document.body.appendChild(a);a.click();document.body.removeChild(a);URL.revokeObjectURL(url);
  toast('✅ Excel descargado: AirTec_Ops_'+selectedDate+'.xls');
}

window.addEventListener('resize',()=>{mTW();buildShiftBands();updateTimeLine();});

// ── PWA Install Prompt ──
let deferredInstallPrompt = null;
window.addEventListener('beforeinstallprompt', e => {
  e.preventDefault();
  deferredInstallPrompt = e;
  // Show install button
  const btn = document.getElementById('btn-install');
  if(btn) btn.style.display = 'flex';
  console.log('✅ App instalable — botón mostrado');
});
window.addEventListener('appinstalled', () => {
  deferredInstallPrompt = null;
  const btn = document.getElementById('btn-install');
  if(btn) btn.style.display = 'none';
  toast('✅ ¡App instalada correctamente!');
});
async function installApp(){
  if(!deferredInstallPrompt){ 
    toast('ℹ️ Abre el menú del navegador → "Instalar app" o "Agregar a pantalla de inicio"');
    return;
  }
  deferredInstallPrompt.prompt();
  const {outcome} = await deferredInstallPrompt.userChoice;
  if(outcome==='accepted') toast('✅ ¡App instalada!');
  deferredInstallPrompt = null;
  const btn = document.getElementById('btn-install');
  if(btn) btn.style.display = 'none';
}
// ══ VUELOS ══
let flightsData = [];

async function loadFlights(station, date){
  station = station || window._station || activeStation();
  try {
    // Load ALL flights (both arrivals and departures) - don't orderBy to avoid index issues
    const snap = await FB.db.collection(AIRLINE_ID).doc(station)
      .collection('flights').get();
    flightsData = snap.docs.map(d=>({id:d.id,...d.data()}));
    console.log('[Flights] loaded:', flightsData.length, 'flights for', station);
  } catch(e) { console.warn('loadFlights:', e.message); flightsData=[]; }
  // Populate datalists in OT modal
  const arrListEl = document.getElementById('fl-arr-list');
  const depListEl = document.getElementById('fl-dep-list');
  if(arrListEl) arrListEl.innerHTML = flightsData.filter(f=>f.type==='arr'||f.eta).map(f=>
    '<option value="'+esc(f.number)+'">'+esc(f.number)+' · '+esc(f.origin||'?')+'→PUJ ETA:'+esc(f.eta||'--:--')+'</option>'
  ).join('');
  if(depListEl) depListEl.innerHTML = flightsData.filter(f=>f.type==='dep'||f.etd).map(f=>
    '<option value="'+esc(f.number)+'">'+esc(f.number)+' · PUJ→'+esc(f.dest||'?')+' ETD:'+esc(f.etd||'--:--')+'</option>'
  ).join('');
  // Re-render Gantt so route info shows under aircraft names
  if(typeof renderGantt === 'function') renderGantt();
}

// ══ TAIL ASSIGNMENTS + API SYNC ═════════════════════════════════════════════

let tailAssignments = {};      // { 'DM101': 'HP-1840CMP', ... }
let _tailImportRows = [];
let _flightAPIPreviewRows = [];

function normFltNum(s){
  // Normaliza "DM-101", "DM 101", "DM101" → "DM101"
  return String(s||'').toUpperCase().replace(/[\s\-]/g,'');
}

function updateTailBadge(){
  const el = document.getElementById('tail-count-badge');
  const n  = Object.keys(tailAssignments).length;
  if(el) el.textContent = n>0 ? '✓ '+n+' matrículas cargadas' : 'Sin matrículas cargadas';
}

async function loadTailAssignments(){
  if(!window.FB) return;
  try{
    const snap = await FB.db.collection(AIRLINE_ID).doc('config').collection('tailAssignments').get();
    tailAssignments = {};
    snap.docs.forEach(d=>{ tailAssignments[normFltNum(d.id)] = d.data().registration; });
    updateTailBadge();
    console.log('[TailAssignments] loaded:', Object.keys(tailAssignments).length);
  }catch(e){ console.warn('loadTailAssignments:', e); }
}

// ── Importar itinerario completo de vuelos desde Excel ───────────────────────
let _flightsExcelRows = [];

function importFlightsExcel(input){
  const file = input.files[0]; if(!file) return;
  input.value = '';
  const reader = new FileReader();
  reader.onload = function(e){
    try{
      const wb  = XLSX.read(e.target.result,{type:'binary'});
      const ws  = wb.Sheets[wb.SheetNames[0]];
      const raw = XLSX.utils.sheet_to_json(ws,{defval:''});
      if(!raw.length){ toast('El archivo está vacío',true); return; }

      function nrm(s){ return String(s).normalize('NFD').replace(/[̀-ͯ]/g,'').replace(/[\s\-]/g,'_').toUpperCase(); }
      const hdrs   = Object.keys(raw[0]);
      const findCol= list => hdrs.find(h=>list.includes(nrm(h)))||null;

      const colNum  = findCol(['VUELO','FLIGHT','NUMERO_VUELO','FLIGHT_NUMBER','FLT','FLT_NO','FLIGHT_NO']);
      const colOrig = findCol(['ORIGEN','ORIGIN','DEP','DEPARTURE','FROM','PROCEDENCIA']);
      const colDest = findCol(['DESTINO','DESTINATION','ARR','ARRIVAL','TO','DESTINO_IATA']);
      const colEta  = findCol(['ETA','LLEGADA','ARRIVAL_TIME','ARR_TIME','HORA_LLEGADA','STA']);
      const colEtd  = findCol(['ETD','SALIDA','DEPARTURE_TIME','DEP_TIME','HORA_SALIDA','STD']);
      const colAc   = findCol(['MATRICULA','REGISTRATION','REG','TAIL','AIRCRAFT','AC','AC_REG']);
      const colDays = findCol(['DIAS','DAYS','DIAS_SEMANA','DOW','FREQUENCY','FRECUENCIA']);

      if(!colNum){ toast('No se encontró columna VUELO — revisa los encabezados del Excel',true); return; }

      // Day-name → JS day index (0=Sun … 6=Sat)
      const DAY_MAP={'D':0,'DO':0,'DOM':0,'SU':0,'SUN':0,'DOMINGO':0,'SUNDAY':0,
                     'L':1,'LU':1,'LUN':1,'MO':1,'MON':1,'LUNES':1,'MONDAY':1,
                     'M':2,'MA':2,'MAR':2,'TU':2,'TUE':2,'MARTES':2,'TUESDAY':2,
                     'X':3,'MI':3,'MIE':3,'WE':3,'WED':3,'MIERCOLES':3,'WEDNESDAY':3,
                     'J':4,'JU':4,'JUE':4,'TH':4,'THU':4,'JUEVES':4,'THURSDAY':4,
                     'V':5,'VI':5,'VIE':5,'FR':5,'FRI':5,'VIERNES':5,'FRIDAY':5,
                     'S':6,'SA':6,'SAB':6,'SAT':6,'SABADO':6,'SATURDAY':6};

      function parseDays(val){
        if(!val) return [0,1,2,3,4,5,6]; // sin días = todos
        const str=String(val).toUpperCase();
        // Numeric: "1234567" or "1,2,3"
        if(/^[\d,\s]+$/.test(str)) return str.split(/[,\s]+/).map(d=>parseInt(d)-1).filter(d=>d>=0&&d<=6);
        // Named: "L,M,X,J,V" or "MON TUE WED"
        return str.split(/[,\s\/\-]+/).map(t=>t.trim()).map(t=>DAY_MAP[t]).filter(d=>d!==undefined);
      }

      function parseTime(val){
        if(!val&&val!==0) return '';
        const s=String(val).trim();
        // Excel time as decimal (0.5 = 12:00)
        if(/^\d+\.\d+$/.test(s)){
          const mins=Math.round(parseFloat(s)*1440);
          return String(Math.floor(mins/60)).padStart(2,'0')+':'+String(mins%60).padStart(2,'0');
        }
        // HH:MM or H:MM
        const m=s.match(/(\d{1,2}):(\d{2})/);
        if(m) return m[1].padStart(2,'0')+':'+m[2];
        // HHMM
        if(/^\d{3,4}$/.test(s)){
          const n=s.padStart(4,'0');
          return n.slice(0,2)+':'+n.slice(2);
        }
        return s;
      }

      const station = window._station;
      const rows=[]; const skipped=[];
      raw.forEach((r,i)=>{
        const num=(r[colNum]||'').toString().trim().toUpperCase();
        if(!num){ skipped.push(i+2); return; }
        const orig=(colOrig?String(r[colOrig]||'').trim().toUpperCase():'');
        const dest=(colDest?String(r[colDest]||'').trim().toUpperCase():'');
        const eta =parseTime(colEta?r[colEta]:'');
        const etd =parseTime(colEtd?r[colEtd]:'');
        const ac  =(colAc?String(r[colAc]||'').trim().toUpperCase():'')||tailAssignments[normFltNum(num)]||'';
        const days=parseDays(colDays?r[colDays]:'');
        // Determine type: arrival if has ETA, departure if only ETD
        const type = eta ? 'arr' : 'dep';
        function toMin(t){ if(!t) return 0; const [h,m]=t.split(':').map(Number); return h*60+(m||0); }
        rows.push({number:num, origin:orig, dest, eta, etd, ac, days, type, station,
          etaM:toMin(eta), etdM:toMin(etd)});
      });

      if(!rows.length){ toast('No se encontraron vuelos válidos con VUELO',true); return; }
      _flightsExcelRows=rows;

      // Preview table
      const tbl=document.getElementById('flights-excel-table');
      const cnt=document.getElementById('flights-excel-count');
      const warn=document.getElementById('flights-excel-warn');
      if(tbl){
        tbl.innerHTML=`<div style="display:grid;grid-template-columns:90px 55px 100px 50px 50px 110px 80px;font-weight:700;color:#166534;background:#dcfce7;padding:6px 10px;border-radius:6px 6px 0 0;position:sticky;top:0">
          <span>VUELO</span><span>TIPO</span><span>RUTA</span><span>ETA</span><span>ETD</span><span>MATRÍCULA</span><span>DÍAS</span></div>`;
        const DAYNAMES=['Do','Lu','Ma','Mi','Ju','Vi','Sa'];
        rows.forEach(r=>{
          const row=document.createElement('div');
          const hasTail=!!r.ac;
          row.style.cssText='display:grid;grid-template-columns:90px 55px 100px 50px 50px 110px 80px;padding:4px 10px;border-bottom:1px solid #dcfce7;'+(hasTail?'':'background:#fef9c3');
          const daysStr=r.days.length===7?'Todos':r.days.map(d=>DAYNAMES[d]).join(' ');
          row.innerHTML=`
            <span style="font-family:monospace;font-weight:700;color:#0f2a66">${r.number}</span>
            <span style="color:${r.type==='arr'?'#166534':'#b45309'};font-weight:600">${r.type==='arr'?'▼ ARR':'▲ DEP'}</span>
            <span style="font-size:9px;color:#374151">${r.origin}→${r.dest}</span>
            <span style="font-family:monospace;color:#0f2a66">${r.eta||'—'}</span>
            <span style="font-family:monospace;color:#0f2a66">${r.etd||'—'}</span>
            <span style="font-family:monospace;font-weight:600;color:${hasTail?'#166534':'#9ca3af'}">${r.ac||'Sin matrícula'}</span>
            <span style="font-size:9px;color:#64748b">${daysStr}</span>`;
          tbl.appendChild(row);
        });
      }
      const noTail=rows.filter(r=>!r.ac).length;
      if(cnt) cnt.textContent=rows.length+' vuelos'+(noTail?' · ⚠ '+noTail+' sin matrícula':'');
      if(warn) warn.textContent=skipped.length?'⚠ Filas sin número de vuelo omitidas: fila(s) '+skipped.slice(0,10).join(', ')+(skipped.length>10?'…':''):'';
      document.getElementById('flights-excel-preview').style.display='block';
    }catch(err){ console.error(err); toast('Error leyendo Excel: '+err.message,true); }
  };
  reader.readAsBinaryString(file);
}

async function confirmFlightsExcelImport(){
  if(!_flightsExcelRows.length) return;
  const total=_flightsExcelRows.length;
  const station=window._station;
  const btn=document.querySelector('#flights-excel-preview .btn-green');
  if(btn){ btn.disabled=true; btn.textContent='Importando…'; }
  try{
    const CHUNK=400;
    const rows=[..._flightsExcelRows];
    for(let i=0;i<rows.length;i+=CHUNK){
      const batch=FB.db.batch();
      rows.slice(i,i+CHUNK).forEach(r=>{
        const ref=FB.db.collection(AIRLINE_ID).doc(station).collection('flights').doc();
        batch.set(ref,{...r, createdAt:Date.now(), createdBy:currentUserName, excelImport:true});
      });
      await batch.commit();
    }
    document.getElementById('flights-excel-preview').style.display='none';
    _flightsExcelRows=[];
    await loadFlights(station);
    renderFlightsView();
    toast('✅ '+total+' vuelos importados para '+station);
  }catch(err){
    console.error(err); toast('Error: '+err.message,true);
    if(btn){ btn.disabled=false; btn.textContent='✅ Importar vuelos'; }
  }
}

// ── Importar matrículas desde Excel ─────────────────────────────────────────
function importTailAssignmentsExcel(input){
  const file = input.files[0]; if(!file) return;
  input.value = '';
  const reader = new FileReader();
  reader.onload = function(e){
    try{
      const wb   = XLSX.read(e.target.result, {type:'binary'});
      const ws   = wb.Sheets[wb.SheetNames[0]];
      const raw  = XLSX.utils.sheet_to_json(ws, {defval:''});
      if(!raw.length){ toast('El archivo está vacío',true); return; }

      function nrm(s){ return String(s).normalize('NFD').replace(/[̀-ͯ]/g,'').replace(/\s+/g,'_').toUpperCase(); }
      const hdrs = Object.keys(raw[0]);
      const findCol = list => hdrs.find(h=>list.includes(nrm(h)))||null;

      const colFlt = findCol(['VUELO','FLIGHT','NUMERO_VUELO','FLIGHT_NUMBER','FLT','FLT_NUMBER','FLIGHT_NO']);
      const colReg = findCol(['MATRICULA','REGISTRATION','REG','TAIL','TAIL_NUMBER','AIRCRAFT','AC_REG']);

      if(!colFlt||!colReg){ toast('No se encontraron columnas VUELO y MATRICULA — revisa los encabezados del Excel',true); return; }

      const rows = [];
      raw.forEach(r=>{
        const flt = normFltNum(r[colFlt]||'');
        const reg = String(r[colReg]||'').trim().toUpperCase();
        if(flt && reg) rows.push({flt, reg});
      });
      if(!rows.length){ toast('No se encontraron filas válidas',true); return; }

      _tailImportRows = rows;
      const tbl = document.getElementById('tail-import-table');
      const cnt = document.getElementById('tail-import-count');
      if(tbl){
        tbl.innerHTML = `<div style="display:grid;grid-template-columns:1fr 1fr;font-weight:700;color:#6d28d9;background:#ede9fe;padding:6px 10px;border-radius:6px 6px 0 0;font-size:11px;position:sticky;top:0"><span>VUELO</span><span>MATRÍCULA</span></div>`;
        rows.forEach(r=>{
          const d=document.createElement('div');
          d.style.cssText='display:grid;grid-template-columns:1fr 1fr;padding:4px 10px;border-bottom:1px solid #ede9fe;font-size:11px';
          d.innerHTML=`<span style="font-family:monospace;font-weight:700;color:#0f2a66">${r.flt}</span><span style="font-family:monospace;font-weight:600;color:#166534">${r.reg}</span>`;
          tbl.appendChild(d);
        });
      }
      if(cnt) cnt.textContent = rows.length+' registros';
      document.getElementById('tail-import-preview').style.display='block';
    }catch(err){ console.error(err); toast('Error leyendo Excel: '+err.message,true); }
  };
  reader.readAsBinaryString(file);
}

async function confirmTailImport(){
  if(!_tailImportRows.length) return;
  const btn = document.querySelector('#tail-import-preview .btn-green');
  if(btn){ btn.disabled=true; btn.textContent='Guardando…'; }
  try{
    const CHUNK=400;
    for(let i=0;i<_tailImportRows.length;i+=CHUNK){
      const batch=FB.db.batch();
      _tailImportRows.slice(i,i+CHUNK).forEach(r=>{
        const ref=FB.db.collection(AIRLINE_ID).doc('config').collection('tailAssignments').doc(r.flt);
        batch.set(ref,{registration:r.reg, updatedAt:Date.now()});
        tailAssignments[r.flt]=r.reg;
      });
      await batch.commit();
    }
    document.getElementById('tail-import-preview').style.display='none';
    _tailImportRows=[];
    updateTailBadge();
    toast('✅ '+Object.keys(tailAssignments).length+' matrículas guardadas en Firestore');
  }catch(err){
    console.error(err); toast('Error guardando: '+err.message,true);
    if(btn){ btn.disabled=false; btn.textContent='✅ Confirmar'; }
  }
}

// ── Sincronización desde AviationStack API ───────────────────────────────────
async function syncFlightsFromAPI(){
  const apiKey = window.APP_CONFIG?.aviationApiKey;
  if(!apiKey){
    toast('⚠ Agrega aviationApiKey en config.js — clave gratuita en aviationstack.com',true);
    return;
  }
  const station = window._station;
  if(!station){ toast('Selecciona una base primero',true); return; }

  const dateEl  = document.getElementById('api-sync-date');
  const dateStr = dateEl?.value || selectedDate;

  const syncBtn = document.getElementById('btn-api-sync');
  if(syncBtn){ syncBtn.disabled=true; syncBtn.textContent='Consultando API…'; }

  try{
    // AviationStack free plan = HTTP only → route through CORS proxy
    const PROXY = 'https://corsproxy.io/?';
    const BASE  = 'http://api.aviationstack.com/v1/flights';
    const mkUrl = extra => PROXY + encodeURIComponent(
      `${BASE}?access_key=${apiKey}&flight_date=${dateStr}&${extra}&limit=100`
    );

    async function apiFetch(url){
      const r = await fetch(url);
      if(!r.ok) throw new Error('HTTP '+r.status+' — '+r.statusText);
      return r.json();
    }

    const [arrRes, depRes] = await Promise.all([
      apiFetch(mkUrl('arr_iata='+station)).catch(e=>({error:{message:e.message}})),
      apiFetch(mkUrl('dep_iata='+station)).catch(e=>({error:{message:e.message}}))
    ]);

    if(arrRes.error||depRes.error){
      toast('Error API: '+((arrRes.error||depRes.error).message||'Revisa tu clave en config.js'),true);
      return;
    }

    function parseISOTime(iso){
      if(!iso) return '';
      const m=String(iso).match(/T(\d{2}:\d{2})/);
      return m?m[1]:'';
    }

    const arrFlights = (arrRes.data||[]).map(f=>({
      type:'arr',
      number: f.flight?.iata||f.flight?.icao||'',
      origin: f.departure?.iata||'',
      dest:   station,
      eta:    parseISOTime(f.arrival?.estimated||f.arrival?.scheduled),
      etd:    '',
      ac:     tailAssignments[normFltNum(f.flight?.iata||'')] || '',
      station, days:[], apiSynced:true, syncDate:dateStr
    }));

    const depFlights = (depRes.data||[]).map(f=>({
      type:'dep',
      number: f.flight?.iata||f.flight?.icao||'',
      origin: station,
      dest:   f.arrival?.iata||'',
      eta:    '',
      etd:    parseISOTime(f.departure?.estimated||f.departure?.scheduled),
      ac:     tailAssignments[normFltNum(f.flight?.iata||'')] || '',
      station, days:[], apiSynced:true, syncDate:dateStr
    }));

    // Merge: si hay una llegada y una salida del mismo AC en el mismo día → fusionar en un solo registro
    const merged = [];
    const usedDep = new Set();
    arrFlights.forEach(arr=>{
      if(!arr.number) return;
      const matchDep = arr.ac ? depFlights.find(d=>d.ac===arr.ac&&!usedDep.has(d.number)) : null;
      if(matchDep){ usedDep.add(matchDep.number); merged.push({...arr, etd:matchDep.etd, depNumber:matchDep.number, dest_dep:matchDep.dest}); }
      else merged.push(arr);
    });
    depFlights.forEach(d=>{ if(!usedDep.has(d.number)&&d.number) merged.push(d); });

    if(!merged.length){ toast('No se encontraron vuelos para '+station+' el '+dateStr,true); return; }

    _flightAPIPreviewRows = merged;
    renderFlightAPIPreview(merged);

  }catch(err){ console.error(err); toast('Error de conexión: '+err.message,true); }
  finally{ if(syncBtn){ syncBtn.disabled=false; syncBtn.textContent='🔄 Sincronizar desde API'; } }
}

function renderFlightAPIPreview(rows){
  const preview = document.getElementById('flight-api-preview');
  const table   = document.getElementById('flight-api-table');
  if(!preview||!table) return;

  const withTail=rows.filter(r=>r.ac).length;
  const noTail  =rows.length-withTail;

  table.innerHTML=`<div style="display:grid;grid-template-columns:90px 55px 130px 55px 55px 1fr 60px;font-weight:700;color:#1e40af;background:#dbeafe;padding:6px 10px;border-radius:6px 6px 0 0;font-size:10px;position:sticky;top:0">
    <span>VUELO</span><span>TIPO</span><span>RUTA</span><span>ETA</span><span>ETD</span><span>MATRÍCULA</span><span style="text-align:center">OK</span>
  </div>`;

  rows.forEach(r=>{
    const hasTail=!!r.ac;
    const ruta = r.type==='arr' ? r.origin+'→'+r.dest : r.origin+'→'+(r.dest_dep||r.dest);
    const row=document.createElement('div');
    row.style.cssText='display:grid;grid-template-columns:90px 55px 130px 55px 55px 1fr 60px;padding:5px 10px;border-bottom:1px solid #dbeafe;font-size:10px;'+(hasTail?'':'background:#fef9c3');
    row.innerHTML=`
      <span style="font-family:monospace;font-weight:700;color:#0f2a66">${r.number}</span>
      <span style="color:${r.type==='arr'?'#166534':'#b45309'};font-weight:600">${r.type==='arr'?'▼ ARR':'▲ DEP'}</span>
      <span style="font-size:9px;color:#374151;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${ruta}</span>
      <span style="font-family:monospace;color:#0f2a66">${r.eta||'—'}</span>
      <span style="font-family:monospace;color:#0f2a66">${r.etd||'—'}</span>
      <span style="font-family:monospace;font-weight:600;color:${hasTail?'#166534':'#9ca3af'}">${r.ac||'Sin matrícula'}</span>
      <span style="text-align:center">${hasTail?'✅':'⚠️'}</span>`;
    table.appendChild(row);
  });

  const cnt=document.getElementById('flight-api-count');
  if(cnt) cnt.textContent=rows.length+' vuelos · '+withTail+' con matrícula'+(noTail?' · ⚠ '+noTail+' sin matrícula':'');
  preview.style.display='block';
}

async function confirmFlightAPISync(){
  if(!_flightAPIPreviewRows.length) return;
  const station=window._station;
  const total=_flightAPIPreviewRows.length;
  const btn=document.querySelector('#flight-api-preview .btn-green');
  if(btn){ btn.disabled=true; btn.textContent='Guardando…'; }
  try{
    function toMin(hhmm){ if(!hhmm) return 0; const [h,m]=(hhmm||'00:00').split(':').map(Number); return h*60+m; }
    const CHUNK=400;
    const rows=[..._flightAPIPreviewRows];
    for(let i=0;i<rows.length;i+=CHUNK){
      const batch=FB.db.batch();
      rows.slice(i,i+CHUNK).forEach(r=>{
        const ref=FB.db.collection(AIRLINE_ID).doc(station).collection('flights').doc();
        const etaM=toMin(r.eta), etdM=toMin(r.etd);
        batch.set(ref,{...r, etaM, etdM, createdAt:Date.now(), createdBy:currentUserName});
      });
      await batch.commit();
    }
    document.getElementById('flight-api-preview').style.display='none';
    _flightAPIPreviewRows=[];
    await loadFlights(station);
    renderFlightsView();
    toast('✅ '+total+' vuelos sincronizados para '+station);
  }catch(err){
    console.error(err); toast('Error: '+err.message,true);
    if(btn){ btn.disabled=false; btn.textContent='✅ Guardar vuelos'; }
  }
}

function openFlightModal(flight){
  if(typeof flight === 'string') try{ flight=JSON.parse(flight); }catch(_){ flight=null; }
  document.getElementById('flight-modal-title').textContent = flight ? '✏️ Editar vuelo' : '✈️ Nuevo vuelo';
  const flSt = document.getElementById('fl-station');
  if(flSt) flSt.innerHTML = stations.map(s=>`<option value="${s.code}"${(flight?.station||activeStation())===s.code?' selected':''}>${s.code} · ${s.name||''}</option>`).join('');
  const flAc = document.getElementById('fl-ac');
  if(flAc){ flAc.innerHTML = '<option value="">— Sin asignar —</option>' + aircraft.map(a=>`<option value="${a.reg}"${flight?.ac===a.reg?' selected':''}>${a.reg}</option>`).join(''); }
  document.querySelectorAll('.fl-day').forEach(cb=>{ cb.checked = flight ? (flight.days||[]).includes(Number(cb.value)) : true; });
  const set=(id,val)=>{const el=document.getElementById(id);if(el)el.value=val||'';};
  set('fl-number',flight?.number); set('fl-origin',flight?.origin); set('fl-dest',flight?.dest);
  set('fl-eta',flight?.eta); set('fl-etd',flight?.etd);
  set('fl-arr-prev',flight?.arrPrev); set('fl-dep-next',flight?.depNext); set('fl-notes',flight?.notes);
  document.getElementById('modal-flight')._editId = flight?.id||null;
  document.getElementById('modal-flight').classList.add('open');
}
function closeFlightModal(){ document.getElementById('modal-flight').style.display='none'; }


// ── Auto-generate OT tasks (amber bars) from a flight ──
async function autoGenerateFlightOTs(station, fl){
  const today = new Date();
  const batch = [];
  for(let i=0; i<30; i++){
    const d = new Date(today);
    d.setDate(today.getDate() + i);
    const dow = d.getDay();
    if(!(fl.days||[]).includes(dow)) continue;
    const dateStr = localDateStr(d);
    // Skip existence check (avoid composite index requirement)
    batch.push({
      ac: fl.ac,
      wo: 'TRANSITO',              // Default: tránsito 30 min
      taskDate: dateStr,
      gs: fl.etaM,                 // Ground slot ETA
      ge: fl.etdM,                 // Ground slot ETD
      start: fl.etaM,              // Maintenance starts at ETA
      dur: 30,                     // 30 min TRANSITO por defecto
      arrFlt: fl.number,
      arrOrigin: fl.origin,
      depFlt: fl.number,
      depDest: fl.dest,
      flightId: fl.flightDocId,
      status: 'pending',
      staff: [],
      taskDays: 0,
      comments: '',
      attachments: [],
      linkedTasks: [],             // No planificación aún
      station: station,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      autoGenerated: true
    });
  }
  if(!batch.length){ toast('No hay días que correspondan con los días seleccionados'); return; }
  const col = FB.db.collection(AIRLINE_ID).doc(station).collection('tasks');
  toast('Procesando '+batch.length+' OTs...');
  let created=0, updated=0;
  for(const task of batch){
    try{
      const existing = await col.where('ac','==',task.ac).where('taskDate','==',task.taskDate).get();
      if(!existing.empty){
        const existData = existing.docs[0].data();
        // Only update start if OT is TRANSITO (not a real work order)
        const updateData = {
          gs:task.gs, ge:task.ge,
          arrFlt:task.arrFlt, arrOrigin:task.arrOrigin,
          depFlt:task.depFlt, depDest:task.depDest,
          flightId:task.flightId, updatedAt:Date.now()
        };
        if(existData.wo==='TRANSITO'||!existData.wo||existData.autoGenerated){
          updateData.start = task.gs;  // sync maintenance start to ETA
          updateData.dur = 30;         // reset to 30min transit
        }
        await col.doc(existing.docs[0].id).update(updateData);
        updated++;
      } else {
        await col.add(task);
        created++;
      }
    }catch(e){ await col.add(task); created++; }
  }
  toast('✅ '+created+' creadas · '+updated+' gs actualizados — '+fl.number+' · '+fl.ac);
  // Wait for Firestore subscription to receive the new tasks
  setTimeout(()=>{ renderGantt(); }, 2000);
}


// ── Flight day toggle ──
function toggleFlDay(btn){
  btn.classList.toggle('active');
}

async function submitFlight(){
  const modal = document.getElementById('modal-flight');
  const flType = modal._flType || 'arr';
  const editId = modal._editId;
  const station = document.getElementById('flights-station-filter')?.value || activeStation();
  const days  = [...document.querySelectorAll('.day-btn.active')].map(b=>parseInt(b.dataset.day));
  const notes = (document.getElementById('fl-notes')?.value||'').trim();

  let data;
  if(flType==='arr'){
    const number = (document.getElementById('fl-arr-num')?.value||'').trim().toUpperCase();
    const origin = (document.getElementById('fl-arr-origin')?.value||'').trim().toUpperCase();
    const eta    = document.getElementById('fl-arr-eta')?.value||'';
    if(!number||!origin||!eta){ toast('Completa número, origen y ETA',true); return; }
    data = {type:'arr', number, origin, eta, station, days, notes, updatedAt:Date.now()};
  } else {
    const number = (document.getElementById('fl-dep-num')?.value||'').trim().toUpperCase();
    const dest   = (document.getElementById('fl-dep-dest')?.value||'').trim().toUpperCase();
    const etd    = document.getElementById('fl-dep-etd')?.value||'';
    if(!number||!dest||!etd){ toast('Completa número, destino y ETD',true); return; }
    data = {type:'dep', number, dest, etd, station, days, notes, updatedAt:Date.now()};
  }

  const col = FB.db.collection(AIRLINE_ID).doc(station).collection('flights');
  if(editId){ await col.doc(editId).update(data); }
  else { await col.add(data); }
  toast('✅ '+(flType==='arr'?'🛬 Llegada':'🛫 Salida')+' '+data.number+' guardado');
  closeFlightModal();
  loadFlights(station);
}


async function deleteFlight(id,station){
  if(!confirm('¿Eliminar este vuelo?')) return;
  await FB.db.collection(AIRLINE_ID).doc(station).collection('flights').doc(id).delete();
  toast('Vuelo eliminado'); loadFlights(station);
}

function flightTimeToMins(t){ if(!t) return 0; const [h,m]=(t||'00:00').split(':').map(Number); return h*60+m; }



// ── Quick edit ETA/ETD from Gantt ──
function quickEditTimes(taskId, ac){
  const t = tasks.find(x=>x.id===taskId);
  if(!t) return;
  const st = activeStation();
  const overlay = document.createElement('div');
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.4);z-index:9998';
  const dlg = document.createElement('div');
  dlg.style.cssText = 'position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);background:#fff;border-radius:14px;padding:24px;box-shadow:0 8px 40px rgba(0,0,0,.25);z-index:9999;min-width:320px';
  const etaVal = hhmm(t.gs), etdVal = hhmm(t.ge);
  dlg.innerHTML = '<div style="font-size:15px;font-weight:800;color:#0f2a66;margin-bottom:16px">🕐 Cambiar horario — ' + esc(ac) + '</div>' +
    '<div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:16px">' +
    '<div><label style="font-size:11px;font-weight:700;color:#64748b;display:block;margin-bottom:4px">ETA</label>' +
    '<input id="qe-eta" type="time" value="' + etaVal + '" style="width:100%;padding:8px;border:1.5px solid #e2e8f0;border-radius:8px;font-size:14px;font-weight:700"></div>' +
    '<div><label style="font-size:11px;font-weight:700;color:#64748b;display:block;margin-bottom:4px">ETD</label>' +
    '<input id="qe-etd" type="time" value="' + etdVal + '" style="width:100%;padding:8px;border:1.5px solid #e2e8f0;border-radius:8px;font-size:14px;font-weight:700"></div>' +
    '</div>' +
    '<div style="display:flex;gap:8px">' +
    '<button id="qe-save" style="flex:1;background:#0f2a66;color:#fff;border:none;padding:10px;border-radius:8px;font-weight:700;cursor:pointer">💾 Guardar</button>' +
    '<button id="qe-cancel" style="flex:1;background:#f1f5f9;color:#64748b;border:none;padding:10px;border-radius:8px;font-weight:700;cursor:pointer">Cancelar</button>' +
    '</div>';
  document.body.appendChild(overlay);
  document.body.appendChild(dlg);
  const close = () => { document.body.removeChild(dlg); document.body.removeChild(overlay); };
  overlay.onclick = close;
  document.getElementById('qe-cancel').onclick = close;
  document.getElementById('qe-save').onclick = async () => {
    const eta = document.getElementById('qe-eta').value;
    const etd = document.getElementById('qe-etd').value;
    if(!eta||!etd){ toast('ETA y ETD son requeridos',true); return; }
    const [eh,em]=eta.split(':').map(Number);
    const [dh,dm]=etd.split(':').map(Number);
    try {
      await FB.db.collection(AIRLINE_ID).doc(st).collection('tasks').doc(taskId)
        .update({gs:eh*60+em, ge:dh*60+dm, updatedAt:Date.now()});
      close();
      toast('✅ ' + esc(ac) + ' · ETA ' + eta + ' · ETD ' + etd + ' actualizados');
    } catch(e){ toast('Error: '+e.message, true); }
  };
}


function _flightEdit(id){ openFlightModal(flightsData.find(function(f){return f.id===id;})); }
function _flightDel(id,st){ deleteFlight(id,st); }

async function renderFlightsView(){
  console.log('[Vuelos] renderFlightsView start, role:', currentRole);
  const listEl = document.getElementById('flights-list');
  if(!listEl){ console.error('[Vuelos] flights-list NOT FOUND'); return; }
  const stEl = document.getElementById('flights-station-filter');
  if(stEl && !stEl.options.length){
    stations.forEach(s => {
      const o = document.createElement('option');
      o.value = s.code; o.textContent = s.code; stEl.appendChild(o);
    });
    stEl.value = window._station || activeStation();
  }
  const station = stEl ? stEl.value : (activeStation());
  const canEdit = currentRole === 'superadmin';
  console.log('[Vuelos] canEdit:', canEdit);

  // Load ALL flights for station
  try {
    const snap = await FB.db.collection(AIRLINE_ID).doc(station).collection('flights').get();
    flightsData = snap.docs.map(d => ({id: d.id, ...d.data()}))
      .sort((a,b) => (a.eta||a.etd||'').localeCompare(b.eta||b.etd||''));
  } catch(e) { console.warn('[Vuelos] load error:', e.message); flightsData = []; }

  const sub = document.getElementById('flights-subtitle');
  if(sub) sub.textContent = station + ' · ' + flightsData.length + ' vuelos programados';

  const DAY_NAMES = ['Domingo','Lunes','Martes','Miércoles','Jueves','Viernes','Sábado'];
  const DAY_SHORT = ['D','L','M','X','J','V','S'];
  const DAY_COLORS = ['#f3e8ff','#dbeafe','#dcfce7','#fef9c3','#ffe4e6','#e0f2fe','#f0fdf4'];
  const DAY_BORDER = ['#c084fc','#60a5fa','#4ade80','#fde047','#fb7185','#38bdf8','#86efac'];

  // Build the add button
  const addBtnHtml = canEdit
    ? '<div style="margin-bottom:16px;display:flex;gap:10px">' +
      '<button onclick="openFlightModal(null,\'arr\')" style="background:#1e40af;color:#fff;border:none;padding:10px 20px;border-radius:10px;font-size:13px;font-weight:700;cursor:pointer">🛬 + Llegada</button>' +
      '<button onclick="openFlightModal(null,\'dep\')" style="background:#166534;color:#fff;border:none;padding:10px 20px;border-radius:10px;font-size:13px;font-weight:700;cursor:pointer">🛫 + Salida</button>' +
      '</div>'
    : '';

  if(!flightsData.length){
    listEl.innerHTML = addBtnHtml + '<div style="text-align:center;padding:40px;color:#94a3b8;font-size:12px">No hay vuelos creados aún.</div>';
    console.log('[Vuelos] innerHTML set, length:', listEl.innerHTML.length, 'visible:', listEl.offsetParent !== null);
    return;
  }

  // Build weekly calendar: 7 day columns
  const parts = [addBtnHtml];
  parts.push('<div style="display:grid;grid-template-columns:repeat(7,1fr);gap:10px;min-width:900px">');

  for(let d=0; d<7; d++){
    // Debug: log all flights for this day
    if(d===2) console.log('[Vuelos] Day',d,'total flights:', flightsData.length, 'types:', flightsData.map(f=>f.type+':'+f.number));
    const dayFlights = flightsData.filter(f => {
        const fDays = f.days;
        if(!fDays||!fDays.length) return true; // no days = all days
        return fDays.includes(d);
      }).sort((a,b) => (a.eta||a.etd||'').localeCompare(b.eta||b.etd||''));
    const today = new Date().getDay();
    const isToday = d === today;

    parts.push('<div style="border-radius:12px;overflow:hidden;border:2px solid '+(isToday?'#0f2a66':DAY_BORDER[d])+'">');
    // Day header
    parts.push('<div style="background:'+(isToday?'#0f2a66':DAY_COLORS[d])+';padding:10px 8px;text-align:center">');
    parts.push('<div style="font-size:13px;font-weight:900;color:'+(isToday?'#fff':'#1e293b')+'">'+DAY_NAMES[d]+'</div>');
    parts.push('<div style="font-size:11px;color:'+(isToday?'#93c5fd':'#64748b')+'">'+dayFlights.length+' vuelo'+(dayFlights.length!==1?'s':'')+'</div>');
    parts.push('</div>');

    // Flights for this day
    parts.push('<div style="background:#fff;padding:6px">');
    if(!dayFlights.length){
      parts.push('<div style="text-align:center;padding:20px 4px;color:#cbd5e1;font-size:10px">Sin vuelos</div>');
    } else {
      dayFlights.forEach(function(f){
        parts.push('<div style="margin-bottom:6px;border-radius:8px;background:#f8fafc;padding:8px;border-left:3px solid #0f2a66">');
        // Flight number + AC
        parts.push('<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:4px">');
        const isArr = f.type==='arr'||!f.type;
        const isDep = f.type==='dep';
        parts.push('<span style="font-weight:900;font-family:monospace;font-size:13px;color:'+(isArr?'#1e40af':'#166534')+'">'+(isArr?'🛬':'🛫')+esc(f.number)+'</span>');

        parts.push('</div>');
        // Route
        parts.push('<div style="display:flex;align-items:center;gap:3px;font-size:10px;font-weight:700;margin-bottom:5px">');
        if(isArr){
          parts.push('<span style="background:#dbeafe;color:#1e40af;padding:1px 6px;border-radius:4px">'+esc(f.origin||'?')+'</span>');
          parts.push('<span style="color:#94a3b8">→</span>');
          parts.push('<span style="background:#1e40af;color:#fff;padding:1px 6px;border-radius:4px">'+(station||activeStation())+'</span>');
        } else {
          parts.push('<span style="background:#166534;color:#fff;padding:1px 6px;border-radius:4px">'+(station||activeStation())+'</span>');
          parts.push('<span style="color:#94a3b8">→</span>');
          parts.push('<span style="background:#dcfce7;color:#166534;padding:1px 6px;border-radius:4px">'+esc(f.dest||'?')+'</span>');
        }
        parts.push('</div>');
        // ETA / ETD
        parts.push('<div style="text-align:center;background:'+(isArr?'#eff6ff':'#f0fdf4')+';border-radius:6px;padding:6px">');
        parts.push('<div style="font-size:9px;color:'+(isArr?'#1e40af':'#166534')+';font-weight:700">'+(isArr?'🛬 ETA':'🛫 ETD')+'</div>');
        parts.push('<div style="font-size:20px;font-weight:900;color:#0f2a66">'+esc(isArr?(f.eta||'--:--'):(f.etd||'--:--'))+'</div>');
        parts.push('</div>');
        // Edit/delete for superadmin
        if(canEdit){
          parts.push('<div style="display:flex;gap:4px;margin-top:5px;justify-content:flex-end">');
          parts.push('<button data-flid="'+f.id+'" onclick="_flightEdit(this.dataset.flid)" style="background:'+(isArr?'#eff6ff':'#f0fdf4')+';border:none;color:'+(isArr?'#1e40af':'#166534')+';padding:2px 8px;border-radius:4px;cursor:pointer;font-size:10px">✏️ Editar</button>');
          parts.push('<button data-flid="'+f.id+'" data-flst="'+station+'" onclick="_flightDel(this.dataset.flid,this.dataset.flst)" style="background:#fee2e2;border:none;color:#dc2626;padding:2px 8px;border-radius:4px;cursor:pointer;font-size:10px">🗑</button>');
          parts.push('</div>');
        }
        parts.push('</div>');
      });
    }
    parts.push('</div></div>');
  }
  parts.push('</div>');
  listEl.innerHTML = parts.join('');
  console.log('[Vuelos] rendered', flightsData.length, 'flights in weekly view');
}


// ── Populate flight datalists when modal opens ──
function populateFlightDataLists(){
  ['fl-arr-list','fl-dep-list'].forEach(id=>{
    const dl = document.getElementById(id);
    if(!dl||!flightsData) return;
    dl.innerHTML = flightsData.map(f=>
      '<option value="'+esc(f.number)+'">'+esc(f.number)+
      ' | '+esc(f.origin||'?')+'→'+esc(f.dest||'?')+
      ' ETA:'+esc(f.eta||'--:--')+' ETD:'+esc(f.etd||'--:--')+'</option>'
    ).join('');
  });
}
function autoFillFlightFromAC(ac){ populateFlightDataLists(); }

function openFlightModal(f, type){
  // type: 'arr' = llegada, 'dep' = salida
  // When editing, detect type from saved data
  const flType = f ? (f.type||'arr') : (type||'arr');
  document.getElementById('modal-flight')._editId = f?.id||null;
  document.getElementById('modal-flight')._flType = flType;
  // Show/hide sections
  document.getElementById('fl-section-arr').style.display = flType==='arr' ? 'block' : 'none';
  document.getElementById('fl-section-dep').style.display = flType==='dep' ? 'block' : 'none';
  // Set title
  document.getElementById('flight-modal-title').textContent = 
    f ? (flType==='arr' ? '✏️ Editar llegada' : '✏️ Editar salida')
      : (flType==='arr' ? '🛬 Nueva llegada' : '🛫 Nueva salida');
  // Fill fields
  const set = (id,v) => { const el=document.getElementById(id); if(el) el.value=v||''; };
  if(flType==='arr'){
    set('fl-arr-num',    f?.number||'');
    set('fl-arr-origin', f?.origin||'');
    set('fl-arr-eta',    f?.eta||'');
  } else {
    set('fl-dep-num',    f?.number||'');
    set('fl-dep-dest',   f?.dest||'');
    set('fl-dep-etd',    f?.etd||'');
  }
  set('fl-notes', f?.notes||'');
  document.querySelectorAll('.day-btn').forEach(b=>{
    b.classList.toggle('active',(f?.days||[]).includes(parseInt(b.dataset.day)));
  });
  document.getElementById('modal-flight').style.display='flex';
}


function sbConfigured(){ return SUPABASE_URL && SUPABASE_KEY; }

function saveSBConfig(){
  const u = document.getElementById('sb-url-inp').value.trim().replace(/\/$/,'');
  const k = document.getElementById('sb-key-inp').value.trim();
  if(!u||!k){ toast('⚠ Completa URL y Key de Supabase', true); return; }
  if(k.length < 100){ toast('⚠ La key parece muy corta — pega el anon key completo (empieza con eyJ...)', true); return; }
  SUPABASE_URL = u; SUPABASE_KEY = k;
  localStorage.setItem('airtechassist_sb_url', u);
  localStorage.setItem('airtechassist_sb_key', k);
  console.log('[Supabase] Saved — URL:', u, '| Key prefix:', k.substring(0,20)+'...');
  document.getElementById('sb-config-panel').style.display='none';
  document.getElementById('sb-status-bar').style.display='flex';
  document.getElementById('sb-project-name').textContent = u.replace('https://','').split('.')[0];
  toast('✅ Supabase configurado — ya puedes subir archivos');
}

function clearSBConfig(){
  localStorage.removeItem('airtechassist_sb_url'); localStorage.removeItem('airtechassist_sb_key');
  SUPABASE_URL=''; SUPABASE_KEY='';
  document.getElementById('sb-config-panel').style.display='block';
  document.getElementById('sb-status-bar').style.display='none';
}

// ── Ensure Supabase bucket exists (creates it if not) ──
async function ensureBucket(sbUrl, key){
  // Try to create bucket (idempotent — ignores error if already exists)
  try{
    await fetch(`${sbUrl}/storage/v1/bucket`, {
      method: 'POST',
      headers:{
        'Authorization':'Bearer '+key,
        'apikey': key,
        'Content-Type':'application/json'
      },
      body: JSON.stringify({id:SB_BUCKET, name:SB_BUCKET, public:true})
    });
    // 200 = created, 409 = already exists — both OK
  }catch(e){ console.log('[Supabase] Bucket check done'); }
}

// ── Upload file to Supabase Storage ──
async function uploadToSupabase(file, folder){
  const key   = localStorage.getItem('airtechassist_sb_key') || SB_DEFAULT_KEY;
  const sbUrl = (localStorage.getItem('airtechassist_sb_url') || SB_DEFAULT_URL).replace(/\/$/,'');

  // Create bucket if needed
  await ensureBucket(sbUrl, key);

  const safe = file.name.replace(/[^a-zA-Z0-9._-]/g,'_');
  const path = `${folder}/${Date.now()}_${safe}`;
  const uploadUrl = `${sbUrl}/storage/v1/object/${SB_BUCKET}/${path}`;

  console.log('[Supabase] Uploading:', file.name, '→', path);

  // Use FormData — most compatible across browsers and iOS
  const fd = new FormData();
  fd.append('', file, file.name);

  const resp = await fetch(uploadUrl, {
    method : 'POST',
    headers: {
      'Authorization': 'Bearer ' + key,
      'apikey'       : key,
      'x-upsert'     : 'true'
      // No Content-Type here — browser sets it automatically with boundary for FormData
    },
    body: fd
  });

  if(!resp.ok){
    const errText = await resp.text();
    console.error('[Supabase] Upload failed:', resp.status, errText);
    // If FormData failed, try raw binary as fallback
    const resp2 = await fetch(uploadUrl, {
      method : 'POST',
      headers:{
        'Authorization': 'Bearer '+key,
        'apikey'       : key,
        'Content-Type' : file.type||'application/octet-stream',
        'x-upsert'     : 'true'
      },
      body: file
    });
    if(!resp2.ok){
      const err2 = await resp2.text();
      throw new Error('Supabase error '+resp2.status+': '+err2.substring(0,200));
    }
  }

  const publicUrl = `${sbUrl}/storage/v1/object/public/${SB_BUCKET}/${path}`;
  console.log('[Supabase] ✅ Uploaded:', publicUrl);
  return { url: publicUrl, path };
}

// ══ FASE 1 SEGURIDAD — Auth real + hashing + rate limiting + audit ══

// ══════════════════════════════════════════════════════
// REPORTE EJECUTIVO DIARIO — PDF
// ══════════════════════════════════════════════════════
async function generateDailyReport(){
  if(typeof window.jspdf === 'undefined' && typeof jsPDF === 'undefined'){
    toast('jsPDF no está disponible', true); return;
  }
  const { jsPDF } = window.jspdf || window;
  const doc = new jsPDF({ orientation:'portrait', unit:'mm', format:'a4' });
  const st = window._station || activeStation();
  const date = selectedDate || localDateStr();
  const dateFmt = new Date(date+'T12:00:00').toLocaleDateString('es-DO',{weekday:'long',year:'numeric',month:'long',day:'numeric'});
  const dt = dayTasks();
  const W = 210, margin = 14;

  // ── HEADER ──
  doc.setFillColor(15, 42, 102);
  doc.rect(0, 0, W, 28, 'F');
  doc.setTextColor(255,255,255);
  doc.setFont('helvetica','bold');
  doc.setFontSize(16);
  doc.text('REPORTE OPERACIONAL DIARIO', margin, 12);
  doc.setFontSize(9);
  doc.setFont('helvetica','normal');
  doc.text(`${window._airlineName||'AirTech Assist'} — Control de Mantenimiento`, margin, 19);
  doc.text('Base: '+st+'   |   Fecha: '+dateFmt, margin, 25);

  // ── KPIs ──
  const entregadas = dt.filter(t=>t.status==='entregada').length;
  const isLate = (t) => {
    if(t.status!=='entregada'||!t.deliveredAt||!t.ge) return false;
    const m=t.deliveredAt.match(/([0-9]{1,2}):([0-9]{2})(?:[ ]*([ap][.]?[ ]*m[.]?))?/i);
    if(!m) return false;
    let h=parseInt(m[1]),mn=parseInt(m[2]);
    if(m[3]&&/p/i.test(m[3])&&h!==12) h+=12;
    if(m[3]&&!/p/i.test(m[3])&&h===12) h=0;
    return (h*60+mn)>t.ge;
  };
  const demoras = dt.filter(t=>isLate(t)).length;
  const onTime = entregadas - demoras;
  const otp = dt.length>0 ? Math.round((onTime/dt.length)*100) : 100;
  const aogs = dt.filter(t=>t.aog).length;

  let y = 36;
  doc.setFillColor(248,250,252);
  doc.roundedRect(margin, y, W-margin*2, 24, 3, 3, 'F');

  const kpis = [
    {label:'OTs del día', value:dt.length, color:[15,42,102]},
    {label:'Entregadas', value:entregadas, color:[22,101,52]},
    {label:'Demoras', value:demoras, color:demoras>0?[220,38,38]:[100,116,139]},
    {label:'OTP', value:otp+'%', color:otp>=85?[22,101,52]:otp>=70?[180,83,9]:[220,38,38]},
    {label:'AOG', value:aogs, color:aogs>0?[157,23,77]:[100,116,139]},
  ];
  const kW = (W-margin*2)/kpis.length;
  kpis.forEach((k,i)=>{
    const x = margin + i*kW + kW/2;
    doc.setFont('helvetica','bold');
    doc.setFontSize(16);
    doc.setTextColor(...k.color);
    doc.text(String(k.value), x, y+12, {align:'center'});
    doc.setFontSize(7);
    doc.setFont('helvetica','normal');
    doc.setTextColor(100,116,139);
    doc.text(k.label, x, y+19, {align:'center'});
  });

  // ── DETALLE OTS ──
  y += 30;
  doc.setFont('helvetica','bold');
  doc.setFontSize(10);
  doc.setTextColor(15,42,102);
  doc.text('DETALLE DE ÓRDENES DE TRABAJO', margin, y);
  y += 4;

  const rows = dt.map(t => {
    const buf = t.ge-(t.start+t.dur);
    const late = isLate(t);
    return [
      t.ac||'—',
      t.wo||'TRANSITO',
      (t.arrOrigin||'?')+'→'+st+'→'+(t.depDest||'?'),
      hhmm(t.gs)+' → '+hhmm(t.ge),
      t.deliveredAt||(t.status==='entregada'?'✓':'—'),
      late?'⚠ DEMORA':t.status==='entregada'?'✓ OK':t.status==='en trabajo'?'En trabajo':'Pendiente',
    ];
  });

  doc.autoTable({
    startY: y,
    head: [['Aeronave','WO','Ruta','Slot','Entrega','Estado']],
    body: rows,
    margin:{left:margin, right:margin},
    styles:{fontSize:8, cellPadding:2},
    headStyles:{fillColor:[15,42,102], textColor:255, fontStyle:'bold', fontSize:8},
    columnStyles:{
      0:{cellWidth:20, fontStyle:'bold'},
      1:{cellWidth:30},
      2:{cellWidth:38},
      3:{cellWidth:28},
      4:{cellWidth:18},
      5:{cellWidth:25},
    },
    didParseCell: (data) => {
      if(data.section==='body' && data.column.index===5){
        const v = data.cell.raw;
        if(v&&v.includes('DEMORA')) data.cell.styles.textColor=[220,38,38];
        else if(v&&v.includes('OK')) data.cell.styles.textColor=[22,101,52];
      }
    }
  });

  y = doc.lastAutoTable.finalY + 8;

  // ── TÉCNICOS EN TURNO ──
  const _now=new Date();
  const _mkey=_now.getFullYear()+'-'+String(_now.getMonth()+1).padStart(2,'0');
  const _skey=_mkey+'-'+st;
  const _sched=scheduleData[_skey];
  if(_sched && _sched.personnel){
    const dayNum=new Date(date+'T12:00:00').getDate();
    const shiftCount={A:0,B:0,C:0,ADM:0};
    _sched.personnel.forEach(p=>{
      const day=p.schedule?.[String(dayNum)];
      if(!day||!day.working) return;
      const base=(day.code||'')[0];
      if(base==='A') shiftCount.A++;
      else if(base==='B') shiftCount.B++;
      else if(base==='C') shiftCount.C++;
      else if(day.code==='ADM') shiftCount.ADM++;
    });
    const total=shiftCount.A+shiftCount.B+shiftCount.C+shiftCount.ADM;

    if(y > 240){ doc.addPage(); y=14; }
    doc.setFont('helvetica','bold');
    doc.setFontSize(10);
    doc.setTextColor(15,42,102);
    doc.text('PERSONAL EN TURNO', margin, y);
    y+=6;
    doc.setFont('helvetica','normal');
    doc.setFontSize(9);
    doc.setTextColor(30,41,59);
    doc.text('Total en turno: '+total+' técnicos', margin, y);
    y+=5;
    const shifts = [
      {label:'Turno A (05-14h)', count:shiftCount.A, color:[59,130,246]},
      {label:'Turno B (13-22h)', count:shiftCount.B, color:[245,158,11]},
      {label:'Turno C (21-06h)', count:shiftCount.C, color:[139,92,246]},
      {label:'Administrativo',   count:shiftCount.ADM, color:[34,197,94]},
    ].filter(s=>s.count>0);
    shifts.forEach(s=>{
      doc.setFillColor(...s.color);
      doc.roundedRect(margin, y, 40, 8, 2, 2, 'F');
      doc.setFont('helvetica','bold');
      doc.setFontSize(8);
      doc.setTextColor(255,255,255);
      doc.text(s.label+': '+s.count, margin+20, y+5.5, {align:'center'});
      y+=11;
    });
  }

  // ── FOOTER ──
  const pageH = doc.internal.pageSize.height;
  doc.setFillColor(15,42,102);
  doc.rect(0, pageH-10, W, 10, 'F');
  doc.setFont('helvetica','normal');
  doc.setFontSize(7);
  doc.setTextColor(255,255,255);
  doc.text(`${window._airlineName||'AirTech Assist'} — Generado el `+new Date().toLocaleString('es-DO'), margin, pageH-3);
  doc.text('Confidencial — Solo para uso interno', W-margin, pageH-3, {align:'right'});

  // Save
  const fileName = 'Reporte_Operacional_'+st+'_'+date+'.pdf';
  doc.save(fileName);
  toast('✅ Reporte PDF generado: '+fileName);
}

// ══ PLATFORM ADMIN — gestión de clientes ══════════════════════

async function loadPlatformClients(){
  const tbody=document.getElementById('platform-tbody');
  const countEl=document.getElementById('platform-count');
  const statsEl=document.getElementById('platform-stats');
  if(!tbody) return;
  tbody.innerHTML='<tr><td colspan="6" style="text-align:center;padding:24px;color:#94a3b8">Cargando...</td></tr>';

  try{
    const snap=await FB.db.collection('platform').doc('clients').collection('list').orderBy('createdAt','desc').get();
    const clients=snap.docs.map(d=>({id:d.id,...d.data()}));

    if(countEl) countEl.textContent=clients.length+' cliente'+(clients.length!==1?'s':'');

    // Stats
    const byPlan={Gratis:0,Básico:0,Pro:0};
    clients.forEach(c=>{ const k=c.plan||'Gratis'; if(byPlan[k]!==undefined) byPlan[k]++; });
    if(statsEl) statsEl.innerHTML=Object.entries(byPlan).map(([p,n])=>`
      <div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:10px;padding:12px;text-align:center">
        <div style="font-size:22px;font-weight:800;color:#0f2a66">${n}</div>
        <div style="font-size:11px;color:#64748b;margin-top:2px">${p}</div>
      </div>`).join('')+`
      <div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:10px;padding:12px;text-align:center">
        <div style="font-size:22px;font-weight:800;color:#0f2a66">${clients.length}</div>
        <div style="font-size:11px;color:#64748b;margin-top:2px">Total</div>
      </div>`;

    if(!clients.length){
      tbody.innerHTML='<tr><td colspan="6" style="text-align:center;padding:24px;color:#94a3b8">Sin clientes registrados aún</td></tr>';
      return;
    }

    const planColors={Gratis:'background:#f0fdf4;color:#166534',Básico:'background:#eff6ff;color:#1e40af',Pro:'background:#f5f3ff;color:#6d28d9'};
    tbody.innerHTML=clients.map(c=>{
      const url=`https://airtech-assist.web.app/app?client=${c.clientId}`;
      const fecha=c.createdAt?new Date(c.createdAt).toLocaleDateString('es-DO',{day:'2-digit',month:'short',year:'numeric'}):'—';
      const planStyle=planColors[c.plan||'Gratis']||planColors.Gratis;
      return `<tr style="border-bottom:1px solid #f1f5f9;transition:background .15s" onmouseover="this.style.background='#f8fafc'" onmouseout="this.style.background=''">
        <td style="padding:10px 12px">
          <div style="font-weight:600;color:#1e293b">${esc(c.airlineName||'—')}</div>
          <div style="font-size:10px;color:#94a3b8;font-family:monospace">${esc(c.clientId||'')}</div>
        </td>
        <td style="padding:10px 12px;color:#475569">${esc(c.adminEmail||'—')}</td>
        <td style="padding:10px 12px">
          <select onchange="updateClientPlan('${c.clientId}',this.value,this)"
            style="padding:4px 8px;border-radius:6px;border:1px solid #e2e8f0;font-size:11px;font-weight:700;${planStyle};cursor:pointer">
            ${['Gratis','Básico','Pro'].map(p=>`<option value="${p}"${(c.plan||'Gratis')===p?' selected':''}>${p}</option>`).join('')}
          </select>
        </td>
        <td style="padding:10px 12px;color:#64748b;font-size:11px">${fecha}</td>
        <td style="padding:10px 12px">
          <label style="display:flex;align-items:center;gap:6px;cursor:pointer">
            <input type="checkbox" ${c.active!==false?'checked':''} onchange="toggleClientActive('${c.clientId}',this.checked)"
              style="width:16px;height:16px;cursor:pointer">
            <span style="font-size:11px;color:${c.active!==false?'#166534':'#dc2626'}">${c.active!==false?'Activo':'Inactivo'}</span>
          </label>
        </td>
        <td style="padding:10px 12px">
          <button onclick="navigator.clipboard.writeText('${url}');toast('✅ URL copiada')"
            style="padding:5px 10px;background:#0f2a66;color:#fff;border:none;border-radius:6px;font-size:11px;font-weight:600;cursor:pointer">
            Copiar URL
          </button>
        </td>
      </tr>`;
    }).join('');
  }catch(e){
    tbody.innerHTML=`<tr><td colspan="6" style="text-align:center;padding:24px;color:#dc2626">Error: ${e.message}</td></tr>`;
    console.error('[Platform]',e);
  }
}

async function updateClientPlan(clientId, plan, selectEl){
  if(!clientId||!plan) return;
  try{
    const batch=FB.db.batch();
    batch.update(FB.db.collection('platform').doc('clients').collection('list').doc(clientId),{plan});
    batch.update(FB.db.collection(clientId).doc('config'),{plan});
    await batch.commit();
    toast('✅ Plan actualizado a '+plan);
    // Update select color
    const planColors={Gratis:'background:#f0fdf4;color:#166534',Básico:'background:#eff6ff;color:#1e40af',Pro:'background:#f5f3ff;color:#6d28d9'};
    if(selectEl) selectEl.style.cssText=selectEl.style.cssText.replace(/background:[^;]+;color:[^;]+/,planColors[plan]||'');
  }catch(e){
    toast('❌ Error: '+e.message, true);
  }
}

async function toggleClientActive(clientId, active){
  if(!clientId) return;
  try{
    await FB.db.collection('platform').doc('clients').collection('list').doc(clientId).update({active});
    toast(active?'✅ Cliente activado':'⚠ Cliente desactivado');
  }catch(e){
    toast('❌ Error: '+e.message, true);
  }
}


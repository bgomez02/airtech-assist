// ── State variables ──
let dbCharts={}, dbSortCol='taskDate', dbSortDir=1, dbHistory=[];

const dbLocalDate=(d=new Date())=>{const y=d.getFullYear(),m=String(d.getMonth()+1).padStart(2,'0'),dy=String(d.getDate()).padStart(2,'0');return`${y}-${m}-${dy}`};
const dbFmtDate=d=>{try{return new Date(d+'T12:00:00').toLocaleDateString('es-DO',{day:'2-digit',month:'short'})}catch(_){return d}}

// ══ DASHBOARD — Analíticas y Reportes — AirTec Assist ══
// Chart.js, KPIs históricos, exportación CSV

function dbSetRange(days){
  const to=new Date(),from=new Date();
  from.setDate(from.getDate()-(days-1));
  document.getElementById('db-to').value=dbLocalDate(to);
  document.getElementById('db-from').value=dbLocalDate(from);
  renderDashboard();
}

async function renderDashboard(){
  const fromEl=document.getElementById('db-from');
  const toEl=document.getElementById('db-to');
  // Init dates on first open
  if(!fromEl.value){
    const to=new Date(),from=new Date();
    from.setDate(from.getDate()-29);
    toEl.value=dbLocalDate(to);
    fromEl.value=dbLocalDate(from);
  }
  const from=fromEl.value, to=toEl.value;
  const st=window._station||'PUJ';
  document.getElementById('db-status').textContent='Cargando...';

  // Load history from Firestore for date range
  try{
    const snap=await FB.db.collection(AIRLINE_ID).doc(st).collection('history')
      .where('date','>=',from).where('date','<=',to).orderBy('date').get();
    dbHistory=snap.docs.map(d=>({id:d.id,...d.data()}));
  }catch(e){ dbHistory=[]; }

  // Use in-memory tasks[] (subscribeAll loads ALL tasks with no date filter)
  // Fall back to Firestore query only if tasks[] is empty
  // Helper: normalize taskDate to YYYY-MM-DD string regardless of format
  const normDate = v => {
    if(!v) return '';
    if(typeof v === 'string') return v.substring(0,10);
    if(v.toDate) return v.toDate().toISOString().substring(0,10); // Firestore Timestamp
    if(v.seconds) return new Date(v.seconds*1000).toISOString().substring(0,10);
    return String(v).substring(0,10);
  };

  // Always query Firestore fresh for the date range
  let dbTasks = [];
  try {
    const tSnap = await FB.db.collection(AIRLINE_ID).doc(st).collection('tasks').get();
    dbTasks = tSnap.docs.map(d=>({id:d.id,...d.data()})).filter(t => {
      const td = normDate(t.taskDate);
      return td >= from && td <= to;
    });
    // Load plan tasks for completed tasks chart
    try {
      const pSnap = await FB.db.collection(AIRLINE_ID).doc(st).collection('plans').get();
      window._dbPlans = pSnap.docs.map(d=>({id:d.id,...d.data()}));
    } catch(e) { window._dbPlans = []; }
  } catch(e) {
    // Fall back to in-memory
    console.warn('[Dashboard] Firestore failed:', e.message);
    const allInMemory = typeof tasks !== 'undefined' ? tasks : [];
    dbTasks = allInMemory.filter(t => normDate(t.taskDate) >= from && normDate(t.taskDate) <= to);
  }

  window._dbTasksCache = dbTasks;
  const statusEl = document.getElementById('db-status');
  if(statusEl) statusEl.textContent = dbTasks.length + ' OTs · ' + from.substring(5) + ' → ' + to.substring(5);
  if(typeof toast==='function') toast('📊 Dashboard: ' + dbTasks.length + ' OTs cargadas');
  const acFilter=document.getElementById('db-ac-filter').value;

  // Populate AC filter
  const acSel=document.getElementById('db-ac-filter');
  const prevAC=acSel.value;
  acSel.innerHTML='<option value="">Todas</option>';
  [...new Set(dbTasks.map(t=>t.ac).filter(Boolean))].sort()
    .forEach(ac=>{const o=document.createElement('option');o.value=ac;o.textContent=ac;acSel.appendChild(o);});
  if(prevAC) acSel.value=prevAC;

  const filtered=acFilter?dbTasks.filter(t=>t.ac===acFilter):dbTasks;

  document.getElementById('db-status').textContent=`${filtered.length} OTs · ${[...new Set(filtered.map(t=>t.taskDate))].length} días`;

  try{ dbUpdateKPIs(filtered); }catch(e){ console.error('KPIs:',e); }
  window._dbFilteredTasks = filtered;
  try{ dbUpdateCharts(filtered); }catch(e){ console.error('Charts:',e); }
  try{ dbRenderHeatmap(); }catch(e){ console.error('Heatmap:',e); }
  try{ dbRenderOTTable(filtered); }catch(e){ console.error('Table:',e); }
  try{ dbRenderRoster(filtered); }catch(e){ console.error('Roster:',e); }
}

function dbUpdateKPIs(t){
  const acs=new Set(t.map(x=>x.ac));
  const totalHH=t.reduce((s,x)=>{
    const cap=(x.staff||[]).reduce((a,id)=>{const tech=techs.find(z=>z.id===id);return a+(tech?.hours||0)},0);
    return s+(x.dur||0)/60*(cap/6||1);
  },0);
  const avgDur=t.length?Math.round(t.reduce((s,x)=>s+(x.dur||0),0)/t.length):0;
  const peak=dbHistory.reduce((mx,h)=>Math.max(mx,...(h.hrs||[0])),0);
  document.getElementById('db-kv1').textContent=t.length;
  document.getElementById('db-kv1s').textContent=[...new Set(t.map(x=>x.taskDate))].length+' días activos';
  document.getElementById('db-kv2').textContent=acs.size;
  document.getElementById('db-kv3').textContent=totalHH.toFixed(1)+'h';
  document.getElementById('db-kv4').textContent=techs.length;
  document.getElementById('db-kv5').textContent=peak||'—';
  document.getElementById('db-kv6').textContent=avgDur;
  // Plan task KPIs — aggregate from linkedTasks in OTs
  let planDone=0,planUnassigned=0,planTotal=0;
  t.forEach(x=>{
    const lt=x.linkedTasks||[];
    lt.forEach(task=>{
      planTotal++;
      if(task.status==='done') planDone++;
      else if(task.status==='unassigned') planUnassigned++;
    });
  });
  const otp=planTotal>0?Math.round(planDone/planTotal*100):0;
  const el7=document.getElementById('db-kv7'); if(el7){ el7.textContent=planDone; document.getElementById('db-kv7s').textContent='de '+planTotal+' totales'; }
  const el8=document.getElementById('db-kv8'); if(el8){ el8.textContent=planUnassigned; document.getElementById('db-kv8s').textContent='de '+planTotal+' totales'; }
  const el9=document.getElementById('db-kv9'); if(el9) el9.textContent=planTotal>0?otp+'%':'—';
}

function dbMkChart(id,cfg){
  if(dbCharts[id]){ try{dbCharts[id].destroy();}catch(_){} delete dbCharts[id]; }
  const canvas=document.getElementById(id);
  if(!canvas) return;
  if(typeof Chart==='undefined'){
    if(!window._chartJsLoading){
      window._chartJsLoading=true;
      const s=document.createElement('script');
      s.src='https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.1/chart.umd.min.js';
      s.onload=()=>{ window._chartJsLoading=false; if(typeof renderDashboard==='function') renderDashboard(); };
      document.head.appendChild(s);
    }
    return;
  }
  Chart.defaults.color='#94a3b8';
  Chart.defaults.borderColor='rgba(148,163,184,.15)';
  try{
    dbCharts[id]=new Chart(canvas,cfg);
  }catch(e){ console.error('Chart error '+id+':', e); }
}

function dbUpdateCharts(t){
  // OTs por día
  const byDay={};
  t.forEach(x=>{byDay[x.taskDate]=(byDay[x.taskDate]||0)+1;});
  const days=Object.keys(byDay).sort();
  document.getElementById('db-badge1').textContent=days.length+' días';
  dbMkChart('db-chart-daily',{
    type:'bar',
    data:{labels:days.map(dbFmtDate),datasets:[{
      label:'OTs',data:days.map(d=>byDay[d]),
      backgroundColor:'rgba(59,130,246,.75)',borderColor:'#3b82f6',
      borderWidth:1,borderRadius:4
    }]},
    options:{responsive:true,maintainAspectRatio:false,
      plugins:{legend:{display:false}},
      scales:{x:{ticks:{font:{size:9},maxRotation:45}},y:{beginAtZero:true,ticks:{stepSize:1,font:{size:9}}}}}
  });

  // Top aeronaves
  const byAC={};
  t.forEach(x=>{byAC[x.ac]=(byAC[x.ac]||0)+1;});
  const topAC=Object.entries(byAC).sort((a,b)=>b[1]-a[1]).slice(0,8);
  dbMkChart('db-chart-ac',{
    type:'bar',
    data:{labels:topAC.map(x=>x[0]),datasets:[{
      label:'OTs',data:topAC.map(x=>x[1]),
      backgroundColor:topAC.map((_,i)=>`hsl(${210+i*18},65%,55%)`),
      borderRadius:4,borderWidth:0
    }]},
    options:{indexAxis:'y',responsive:true,maintainAspectRatio:false,
      plugins:{legend:{display:false}},
      scales:{x:{beginAtZero:true,ticks:{stepSize:1,font:{size:9}}},y:{ticks:{font:{size:9}}}}}
  });

  // Turnos
  const sm={'05:00–14:00':0,'13:00–22:00':0,'21:00–05:00':0};
  techs.forEach(x=>{if(sm[x.shift]!==undefined)sm[x.shift]++;});
  dbMkChart('db-chart-shift',{
    type:'doughnut',
    data:{
      labels:['🌅 Mañana','🌇 Tarde','🌙 Noche'],
      datasets:[{data:Object.values(sm),backgroundColor:['rgba(59,130,246,.8)','rgba(245,158,11,.8)','rgba(139,92,246,.8)'],borderWidth:0}]
    },
    options:{responsive:true,maintainAspectRatio:false,
      plugins:{legend:{position:'bottom',labels:{font:{size:10},padding:8,color:'#64748b'}}}}
  });

  // Roles
  const rm={FIRMA:0,'NO-FIRMA':0,ASISTENTE:0,GASEO:0,DESPACHO:0};
  techs.forEach(x=>{if(rm[x.role]!==undefined)rm[x.role]++;});
  dbMkChart('db-chart-roles',{
    type:'pie',
    data:{
      labels:Object.keys(rm),
      datasets:[{data:Object.values(rm),
        backgroundColor:['rgba(59,130,246,.8)','rgba(34,197,94,.8)','rgba(245,158,11,.8)','rgba(139,92,246,.8)','rgba(6,182,212,.8)'],
        borderWidth:0}]
    },
    options:{responsive:true,maintainAspectRatio:false,
      plugins:{legend:{position:'bottom',labels:{font:{size:10},padding:8,color:'#64748b'}}}}
  });


  // ── Tareas por aeronave: completadas vs no realizadas ──
  const acTaskMap={};
  const dbPlans = window._dbPlans||[];
  t.forEach(x=>{
    const ac=x.ac; if(!ac) return;
    if(!acTaskMap[ac]) acTaskMap[ac]={done:0,unassigned:0};
    // Match plan tasks by WO and AC
    const woList = (x.wo||'').split(',').map(w=>w.trim()).filter(Boolean);
    if(woList.length){
      dbPlans.filter(p=>(p.ac||'').trim()===ac.trim() && woList.some(w=>w===(p.wo||'').trim())).forEach(p=>{
        if(p.status==='done') acTaskMap[ac].done++;
        else if(p.status==='unassigned') acTaskMap[ac].unassigned++;
      });
    }
    // Also count from embedded linkedTasks if present
    (x.linkedTasks||[]).forEach(task=>{
      if(task.status==='done') acTaskMap[ac].done++;
      else if(task.status==='unassigned') acTaskMap[ac].unassigned++;
    });
  });
  const acTaskLabels=Object.keys(acTaskMap).filter(a=>acTaskMap[a].done+acTaskMap[a].unassigned>0).sort();
  if(document.getElementById('db-chart-tasks-ac')&&acTaskLabels.length>0){
    dbMkChart('db-chart-tasks-ac',{
      type:'bar',
      data:{labels:acTaskLabels,datasets:[
        {label:'Completadas',data:acTaskLabels.map(a=>acTaskMap[a].done),backgroundColor:'#10b981',borderRadius:3,borderWidth:0},
        {label:'No realizadas',data:acTaskLabels.map(a=>acTaskMap[a].unassigned),backgroundColor:'#ef4444',borderRadius:3,borderWidth:0}
      ]},
      options:{responsive:true,maintainAspectRatio:false,
        plugins:{legend:{labels:{color:'#94a3b8',font:{size:9}},position:'top'}},
        scales:{x:{ticks:{font:{size:9},color:'#94a3b8'},grid:{color:'rgba(148,163,184,.1)'}},
                y:{beginAtZero:true,ticks:{stepSize:1,font:{size:9},color:'#94a3b8'},grid:{color:'rgba(148,163,184,.1)'}}}}
    });
  }

  // ── Comparación entre bases ──
  const baseMap={};
  t.forEach(x=>{
    const base=x.station||window._station||'PUJ';
    if(!baseMap[base]) baseMap[base]={total:0,entregadas:0,done:0,unassigned:0};
    baseMap[base].total++;
    if(x.status==='entregada') baseMap[base].entregadas++;
    (x.linkedTasks||[]).forEach(task=>{
      if(task.status==='done') baseMap[base].done++;
      else if(task.status==='unassigned') baseMap[base].unassigned++;
    });
  });
  const baseLabels=Object.keys(baseMap).sort();
  if(document.getElementById('db-chart-bases')&&baseLabels.length>0){
    dbMkChart('db-chart-bases',{
      type:'bar',
      data:{labels:baseLabels,datasets:[
        {label:'OTs totales',data:baseLabels.map(b=>baseMap[b].total),backgroundColor:'#3b82f6',borderRadius:3,borderWidth:0},
        {label:'Entregadas',data:baseLabels.map(b=>baseMap[b].entregadas),backgroundColor:'#10b981',borderRadius:3,borderWidth:0},
        {label:'Tareas completas',data:baseLabels.map(b=>baseMap[b].done),backgroundColor:'#a78bfa',borderRadius:3,borderWidth:0},
        {label:'No realizadas',data:baseLabels.map(b=>baseMap[b].unassigned),backgroundColor:'#f87171',borderRadius:3,borderWidth:0}
      ]},
      options:{responsive:true,maintainAspectRatio:false,
        plugins:{legend:{labels:{color:'#94a3b8',font:{size:9}},position:'top'}},
        scales:{x:{ticks:{font:{size:9},color:'#94a3b8'},grid:{color:'rgba(148,163,184,.1)'}},
                y:{beginAtZero:true,ticks:{stepSize:1,font:{size:9},color:'#94a3b8'},grid:{color:'rgba(148,163,184,.1)'}}}}
    });
  }
}

function dbRenderHeatmap(){
  const el=document.getElementById('db-heatmap');
  if(!el) return;
  el.innerHTML='';
  const totals=Array(24).fill(0),counts=Array(24).fill(0);
  dbHistory.forEach(h=>(h.hrs||[]).forEach((v,i)=>{totals[i]+=v;counts[i]++;}));
  const avgs=totals.map((t,i)=>counts[i]?t/counts[i]:0);
  const maxV=Math.max(...avgs,1);
  for(let i=0;i<24;i++){
    const v=avgs[i],pct=v/maxV;
    let bg=v===0?'#1e3a5f':pct<0.33?`rgba(29,78,216,${0.3+pct*2})`:pct<0.66?`rgba(245,158,11,${0.5+pct*0.7})`:`rgba(220,38,38,${0.6+pct*0.4})`;
    const cell=document.createElement('div');
    cell.className='db-hm-cell';
    cell.style.background=bg;
    cell.title=`${String(i).padStart(2,'0')}:00 — ${v.toFixed(1)} téc. prom.`;
    cell.textContent=v>0?v.toFixed(1):'';
    el.appendChild(cell);
  }
}

function dbSortOT(col){
  if(dbSortCol===col)dbSortDir*=-1;else{dbSortCol=col;dbSortDir=1;}
  renderDashboard();
}

function dbRenderOTTable(t){
  if(!t) return;
  const q=(document.getElementById('db-tbl-search')?.value||'').toLowerCase();
  let data=[...t];
  if(q) data=data.filter(x=>(x.ac||'').toLowerCase().includes(q)||(x.wo||'').toLowerCase().includes(q)||(x.comments||'').toLowerCase().includes(q));
  data.sort((a,b)=>{let va=a[dbSortCol]||'',vb=b[dbSortCol]||'';return va>vb?dbSortDir:va<vb?-dbSortDir:0;});
  const el=document.getElementById('db-ot-count');
  if(el) el.textContent=data.length+' registros';
  const tb=document.getElementById('db-ot-tbody');
  if(!tb) return;
  if(!data.length){tb.innerHTML=`<tr><td colspan="12" style="text-align:center;padding:20px;color:#475569">Sin OTs en el período</td></tr>`;return;}
  tb.innerHTML=data.map(x=>{
    const names=(x.staff||[]).map(id=>techs.find(s=>s.id===id)?.name?.split(' ')[0]||'').filter(Boolean).join(', ');
    const cap=(x.staff||[]).reduce((a,id)=>{const s=techs.find(z=>z.id===id);return a+(s?.hours||0)},0);
    const hh=((x.dur||0)/60*(cap/6||1)).toFixed(1);
    return`<tr>
      <td style="white-space:nowrap;color:#64748b">${dbFmtDate(x.taskDate)}</td>
      <td><span class="db-badge-ac">${esc(x.ac||'—')}</span></td>
      <td style="font-family:monospace;font-size:10px;color:#60a5fa">${esc(x.wo||'—')}</td>
      <td style="color:#64748b">${hhmm(x.gs||0)}</td>
      <td style="color:#64748b">${hhmm(x.ge||0)}</td>
      <td style="color:#fbbf24">${hhmm(x.start||0)}</td>
      <td style="color:#fb923c">${hhmm((x.start||0)+(x.dur||0))}</td>
      <td style="font-weight:600">${fdur(x.dur||0)}</td>
      <td style="text-align:center">${(x.staff||[]).length}</td>
      <td style="font-weight:600;color:#4ade80">${hh}h</td>
      <td style="font-size:10px;color:#64748b;max-width:140px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${esc(names)}">${esc(names||'—')}</td>
      <td style="font-size:10px;color:${x.comments?'#fbbf24':'#334155'};max-width:150px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${esc(x.comments||'')}">${esc(x.comments||'—')}</td>
    </tr>`;
  }).join('');
}

function dbRenderRoster(t){
  const techOTs={},techHH={};
  (t||[]).forEach(x=>{
    const cap=(x.staff||[]).reduce((a,id)=>{const s=techs.find(z=>z.id===id);return a+(s?.hours||0)},0);
    (x.staff||[]).forEach(id=>{
      techOTs[id]=(techOTs[id]||0)+1;
      const techH=techs.find(z=>z.id===id)?.hours||0;
      techHH[id]=(techHH[id]||0)+((x.dur||0)/60*(cap>0?techH/cap:0));
    });
  });
  const maxOTs=Math.max(...techs.map(x=>techOTs[x.id]||0),1);
  const roleOrder={FIRMA:0,'NO-FIRMA':1,ASISTENTE:2,GASEO:3,DESPACHO:4};
  const sorted=[...techs].sort((a,b)=>(roleOrder[a.role]??5)-(roleOrder[b.role]??5)||a.name.localeCompare(b.name));

  const firmaN=sorted.filter(x=>x.role==='FIRMA').length;
  const nfN=sorted.filter(x=>x.role==='NO-FIRMA').length;
  const espN=sorted.length-firmaN-nfN;
  const sumEl=document.getElementById('db-roster-summary');
  if(sumEl) sumEl.innerHTML=`
    <span style="background:rgba(59,130,246,.15);color:#93c5fd;padding:2px 8px;border-radius:20px;font-size:10px;font-weight:600">FIRMA: ${firmaN}</span>
    <span style="background:rgba(34,197,94,.15);color:#4ade80;padding:2px 8px;border-radius:20px;font-size:10px;font-weight:600">NO-FIRMA: ${nfN}</span>
    <span style="background:rgba(245,158,11,.15);color:#fbbf24;padding:2px 8px;border-radius:20px;font-size:10px;font-weight:600">Especial: ${espN}</span>`;

  const roleCls={FIRMA:'rgba(59,130,246,.15)|#93c5fd','NO-FIRMA':'rgba(34,197,94,.15)|#4ade80',ASISTENTE:'rgba(245,158,11,.15)|#fbbf24',GASEO:'rgba(139,92,246,.15)|#c4b5fd',DESPACHO:'rgba(6,182,212,.15)|#22d3ee'};
  const shiftEmoji=s=>s==='05:00–14:00'?'🌅 Mañana':s==='13:00–22:00'?'🌇 Tarde':s==='21:00–05:00'?'🌙 Noche':s||'—';

  const tb=document.getElementById('db-roster-tbody');
  if(!tb) return;
  tb.innerHTML=sorted.map((x,i)=>{
    const ots=techOTs[x.id]||0, hh=(techHH[x.id]||0).toFixed(1);
    const barW=Math.round((ots/maxOTs)*100);
    const barCol=barW>75?'#ef4444':barW>40?'#f59e0b':'#3b82f6';
    const [rbg,rc]=(roleCls[x.role]||'rgba(100,116,139,.15)|#94a3b8').split('|');
    return`<tr>
      <td style="color:#334155;font-size:10px">${i+1}</td>
      <td style="font-weight:600;font-size:11px">${esc(x.name)}</td>
      <td><span class="db-role-badge" style="background:${rbg};color:${rc}">${esc(x.role)}</span></td>
      <td style="text-align:center">${x.hours}h</td>
      <td style="font-size:10px">${shiftEmoji(x.shift)}</td>
      <td>
        <div style="display:flex;align-items:center;gap:6px">
          <div class="db-bar-mini" style="flex:1"><div class="db-bar-mini-fill" style="width:${barW}%;background:${barCol}"></div></div>
          <span style="font-size:11px;font-weight:700;color:${barCol};min-width:18px;text-align:right">${ots}</span>
        </div>
      </td>
      <td style="font-weight:600;color:#4ade80">${hh}h</td>
      <td style="font-size:11px;color:${barW>75?'#f87171':barW>40?'#fbbf24':'#60a5fa'}">${barW}%</td>
    </tr>`;
  }).join('');
}

function dbExportCSV(){
  const from=document.getElementById('db-from').value, to=document.getElementById('db-to').value;
  const dbTasks=window._dbTasksCache||tasks.filter(t=>t.taskDate>=from&&t.taskDate<=to);
  const acF=document.getElementById('db-ac-filter').value;
  const filtered=acF?dbTasks.filter(t=>t.ac===acF):dbTasks;
  const rows=[['Fecha','Aeronave','WO','ETA','ETD','Inicio','Fin','Duración(min)','#Técnicos','H-Hombre','Técnicos','Comentario']];
  filtered.sort((a,b)=>a.taskDate.localeCompare(b.taskDate)).forEach(t=>{
    const names=(t.staff||[]).map(id=>techs.find(s=>s.id===id)?.name||'').filter(Boolean).join(' | ');
    const cap=(t.staff||[]).reduce((a,id)=>{const s=techs.find(z=>z.id===id);return a+(s?.hours||0)},0);
    const hh=((t.dur||0)/60*(cap/6||1)).toFixed(1);
    rows.push([t.taskDate,t.ac,t.wo,hhmm(t.gs||0),hhmm(t.ge||0),hhmm(t.start||0),hhmm((t.start||0)+(t.dur||0)),t.dur||0,(t.staff||[]).length,hh,names,t.comments||'']);
  });
  const csv=rows.map(r=>r.map(v=>'"'+String(v).replace(/"/g,'""')+'"').join(',')).join('\n');
  const blob=new Blob(['﻿'+csv],{type:'text/csv;charset=utf-8'});
  const a=document.createElement('a');a.href=URL.createObjectURL(blob);
  a.download='AirTec_Dashboard_'+from+'_'+to+'.csv';a.click();
  toast('✅ CSV exportado');
}
// ── Exportar OTP Semanal a Excel ──
function exportOTPExcel(){
  if(typeof XLSX==='undefined'){ toast('XLSX no disponible',true); return; }
  const t = window._dbFilteredTasks || dbTasks || [];
  const weekOTP={};
  t.forEach(x=>{
    if(!x.taskDate) return;
    const d=new Date(x.taskDate+'T12:00:00');
    const jan1=new Date(d.getFullYear(),0,1);
    const wk=Math.ceil(((d-jan1)/86400000+jan1.getDay()+1)/7);
    const wkKey=d.getFullYear()+'-S'+String(wk).padStart(2,'0');
    if(!weekOTP[wkKey]) weekOTP[wkKey]={semana:wkKey,total:0,entregadas:0,demoras:0,otp:0};
    weekOTP[wkKey].total++;
    if(x.status==='entregada'){
      const m=(x.deliveredAt||'').match(/([0-9]{1,2}):([0-9]{2})/);
      if(m){
        let h=parseInt(m[1]),mn=parseInt(m[2]);
        if((x.deliveredAt||'').toLowerCase().includes('p.')&&h!==12) h+=12;
        if((h*60+mn)>x.ge) weekOTP[wkKey].demoras++;
        else weekOTP[wkKey].entregadas++;
      } else { weekOTP[wkKey].entregadas++; }
    }
  });
  // Calculate OTP
  Object.values(weekOTP).forEach(w=>{
    w.otp=w.total>0?Math.round(w.entregadas/w.total*100):0;
    w['OTP%']=w.otp+'%';
  });
  const rows=Object.values(weekOTP).sort((a,b)=>a.semana.localeCompare(b.semana));
  const ws=XLSX.utils.json_to_sheet(rows.map(r=>({
    'Semana':r.semana,'Total OTs':r.total,'Entregadas a tiempo':r.entregadas,
    'Demoras':r.demoras,'OTP%':r['OTP%']
  })));
  const wb=XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb,ws,'OTP Semanal');
  XLSX.writeFile(wb,'OTP_Semanal_'+(window._station||'PUJ')+'.xlsx');
  toast('✅ Excel exportado');
}

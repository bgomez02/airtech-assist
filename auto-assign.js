// ══ AUTO-ASIGNACIÓN — AirTech Assist ══
// Algoritmo de distribución de OTs entre técnicos disponibles

// ══ AUTO-ASIGNACIÓN ══
let autoAssignResult = {};

// Convierte "HH:MM–HH:MM" a {s, e, overnight}
function shiftWindow(shift){
  if(!shift) return {s:0,e:1440,overnight:false};
  const p=(shift||'').split('–');
  const s=(+p[0].split(':')[0])*60+(+( p[0].split(':')[1])||0);
  const e=(+p[1].split(':')[0])*60+(+( p[1].split(':')[1])||0);
  return {s, e, overnight: e<=s};
}
// ¿El técnico está en turno durante la ventana [ts, te]?
function techInShift(tech, ts, te){
  const w=shiftWindow(tech.shift);
  if(w.overnight) return te>w.s || ts<w.e;
  return ts<w.e && te>w.s;
}
// Turno requerido según ETD de la aeronave (ge en minutos)
// 05:30–13:30 → mañana | 13:30–21:30 → tarde | 21:30–05:30 → noche
function shiftForEtd(ge){
  const m=ge%1440;
  if(m<=330)  return '21:00–05:00'; // 00:00–05:30 → noche
  if(m<=810)  return '05:00–14:00'; // 05:30–13:30 → mañana
  if(m<=1290) return '13:00–22:00'; // 13:30–21:30 → tarde
  return '21:00–05:00';             // 21:30–24:00 → noche
}

function openAutoAssign(){
  if(currentRole==='tech'){toast('⛔ Sin permisos',true);return;}
  const dt=dayTasks().filter(t=>t.status!=='entregada');
  if(!dt.length){toast('⚠ No hay OTs activas para hoy',true);return;}
  autoAssignResult={};
  renderAutoTechList();
  document.getElementById('auto-step1').style.display='block';
  document.getElementById('auto-step2').style.display='none';
  document.getElementById('modal-auto').classList.add('open');
}

function closeAutoModal(){
  document.getElementById('modal-auto').classList.remove('open');
}

function renderAutoTechList(){
  const el=document.getElementById('auto-tech-list');
  // Detect current shift
  const nowH=new Date().getHours();
  const curShift=nowH>=5&&nowH<13?'05:00–14:00':nowH>=13&&nowH<21?'13:00–22:00':'21:00–05:00';

  const groups=[
    {label:'🌅 Turno Mañana (05–14h)', shift:'05:00–14:00', roles:['FIRMA','NO-FIRMA','ASISTENTE']},
    {label:'🌇 Turno Tarde (13–22h)',   shift:'13:00–22:00', roles:['FIRMA','NO-FIRMA','ASISTENTE']},
    {label:'🌙 Turno Noche (21–05h)',   shift:'21:00–05:00', roles:['FIRMA','NO-FIRMA','ASISTENTE']},
    {label:'⛽ Gaseo / ✈ Despacho',     shift:'',            roles:['GASEO','DESPACHO']},
  ];

  el.innerHTML='';
  groups.forEach(g=>{
    const members=techs.filter(t=>
      (g.shift ? t.shift===g.shift : ['GASEO','DESPACHO'].includes(t.role))
      && (g.roles.includes(t.role))
    );
    if(!members.length) return;

    const sec=document.createElement('div');
    sec.style.cssText='margin-bottom:8px';
    sec.innerHTML=`<div style="font-size:10px;font-weight:700;color:#64748b;text-transform:uppercase;padding:5px 8px;background:#f8fafc;border-radius:6px;margin-bottom:4px">${g.label}</div>`;

    members.forEach(t=>{
      const isGaseoDesp=['GASEO','DESPACHO'].includes(t.role);
      const preSelected = isGaseoDesp || t.shift===curShift;
      const roleBg={FIRMA:'#dbeafe',GASEO:'#dcfce7',DESPACHO:'#fef9c3','NO-FIRMA':'#f0fdf4',ASISTENTE:'#fef3c7'}[t.role]||'#f1f5f9';
      const roleCol={FIRMA:'#1e40af',GASEO:'#166534',DESPACHO:'#854d0e','NO-FIRMA':'#166534',ASISTENTE:'#92400e'}[t.role]||'#374151';

      const row=document.createElement('label');
      row.style.cssText='display:flex;align-items:center;gap:8px;padding:5px 8px;border-radius:7px;cursor:pointer;transition:background .1s';
      row.addEventListener('mouseenter',()=>row.style.background='#f1f5f9');
      row.addEventListener('mouseleave',()=>row.style.background='');
      row.innerHTML=`
        <input type="checkbox" value="${t.id}" ${preSelected?'checked':''} onchange="updateAutoSelCount()"
          style="width:14px;height:14px;accent-color:#7c3aed;cursor:pointer;flex-shrink:0">
        <span style="flex:1;font-size:12px;font-weight:500">${esc(t.name)}</span>
        <span style="background:${roleBg};color:${roleCol};font-size:9px;font-weight:700;padding:1px 7px;border-radius:20px">${t.role}</span>
        <span style="font-size:10px;color:#94a3b8">${t.hours}h · ${t.shift||'—'}</span>`;
      sec.appendChild(row);
    });
    el.appendChild(sec);
  });
  updateAutoSelCount();
}

function autoFilterShift(shift){
  document.querySelectorAll('#auto-tech-list input[type=checkbox]').forEach(cb=>{
    const tech=techs.find(t=>t.id===cb.value);
    if(tech) cb.checked = tech.shift===shift || ['GASEO','DESPACHO'].includes(tech.role);
  });
  updateAutoSelCount();
}

function autoSelectAll(v){
  document.querySelectorAll('#auto-tech-list input[type=checkbox]').forEach(cb=>cb.checked=v);
  updateAutoSelCount();
}

function updateAutoSelCount(){
  const n=document.querySelectorAll('#auto-tech-list input[type=checkbox]:checked').length;
  document.getElementById('auto-sel-count').textContent=`${n} técnico${n!==1?'s':''} seleccionado${n!==1?'s':''}`;
}

function getAutoSelectedIds(){
  return [...document.querySelectorAll('#auto-tech-list input[type=checkbox]:checked')].map(cb=>cb.value);
}

function calcAutoAssign(){
  const selectedIds=new Set(getAutoSelectedIds());
  if(!selectedIds.size){toast('⚠ Selecciona al menos un técnico',true);return;}

  const dt=dayTasks().filter(t=>t.status!=='entregada').sort((a,b)=>(a.gs||0)-(b.gs||0));
  const available=techs.filter(t=>selectedIds.has(t.id));

  const firma    =available.filter(t=>t.role==='FIRMA');
  const noFirma  =available.filter(t=>t.role==='NO-FIRMA');
  const asistente=available.filter(t=>t.role==='ASISTENTE');
  const gaseoPool  =available.filter(t=>t.role==='GASEO');
  const despPool   =available.filter(t=>t.role==='DESPACHO');
  // Para gaseo: ASISTENTE → NO-FIRMA → FIRMA → GASEO → DESPACHO
  const gaseoOrder =[...asistente,...noFirma,...firma,...gaseoPool,...despPool];
  // Para despacho: DESPACHO → ASISTENTE → NO-FIRMA → FIRMA → GASEO
  const despOrder  =[...despPool,...asistente,...noFirma,...firma,...gaseoPool];

  // Horas restantes por técnico (en minutos)
  const rem={};
  available.forEach(t=>{ rem[t.id]=t.hours*60; });

  // Registro de ventanas de tiempo ocupadas: techId → [{s, e}]
  const slots={};
  const isFree=(id,s,e)=>!(slots[id]||[]).some(w=>s<w.e&&e>w.s);
  const book=(id,s,e)=>{(slots[id]=slots[id]||[]).push({s,e});};

  autoAssignResult={};

  dt.forEach(task=>{
    const slotMin=(task.ge||0)-(task.gs||0);
    const taskStart=task.start||task.gs||0;
    const taskEnd=taskStart+(task.dur||slotMin);

    // Duración nominal (base 6h de capacidad)
    const existingCap=(task.staff||[]).reduce((s,id)=>{const tc=techs.find(x=>x.id===id);return s+(tc?.hours||0);},0);
    const nom=existingCap>0?Math.round(task.dur*(existingCap/6)):task.dur;

    const assigned=[];
    const totalCap=()=>assigned.reduce((s,id)=>{const tc=techs.find(x=>x.id===id);return s+(tc?.hours||0);},0);
    const adjDur=()=>{ const c=totalCap(); return c>0?Math.round(nom/(c/6)):nom; };

    // Filtrar por turno según ETD de la aeronave
    const reqShift=shiftForEtd(task.ge||0);
    const firmaOk    =firma    .filter(t=>t.shift===reqShift);
    const noFirmaOk  =noFirma  .filter(t=>t.shift===reqShift);
    const asistenteOk=asistente.filter(t=>t.shift===reqShift);

    // Helpers por rol — más horas disponibles primero, sin conflicto
    const freeOf=(pool)=>pool
      .filter(t=>!assigned.includes(t.id)&&(rem[t.id]||0)>0&&isFree(t.id,taskStart,taskStart+adjDur()))
      .sort((a,b)=>(rem[b.id]||0)-(rem[a.id]||0));

    // ── PASO 1: Asignar 1 FIRMA como técnico principal ──
    const firmaDisp=freeOf(firmaOk)[0];
    if(firmaDisp){
      assigned.push(firmaDisp.id);
    } else {
      // ── PASO 2: FIRMA no disponible (conflicto) → 1 NO-FIRMA de cobertura ──
      const noFirmaDisp=freeOf(noFirmaOk)[0];
      if(noFirmaDisp) assigned.push(noFirmaDisp.id);
    }

    // ── PASO 3: Si la duración aún supera el slot, agregar apoyo ──
    // Orden: FIRMA libre restante → NO-FIRMA → ASISTENTE
    while(adjDur()>slotMin){
      const apoyo=freeOf(firmaOk)[0]||freeOf(noFirmaOk)[0]||freeOf(asistenteOk)[0];
      if(!apoyo) break;
      assigned.push(apoyo.id);
    }

    // ── FALLBACK: nadie del turno → cualquiera con más horas libres (FIRMA > NO-FIRMA > ASISTENTE) ──
    if(!assigned.length){
      const rp={FIRMA:0,'NO-FIRMA':1,ASISTENTE:2};
      const fallback=[...firma,...noFirma,...asistente]
        .filter(t=>(rem[t.id]||0)>0&&isFree(t.id,taskStart,taskStart+adjDur()))
        .sort((a,b)=>{const rd=(rp[a.role]||9)-(rp[b.role]||9);return rd!==0?rd:(rem[b.id]||0)-(rem[a.id]||0);})[0];
      if(fallback) assigned.push(fallback.id);
    }

    const finalDur=adjDur();
    const finalEnd=taskStart+finalDur;

    // Registrar ventana ocupada y descontar horas (sin exceder horas disponibles)
    const cap=totalCap();
    assigned.forEach(id=>{
      book(id,taskStart,finalEnd);
      const tech=techs.find(x=>x.id===id);
      const contrib=cap>0?((tech?.hours||0)/cap)*finalDur:finalDur;
      rem[id]=Math.max(0,(rem[id]||0)-Math.min(contrib,rem[id]||0)); // no bajar de 0
    });

    // ── Gaseo: ventana gs → gs+30 ──
    // Prioridad: ASISTENTE → NO-FIRMA → FIRMA → GASEO → DESPACHO (más horas primero)
    const gsStart=task.gs||0, gsEnd=gsStart+30;
    const gCandidates=pool=>pool
      .filter(g=>g.shift===reqShift&&!assigned.includes(g.id)&&(rem[g.id]||0)>0&&isFree(g.id,gsStart,gsEnd));
    const gaseoCandidate=
      gCandidates(gaseoOrder)[0] ||
      gaseoOrder.filter(g=>!assigned.includes(g.id)&&(rem[g.id]||0)>0&&isFree(g.id,gsStart,gsEnd))[0];
    const gaseo=gaseoCandidate?.id||'';
    // Reservar la ventana de gaseo (sin buffer aún — se decide después)
    if(gaseo){book(gaseo,gsStart,gsEnd);rem[gaseo]=Math.max(0,(rem[gaseo]||0)-30);}

    // ── Despacho: intentar con el mismo gaseador primero ──
    // El gaseador puede hacer despacho de la MISMA aeronave sin buffer de traslado
    const despStart=Math.max(0,(task.ge||0)-15), despEnd=task.ge||0;
    let despacho='';

    if(gaseo&&isFree(gaseo,despStart,despEnd)){
      // Mismo gaseador hace el despacho
      despacho=gaseo;
      book(gaseo,despStart,despEnd);
      rem[gaseo]=Math.max(0,(rem[gaseo]||0)-15);
      // Buffer de 15 min DESPUÉS del despacho (para próxima aeronave)
      book(gaseo,despEnd,despEnd+15);
    } else {
      // Gaseador no puede hacer despacho → aplicar su buffer post-gaseo
      if(gaseo) book(gaseo,gsEnd,gsEnd+15);
      // Buscar despachador independiente
      const dCandidates=pool=>pool
        .filter(d=>d.shift===reqShift&&!assigned.includes(d.id)&&(rem[d.id]||0)>0&&isFree(d.id,despStart,despEnd));
      const despCandidate=
        dCandidates(despOrder)[0] ||
        despOrder.filter(d=>!assigned.includes(d.id)&&(rem[d.id]||0)>0&&isFree(d.id,despStart,despEnd))[0];
      if(despCandidate){
        despacho=despCandidate.id;
        book(despacho,despStart,despEnd);
        rem[despacho]=Math.max(0,(rem[despacho]||0)-15);
        book(despacho,despEnd,despEnd+15); // buffer post-despacho
      }
    }

    autoAssignResult[task.id]={staff:assigned,gaseo,despacho,dur:finalDur};
  });

  renderAutoPreview(dt);
  document.getElementById('auto-step1').style.display='none';
  document.getElementById('auto-step2').style.display='block';
}

function renderAutoPreview(dt){
  const wrap=document.getElementById('auto-preview-wrap');
  const noAsign=dt.filter(t=>!(autoAssignResult[t.id]?.staff?.length));

  let html=`<div style="font-size:11px;font-weight:600;color:#64748b;margin-bottom:8px">
    Revisa las asignaciones antes de guardar. Puedes volver atrás para ajustar.
  </div>`;

  if(noAsign.length){
    html+=`<div style="background:#fff7ed;border:1px solid #fed7aa;border-radius:8px;padding:8px 12px;margin-bottom:10px;font-size:11px;color:#92400e">
      ⚠ ${noAsign.length} OT${noAsign.length>1?'s':''} sin técnicos disponibles: ${noAsign.map(t=>esc(t.ac)).join(', ')}
    </div>`;
  }

  dt.forEach(task=>{
    const a=autoAssignResult[task.id];
    if(!a) return;
    const staffNames=(a.staff||[]).map(id=>techs.find(t=>t.id===id)?.name||id);
    const gaseoName=a.gaseo?techs.find(t=>t.id===a.gaseo)?.name:'—';
    const despName=a.despacho?techs.find(t=>t.id===a.despacho)?.name:'—';
    const slotMin=(task.ge||0)-(task.gs||0);
    const fits=a.dur<=slotMin;
    const borderCol=fits?'#86efac':'#fca5a5';
    const bgCol=fits?'#f0fdf4':'#fff0f0';

    html+=`<div style="border:1.5px solid ${borderCol};background:${bgCol};border-radius:10px;padding:10px 12px;margin-bottom:8px">
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px;flex-wrap:wrap">
        <span style="font-weight:700;font-size:13px">${esc(task.ac)}</span>
        <span style="font-size:10px;color:#64748b;font-family:monospace">${esc(task.wo)}</span>
        <span style="font-size:10px;color:#64748b">Slot: ${hhmm(task.gs||0)} → ${hhmm(task.ge||0)} (${fdur(slotMin)})</span>
        <span style="margin-left:auto;font-size:10px;font-weight:700;color:${fits?'#166534':'#dc2626'};background:${fits?'#dcfce7':'#fee2e2'};padding:2px 8px;border-radius:20px">
          ${fits?'✅ Cabe en slot':'⚠ Supera slot'} · ${fdur(a.dur)}
        </span>
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px;font-size:11px">
        <div>
          <div style="font-size:9px;font-weight:600;color:#64748b;text-transform:uppercase;margin-bottom:3px">🔧 Técnicos de mant.</div>
          ${staffNames.length
            ? staffNames.map(n=>`<div style="background:#dbeafe;color:#1e40af;padding:2px 8px;border-radius:20px;margin-bottom:2px;font-weight:500">${esc(n)}</div>`).join('')
            : '<div style="color:#94a3b8;font-size:10px">Sin técnicos disponibles</div>'}
        </div>
        <div>
          <div style="font-size:9px;font-weight:600;color:#64748b;text-transform:uppercase;margin-bottom:3px">⛽ Gaseo · ✈ Despacho</div>
          <div style="background:#dcfce7;color:#166534;padding:2px 8px;border-radius:20px;margin-bottom:2px;font-weight:500">⛽ ${esc(gaseoName||'—')}</div>
          <div style="background:#fef9c3;color:#854d0e;padding:2px 8px;border-radius:20px;font-weight:500">✈ ${esc(despName||'—')}</div>
        </div>
      </div>
    </div>`;
  });

  wrap.innerHTML=html;
}

async function applyAutoAssign(){
  if(!FB){toast('⚠ Sin conexión',true);return;}
  const btn=document.getElementById('auto-apply-btn');
  btn.textContent='Guardando...'; btn.disabled=true;
  const st=window._station||'PUJ';
  try{
    const promises=Object.entries(autoAssignResult).map(([id,a])=>
      FB.db.collection('airtechassist').doc(st).collection('tasks').doc(id).update({
        staff:a.staff, gaseo:a.gaseo||'', despacho:a.despacho||'', dur:a.dur
      })
    );
    await Promise.all(promises);
    closeAutoModal();
    playSound('new_ot');
    toast(`✅ Asignaciones guardadas — ${Object.keys(autoAssignResult).length} OTs actualizadas`);
  }catch(e){
    toast('❌ Error: '+e.message,true);
    btn.textContent='✅ Guardar asignaciones'; btn.disabled=false;
  }
}


;
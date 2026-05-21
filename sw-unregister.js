// ── Service Worker Cleanup ──

// ── Desregistrar cualquier Service Worker anterior (causaba cache bloqueado) ──
if('serviceWorker' in navigator){
  navigator.serviceWorker.getRegistrations().then(regs=>{
    regs.forEach(r=>{
      r.unregister();
      console.log('[SW] Desregistrado:', r.scope);
    });
    if(regs.length>0){
      console.log('[SW] Cache limpiado — recargando...');
      // Clear all caches
      caches.keys().then(keys=>Promise.all(keys.map(k=>caches.delete(k))));
    }
  });
}

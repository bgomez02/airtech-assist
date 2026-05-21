// ═══════════════════════════════════════════════════════════
// AirTech Assist — Service Worker v1.2
// Estrategia: Cache First para app shell, Network First para datos
// ═══════════════════════════════════════════════════════════

const CACHE_NAME = 'airtechassist-ops-v3';

// CDN scripts que se pre-cachean
const CDN_SCRIPTS = [
  'https://www.gstatic.com/firebasejs/10.12.0/firebase-app-compat.js',
  'https://www.gstatic.com/firebasejs/10.12.0/firebase-auth-compat.js',
  'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore-compat.js',
];

// ── INSTALL ──
self.addEventListener('install', event => {
  console.log('[SW] Instalando AirTech Assist v2...');
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => {
      // Cache the app shell (same-origin)
      const shellPromise = cache.addAll(['./','./index.html'])
        .catch(e => console.warn('[SW] Shell cache parcial:', e));
      // Cache CDN scripts
      const cdnPromises = CDN_SCRIPTS.map(url =>
        cache.add(url).catch(e => console.warn('[SW] CDN no cacheado:', url))
      );
      return Promise.allSettled([shellPromise, ...cdnPromises]);
    }).then(() => self.skipWaiting())
  );
});

// ── ACTIVATE ──
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

// ── FETCH ──
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);

  // ① Firebase/Firestore — dejar pasar (tiene su propio offline con IndexedDB)
  if (url.hostname.includes('googleapis.com') ||
      url.hostname.includes('firebaseio.com') ||
      url.hostname.includes('firebase.com')) {
    return;
  }

  // ② Cloudinary — Network Only (archivos grandes, no cachear)
  if (url.hostname.includes('cloudinary.com')) {
    event.respondWith(
      fetch(event.request).catch(() =>
        new Response(JSON.stringify({error:'Archivo no disponible sin conexión'}),
          {status:503, headers:{'Content-Type':'application/json'}})
      )
    );
    return;
  }

  // ③ CDN scripts (Firebase SDK, etc.) — Cache First
  if (url.hostname.includes('gstatic.com') || url.hostname.includes('cdnjs')) {
    event.respondWith(
      caches.match(event.request).then(cached => {
        if (cached) return cached;
        return fetch(event.request).then(res => {
          if (res && res.status === 200) {
            const clone = res.clone();
            caches.open(CACHE_NAME).then(c => c.put(event.request, clone));
          }
          return res;
        });
      })
    );
    return;
  }

  // ④ App shell (mismo origen) — Stale While Revalidate
  if (url.origin === self.location.origin) {
    event.respondWith(
      caches.match(event.request).then(cached => {
        const networkReq = fetch(event.request).then(res => {
          if (res && res.status === 200 && res.type !== 'opaque') {
            const clone = res.clone();
            caches.open(CACHE_NAME).then(c => c.put(event.request, clone));
          }
          return res;
        }).catch(() => null);
        return cached || networkReq;
      })
    );
    return;
  }

  // Default
  event.respondWith(
    fetch(event.request).catch(() => caches.match(event.request))
  );
});

self.addEventListener('message', event => {
  if (event.data?.type === 'SKIP_WAITING') self.skipWaiting();
});

// ══════════════════════════════════════════════════════
// firebase-init.js — proyecto: airtech-assist
// Configurado el 2026-05-21
//
// Expone window.FB con la interfaz que consume app.js:
//   signInAnonymously() · onAuthStateChanged(_,cb) · onSnapshot(ref,cb)
//   addDoc(ref,data) · db · TASKS/TECHS/REPORTS/PLANS/DOCS/HIST(st) · USERS()
//
// PENDIENTE en la consola de Firebase:
// 1. Authentication → Sign-in method → activar Anónimo Y Email/Password
// 2. Firestore Database → crear base (región us-central1)
// 3. Firestore → Rules → publicar el contenido de Seguridad/firestore.rules
// ══════════════════════════════════════════════════════

try {
  const cfg = {
    apiKey:            "AIzaSyB2WsDSnOtxU81nlwRvJlF7DrhgANHq3Mg",
    authDomain:        "airtech-assist.firebaseapp.com",
    projectId:         "airtech-assist",
    storageBucket:     "airtech-assist.firebasestorage.app",
    messagingSenderId: "334675945545",
    appId:             "1:334675945545:web:f73058130149e69d27b798"
  };

  firebase.initializeApp(cfg);
  const auth = firebase.auth();
  const db   = firebase.firestore();

  // Persistencia offline (IndexedDB). experimentalForceOwningTab evita
  // conflictos si hay varias pestañas abiertas.
  db.enablePersistence({ experimentalForceOwningTab: true })
    .then(() => console.log('✅ Firestore persistence activo'))
    .catch(err => { if (err.code !== 'failed-precondition') console.warn(err); });

  // root() usa AIRLINE_ID dinámico — multi-tenant
  const root = () => db.collection(window.AIRLINE_ID || 'airtechassist');

  // Interfaz que consume app.js / dashboard.js / auto-assign.js
  window.FB = {
    db, auth,
    signInAnonymously:  () => auth.signInAnonymously(),
    onAuthStateChanged: (_, cb) => auth.onAuthStateChanged(cb),
    onSnapshot: (ref, cb) => ref.onSnapshot(cb),
    addDoc:     (ref, data) => ref.add(data),
    setDoc:     (ref, data, opts) => opts ? ref.set(data, opts) : ref.set(data),
    // Colecciones por estación: /airtechassist/{station}/<col>
    TASKS:   (st) => root().doc(st).collection('tasks'),
    TECHS:   (st) => root().doc(st).collection('techs'),
    REPORTS: (st) => root().doc(st).collection('reports'),
    PLANS:   (st) => root().doc(st).collection('plans'),
    DOCS:    (st) => root().doc(st).collection('documents'),
    HIST:    (st) => root().doc(st).collection('history'),
    DEFS:    (st) => root().doc(st).collection('diferidos'),
    // Usuarios: /airtechassist/config/users
    USERS:   () => root().doc('config').collection('users'),
  };

  console.log('✅ Firebase listo — cliente: ' + (window.AIRLINE_ID || 'airtechassist'));

} catch (e) {
  console.error('❌ Firebase init error:', e);
  const errEl  = document.getElementById('loader-err');
  const errMsg = document.getElementById('loader-err-msg');
  const spin   = document.getElementById('loader-spin');
  if (errEl)  errEl.style.display = 'block';
  if (spin)   spin.style.display = 'none';
  if (errMsg) errMsg.textContent = 'Error al inicializar Firebase: ' + e.message;
}

// ══════════════════════════════════════════════════════════════
// CONFIG.EXAMPLE.JS — Plantilla de configuración
// ══════════════════════════════════════════════════════════════
// Copia este archivo como "config.js" y rellena tus valores.
// config.js está en .gitignore y nunca debe subirse al repo.
// ══════════════════════════════════════════════════════════════

window.APP_CONFIG = {

  // Nombre del superadmin en MAYÚSCULAS (igual que en el campo login)
  superadminName:  'NOMBRE APELLIDO',

  // Email del superadmin registrado en Firebase Authentication
  superadminEmail: 'correo@ejemplo.com',

  // UID del superadmin — cópialo de Firebase Console → Authentication → Users
  superadminUid:   'UID_AQUI',

  // ID de la colección raíz en Firestore (no cambiar si ya tienes datos)
  airlineId: 'airtechassist',

  // URL de tu proyecto Supabase (https://xxxx.supabase.co)
  supabaseUrl: 'https://XXXX.supabase.co',

  // anon key de Supabase (Settings → API → Project API keys → anon public)
  supabaseKey: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...',

  // Nombre del bucket de almacenamiento en Supabase
  supabaseBucket: 'files',

  // ── AviationStack API (sincronización automática de vuelos) ────
  // Clave gratuita en https://aviationstack.com (500 consultas/mes)
  // Deja vacío '' si no usas sincronización desde internet
  aviationApiKey: '',

  // ── Plan de suscripción ──────────────────────────────────────────
  // 'free'  → Gratis   : 1 base, 5 aeronaves, 3 usuarios, solo Gantt
  // 'basic' → Básico   : 2 bases, 15 aeronaves, 10 usuarios, sin MCC
  // 'pro'   → Pro      : Sin límites, todas las funciones
  plan: 'free'

};

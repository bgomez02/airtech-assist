# AirTech Assist

**Sistema de Gestión de Mantenimiento Aeronáutico (MRO)**

Plataforma web progresiva (PWA) para la gestión operativa de mantenimiento en tierra. Diseñada para aerolíneas y operadores aéreos que requieren control en tiempo real de órdenes de trabajo, asignación de técnicos, seguimiento de aeronaves y documentación técnica.

---

## Características principales

- **Gantt en tiempo real** — visualización de tareas y disponibilidad de aeronaves por línea de tiempo
- **MCC multi-base** — Maintenance Control Center con soporte para múltiples bases operativas
- **Gestión de roles** — acceso diferenciado para administradores y técnicos
- **Roster de personal** — planificación de turnos y asignación de técnicos
- **Documentación adjunta** — almacenamiento de archivos técnicos vía Supabase Storage
- **Notificaciones por email** — alertas automáticas integradas con EmailJS
- **Modo offline / PWA** — Service Worker para uso sin conexión
- **Exportación** — generación de reportes en PDF y Excel (jsPDF + XLSX)
- **Sincronización de vuelos** — integración opcional con AviationStack API
- **Auditoría** — registro de acciones en Firestore (plan Pro)

---

## Stack tecnológico

| Capa | Tecnología |
|------|-----------|
| Frontend | HTML5 + CSS3 + JavaScript ES6+ (vanilla, sin framework) |
| Autenticación | Firebase Authentication |
| Base de datos | Firebase Firestore |
| Almacenamiento | Supabase Storage |
| Gráficos | Chart.js |
| PDF | jsPDF |
| Excel | SheetJS (XLSX) |
| Email | EmailJS |
| Fuente | Inter (Google Fonts) |
| Hosting | Firebase Hosting |

---

## Estructura del proyecto

```
/
├── index.html           — Landing page / página de marketing
├── app.html             — Shell de la aplicación (todas las vistas)
├── styles.css           — Estilos globales (sin preprocesador)
├── app.js               — Lógica principal: estado, Firebase, modales, roles
├── dashboard.js         — Dashboard y diagrama de Gantt
├── firebase-init.js     — Inicialización de Firebase
├── config.js            — Credenciales locales (no incluido en repo)
├── config.example.js    — Plantilla de configuración
├── sw.js                — Service Worker (PWA / modo offline)
├── manifest.json        — Manifiesto PWA
├── firebase.json        — Configuración de Firebase Hosting
├── Seguridad/
│   └── firestore.rules  — Reglas de seguridad de Firestore
└── Scripts/             — Utilidades y scripts de mantenimiento
```

---

## Planes de suscripción

| Plan | Bases | Aeronaves | Usuarios | Funciones |
|------|-------|-----------|----------|-----------|
| **Free** | 1 | 5 | 3 | Solo Gantt |
| **Basic** | 2 | 15 | 10 | Sin MCC |
| **Pro** | Sin límite | Sin límite | Sin límite | Todas (incluye auditoría) |

---

## Instalación y configuración local

### 1. Clonar el repositorio

```bash
git clone <url-del-repo>
cd "AirTech Assist"
```

### 2. Configurar credenciales

Copia la plantilla y rellena tus valores:

```bash
cp config.example.js config.js
```

Edita `config.js` con los datos de tu proyecto Firebase, Supabase y EmailJS:

```js
window.APP_CONFIG = {
  superadminName:  'NOMBRE APELLIDO',
  superadminEmail: 'correo@ejemplo.com',
  superadminUid:   'UID_DE_FIREBASE',
  airlineId:       'airtechassist',
  supabaseUrl:     'https://xxxx.supabase.co',
  supabaseKey:     'eyJhbGci...',
  supabaseBucket:  'files',
  aviationApiKey:  '',     // opcional
  plan:            'pro'
};
```

> `config.js` está en `.gitignore` y **nunca** debe subirse al repositorio.

### 3. Configurar Firebase

- Crea un proyecto en [Firebase Console](https://console.firebase.google.com)
- Habilita **Authentication** (email/password) y **Firestore**
- Despliega las reglas de Firestore desde `Seguridad/firestore.rules`

### 4. Configurar Supabase

- Crea un proyecto en [Supabase](https://supabase.com)
- El bucket de almacenamiento se crea automáticamente al primer uso

### 5. Servir localmente

La app no requiere bundler. Puedes servirla con cualquier servidor HTTP estático:

```bash
# Con Python
python3 -m http.server 8080

# Con Node.js (npx)
npx serve .
```

Abre `http://localhost:8080` en el navegador.

---

## Deploy en Firebase Hosting

```bash
npm install -g firebase-tools
firebase login
firebase deploy --only hosting
```

---

## Seguridad

- Las credenciales se cargan siempre desde `config.js` (excluido del repo vía `.gitignore`)
- Las contraseñas se verifican con **SHA-256** via Web Crypto API (sin librerías)
- Rate limiting en login: máximo 5 intentos, bloqueo de 30 segundos
- CSP definida en `index.html` — toda nueva dependencia CDN debe agregarse a la política
- Reglas de Firestore en `Seguridad/firestore.rules` — revisar antes de cada deploy
- El contenido HTML dinámico se sanitiza antes de usar `innerHTML`

---

## Convenciones de código

- JavaScript vanilla ES6+, sin TypeScript ni bundler
- Módulos cargados como `<script>` en orden en el HTML
- Nombres CSS: `kebab-case` descriptivo (`kpi-val`, `btn-blue`, `modal-overlay`)
- Nombres JS: `camelCase` con verbos (`loadOrdenes`, `renderGantt`, `toast`)
- `console.log` solo con prefijo `[Módulo]` para filtrado en DevTools
- Sin comentarios que expliquen qué hace el código — solo el porqué cuando no es obvio

---

## Licencia

Proyecto propietario — AirTech Assist. Todos los derechos reservados.

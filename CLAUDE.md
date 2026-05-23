# CLAUDE.md — AirTech Assist

Aplicación web PWA para gestión de mantenimiento aeronáutico. Roles: admin y técnico. Stack: HTML + CSS + JS vanilla, Firebase Firestore/Auth, Supabase Storage, Chart.js, jsPDF, XLSX, EmailJS.

---

## UI/UX Pro Max — Reglas de Diseño

> Skill: [UI/UX Pro Max v2.5](https://github.com/nextlevelbuilder/ui-ux-pro-max-skill)

### Sistema de diseño activo

| Token | Valor |
|-------|-------|
| Familia tipográfica | `Inter`, -apple-system, sans-serif |
| Color primario | `#0f2a66` (navy) |
| Color secundario | `#1d4ed8` (blue-700) |
| Color acento | `#3b82f6` (blue-500) |
| Fondo app | `#f1f5f9` (slate-100) |
| Fondo tarjetas | `#ffffff` |
| Texto principal | `#1e293b` (slate-800) |
| Texto secundario | `#64748b` (slate-500) |
| Bordes | `#e2e8f0` (slate-200) |
| Error | `#dc2626` (red-600) |
| Éxito | `#166534` (green-800) |

### Tipografía

- Pesos en uso: 400 (normal), 500 (medium), 600 (semibold), 700 (bold), 800 (extrabold)
- Tamaño base: 13px (UI compacta de escritorio)
- Escala: 10px (label), 11px (meta), 12px (small), 13px (body), 14px (btn), 17px (heading), 22px (KPI value)
- Tracking negativo (`letter-spacing: -.03em`) en títulos y valores KPI grandes

### Componentes y convenciones CSS

**Botones**
```css
/* Siempre: cursor-pointer, font-family: inherit, transición 150-200ms */
.btn { padding: 8px 14px; border-radius: 8px; font-size: 12px; font-weight: 600;
       transition: all .15s; display: flex; align-items: center; gap: 5px; }
.btn:active { transform: scale(.97); }
```

**Tarjetas / Cards**
```css
/* border-radius mínimo: 10px; sombra sutil; hover con elevación */
.card { background: #fff; border: 1px solid #e2e8f0; border-radius: 12px;
        box-shadow: 0 1px 4px rgba(0,0,0,.05); transition: box-shadow .2s, transform .15s; }
.card:hover { box-shadow: 0 6px 20px rgba(0,0,0,.09); transform: translateY(-1px); }
```

**Inputs**
```css
/* focus con ring de color primario, sin outline nativo */
.inp:focus { outline: none; border-color: #0f2a66; box-shadow: 0 0 0 3px rgba(15,42,102,.09); }
```

**Gradiente de marca** (login, loader, headers destacados)
```css
background: linear-gradient(145deg, #050f2e 0%, #0f2a66 45%, #1a3a8f 75%, #1d4ed8 100%);
```

---

## Reglas obligatorias (UI/UX Pro Max Pre-Delivery Checklist)

### Iconos
- **No usar emojis como iconos funcionales.** Usar SVG (Heroicons, Lucide) o caracteres Unicode neutros solo como decoración.
- Excepción: toasts informativos pueden usar emoji Unicode (✅ ⚠ ✈) solo como prefijo de texto.

### Interactividad
- `cursor: pointer` en **todos** los elementos clicables (botones, tabs, filas de tabla, badges, links).
- Estados hover en todos los elementos interactivos con transición `150–300ms`.
- Estados `:active` con `transform: scale(.97)` o reducción de sombra.
- Estados `:focus-visible` explícitos para navegación por teclado — nunca eliminar `outline` sin reemplazarlo.

### Accesibilidad (WCAG AA)
- Contraste mínimo texto/fondo: **4.5:1** en modo claro.
- Respetar `prefers-reduced-motion`: envolver animaciones en `@media (prefers-reduced-motion: no-preference)` o desactivarlas con `animation: none`.
- Atributos `aria-label` en botones icon-only y elementos interactivos sin texto visible.
- `role="alert"` en notificaciones toast dinámicas.

### Responsive
Breakpoints obligatorios: `375px` · `768px` · `1024px` · `1440px`

```css
/* Patrón de grid adaptativo en lugar de breakpoints rígidos */
grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
```

- En móvil (< 768px): KPIs en 2 columnas, tablas con scroll horizontal, modales a ancho completo.
- Inputs y botones: mínimo 44px de altura táctil en móvil.

### Animaciones
- Transiciones de UI: `150–200ms ease`
- Modales / overlays: `200–300ms ease-out`
- Carga / skeletons: `pulse 2s infinite` o `spin .8s linear infinite`
- Sin animaciones puramente decorativas que no aporten feedback al usuario.

### Z-index (escala fija)
| Capa | Valor |
|------|-------|
| Dropdown / tooltip | 100 |
| Sticky header | 500 |
| Modal backdrop | 1000 |
| Modal content | 1001 |
| Toast / notificaciones | 2000 |
| Loader inicial | 9999 |

---

## Patrones de UX específicos de AirTech Assist

### Feedback al usuario
- Toda acción asíncrona debe mostrar estado de carga (spinner, disabled en botón, o skeleton).
- Confirmar operaciones destructivas con modal — nunca con `window.confirm()`.
- Toasts para resultados de operaciones: visibles mínimo 3s, descartables por click.

### Tablas de datos
- Filas con `cursor: pointer` si son clicables.
- Hover: `background: #f8fafc` en filas.
- Columnas numéricas alineadas a la derecha.
- Paginación o scroll virtual para listas > 50 ítems.

### Modales
- Overlay oscuro con `backdrop-filter: blur(2px)` opcional.
- Cerrar con Escape y click en overlay.
- Foco atrapado dentro del modal mientras está abierto.
- Siempre botón de cierre explícito (×) en esquina superior derecha.

### Formularios
- Validación inline, nunca solo al submit.
- Mensajes de error debajo del campo afectado, en rojo (`#dc2626`), 12px.
- Labels siempre visibles — no usar solo placeholder como label.

---

## Anti-patrones prohibidos

- Neon o colores vibrantes fuera del sistema de colores definido.
- Gradientes `AI purple/pink` — esta app es aeronáutica/industrial, no SaaS genérico.
- Animaciones que ignoren `prefers-reduced-motion`.
- Eliminar `outline` de focus sin reemplazarlo.
- `!important` salvo para utilidades de visibilidad (`.hide { display: none !important }`).
- Inline styles para lógica de diseño — solo para valores dinámicos calculados en JS.
- IDs de CSS mezclados con lógica de componentes (los IDs son para JS, las clases para CSS).

---

## Arquitectura del proyecto

```
/
├── index.html          — Shell único, todas las pantallas via display:none/block
├── styles.css          — Todos los estilos (sin preprocesador)
├── app.js              — Lógica principal: estado, Firebase, modales, roles
├── dashboard.js        — Lógica del dashboard y Gantt
├── firebase-init.js    — Inicialización Firebase
├── config.js           — Credenciales locales (no en repo — ver config.example.js)
├── sw.js               — Service Worker (PWA)
├── Seguridad/
│   └── firestore.rules — Reglas de seguridad Firestore
└── Scripts/            — Utilidades y scripts de mantenimiento
```

**Principio de pantallas:** Todas las vistas viven en `index.html`. La navegación se maneja alternando las clases `.on` / ocultando con `display:none`. No usar `window.location` para navegación interna.

---

## Convenciones de código

- JS sin TypeScript ni bundler — ES6+ nativo, módulos vía `<script>` en orden.
- CSS minimalista y sin framework — clases utilitarias inline son aceptables para casos únicos.
- Nombres de clases CSS: kebab-case descriptivo (`kpi-val`, `btn-blue`, `modal-overlay`).
- Nombres de funciones JS: camelCase, verbos (`loadOrdenes`, `renderGantt`, `toast`).
- Sin comentarios que expliquen qué hace el código — solo el porqué cuando no es obvio.
- `console.log` solo con prefijo `[Módulo]` para fácil filtrado en DevTools.

---

## Seguridad (no negociable)

- Nunca incluir credenciales en el código — siempre desde `config.js` (gitignored).
- `config.example.js` como plantilla pública sin valores reales.
- Firestore Rules en `Seguridad/firestore.rules` — revisar antes de deploy.
- CSP definida en `index.html` — toda nueva dependencia CDN debe agregarse a la política.
- Sanitizar cualquier contenido HTML dinámico antes de `innerHTML`.

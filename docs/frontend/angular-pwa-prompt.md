# Prompt de construccion — Frontend Angular + PWA (Barby Toys & Cupidos)

> **Como usar este documento.** Copia el contenido completo (desde "## 1. Rol" hasta
> el final) como instruccion inicial de un agente de codigo o como brief para el
> equipo. No hace falta contexto adicional: aqui esta el contrato real de la API ya
> entregada, las reglas de negocio que la interfaz **debe** respetar y la
> arquitectura propuesta para el frontend.
>
> Backend de referencia: `events-api` (`/api/v1`), documentado en `/api/v1/docs`
> (Swagger UI) y `/api/v1/openapi.json` (OpenAPI 3.1). Arquitectura del backend en
> [`docs/architecture/overview.md`](../architecture/overview.md).

**Indice**

1. Rol y objetivo · 2. Contexto del backend · 3. Alcance del frontend ·
4. Requisitos no funcionales y stack · 5. Arquitectura del proyecto ·
6. Convenciones de la API y mapa de errores · 7. Catalogo de endpoints ·
8. Reglas de negocio que la UI respeta · 9. Modelos y capa de datos ·
10. Pantallas y flujos · 11. Sistema de diseno · 12. PWA ·
13. Seguridad, rendimiento, pruebas y calidad · 14. Plan por fases ·
15. Definicion de terminado · 16. Decisiones abiertas · 17. Anexo de utilidades.

---

## 1. Rol y objetivo

Actua como **arquitecto frontend senior especializado en Angular**. Tu tarea es
construir, desde cero, la interfaz web de la plataforma de eventos de **Barby Toys y
Cupidos**: una aplicacion **Angular (standalone) + PWA** que consuma la `events-api`
existente.

Objetivo del producto: que una persona pueda **descubrir un evento, elegir sede e
inscribirse en menos de un minuto** desde el movil, y que el equipo de operacion
pueda **atender la mesa de registro** (buscar, dar de alta, cancelar) y
**administrar el catalogo** (eventos, sedes, participaciones, cuentas) sin friccion.

Criterios que guian cada decision: **escalabilidad, organizacion por features,
buenas practicas (tipado estricto, signals, accesibilidad AA), y un diseno moderno,
sobrio y rapido**.

---

## 2. Contexto del backend (estado real, no inventado)

| Aspecto | Valor |
| --- | --- |
| Prefijo versionado | `/api/v1` |
| Local | `http://localhost:8787` |
| Runtime | Cloudflare Workers + Hono 4 + `@hono/zod-openapi` |
| Datos | Cloudflare D1 (SQLite) + Drizzle ORM |
| Validacion | Zod 4 (servidor). El cliente **no** comparte esquemas: se tipa a mano |
| Docs vivas | `/api/v1/docs` (Swagger UI), `/api/v1/openapi.json` |
| Autenticacion | Sesion opaca en **cookie `HttpOnly`** (`events_session`), `SameSite=Lax`, `Secure` fuera de `local` |
| Roles | `admin` (escribe catalogo y cuentas) y `operator` (opera la jornada: lee catalogo y gestiona registros) |
| Fases entregadas | Auth + RBAC + cuentas, catalogo de eventos/sedes/participaciones, registro publico + catalogo publico + mesa de registro |
| Fase 5 pendiente | Codigos QR, turnos, check-in y flujo de ajuste de cupos (`capacity_adjustments`) — **no hay endpoints todavia**: deja la UI preparada pero sin llamadas |
| Fase 6 pendiente | Rate limiting expuesto y observabilidad |

Hechos que condicionan el frontend:

- **La sesion no se maneja con tokens en JavaScript.** El navegador envia la cookie
  automaticamente; el cliente nunca la lee ni la guarda.
- **CORS en lista blanca con `credentials: true`**, cabeceras permitidas
  `Content-Type`, `Authorization`, `X-Request-Id`; expuesta al navegador `X-Request-Id`.
  El origen del frontend debe estar en `CORS_ORIGINS` del backend
  (`http://localhost:4200` en local).
- **`SameSite=Lax`**: la cookie no viaja en peticiones cross-site. En desarrollo usa
  el **proxy** de Angular; en produccion, publica el frontend en el **mismo sitio**
  que la API (mismo dominio o subdominio con la cookie en el dominio padre).
- **Fechas**: siempre ISO-8601 **UTC**. El campo `timezone` del evento (por defecto
  `America/Bogota`) indica **como presentarlas**; la UI nunca envia fechas locales.
- **Ids**: ULID en texto. No los trates como enteros ni los acortes.
- Toda respuesta incluye `x-request-id`; conviene mostrarlo en el detalle tecnico de
  los errores (soporte).

---

## 3. Alcance del frontend

**Una sola aplicacion Angular** con dos superficies claramente separadas por
enrutado y por layout:

1. **Sitio publico (PWA, sin sesion)** — es lo que se comparte por WhatsApp:
   - `/` listado de eventos publicados (con busqueda y paginacion).
   - `/e/:slug` ficha publica del evento con sus sedes, cupo disponible y si el
     registro esta abierto.
   - `/e/:slug/registro` formulario de inscripcion (titular + acompanantes).
   - `/registro/:id` comprobante de inscripcion (folio para mostrar en el acceso).
   - `/offline` pantalla de respaldo sin conexion.
2. **Panel operativo (requiere sesion)** bajo `/panel`:
   - `/panel/login`
   - `/panel` tablero del dia (eventos activos, cupos, registros recientes).
   - `/panel/registros` **mesa de registro**: buscar por nombre/documento/email,
     filtrar por sede y estado, alta manual, cancelacion con motivo, ficha con
     acompanantes.
   - `/panel/eventos` (CRUD + transiciones de estado), `/panel/sedes` (CRUD),
     `/panel/participaciones` (cupos y ventanas por sede).
   - `/panel/usuarios` (solo `admin`).
   - `/panel/cuentas` perfil propio y cambio de contrasena (via `POST /users/{id}/password`).

Los guards de rol son **UX, no seguridad**: la API ya valida en cada peticion.

---

## 4. Requisitos no funcionales y stack propuesto

**Requisitos**

| Requisito | Meta concreta |
| --- | --- |
| Escalabilidad | Feature-first: agregar un modulo nuevo no debe tocar los existentes (no hay "carpeta compartida de dios") |
| Rendimiento | LCP < 2.5 s en 4G; rutas lazy; `@defer` para lo pesado; presupuesto de bundle por ruta |
| PWA | Instalable, arranque offline del shell, catalogo legible offline, cola de reintento para altas fallidas por red |
| Accesibilidad | WCAG 2.1 AA: foco visible, roles/aria correctos, contraste >= 4.5:1, navegacion completa por teclado, `prefers-reduced-motion` |
| Internacionalizacion | `es-CO` por defecto, todos los textos en claves i18n; fechas y horas en `America/Bogota` con `Intl` |
| Tipado | `strict: true` + `strictTemplates` + `noUncheckedIndexedAccess`; cero `any` |
| Errores | Ningun error crudo al usuario: mapeo `error.code` → mensaje accionable |
| Observabilidad | Enviar `x-request-id` al log del cliente y ofrecerlo como "codigo de soporte" en pantallas de error |

**Stack (versiones de la linea vigente de Angular)**

- **Angular 20** standalone components, **signals** (`signal`, `computed`, `effect`,
  `linkedSignal`, `resource`), `input()`/`output()`/`model()`, control flow
  `@if/@for/@switch/@defer`, `provideRouter` con `withComponentInputBinding()` y
  **zoneless** (`provideZonelessChangeDetection()`).
- **Nuevo control flow y `inject()`** en lugar de inyeccion por constructor
  (excepto cuando el constructor aporta valor real).
- **Formularios reactivos tipados** (`FormGroup<T>`, `NonNullableFormBuilder`,
  validadores propios) — el formulario publico es el caso critico.
- **HTTP**: `provideHttpClient(withFetch(), withInterceptors([...]))`; un unico
  `ApiClient` tipado sobre `HttpClient` (nada de servicios que llamen a `HttpClient`
  directamente desde componentes).
- **Estado**: signals + servicios `providedIn: 'root'` por feature. RxJS solo donde
  aporta (debounce de busqueda, cancelacion, `switchMap`). Sin NgRx.
- **UI**: elige **uno** y justificalo en el ADR:
  - **Angular Material 3** (tematizado con tokens propios) si se prioriza velocidad y
    accesibilidad nativa;
  - **Tailwind CSS + Angular CDK** (primitivas de overlay/a11y propias) si se prioriza
    control total del diseno.
  No mezcles dos librerias de componentes.
- **PWA**: `@angular/pwa` (service worker + manifest) o un SW propio con
  `@angular/service-worker`; ver seccion 12.
- **Testing**: **Vitest** con `@analogjs/vitest-angular` (unico runner: unit y
  componentes con `TestBed`), **Playwright** para e2e y a11y (`@axe-core/playwright`).
- **Calidad**: ESLint (reglas `@angular-eslint` + `eslint-plugin-rxjs`), Prettier,
  Husky + lint-staged, Commitlint (Conventional Commits).
- **Sin SSR** en la primera version (el panel es privado y el catalogo publico es de
  bajo trafico SEO); dejalo desbloqueado por si mas adelante hace falta `ng add @angular/ssr`.

---

## 5. Arquitectura del proyecto

```
frontend/
  src/
    app/
      app.config.ts            # providers: router, http+interceptores, pwa, i18n, zoneless
      app.routes.ts            # solo composicion: rutas publicas y panel (lazy)
      app.component.ts         # shell minimo: router-outlet + toasts + banner de red
      core/                    # infraestructura transversal, sin logica de negocio
        api/                   # ApiClient, ApiError, tipos del sobre, paginacion
        auth/                  # SessionStore (signals), AuthService, guards, roles
        http/                  # interceptores: base-url, credenciales, errores, request-id, retry
        i18n/                  # catalogo de textos y pipe/helper de traduccion
        config/                # environment.ts / environment.production.ts
        utils/                 # fechas+timezone, normalizacion de documentos, ids
      shared/                  # presentacional reutilizable, sin dependencias de features
        ui/                    # boton, input, select, chip, badge, card, tabla, dialogo, sheet
        layout/                # PublicShell, PanelShell, PageHeader, Sidebar, EmptyState
        directives/ pipes/
      features/
        public-catalog/        # listado + ficha publica (rutas /, /e/:slug)
        public-registration/   # formulario + comprobante
        auth/                  # pantalla de login
        dashboard/             # tablero del panel
        registrations/         # mesa de registro (listado, alta, cancelacion, ficha)
        events/                # CRUD de eventos + transiciones
        establishments/        # CRUD de sedes
        participations/        # cupos y ventanas por sede
        users/                 # cuentas (solo admin)
      app.routes.ts
    styles/                    # tokens.css, base.css, themes/light.css, themes/dark.css
    testing/                   # helpers de TestBed, builders de datos de prueba
```

Reglas de dependencia (verificables con ESLint con restricciones de import):

- `features/*` puede depender de `core/*` y `shared/*`; **nunca** de otra feature.
- `shared/*` no depende de `core/*` ni de `features/*`.
- `core/*` no depende de `features/*`.
- Dentro de cada feature: `*.routes.ts` → `components/` → `data/` (servicios HTTP) →
  `models/`. Los componentes no construyen URLs ni arman respuestas a mano.

---

## 6. Convenciones de la API (contrato que el cliente debe respetar)

**Sobres**

```jsonc
// exito
{ "success": true,  "data": { }, "meta": { "total": 42, "limit": 20, "offset": 0 } }
// error
{ "success": false, "error": { "code": "EVENT_NOT_FOUND", "message": "..." }, "requestId": "..." }
```

- **Ramifica siempre por `error.code`**, nunca por `error.message` (los mensajes
  pueden cambiar; los codigos son contrato estable y publico).
- En `422` el detalle viene en `error.details`:
  `{ target: 'json'|'query'|'param', issues: [{ path: 'companions.0.fullName', code, message }] }`.
  Usalo para **pintar el error en el campo** (`path` es la ruta al control del
  formulario). El servidor nunca devuelve el valor recibido.
- Paginacion uniforme en todos los listados: `limit` (defecto y tope por modulo) y
  `offset`; `meta` devuelve `total`, `limit` y `offset` **realmente aplicados**. No
  asumas que el `limit` pedido se respeto: lee `meta.limit`.
- Cabeceras: `x-request-id` en **todas** las respuestas; guardalo para soporte.
  Puedes enviar `X-Request-Id` si quieres correlacionar tu propio id.

**Limites de paginacion por listado**

| Listado | `limit` por defecto | Tope |
| --- | --- | --- |
| `/public/events` | 10 | 50 |
| `/events`, `/establishments`, `/participations`, `/registrations`, `/users` | 20 | 100 |

**Codigos de estado** — `200/201` exito · `400` JSON malformado · `401` sin sesion,
sesion caducada o revocada · `403` sin permisos · `404` no existe · `409` conflicto de
estado o cupo · `422` validacion de negocio/formato · `429` rate limit · `500/503`
fallo interno o dependencia caida.

## 6.1 Mapa de `error.code` → comportamiento en la UI

| Codigo | Cuando aparece | Que debe hacer la UI |
| --- | --- | --- |
| `VALIDATION_ERROR` | 422 formato/negocio | Pintar `details.issues` en los campos; toast solo si no hay campo asociado |
| `MALFORMED_JSON` / `PAYLOAD_TOO_LARGE` | 400 / 413 | Banner tecnico "vuelve a intentarlo"; nunca por UI normal |
| `ROUTE_NOT_FOUND` | 404 de ruta inexistente | Pantalla 404 propia |
| `UNAUTHENTICATED` / `SESSION_EXPIRED` / `SESSION_REVOKED` | 401 | Limpiar `SessionStore` y redirigir a `/panel/login?returnUrl=...` |
| `ACCOUNT_DISABLED` | 401 | Mensaje "cuenta desactivada, contacta al administrador" |
| `INVALID_CREDENTIALS` | 401 en login | Error en el formulario (mismo texto para email inexistente) |
| `ACCOUNT_LOCKED` | 401 en login | Aviso de bloqueo temporal progresivo; ofrece reintentar mas tarde |
| `FORBIDDEN` | 403 | Pantalla "sin permisos" + volver al tablero |
| `EVENT_NOT_FOUND` / `ESTABLISHMENT_NOT_FOUND` / `PARTICIPATION_NOT_FOUND` / `REGISTRATION_NOT_FOUND` / `USER_NOT_FOUND` | 404 | Estado "no existe o ya no esta disponible" con accion de volver |
| `EVENT_NOT_REGISTRABLE` / `PARTICIPATION_CLOSED` | 409 | Marcar la sede como cerrada y refrescar el catalogo |
| `REGISTRATION_OUTSIDE_WINDOW` | 409 | Mostrar ventana efectiva y deshabilitar el boton de inscripcion |
| `TITULAR_CAPACITY_EXCEEDED` / `COMPANION_CAPACITY_EXCEEDED` | 409 | Explicar que se agoto el cupo y recargar disponibilidad |
| `DUPLICATE_REGISTRATION` | 409 | "Ese documento ya esta inscrito en esta sede" + enlace a la ficha |
| `REGISTRATION_ALREADY_CANCELLED` | 409 | Refrescar el registro; mostrar que ya estaba cancelado |
| `EMAIL_ALREADY_USED` | 409 | Error en el campo email |
| `LAST_ADMIN_PROTECTED` | 409 | Explicar que debe existir al menos un admin activo |
| `STATUS_TRANSITION_INVALID` | 409 | Refrescar el recurso y ofrecer solo transiciones validas |
| `PARTICIPATION_HAS_REGISTRATIONS` | 409 | Bloquear la cancelacion de sede con registros confirmados |
| `CAPACITY_ADJUSTMENT_REQUIRED` | 409 | Explicar que el cupo no se edita en caliente (flujo de aprobacion, Fase 5) |
| `RATE_LIMITED` | 429 | Toast con reintento y `Retry-After` si viene |
| `DATABASE_UNAVAILABLE` / `SERVICE_UNAVAILABLE` / `INTERNAL_ERROR` | 503/500 | Pantalla de error con reintento y codigo de soporte (`requestId`) |

---

## 7. Catalogo de endpoints

### 7.1 Catalogo publico y registro (sin sesion)

| Metodo | Ruta | Descripcion |
| --- | --- | --- |
| GET | `/public/events` | Eventos **publicados** con la disponibilidad de sus sedes |
| GET | `/public/events/{slug}` | Ficha publica; acepta **slug o id** |
| POST | `/public/registrations` | Inscribe al titular y a sus acompanantes |

**`GET /public/events`** — query: `search?` (nombre/slug, <= 120), `limit?` (1-50, 10),
`offset?` (>= 0). Respuesta:

```jsonc
{ "success": true,
  "data": [{
    "id": "01J...", "slug": "dia-del-nino-2026", "name": "Dia del Nino",
    "description": "..." | null, "timezone": "America/Bogota",
    "startsAt": "2026-04-25T15:00:00.000Z" | null,
    "endsAt": null,
    "registrationOpensAt": "..." | null, "registrationClosesAt": "..." | null,
    "participations": [{
      "id": "01J...",
      "establishment": { "id": "01J...", "name": "Sede Norte", "city": "Bogota" | null },
      "availableTitulares": 12, "availableCompanions": 30,
      "registrationOpensAt": "..." | null,
      "registrationClosesAt": "..." | null,
      "registrationOpen": true
    }]
  }],
  "meta": { "total": 3, "limit": 10, "offset": 0 } }
```

**`GET /public/events/{slug}`** — mismo objeto `PublicEvent` en `data`. `404`
`EVENT_NOT_FOUND` si no existe **o** si esta en `draft`, `closed` o `archived` (el
estado interno no se filtra al publico).

**`POST /public/registrations`** — cuerpo (lo comparte el alta del panel):

```jsonc
{
  "participationId": "01J...",            // sede elegida (unidad de cupo)
  "documentType": "CC",                   // CC | TI | CE | PA | RC | NIT
  "documentNumber": "1.020.304.000",      // 4-30, admite puntos/espacios: se normaliza
  "fullName": "Ana Perez",                // 3-120
  "email": "ana@example.com" | null,      // opcional
  "phone": "+57 300 123 4567" | null,     // opcional, 7-20
  "companions": [                          // opcional, max. 10
    { "fullName": "Luis Perez", "documentType": "TI" | null, "documentNumber": "..." | null }
  ]
}
```

Respuesta `201`:

```jsonc
{ "success": true,
  "data": { "id": "01J...", "participationId": "01J...", "documentType": "CC",
            "documentNumber": "1020304000", "fullName": "Ana Perez",
            "companionsCount": 1, "status": "confirmed",
            "registeredAt": "2026-03-14T13:05:11.000Z" } }
```

Errores: `404` `PARTICIPATION_NOT_FOUND` / `EVENT_NOT_FOUND`; `409`
`DUPLICATE_REGISTRATION`, `TITULAR_CAPACITY_EXCEEDED`, `COMPANION_CAPACITY_EXCEEDED`,
`PARTICIPATION_CLOSED`, `EVENT_NOT_REGISTRABLE`, `REGISTRATION_OUTSIDE_WINDOW`; `422`
formato o incoherencia (por ejemplo, mas acompanantes que cupo disponible).

**No hay endpoint publico para consultar un registro por documento.** Si se necesita
"consultar mi inscripcion" en el sitio publico, es un **requisito nuevo** a pedir al
backend; hasta entonces, guarda el folio devuelto en el comprobante y en el navegador
(`localStorage`, ver 10.2) para reconstruir la pantalla `/registro/:id` **solo con los
datos del comprobante**, sin consultar la API.

### 7.2 Autenticacion

| Metodo | Ruta | Acceso | Cuerpo / respuesta |
| --- | --- | --- | --- |
| POST | `/auth/login` | Publico | `{ email, password }` → `200 { user, session }` + `Set-Cookie` |
| POST | `/auth/logout` | Publico | `200 { revoked: boolean }` (idempotente) |
| GET | `/auth/me` | Con sesion | `200 { user, session }` |

```jsonc
{ "user": { "id": "01J...", "email": "admin@example.com", "fullName": "Admin",
            "role": "admin" | "operator", "status": "active" | "disabled" },
  "session": { "id": "01J...", "expiresAt": "2026-03-14T19:30:00.000Z" } }
```

- `INVALID_CREDENTIALS` (401) es el mismo codigo para email inexistente y contrasena
  incorrecta: **no** sugieras en la UI cual de los dos fallo.
- `ACCOUNT_LOCKED` por **bloqueo progresivo**: tras 5 fallos en 15 minutos el bloqueo
  dura 15 minutos y se duplica en cada ronda (tope 8x). Muestra un aviso claro y no
  reintentes en bucle.
- La cookie es `HttpOnly` + `SameSite=Lax`: **todas** las peticiones del panel deben
  hacerse con `credentials: 'include'` (esto se configura **una vez** en el
  interceptor, no en cada llamada).
- `expiresAt` viene del servidor: programar el refresco de `/auth/me` antes de esa
  fecha y, si responde 401, cerrar sesion en la UI.

### 7.3 Salud

`GET /health` (publico, etiqueta "Sistema") — usado por el "estado del servicio" del
panel y por la pantalla de error global. No requiere sesion.

### 7.4 Panel — eventos, sedes y participaciones

| Metodo | Ruta | Acceso | Descripcion |
| --- | --- | --- | --- |
| GET | `/events` | admin, operator | Lista (query: `status?`, `search?`, `limit`, `offset`) |
| GET | `/events/{idOrSlug}` | admin, operator | Ficha por id **o** slug |
| POST | `/events` | admin | Crea (`status` por defecto `draft`) |
| PATCH | `/events/{id}` | admin | Edita campos y estado |
| GET | `/establishments` | admin, operator | Lista (query: `status?`, `search?`, `limit`, `offset`) |
| GET | `/establishments/{id}` | admin, operator | Ficha |
| POST | `/establishments` | admin | Crea (`status` por defecto `active`) |
| PATCH | `/establishments/{id}` | admin | Edita (no hay `DELETE`) |
| GET | `/participations` | admin, operator | Lista (query: `eventId?`, `establishmentId?`, `status?`, `limit`, `offset`) |
| GET | `/participations/{id}` | admin, operator | Ficha con la sede resuelta |
| POST | `/participations` | admin | Suma una sede al evento con cupos iniciales |
| PATCH | `/participations/{id}` | admin | Edita estado, cupos, ventanas o notas |

**Evento** (`Event`): `id`, `slug`, `name`, `description|null`, `timezone`,
`startsAt|endsAt`, `registrationOpensAt|registrationClosesAt` (ISO o `null`), `status`,
`createdBy|null`, `createdAt`, `updatedAt`.

- `POST /events`: `slug` (3-80, `^[a-z0-9]+(-[a-z0-9]+)*$`, sugerido `2026-04-25` style),
  `name` (1-160), `description?|null` (<= 1000), `timezone?`, cuatro fechas
  ISO-8601 UTC **o `null`**, `status?`.
- `PATCH /events/{id}`: mismos campos opcionales; **`null` limpia una fecha** y los
  ausentes se mantienen. El `slug` es **inmutable**: enviarlo distinto → `422` con el
  campo implicado. En la UI, deshabilita el input de slug al editar y explica por que.
- Ciclo de vida: `draft → published → closed → archived`, reabrir es
  `closed → published`, `archived` es terminal. Cualquier otro salto → `409`
  `STATUS_TRANSITION_INVALID`. **La UI ofrece solo las transiciones validas**; el
  selector no debe permitir las invalidas.
- `POST`/`PATCH` devuelven `409 EVENT_SLUG_ALREADY_USED` si el slug ya existe.

**Sede** (`Establishment`): `id`, `code` (2-32, mismo patron de slug), `name`, `city|null`,
`address|null`, `status`, fechas. `code` **inmutable** (422 si se envia distinto);
`status`: `active | inactive`; no existe borrado fisico: "eliminar" en la UI es pasar a
`inactive` con confirmacion.

**Participacion** (`Participation`) — la unidad real de cupo:

```jsonc
{ "id": "01J...", "eventId": "01J...", "establishmentId": "01J...",
  "status": "open" | "closed" | "cancelled",
  "titularCapacity": 150, "companionCapacity": 300,
  "confirmedTitulares": 138, "confirmedCompanions": 210,
  "availableTitulares": 12, "availableCompanions": 90,     // derivados: no los restes tu
  "registrationOpensAt": null,                             // null = hereda del evento
  "registrationClosesAt": null,
  "checkInOpensAt": null, "checkInClosesAt": null,         // Fase 5 (sin uso todavia)
  "notes": null, "createdAt": "...", "updatedAt": "...",
  "establishment": { "id": "...", "code": "sede-norte", "name": "Sede Norte",
                     "city": "Bogota", "status": "active" } }
```

- `POST /participations`: `eventId` (requerido), `establishmentId` (requerido),
  `titularCapacity`, `companionCapacity` (0-100000), ventanas propias `?|null`,
  `notes?|null`. `409 PARTICIPATION_ALREADY_EXISTS` si esa sede ya participa en el evento.
- `PATCH`: `eventId`/`establishmentId` son **inmutables** (422). `409`
  `CAPACITY_ADJUSTMENT_REQUIRED` al cambiar cupo con registros confirmados, `409`
  `PARTICIPATION_HAS_REGISTRATIONS` al cancelar con registros, `409`
  `STATUS_TRANSITION_INVALID` en transiciones no permitidas (`open ↔ closed`,
  `cancelled` terminal).

### 7.5 Panel — mesa de registro

| Metodo | Ruta | Acceso | Descripcion |
| --- | --- | --- | --- |
| GET | `/registrations` | admin, operator | Lista (query: `participationId?`, `status?`, `search?`, `limit`, `offset`) |
| GET | `/registrations/{id}` | admin, operator | Ficha con acompanantes |
| POST | `/registrations` | admin, operator | Alta manual (`source: admin`) |
| POST | `/registrations/{id}/cancel` | admin, operator | Cancela con motivo |

**`Registration`**: `id`, `participationId`, `documentType`, `documentNumber`
(normalizado: mayusculas, sin puntos ni espacios), `fullName`, `email|null`, `phone|null`,
`companionsCount`, `status` (`confirmed | waitlisted | cancelled`), `source`
(`public | admin`), `registeredAt`, `cancelledAt|null`, `cancelledReason|null`,
`createdAt`, `updatedAt`.

**`RegistrationDetail`** = `Registration` + `companions[]`
(`{ id, fullName, documentType|null, documentNumber|null, createdAt }`).

- `search` filtra por **nombre, documento o email** (sin distinguir mayusculas): es el
  buscador principal de la mesa de registro.
- El listado es **cronologico inverso** (`registeredAt` desc, `id` como desempate) e
  **incluye los cancelados**: para ver un solo estado hay que enviar `status`.
- Alta manual: mismo cuerpo que `POST /public/registrations` (7.1) pero la ruta fija
  `source: 'admin'` y responde el **detalle con acompanantes** (`201`).
- Cancelacion: cuerpo `{ "reason": "..." }` (3-200, obligatorio; sin el → `422`).
  Devuelve el registro cancelado (`200`). Errores: `404 REGISTRATION_NOT_FOUND`,
  `409 REGISTRATION_ALREADY_CANCELLED`.

### 7.6 Panel — cuentas (solo `admin`)

| Metodo | Ruta | Descripcion |
| --- | --- | --- |
| GET | `/users` | Lista (query: `role?`, `status?`, `search?` por email/nombre, `limit`, `offset`) |
| POST | `/users` | Crea cuenta (`{ email, fullName, password, role?, status? }`) |
| GET | `/users/{id}` | Ficha administrativa |
| PATCH | `/users/{id}` | Edita `email`, `fullName`, `role`, `status` |
| POST | `/users/{id}/password` | Rota contrasena y revoca sesiones del titular |

**`AdminUser`**: `id`, `email`, `fullName`, `role`, `status`, `failedLoginAttempts`,
`lockedUntil|null`, `lastLoginAt|null`, `createdAt`, `updatedAt`. **Nunca** se exponen
hash, salt ni iteraciones.

- Contrasenas: **minimo 12 caracteres** (max 200). Valida en el cliente con el mismo
  minimo y muestra la politica, pero **no** la relajes.
- El listado **incluye las cuentas desactivadas** (para auditoria): muestra un chip de
  estado y no las ocultes por defecto.
- No hay `DELETE`: "dar de baja" es `status: 'disabled'` con confirmacion.
- `409 EMAIL_ALREADY_USED`; `409 LAST_ADMIN_PROTECTED` si el cambio dejaria el sistema
  sin administradores activos (ni degradar ni desactivar al ultimo admin).
- `POST /users/{id}/password` devuelve
  `{ user: AdminUser, revokedSessions: number }` y **cierra todas las sesiones del
  titular**; si el admin rota su propia contrasena, su sesion tambien se cierra:
  redirige a `/panel/login` con un aviso.
- El administrador inicial se crea con un comando de bootstrap del backend (Fase 4.5,
  pendiente): la UI no ofrece "registro" publico de administradores.

---

## 8. Reglas de negocio que la interfaz debe respetar

1. **`registrationOpen` es la unica fuente de verdad para habilitar el boton de
   inscripcion.** El backend lo calcula exigiendo tres condiciones a la vez: la sede en
   `open`, su establecimiento en `active` y la fecha dentro de la **ventana efectiva**.
   El catalogo usa la misma evaluacion que el alta, asi que si `registrationOpen` es
   `false` no puede existir un alta exitosa: **no recalcules la ventana en el cliente**
   ni la compares con el reloj local para decidir si se puede inscribir.
2. **Ventana efectiva = ventana de la sede, o la del evento cuando la sede no define la
   suya.** En la UI muestra la fecha **efectiva** (los campos que el backend devuelve en
   la participacion publica ya vienen resueltos), no la del evento.
3. **El cupo se reserva de forma condicional en el servidor.** Ante dos altas por el
   ultimo lugar, una prospera y la otra recibe `409` `TITULAR_CAPACITY_EXCEEDED` (o
   `COMPANION_CAPACITY_EXCEEDED`). La UI **nunca** promete "hay cupo": refresca la
   disponibilidad y maneja el 409 con un mensaje claro y accion de elegir otra sede.
4. **Documento unico por sede, no por evento.** La misma persona puede inscribirse en
   varias sedes del mismo evento, pero solo una vez por sede. El documento se
   **normaliza** (mayusculas, solo letras y digitos) antes de comparar: `1.020.304.000`
   y `1020304000` son el mismo. Normaliza tambien en el cliente para la busqueda y para
   el mensaje de duplicado, pero deja la verdad al servidor.
5. **Cancelar libera el documento y devuelve el cupo** (titular + acompanantes) en la
   misma operacion. Si el usuario vuelve a inscribirse, es un alta nueva.
6. **El listado de registros incluye los cancelados** y es cronologico inverso. Filtra
   por `status` cuando la vista necesite "solo vigentes"; muestra los cancelados con
   estilo atenuado y el motivo.
7. **Los estados internos no se filtran al publico**: un evento en `draft`, `closed` o
   `archived` responde `404 EVENT_NOT_FOUND` igual que uno inexistente. En el sitio
   publico, "no encontrado" y "no disponible" se ven igual.
8. **Los identificadores estables no se editan**: `slug` del evento y `code` de la sede
   son inmutables; en edicion, inputs deshabilitados con tooltip explicativo.
9. **Sin borrado fisico**: evento → `archived`; sede → `inactive`; cuenta → `disabled`;
   participacion → `cancelled` (solo sin registros confirmados). Las acciones de
   "eliminar" de la UI son transiciones de estado con confirmacion explicita.
10. **El cupo no se edita en caliente**: con registros confirmados, `PATCH
    /participations/{id}` con nuevos cupos responde `409 CAPACITY_ADJUSTMENT_REQUIRED`.
    La UI muestra el cupo en solo lectura y explica que requiere el flujo de aprobacion
    (Fase 5); deja el punto de extension preparado, sin endpoint inventado.
11. **Las fechas se envian siempre en ISO-8601 UTC** (`new Date(...).toISOString()`);
    la conversion a `America/Bogota` es solo de presentacion. Cuidado con los
    `<input type="datetime-local">`: convierte explicitamente usando el `timezone` del
    recurso antes de enviar.
12. **`status: 'waitlisted'` existe** en los tipos de registro aunque hoy no lo produzca
    ningun flujo: disena los chips/estados para soportarlo sin romper la UI.

---

## 9. Modelos y capa de datos

### 9.1 Tipos (espejo del contrato; sin `any`)

```ts
// core/api/envelope.ts
export type ApiEnvelope<T> = { success: true; data: T; meta?: PageMeta };
export interface PageMeta { total: number; limit: number; offset: number }
export interface ApiErrorBody {
  success: false;
  error: { code: ErrorCode; message: string; details?: ValidationDetails };
  requestId?: string;
}
export type ErrorCode = 'VALIDATION_ERROR' | 'EVENT_NOT_FOUND' | 'DUPLICATE_REGISTRATION' | /* ... */ string;

// features/*/models
export type EventStatus = 'draft' | 'published' | 'closed' | 'archived';
export type EstablishmentStatus = 'active' | 'inactive';
export type ParticipationStatus = 'open' | 'closed' | 'cancelled';
export type RegistrationStatus = 'confirmed' | 'waitlisted' | 'cancelled';
export type RegistrationSource = 'public' | 'admin';
export type DocumentType = 'CC' | 'TI' | 'CE' | 'PA' | 'RC' | 'NIT';
export type UserRole = 'admin' | 'operator';
export type UserStatus = 'active' | 'disabled';

/** Todos los campos de fecha: string ISO-8601 UTC, jamas Date en los modelos de API. */
export type IsoDate = string;
```

`ApiError` (clase propia, en `core/api/`): `status`, `code`, `message`, `details?`,
`requestId?`. Se construye **una sola vez** en el interceptor de errores y es lo que
reciben los stores, de modo que ningun componente parsea el cuerpo del error.

### 9.2 `ApiClient` y servicios por feature

```ts
// core/api/api-client.ts (unico punto que habla con HttpClient)
@Injectable({ providedIn: 'root' })
export class ApiClient {
  private readonly http = inject(HttpClient);
  private readonly base = environment.apiBaseUrl; // '/api/v1' con proxy o URL absoluta

  get<T>(path: string, params?: QueryParams): Observable<T>        // desenvuelve data
  getPage<T>(path: string, params?: QueryParams): Observable<{ items: T[]; meta: PageMeta }>
  post<T>(path: string, body: unknown): Observable<T>
  patch<T>(path: string, body: unknown): Observable<T>
  postForPage<T>(...) // solo si un POST devolviera listado (no hay hoy)
}
```

Interceptores (en orden):

1. **`baseUrlInterceptor`**: antepone `environment.apiBaseUrl` y fuerza
   `withCredentials: true` (la cookie de sesion viaja sola; el JS no la toca).
2. **`requestIdInterceptor`**: añade `X-Request-Id` generado con `crypto.randomUUID()`.
3. **`errorInterceptor`**: normaliza cualquier `HttpErrorResponse` a `ApiError`,
   distingue **fallo de red** (`status === 0` → offline) de **error de API**, y
   reacciona al `401` limpiando `SessionStore` y navegando a login (una sola vez, con
   bandera para no encadenar redirecciones).
4. **`retryInterceptor`**: reintento exponencial **solo** en `GET` con `status === 0`,
   `408`, `429`, `502`, `503`, `504` (max 2 intentos, con jitter). **Nunca** reintentar
   `POST/PATCH`.

Servicios por feature devuelven **tipado del dominio** (no `HttpResponse`) y solo
traducen query params; la logica de filtros y paginacion vive en el store.

### 9.3 Estado con signals

- `SessionStore` (`core/auth`): `#user = signal<AuthUser | null>(null)`,
  `user = this.#user.asReadonly()`, `isAuthenticated = computed(...)`,
  `role = computed(...)`; metodos `load()` (`/auth/me`), `login()`, `logout()`,
  `clear()`. Se hidrata en un `provideAppInitializer` que llama a `/auth/me` y **no**
  bloquea si responde 401 (el panel decide con el guard).
- **Store por feature** (`registrations.store.ts`, `events.store.ts`, ...): señales
  `items`, `meta`, `filters`, `loading`, `error` y una señal `page` con
  `linkedSignal`/`resource` para recargar al cambiar filtros. `computed` para los
  derivados (por ejemplo, `hasNextPage = offset + limit < total`).
- Reglas: los stores no conocen el DOM ni el router; los componentes no llaman a
  `HttpClient`; **una mutacion refetchea** la lista afectada o aplica un parche
  optimista justificado (ver 9.4).
- Busqueda: `toSignal(searchControl.valueChanges.pipe(debounceTime(300),
  distinctUntilChanged(), switchMap(...)))` — el debounce vive en el componente, la
  peticion en el store.

### 9.4 Mutaciones y coherencia

- **Alta de registro** (publica o de mesa): tras `201`, no confies en el cupo cacheado:
  invalida el detalle del evento publico y la lista de registros; navega al comprobante.
- **Cancelacion**: al `200`, actualiza el item de la lista con la respuesta del servidor
  (viene el registro cancelado) y refresca la disponibilidad de la sede.
- **Transiciones de estado** (evento, sede, participacion): sin optimismo; aplica la
  respuesta del servidor y ofrece "deshacer" solo si existe la transicion inversa.
- **Todo error de mutacion** termina en un toast con el mensaje traducido de `error.code`
  y, cuando aplica, el campo marcado en el formulario.

---

## 10. Pantallas y flujos

### 10.1 Sitio publico (sin sesion)

- **`/` Catalogo** — hero corto de marca, buscador con debounce (300 ms) sobre
  `search`, tarjetas de evento (nombre, fecha en `America/Bogota`, ciudad(es) de las
  sedes, badge "Inscripciones abiertas"/"Cerradas"), paginacion con `offset` +
  "Cargar mas" (lee `meta.total`). Pull-to-refresh en movil.
- **`/e/:slug` Ficha** — nombre, descripcion, cuando y donde, y **una tarjeta por
  sede** con: nombre de la sede y ciudad, `availableTitulares`,
  `availableCompanions` (barra de ocupacion si el cupo total es conocido por el panel
  — en publico solo hay disponibles, asi que presenta "quedan N lugares"), la ventana
  efectiva y el boton **"Inscribirme aqui"** habilitado **solo si
  `registrationOpen === true`**. Sedes con `registrationOpen: false` se muestran
  deshabilitadas con el motivo ("cerrada" / "fuera de la ventana").
- **`/e/:slug/registro?participationId=...` Formulario** — reactivo tipado:
  oficialmente `documentType` (select con los 6 valores), `documentNumber`, `fullName`,
  `email` y `phone` opcionales, y una lista **dinamica** de acompanantes (max. 10,
  añadir/quitar con teclado y sin perder foco). Muestra en cabecera la sede elegida y
  su disponibilidad. Estados: `idle` → `submitting` (boton bloqueado, `aria-busy`) →
  `success` (redirige a `/registro/:id`) o `error` (campo o error de negocio).
- **`/registro/:id` Comprobante** — folio visible y copiable, nombre, sede, evento,
  numero de acompanantes y estado, con accion "Compartir" (`navigator.share`, con
  fallback a copiar enlace) y "Anadir a mi calendario" (`.ics` generado en cliente).
  Deja un hueco marcado para el **codigo QR** que llegara en la Fase 5.
- **`/offline`** — explicacion, acciones ya visitadas disponibles y reintento.

Consideraciones publicas: precios/edades no existen en el contrato actual (no los
inventes); textos legales si se añaden, configurables por entorno.

### 10.2 Panel

- **`/panel/login`** — email + contrasena, `autocomplete` correcto, mensaje claro para
  `INVALID_CREDENTIALS`/`ACCOUNT_LOCKED`/`ACCOUNT_DISABLED`. Al entrar, redirige a
  `returnUrl` o al tablero. Nunca revises si el email existe.
- **`/panel` Tablero** — eventos publicados con su ocupacion por sede, registros de las
  ultimas 24 h, boton grande "Abrir mesa de registro". Es la pantalla que se usa un
  sabado a las 9 a.m.: debe cargar en menos de un segundo y funcionar en tablet.
- **`/panel/registros` Mesa de registro** — el nucleo operativo:
  - Buscador unico (`search`) con debounce, chips de filtro por estado
    (`confirmed`, `waitlisted`, `cancelled`) y por sede (`participationId`, con el
    evento y la sede en la etiqueta). Debajo, contador con `meta.total`.
  - Tabla/lista **cronologica inversa** con: nombre, documento (normalizado), sede,
    acompanantes, estado, origen (`public`/`admin`), fecha. Filas canceladas atenuadas
    con el motivo en tooltip. Paginacion por `limit`/`offset`.
  - Acciones por fila: **Ver ficha** (`GET /registrations/{id}`, muestra acompanantes y
    el cupo que consume), **Cancelar** (dialogo con motivo obligatorio, 3-200) y
    **Reinscribir** (abre el alta manual precargada con el documento).
  - **Alta manual** (`POST /registrations`, `source: admin`): mismo formulario que el
    publico, con selector de **evento → sede** que trae la disponibilidad actual
    (`GET /participations?eventId=...`). Si el evento/sede no admite registro, el boton
    explica el motivo antes de intentarlo (`REGISTRATION_OUTSIDE_WINDOW`,
    `PARTICIPATION_CLOSED`, `EVENT_NOT_REGISTRABLE`).
  - **Modo escritorio vs movil**: en escritorio tabla densa con atajos (`/` para buscar,
    `Esc` para cerrar dialogos); en movil, lista con acciones en hoja inferior.
- **`/panel/eventos`** — lista con filtros (`status`, `search`), crear/editar en un
  drawer con secciones (datos, fechas, estado). El selector de estado ofrece **solo**
  transiciones validas desde el estado actual (`draft → published`,
  `published → closed`, `closed → published`, `* → archived`) y confirma las
  irreversibles. El `slug` se autosugiere desde el nombre al crear y queda
  deshabilitado al editar.
- **`/panel/sedes`** — misma estructura; `inactive` con confirmacion y aviso de que la
  sede sale del catalogo publico.
- **`/panel/participaciones`** — filtro por evento (obligatorio por defecto: es donde se
  dimensiona) y por sede; por cada fila, cupos (`titular`/`companion`) con uso
  (`confirmed/total`) y barra; ventanas propias con la indicacion **"hereda del
  evento"** cuando estan vacias; acciones: editar ventanas/notas, `open ↔ closed`,
  cancelar (bloqueado con `PARTICIPATION_HAS_REGISTRATIONS`). El cupo se muestra en solo
  lectura si existen registros confirmados (`CAPACITY_ADJUSTMENT_REQUIRED`).
- **`/panel/usuarios`** (solo `admin`) — tabla con rol y estado, crear cuenta, editar,
  desactivar (no borrar) y "Rotar contrasena" con aviso de revocacion de sesiones.

Todos los listados comparten: skeleton de carga, estado vacio con accion primaria,
estado de error con reintento y `requestId` copiable, y **persistencia de filtros en la
URL** (`?status=cancelled&page=2`) para poder compartir el enlace.

---

## 11. Sistema de diseno (moderno, sobrio, rapido)

**Principios**: mobile-first, mucho aire, jerarquia tipografica clara, color con
proposito, nada de decoracion que no ayude a inscribirse. Estetica de marca "Barby Toys
& Cupidos": calida y familiar sin ser infantil; el panel, en cambio, es **denso,
neutro y de alta legibilidad** (es una herramienta de trabajo).

**Tokens** (`styles/tokens.css`, exportados tambien como variables de componente):

- **Color**: primario de marca, secundario, superficie/elevaciones (3 niveles),
  borde, texto (3 niveles), semanticos `success`/`warning`/`danger`/`info`, y un
  **color por estado de dominio** (borrador, publicado, cerrado, archivado, abierto,
  cancelado, confirmado, en espera, activo, inactivo). Tema claro y oscuro con
  `color-scheme` y `prefers-color-scheme` + conmutador manual persistido.
- **Tipografia**: escala modular (12/14/16/20/24/32/40), pesos 400/500/600/700,
  `line-height` 1.4-1.6, fuente variable del sistema con fallback; numeros tabulares en
  cupos y documentos (`font-variant-numeric: tabular-nums`).
- **Espaciado**: escala de 4 px; radios 8/12/16/999; elevaciones suaves (nada de sombras
  duras moradas por defecto).
- **Movimiento**: 150/250/350 ms, `ease-out` al entrar, `ease-in` al salir; respeta
  `prefers-reduced-motion: reduce` (transiciones a 0.01 ms).
- **Grid**: contenedor max. 1200 px, 12 columnas, breakpoints 480/768/1024/1440.

**Componentes base** (en `shared/ui`, con estados `default/hover/focus/active/disabled/
loading` y API tipada por `input()`):

`Button` (variantes primary/secondary/ghost/danger, tamaños, `loading`, `iconOnly` con
`aria-label` obligatorio), `TextField` (label flotante o fijo, hint, error, contador),
`Select`, `Combobox` con busqueda, `Checkbox/Switch`, `DatePicker` (con conversion a
UTC), `Chip`/`Badge` de estado, `Card`, `DataTable` (orden, paginacion, columna
fijada, fila expandible), `Dialog`/`BottomSheet` (con focus trap y `Esc`),
`Toast` (con `aria-live="polite"`), `Skeleton`, `EmptyState`, `CapacityBar`,
`CopyToClipboard`, `PageHeader`, `Tabs`.

**Estados obligatorios en toda vista con datos**: `loading` (skeleton con la forma real
del contenido), `empty` (ilustracion simple + accion), `error` (mensaje traducido +
"Reintentar" + `requestId`), `offline` (banner + datos cacheados) y `stale` (aviso de
"actualizado hace X" con boton de refresco). Nunca dejes una lista vacia sin
explicacion.

**Accesibilidad (AA)**: foco visible con `:focus-visible` de 2 px, todo control
alcanzable por teclado en orden logico, labels asociados (`for`/`id`) o `aria-label`,
errores anunciados con `aria-describedby` + `role="alert"` en el resumen,
`aria-live` en contadores y toasts, contraste verificado de los tokens en ambos temas,
`prefers-contrast` respetado, areas tactiles de 44x44 px minimo y `lang="es-CO"`.

---

## 12. PWA

**Manifest** (`manifest.webmanifest`): `name`/`short_name` de marca, `display:
standalone`, `start_url: /`, `scope: /`, `theme_color`, `background_color`,
`orientation: portrait-primary`, iconos 192/512 + `maskable` + `apple-touch-icon`,
`shortcuts` ("Buscar eventos" → `/`, "Mesa de registro" → `/panel/registros`) y
`screenshots` para el prompt de instalacion.

**Service worker** (Angular SW, `ngsw-config.json`) — estrategia por tipo de recurso:

| Recurso | Estrategia | Motivo |
| --- | --- | --- |
| `index.html`, bundle de la app | `prefetch` (app shell) | Arranque instantaneo offline |
| Fuentes, imagenes de UI, iconos | `lazy` + `performance` | Cache estable con versionado |
| `GET /api/v1/public/events*` | `freshness` (timeout 3 s, red primero) | Catalogo legible offline, datos frescos si hay red |
| `GET /api/v1/health` | **sin cache** | Nunca mentir sobre el estado |
| `/api/v1/auth/**`, `/api/v1/registrations*`, `/api/v1/events*`, `/panel/**` | **sin cache** (`dataGroups` no aplica; excluidos del `dataGroup`) | Datos de sesion y operativos: jamas servidos desde cache |

- **Todo lo privado se excluye del cache del SW** (nada de registros, cuentas ni
  catalogos internos cacheados en un dispositivo compartido).
- **Offline de escritura**: `POST /public/registrations` no se puede cachear. Si el
  navegador esta offline, ofrece **reintentar** (y opcionalmente guarda el formulario en
  `localStorage` para no perder los datos), pero **no** simules exito ni prometas la
  inscripcion: informa que hace falta conexion.
- **Actualizaciones**: `SwUpdate.versionUpdates` → banner no intrusivo "Hay una version
  nueva" con `activateUpdate()` + recarga; nunca recargues por sorpresa mientras el
  operador esta escribiendo en la mesa de registro.
- **Instalacion**: captura `beforeinstallprompt` y ofrece "Instalar app" en el sitio
  publico (nunca en el panel); documenta el flujo en iOS (Compartir → Añadir a inicio).
- **Comprobante offline**: guarda en `localStorage` los ultimos comprobantes propios
  (folio, evento, sede, documento, acompanantes) para que `/registro/:id` funcione sin
  red. Es el unico dato personal que se persiste en el cliente: dejalo bajo una clave
  con versionado, con boton de borrado y caducidad (por ejemplo 30 dias).
- **Sin notificaciones push ni background sync** en esta fase: no hay endpoints que los
  justifiquen.

---

## 13. Seguridad, rendimiento, pruebas y calidad

### 13.1 Seguridad en el cliente

- **Nunca** guardes tokens ni la cookie en `localStorage`/`sessionStorage`: la sesion es
  `HttpOnly` y la gestiona el navegador. Nada de `Authorization` manual.
- `withCredentials: true` centralizado en el interceptor; el backend usa lista blanca
  `CORS_ORIGINS` con `credentials: true`.
- **CSRF**: `SameSite=Lax` ya impide enviar la cookie desde otro sitio en peticiones
  no-GET; no añadas el token en la URL ni en `localStorage`. Si productivamente el
  frontend y la API quedan en **sitios distintos**, esto se rompe: exige mismo sitio
  (o pide al backend `SameSite=None; Secure` + doble submit). Documenta la decision.
- **Guards y directivas de rol son UX**: la autorizacion real la hace la API. Una
  directiva `*appHasRole="'admin'"` puede ocultar UI, **nunca** sustituir una llamada
  protegida.
- **Sanitizacion**: usa el binding de Angular (`[innerHTML]` solo con
  `DomSanitizer` justificado y contenido propio). Nada de `eval`/`Function`.
- **Datos personales**: minimiza lo persistido (solo comprobantes propios), permiten
  borrado y no registres documentos/emails en logs del cliente ni en analitica.
- **Cabeceras**: documenta la configuracion del hosting (CSP sin `unsafe-inline` si es
  posible, `Referrer-Policy: strict-origin-when-cross-origin`, `X-Content-Type-Options:
  nosniff`, HSTS).
- **Errores**: muestra codigo + `requestId`, jamas el stack ni el cuerpo crudo.

### 13.2 Rendimiento

- Rutas `loadChildren`/`loadComponent` en todos los casos; `PreloadAllModules` no: usa
  `withPreloading(QuickLinkStrategy)` o precarga solo lo publico.
- Presupuestos en `angular.json`: `initial` < 250 kB warning / 400 kB error; por
  componente lazy < 150 kB.
- `@defer (on viewport|on idle)` para mapa de sedes, tablas grandes y el editor de
  acompanantes; `NgOptimizedImage` con `width`/`height` y `priority` en el hero.
- Cambio de deteccion **zoneless** + `OnPush` (implicito con signals) y `track` en
  todos los `@for` (por `id`, nunca `$index`).
- Evita peticiones en cascada: el detalle publico ya trae las participaciones; la mesa
  de registro carga catalogos de sede una vez y los comparte por store.
- Mide con Lighthouse CI (objetivo >= 90 en Performance, Accessibility, Best Practices
  y SEO en las rutas publicas) y guarda el reporte del PR.

### 13.3 Pruebas

| Nivel | Herramienta | Que se cubre |
| --- | --- | --- |
| Unit puro | Vitest | Utilidades de fecha/timezone, normalizacion de documento, mapeo `error.code` → mensaje, guards y validadores |
| Componente | Vitest + TestBed + `HttpTestingController` | Formulario publico (dinamica de acompanantes, errores por campo desde `details.issues`), chips de filtro, tabla, dialogos |
| Store/servicio | Vitest | Paginacion (`meta`), cache/invalidacion tras mutacion, reaccion al 401, reintentos solo en GET |
| e2e | Playwright | Flujo publico completo (listado → ficha → alta → comprobante), login, alta manual, busqueda, cancelacion, y el `409 DUPLICATE_REGISTRATION` visible |
| a11y | `@axe-core/playwright` | Sin violaciones serias en rutas publicas y panel |
| Contrato | Smoke contra `/api/v1/openapi.json` | Los nombres de campos que usa el cliente existen en el esquema publicado (falla el CI si el backend cambia) |

Datos de prueba: factorias tipadas (`testing/factories.ts`) que construyan eventos,
participaciones y registros validos; **nunca** llames al backend real en unit tests.

### 13.4 Calidad y DX

- `tsconfig` estricto + `strictTemplates`; `no-console` en `lib` (usa el logger).
- ESLint: sin `any`, sin `console`, orden de imports, sin subscripciones sin limpiar
  (`takeUntilDestroyed`), restricciones de import por capas (seccion 5).
- Prettier, `lint-staged`, Conventional Commits, plantilla de PR con checklist de
  accesibilidad y de reglas de negocio.
- CI (GitHub Actions): `npm ci` → `lint` → `typecheck` → `test --coverage` →
  `build --configuration production` → e2e Playwright → Lighthouse CI. Un PR no entra
  sin todo en verde y sin ADR si toca arquitectura.

### 13.5 Entornos y arranque

```bash
ng new frontend --style=css --routing --ssr=false
cd frontend
npm i -D @analogjs/vitest-angular vitest @vitest/coverage-v8 @playwright/test @axe-core/playwright
ng add @angular/pwa            # service worker + manifest
```

- **Desarrollo**: `proxy.conf.json` redirige `/api` a `http://localhost:8787`, de modo
  que el navegador ve un **mismo origen** y la cookie `SameSite=Lax` funciona sin
  tocar `CORS_ORIGINS` (si usas origen explicito, añade `http://localhost:4200` al
  backend).
- `environment.ts`: `apiBaseUrl: '/api/v1'`, `environmentName`, `supportUrl`,
  `enableDevtools`. `environment.production.ts` con la URL real del Worker.
- Comandos: `npm start`, `npm run build`, `npm test`, `npm run test:cov`, `npm run e2e`,
  `npm run lint`, `npm run typecheck`.

---

## 14. Plan de trabajo sugerido (por fases, con entregables)

| Fase | Entregable | Criterio de cierre |
| --- | --- | --- |
| A. Fundacion | Proyecto, tokens, `shared/ui` minimo, `ApiClient` + interceptores, `SessionStore`, esqueleto de rutas y layouts, CI | `lint`/`typecheck`/`test`/`build` en verde y pagina estatica navegable |
| B. Catalogo publico | `/`, `/e/:slug`, estados de carga/vacio/error, PWA instalable con SW | Flujo listado → ficha con `registrationOpen` correcto en Playwright |
| C. Inscripcion publica | Formulario, acompanantes, comprobante, mapeo de los 409 y del 422 por campo | e2e de alta + duplicado + cupo agotado simulados |
| D. Panel | Login, guards, tablero, mesa de registro (buscar, alta manual, cancelar, ficha) | Un operador atiende 20 registros seguidos sin recargar la pagina |
| E. Administracion | Eventos, sedes, participaciones (con transiciones validas) y usuarios | Cada `409` del contrato tiene mensaje y accion probados |
| F. Endurecimiento | Lighthouse >= 90, a11y sin violaciones, presupuestos, offline del catalogo, actualizacion del SW | Reporte de Lighthouse y axe adjuntos; presupuesto respetado |

**Huecos para la Fase 5 del backend** (no implementar todavia, dejar preparado):
`/registro/:id` con hueco de QR, `checkIn*` visibles solo como informacion, y
`capacity_adjustments` como futuro flujo de aprobacion (sin endpoint: no inventes
llamadas).

---

## 15. Definicion de terminado (checklist de aceptacion)

- [ ] Una persona en el movil completa: abrir `/` → elegir evento → elegir sede → inscribirse → ver folio, **sin scroll horizontal y sin zoom**.
- [ ] El boton de inscripcion solo aparece habilitado con `registrationOpen === true`, y el motivo se explica siempre que este deshabilitado.
- [ ] `DUPLICATE_REGISTRATION`, `TITULAR_CAPACITY_EXCEEDED`, `COMPANION_CAPACITY_EXCEEDED`, `PARTICIPATION_CLOSED`, `EVENT_NOT_REGISTRABLE` y `REGISTRATION_OUTSIDE_WINDOW` muestran mensajes distintos, en `es-CO`, con la accion siguiente.
- [ ] Un `422` pinta el error **en el campo** indicado por `details.issues[].path`.
- [ ] El `401` cierra la sesion y lleva al login conservando `returnUrl`; el `403` muestra una pantalla de permisos.
- [ ] La mesa de registro busca por nombre, documento y email; por defecto **incluye cancelados** y los distingue visualmente con su motivo.
- [ ] Cancelar exige motivo, actualiza la fila sin recargar y respeta `REGISTRATION_ALREADY_CANCELLED`.
- [ ] `slug` y `code` son inmutables en la UI; los estados solo ofrecen transiciones validas.
- [ ] Ningun dato sensible (documento, email, hash, cookie) aparece en `localStorage` salvo los comprobantes propios, y estos se pueden borrar.
- [ ] La app funciona en tablet 768 px y en movil 360 px; en el panel, la tabla es usable con teclado.
- [ ] `axe` sin violaciones serias/graves; contraste AA verificado en claro y oscuro; `prefers-reduced-motion` respetado.
- [ ] Offline: el shell arranca, el catalogo previamente visto se puede leer y la escritura avisa que necesita conexion (sin mentir sobre el exito).
- [ ] `error.code` es siempre la rama de decision: cero comparaciones de `error.message` en el codigo.
- [ ] Ninguna fecha se envia en hora local: todo sale como ISO-8601 UTC.
- [ ] CI en verde: lint, typecheck, unit, e2e, build de produccion y Lighthouse.

---

## 16. Decisiones abiertas (resolver antes de la Fase A)

1. **Libreria de UI**: Material 3 tematizado o Tailwind + CDK. Decide y escribe el ADR;
   no mezcles.
2. **Hospedaje y mismo sitio**: el frontend deberia servirse desde el mismo dominio que
   el Worker (ideal: cookie `SameSite=Lax` sin cambios). Si se sirve desde otro sitio,
   hacen falta cambios de CORS y de politica de cookie (`SameSite=None; Secure`) mas
   estrategia CSRF: documentalo antes de empezar.
3. **Analitica**: si se habilita, anonimiza y excluye documentos/emails; define eventos
   minimos (vista de evento, inicio de alta, alta exitosa, tipo de error).
4. **SEO/SSR**: sin SSR en la v1, pero si el catalogo publico debe posicionar, planifica
   `@angular/ssr` con las rutas publicas pre-renderizadas.
5. **Consultar mi inscripcion**: si el negocio lo necesita, pide al backend un endpoint
   publico (por ejemplo, verificacion por documento + codigo) en vez de resolverlo solo
   con datos locales.
6. **Marca**: paleta, tipografia, logotipos e ilustraciones definitivas; hasta entonces
   usa tokens placeholder documentados.

---

## 17. Anexo: utilidades que debes escribir primero

```ts
// core/utils/dates.ts  — presentacion en la zona del evento, envio en UTC
export function toZonedDisplay(iso: string | null, timeZone: string,
  options?: Intl.DateTimeFormatOptions): string;      // '' si null
export function localInputToUtcIso(localValue: string, timeZone: string): string;
export function utcIsoToLocalInput(iso: string | null, timeZone: string): string; // datetime-local
export function describeWindow(opensAt: string | null, closesAt: string | null,
  timeZone: string): string;                          // "Abierto hasta el 20 de abril, 23:59"

// core/utils/documents.ts — misma normalizacion que el servidor
export function normalizeDocument(value: string): string;   // trim, mayusculas, [^A-Z0-9]
export function isValidDocumentInput(value: string): boolean;
export function formatDocument(value: string, type: DocumentType): string; // presentacion

// core/api/error-messages.ts — unica tabla code → texto i18n
export const ERROR_MESSAGES: Record<string, string>;  // clave i18n por codigo del catalogo
```

**Glosario**: *evento* (catalogo con ciclo `draft→published→closed→archived`) ·
*establecimiento/sede* (`active|inactive`) · *participacion* (una sede dentro de un
evento: **la unidad de cupo**) · *titular* (persona que se inscribe y recibe el QR) ·
*acompanante* (declarado por el titular; no recibe QR) · *registro* (`confirmed`,
`waitlisted`, `cancelled`; `source` `public|admin`) · *ventana efectiva* (la de la sede o,
si falta, la del evento) · *`registrationOpen`* (veredicto del servidor sobre si hoy se
puede inscribir en esa sede).

---

**Como cerrar este encargo**: entrega el proyecto ejecutable, con un `README` de la app
(arranque, proxy, variables de entorno, scripts), el ADR de las decisiones 1 y 2 y la
suite de pruebas en verde. Si algo del contrato no cuadra con lo documentado aqui,
**gana siempre `/api/v1/openapi.json`**: contrasta, avisa y no inventes campos.


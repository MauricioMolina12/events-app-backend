# Events API

Backend de **registro de participantes, emision de codigos QR y asignacion de turnos de acceso** para los eventos de Barby Toys y Cupidos.

| Capa          | Tecnologia                                                                  |
| ------------- | --------------------------------------------------------------------------- |
| Runtime       | Cloudflare Workers (workerd)                                                |
| HTTP          | [Hono](https://hono.dev) 4 + `@hono/zod-openapi` (OpenAPI 3.1)              |
| Base de datos | Cloudflare D1 (SQLite) con [Drizzle ORM](https://orm.drizzle.team)          |
| Validacion    | [Zod](https://zod.dev) 4                                                    |
| Documentacion | OpenAPI 3.1 + Swagger UI                                                    |
| Pruebas       | [Vitest](https://vitest.dev) 4 dentro de workerd (`@cloudflare/vitest-plugin`) |
| Lenguaje      | TypeScript estricto                                                         |

---

## Requisitos

- **Node.js >= 22** (desarrollado con Node 22.13).
- Cuenta de Cloudflare. **En produccion se requiere el plan Workers Paid**: el
  hashing de contrasenas (PBKDF2-SHA256, >= 210 000 iteraciones) excede el limite
  de 10 ms de CPU por peticion del plan gratuito. Ver
  [`docs/architecture/overview.md`](docs/architecture/overview.md).

---

## Puesta en marcha

```bash
npm install          # instala dependencias
npm run cf-typegen   # genera worker-configuration.d.ts (tipos de bindings + runtime)
npm run dev          # servidor local en http://localhost:8787
```

Comprobacion rapida:

```bash
curl http://localhost:8787/api/v1/health
```

- Documentacion interactiva: <http://localhost:8787/api/v1/docs>
- Documento OpenAPI: <http://localhost:8787/api/v1/openapi.json>

### Variables de entorno

Los valores no sensibles viven en `wrangler.jsonc` (`vars`). Los secretos:

| Entorno    | Mecanismo                                                    |
| ---------- | ------------------------------------------------------------ |
| Local      | `.dev.vars` (partir de `.dev.vars.example`; esta en .gitignore) |
| Produccion | `wrangler secret put <NOMBRE> --env production`              |

| Variable                   | Descripcion                                                            |
| -------------------------- | ---------------------------------------------------------------------- |
| `ENVIRONMENT`              | `local` \| `development` \| `production`. Un valor invalido produce 500. |
| `CORS_ORIGINS`             | Lista blanca de origenes separada por comas. Vacia = ningun origen permitido. |
| `PBKDF2_ITERATIONS`        | Iteraciones de PBKDF2-SHA256 (1000-1000000; por defecto 210 000).      |
| `SESSION_TTL_HOURS`        | Vigencia de una sesion, en horas (1-720; por defecto 12).              |
| `SESSION_COOKIE_NAME`      | Nombre de la cookie de sesion (por defecto `events_session`).          |
| `AUTH_MAX_FAILED_ATTEMPTS` | Fallos por cuenta en 15 min antes del primer bloqueo (1-100; 5).       |
| `AUTH_LOCKOUT_MINUTES`     | Duracion del primer bloqueo, en minutos (1-1440; 15).                  |

Ninguna de las variables de autenticacion es un secreto: el salt y el derivado
PBKDF2 se generan **por usuario** al dar de alta la cuenta. Un `var` presente pero
fuera de rango produce 500 en la primera peticion: es preferible fallar ruidosamente
a arrancar con un coste de hashing inseguro.

---

## Scripts

| Script                      | Descripcion                                                      |
| --------------------------- | ---------------------------------------------------------------- |
| `npm run dev`               | Servidor de desarrollo local (Wrangler).                         |
| `npm run deploy`            | Despliega **el entorno `production`** (`wrangler deploy --env production`). |
| `npm run cf-typegen`        | Regenera `worker-configuration.d.ts` desde `wrangler.jsonc`.     |
| `npm run typecheck`         | Type-check de `src/` y `tests/` (regenera tipos antes).          |
| `npm test`                  | Ejecuta Vitest dentro de workerd (regenera tipos antes).         |
| `npm run test:watch`        | Vitest en modo watch.                                            |
| `npm run db:generate`       | Genera migraciones SQL con Drizzle Kit desde el esquema.         |
| `npm run db:migrate:local`  | Aplica migraciones a la D1 local.                                |
| `npm run db:migrate:remote` | Aplica migraciones a la D1 de produccion.                        |
| `npm run db:seed:local`     | Carga datos de desarrollo en la D1 local (`src/db/seeds/dev.sql`). |

---

## Base de datos (D1)

`wrangler.jsonc` declara el binding `DB` con un `database_id` **placeholder**.
Para crear la base real:

```bash
npx wrangler d1 create events-db   # copia el database_id devuelto
# pega el id en wrangler.jsonc (bloques raiz y env.production)
npm run cf-typegen
npm run db:migrate:local
```

En local el placeholder es suficiente: Wrangler crea una base SQLite aislada en
`.wrangler/`.

Para cargar datos de ejemplo:

```bash
npm run db:seed:local
```

El seed (`src/db/seeds/dev.sql`) es idempotente: usa identificadores fijos y
`ON CONFLICT DO NOTHING`. No siembra usuarios porque la contrasena se deriva con
PBKDF2 dentro del Worker: el administrador inicial se creara con el comando de
bootstrap (Fase 4).

### Reglas de acceso a datos

D1 **no soporta transacciones interactivas** (`BEGIN`/`COMMIT` estan
prohibidos). La atomicidad se consigue con:

1. Sentencias unicas condicionales (`INSERT ... ON CONFLICT DO ... RETURNING`,
   `UPDATE ... WHERE ...`).
2. Indices unicos y parciales que hacen imposible el estado invalido.
3. `env.DB.batch([...])` cuando varias sentencias deben aplicarse como un todo.

Limites a respetar: 100 parametros por consulta, 100 KB por sentencia, 30 s por
consulta y ~1000 subpeticiones por invocacion (plan Paid).

### Modelo de datos

13 tablas definidas en `src/db/schema/` (un archivo por grupo) y materializadas en
`migrations/`, que es **SQL generado** con `npm run db:generate` y no se edita a
mano.

| Grupo       | Tablas                                                     |
| ----------- | ---------------------------------------------------------- |
| Catalogo    | `events`, `establishments`, `event_establishments`         |
| Registro    | `registrations`, `registration_companions`                 |
| Operacion   | `shifts`, `shift_assignments`, `qr_codes`, `qr_deliveries`  |
| Cupos       | `capacity_adjustments`                                     |
| Auth        | `users`, `sessions`, `auth_attempts`                       |

- `event_establishments` es la unidad real de cupo: `confirmed_titulares` y
  `confirmed_companions` son la fuente de verdad y los `CHECK` de la tabla impiden
  que se sobrepasen. Reservar es `UPDATE ... WHERE confirmed_titulares <
  titular_capacity`: si no cambia ninguna fila, no habia cupo.
- Un documento es unico por **participacion** (evento + sede), no por evento: la
  misma persona puede asistir a varias sedes. Los registros cancelados quedan fuera
  del indice, de modo que se puede volver a inscribir el mismo documento.
- Los indices unicos parciales expresan invariantes que antes vivian en el codigo:
  un QR activo por registro, una asignacion activa por registro y un ajuste de cupo
  pendiente por participacion.

### Traduccion de restricciones

`src/db/constraints.ts` es el **unico** lugar donde se interpretan los mensajes de
error de SQLite. Los repositorios envuelven sus escrituras en
`withConstraintTranslation`, asi que un choque de indice llega arriba como
`AppError` con codigo de negocio (`DUPLICATE_REGISTRATION`,
`TITULAR_CAPACITY_EXCEEDED`, ...) en lugar de un 500. Detalles en
[`docs/architecture/overview.md`](docs/architecture/overview.md).

---

## Estructura del proyecto

```
src/
  index.ts                  # entrypoint del Worker
  app.ts                    # composicion de Hono (middleware + rutas + OpenAPI)
  config/
    constants.ts            # constantes estaticas (prefijo /api/v1, metadatos)
    env.ts                  # lectura y validacion de bindings y vars
  core/
    crypto/                 # codificacion (base64url/hex) y SHA-256
    errors/                 # AppError, catalogo de codigos, manejador global
    http/                   # sobres de respuesta, esquemas, paginacion y error
    middleware/             # request-id, logging estructurado, CORS
    types/                  # contexto de Hono (Bindings + Variables)
  db/
    client.ts               # conexion Drizzle sobre el binding D1
    constraints.ts          # traduccion de restricciones de SQLite
    helpers.ts              # ULID y utilidades de escritura
    schema/                 # esquema Drizzle: 13 tablas, un archivo por grupo
    seeds/dev.sql           # datos de desarrollo (npm run db:seed:local)
  modules/
    auth/                   # login/logout/me, sesiones y guards de rol
    health/                 # modulo de estado del servicio
    users/                  # cuentas: alta, edicion, baja logica y contrasenas
    events/                 # catalogo de eventos: CRUD, ventanas y estados
    establishments/         # catalogo de sedes
    participations/         # una sede dentro de un evento: cupos y ventanas
    registrations/          # altas y cancelaciones atomicas
migrations/                 # SQL generado por Drizzle Kit + _journal.json
tests/
  setup/                    # migraciones de pruebas sobre la D1 de workerd
  helpers/                  # limpieza entre casos y conteos
  unit/                     # pruebas de unidades puras
  integration/              # pruebas de la app completa en workerd
docs/
  architecture/overview.md  # arquitectura, decisiones y roadmap
  frontend/angular-pwa-prompt.md  # brief del frontend Angular + PWA
  comercial/cotizacion-frontend-angular-pwa.md  # propuesta comercial de precio fijo (COP 650.000)
```

Cada modulo de negocio sigue el patron `*.routes.ts` -> `*.service.ts` ->
`*.repository.ts`: las rutas validan y serializan, los servicios contienen las
reglas de negocio y los repositorios son los unicos que hablan con D1.

---

## Autenticacion

Sesiones **opacas** en cookie `HttpOnly`: la contrasena se deriva con PBKDF2-SHA256 y
de D1 solo se lee el SHA-256 del token de sesion, nunca el token en claro.

| Metodo | Ruta                   | Acceso     | Descripcion                                      |
| ------ | ---------------------- | ---------- | ------------------------------------------------ |
| POST   | `/api/v1/auth/login`   | Publico    | Valida credenciales y emite la cookie de sesion.  |
| POST   | `/api/v1/auth/logout`  | Publico    | Revoca la sesion y borra la cookie (idempotente). |
| GET    | `/api/v1/auth/me`      | Con sesion | Devuelve el usuario y la sesion activa.           |

```bash
curl -i -X POST http://localhost:8787/api/v1/auth/login \
  -H 'content-type: application/json' \
  -d '{"email":"admin@example.com","password":"<contrasena>"}'
```

- Cuerpo de exito de `login` y `me`: `{ user: { id, email, fullName, role, status },
  session: { id, expiresAt } }`. Las cuentas se crean con `POST /api/v1/users` (solo
  administradores); el administrador inicial, con el comando de bootstrap (Fase 4.5,
  pendiente).
- Roles: `admin` y `operator` (`src/db/schema/auth.ts`). `requireAuth` resuelve la
  cookie y publica el usuario en el contexto; `requireRole(...)` protege las rutas de
  administracion y de catalogo (`admin` escribe; `admin` y `operator` leen).
- Codigos de rechazo: `INVALID_CREDENTIALS` (identico para email inexistente y
  contrasena incorrecta, para no permitir enumeracion de cuentas), `ACCOUNT_LOCKED`,
  `ACCOUNT_DISABLED`, `UNAUTHENTICATED`, `SESSION_EXPIRED`, `SESSION_REVOKED` y
  `FORBIDDEN`.
- Bloqueo progresivo: superados `AUTH_MAX_FAILED_ATTEMPTS` fallos de la misma cuenta
  dentro de una ventana de 15 minutos, el bloqueo dura `AUTH_LOCKOUT_MINUTES` y se
  duplica en cada ronda posterior (tope 8x). Los intentos viven en `auth_attempts`
  con la IP **hasheada**, no en claro.
- La cookie se marca `Secure` fuera de `local` (en local el desarrollo es http y el
  navegador descartaria una cookie `Secure`).

---

## Administracion

### Cuentas (solo administradores)

| Metodo | Ruta                          | Descripcion                                          |
| ------ | ----------------------------- | ---------------------------------------------------- |
| GET    | `/api/v1/users`               | Lista las cuentas (filtros por rol, estado y texto).  |
| POST   | `/api/v1/users`               | Crea una cuenta (`operator` y `active` por defecto).  |
| GET    | `/api/v1/users/{id}`          | Ficha administrativa de una cuenta.                   |
| PATCH  | `/api/v1/users/{id}`          | Edita email, nombre, rol o estado.                    |
| POST   | `/api/v1/users/{id}/password` | Rota la contrasena y revoca las sesiones del titular. |

- La ficha incluye estado y bloqueo, **nunca** el hash, el salt ni las iteraciones.
- Un cambio que dejaria el sistema sin administradores activos responde
  `LAST_ADMIN_PROTECTED`, y la baja es logica (`status: disabled`): no existe `DELETE`.
- La contrasena exige 12 caracteres como minimo.

### Eventos, sedes y participaciones

| Metodo | Ruta                          | Acceso              | Descripcion                                       |
| ------ | ----------------------------- | ------------------- | ------------------------------------------------- |
| GET    | `/api/v1/events`              | `admin`, `operator` | Eventos con filtros por estado y texto.            |
| GET    | `/api/v1/events/{idOrSlug}`   | `admin`, `operator` | Evento por identificador o slug.                   |
| POST   | `/api/v1/events`              | `admin`             | Crea un evento (`draft` por defecto).              |
| PATCH  | `/api/v1/events/{id}`         | `admin`             | Edita el evento y su estado.                       |
| GET    | `/api/v1/establishments`      | `admin`, `operator` | Sedes con filtros por estado y texto.              |
| GET    | `/api/v1/establishments/{id}` | `admin`, `operator` | Sede por identificador.                            |
| POST   | `/api/v1/establishments`      | `admin`             | Crea una sede (`active` por defecto).              |
| PATCH  | `/api/v1/establishments/{id}` | `admin`             | Edita nombre, ciudad, direccion o estado.          |
| GET    | `/api/v1/participations`      | `admin`, `operator` | Sedes participantes con su sede y cupo disponible. |
| GET    | `/api/v1/participations/{id}` | `admin`, `operator` | Participacion con la sede resuelta.                |
| POST   | `/api/v1/participations`      | `admin`             | Suma una sede al evento con sus cupos iniciales.   |
| PATCH  | `/api/v1/participations/{id}` | `admin`             | Edita estado, cupos, ventanas o notas.             |

- **Ciclo de vida del evento**: `draft -> published -> closed -> archived`; reabrir el
  registro es `closed -> published` y `archived` es terminal. Cualquier otro salto
  responde 409 con `STATUS_TRANSITION_INVALID`.
- **Ciclo de vida de la sede**: `open <-> closed` (cortar y reanudar el registro) y
  `cancelled`, que es terminal y solo se admite sin registros confirmados
  (`PARTICIPATION_HAS_REGISTRATIONS`).
- **Cupos**: la participacion (evento + sede) es la unidad real de cupo y expone
  `availableTitulares` y `availableCompanions`. Sin registros confirmados el cupo se
  edita directo; en cuanto hay alguno, el cambio responde
  `CAPACITY_ADJUSTMENT_REQUIRED` porque entra por el flujo de aprobacion de ajustes
  (Fase 5).
- **Identificadores estables**: el `slug` del evento y el `code` de la sede no se
  pueden cambiar (422 con el campo implicado); tampoco el `eventId` ni el
  `establishmentId` de una participacion.
- **Sin borrado fisico**: un evento se archiva y una sede se desactiva (`inactive`);
  participaciones, registros y accesos historicos los siguen referenciando.
- El catalogo publico (solo eventos `published`, con la disponibilidad de cupos) y el
  alta publica viven en `/api/v1/public/*`: ver "Catalogo publico y registro".

### Registros (mesa de registro)

| Metodo | Ruta                                | Acceso              | Descripcion                                            |
| ------ | ----------------------------------- | ------------------- | ------------------------------------------------------ |
| GET    | `/api/v1/registrations`             | `admin`, `operator` | Registros con filtros por sede, estado y texto libre.   |
| GET    | `/api/v1/registrations/{id}`        | `admin`, `operator` | Registro con sus acompanantes y el cupo que consume.    |
| POST   | `/api/v1/registrations`             | `admin`, `operator` | Alta manual: reserva cupo y normaliza el documento.     |
| POST   | `/api/v1/registrations/{id}/cancel` | `admin`, `operator` | Cancela con motivo, libera cupo y revoca el QR activo.  |

- **Precondiciones**: el evento debe estar `published` (`EVENT_NOT_REGISTRABLE`), la
  participacion `open` y su establecimiento `active` (`PARTICIPATION_CLOSED`). Fuera de
  la ventana efectiva el alta responde 409 con `REGISTRATION_OUTSIDE_WINDOW`.
- **Cupo**: se reserva con un `UPDATE` condicional **antes** de escribir el registro y,
  si la escritura falla, se devuelve (compensacion). Dos altas por el ultimo lugar
  conceden una sola y la otra responde `TITULAR_CAPACITY_EXCEEDED` o
  `COMPANION_CAPACITY_EXCEEDED`.
- **Documento**: se normaliza (sin puntos ni espacios) y es unico por sede entre los
  registros vigentes (`DUPLICATE_REGISTRATION`); la cancelacion lo libera, asi que la
  misma persona puede volver a inscribirse.
- **Cancelacion**: exige motivo (422 sin el), un registro ya cancelado responde 409 con
  `REGISTRATION_ALREADY_CANCELLED` y el cupo del titular y de sus acompanantes se
  devuelve en la misma operacion.
- El listado es cronologico inverso (`registeredAt` descendente, `id` como desempate) y
  **incluye** los cancelados: para ver un solo estado hay que pedir `status`.

---

## Catalogo publico y registro

El catalogo publico no pide sesion y solo expone eventos `published`; la inscripcion
tampoco pide sesion y escribe el registro con `source: public`.

| Metodo | Ruta                           | Acceso  | Descripcion                                              |
| ------ | ------------------------------ | ------- | -------------------------------------------------------- |
| GET    | `/api/v1/public/events`        | Publico | Eventos publicados con la disponibilidad de sus sedes.    |
| GET    | `/api/v1/public/events/{slug}` | Publico | Ficha publica (acepta el `slug` o el identificador).      |
| POST   | `/api/v1/public/registrations` | Publico | Inscribe a una persona y a sus acompanantes.              |

- **Catalogo**: solo eventos `published`, con filtros por texto y paginacion. Un evento
  en `draft`, `closed` o `archived` responde 404 con `EVENT_NOT_FOUND`, igual que uno
  inexistente: el estado interno del evento no se filtra al publico.
- **Disponibilidad por sede**: cada sede participante expone su cupo disponible y su
  ventana efectiva (la de la sede sustituye la del evento, que se hereda cuando la sede
  no define la suya). Las sedes cerradas, canceladas o con el establecimiento inactivo
  no se ofrecen.
- **`registrationOpen`**: `false` si la sede no esta `open`, su establecimiento no esta
  `active` o la fecha cae fuera de la ventana efectiva. El catalogo evalua lo mismo que
  el alta, de modo que no puede anunciar "abierto" y luego responder
  `REGISTRATION_OUTSIDE_WINDOW`.
- **Alta publica**: comparte precondiciones y reserva de cupo con el alta del panel
  (documento unico por sede, 409 con `DUPLICATE_REGISTRATION`, cupos con
  `TITULAR_CAPACITY_EXCEEDED`/`COMPANION_CAPACITY_EXCEEDED`).
- **Sin datos de terceros**: el catalogo nunca devuelve registros ni documentos; la
  consulta de registros es exclusiva de `admin` y `operator`.

---


## Convenciones de la API

- Prefijo versionado: **`/api/v1`**.
- Toda respuesta usa un sobre comun:

  ```jsonc
  { "success": true, "data": { } }
  { "success": false, "error": { "code": "EVENT_NOT_FOUND", "message": "..." } }
  ```

- Los clientes ramifican por `error.code` (contrato estable), nunca por
  `error.message`.
- Cada respuesta incluye la cabecera `x-request-id`; el mismo valor viaja en
  `requestId` dentro del sobre de error.
- Las fechas se almacenan y transportan en **ISO-8601 UTC**; la presentacion en
  `America/Bogota` es responsabilidad de la UI.
- Codigos: 200/201 exito, 400 cuerpo malformado, 401 sin sesion, 403 sin
  permisos, 404 no existe, 409 conflicto de estado, 422 validacion de negocio,
  429 rate limit, 500/503 fallo interno o dependencia caida.

---

## Estado del proyecto

| Fase | Alcance                                                   | Estado     |
| ---- | --------------------------------------------------------- | ---------- |
| 1    | Analisis y decisiones de arquitectura                     | Completada |
| 2    | Fundamentos: scaffold, config, middleware, health, tests  | Completada |
| 3    | Modelo de datos D1, migraciones Drizzle y repositorios base | Completada |
| 4    | Auth (sesiones PBKDF2), RBAC, usuarios y CRUD de eventos   | En curso   |
| 5    | Registro publico, QR, turnos, check-in y gestion de cupos | En curso   |
| 6    | Endurecimiento: rate limiting, observabilidad, despliegue | Pendiente  |

- Fase 5 en curso: el registro de participantes (panel y formulario publico), el catalogo
  publico y la cancelacion ya estan entregados; los codigos QR, los turnos y el check-in
  siguen pendientes.
- Frontend (Angular + PWA): el brief completo para su construccion esta en
  [`docs/frontend/angular-pwa-prompt.md`](docs/frontend/angular-pwa-prompt.md). Aun no
  tiene implementacion.

Decisiones y justificaciones: [`docs/architecture/overview.md`](docs/architecture/overview.md).

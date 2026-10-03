# Events API - Barby Toys & Cupidos

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
    http/                   # sobres de respuesta, esquemas y respuesta de error
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
    users/                  # alta y mantenimiento de cuentas (solo administradores)
    health/                 # modulo de estado del servicio
    events/                 # repositorio del catalogo de eventos
    establishments/         # repositorio de sedes
    participations/         # cupos por sede: reservar y liberar
    registrations/          # altas y cancelaciones atomicas
migrations/                 # SQL generado por Drizzle Kit + _journal.json
tests/
  setup/                    # migraciones de pruebas sobre la D1 de workerd
  helpers/                  # limpieza entre casos y conteos
  unit/                     # pruebas de unidades puras
  integration/              # pruebas de la app completa en workerd
docs/
  architecture/overview.md  # arquitectura, decisiones y roadmap
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
  session: { id, expiresAt } }`. Las cuentas se crean desde `POST /api/v1/users`
  (ver [Usuarios](#usuarios)) o con el comando de bootstrap del primer
  administrador (Fase 4, pendiente).
- Roles: `admin` y `operator` (`src/db/schema/auth.ts`). `requireAuth` resuelve la
  cookie y publica el usuario en el contexto; `requireRole('admin')` protege las
  rutas de administracion. El rol se lee de la base en cada peticion, de modo que
  degradar a un administrador surte efecto en su siguiente llamada sin tocar su
  sesion.
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

## Usuarios

Alta y mantenimiento de cuentas. Todo el modulo esta reservado al rol `admin`:
`requireAuth` resuelve la sesion y `requireRole('admin')` comprueba el rol.

| Metodo | Ruta                          | Acceso | Descripcion                                          |
| ------ | ----------------------------- | ------ | ---------------------------------------------------- |
| GET    | `/api/v1/users`               | Admin  | Lista paginada, con filtros por rol, estado y texto.  |
| POST   | `/api/v1/users`               | Admin  | Crea una cuenta (rol `operator` por defecto).         |
| GET    | `/api/v1/users/{id}`          | Admin  | Ficha de una cuenta, con su estado y bloqueo.         |
| PATCH  | `/api/v1/users/{id}`          | Admin  | Modifica nombre, email, rol o estado.                 |
| POST   | `/api/v1/users/{id}/password` | Admin  | Rota la contrasena y revoca las sesiones de la cuenta.|

```bash
curl -X POST http://localhost:8787/api/v1/users \
  -H 'content-type: application/json' \
  -H 'cookie: events_session=<token-de-admin>' \
  -d '{"email":"operador@example.com","fullName":"Operador Uno","password":"<contrasena>"}'
```

- El listado responde `{ success, data, meta: { total, limit, offset } }`; `limit`
  se acota a 100 y por defecto es 20. Las cuentas desactivadas se incluyen: siguen
  existiendo para la auditoria.
- **Nunca se devuelven credenciales**: ni el hash, ni el salt, ni las iteraciones.
- **Ultimo administrador**: un cambio que dejaria el sistema sin administradores
  activos responde 409 con `LAST_ADMIN_PROTECTED`. Cubre tambien al administrador
  que intenta degradarse o desactivarse a si mismo, y por eso no hay una regla
  aparte de auto-bloqueo.
- **Politica de contrasena**: minimo 12 caracteres; si no se cumple, la respuesta
  es 422 con `VALIDATION_ERROR`. No hay registro publico: una cuenta solo nace de
  un administrador o del comando de bootstrap.
- **Desactivar** (`status: "disabled"`) revoca las sesiones vivas de la cuenta, y
  **rotar la contrasena** hace lo mismo ademas de levantar el bloqueo por intentos
  fallidos: en ambos casos no hace falta llamar a `POST /auth/logout`.
- No hay `DELETE`: la baja es logica para no perder la atribucion historica
  (`created_by`, `assigned_by`, ...) de eventos, cupos y accesos.

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
| 4    | Auth (sesiones, PBKDF2), RBAC, usuarios y CRUD de eventos | En curso   |
| 5    | Registro publico, codigos QR, turnos y check-in           | Pendiente  |
| 6    | Endurecimiento: rate limiting, observabilidad, despliegue | Pendiente  |

Decisiones y justificaciones: [`docs/architecture/overview.md`](docs/architecture/overview.md).

La **Fase 4** avanza por partes y asi se refleja aqui: el modulo de auth (login,
logout, `me`, sesiones opacas, PBKDF2 y guards `requireAuth`/`requireRole`) y el
modulo de usuarios (alta, listado, edicion, rotacion de contrasena y proteccion
del ultimo administrador) estan cerrados y probados; quedan pendientes el CRUD de
eventos/establecimientos y el comando de bootstrap del primer administrador.

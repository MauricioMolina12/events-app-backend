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

| Variable       | Descripcion                                                            |
| -------------- | ---------------------------------------------------------------------- |
| `ENVIRONMENT`  | `local` \| `development` \| `production`. Un valor invalido produce 500. |
| `CORS_ORIGINS` | Lista blanca de origenes separada por comas. Vacia = ningun origen permitido. |

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

### Reglas de acceso a datos

D1 **no soporta transacciones interactivas** (`BEGIN`/`COMMIT` estan
prohibidos). La atomicidad se consigue con:

1. Sentencias unicas condicionales (`INSERT ... ON CONFLICT DO ... RETURNING`,
   `UPDATE ... WHERE ...`).
2. Indices unicos y parciales que hacen imposible el estado invalido.
3. `env.DB.batch([...])` cuando varias sentencias deben aplicarse como un todo.

Limites a respetar: 100 parametros por consulta, 100 KB por sentencia, 30 s por
consulta y ~1000 subpeticiones por invocacion (plan Paid).

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
    errors/                 # AppError, catalogo de codigos, manejador global
    http/                   # sobres de respuesta y esquemas compartidos
    middleware/             # request-id, logging estructurado, CORS
    types/                  # contexto de Hono (Bindings + Variables)
  db/
    client.ts               # conexion Drizzle sobre el binding D1
  modules/
    health/                 # modulo de estado del servicio
tests/
  unit/                     # pruebas de unidades puras
  integration/              # pruebas de la app completa en workerd
docs/
  architecture/overview.md  # arquitectura, decisiones y roadmap
```

Cada modulo de negocio sigue el patron `*.routes.ts` -> `*.service.ts` ->
`*.repository.ts`: las rutas validan y serializan, los servicios contienen las
reglas de negocio y los repositorios son los unicos que hablan con D1.

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
| 3    | Modelo de datos D1 y migraciones Drizzle                  | Pendiente  |
| 4    | Auth (sesiones, PBKDF2), RBAC y CRUD de eventos           | Pendiente  |
| 5    | Registro publico, codigos QR, turnos y check-in           | Pendiente  |
| 6    | Endurecimiento: rate limiting, observabilidad, despliegue | Pendiente  |

Decisiones y justificaciones: [`docs/architecture/overview.md`](docs/architecture/overview.md).

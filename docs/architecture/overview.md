# Arquitectura - Events API

Documento de referencia con las decisiones tecnicas del backend de registro, QR
y turnos para los eventos de Barby Toys y Cupidos.

---

## 1. Proposito y alcance

La API cubre el ciclo completo de un evento:

1. **Administracion**: usuarios, eventos, establecimientos, cupos y ventanas de registro.
2. **Registro publico**: alta de participantes, acompanantes y control de duplicados.
3. **Emision de QR**: un codigo por registro (titular), servido por el backend como SVG.
4. **Operacion en puerta**: verificacion de QR, asignacion de turno y control de acceso.
5. **Gestion de cupos**: ajustes de capacidad con flujo de aprobacion y redistribucion.

---

## 2. Principios

- **Monolito modular**: un solo Worker desplegable, con fronteras de modulo
  explicitas. La separacion en servicios solo se justificara por necesidad real.
- **Dependencias dirigidas hacia dentro**: `routes` -> `services` -> `repositories`.
  Las reglas de negocio nunca dependen de Hono ni de D1 directamente.
- **Contrato primero**: cada endpoint se declara con `createRoute` + esquemas Zod,
  de modo que validacion, tipos y documentacion OpenAPI provienen de una sola fuente.
- **Todo o nada**: no se usan transacciones interactivas (D1 no las soporta); la
  integridad se garantiza con indices y sentencias condicionales.
- **Sin estado en el isolate**: nada de caches en memoria que sobrevivan a una
  peticion; el estado vive en D1.

---

## 3. Capas

```
HTTP (Hono)
  └── modules/<modulo>/<modulo>.routes.ts   validacion + serializacion + OpenAPI
        └── modules/<modulo>/<modulo>.service.ts   reglas de negocio, sin I/O
              └── modules/<modulo>/<modulo>.repository.ts   acceso a D1 via Drizzle
```

- **routes**: define `createRoute`, recibe datos ya validados, delega y responde.
  No contiene `if` de negocio.
- **service**: recibe dependencias (`db`, reloj, generador de QR) por parametro y
  devuelve resultados de dominio o lanza `AppError`. Es la unica capa con tests unitarios puros.
- **repository**: unico punto que emite SQL/Drizzle. Recibe y devuelve tipos de
  dominio, nunca tipos HTTP.
- **Una tabla, un repositorio**: cada tabla tiene un unico modulo que emite SQL
  sobre ella (`users` en `modules/users`; `sessions` y `auth_attempts` en
  `modules/auth`; los cupos en `modules/participations`). Si un modulo necesita una
  operacion de otro importa su **servicio**, nunca su repositorio: es la regla que
  sigue `users` -> `auth` y la que mantiene las dependencias en una sola direccion.

Codigo transversal en `src/core/` (errores, sobres de respuesta, middleware) y
`src/config/` (constantes y lectura de bindings).

El acceso a datos se concentra en `src/db/`:

- `client.ts`: conexion Drizzle sobre el binding D1.
- `schema/`: esquema de las 13 tablas, un archivo por grupo.
- `constraints.ts`: traduccion de los mensajes de restriccion de SQLite.
- `helpers.ts`: ULID y utilidades de escritura.
- `seeds/dev.sql`: datos de desarrollo (`npm run db:seed:local`).

---

## 4. Ciclo de vida de una peticion

1. `requestIdMiddleware`: asigna/reutiliza `x-request-id` y lo publica en la respuesta.
2. `requestLoggerMiddleware`: cronometra y emite un log JSON estructurado al finalizar.
3. `corsMiddleware`: aplica lista blanca de origenes y `credentials: true`.
4. Enrutado versionado bajo `/api/v1`.
5. Validacion con `defaultHook` de `@hono/zod-openapi`: un ZodError se convierte
   en `AppError` 422 y cae en el manejador global (una sola forma de respuesta).
6. `app.onError` -> `createErrorHandler`: normaliza, registra y serializa.
7. `app.notFound` -> `createNotFoundHandler`: 404 con codigo `ROUTE_NOT_FOUND`.

Privacidad en logs: se registra `path` **sin query string** (los enlaces de
verificacion llevan tokens) y nunca cabeceras ni cuerpos.

---

## 5. Modelo de errores

- `AppError` = codigo de negocio + estado HTTP + mensaje + `details` + `expose`.
- El catalogo de codigos vive en `src/core/errors/error-codes.ts` y es **contrato
  publico estable**: los clientes ramifican por `code`, no por `message`.
- `expose: false` (500 en adelante) reemplaza el mensaje por uno generico antes de
  salir al cliente; la causa completa solo va al log.
- Respuesta de error:

  ```json
  {
    "success": false,
    "error": { "code": "DUPLICATE_REGISTRATION", "message": "..." },
    "requestId": "..."
  }
  ```

---

## 6. Acceso a datos en D1

### Restricciones verificadas

| Restriccion                        | Consecuencia en el diseno                                   |
| ---------------------------------- | ----------------------------------------------------------- |
| Sin `BEGIN`/`COMMIT`               | No se puede aislar una secuencia de lecturas y escrituras.  |
| `batch()` es atomico               | Se usa para grupos de escrituras que deben ir juntas.       |
| 100 parametros por consulta        | Inserciones masivas troceadas.                              |
| 100 KB por sentencia               | Nada de blobs grandes; el QR se genera al vuelo.             |
| ~1000 subpeticiones (plan Paid)    | Margen comodo; se evita N+1 en listados.                    |
| Un solo hilo, auto-commit          | Las carreras se resuelven con indices unicos, no con locks. |

`db.transaction()` de Drizzle **no aplica** al driver D1: no existe soporte de
transacciones interactivas. Por eso la atomicidad se obtiene con:

1. `INSERT ... ON CONFLICT DO NOTHING/UPDATE ... RETURNING` para alta idempotente.
2. `UPDATE ... WHERE <precondicion>` + comprobar `changes` para transiciones de
   estado (por ejemplo, asignar turno solo si sigue libre).
3. Indices unicos parciales para invariantes (una QR activa por registro, un
   documento unico por evento + establecimiento).
4. `env.DB.batch([...])` cuando el grupo debe aplicarse como un todo.

### Modelo de datos

13 tablas, definidas en `src/db/schema/` (un archivo por grupo) y materializadas en
`migrations/`, que es **SQL generado** con `npm run db:generate` y no se edita a
mano.

| Grupo     | Tablas                                                     | Nota de diseno                                                     |
| --------- | ---------------------------------------------------------- | ------------------------------------------------------------------ |
| Catalogo  | `events`, `establishments`, `event_establishments`         | La participacion (evento + sede) es la unidad real de cupo.        |
| Registro  | `registrations`, `registration_companions`                 | Un documento es unico por participacion, no por evento.            |
| Operacion | `shifts`, `shift_assignments`, `qr_codes`, `qr_deliveries`  | Un QR activo por registro; el contenido no lleva datos personales. |
| Cupos     | `capacity_adjustments`                                     | Historial completo: cupo anterior, propuesto y quien resolvio.     |
| Auth      | `users`, `sessions`, `auth_attempts`                       | Solo el hash del token de sesion; intentos para el bloqueo.        |

Convenciones: `id` es un ULID en texto (ordenable, sin coordinacion), las fechas
son epoch en milisegundos UTC y todas las tablas de dominio llevan `created_at` y
`updated_at`.

### Cupo sin transacciones

`event_establishments.confirmed_titulares` y `confirmed_companions` son la fuente
de verdad del cupo consumido. Reservar cupo es:

```sql
UPDATE event_establishments
   SET confirmed_titulares = confirmed_titulares + 1
 WHERE id = ? AND status = 'open'
   AND confirmed_titulares < titular_capacity
```

Si la sentencia no cambia filas, no habia cupo: no hace falta leer antes, y por
tanto no hay ventana de carrera. Los `CHECK` de la tabla
(`event_establishments_titular_capacity_check` y `..._companion_capacity_check`)
son la red de seguridad para cualquier camino que se salte la precondicion.

### Traduccion de restricciones

`src/db/constraints.ts` es el unico modulo que interpreta mensajes de error de
SQLite. Los repositorios envuelven sus escrituras en `withConstraintTranslation`,
de modo que un choque de indice o de `CHECK` sale como `AppError` de negocio
(`DUPLICATE_REGISTRATION`, `PARTICIPATION_ALREADY_EXISTS`,
`TITULAR_CAPACITY_EXCEEDED`, ...) y nunca como 500.

Dos particularidades del driver que ese modulo absorbe:

1. D1 anexa el codigo extendido al texto de SQLite:
   `UNIQUE constraint failed: establishments.code: SQLITE_CONSTRAINT (extended: SQLITE_CONSTRAINT_UNIQUE)`.
2. Drizzle envuelve el fallo en `DrizzleQueryError` (`Failed query: ...`) y deja el
   texto real del driver en `cause`.

Por eso la resolucion recorre la cadena de `cause` y corta en el primer `:` antes
de comparar. Un indice unico nuevo debe registrarse en `UNIQUE_INVARIANTS`; si no,
su violacion se reportaria como error interno.

### Claves foraneas

El esquema declara `FOREIGN KEY` con `ON DELETE cascade | restrict | set null`. D1
las aplica: las pruebas de integracion lo comprueban, ya que el borrado de un
establecimiento con participaciones y la insercion huerfana fallan con
`FOREIGN KEY constraint failed`.

---

## 7. Entornos y configuracion

| Entorno     | Configuracion                                     | Base de datos            |
| ----------- | ------------------------------------------------- | ------------------------ |
| Local       | `wrangler.jsonc` (bloque raiz) + `.dev.vars`       | D1 local en `.wrangler/` |
| Development | `wrangler dev --env development` (si se necesita)  | D1 remota de desarrollo  |
| Production  | `wrangler deploy --env production` + secrets       | D1 remota de produccion  |

- El prefijo de la API es una **constante** (`/api/v1`), no una variable: las rutas
  de Hono se registran al construir la app, antes de tener acceso a los bindings.
- `readRuntimeConfig(env)` valida los `vars` en cada peticion. Un `ENVIRONMENT`
  desconocido produce 500 inmediato: es preferible fallar ruidosamente.
- `worker-configuration.d.ts` se genera con `npm run cf-typegen` y **no se versiona**;
  los hooks `pretypecheck` y `pretest` lo regeneran automaticamente.

### Limites de plan

| Recurso           | Free  | Paid |
| ----------------- | ----- | ---- |
| CPU por peticion  | 10 ms | 30 s |
| Subpeticiones     | 50    | 1000 |

El hashing PBKDF2-SHA256 con 210 000 iteraciones cuesta **~110-230 ms de CPU por
operacion**, medido dentro de workerd con los parametros de produccion: 136.8 ms de
media al derivar y 119.6 ms al verificar (~0.65 ms por cada 1000 iteraciones). Una
sola peticion de login agota mas de diez veces los 10 ms del plan gratuito, por lo
que **produccion requiere el plan Paid** (decision #1). Bajar `PBKDF2_ITERATIONS`
para caber en el plan gratuito degradaria la proteccion frente a fuerza bruta: no es
una opcion.

---

## 8. Seguridad

- Contrasenas: PBKDF2-SHA256 (WebCrypto), >= 210 000 iteraciones y salt por usuario.
- Sesion: token opaco en cookie `HttpOnly`, `Secure`, `SameSite=Lax`. En D1 solo se
  almacena el hash del token, nunca el valor en claro.
- Fuerza bruta: tabla `auth_attempts` con bloqueo progresivo.
- QR: sin datos personales. El contenido es un identificador aleatorio que se
  resuelve contra la base de datos. Un QR por registro (titular) y revocable.
- Entregas de QR: se auditan en `qr_deliveries`. El `EmailSender` inicial es un
  adaptador no-op, de modo que conectar un proveedor real no toca el dominio.
- Toda entrada se valida con Zod antes de llegar al repositorio.

### Sesiones y RBAC

- Token **opaco** de 256 bits en base64url. En `sessions` solo se guarda su SHA-256
  (`sessions_token_hash_unique`): un volcado de D1 no permite suplantar a nadie y la
  revocacion es inmediata (`revoked_at` + `revoked_reason`).
- Cookie `HttpOnly`, `SameSite=Lax`, `Path=/` y `Secure` fuera de `local`. El token en
  claro existe una sola vez: en el `Set-Cookie` del login. Se firma con TTL
  (`SESSION_TTL_HOURS`) y no se rota en cada peticion.
- `resolveAuth` (`auth.service.ts`) distingue `missing`, `expired`, `revoked` y
  `disabled` porque el cliente debe reaccionar distinto; `requireAuth` los traduce a
  `UNAUTHENTICATED`, `SESSION_EXPIRED`, `SESSION_REVOKED` y `ACCOUNT_DISABLED`, y
  publica el usuario y la sesion en el contexto. `requireRole` solo comprueba el rol y
  **exige** que `requireAuth` haya corrido antes: no repite la consulta.
- `sessions.last_used_at` se actualiza con pereza (como maximo cada 5 minutos) para no
  gastar una escritura de D1 por peticion.
- Un email inexistente deriva un PBKDF2 igualmente y descarta el resultado: el tiempo
  de respuesta no revela si la cuenta existe (`INVALID_CREDENTIALS` en ambos casos).
- Parametros: `PBKDF2_ITERATIONS`, `SESSION_TTL_HOURS`, `SESSION_COOKIE_NAME`,
  `AUTH_MAX_FAILED_ATTEMPTS` y `AUTH_LOCKOUT_MINUTES`. Un valor fuera de rango produce
  500 en la primera peticion.

### Administracion de cuentas

- Todo el modulo de usuarios exige rol `admin` (`requireAuth` + `requireRole`). Como
  el rol se lee de la base en cada peticion, degradar a un administrador surte efecto
  en su siguiente llamada sin necesidad de tocar su sesion.
- **Ultimo administrador (decision #18)**: un cambio que dejaria el sistema sin
  administradores activos responde `LAST_ADMIN_PROTECTED`. Cubre tambien al
  administrador que intenta degradarse o desactivarse a si mismo, de modo que no hace
  falta una regla adicional de auto-bloqueo: seria redundante.
- **Baja logica (decision #19)**: no existe `DELETE /users/{id}`. Desactivar la cuenta
  (`status: disabled`) conserva la atribucion historica (`created_by`,
  `assigned_by`, ...) de eventos, cupos y accesos.
- **Politica de contrasena (decision #20)**: minimo 12 caracteres. Se valida en el
  servicio, no solo en el esquema de la ruta, porque el comando de bootstrap crea la
  primera cuenta sin pasar por HTTP.
- **Rotacion y sesiones (decision #21)**: rotar la contrasena revoca todas las
  sesiones del titular y levanta el bloqueo por intentos fallidos; desactivar la cuenta
  revoca sus sesiones. Ninguna credencial anterior sobrevive a un cambio.
- La ficha que devuelve el listado incluye estado y bloqueo, pero **nunca** el hash, el
  salt ni las iteraciones. La traduccion de fila a JSON vive en `users.schemas.ts`,
  igual que `auth.schemas.ts` decide que se publica de una sesion.

---

### Catalogo y cupos

- **Acceso (decision #22)**: `admin` y `operator` leen el catalogo; solo `admin`
  escribe. El operador necesita eventos y sedes para preparar la jornada, pero no
  dimensiona cupos.
- **Estados (decision #23)**: las transiciones se declaran en una tabla del servicio
  (`EVENT_STATUS_TRANSITIONS` y `PARTICIPATION_STATUS_TRANSITIONS`) en lugar de aceptar
  cualquier `status`; `archived` y `cancelled` son terminales. Un salto no admitido
  responde 409 con `STATUS_TRANSITION_INVALID`.
- **Validacion antes de escribir**: el formato del slug y del codigo, la zona IANA (se
  sondea con `Intl.DateTimeFormat`) y la coherencia de ventanas se comprueban en el
  esquema o en el servicio, de modo que el cliente recibe 422 con el campo implicado en
  vez de un 500 por restriccion. Los indices unicos siguen siendo la red de seguridad, y
  cada uno tiene su codigo de negocio: `EVENT_SLUG_ALREADY_USED` y
  `ESTABLISHMENT_CODE_ALREADY_USED`, igual que `EMAIL_ALREADY_USED` en las cuentas.
- **Cupos (decision #26)**: `POST /participations` fija el cupo inicial. Con registros
  confirmados, cualquier cambio de cupo responde `CAPACITY_ADJUSTMENT_REQUIRED` porque
  toda redistribucion pasa por `capacity_adjustments` (decision #4); cancelar una sede
  con registros responde `PARTICIPATION_HAS_REGISTRATIONS` y para cortar el registro se
  cierra la sede (`closed`), que conserva lo ya confirmado.
- **Composicion entre modulos**: `participations` resuelve la sede con el servicio de
  establecimientos (`listEstablishmentSummaries`) en una consulta por pagina, no una por
  fila, y nunca consulta `establishments` desde su repositorio. La dependencia va en una
  sola direccion (`participations` -> `events` y `establishments`), lo que mantiene al
  evento sin saber quien lo usa.
- **Sin borrado (decision #25)**: un evento se archiva y una sede se desactiva; las
  participaciones, registros y accesos historicos siguen apuntando a ellas.

---

## 9. Pruebas

- Se ejecutan dentro de workerd con `@cloudflare/vitest-plugin` + Miniflare, usando
  la misma configuracion de `wrangler.jsonc` (incluido el binding D1).
- `tests/unit`: unidades puras (errores, traduccion de restricciones, utilidades,
  codificacion, PBKDF2, tokens de sesion, guards de rol, politica de contrasenas, ficha
  publica de usuario y, desde la Fase 4, las transiciones de estado del catalogo, la
  validacion de zonas y ventanas, la paginacion compartida y los mapeos de eventos,
  sedes y participaciones).
- `tests/integration`: la app completa via `SELF.fetch` (incluido el ciclo
  `login` -> `me` -> `logout` con cookie y sesion reales en D1) y, desde la Fase 3, los
  repositorios contra una **D1 real** dentro de workerd (sin dobles de prueba). El panel
  de usuarios se cubre de extremo a extremo: autorizacion por rol, paginacion, proteccion
  del ultimo administrador y revocacion de sesiones al desactivar o rotar la contrasena.
  El catalogo (eventos, sedes y participaciones) tambien: matriz de autorizacion, formato
  de los identificadores, ciclo de vida de los estados, cupo disponible y protecciones
  sobre los registros confirmados. Desde la Fase 5 se suman el alta y la cancelacion de
  registros (reserva de cupo, documento duplicado, ventana efectiva, motivo obligatorio)
  y el catalogo y el alta publicos, incluida la coherencia entre `registrationOpen` y la
  ventana que aplica el alta.
- Las migraciones de `migrations/` se aplican con `applyD1Migrations` en
  `tests/setup/`, que recibe el SQL por el binding `TEST_MIGRATIONS` porque workerd
  no puede leer el sistema de archivos. `tests/helpers/database.ts` centraliza la
  limpieza entre casos y los conteos de filas.
- Los tests de esquema fijan el formato real que entrega el driver
  (`UNIQUE constraint failed: <columnas>: SQLITE_CONSTRAINT (extended: ...)`,
  `CHECK constraint failed: <nombre>`, `FOREIGN KEY constraint failed`): si D1
  cambiara ese texto, fallarian aqui antes que en produccion.
- **Aislamiento por archivo**: el plugin revierte el storage al terminar cada
  archivo, no cada test. Los tests de un mismo archivo comparten estado, por lo que
  toda prueba que escriba datos debe limpiar en `beforeEach`.

---

## 10. Roadmap

| Fase | Entregable                                                                 |
| ---- | -------------------------------------------------------------------------- |
| 1    | Analisis y decisiones de arquitectura (completada)                         |
| 2    | Fundamentos: config, middleware, errores, health, OpenAPI, tests (completada) |
| 3    | Esquema D1 completo, migraciones Drizzle y repositorios base (completada)  |
| 4    | Auth con sesiones, RBAC, usuarios y CRUD de eventos/establecimientos (auth, RBAC, usuarios y catalogo listos; falta el bootstrap del primer admin) |
| 5    | Registro publico y catalogo listos; faltan QR, turnos y check-in           |
| 6    | Endurecimiento: rate limiting, observabilidad, despliegue y runbook        |

---

## 11. Decisiones registradas

| #  | Decision                                       | Razon                                                          |
| -- | ---------------------------------------------- | -------------------------------------------------------------- |
| 1  | Plan Workers Paid en produccion                | PBKDF2 excede los 10 ms de CPU del plan gratuito.               |
| 2  | PBKDF2-SHA256 via WebCrypto                    | Disponible en el runtime, sin dependencias nativas.             |
| 3  | Token de sesion opaco en cookie `HttpOnly`     | Reduce el impacto de XSS y permite revocacion inmediata en D1.  |
| 4  | Redistribucion de cupos con aprobacion         | Un cambio de capacidad no debe afectar registros confirmados sin control humano. |
| 5  | `EmailSender` no-op + `qr_deliveries`           | Desacopla el dominio del proveedor de correo.                   |
| 6  | QR como SVG generado por el backend            | Sin binarios almacenados; revocacion y versionado triviales.     |
| 7  | Un QR por registro (solo titular)              | Simplifica la operacion en puerta y la politica de cupos.        |
| 8  | Documento unico por (evento, establecimiento)  | La misma persona puede asistir a varios establecimientos.        |
| 9  | UTC en almacenamiento, `America/Bogota` en UI  | Elimina ambiguedades de zona horaria.                            |
| 10 | Conventional Commits + npm                     | Historial legible y automatizable.                               |
| 11 | Contadores `confirmed_*` como fuente de cupo    | Permite reservar con una sentencia condicional, sin transacciones. |
| 12 | Traduccion de restricciones en un solo modulo   | Los repositorios devuelven `AppError` de negocio en lugar de 500.  |
| 13 | Recorrer la cadena de `cause` al interpretar    | Drizzle envuelve el error y D1 anexa el codigo extendido.          |
| 14 | Migraciones generadas con Drizzle Kit           | El esquema es la fuente unica; el SQL de `migrations/` no se edita. |
| 15 | Bloqueo progresivo con tope de 8x               | Superado el umbral, la espera se duplica en cada ronda: frena la fuerza bruta sin bloquear la cuenta indefinidamente. |
| 16 | IP hasheada (SHA-256) en `auth_attempts`        | Permite correlacionar intentos sin almacenar un dato personal.     |
| 17 | Respuesta identica si el email no existe        | Derivar PBKDF2 y responder `INVALID_CREDENTIALS` en ambos casos evita la enumeracion de cuentas. |
| 18 | Un cambio no puede dejar el sistema sin admins  | Degradar o desactivar al ultimo administrador activo responde `LAST_ADMIN_PROTECTED`; cubre el auto-bloqueo sin reglas redundantes. |
| 19 | Baja logica de usuarios, sin `DELETE`           | Preserva la atribucion historica de eventos, cupos y accesos; el acceso se corta con `status: disabled`. |
| 20 | Minimo de 12 caracteres para la contrasena      | Las cuentas nacen de un administrador o del bootstrap: la contrasena es la unica barrera, no un registro publico. |
| 21 | Rotacion de contrasena revoca sesiones          | Cerrar todas las sesiones del titular hace efectivo el cambio tambien frente a un token robado. |
| 22 | Lectura del catalogo para el staff autenticado   | El operador necesita eventos y sedes para preparar la jornada; el catalogo publico (solo `published`, con disponibilidad) nace con el registro de la Fase 5, cuando se conoce el payload que exige la inscripcion. |
| 23 | Transiciones de estado explicitas               | Aceptar cualquier `status` permitiria reabrir un evento archivado o una sede cancelada; la tabla de transiciones vive en el servicio y un salto no admitido responde `STATUS_TRANSITION_INVALID`. |
| 24 | `slug` y `code` inmutables                      | Son identificadores publicos y operativos que ya pueden estar impresos o compartidos: cambiarlos rompe enlaces, planillas y reportes. |
| 25 | Sin `DELETE` en el catalogo                     | Un evento se archiva y una sede se desactiva; el `ON DELETE restrict` de las participaciones impide perder la trazabilidad de registros y accesos. |
| 26 | Cupo editable solo sin registros confirmados    | Sin registros confirmados el cupo es configuracion; con ellos, el cambio responde `CAPACITY_ADJUSTMENT_REQUIRED` para forzar el flujo de aprobacion de la decision #4. |
| 27 | Catalogo publico solo de eventos `published`    | Un evento en borrador o archivado no debe existir para el publico: la ficha responde 404 `EVENT_NOT_FOUND`, sin revelar el estado interno ni exigir sesion. |
| 28 | Reserva de cupo antes de escribir el registro   | Un `UPDATE` condicional (`confirmed < capacity`) deja la exclusividad al motor y evita la sobreventa con altas simultaneas; si la escritura falla, el cupo se devuelve como compensacion. |
| 29 | Ventana efectiva: la sede sustituye al evento   | Cada sede conoce su horario real; cuando no define un extremo hereda el del evento, de modo que la ventana se configura donde se necesita y el catalogo y el alta evaluan la misma. |


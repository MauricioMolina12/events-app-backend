import { and, asc, count, eq, gt, inArray, lt, ne, sql, type SQL } from 'drizzle-orm';
import type { Database } from '../../db/client';
import { withConstraintTranslation } from '../../db/constraints';
import { newId } from '../../db/helpers';
import { eventEstablishments, type ParticipationStatus } from '../../db/schema';

/**
 * Repositorio de participaciones (una sede dentro de un evento).
 *
 * Aqui viven las dos operaciones mas delicadas del sistema, porque son las que
 * consumen cupo:
 *
 * - `reserve*Capacity`: `UPDATE ... WHERE <precondicion>` que baja el cupo
 *   disponible. Devuelve `false` si la precondicion no se cumple (sede cerrada o
 *   cupo agotado), que es como se resuelve la carrera sin transacciones.
 * - `release*Capacity`: devuelve el cupo, sin bajar nunca de cero.
 *
 * Los contadores `confirmed_*` son la fuente de verdad del cupo consumido y los
 * `CHECK` de la tabla impiden que se sobrepasen.
 */

export type ParticipationRow = typeof eventEstablishments.$inferSelect;

export interface CreateParticipationInput {
  eventId: string;
  establishmentId: string;
  status?: ParticipationStatus;
  titularCapacity: number;
  companionCapacity: number;
  registrationOpensAt?: Date | null;
  registrationClosesAt?: Date | null;
  checkInOpensAt?: Date | null;
  checkInClosesAt?: Date | null;
  notes?: string | null;
}

export interface UpdateCapacityInput {
  titularCapacity: number;
  companionCapacity: number;
}

/** Filtros del catalogo de participaciones. */
export interface ParticipationFilters {
  readonly eventId?: string;
  readonly establishmentId?: string;
  readonly status?: ParticipationStatus;
}

export interface ListParticipationsOptions extends ParticipationFilters {
  limit?: number;
  offset?: number;
}

/** Campos que la administracion del catalogo puede modificar de una sede. */
export interface UpdateParticipationInput {
  status?: ParticipationStatus;
  titularCapacity?: number;
  companionCapacity?: number;
  registrationOpensAt?: Date | null;
  registrationClosesAt?: Date | null;
  checkInOpensAt?: Date | null;
  checkInClosesAt?: Date | null;
  notes?: string | null;
}

/** Limite por defecto de los listados; igual que el de los demas catalogos. */
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

/**
 * Condiciones compartidas por el listado y su conteo.
 *
 * Un unico lugar para calcularlas evita que `meta.total` deje de corresponder con
 * las filas devueltas.
 */
function filterConditions(filters: ParticipationFilters): SQL[] {
  const conditions: SQL[] = [];

  if (filters.eventId !== undefined) {
    conditions.push(eq(eventEstablishments.eventId, filters.eventId));
  }
  if (filters.establishmentId !== undefined) {
    conditions.push(eq(eventEstablishments.establishmentId, filters.establishmentId));
  }
  if (filters.status !== undefined) {
    conditions.push(eq(eventEstablishments.status, filters.status));
  }

  return conditions;
}

export async function findParticipationById(
  db: Database,
  id: string,
): Promise<ParticipationRow | null> {
  const [row] = await db
    .select()
    .from(eventEstablishments)
    .where(eq(eventEstablishments.id, id))
    .limit(1);
  return row ?? null;
}

export async function findParticipationByEventAndEstablishment(
  db: Database,
  eventId: string,
  establishmentId: string,
): Promise<ParticipationRow | null> {
  const [row] = await db
    .select()
    .from(eventEstablishments)
    .where(
      and(
        eq(eventEstablishments.eventId, eventId),
        eq(eventEstablishments.establishmentId, establishmentId),
      ),
    )
    .limit(1);
  return row ?? null;
}

export async function listParticipationsByEvent(
  db: Database,
  eventId: string,
): Promise<ParticipationRow[]> {
  return db
    .select()
    .from(eventEstablishments)
    .where(eq(eventEstablishments.eventId, eventId))
    .orderBy(asc(eventEstablishments.createdAt));
}

/**
 * Participaciones de varios eventos en una sola consulta.
 *
 * La usan los listados que agrupan por evento (catalogo publico): una consulta
 * por pagina en lugar de una por fila.
 */
export async function listParticipationsByEventIds(
  db: Database,
  eventIds: readonly string[],
  filters: ParticipationFilters = {},
): Promise<ParticipationRow[]> {
  if (eventIds.length === 0) {
    return [];
  }

  const conditions: SQL[] = [inArray(eventEstablishments.eventId, [...eventIds])];
  if (filters.status !== undefined) {
    conditions.push(eq(eventEstablishments.status, filters.status));
  }

  return db
    .select()
    .from(eventEstablishments)
    .where(and(...conditions))
    .orderBy(asc(eventEstablishments.createdAt), asc(eventEstablishments.id));
}

/**
 * Listado paginado de participaciones.
 *
 * El orden (`created_at` y `id` como desempate) es estable para que dos filas
 * creadas en el mismo milisegundo no intercambien posicion entre paginas.
 */
export async function listParticipations(
  db: Database,
  options: ListParticipationsOptions = {},
): Promise<ParticipationRow[]> {
  const limit = Math.min(options.limit ?? DEFAULT_LIMIT, MAX_LIMIT);
  const conditions = filterConditions(options);

  return db
    .select()
    .from(eventEstablishments)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(asc(eventEstablishments.createdAt), asc(eventEstablishments.id))
    .limit(limit)
    .offset(options.offset ?? 0);
}

/** Cuenta las participaciones que cumplen los mismos filtros que el listado. */
export async function countParticipations(
  db: Database,
  filters: ParticipationFilters = {},
): Promise<number> {
  const conditions = filterConditions(filters);
  const [row] = await db
    .select({ total: count() })
    .from(eventEstablishments)
    .where(conditions.length > 0 ? and(...conditions) : undefined);

  return row?.total ?? 0;
}

/**
 * Suma titulares + acompanantes de las sedes vigentes del evento.
 *
 * Las canceladas no cuentan: ya no ofrecen cupo y ese aforo se puede reasignar.
 * `excludeParticipationId` deja fuera la sede que se esta editando.
 */
export async function sumAllocatedEventCapacity(
  db: Database,
  eventId: string,
  options: { readonly excludeParticipationId?: string } = {},
): Promise<number> {
  const conditions: SQL[] = [
    eq(eventEstablishments.eventId, eventId),
    ne(eventEstablishments.status, 'cancelled'),
  ];

  if (options.excludeParticipationId !== undefined) {
    conditions.push(ne(eventEstablishments.id, options.excludeParticipationId));
  }

  const [row] = await db
    .select({
      total: sql<number>`coalesce(sum(${eventEstablishments.titularCapacity} + ${eventEstablishments.companionCapacity}), 0)`,
    })
    .from(eventEstablishments)
    .where(and(...conditions));

  return Number(row?.total ?? 0);
}

/**
 * Crea la participacion.
 *
 * Un duplicado no se consulta antes: lo detecta el indice unico y `constraints.ts`
 * lo traduce a `PARTICIPATION_ALREADY_EXISTS`. Consultar primero abriria una
 * ventana de carrera entre la lectura y la escritura.
 */
export async function insertParticipation(
  db: Database,
  input: CreateParticipationInput,
  now: Date = new Date(),
): Promise<ParticipationRow> {
  return withConstraintTranslation(() => writeParticipation(db, input, now));
}

/**
 * Alta idempotente: si la participacion ya existe la devuelve en lugar de fallar.
 *
 * Usa `INSERT ... ON CONFLICT DO NOTHING`: una sola sentencia, sin carrera, apta
 * para reintentos de la capa de administracion.
 */
export async function ensureParticipation(
  db: Database,
  input: CreateParticipationInput,
  now: Date = new Date(),
): Promise<ParticipationRow> {
  return withConstraintTranslation(async () => {
    const [inserted] = await db
      .insert(eventEstablishments)
      .values(buildParticipationValues(input, now))
      .onConflictDoNothing({
        target: [eventEstablishments.eventId, eventEstablishments.establishmentId],
      })
      .returning();

    if (inserted !== undefined) {
      return inserted;
    }

    const existing = await findParticipationByEventAndEstablishment(
      db,
      input.eventId,
      input.establishmentId,
    );
    if (existing === null) {
      throw new Error('La participacion no se pudo crear ni encontrar tras el conflicto.');
    }
    return existing;
  });
}

async function writeParticipation(
  db: Database,
  input: CreateParticipationInput,
  now: Date,
): Promise<ParticipationRow> {
  const [row] = await db
    .insert(eventEstablishments)
    .values(buildParticipationValues(input, now))
    .returning();

  if (row === undefined) {
    throw new Error('El INSERT de la participacion no devolvio ninguna fila.');
  }
  return row;
}

function buildParticipationValues(input: CreateParticipationInput, now: Date) {
  return {
    id: newId(),
    eventId: input.eventId,
    establishmentId: input.establishmentId,
    status: input.status ?? ('open' as const),
    titularCapacity: input.titularCapacity,
    companionCapacity: input.companionCapacity,
    registrationOpensAt: input.registrationOpensAt ?? null,
    registrationClosesAt: input.registrationClosesAt ?? null,
    checkInOpensAt: input.checkInOpensAt ?? null,
    checkInClosesAt: input.checkInClosesAt ?? null,
    notes: input.notes ?? null,
    createdAt: now,
    updatedAt: now,
  };
}

/** Filtro reutilizable: participacion en estado `open`. */
const openParticipation: SQL = eq(eventEstablishments.status, 'open');

/**
 * Reserva un cupo de titular.
 *
 * Sentencia unica y atomica: `UPDATE ... SET confirmed_titulares = confirmed_titulares + 1
 * WHERE id = ? AND status = 'open' AND confirmed_titulares < titular_capacity`.
 * Si devuelve `false`, la precondicion no se cumplio (sede cerrada o cupo
 * agotado) y el servicio decide el error concreto. No hay lectura previa, por lo
 * que dos peticiones simultaneas no pueden vender el mismo ultimo cupo.
 */
export async function reserveTitularCapacity(
  db: Database,
  participationId: string,
  now: Date = new Date(),
): Promise<boolean> {
  return withConstraintTranslation(async () => {
    const updated = await db
      .update(eventEstablishments)
      .set({
        confirmedTitulares: sql`${eventEstablishments.confirmedTitulares} + 1`,
        updatedAt: now,
      })
      .where(
        and(
          eq(eventEstablishments.id, participationId),
          openParticipation,
          lt(eventEstablishments.confirmedTitulares, eventEstablishments.titularCapacity),
        ),
      )
      .returning({ id: eventEstablishments.id });

    return updated.length > 0;
  });
}

/**
 * Reserva cupos de acompanantes.
 *
 * La precondicion se evalua sobre el total (`actual + slots <= capacidad`), de
 * modo que un registro con acompanantes o entra completo o no entra.
 */
export async function reserveCompanionCapacity(
  db: Database,
  participationId: string,
  slots: number,
  now: Date = new Date(),
): Promise<boolean> {
  assertPositiveSlots(slots);

  return withConstraintTranslation(async () => {
    const updated = await db
      .update(eventEstablishments)
      .set({
        confirmedCompanions: sql`${eventEstablishments.confirmedCompanions} + ${slots}`,
        updatedAt: now,
      })
      .where(
        and(
          eq(eventEstablishments.id, participationId),
          openParticipation,
          sql`${eventEstablishments.confirmedCompanions} + ${slots} <= ${eventEstablishments.companionCapacity}`,
        ),
      )
      .returning({ id: eventEstablishments.id });

    return updated.length > 0;
  });
}

/** Devuelve un cupo de titular. `false` si no habia nada que liberar. */
export async function releaseTitularCapacity(
  db: Database,
  participationId: string,
  now: Date = new Date(),
): Promise<boolean> {
  const updated = await db
    .update(eventEstablishments)
    .set({
      confirmedTitulares: sql`${eventEstablishments.confirmedTitulares} - 1`,
      updatedAt: now,
    })
    .where(
      and(
        eq(eventEstablishments.id, participationId),
        gt(eventEstablishments.confirmedTitulares, 0),
      ),
    )
    .returning({ id: eventEstablishments.id });

  return updated.length > 0;
}

/** Devuelve cupos de acompanantes. `false` si no habia suficientes consumidos. */
export async function releaseCompanionCapacity(
  db: Database,
  participationId: string,
  slots: number,
  now: Date = new Date(),
): Promise<boolean> {
  assertPositiveSlots(slots);

  const updated = await db
    .update(eventEstablishments)
    .set({
      confirmedCompanions: sql`${eventEstablishments.confirmedCompanions} - ${slots}`,
      updatedAt: now,
    })
    .where(
      and(
        eq(eventEstablishments.id, participationId),
        sql`${eventEstablishments.confirmedCompanions} >= ${slots}`,
      ),
    )
    .returning({ id: eventEstablishments.id });

  return updated.length > 0;
}

/**
 * Fija el cupo de la sede.
 *
 * Si el cupo nuevo queda por debajo de lo ya confirmado, los `CHECK` de la tabla
 * rechazan la escritura y el error se traduce a
 * `TITULAR_CAPACITY_EXCEEDED`/`COMPANION_CAPACITY_EXCEEDED`. El servicio de la
 * Fase 5 comprueba ademas el caso antes para poder responder
 * `CAPACITY_BELOW_CONFIRMED_REGISTRATIONS` con el cupo consumido en `details`.
 */
export async function updateCapacity(
  db: Database,
  participationId: string,
  input: UpdateCapacityInput,
  now: Date = new Date(),
): Promise<ParticipationRow | null> {
  return withConstraintTranslation(async () => {
    const [row] = await db
      .update(eventEstablishments)
      .set({
        titularCapacity: input.titularCapacity,
        companionCapacity: input.companionCapacity,
        updatedAt: now,
      })
      .where(eq(eventEstablishments.id, participationId))
      .returning();

    return row ?? null;
  });
}

/**
 * Aplica los cambios del catalogo sobre una participacion.
 *
 * Una sola sentencia: cupos, estado y ventanas se escriben juntos, de modo que no
 * puede quedar una actualizacion a medias (D1 no ofrece transacciones
 * interactivas). Los `CHECK` de la tabla siguen siendo la red de seguridad si el
 * cupo nuevo quedara por debajo de lo confirmado.
 *
 * `updateCapacity` se conserva como aplicador estrecho del flujo de aprobacion de
 * cupos (Fase 5): el ajuste aprobado no debe arrastrar otros campos.
 */
export async function updateParticipation(
  db: Database,
  id: string,
  changes: UpdateParticipationInput,
  now: Date = new Date(),
): Promise<ParticipationRow | null> {
  const values: Partial<typeof eventEstablishments.$inferInsert> = { updatedAt: now };

  if (changes.status !== undefined) {
    values.status = changes.status;
  }
  if (changes.titularCapacity !== undefined) {
    values.titularCapacity = changes.titularCapacity;
  }
  if (changes.companionCapacity !== undefined) {
    values.companionCapacity = changes.companionCapacity;
  }
  if (changes.registrationOpensAt !== undefined) {
    values.registrationOpensAt = changes.registrationOpensAt;
  }
  if (changes.registrationClosesAt !== undefined) {
    values.registrationClosesAt = changes.registrationClosesAt;
  }
  if (changes.checkInOpensAt !== undefined) {
    values.checkInOpensAt = changes.checkInOpensAt;
  }
  if (changes.checkInClosesAt !== undefined) {
    values.checkInClosesAt = changes.checkInClosesAt;
  }
  if (changes.notes !== undefined) {
    values.notes = changes.notes;
  }

  return withConstraintTranslation(async () => {
    const [row] = await db
      .update(eventEstablishments)
      .set(values)
      .where(eq(eventEstablishments.id, id))
      .returning();

    return row ?? null;
  });
}

function assertPositiveSlots(slots: number): void {
  if (!Number.isInteger(slots) || slots < 1) {
    throw new Error(`El numero de cupos a operar debe ser un entero positivo, recibido: ${slots}`);
  }
}


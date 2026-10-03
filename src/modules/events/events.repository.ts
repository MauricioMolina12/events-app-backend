import { and, count, desc, eq, or, sql, type SQL } from 'drizzle-orm';
import type { Database } from '../../db/client';
import { withConstraintTranslation } from '../../db/constraints';
import { newId } from '../../db/helpers';
import { events, type EventStatus } from '../../db/schema';

/**
 * Repositorio de eventos.
 *
 * Unico punto del proyecto que emite SQL sobre `events`. No conoce Hono ni tipos
 * HTTP: recibe y devuelve filas de Drizzle.
 */

export type EventRow = typeof events.$inferSelect;

export interface CreateEventInput {
  slug: string;
  name: string;
  description?: string | null;
  timezone?: string;
  startsAt?: Date | null;
  endsAt?: Date | null;
  registrationOpensAt?: Date | null;
  registrationClosesAt?: Date | null;
  status?: EventStatus;
  createdBy?: string | null;
}

export type UpdateEventInput = Partial<Omit<CreateEventInput, 'slug' | 'createdBy'>>;

/** Filtros del catalogo de eventos. */
export interface EventFilters {
  readonly status?: EventStatus;
  /** Texto libre buscado en el slug y el nombre, sin distinguir mayusculas. */
  readonly search?: string;
}

export interface ListEventsOptions extends EventFilters {
  limit?: number;
  offset?: number;
}

/** Limite por defecto de los listados; evita respuestas sin techo. */
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

/**
 * Condiciones compartidas por el listado y su conteo.
 *
 * Deben calcularse en un unico lugar: si divergieran, `meta.total` dejaria de
 * corresponder con las filas que el cliente puede recorrer.
 */
function filterConditions(filters: EventFilters): SQL[] {
  const conditions: SQL[] = [];

  if (filters.status !== undefined) {
    conditions.push(eq(events.status, filters.status));
  }

  const search = filters.search?.trim().toLowerCase();
  if (search !== undefined && search !== '') {
    // `instr` en lugar de `LIKE`: el texto buscado puede contener `%` o `_`, que en
    // `LIKE` son comodines y obligarian a escapar el patron.
    const matching = or(
      sql`instr(lower(${events.slug}), ${search}) > 0`,
      sql`instr(lower(${events.name}), ${search}) > 0`,
    );
    if (matching !== undefined) {
      conditions.push(matching);
    }
  }

  return conditions;
}

export async function findEventById(db: Database, id: string): Promise<EventRow | null> {
  const [row] = await db.select().from(events).where(eq(events.id, id)).limit(1);
  return row ?? null;
}

export async function findEventBySlug(db: Database, slug: string): Promise<EventRow | null> {
  const [row] = await db.select().from(events).where(eq(events.slug, slug)).limit(1);
  return row ?? null;
}

export async function listEvents(
  db: Database,
  options: ListEventsOptions = {},
): Promise<EventRow[]> {
  const limit = Math.min(options.limit ?? DEFAULT_LIMIT, MAX_LIMIT);
  const conditions = filterConditions(options);

  return db
    .select()
    .from(events)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(desc(events.createdAt))
    .limit(limit)
    .offset(options.offset ?? 0);
}

/** Cuenta los eventos que cumplen los mismos filtros que `listEvents`. */
export async function countEvents(db: Database, filters: EventFilters = {}): Promise<number> {
  const conditions = filterConditions(filters);
  const [row] = await db
    .select({ total: count() })
    .from(events)
    .where(conditions.length > 0 ? and(...conditions) : undefined);

  return row?.total ?? 0;
}

/**
 * Inserta un evento.
 *
 * Las marcas de tiempo y el identificador los pone el repositorio: la fila es
 * reproducible en tests y el `slug` duplicado se traduce a `EVENT_*` desde la
 * restriccion, no desde una consulta previa (que seria una carrera).
 */
export async function insertEvent(
  db: Database,
  input: CreateEventInput,
  now: Date = new Date(),
): Promise<EventRow> {
  return withConstraintTranslation(async () => {
    const [row] = await db
      .insert(events)
      .values({
        id: newId(),
        slug: input.slug,
        name: input.name,
        description: input.description ?? null,
        timezone: input.timezone ?? 'America/Bogota',
        startsAt: input.startsAt ?? null,
        endsAt: input.endsAt ?? null,
        registrationOpensAt: input.registrationOpensAt ?? null,
        registrationClosesAt: input.registrationClosesAt ?? null,
        status: input.status ?? 'draft',
        createdBy: input.createdBy ?? null,
        createdAt: now,
        updatedAt: now,
      })
      .returning();

    if (row === undefined) {
      throw new Error('El INSERT del evento no devolvio ninguna fila.');
    }
    return row;
  });
}

/** Actualiza los campos indicados; devuelve `null` si el evento no existe. */
export async function updateEvent(
  db: Database,
  id: string,
  changes: UpdateEventInput,
  now: Date = new Date(),
): Promise<EventRow | null> {
  const [row] = await db
    .update(events)
    .set({ ...changes, updatedAt: now })
    .where(eq(events.id, id))
    .returning();
  return row ?? null;
}

import { and, desc, eq, type SQL } from 'drizzle-orm';
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

export interface ListEventsOptions {
  status?: EventStatus;
  limit?: number;
  offset?: number;
}

/** Limite por defecto de los listados; evita respuestas sin techo. */
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

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
  const filters: SQL[] = [];
  if (options.status !== undefined) {
    filters.push(eq(events.status, options.status));
  }

  return db
    .select()
    .from(events)
    .where(filters.length > 0 ? and(...filters) : undefined)
    .orderBy(desc(events.createdAt))
    .limit(limit)
    .offset(options.offset ?? 0);
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

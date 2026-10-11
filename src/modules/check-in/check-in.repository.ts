import { asc, eq, sql } from 'drizzle-orm';
import type { Database } from '../../db/client';
import { isUniqueViolation, mapConstraintViolation } from '../../db/constraints';
import { newId } from '../../db/helpers';
import {
  establishments,
  eventEstablishments,
  events,
  qrCodes,
  registrations,
  turnCounters,
  turns,
} from '../../db/schema';

/**
 * Repositorio de turnos de ingreso.
 *
 * La numeracion consecutiva por sede se sostiene en dos piezas:
 *
 * - `turn_counters` se incrementa con un upsert (`last_number + n`) en lugar de
 *   calcular `MAX(number) + 1`, que dos escaneos simultaneos leerian igual.
 * - Las filas de `turns` entran en el mismo `db.batch` leyendo ese contador: si
 *   algo falla, D1 revierte el grupo completo y el contador no avanza, asi que no
 *   quedan huecos ni numeros repetidos.
 */

export type TurnRow = typeof turns.$inferSelect;
export type QrCodeRow = typeof qrCodes.$inferSelect;
type RegistrationRow = typeof registrations.$inferSelect;

export interface TicketContext {
  readonly registration: RegistrationRow;
  readonly participationId: string;
  readonly event: { id: string; slug: string; name: string };
  readonly establishment: { id: string; name: string; city: string | null };
}

export interface TurnHolder {
  readonly position: number;
  readonly fullName: string;
  readonly companionId: string | null;
}

export interface AssignTurnsInput {
  readonly participationId: string;
  readonly registrationId: string;
  readonly people: readonly TurnHolder[];
  readonly assignedBy: string | null;
}

export async function findQrCodeByTokenHash(
  db: Database,
  tokenHash: string,
): Promise<QrCodeRow | null> {
  const [row] = await db.select().from(qrCodes).where(eq(qrCodes.tokenHash, tokenHash)).limit(1);
  return row ?? null;
}

export async function findTicketContext(
  db: Database,
  registrationId: string,
): Promise<TicketContext | null> {
  const [row] = await db
    .select({
      registration: registrations,
      event: { id: events.id, slug: events.slug, name: events.name },
      establishment: {
        id: establishments.id,
        name: establishments.name,
        city: establishments.city,
      },
    })
    .from(registrations)
    .innerJoin(eventEstablishments, eq(eventEstablishments.id, registrations.participationId))
    .innerJoin(events, eq(events.id, eventEstablishments.eventId))
    .innerJoin(establishments, eq(establishments.id, eventEstablishments.establishmentId))
    .where(eq(registrations.id, registrationId))
    .limit(1);

  if (row === undefined) {
    return null;
  }
  return { ...row, participationId: row.registration.participationId };
}

export async function listTurns(db: Database, registrationId: string): Promise<TurnRow[]> {
  return db
    .select()
    .from(turns)
    .where(eq(turns.registrationId, registrationId))
    .orderBy(asc(turns.position));
}

/**
 * Reserva `people.length` numeros seguidos en la sede y crea un turno por persona.
 *
 * Devuelve `null` cuando otro escaneo del mismo registro gano la carrera
 * (`turns_registration_position_unique`): el llamador relee los turnos existentes.
 */
export async function assignTurns(
  db: Database,
  input: AssignTurnsInput,
  now: Date = new Date(),
): Promise<TurnRow[] | null> {
  const size = input.people.length;
  const [first, ...rest] = input.people.map((person) => {
    // `last_number` ya incluye el grupo completo: la persona en la posicion `i`
    // recibe `last_number - (size - 1 - i)`.
    const offset = size - 1 - person.position;
    return db
      .insert(turns)
      .values({
        id: newId(),
        participationId: input.participationId,
        registrationId: input.registrationId,
        companionId: person.companionId,
        position: person.position,
        fullName: person.fullName,
        number: sql`(SELECT "last_number" FROM "turn_counters" WHERE "participation_id" = ${input.participationId}) - ${offset}`,
        assignedAt: now,
        assignedBy: input.assignedBy,
      })
      .returning();
  });

  if (first === undefined) {
    return [];
  }

  const reserve = db
    .insert(turnCounters)
    .values({ participationId: input.participationId, lastNumber: size, updatedAt: now })
    .onConflictDoUpdate({
      target: turnCounters.participationId,
      set: { lastNumber: sql`${turnCounters.lastNumber} + ${size}`, updatedAt: now },
    });

  try {
    const [, ...inserted] = await db.batch([reserve, first, ...rest]);
    return inserted
      .flat()
      .sort((left, right) => left.position - right.position);
  } catch (error) {
    if (isUniqueViolation(error) && (await hasTurns(db, input.registrationId))) {
      return null;
    }
    throw mapConstraintViolation(error);
  }
}

async function hasTurns(db: Database, registrationId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: turns.id })
    .from(turns)
    .where(eq(turns.registrationId, registrationId))
    .limit(1);
  return row !== undefined;
}

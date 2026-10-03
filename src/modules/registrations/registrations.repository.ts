import { and, asc, desc, eq, gt, gte, ne, sql } from 'drizzle-orm';
import type { Database } from '../../db/client';
import { mapConstraintViolation, withConstraintTranslation } from '../../db/constraints';
import { newId } from '../../db/helpers';
import {
  eventEstablishments,
  qrCodes,
  registrationCompanions,
  registrations,
  type DocumentType,
  type RegistrationSource,
  type RegistrationStatus,
} from '../../db/schema';

/**
 * Repositorio de registros de participacion.
 *
 * Concentra las escrituras que pueden fallar por restricciones del dominio:
 *
 * - El alta usa `db.batch([...])`: el titular y sus acompanantes entran como un
 *   grupo atomico de D1, asi que no existe un estado intermedio con el titular
 *   creado y sin acompanantes.
 * - El documento unico por sede lo garantiza el indice parcial; el duplicado se
 *   traduce a `DUPLICATE_REGISTRATION` sin consultar antes.
 * - La cancelacion es una transicion guardada (`WHERE status <> 'cancelled'`)
 *   seguida de un grupo atomico que devuelve cupo y revoca el QR.
 */

export type RegistrationRow = typeof registrations.$inferSelect;
export type RegistrationCompanionRow = typeof registrationCompanions.$inferSelect;

export interface CreateCompanionInput {
  fullName: string;
  documentType?: DocumentType | null;
  documentNumber?: string | null;
}

export interface CreateRegistrationInput {
  participationId: string;
  documentType: DocumentType;
  documentNumber: string;
  fullName: string;
  email?: string | null;
  phone?: string | null;
  companions?: readonly CreateCompanionInput[];
  status?: RegistrationStatus;
  source?: RegistrationSource;
}

export interface CreatedRegistration {
  registration: RegistrationRow;
  companions: RegistrationCompanionRow[];
}

export interface ListRegistrationsOptions {
  status?: RegistrationStatus;
  limit?: number;
  offset?: number;
}

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;

/**
 * Crea el registro y, si los hay, sus acompanantes en la misma unidad de trabajo.
 *
 * No reserva cupo: la reserva es responsabilidad del servicio, que la hace antes
 * y libera si esta escritura falla (Fase 5).
 */
export async function createRegistration(
  db: Database,
  input: CreateRegistrationInput,
  now: Date = new Date(),
): Promise<CreatedRegistration> {
  const registrationId = newId();
  const values = {
    id: registrationId,
    participationId: input.participationId,
    documentType: input.documentType,
    documentNumber: input.documentNumber,
    fullName: input.fullName,
    email: input.email ?? null,
    phone: input.phone ?? null,
    companionsCount: input.companions?.length ?? 0,
    status: input.status ?? ('confirmed' as const),
    source: input.source ?? ('public' as const),
    registeredAt: now,
    createdAt: now,
    updatedAt: now,
  };

  const companionValues = (input.companions ?? []).map((companion) => ({
    id: newId(),
    registrationId,
    fullName: companion.fullName,
    documentType: companion.documentType ?? null,
    documentNumber: companion.documentNumber ?? null,
    createdAt: now,
    updatedAt: now,
  }));

  try {
    if (companionValues.length === 0) {
      const [registration] = await db.insert(registrations).values(values).returning();
      if (registration === undefined) {
        throw new Error('El INSERT del registro no devolvio ninguna fila.');
      }
      return { registration, companions: [] };
    }

    const [[registration], companions] = await db.batch([
      db.insert(registrations).values(values).returning(),
      db.insert(registrationCompanions).values(companionValues).returning(),
    ]);

    if (registration === undefined) {
      throw new Error('El INSERT del registro no devolvio ninguna fila.');
    }
    return { registration, companions };
  } catch (error) {
    throw mapConstraintViolation(error);
  }
}

export async function findRegistrationById(
  db: Database,
  id: string,
): Promise<RegistrationRow | null> {
  const [row] = await db.select().from(registrations).where(eq(registrations.id, id)).limit(1);
  return row ?? null;
}

/**
 * Busca el registro vigente de un documento en una sede.
 *
 * Ignora los cancelados porque el indice unico es parcial: cancelar libera el
 * documento para volver a registrarse.
 */
export async function findActiveRegistrationByDocument(
  db: Database,
  participationId: string,
  documentType: DocumentType,
  documentNumber: string,
): Promise<RegistrationRow | null> {
  const [row] = await db
    .select()
    .from(registrations)
    .where(
      and(
        eq(registrations.participationId, participationId),
        eq(registrations.documentType, documentType),
        eq(registrations.documentNumber, documentNumber),
        ne(registrations.status, 'cancelled'),
      ),
    )
    .limit(1);
  return row ?? null;
}

export async function listRegistrationsByParticipation(
  db: Database,
  participationId: string,
  options: ListRegistrationsOptions = {},
): Promise<RegistrationRow[]> {
  const limit = Math.min(options.limit ?? DEFAULT_LIMIT, MAX_LIMIT);

  return db
    .select()
    .from(registrations)
    .where(
      options.status === undefined
        ? eq(registrations.participationId, participationId)
        : and(
            eq(registrations.participationId, participationId),
            eq(registrations.status, options.status),
          ),
    )
    .orderBy(desc(registrations.registeredAt))
    .limit(limit)
    .offset(options.offset ?? 0);
}

export async function listCompanions(
  db: Database,
  registrationId: string,
): Promise<RegistrationCompanionRow[]> {
  return db
    .select()
    .from(registrationCompanions)
    .where(eq(registrationCompanions.registrationId, registrationId))
    .orderBy(asc(registrationCompanions.createdAt));
}

/** Registros vigentes de una sede; sirve para validar reducciones de cupo. */
export async function countActiveRegistrations(
  db: Database,
  participationId: string,
): Promise<number> {
  const [row] = await db
    .select({ total: sql<number>`count(*)` })
    .from(registrations)
    .where(
      and(
        eq(registrations.participationId, participationId),
        ne(registrations.status, 'cancelled'),
      ),
    );

  return row?.total ?? 0;
}

/**
 * Cancela el registro y devuelve el cupo consumido.
 *
 * Son dos pasos porque el segundo depende del resultado del primero (la sede y el
 * numero de acompanantes solo se conocen tras la transicion):
 *
 * 1. Transicion guardada: `UPDATE ... WHERE id = ? AND status <> 'cancelled'`.
 *    Si no devuelve fila, el registro no existe o ya estaba cancelado, y el
 *    servicio responde `REGISTRATION_ALREADY_CANCELLED`.
 * 2. Grupo atomico de D1 con las compensaciones: devolver el cupo del titular y
 *    de sus acompanantes y revocar el QR activo. Se aplica como un todo.
 *
 * La liberacion del turno asignado no se incluye: exige ajustar tambien el
 * contador del turno y pertenece al flujo de puerta de la Fase 5.
 */
export async function cancelRegistration(
  db: Database,
  registrationId: string,
  reason: string,
  now: Date = new Date(),
): Promise<RegistrationRow | null> {
  const [cancelled] = await db
    .update(registrations)
    .set({ status: 'cancelled', cancelledAt: now, cancelledReason: reason, updatedAt: now })
    .where(and(eq(registrations.id, registrationId), ne(registrations.status, 'cancelled')))
    .returning();

  if (cancelled === undefined) {
    return null;
  }

  await withConstraintTranslation(() =>
    db.batch([
      db
        .update(eventEstablishments)
        .set({
          confirmedTitulares: sql`${eventEstablishments.confirmedTitulares} - 1`,
          confirmedCompanions: sql`${eventEstablishments.confirmedCompanions} - ${cancelled.companionsCount}`,
          updatedAt: now,
        })
        .where(
          and(
            eq(eventEstablishments.id, cancelled.participationId),
            gt(eventEstablishments.confirmedTitulares, 0),
            gte(eventEstablishments.confirmedCompanions, cancelled.companionsCount),
          ),
        ),
      db
        .update(qrCodes)
        .set({ status: 'revoked', revokedAt: now, revokedReason: 'registration_cancelled' })
        .where(and(eq(qrCodes.registrationId, registrationId), eq(qrCodes.status, 'active'))),
    ]),
  );

  return cancelled;
}

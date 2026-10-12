import { and, asc, desc, eq, gt, gte, inArray, ne, or, sql, type SQL } from 'drizzle-orm';
import type { Database } from '../../db/client';
import { mapConstraintViolation, withConstraintTranslation } from '../../db/constraints';
import { newId } from '../../db/helpers';
import {
  eventEstablishments,
  qrCodes,
  registrationCompanions,
  registrationDocuments,
  registrations,
  type DocumentType,
  type RegistrationDocumentRole,
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
  eventId: string;
  participationId: string;
  documentType: DocumentType;
  documentNumber: string;
  fullName: string;
  email?: string | null;
  phone?: string | null;
  requiresElectronicInvoice?: boolean;
  companions?: readonly CreateCompanionInput[];
  status?: RegistrationStatus;
  source?: RegistrationSource;
}

export interface CreatedRegistration {
  registration: RegistrationRow;
  companions: RegistrationCompanionRow[];
}

export interface RegistrationFilters {
  readonly participationId?: string;
  readonly status?: RegistrationStatus;
  readonly search?: string;
}

export interface ListRegistrationsOptions extends RegistrationFilters {
  limit?: number;
  offset?: number;
}

export interface ActiveRegistrationDocument {
  readonly documentType: DocumentType;
  readonly documentNumber: string;
  readonly role: RegistrationDocumentRole;
}

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;

/** Misma normalizacion que el servicio: el indice unico compara el valor guardado. */
function storedDocumentNumber(value: string): string {
  return value.trim().toUpperCase().replace(/[\s.-]/g, '');
}

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
    documentNumber: storedDocumentNumber(input.documentNumber),
    fullName: input.fullName,
    email: input.email ?? null,
    phone: input.phone ?? null,
    requiresElectronicInvoice: input.requiresElectronicInvoice ?? false,
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
    documentNumber:
      companion.documentNumber === undefined || companion.documentNumber === null
        ? null
        : storedDocumentNumber(companion.documentNumber),
    createdAt: now,
    updatedAt: now,
  }));

  const documentValues = [
    {
      id: newId(),
      eventId: input.eventId,
      participationId: input.participationId,
      registrationId,
      role: 'holder' as const,
      documentType: input.documentType,
      documentNumber: storedDocumentNumber(input.documentNumber),
      status: 'active' as const,
      releasedAt: null,
      createdAt: now,
      updatedAt: now,
    },
    ...companionValues
      .filter(
        (companion) => companion.documentType !== null && companion.documentNumber !== null,
      )
      .map((companion) => ({
        id: newId(),
        eventId: input.eventId,
        participationId: input.participationId,
        registrationId,
        role: 'companion' as const,
        documentType: companion.documentType as DocumentType,
        documentNumber: companion.documentNumber as string,
        status: 'active' as const,
        releasedAt: null,
        createdAt: now,
        updatedAt: now,
      })),
  ];

  try {
    if (companionValues.length === 0) {
      const [[registration]] = await db.batch([
        db.insert(registrations).values(values).returning(),
        db.insert(registrationDocuments).values(documentValues),
      ]);
      if (registration === undefined) {
        throw new Error('El INSERT del registro no devolvio ninguna fila.');
      }
      return { registration, companions: [] };
    }

    const [[registration], companions] = await db.batch([
      db.insert(registrations).values(values).returning(),
      db.insert(registrationCompanions).values(companionValues).returning(),
      db.insert(registrationDocuments).values(documentValues),
    ]);

    if (registration === undefined) {
      throw new Error('El INSERT del registro no devolvio ninguna fila.');
    }
    return { registration, companions };
  } catch (error) {
    throw mapConstraintViolation(error);
  }
}

function filterConditions(filters: RegistrationFilters): SQL[] {
  const conditions: SQL[] = [];

  if (filters.participationId !== undefined) {
    conditions.push(eq(registrations.participationId, filters.participationId));
  }
  if (filters.status !== undefined) {
    conditions.push(eq(registrations.status, filters.status));
  }

  const search = filters.search?.trim().toLowerCase();
  if (search !== undefined && search !== '') {
    const matching = or(
      sql`instr(lower(${registrations.fullName}), ${search}) > 0`,
      sql`instr(lower(${registrations.documentNumber}), ${search}) > 0`,
      sql`instr(lower(coalesce(${registrations.email}, '')), ${search}) > 0`,
    );
    if (matching !== undefined) {
      conditions.push(matching);
    }
  }

  return conditions;
}

export async function listRegistrations(
  db: Database,
  options: ListRegistrationsOptions = {},
): Promise<RegistrationRow[]> {
  const limit = Math.min(options.limit ?? DEFAULT_LIMIT, MAX_LIMIT);
  const conditions = filterConditions(options);

  return db
    .select()
    .from(registrations)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(desc(registrations.registeredAt))
    .limit(limit)
    .offset(options.offset ?? 0);
}

export async function countRegistrations(
  db: Database,
  filters: RegistrationFilters = {},
): Promise<number> {
  const conditions = filterConditions(filters);
  const [row] = await db
    .select({ total: sql<number>`count(*)` })
    .from(registrations)
    .where(conditions.length > 0 ? and(...conditions) : undefined);

  return row?.total ?? 0;
}

export async function listActiveDocumentsForEvent(
  db: Database,
  eventId: string,
): Promise<readonly ActiveRegistrationDocument[]> {
  return db
    .select({
      documentType: registrationDocuments.documentType,
      documentNumber: registrationDocuments.documentNumber,
      role: registrationDocuments.role,
    })
    .from(registrationDocuments)
    .where(
      and(eq(registrationDocuments.eventId, eventId), eq(registrationDocuments.status, 'active')),
    );
}

export async function insertQrCode(
  db: Database,
  registrationId: string,
  tokenHash: string,
  now: Date = new Date(),
): Promise<string> {
  const id = newId();
  await withConstraintTranslation(async () => {
    await db.insert(qrCodes).values({
      id,
      registrationId,
      tokenHash,
      status: 'active',
      issuedAt: now,
      issuedBy: null,
      revokedAt: null,
      revokedBy: null,
      revokedReason: null,
      createdAt: now,
    });
  });
  return id;
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

/**
 * Registro vigente cuyo titular tiene ese documento en el evento.
 *
 * Se resuelve por `registration_documents` porque es ahi donde el documento es unico
 * por evento; un documento usado como acompanante no devuelve nada.
 */
export async function findActiveHolderRegistration(
  db: Database,
  eventId: string,
  documentType: DocumentType,
  documentNumber: string,
): Promise<RegistrationRow | null> {
  const [row] = await db
    .select({ registration: registrations })
    .from(registrationDocuments)
    .innerJoin(registrations, eq(registrations.id, registrationDocuments.registrationId))
    .where(
      and(
        eq(registrationDocuments.eventId, eventId),
        eq(registrationDocuments.role, 'holder'),
        eq(registrationDocuments.status, 'active'),
        eq(registrationDocuments.documentType, documentType),
        eq(registrationDocuments.documentNumber, storedDocumentNumber(documentNumber)),
        ne(registrations.status, 'cancelled'),
      ),
    )
    .limit(1);
  return row?.registration ?? null;
}

export interface AppendCompanionsInput {
  readonly eventId: string;
  readonly registration: RegistrationRow;
  readonly companions: readonly CreateCompanionInput[];
  readonly maxCompanions: number;
}

/**
 * Suma acompanantes a un registro confirmado.
 *
 * El contador se mueve primero con una transicion guardada
 * (`companions_count + n <= max`), que es la defensa ante dos envios simultaneos;
 * `null` significa que el tope ya no lo permite o que el registro dejo de estar
 * confirmado. Despues entran las filas y los documentos como un grupo atomico; si
 * ese grupo falla (documento duplicado), el contador se devuelve.
 *
 * No reserva cupo de la sede: lo hace el servicio antes de llamar.
 */
export async function appendCompanions(
  db: Database,
  input: AppendCompanionsInput,
  now: Date = new Date(),
): Promise<CreatedRegistration | null> {
  const { registration } = input;
  const added = input.companions.length;

  const [updated] = await db
    .update(registrations)
    .set({ companionsCount: sql`${registrations.companionsCount} + ${added}`, updatedAt: now })
    .where(
      and(
        eq(registrations.id, registration.id),
        eq(registrations.status, 'confirmed'),
        sql`${registrations.companionsCount} + ${added} <= ${input.maxCompanions}`,
      ),
    )
    .returning();

  if (updated === undefined) {
    return null;
  }

  const companionValues = input.companions.map((companion) => ({
    id: newId(),
    registrationId: registration.id,
    fullName: companion.fullName,
    documentType: companion.documentType ?? null,
    documentNumber:
      companion.documentNumber === undefined || companion.documentNumber === null
        ? null
        : storedDocumentNumber(companion.documentNumber),
    createdAt: now,
    updatedAt: now,
  }));

  const documentValues = companionValues
    .filter((companion) => companion.documentType !== null && companion.documentNumber !== null)
    .map((companion) => ({
      id: newId(),
      eventId: input.eventId,
      participationId: registration.participationId,
      registrationId: registration.id,
      role: 'companion' as const,
      documentType: companion.documentType as DocumentType,
      documentNumber: companion.documentNumber as string,
      status: 'active' as const,
      releasedAt: null,
      createdAt: now,
      updatedAt: now,
    }));

  try {
    const [companions] =
      documentValues.length === 0
        ? await db.batch([db.insert(registrationCompanions).values(companionValues).returning()])
        : await db.batch([
            db.insert(registrationCompanions).values(companionValues).returning(),
            db.insert(registrationDocuments).values(documentValues),
          ]);
    return { registration: updated, companions };
  } catch (error) {
    await db
      .update(registrations)
      .set({ companionsCount: sql`${registrations.companionsCount} - ${added}`, updatedAt: now })
      .where(eq(registrations.id, registration.id));
    throw mapConstraintViolation(error);
  }
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
      db
        .update(registrationDocuments)
        .set({ status: 'released', releasedAt: now, updatedAt: now })
        .where(
          and(
            eq(registrationDocuments.registrationId, registrationId),
            eq(registrationDocuments.status, 'active'),
          ),
        ),
    ]),
  );

  return cancelled;
}

export interface ReleaseNoShowCompanionsInput {
  readonly participationId: string;
  readonly registrationId: string;
  readonly companions: readonly RegistrationCompanionRow[];
}

/**
 * Quita acompanantes que no llegaron a la puerta: libera su cupo de sede, su
 * documento en el evento y baja `companions_count` para que otro grupo pueda
 * usar ese lugar.
 *
 * Solo se llama despues de asignar turnos al titular (y a quienes si vinieron).
 * Las filas se borran porque el esquema no tiene estado de no-show: el cupo
 * consumido vive en el contador, y dejarlas informativas haria que la mesa
 * siguiera mostrando a quien no asistio.
 */
export async function releaseNoShowCompanions(
  db: Database,
  input: ReleaseNoShowCompanionsInput,
  now: Date = new Date(),
): Promise<void> {
  const { companions } = input;
  if (companions.length === 0) {
    return;
  }

  const ids = companions.map((companion) => companion.id);
  const documents = companions.filter(
    (companion) => companion.documentType !== null && companion.documentNumber !== null,
  );

  const countUpdate = db
    .update(registrations)
    .set({
      companionsCount: sql`${registrations.companionsCount} - ${companions.length}`,
      updatedAt: now,
    })
    .where(
      and(
        eq(registrations.id, input.registrationId),
        eq(registrations.status, 'confirmed'),
        gte(registrations.companionsCount, companions.length),
      ),
    );

  const capacityUpdate = db
    .update(eventEstablishments)
    .set({
      confirmedCompanions: sql`${eventEstablishments.confirmedCompanions} - ${companions.length}`,
      updatedAt: now,
    })
    .where(
      and(
        eq(eventEstablishments.id, input.participationId),
        gte(eventEstablishments.confirmedCompanions, companions.length),
      ),
    );

  const deleteCompanions = db
    .delete(registrationCompanions)
    .where(
      and(
        eq(registrationCompanions.registrationId, input.registrationId),
        inArray(registrationCompanions.id, ids),
      ),
    );

  await withConstraintTranslation(() => {
    if (documents.length === 0) {
      return db.batch([countUpdate, capacityUpdate, deleteCompanions]);
    }

    const documentMatch = or(
      ...documents.map((companion) =>
        and(
          eq(registrationDocuments.documentType, companion.documentType as DocumentType),
          eq(registrationDocuments.documentNumber, companion.documentNumber as string),
        ),
      ),
    );

    return db.batch([
      countUpdate,
      capacityUpdate,
      deleteCompanions,
      db
        .update(registrationDocuments)
        .set({ status: 'released', releasedAt: now, updatedAt: now })
        .where(
          and(
            eq(registrationDocuments.registrationId, input.registrationId),
            eq(registrationDocuments.role, 'companion'),
            eq(registrationDocuments.status, 'active'),
            documentMatch,
          ),
        ),
    ]);
  });
}

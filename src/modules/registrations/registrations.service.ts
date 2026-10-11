import { AppError } from '../../core/errors/app-error';
import { ErrorCode } from '../../core/errors/error-codes';
import { clampLimit, clampOffset, type PaginationLimits } from '../../core/http/pagination';
import type { Database } from '../../db/client';
import { toIsoString } from '../../db/helpers';
import {
  type DocumentType,
  type EstablishmentStatus,
  type EventStatus,
  type ParticipationStatus,
  type RegistrationSource,
  type RegistrationStatus,
} from '../../db/schema';
import { getEventById, getEventByReference } from '../events/events.service';
import {
  getParticipationDetail,
  releaseCompanionSlots,
  releaseTitularSlot,
  reserveCompanionSlots,
  reserveTitularSlot,
} from '../participations/participations.service';
import { MAX_COMPANIONS_PER_REGISTRATION } from './registrations.schemas';
import {
  appendCompanions,
  cancelRegistration as cancelRegistrationRow,
  countRegistrations,
  createRegistration as insertRegistration,
  findActiveHolderRegistration,
  findRegistrationById,
  insertQrCode,
  listActiveDocumentsForEvent,
  listCompanions,
  listRegistrations,
  type RegistrationCompanionRow,
  type RegistrationRow,
} from './registrations.repository';

export interface RegistrationCompanionCommand {
  readonly fullName: string;
  readonly documentType?: DocumentType | null;
  readonly documentNumber?: string | null;
}

export interface CreateRegistrationCommand {
  readonly participationId: string;
  readonly documentType: DocumentType;
  readonly documentNumber: string;
  readonly fullName: string;
  readonly email?: string | null;
  readonly phone?: string | null;
  readonly requiresElectronicInvoice?: boolean;
  readonly companions?: readonly RegistrationCompanionCommand[];
  readonly source?: RegistrationSource;
}

export interface CancelRegistrationCommand {
  readonly reason: string;
}

/** Como se identifica un titular sin sesion: evento, documento y correo del alta. */
export interface HolderCredentials {
  readonly event: string;
  readonly documentType: DocumentType;
  readonly documentNumber: string;
  readonly email: string;
}

export interface AddCompanionsCommand extends HolderCredentials {
  readonly companions: readonly RegistrationCompanionCommand[];
}

export interface HolderRegistration {
  readonly registration: RegistrationRow;
  readonly eventId: string;
}

export interface RegistrationListQuery {
  readonly participationId?: string;
  readonly status?: RegistrationStatus;
  readonly search?: string;
  readonly limit?: number;
  readonly offset?: number;
}

export interface RegistrationPage {
  readonly items: readonly RegistrationRow[];
  readonly total: number;
  readonly limit: number;
  readonly offset: number;
}

export interface RegistrationDetail {
  readonly registration: RegistrationRow;
  readonly companions: readonly RegistrationCompanionRow[];
  /** Token en claro del QR; solo existe en el alta, nunca se vuelve a leer. */
  readonly qrToken?: string;
}

export interface RegistrationWindowSource {
  readonly registrationOpensAt: Date | null;
  readonly registrationClosesAt: Date | null;
}

export interface RegistrationWindow {
  readonly opensAt: Date | null;
  readonly closesAt: Date | null;
}

export interface NormalizedCompanion {
  readonly fullName: string;
  readonly documentType: DocumentType | null;
  readonly documentNumber: string | null;
}

export interface DuplicateDocumentMatch {
  readonly document: string;
  readonly role: 'holder' | 'companion';
  readonly registeredAs: 'holder' | 'companion';
  readonly field: string;
}

export const REGISTRATION_LIST_DEFAULT_LIMIT = 20;
export const REGISTRATION_LIST_MAX_LIMIT = 200;

export function normalizeDocumentNumber(value: string): string {
  return value.trim().toUpperCase().replace(/[\s.-]/g, '');
}

export function assertDocumentNumber(documentNumber: string): void {
  if (!/^[A-Z0-9]{4,20}$/.test(documentNumber)) {
    throw AppError.unprocessable(
      ErrorCode.VALIDATION_ERROR,
      'El numero de documento no tiene un formato valido (letras y digitos).',
      { details: { field: 'documentNumber' } },
    );
  }
}

export function normalizeCompanions(
  companions: readonly RegistrationCompanionCommand[] = [],
  titular?: { readonly documentType: DocumentType; readonly documentNumber: string },
): readonly NormalizedCompanion[] {
  if (companions.length > MAX_COMPANIONS_PER_REGISTRATION) {
    throw AppError.unprocessable(
      ErrorCode.VALIDATION_ERROR,
      `Un registro admite como maximo ${MAX_COMPANIONS_PER_REGISTRATION} acompanantes.`,
      { details: { field: 'companions' } },
    );
  }

  const normalized = companions.map((companion, index) => ({
    fullName: companion.fullName.trim(),
    ...companionDocument(index, companion),
  }));

  assertDistinctCompanionDocuments(normalized, titular);
  return normalized;
}

function companionDocument(
  index: number,
  companion: RegistrationCompanionCommand,
): { readonly documentType: DocumentType | null; readonly documentNumber: string | null } {
  const documentType = companion.documentType ?? null;
  const raw = companion.documentNumber ?? null;
  const field = `companions[${index}].documentNumber`;

  if ((documentType === null) !== (raw === null)) {
    throw AppError.unprocessable(
      ErrorCode.VALIDATION_ERROR,
      'El documento del acompanante necesita tipo y numero, o ninguno de los dos.',
      { details: { field } },
    );
  }

  if (raw === null) {
    return { documentType: null, documentNumber: null };
  }

  const documentNumber = normalizeDocumentNumber(raw);
  if (!/^[A-Z0-9]{4,20}$/.test(documentNumber)) {
    throw AppError.unprocessable(
      ErrorCode.VALIDATION_ERROR,
      'El documento del acompanante no tiene un formato valido (letras y digitos).',
      { details: { field } },
    );
  }

  return { documentType, documentNumber };
}

function assertDistinctCompanionDocuments(
  companions: readonly NormalizedCompanion[],
  titular?: { readonly documentType: DocumentType; readonly documentNumber: string },
): void {
  const seen = new Set<string>();

  companions.forEach((companion, index) => {
    if (companion.documentType === null || companion.documentNumber === null) {
      return;
    }

    const key = `${companion.documentType}:${companion.documentNumber}`;
    if (titular !== undefined && key === `${titular.documentType}:${titular.documentNumber}`) {
      throw AppError.unprocessable(
        ErrorCode.VALIDATION_ERROR,
        'El titular no puede figurar tambien como acompanante.',
        { details: { field: `companions[${index}].documentNumber` } },
      );
    }

    if (seen.has(key)) {
      throw AppError.unprocessable(
        ErrorCode.VALIDATION_ERROR,
        'Un documento no puede repetirse entre los acompanantes de un registro.',
        { details: { field: `companions[${index}].documentNumber` } },
      );
    }

    seen.add(key);
  });
}

export function effectiveRegistrationWindow(
  event: RegistrationWindowSource,
  participation: RegistrationWindowSource,
): RegistrationWindow {
  return {
    opensAt: participation.registrationOpensAt ?? event.registrationOpensAt,
    closesAt: participation.registrationClosesAt ?? event.registrationClosesAt,
  };
}

export function isWithinRegistrationWindow(window: RegistrationWindow, now: Date): boolean {
  if (window.opensAt !== null && now.getTime() < window.opensAt.getTime()) {
    return false;
  }
  if (window.closesAt !== null && now.getTime() > window.closesAt.getTime()) {
    return false;
  }

  return true;
}

export function assertRegistrationWindow(window: RegistrationWindow, now: Date): void {
  if (isWithinRegistrationWindow(window, now)) {
    return;
  }

  throw AppError.conflict(
    ErrorCode.REGISTRATION_OUTSIDE_WINDOW,
    'El registro esta fuera de la ventana de inscripcion.',
    {
      details: {
        opensAt: toIsoString(window.opensAt),
        closesAt: toIsoString(window.closesAt),
        now: now.toISOString(),
      },
    },
  );
}

export function assertEventPublished(status: EventStatus): void {
  if (status !== 'published') {
    throw AppError.conflict(
      ErrorCode.EVENT_NOT_REGISTRABLE,
      'El evento no admite registros: todavia no esta publicado o ya se cerro.',
      { details: { status } },
    );
  }
}

export function assertParticipationAcceptsRegistrations(
  status: ParticipationStatus,
  establishmentStatus: EstablishmentStatus,
): void {
  if (status !== 'open' || establishmentStatus !== 'active') {
    throw AppError.conflict(
      ErrorCode.PARTICIPATION_CLOSED,
      'La sede no esta recibiendo registros.',
      {
        details: { status, establishmentStatus },
      },
    );
  }
}

export function collectRequestDocuments(
  holderDocumentType: DocumentType,
  holderDocumentNumber: string,
  companions: readonly NormalizedCompanion[] = [],
): Array<{ readonly role: 'holder' | 'companion'; readonly documentType: DocumentType; readonly documentNumber: string; readonly field: string }> {
  const documents = [
    {
      role: 'holder' as const,
      documentType: holderDocumentType,
      documentNumber: holderDocumentNumber,
      field: 'documentNumber',
    },
    ...companions
      .filter((companion) => companion.documentType !== null && companion.documentNumber !== null)
      .map((companion, index) => ({
        role: 'companion' as const,
        documentType: companion.documentType as DocumentType,
        documentNumber: companion.documentNumber as string,
        field: `companions[${index}].documentNumber`,
      })),
  ];

  return documents;
}

export function resolveDuplicateDocument(
  requested: readonly { readonly role: 'holder' | 'companion'; readonly documentType: DocumentType; readonly documentNumber: string; readonly field: string }[],
  registered: readonly { readonly documentType: DocumentType; readonly documentNumber: string; readonly role: 'holder' | 'companion' }[],
): DuplicateDocumentMatch | null {
  for (const candidate of requested) {
    const match = registered.find(
      (entry) => entry.documentType === candidate.documentType && entry.documentNumber === candidate.documentNumber,
    );

    if (match === undefined) {
      continue;
    }

    return {
      document: candidate.documentNumber,
      role: candidate.role,
      registeredAs: match.role,
      field: candidate.field,
    };
  }

  return null;
}

export function duplicateDocumentError(match: DuplicateDocumentMatch): AppError {
  const message =
    match.registeredAs === 'companion'
      ? 'Este documento ya esta registrado como acompanante de otra persona.'
      : 'El documento ingresado ya se encuentra registrado en este evento.';

  return AppError.conflict(ErrorCode.DUPLICATE_DOCUMENT, message, {
    details: {
      document: match.document,
      role: match.role,
      registeredAs: match.registeredAs,
      field: match.field,
    },
  });
}

const REGISTRATION_PAGE_LIMITS: PaginationLimits = {
  defaultLimit: REGISTRATION_LIST_DEFAULT_LIMIT,
  maxLimit: REGISTRATION_LIST_MAX_LIMIT,
};

export async function listRegistrationCatalog(
  db: Database,
  query: RegistrationListQuery = {},
): Promise<RegistrationPage> {
  const limit = clampLimit(query.limit, REGISTRATION_PAGE_LIMITS);
  const offset = clampOffset(query.offset);
  const filters = {
    participationId: query.participationId,
    status: query.status,
    search: query.search,
  };

  const [items, total] = await Promise.all([
    listRegistrations(db, { ...filters, limit, offset }),
    countRegistrations(db, filters),
  ]);

  return { items, total, limit, offset };
}

export async function getRegistrationDetail(
  db: Database,
  id: string,
): Promise<RegistrationDetail> {
  const registration = await findRegistrationById(db, id);

  if (registration === null) {
    throw AppError.notFound(ErrorCode.REGISTRATION_NOT_FOUND, 'El registro no existe.', {
      details: { id },
    });
  }

  const companions = await listCompanions(db, id);
  return { registration, companions };
}

/**
 * Alta de un titular y, si los hay, sus acompanantes.
 *
 * Reserva el cupo antes de escribir. Si la escritura falla (documento duplicado
 * u otro conflicto), devuelve lo reservado para no dejar el contador inflado.
 * El token del QR solo se entrega aqui: de la base de datos solo queda el hash.
 */
export async function createRegistration(
  db: Database,
  command: CreateRegistrationCommand,
  now: Date = new Date(),
): Promise<RegistrationDetail> {
  const documentNumber = normalizeDocumentNumber(command.documentNumber);
  assertDocumentNumber(documentNumber);

  const titular = { documentType: command.documentType, documentNumber };
  const companions = normalizeCompanions(command.companions, titular);
  const { participation, establishment } = await getParticipationDetail(
    db,
    command.participationId,
  );

  assertParticipationAcceptsRegistrations(participation.status, establishment.status);

  const event = await getEventById(db, participation.eventId);
  assertEventPublished(event.status);
  assertRegistrationWindow(effectiveRegistrationWindow(event, participation), now);

  const requested = collectRequestDocuments(command.documentType, documentNumber, companions);
  const registered = await listActiveDocumentsForEvent(db, event.id);
  const duplicate = resolveDuplicateDocument(requested, registered);
  if (duplicate !== null) {
    throw duplicateDocumentError(duplicate);
  }

  const titularReserved = await reserveTitularSlot(db, participation.id, now);
  if (!titularReserved) {
    throw AppError.conflict(
      ErrorCode.TITULAR_CAPACITY_EXCEEDED,
      'El cupo de titulares de la sede esta completo.',
    );
  }

  let companionSlotsReserved = 0;

  try {
    if (companions.length > 0) {
      const reserved = await reserveCompanionSlots(db, participation.id, companions.length, now);
      if (!reserved) {
        throw AppError.conflict(
          ErrorCode.COMPANION_CAPACITY_EXCEEDED,
          'El cupo de acompanantes de la sede esta completo.',
        );
      }
      companionSlotsReserved = companions.length;
    }

    const created = await insertRegistration(
      db,
      {
        eventId: event.id,
        participationId: participation.id,
        documentType: command.documentType,
        documentNumber,
        fullName: command.fullName.trim(),
        email: emptyToNull(command.email),
        phone: emptyToNull(command.phone),
        requiresElectronicInvoice: command.requiresElectronicInvoice ?? false,
        companions,
        source: command.source ?? 'public',
      },
      now,
    );

    const qrToken = crypto.randomUUID();
    await insertQrCode(db, created.registration.id, await sha256Hex(qrToken), now);

    return {
      registration: created.registration,
      companions: created.companions,
      qrToken,
    };
  } catch (error) {
    await releaseTitularSlot(db, participation.id, now);
    if (companionSlotsReserved > 0) {
      await releaseCompanionSlots(db, participation.id, companionSlotsReserved, now);
    }
    throw error;
  }
}

/**
 * Registro del titular que se identifica con documento y correo.
 *
 * Cualquier discrepancia (evento no publicado, documento sin registro vigente, correo
 * distinto) responde lo mismo, para no revelar si un documento esta inscrito.
 */
export async function findHolderRegistration(
  db: Database,
  credentials: HolderCredentials,
): Promise<HolderRegistration> {
  const notFound = () =>
    AppError.notFound(
      ErrorCode.REGISTRATION_NOT_FOUND,
      'No encontramos una inscripcion vigente con esos datos.',
    );

  const documentNumber = normalizeDocumentNumber(credentials.documentNumber);
  assertDocumentNumber(documentNumber);

  let event: Awaited<ReturnType<typeof getEventByReference>>;
  try {
    event = await getEventByReference(db, credentials.event);
  } catch {
    throw notFound();
  }
  if (event.status !== 'published') {
    throw notFound();
  }

  const registration = await findActiveHolderRegistration(
    db,
    event.id,
    credentials.documentType,
    documentNumber,
  );
  const email = credentials.email.trim().toLowerCase();
  if (
    registration === null ||
    registration.status !== 'confirmed' ||
    registration.email?.trim().toLowerCase() !== email
  ) {
    throw notFound();
  }

  return { registration, eventId: event.id };
}

/**
 * Suma acompanantes a un registro existente sin volver a inscribir al titular.
 *
 * Aplica las mismas reglas que el alta (sede abierta, ventana, evento publicado,
 * cupo de acompanantes y documento unico por evento) mas el tope por titular, que
 * cuenta los acompanantes que ya tiene.
 */
export async function addCompanionsToRegistration(
  db: Database,
  command: AddCompanionsCommand,
  now: Date = new Date(),
): Promise<RegistrationDetail> {
  const { registration, eventId } = await findHolderRegistration(db, command);

  const companions = normalizeCompanions(command.companions, {
    documentType: registration.documentType,
    documentNumber: registration.documentNumber,
  });
  if (companions.length === 0) {
    throw AppError.unprocessable(
      ErrorCode.VALIDATION_ERROR,
      'Agrega al menos un acompanante.',
      { details: { field: 'companions' } },
    );
  }

  assertCompanionLimit(registration.companionsCount, companions.length);

  const { participation, establishment } = await getParticipationDetail(
    db,
    registration.participationId,
  );
  assertParticipationAcceptsRegistrations(participation.status, establishment.status);

  const event = await getEventById(db, eventId);
  assertEventPublished(event.status);
  assertRegistrationWindow(effectiveRegistrationWindow(event, participation), now);

  const requested = companions
    .map((companion, index) => ({ companion, index }))
    .filter(({ companion }) => companion.documentType !== null && companion.documentNumber !== null)
    .map(({ companion, index }) => ({
      role: 'companion' as const,
      documentType: companion.documentType as DocumentType,
      documentNumber: companion.documentNumber as string,
      field: `companions[${index}].documentNumber`,
    }));
  const duplicate = resolveDuplicateDocument(
    requested,
    await listActiveDocumentsForEvent(db, eventId),
  );
  if (duplicate !== null) {
    throw duplicateDocumentError(duplicate);
  }

  const reserved = await reserveCompanionSlots(db, participation.id, companions.length, now);
  if (!reserved) {
    throw AppError.conflict(
      ErrorCode.COMPANION_CAPACITY_EXCEEDED,
      'El cupo de acompanantes de la sede esta completo.',
    );
  }

  try {
    const updated = await appendCompanions(
      db,
      {
        eventId,
        registration,
        companions,
        maxCompanions: MAX_COMPANIONS_PER_REGISTRATION,
      },
      now,
    );
    if (updated === null) {
      throw companionLimitError(registration.companionsCount, companions.length);
    }
    return {
      registration: updated.registration,
      companions: await listCompanions(db, registration.id),
    };
  } catch (error) {
    await releaseCompanionSlots(db, participation.id, companions.length, now);
    throw error;
  }
}

/** El tope cuenta los acompanantes que el registro ya tiene, no solo los de esta peticion. */
export function assertCompanionLimit(current: number, requested: number): void {
  if (current + requested > MAX_COMPANIONS_PER_REGISTRATION) {
    throw companionLimitError(current, requested);
  }
}

function companionLimitError(current: number, requested: number): AppError {
  return AppError.conflict(
    ErrorCode.COMPANION_LIMIT_REACHED,
    `Un titular puede tener como maximo ${MAX_COMPANIONS_PER_REGISTRATION} acompanantes.`,
    { details: { max: MAX_COMPANIONS_PER_REGISTRATION, current, requested, field: 'companions' } },
  );
}

export async function cancelRegistration(
  db: Database,
  id: string,
  command: CancelRegistrationCommand,
  now: Date = new Date(),
): Promise<RegistrationRow> {
  const cancelled = await cancelRegistrationRow(db, id, command.reason, now);

  if (cancelled !== null) {
    return cancelled;
  }

  const existing = await findRegistrationById(db, id);
  if (existing === null) {
    throw AppError.notFound(ErrorCode.REGISTRATION_NOT_FOUND, 'El registro no existe.', {
      details: { id },
    });
  }

  throw AppError.conflict(
    ErrorCode.REGISTRATION_ALREADY_CANCELLED,
    'El registro ya estaba cancelado.',
    { details: { id } },
  );
}

function emptyToNull(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed === '' ? null : trimmed;
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

import { AppError } from '../../core/errors/app-error';
import { ErrorCode } from '../../core/errors/error-codes';
import { clampLimit, clampOffset, type PaginationLimits } from '../../core/http/pagination';
import type { Database } from '../../db/client';
import type { EventStatus } from '../../db/schema';
import { sumAllocatedEventCapacity } from '../participations/participations.repository';
import { EVENT_CAPACITY_MAX, assertWithinEventCapacity } from './event-capacity';
import {
  countEvents,
  findEventById,
  findEventBySlug,
  insertEvent,
  listEvents,
  updateEvent as updateEventRow,
  type EventRow,
  type UpdateEventInput,
} from './events.repository';

/**
 * Reglas del catalogo de eventos.
 *
 * El servicio no conoce Hono: valida coherencia (ventanas de tiempo, zona horaria
 * y transiciones de estado), traduce la ausencia de un evento a `EVENT_NOT_FOUND`
 * y decide que campos son inmutables. El `slug` lo es: ya puede estar impreso o
 * compartido como identificador publico del evento.
 */

export const EVENT_LIST_DEFAULT_LIMIT = 20;
export const EVENT_LIST_MAX_LIMIT = 100;

/** Reglas de paginacion del listado de eventos. */
const EVENT_PAGE_LIMITS: PaginationLimits = {
  defaultLimit: EVENT_LIST_DEFAULT_LIMIT,
  maxLimit: EVENT_LIST_MAX_LIMIT,
};

/**
 * Transiciones de estado admitidas.
 *
 * `archived` es terminal: un evento archivado no vuelve, se crea otro. Reabrir el
 * registro de un evento cerrado se hace con `closed -> published`.
 */
export const EVENT_STATUS_TRANSITIONS: Readonly<Record<EventStatus, readonly EventStatus[]>> = {
  draft: ['published', 'archived'],
  published: ['closed', 'archived'],
  closed: ['published', 'archived'],
  archived: [],
};

/** Ventanas de tiempo que comparten el alta y la edicion. */
export interface EventWindowInput {
  readonly startsAt?: Date | null;
  readonly endsAt?: Date | null;
  readonly registrationOpensAt?: Date | null;
  readonly registrationClosesAt?: Date | null;
}

export interface CreateEventCommand extends EventWindowInput {
  readonly slug: string;
  readonly name: string;
  readonly description?: string | null;
  readonly timezone?: string;
  readonly capacity: number;
  readonly status?: EventStatus;
  readonly createdBy?: string | null;
}

export interface UpdateEventCommand extends EventWindowInput {
  readonly slug?: string;
  readonly name?: string;
  readonly description?: string | null;
  readonly timezone?: string;
  readonly capacity?: number;
  readonly status?: EventStatus;
}

export interface EventListQuery {
  readonly status?: EventStatus;
  readonly search?: string;
  readonly createdBy?: string;
  readonly limit?: number;
  readonly offset?: number;
}

export interface EventPage {
  readonly items: readonly EventRow[];
  readonly total: number;
  /** Tamano de pagina realmente aplicado, tras acotar el solicitado. */
  readonly limit: number;
  readonly offset: number;
}

/**
 * Listado paginado del catalogo.
 *
 * El listado y su conteo se calculan con los mismos filtros para que `meta.total`
 * corresponda con lo que el cliente puede recorrer.
 */
export async function listEventCatalog(
  db: Database,
  query: EventListQuery = {},
): Promise<EventPage> {
  const limit = clampLimit(query.limit, EVENT_PAGE_LIMITS);
  const offset = clampOffset(query.offset);
  const filters = { status: query.status, search: query.search, createdBy: query.createdBy };

  const [items, total] = await Promise.all([
    listEvents(db, { ...filters, limit, offset }),
    countEvents(db, filters),
  ]);

  return { items, total, limit, offset };
}

/** Busca por identificador o por slug; responde `EVENT_NOT_FOUND` si no existe. */
export async function getEventByReference(db: Database, reference: string): Promise<EventRow> {
  const event = (await findEventById(db, reference)) ?? (await findEventBySlug(db, reference));

  if (event === null) {
    throw eventNotFound(reference);
  }

  return event;
}

/** Exige que el evento exista; es el punto de entrada de los demas modulos. */
export async function getEventById(db: Database, id: string): Promise<EventRow> {
  const event = await findEventById(db, id);

  if (event === null) {
    throw eventNotFound(id);
  }

  return event;
}

/** Evento creado por la cuenta autenticada (`createdBy`). */
export async function createEvent(
  db: Database,
  command: CreateEventCommand,
  now: Date = new Date(),
): Promise<EventRow> {
  const status = command.status ?? 'draft';

  // Un evento nace como borrador: desde ahi solo se publica o se archiva. Nacer
  // "cerrado" no tiene sentido porque nunca estuvo abierto.
  assertEventStatusTransition('draft', status);
  assertTimezone(command.timezone);
  assertWindowCoherent(command);
  assertCapacityBounds(command.capacity);

  return insertEvent(
    db,
    {
      slug: command.slug.trim(),
      name: command.name.trim(),
      description: command.description ?? null,
      timezone: command.timezone,
      startsAt: command.startsAt ?? null,
      endsAt: command.endsAt ?? null,
      registrationOpensAt: command.registrationOpensAt ?? null,
      registrationClosesAt: command.registrationClosesAt ?? null,
      capacity: command.capacity,
      status,
      createdBy: command.createdBy ?? null,
    },
    now,
  );
}

/**
 * Actualiza un evento.
 *
 * La coherencia se valida sobre el resultado combinado (lo guardado + lo enviado):
 * validar solo lo enviado dejaria pasar un `endsAt` anterior al `startsAt` ya
 * almacenado.
 */
export async function updateEvent(
  db: Database,
  id: string,
  command: UpdateEventCommand,
  now: Date = new Date(),
): Promise<EventRow> {
  const current = await getEventById(db, id);

  assertSlugUnchanged(current, command);
  assertTimezone(command.timezone);
  assertWindowCoherent(mergeWindow(current, command));

  if (command.status !== undefined) {
    assertEventStatusTransition(current.status, command.status);
  }

  if (command.capacity !== undefined) {
    assertCapacityBounds(command.capacity);
    const allocated = await sumAllocatedEventCapacity(db, id);
    assertWithinEventCapacity(command.capacity, allocated, 0);
  }

  const updated = await updateEventRow(db, id, changesOf(command), now);
  if (updated === null) {
    // El evento desaparecio entre la lectura y la escritura.
    throw eventNotFound(id);
  }

  return updated;
}

/**
 * Valida una transicion de estado.
 *
 * La tabla de transiciones vive en el servicio, no en la ruta: es una regla de
 * negocio que comparten el alta y la edicion.
 */
export function assertEventStatusTransition(from: EventStatus, to: EventStatus): void {
  if (from === to) {
    return;
  }

  if (!EVENT_STATUS_TRANSITIONS[from].includes(to)) {
    throw AppError.conflict(
      ErrorCode.STATUS_TRANSITION_INVALID,
      `Un evento en estado "${from}" no puede pasar a "${to}".`,
      { details: { from, to, allowed: EVENT_STATUS_TRANSITIONS[from] } },
    );
  }
}

/**
 * Comprueba que la zona horaria exista.
 *
 * Se usa `Intl.DateTimeFormat` como validacion en lugar de mantener una lista de
 * zonas: la base ICU cambia con cada actualizacion del runtime y una copia propia
 * quedaria obsoleta.
 */
export function assertTimezone(timezone: string | undefined): void {
  if (timezone === undefined) {
    return;
  }

  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone });
  } catch {
    throw AppError.unprocessable(
      ErrorCode.VALIDATION_ERROR,
      `La zona horaria "${timezone}" no existe.`,
      { details: { field: 'timezone' } },
    );
  }
}

/**
 * Valida la coherencia de las ventanas de tiempo.
 *
 * El `CHECK` `events_window_check` tambien lo impide, pero comprobarlo aqui
 * permite responder 422 con el campo implicado en lugar de un conflicto de
 * restriccion.
 */
export function assertWindowCoherent(window: EventWindowInput): void {
  assertOrder(window.startsAt, window.endsAt, 'endsAt');
  assertOrder(window.registrationOpensAt, window.registrationClosesAt, 'registrationClosesAt');
}

function assertOrder(
  from: Date | null | undefined,
  to: Date | null | undefined,
  field: string,
): void {
  if (from === null || from === undefined || to === null || to === undefined) {
    return;
  }

  if (from.getTime() > to.getTime()) {
    throw AppError.unprocessable(
      ErrorCode.VALIDATION_ERROR,
      `El campo "${field}" no puede ser anterior al inicio de la ventana.`,
      { details: { field } },
    );
  }
}

/** El slug identifica al evento en las URL: cambiarlo rompe enlaces ya emitidos. */
function assertSlugUnchanged(current: EventRow, command: UpdateEventCommand): void {
  if (command.slug === undefined || command.slug.trim() === current.slug) {
    return;
  }

  throw AppError.unprocessable(
    ErrorCode.VALIDATION_ERROR,
    'El slug de un evento no se puede cambiar.',
    { details: { field: 'slug' } },
  );
}

/** Combina lo almacenado con lo enviado: `undefined` significa "no tocar". */
function mergeWindow(current: EventRow, command: EventWindowInput): EventWindowInput {
  return {
    startsAt: command.startsAt !== undefined ? command.startsAt : current.startsAt,
    endsAt: command.endsAt !== undefined ? command.endsAt : current.endsAt,
    registrationOpensAt:
      command.registrationOpensAt !== undefined
        ? command.registrationOpensAt
        : current.registrationOpensAt,
    registrationClosesAt:
      command.registrationClosesAt !== undefined
        ? command.registrationClosesAt
        : current.registrationClosesAt,
  };
}

/** Solo viaja al repositorio lo que realmente cambia. */
function changesOf(command: UpdateEventCommand): UpdateEventInput {
  const changes: UpdateEventInput = {};

  if (command.name !== undefined) {
    changes.name = command.name.trim();
  }
  if (command.description !== undefined) {
    changes.description = command.description;
  }
  if (command.timezone !== undefined) {
    changes.timezone = command.timezone;
  }
  if (command.status !== undefined) {
    changes.status = command.status;
  }
  if (command.startsAt !== undefined) {
    changes.startsAt = command.startsAt;
  }
  if (command.endsAt !== undefined) {
    changes.endsAt = command.endsAt;
  }
  if (command.registrationOpensAt !== undefined) {
    changes.registrationOpensAt = command.registrationOpensAt;
  }
  if (command.registrationClosesAt !== undefined) {
    changes.registrationClosesAt = command.registrationClosesAt;
  }
  if (command.capacity !== undefined) {
    changes.capacity = command.capacity;
  }

  return changes;
}

function assertCapacityBounds(capacity: number): void {
  if (!Number.isInteger(capacity) || capacity < 0 || capacity > EVENT_CAPACITY_MAX) {
    throw AppError.unprocessable(
      ErrorCode.VALIDATION_ERROR,
      `El cupo general debe ser un entero entre 0 y ${EVENT_CAPACITY_MAX}.`,
      { details: { field: 'capacity' } },
    );
  }
}

function eventNotFound(reference: string): AppError {
  return AppError.notFound(ErrorCode.EVENT_NOT_FOUND, 'El evento no existe.', {
    details: { reference },
  });
}

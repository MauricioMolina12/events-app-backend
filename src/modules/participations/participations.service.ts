import { AppError } from '../../core/errors/app-error';
import { ErrorCode } from '../../core/errors/error-codes';
import { clampLimit, clampOffset, type PaginationLimits } from '../../core/http/pagination';
import type { Database } from '../../db/client';
import type { EstablishmentStatus, EventStatus, ParticipationStatus } from '../../db/schema';
import {
  toEstablishmentSummary,
  type EstablishmentSummary,
} from '../establishments/establishments.schemas';
import {
  getEstablishmentById,
  listEstablishmentSummaries,
} from '../establishments/establishments.service';
import { getEventById } from '../events/events.service';
import {
  countParticipations,
  findParticipationById,
  insertParticipation,
  listParticipations,
  updateParticipation as updateParticipationRow,
  type ParticipationRow,
  type UpdateParticipationInput,
} from './participations.repository';

/**
 * Reglas del catalogo de participaciones (una sede dentro de un evento).
 *
 * El servicio compone dos modulos: pide al catalogo de eventos y al de sedes lo
 * que necesita (nunca consulta sus tablas) y decide las reglas que protegen los
 * cupos ya comprometidos.
 */

export const PARTICIPATION_LIST_DEFAULT_LIMIT = 20;
export const PARTICIPATION_LIST_MAX_LIMIT = 100;

/** Reglas de paginacion del listado de participaciones. */
const PARTICIPATION_PAGE_LIMITS: PaginationLimits = {
  defaultLimit: PARTICIPATION_LIST_DEFAULT_LIMIT,
  maxLimit: PARTICIPATION_LIST_MAX_LIMIT,
};

/**
 * Transiciones de estado admitidas.
 *
 * `cancelled` es terminal: la sede se retira del evento y no vuelve. Cerrar y
 * reabrir (`open <-> closed`) sirve para cortar y reanudar el registro sin perder
 * el cupo ya consumido.
 */
export const PARTICIPATION_STATUS_TRANSITIONS: Readonly<
  Record<ParticipationStatus, readonly ParticipationStatus[]>
> = {
  open: ['closed', 'cancelled'],
  closed: ['open', 'cancelled'],
  cancelled: [],
};

/** Ventanas de tiempo propias de la sede. */
export interface ParticipationWindowInput {
  readonly registrationOpensAt?: Date | null;
  readonly registrationClosesAt?: Date | null;
  readonly checkInOpensAt?: Date | null;
  readonly checkInClosesAt?: Date | null;
}

export interface CreateParticipationCommand extends ParticipationWindowInput {
  readonly eventId: string;
  readonly establishmentId: string;
  readonly titularCapacity: number;
  readonly companionCapacity: number;
  readonly status?: ParticipationStatus;
  readonly notes?: string | null;
}

export interface UpdateParticipationCommand extends ParticipationWindowInput {
  readonly eventId?: string;
  readonly establishmentId?: string;
  readonly status?: ParticipationStatus;
  readonly titularCapacity?: number;
  readonly companionCapacity?: number;
  readonly notes?: string | null;
}

export interface ParticipationListQuery {
  readonly eventId?: string;
  readonly establishmentId?: string;
  readonly status?: ParticipationStatus;
  readonly limit?: number;
  readonly offset?: number;
}

/** Participacion con la sede resuelta: lo que consumen las respuestas. */
export interface ParticipationView {
  readonly participation: ParticipationRow;
  readonly establishment: EstablishmentSummary;
}

export interface ParticipationPage {
  readonly items: readonly ParticipationView[];
  readonly total: number;
  /** Tamano de pagina realmente aplicado, tras acotar el solicitado. */
  readonly limit: number;
  readonly offset: number;
}

/**
 * Listado paginado.
 *
 * Las sedes se resuelven en una sola consulta por pagina (no una por fila) a
 * traves del catalogo de establecimientos.
 */
export async function listParticipationCatalog(
  db: Database,
  query: ParticipationListQuery = {},
): Promise<ParticipationPage> {
  const limit = clampLimit(query.limit, PARTICIPATION_PAGE_LIMITS);
  const offset = clampOffset(query.offset);
  const filters = {
    eventId: query.eventId,
    establishmentId: query.establishmentId,
    status: query.status,
  };

  const [rows, total] = await Promise.all([
    listParticipations(db, { ...filters, limit, offset }),
    countParticipations(db, filters),
  ]);
  const establishments = await establishmentsOf(db, rows);

  return {
    items: rows.map((row) => viewOf(row, establishments)),
    total,
    limit,
    offset,
  };
}

/** Devuelve la participacion con su sede o lanza `PARTICIPATION_NOT_FOUND`. */
export async function getParticipationDetail(
  db: Database,
  id: string,
): Promise<ParticipationView> {
  const participation = await findParticipationById(db, id);

  if (participation === null) {
    throw participationNotFound(id);
  }

  const establishment = await getEstablishmentById(db, participation.establishmentId);

  return { participation, establishment: toEstablishmentSummary(establishment) };
}

/**
 * Agrega una sede al evento.
 *
 * Exige que el evento siga admitiendo registro y que la sede este activa; la
 * existencia la validan los servicios de los otros modulos (404 con
 * `EVENT_NOT_FOUND` / `ESTABLISHMENT_NOT_FOUND`). Un duplicado lo traduce el indice
 * unico a `PARTICIPATION_ALREADY_EXISTS`.
 */
export async function createParticipation(
  db: Database,
  command: CreateParticipationCommand,
  now: Date = new Date(),
): Promise<ParticipationView> {
  const event = await getEventById(db, command.eventId);
  const establishment = await getEstablishmentById(db, command.establishmentId);

  assertEventAcceptsParticipations(event.status);
  assertEstablishmentActive(establishment.status);
  assertWindowCoherent(command);

  const participation = await insertParticipation(
    db,
    {
      eventId: command.eventId,
      establishmentId: command.establishmentId,
      status: command.status,
      titularCapacity: command.titularCapacity,
      companionCapacity: command.companionCapacity,
      registrationOpensAt: command.registrationOpensAt ?? null,
      registrationClosesAt: command.registrationClosesAt ?? null,
      checkInOpensAt: command.checkInOpensAt ?? null,
      checkInClosesAt: command.checkInClosesAt ?? null,
      notes: command.notes ?? null,
    },
    now,
  );

  return { participation, establishment: toEstablishmentSummary(establishment) };
}

/**
 * Actualiza una sede del evento.
 *
 * Dos reglas protegen lo ya comprometido. Cancelar una sede con registros
 * confirmados responde `PARTICIPATION_HAS_REGISTRATIONS` (los dejaria sin sede), y
 * cambiar el cupo responde `CAPACITY_ADJUSTMENT_REQUIRED`: la decision #4 exige que
 * todo cambio que afecte a registros existentes pase por el flujo de aprobacion de
 * la Fase 5. Sin registros confirmados, el cupo es configuracion y se edita
 * directo.
 */
export async function updateParticipation(
  db: Database,
  id: string,
  command: UpdateParticipationCommand,
  now: Date = new Date(),
): Promise<ParticipationView> {
  const current = await findParticipationById(db, id);

  if (current === null) {
    throw participationNotFound(id);
  }

  assertRelationsUnchanged(current, command);
  assertWindowCoherent(mergeWindow(current, command));

  if (command.status !== undefined) {
    assertParticipationStatusTransition(current.status, command.status);
  }

  const confirmed = confirmedTotal(current);

  if ((command.status ?? current.status) === 'cancelled' && confirmed > 0) {
    throw AppError.conflict(
      ErrorCode.PARTICIPATION_HAS_REGISTRATIONS,
      'No se puede cancelar una sede con registros confirmados: cierrala para cortar el registro sin perderlos.',
      { details: registrationsDetails(current) },
    );
  }

  if (confirmed > 0 && changesCapacity(current, command)) {
    throw AppError.conflict(
      ErrorCode.CAPACITY_ADJUSTMENT_REQUIRED,
      'Con registros confirmados, el cupo solo cambia mediante una solicitud de ajuste aprobada.',
      { details: registrationsDetails(current) },
    );
  }

  const updated = await updateParticipationRow(db, id, changesOf(command), now);

  if (updated === null) {
    throw participationNotFound(id);
  }

  const establishment = await getEstablishmentById(db, updated.establishmentId);

  return { participation: updated, establishment: toEstablishmentSummary(establishment) };
}

/**
 * Valida una transicion de estado de la sede.
 *
 * La tabla vive en el servicio porque es una regla de negocio; la compartiran el
 * catalogo y, mas adelante, la operacion en puerta.
 */
export function assertParticipationStatusTransition(
  from: ParticipationStatus,
  to: ParticipationStatus,
): void {
  if (from === to) {
    return;
  }

  if (!PARTICIPATION_STATUS_TRANSITIONS[from].includes(to)) {
    throw AppError.conflict(
      ErrorCode.STATUS_TRANSITION_INVALID,
      `Una sede en estado "${from}" no puede pasar a "${to}".`,
      { details: { from, to, allowed: PARTICIPATION_STATUS_TRANSITIONS[from] } },
    );
  }
}

/**
 * Valida las ventanas de la sede.
 *
 * Cada par (apertura, cierre) debe ir en orden. El `CHECK`
 * `event_establishments_registration_window_check` cubre la ventana de registro
 * como red de seguridad; la de check-in solo se comprueba aqui.
 */
export function assertWindowCoherent(window: ParticipationWindowInput): void {
  assertOrder(window.registrationOpensAt, window.registrationClosesAt, 'registrationClosesAt');
  assertOrder(window.checkInOpensAt, window.checkInClosesAt, 'checkInClosesAt');
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

/** Un evento cerrado o archivado ya no suma sedes. */
function assertEventAcceptsParticipations(status: EventStatus): void {
  if (status === 'closed' || status === 'archived') {
    throw AppError.conflict(
      ErrorCode.EVENT_NOT_REGISTRABLE,
      `El evento esta "${status}": no admite nuevas sedes.`,
      { details: { status } },
    );
  }
}

/** Una sede inactiva no se suma a un evento. */
function assertEstablishmentActive(status: EstablishmentStatus): void {
  if (status !== 'active') {
    throw AppError.unprocessable(
      ErrorCode.VALIDATION_ERROR,
      'El establecimiento esta inactivo.',
      { details: { field: 'establishmentId' } },
    );
  }
}

/** La participacion une un evento con una sede: ninguno de los dos se mueve. */
function assertRelationsUnchanged(
  current: ParticipationRow,
  command: UpdateParticipationCommand,
): void {
  if (command.eventId !== undefined && command.eventId !== current.eventId) {
    throw immutableField('eventId');
  }
  if (
    command.establishmentId !== undefined &&
    command.establishmentId !== current.establishmentId
  ) {
    throw immutableField('establishmentId');
  }
}

function immutableField(field: string): AppError {
  return AppError.unprocessable(
    ErrorCode.VALIDATION_ERROR,
    `El campo "${field}" no se puede cambiar: la participacion une un evento con una sede.`,
    { details: { field } },
  );
}

/** Combina lo almacenado con lo enviado: `undefined` significa "no tocar". */
function mergeWindow(
  current: ParticipationRow,
  command: ParticipationWindowInput,
): ParticipationWindowInput {
  return {
    registrationOpensAt:
      command.registrationOpensAt !== undefined
        ? command.registrationOpensAt
        : current.registrationOpensAt,
    registrationClosesAt:
      command.registrationClosesAt !== undefined
        ? command.registrationClosesAt
        : current.registrationClosesAt,
    checkInOpensAt:
      command.checkInOpensAt !== undefined ? command.checkInOpensAt : current.checkInOpensAt,
    checkInClosesAt:
      command.checkInClosesAt !== undefined ? command.checkInClosesAt : current.checkInClosesAt,
  };
}

/** Solo viaja al repositorio lo que realmente cambia. */
function changesOf(command: UpdateParticipationCommand): UpdateParticipationInput {
  const changes: UpdateParticipationInput = {};

  if (command.status !== undefined) {
    changes.status = command.status;
  }
  if (command.titularCapacity !== undefined) {
    changes.titularCapacity = command.titularCapacity;
  }
  if (command.companionCapacity !== undefined) {
    changes.companionCapacity = command.companionCapacity;
  }
  if (command.registrationOpensAt !== undefined) {
    changes.registrationOpensAt = command.registrationOpensAt;
  }
  if (command.registrationClosesAt !== undefined) {
    changes.registrationClosesAt = command.registrationClosesAt;
  }
  if (command.checkInOpensAt !== undefined) {
    changes.checkInOpensAt = command.checkInOpensAt;
  }
  if (command.checkInClosesAt !== undefined) {
    changes.checkInClosesAt = command.checkInClosesAt;
  }
  if (command.notes !== undefined) {
    changes.notes = command.notes;
  }

  return changes;
}

function changesCapacity(current: ParticipationRow, command: UpdateParticipationCommand): boolean {
  const titular =
    command.titularCapacity !== undefined && command.titularCapacity !== current.titularCapacity;
  const companion =
    command.companionCapacity !== undefined &&
    command.companionCapacity !== current.companionCapacity;

  return titular || companion;
}

function confirmedTotal(participation: ParticipationRow): number {
  return participation.confirmedTitulares + participation.confirmedCompanions;
}

function registrationsDetails(participation: ParticipationRow) {
  return {
    confirmedTitulares: participation.confirmedTitulares,
    confirmedCompanions: participation.confirmedCompanions,
  };
}

/** Sedes de la pagina, resueltas en una sola consulta del otro modulo. */
async function establishmentsOf(
  db: Database,
  rows: readonly ParticipationRow[],
): Promise<Map<string, EstablishmentSummary>> {
  const ids = [...new Set(rows.map((row) => row.establishmentId))];
  const establishments = await listEstablishmentSummaries(db, ids);

  return new Map(establishments.map((row) => [row.id, toEstablishmentSummary(row)]));
}

function viewOf(
  participation: ParticipationRow,
  establishments: ReadonlyMap<string, EstablishmentSummary>,
): ParticipationView {
  const establishment = establishments.get(participation.establishmentId);

  if (establishment === undefined) {
    // La clave foranea `on delete restrict` impide dejar una participacion sin
    // sede: si ocurre, el catalogo esta corrupto y no debe devolverse a medias.
    throw AppError.internal('La sede de la participacion no existe.');
  }

  return { participation, establishment };
}

function participationNotFound(id: string): AppError {
  return AppError.notFound(
    ErrorCode.PARTICIPATION_NOT_FOUND,
    'La participacion no existe.',
    { details: { id } },
  );
}

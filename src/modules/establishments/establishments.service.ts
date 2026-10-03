import { AppError } from '../../core/errors/app-error';
import { ErrorCode } from '../../core/errors/error-codes';
import { clampLimit, clampOffset, type PaginationLimits } from '../../core/http/pagination';
import type { Database } from '../../db/client';
import type { EstablishmentStatus } from '../../db/schema';
import {
  countEstablishments,
  findEstablishmentById,
  insertEstablishment,
  listEstablishments,
  listEstablishmentsByIds,
  updateEstablishment as updateEstablishmentRow,
  type EstablishmentRow,
  type UpdateEstablishmentInput,
} from './establishments.repository';

/**
 * Reglas del catalogo de sedes.
 *
 * El servicio no conoce Hono: valida lo que el esquema no puede expresar (el
 * `code` es inmutable porque ya puede estar impreso en la operacion) y traduce la
 * ausencia de una sede a `ESTABLISHMENT_NOT_FOUND`.
 */

export const ESTABLISHMENT_LIST_DEFAULT_LIMIT = 20;
export const ESTABLISHMENT_LIST_MAX_LIMIT = 100;

/** Reglas de paginacion del listado de sedes. */
const ESTABLISHMENT_PAGE_LIMITS: PaginationLimits = {
  defaultLimit: ESTABLISHMENT_LIST_DEFAULT_LIMIT,
  maxLimit: ESTABLISHMENT_LIST_MAX_LIMIT,
};

export interface CreateEstablishmentCommand {
  readonly code: string;
  readonly name: string;
  readonly city?: string | null;
  readonly address?: string | null;
  readonly status?: EstablishmentStatus;
}

export interface UpdateEstablishmentCommand {
  readonly code?: string;
  readonly name?: string;
  readonly city?: string | null;
  readonly address?: string | null;
  readonly status?: EstablishmentStatus;
}

export interface EstablishmentListQuery {
  readonly status?: EstablishmentStatus;
  readonly search?: string;
  readonly limit?: number;
  readonly offset?: number;
}

export interface EstablishmentPage {
  readonly items: readonly EstablishmentRow[];
  readonly total: number;
  /** Tamano de pagina realmente aplicado, tras acotar el solicitado. */
  readonly limit: number;
  readonly offset: number;
}

/** Listado paginado, con el conteo calculado sobre los mismos filtros. */
export async function listEstablishmentCatalog(
  db: Database,
  query: EstablishmentListQuery = {},
): Promise<EstablishmentPage> {
  const limit = clampLimit(query.limit, ESTABLISHMENT_PAGE_LIMITS);
  const offset = clampOffset(query.offset);
  const filters = { status: query.status, search: query.search };

  const [items, total] = await Promise.all([
    listEstablishments(db, { ...filters, limit, offset }),
    countEstablishments(db, filters),
  ]);

  return { items, total, limit, offset };
}

/** Devuelve la sede indicada o lanza `ESTABLISHMENT_NOT_FOUND`. */
export async function getEstablishmentById(db: Database, id: string): Promise<EstablishmentRow> {
  const establishment = await findEstablishmentById(db, id);

  if (establishment === null) {
    throw establishmentNotFound(id);
  }

  return establishment;
}

/**
 * Resuelve varias sedes por identificador.
 *
 * Es el punto de entrada que usa el catalogo de participaciones: una consulta por
 * pagina en lugar de una por fila, y sin que otro modulo consulte `establishments`.
 */
export async function listEstablishmentSummaries(
  db: Database,
  ids: readonly string[],
): Promise<readonly EstablishmentRow[]> {
  return listEstablishmentsByIds(db, ids);
}

/** Crea una sede; el codigo duplicado lo traduce el indice unico. */
export async function createEstablishment(
  db: Database,
  command: CreateEstablishmentCommand,
  now: Date = new Date(),
): Promise<EstablishmentRow> {
  return insertEstablishment(
    db,
    {
      code: command.code.trim(),
      name: command.name.trim(),
      city: command.city ?? null,
      address: command.address ?? null,
      status: command.status,
    },
    now,
  );
}

/** Actualiza una sede; el `code` es inmutable. */
export async function updateEstablishment(
  db: Database,
  id: string,
  command: UpdateEstablishmentCommand,
  now: Date = new Date(),
): Promise<EstablishmentRow> {
  const current = await getEstablishmentById(db, id);

  assertCodeUnchanged(current, command);

  const updated = await updateEstablishmentRow(db, id, changesOf(command), now);
  if (updated === null) {
    // La sede desaparecio entre la lectura y la escritura.
    throw establishmentNotFound(id);
  }

  return updated;
}

/** El codigo identifica a la sede en la operacion: cambiarlo rompe reportes. */
function assertCodeUnchanged(
  current: EstablishmentRow,
  command: UpdateEstablishmentCommand,
): void {
  if (command.code === undefined || command.code.trim() === current.code) {
    return;
  }

  throw AppError.unprocessable(
    ErrorCode.VALIDATION_ERROR,
    'El codigo de un establecimiento no se puede cambiar.',
    { details: { field: 'code' } },
  );
}

/** Solo viaja al repositorio lo que realmente cambia. */
function changesOf(command: UpdateEstablishmentCommand): UpdateEstablishmentInput {
  const changes: UpdateEstablishmentInput = {};

  if (command.name !== undefined) {
    changes.name = command.name.trim();
  }
  if (command.city !== undefined) {
    changes.city = command.city;
  }
  if (command.address !== undefined) {
    changes.address = command.address;
  }
  if (command.status !== undefined) {
    changes.status = command.status;
  }

  return changes;
}

function establishmentNotFound(reference: string): AppError {
  return AppError.notFound(
    ErrorCode.ESTABLISHMENT_NOT_FOUND,
    'El establecimiento no existe.',
    { details: { reference } },
  );
}

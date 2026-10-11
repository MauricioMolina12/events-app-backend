import { AppError } from '../../core/errors/app-error';
import { ErrorCode } from '../../core/errors/error-codes';
import { clampLimit, clampOffset, type PaginationLimits } from '../../core/http/pagination';
import type { Database } from '../../db/client';
import {
  countBoardRows,
  findBoardEvent,
  listBoardRows,
  sedeTotals,
  type BoardQuery,
  type BoardRow,
  type BoardSort,
  type CheckInFilter,
  type SedeTotalsRow,
  type SortOrder,
} from './check-in-board.repository';

/**
 * Mesa de registro: metricas e inscripciones de un evento con su estado de ingreso.
 *
 * Definiciones (las mismas para el consolidado y para cada sede):
 *
 * - `titulares`: inscripciones confirmadas.
 * - `people`: titulares mas los acompanantes de esas inscripciones.
 * - `checkedIn`: titulares cuyo QR ya se escaneo (tienen turno en la posicion 0).
 * - `pending`: `titulares - checkedIn`.
 * - `attendanceRate`: `checkedIn / titulares`, entre 0 y 1.
 * - `turnsIssued`: turnos entregados, titulares y acompanantes. Los acompanantes
 *   reciben su turno con el escaneo del titular, no se verifican uno por uno.
 *
 * Un escaneo repetido no crea turnos, asi que no puede mover ninguna de estas cifras.
 */

export const BOARD_PAGE_LIMITS: PaginationLimits = { defaultLimit: 20, maxLimit: 100 };

export interface BoardMetrics {
  readonly titulares: number;
  readonly companions: number;
  readonly people: number;
  readonly checkedIn: number;
  readonly pending: number;
  readonly attendanceRate: number;
  readonly turnsIssued: number;
  readonly lastCheckInAt: Date | null;
}

export interface SedeMetrics extends BoardMetrics {
  readonly participationId: string;
  readonly establishment: { id: string; name: string; city: string | null };
}

export interface BoardSummary {
  readonly event: { id: string; slug: string; name: string };
  readonly participationId: string | null;
  readonly totals: BoardMetrics;
  readonly sedes: readonly SedeMetrics[];
}

export interface BoardListQuery {
  readonly eventId: string;
  readonly participationId?: string;
  readonly checkIn?: CheckInFilter;
  readonly search?: string;
  readonly sort?: BoardSort;
  readonly order?: SortOrder;
  readonly limit?: number;
  readonly offset?: number;
}

export interface BoardPage {
  readonly items: readonly BoardRow[];
  readonly total: number;
  readonly limit: number;
  readonly offset: number;
}

function metrics(rows: readonly SedeTotalsRow[]): BoardMetrics {
  const sum = (pick: (row: SedeTotalsRow) => number): number =>
    rows.reduce((total, row) => total + pick(row), 0);
  const titulares = sum((row) => row.titulares);
  const companions = sum((row) => row.companions);
  const checkedIn = sum((row) => row.checkedIn);
  const last = rows.reduce<number | null>(
    (latest, row) =>
      row.lastCheckInAt !== null && (latest === null || row.lastCheckInAt > latest)
        ? row.lastCheckInAt
        : latest,
    null,
  );

  return {
    titulares,
    companions,
    people: titulares + companions,
    checkedIn,
    pending: titulares - checkedIn,
    attendanceRate: titulares === 0 ? 0 : Math.round((checkedIn / titulares) * 10_000) / 10_000,
    turnsIssued: sum((row) => row.turnsIssued),
    lastCheckInAt: last === null ? null : new Date(last),
  };
}

async function requireEvent(db: Database, eventId: string) {
  const event = await findBoardEvent(db, eventId);
  if (event === null) {
    throw AppError.notFound(ErrorCode.EVENT_NOT_FOUND, 'El evento no existe.');
  }
  return event;
}

export async function getBoardSummary(
  db: Database,
  eventId: string,
  participationId?: string,
): Promise<BoardSummary> {
  const event = await requireEvent(db, eventId);
  const rows = await sedeTotals(db, event.id);

  if (participationId !== undefined && !rows.some((row) => row.participationId === participationId)) {
    throw AppError.notFound(
      ErrorCode.PARTICIPATION_NOT_FOUND,
      'La sede no participa en este evento.',
    );
  }

  const scope =
    participationId === undefined ? rows : rows.filter((row) => row.participationId === participationId);

  return {
    event,
    participationId: participationId ?? null,
    totals: metrics(scope),
    sedes: rows.map((row) => ({
      participationId: row.participationId,
      establishment: { id: row.establishmentId, name: row.name, city: row.city },
      ...metrics([row]),
    })),
  };
}

export async function listBoardRegistrations(
  db: Database,
  query: BoardListQuery,
): Promise<BoardPage> {
  const event = await requireEvent(db, query.eventId);
  const filters = {
    eventId: event.id,
    participationId: query.participationId,
    checkIn: query.checkIn,
    search: query.search,
  };
  const page: BoardQuery = {
    ...filters,
    sort: query.sort ?? 'registeredAt',
    order: query.order ?? 'desc',
    limit: clampLimit(query.limit, BOARD_PAGE_LIMITS),
    offset: clampOffset(query.offset),
  };

  const [items, total] = await Promise.all([listBoardRows(db, page), countBoardRows(db, filters)]);
  return { items, total, limit: page.limit, offset: page.offset };
}

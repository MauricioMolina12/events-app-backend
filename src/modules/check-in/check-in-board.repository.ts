import { and, asc, count, desc, eq, isNotNull, isNull, or, sql, type SQL } from 'drizzle-orm';
import { alias } from 'drizzle-orm/sqlite-core';
import type { Database } from '../../db/client';
import {
  establishments,
  eventEstablishments,
  events,
  registrations,
  turns,
  users,
  type DocumentType,
} from '../../db/schema';

/**
 * Lecturas de la mesa de registro, construidas sobre las tablas que ya escribe el
 * escaneo: un titular "ingreso" cuando existe su turno en la posicion 0. No hay
 * una tabla de asistencia aparte, asi que las metricas y el listado nunca pueden
 * contradecir al escaner.
 *
 * Solo cuentan los registros confirmados: una inscripcion cancelada despues de
 * ingresar deja de sumar, igual que deja de tener cupo.
 */

/** Turno del titular: su existencia es el ingreso, su hora y su operador son los del escaneo. */
const holderTurn = alias(turns, 'holder_turn');

export type CheckInFilter = 'checked_in' | 'pending';
export type BoardSort = 'registeredAt' | 'fullName' | 'checkedInAt' | 'turn';
export type SortOrder = 'asc' | 'desc';

export interface SedeTotalsRow {
  readonly participationId: string;
  readonly establishmentId: string;
  readonly name: string;
  readonly city: string | null;
  readonly titulares: number;
  readonly companions: number;
  readonly checkedIn: number;
  readonly turnsIssued: number;
  readonly lastCheckInAt: number | null;
}

export interface BoardFilters {
  readonly eventId: string;
  readonly participationId?: string;
  readonly checkIn?: CheckInFilter;
  readonly search?: string;
}

export interface BoardQuery extends BoardFilters {
  readonly sort: BoardSort;
  readonly order: SortOrder;
  readonly limit: number;
  readonly offset: number;
}

export interface BoardRow {
  readonly id: string;
  readonly fullName: string;
  readonly documentType: DocumentType;
  readonly documentNumber: string;
  readonly companionsCount: number;
  readonly registeredAt: Date;
  readonly participationId: string;
  readonly sedeName: string;
  readonly sedeCity: string | null;
  readonly checkedInAt: Date | null;
  readonly firstTurn: number | null;
  readonly lastTurn: number | null;
  readonly turnsCount: number;
  readonly operatorId: string | null;
  readonly operatorName: string | null;
}

export async function findBoardEvent(
  db: Database,
  eventId: string,
): Promise<{ id: string; slug: string; name: string } | null> {
  const [row] = await db
    .select({ id: events.id, slug: events.slug, name: events.name })
    .from(events)
    .where(eq(events.id, eventId))
    .limit(1);
  return row ?? null;
}

/**
 * Totales por sede del evento, incluidas las sedes sin inscripciones.
 *
 * Cada registro pertenece a una sola sede, asi que el consolidado es la suma de
 * estas filas sin riesgo de contar dos veces.
 */
export async function sedeTotals(db: Database, eventId: string): Promise<SedeTotalsRow[]> {
  const issued = db
    .select({
      participationId: turns.participationId,
      total: count().as('turns_total'),
    })
    .from(turns)
    .innerJoin(
      registrations,
      and(eq(registrations.id, turns.registrationId), eq(registrations.status, 'confirmed')),
    )
    .groupBy(turns.participationId)
    .as('issued');

  const rows = await db
    .select({
      participationId: eventEstablishments.id,
      establishmentId: establishments.id,
      name: establishments.name,
      city: establishments.city,
      titulares: count(registrations.id),
      companions: sql<number>`coalesce(sum(${registrations.companionsCount}), 0)`,
      checkedIn: count(holderTurn.id),
      turnsIssued: sql<number>`coalesce(max(${issued.total}), 0)`,
      lastCheckInAt: sql<number | null>`max(${holderTurn.assignedAt})`,
    })
    .from(eventEstablishments)
    .innerJoin(establishments, eq(establishments.id, eventEstablishments.establishmentId))
    .leftJoin(
      registrations,
      and(
        eq(registrations.participationId, eventEstablishments.id),
        eq(registrations.status, 'confirmed'),
      ),
    )
    .leftJoin(
      holderTurn,
      and(eq(holderTurn.registrationId, registrations.id), eq(holderTurn.position, 0)),
    )
    .leftJoin(issued, eq(issued.participationId, eventEstablishments.id))
    .where(eq(eventEstablishments.eventId, eventId))
    .groupBy(eventEstablishments.id, establishments.id)
    .orderBy(asc(establishments.name));

  return rows.map((row) => ({
    ...row,
    companions: Number(row.companions),
    turnsIssued: Number(row.turnsIssued),
    lastCheckInAt: row.lastCheckInAt === null ? null : Number(row.lastCheckInAt),
  }));
}

/** Busca por nombre, documento (sin puntos ni espacios) o folio, sin distinguir mayusculas. */
function searchCondition(raw: string | undefined): SQL | undefined {
  const term = raw?.trim().toLowerCase();
  if (!term) {
    return undefined;
  }
  const document = term.replace(/[\s.-]/g, '');
  return or(
    sql`instr(lower(${registrations.fullName}), ${term}) > 0`,
    document === '' ? undefined : sql`instr(lower(${registrations.documentNumber}), ${document}) > 0`,
    sql`instr(lower(${registrations.id}), ${term}) > 0`,
  );
}

function boardConditions(filters: BoardFilters): SQL {
  const conditions: (SQL | undefined)[] = [
    eq(eventEstablishments.eventId, filters.eventId),
    eq(registrations.status, 'confirmed'),
    filters.participationId === undefined
      ? undefined
      : eq(registrations.participationId, filters.participationId),
    filters.checkIn === 'checked_in'
      ? isNotNull(holderTurn.id)
      : filters.checkIn === 'pending'
        ? isNull(holderTurn.id)
        : undefined,
    searchCondition(filters.search),
  ];
  return and(...conditions) as SQL;
}

function boardOrder(sort: BoardSort, order: SortOrder): SQL[] {
  const direction = order === 'asc' ? asc : desc;
  switch (sort) {
    case 'fullName':
      return [direction(sql`${registrations.fullName} collate nocase`), asc(registrations.id)];
    case 'checkedInAt':
      // Los pendientes van al final en ambos sentidos: no tienen hora que comparar.
      return [
        asc(sql`${holderTurn.assignedAt} is null`),
        direction(holderTurn.assignedAt),
        asc(registrations.id),
      ];
    case 'turn':
      return [
        asc(sql`${holderTurn.number} is null`),
        direction(holderTurn.number),
        asc(registrations.id),
      ];
    case 'registeredAt':
      return [direction(registrations.registeredAt), asc(registrations.id)];
  }
}

export async function listBoardRows(db: Database, query: BoardQuery): Promise<BoardRow[]> {
  const rows = await db
    .select({
      id: registrations.id,
      fullName: registrations.fullName,
      documentType: registrations.documentType,
      documentNumber: registrations.documentNumber,
      companionsCount: registrations.companionsCount,
      registeredAt: registrations.registeredAt,
      participationId: registrations.participationId,
      sedeName: establishments.name,
      sedeCity: establishments.city,
      checkedInAt: holderTurn.assignedAt,
      firstTurn: holderTurn.number,
      lastTurn: sql<number | null>`(select max(${turns.number}) from ${turns} where ${turns.registrationId} = ${registrations.id})`,
      turnsCount: sql<number>`(select count(*) from ${turns} where ${turns.registrationId} = ${registrations.id})`,
      operatorId: users.id,
      operatorName: users.fullName,
    })
    .from(registrations)
    .innerJoin(eventEstablishments, eq(eventEstablishments.id, registrations.participationId))
    .innerJoin(establishments, eq(establishments.id, eventEstablishments.establishmentId))
    .leftJoin(
      holderTurn,
      and(eq(holderTurn.registrationId, registrations.id), eq(holderTurn.position, 0)),
    )
    .leftJoin(users, eq(users.id, holderTurn.assignedBy))
    .where(boardConditions(query))
    .orderBy(...boardOrder(query.sort, query.order))
    .limit(query.limit)
    .offset(query.offset);

  return rows.map((row) => ({
    ...row,
    lastTurn: row.lastTurn === null ? null : Number(row.lastTurn),
    turnsCount: Number(row.turnsCount),
  }));
}

export async function countBoardRows(db: Database, filters: BoardFilters): Promise<number> {
  const [row] = await db
    .select({ total: count() })
    .from(registrations)
    .innerJoin(eventEstablishments, eq(eventEstablishments.id, registrations.participationId))
    .leftJoin(
      holderTurn,
      and(eq(holderTurn.registrationId, registrations.id), eq(holderTurn.position, 0)),
    )
    .where(boardConditions(filters));
  return row?.total ?? 0;
}

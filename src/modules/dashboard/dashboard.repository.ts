import { and, asc, count, desc, eq, sql, type SQL } from 'drizzle-orm';
import { alias } from 'drizzle-orm/sqlite-core';
import type { Database } from '../../db/client';
import {
  establishments,
  eventEstablishments,
  events,
  registrations,
  turns,
  users,
  type EventStatus,
} from '../../db/schema';

/**
 * Lecturas agregadas del tablero principal.
 *
 * Usan las mismas fuentes y definiciones que la mesa de registro: solo cuentan
 * las inscripciones confirmadas y un titular "ingreso" cuando tiene su turno en
 * la posicion 0. No hay tablas propias del tablero.
 */

const holderTurn = alias(turns, 'holder_turn');

const HOUR_MS = 3_600_000;

export interface EventOverviewRow {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
  readonly status: EventStatus;
  readonly timezone: string;
  readonly startsAt: Date | null;
  readonly endsAt: Date | null;
  readonly registrationOpensAt: Date | null;
  readonly registrationClosesAt: Date | null;
  readonly createdAt: Date;
  readonly titulares: number;
  readonly companions: number;
  readonly checkedIn: number;
}

export interface EventSedeRow {
  readonly eventId: string;
  readonly participationId: string;
  readonly name: string;
}

/** Un evento por fila con sus totales; incluye los eventos sin sedes ni inscripciones. */
export async function eventOverviewRows(db: Database): Promise<EventOverviewRow[]> {
  const rows = await db
    .select({
      id: events.id,
      slug: events.slug,
      name: events.name,
      status: events.status,
      timezone: events.timezone,
      startsAt: events.startsAt,
      endsAt: events.endsAt,
      registrationOpensAt: events.registrationOpensAt,
      registrationClosesAt: events.registrationClosesAt,
      createdAt: events.createdAt,
      titulares: count(registrations.id),
      companions: sql<number>`coalesce(sum(${registrations.companionsCount}), 0)`,
      checkedIn: count(holderTurn.id),
    })
    .from(events)
    .leftJoin(eventEstablishments, eq(eventEstablishments.eventId, events.id))
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
    .groupBy(events.id);

  return rows.map((row) => ({ ...row, companions: Number(row.companions) }));
}

/** Sedes de todos los eventos: la tabla es pequena y evita un `IN` con un parametro por evento. */
export async function eventSedeRows(db: Database): Promise<EventSedeRow[]> {
  return db
    .select({
      eventId: eventEstablishments.eventId,
      participationId: eventEstablishments.id,
      name: establishments.name,
    })
    .from(eventEstablishments)
    .innerJoin(establishments, eq(establishments.id, eventEstablishments.establishmentId))
    .orderBy(asc(establishments.name));
}

export interface ScopeFilter {
  readonly eventId: string;
  readonly participationId?: string;
}

function confirmedInScope(scope: ScopeFilter): SQL {
  return and(
    eq(eventEstablishments.eventId, scope.eventId),
    eq(registrations.status, 'confirmed'),
    scope.participationId === undefined
      ? undefined
      : eq(registrations.participationId, scope.participationId),
  ) as SQL;
}

export interface HourBucketRow {
  /** Horas enteras desde epoch (UTC). */
  readonly hour: number;
  readonly titulares: number;
  readonly companions: number;
  /** Titulares de la hora inscritos en o despues de `since`. */
  readonly recent: number;
}

/**
 * Inscripciones confirmadas agrupadas por hora UTC. Solo devuelve las horas con
 * actividad, de modo que el tamano depende de la actividad y no del rango.
 */
export async function registrationHourBuckets(
  db: Database,
  scope: ScopeFilter,
  since: Date,
): Promise<HourBucketRow[]> {
  const hour = sql<number>`${registrations.registeredAt} / ${HOUR_MS}`;
  const rows = await db
    .select({
      hour,
      titulares: count(),
      companions: sql<number>`coalesce(sum(${registrations.companionsCount}), 0)`,
      recent: sql<number>`coalesce(sum(case when ${registrations.registeredAt} >= ${since.getTime()} then 1 else 0 end), 0)`,
    })
    .from(registrations)
    .innerJoin(eventEstablishments, eq(eventEstablishments.id, registrations.participationId))
    .where(confirmedInScope(scope))
    .groupBy(hour)
    .orderBy(asc(hour));

  return rows.map((row) => ({
    hour: Number(row.hour),
    titulares: row.titulares,
    companions: Number(row.companions),
    recent: Number(row.recent),
  }));
}

export interface RecentRegistrationRow {
  readonly id: string;
  readonly fullName: string;
  readonly companionsCount: number;
  readonly registeredAt: Date;
  readonly sedeName: string;
}

export async function recentRegistrations(
  db: Database,
  scope: ScopeFilter,
  limit: number,
): Promise<RecentRegistrationRow[]> {
  return db
    .select({
      id: registrations.id,
      fullName: registrations.fullName,
      companionsCount: registrations.companionsCount,
      registeredAt: registrations.registeredAt,
      sedeName: establishments.name,
    })
    .from(registrations)
    .innerJoin(eventEstablishments, eq(eventEstablishments.id, registrations.participationId))
    .innerJoin(establishments, eq(establishments.id, eventEstablishments.establishmentId))
    .where(confirmedInScope(scope))
    .orderBy(desc(registrations.registeredAt), asc(registrations.id))
    .limit(limit);
}

export interface RecentCheckInRow {
  readonly id: string;
  readonly fullName: string;
  readonly sedeName: string;
  readonly checkedInAt: Date;
  readonly firstTurn: number;
  readonly lastTurn: number | null;
  readonly operatorName: string | null;
}

/** Ultimos ingresos: un titular aparece una sola vez porque su turno en la posicion 0 es unico. */
export async function recentCheckIns(
  db: Database,
  scope: ScopeFilter,
  limit: number,
): Promise<RecentCheckInRow[]> {
  const rows = await db
    .select({
      id: registrations.id,
      fullName: registrations.fullName,
      sedeName: establishments.name,
      checkedInAt: holderTurn.assignedAt,
      firstTurn: holderTurn.number,
      lastTurn: sql<number | null>`(select max(${turns.number}) from ${turns} where ${turns.registrationId} = ${registrations.id})`,
      operatorName: users.fullName,
    })
    .from(holderTurn)
    .innerJoin(registrations, eq(registrations.id, holderTurn.registrationId))
    .innerJoin(eventEstablishments, eq(eventEstablishments.id, registrations.participationId))
    .innerJoin(establishments, eq(establishments.id, eventEstablishments.establishmentId))
    .leftJoin(users, eq(users.id, holderTurn.assignedBy))
    .where(and(eq(holderTurn.position, 0), confirmedInScope(scope)))
    .orderBy(desc(holderTurn.assignedAt), asc(registrations.id))
    .limit(limit);

  return rows.map((row) => ({
    ...row,
    lastTurn: row.lastTurn === null ? null : Number(row.lastTurn),
  }));
}

export interface EventAuditRow {
  readonly id: string;
  readonly name: string;
  readonly timezone: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly creatorName: string | null;
}

export async function findEventAudit(db: Database, eventId: string): Promise<EventAuditRow | null> {
  const [row] = await db
    .select({
      id: events.id,
      name: events.name,
      timezone: events.timezone,
      createdAt: events.createdAt,
      updatedAt: events.updatedAt,
      creatorName: users.fullName,
    })
    .from(events)
    .leftJoin(users, eq(users.id, events.createdBy))
    .where(eq(events.id, eventId))
    .limit(1);
  return row ?? null;
}

export async function participationBelongsToEvent(
  db: Database,
  eventId: string,
  participationId: string,
): Promise<boolean> {
  const [row] = await db
    .select({ id: eventEstablishments.id })
    .from(eventEstablishments)
    .where(and(eq(eventEstablishments.id, participationId), eq(eventEstablishments.eventId, eventId)))
    .limit(1);
  return row !== undefined;
}

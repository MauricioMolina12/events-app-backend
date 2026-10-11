import { AppError } from '../../core/errors/app-error';
import { ErrorCode } from '../../core/errors/error-codes';
import type { Database } from '../../db/client';
import type { EventStatus } from '../../db/schema';
import { isWithinRegistrationWindow } from '../registrations/registrations.service';
import {
  eventOverviewRows,
  eventSedeRows,
  findEventAudit,
  participationBelongsToEvent,
  recentCheckIns,
  recentRegistrations,
  registrationHourBuckets,
  type EventOverviewRow,
  type HourBucketRow,
  type ScopeFilter,
} from './dashboard.repository';

/**
 * Tablero principal del panel.
 *
 * Las metricas de un evento (titulares, personas, ingresos, pendientes y
 * asistencia) las sigue resolviendo `GET /check-in/summary`; aqui solo vive lo
 * que la mesa no tenia: la fase de cada evento, los totales por evento para la
 * vista general, la evolucion de inscripciones y la actividad reciente. Todas
 * las cifras usan las mismas definiciones que la mesa.
 */

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

/** Hasta dos dias se agrupa por hora; hasta cuatro meses, por dia; despues, por semana. */
const HOURLY_MAX_SPAN_HOURS = 48;
const DAILY_MAX_SPAN_DAYS = 120;

export const OVERVIEW_EVENT_LIMIT = 50;
export const ACTIVITY_LIMITS = { defaultLimit: 8, maxLimit: 20 } as const;

/**
 * Fase de un evento segun su estado y sus fechas.
 *
 * - `draft` y `archived` salen del estado sin mirar fechas.
 * - Un evento publicado o cerrado esta `finished` cuando paso `endsAt`; sin
 *   `endsAt`, se toma como de un dia y termina 24 h despues de `startsAt`.
 * - `in_progress` entre `startsAt` y el final.
 * - Antes de empezar: `registration_closed` si el estado es `closed` o ya se
 *   cerro la ventana, `upcoming` si la ventana aun no abre y `registration_open`
 *   en otro caso (la misma regla de ventana que aplica el alta).
 */
export type EventPhase =
  | 'draft'
  | 'upcoming'
  | 'registration_open'
  | 'registration_closed'
  | 'in_progress'
  | 'finished'
  | 'archived';

export const ACTIVE_PHASES: readonly EventPhase[] = [
  'upcoming',
  'registration_open',
  'registration_closed',
  'in_progress',
];

interface PhaseSource {
  readonly status: EventStatus;
  readonly startsAt: Date | null;
  readonly endsAt: Date | null;
  readonly registrationOpensAt: Date | null;
  readonly registrationClosesAt: Date | null;
}

export function eventPhase(event: PhaseSource, now: Date): EventPhase {
  if (event.status === 'draft' || event.status === 'archived') {
    return event.status;
  }
  const at = now.getTime();
  const endsAt =
    event.endsAt?.getTime() ??
    (event.startsAt === null ? null : event.startsAt.getTime() + DAY_MS);
  if (endsAt !== null && at > endsAt) {
    return 'finished';
  }
  if (event.startsAt !== null && at >= event.startsAt.getTime()) {
    return 'in_progress';
  }
  if (event.status === 'closed') {
    return 'registration_closed';
  }
  if (event.registrationOpensAt !== null && at < event.registrationOpensAt.getTime()) {
    return 'upcoming';
  }
  return isWithinRegistrationWindow(
    { opensAt: event.registrationOpensAt, closesAt: event.registrationClosesAt },
    now,
  )
    ? 'registration_open'
    : 'registration_closed';
}

const PHASE_RANK: Record<EventPhase, number> = {
  in_progress: 0,
  registration_open: 1,
  registration_closed: 2,
  upcoming: 3,
  finished: 4,
  draft: 5,
  archived: 6,
};

export interface OverviewEvent {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
  readonly status: EventStatus;
  readonly phase: EventPhase;
  readonly timezone: string;
  readonly startsAt: Date | null;
  readonly endsAt: Date | null;
  readonly registrationOpensAt: Date | null;
  readonly registrationClosesAt: Date | null;
  readonly sedes: readonly { participationId: string; name: string }[];
  readonly titulares: number;
  readonly people: number;
  readonly checkedIn: number;
  readonly attendanceRate: number;
}

export interface Overview {
  readonly generatedAt: Date;
  readonly events: {
    readonly total: number;
    readonly active: number;
    readonly byStatus: Readonly<Record<EventStatus, number>>;
  };
  /** Ordenados por relevancia: en curso, abiertos, proximos, finalizados, borradores, archivados. */
  readonly items: readonly OverviewEvent[];
}

export function attendanceRate(checkedIn: number, titulares: number): number {
  return titulares === 0 ? 0 : Math.round((checkedIn / titulares) * 10_000) / 10_000;
}

function relevance(left: OverviewEvent, right: OverviewEvent): number {
  const rank = PHASE_RANK[left.phase] - PHASE_RANK[right.phase];
  if (rank !== 0) {
    return rank;
  }
  // Dentro de la misma fase, el mas cercano primero; sin fecha, al final.
  const leftAt = left.startsAt?.getTime() ?? Number.MAX_SAFE_INTEGER;
  const rightAt = right.startsAt?.getTime() ?? Number.MAX_SAFE_INTEGER;
  const finished = left.phase === 'finished' ? -1 : 1;
  return leftAt === rightAt ? left.name.localeCompare(right.name) : (leftAt - rightAt) * finished;
}

export async function getOverview(db: Database, now: Date = new Date()): Promise<Overview> {
  const [rows, sedes] = await Promise.all([eventOverviewRows(db), eventSedeRows(db)]);

  const sedesByEvent = new Map<string, { participationId: string; name: string }[]>();
  for (const sede of sedes) {
    const list = sedesByEvent.get(sede.eventId) ?? [];
    list.push({ participationId: sede.participationId, name: sede.name });
    sedesByEvent.set(sede.eventId, list);
  }

  const byStatus: Record<EventStatus, number> = { draft: 0, published: 0, closed: 0, archived: 0 };
  const items = rows.map((row: EventOverviewRow): OverviewEvent => {
    byStatus[row.status] += 1;
    return {
      id: row.id,
      slug: row.slug,
      name: row.name,
      status: row.status,
      phase: eventPhase(row, now),
      timezone: row.timezone,
      startsAt: row.startsAt,
      endsAt: row.endsAt,
      registrationOpensAt: row.registrationOpensAt,
      registrationClosesAt: row.registrationClosesAt,
      sedes: sedesByEvent.get(row.id) ?? [],
      titulares: row.titulares,
      people: row.titulares + row.companions,
      checkedIn: row.checkedIn,
      attendanceRate: attendanceRate(row.checkedIn, row.titulares),
    };
  });

  items.sort(relevance);
  return {
    generatedAt: now,
    events: {
      total: items.length,
      active: items.filter((item) => ACTIVE_PHASES.includes(item.phase)).length,
      byStatus,
    },
    items: items.slice(0, OVERVIEW_EVENT_LIMIT),
  };
}

/* ── Evolucion de inscripciones ──────────────────────────────────────────── */

export type TimelineGranularity = 'hour' | 'day' | 'week';

export interface TimelineBucket {
  /** Fecha local del evento (`YYYY-MM-DD`); en semanas, el lunes que la abre. */
  readonly date: string;
  /** Hora local (0-23) cuando la granularidad es `hour`. */
  readonly hour: number | null;
  readonly titulares: number;
  readonly people: number;
  /** Titulares acumulados hasta este tramo, incluido. */
  readonly cumulative: number;
}

export interface Timeline {
  readonly timezone: string;
  readonly granularity: TimelineGranularity;
  readonly total: number;
  /** Titulares inscritos en las ultimas 24 horas. */
  readonly last24h: number;
  readonly buckets: readonly TimelineBucket[];
}

interface LocalTime {
  readonly date: string;
  readonly hour: number;
}

function localTimeFormatter(timezone: string): (at: number) => LocalTime {
  let format: Intl.DateTimeFormat;
  try {
    format = new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      hourCycle: 'h23',
    });
  } catch {
    format = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/Bogota',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      hourCycle: 'h23',
    });
  }
  return (at) => {
    const parts = Object.fromEntries(
      format.formatToParts(new Date(at)).map((part) => [part.type, part.value]),
    );
    return { date: `${parts.year}-${parts.month}-${parts.day}`, hour: Number(parts.hour) % 24 };
  };
}

function shiftDate(date: string, days: number): string {
  const [year, month, day] = date.split('-').map(Number);
  return new Date(Date.UTC(year!, month! - 1, day! + days)).toISOString().slice(0, 10);
}

function mondayOf(date: string): string {
  const [year, month, day] = date.split('-').map(Number);
  const weekday = new Date(Date.UTC(year!, month! - 1, day!)).getUTCDay();
  return shiftDate(date, -((weekday + 6) % 7));
}

function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS);
}

/** Agrupa las horas con actividad en tramos locales consecutivos, rellenando con ceros. */
export function buildTimeline(rows: readonly HourBucketRow[], timezone: string): Omit<Timeline, 'last24h'> {
  const total = rows.reduce((sum, row) => sum + row.titulares, 0);
  if (rows.length === 0) {
    return { timezone, granularity: 'day', total, buckets: [] };
  }

  const local = localTimeFormatter(timezone);
  const first = rows[0]!.hour;
  const last = rows[rows.length - 1]!.hour;

  const slots: { date: string; hour: number | null }[] = [];
  let granularity: TimelineGranularity;
  let keyOf: (hour: number) => string;

  if (last - first < HOURLY_MAX_SPAN_HOURS) {
    granularity = 'hour';
    keyOf = (hour) => {
      const time = local(hour * HOUR_MS);
      return `${time.date}T${time.hour}`;
    };
    // Al atrasar el reloj una hora local se repite: ambas horas UTC caen en el mismo tramo.
    for (let hour = first; hour <= last; hour += 1) {
      const time = local(hour * HOUR_MS);
      const previous = slots.at(-1);
      if (previous?.date !== time.date || previous.hour !== time.hour) {
        slots.push({ date: time.date, hour: time.hour });
      }
    }
  } else {
    const firstDate = local(first * HOUR_MS).date;
    const lastDate = local(last * HOUR_MS).date;
    granularity = daysBetween(firstDate, lastDate) <= DAILY_MAX_SPAN_DAYS ? 'day' : 'week';
    const step = granularity === 'day' ? 1 : 7;
    const start = granularity === 'day' ? firstDate : mondayOf(firstDate);
    const end = granularity === 'day' ? lastDate : mondayOf(lastDate);
    keyOf = (hour) => {
      const date = local(hour * HOUR_MS).date;
      return granularity === 'day' ? date : mondayOf(date);
    };
    for (let date = start; date <= end; date = shiftDate(date, step)) {
      slots.push({ date, hour: null });
    }
  }

  const totals = new Map<string, { titulares: number; people: number }>();
  for (const row of rows) {
    const key = keyOf(row.hour);
    const current = totals.get(key) ?? { titulares: 0, people: 0 };
    current.titulares += row.titulares;
    current.people += row.titulares + row.companions;
    totals.set(key, current);
  }

  let cumulative = 0;
  const buckets = slots.map((slot): TimelineBucket => {
    const key = slot.hour === null ? slot.date : `${slot.date}T${slot.hour}`;
    const value = totals.get(key) ?? { titulares: 0, people: 0 };
    cumulative += value.titulares;
    return { date: slot.date, hour: slot.hour, ...value, cumulative };
  });

  return { timezone, granularity, total, buckets };
}

async function requireScope(db: Database, scope: ScopeFilter) {
  const event = await findEventAudit(db, scope.eventId);
  if (event === null) {
    throw AppError.notFound(ErrorCode.EVENT_NOT_FOUND, 'El evento no existe.');
  }
  if (
    scope.participationId !== undefined &&
    !(await participationBelongsToEvent(db, scope.eventId, scope.participationId))
  ) {
    throw AppError.notFound(ErrorCode.PARTICIPATION_NOT_FOUND, 'La sede no participa en este evento.');
  }
  return event;
}

export async function getRegistrationTimeline(
  db: Database,
  scope: ScopeFilter,
  now: Date = new Date(),
): Promise<Timeline> {
  const event = await requireScope(db, scope);
  const rows = await registrationHourBuckets(db, scope, new Date(now.getTime() - DAY_MS));
  return {
    ...buildTimeline(rows, event.timezone),
    last24h: rows.reduce((sum, row) => sum + row.recent, 0),
  };
}

/* ── Actividad reciente ──────────────────────────────────────────────────── */

export type ActivityItem =
  | {
      readonly type: 'registration';
      readonly at: Date;
      readonly registration: { id: string; fullName: string; people: number; sede: string };
    }
  | {
      readonly type: 'check_in';
      readonly at: Date;
      readonly registration: { id: string; fullName: string; sede: string };
      readonly turn: { first: number; last: number | null };
      readonly operator: string | null;
    }
  | {
      readonly type: 'event_created' | 'event_updated';
      readonly at: Date;
      readonly event: { id: string; name: string };
      readonly actor: string | null;
    };

export async function getRecentActivity(
  db: Database,
  scope: ScopeFilter,
  limit: number,
): Promise<ActivityItem[]> {
  const event = await requireScope(db, scope);
  const [registered, checkedIn] = await Promise.all([
    recentRegistrations(db, scope, limit),
    recentCheckIns(db, scope, limit),
  ]);

  const items: ActivityItem[] = [
    ...registered.map((row): ActivityItem => ({
      type: 'registration',
      at: row.registeredAt,
      registration: {
        id: row.id,
        fullName: row.fullName,
        people: row.companionsCount + 1,
        sede: row.sedeName,
      },
    })),
    ...checkedIn.map((row): ActivityItem => ({
      type: 'check_in',
      at: row.checkedInAt,
      registration: { id: row.id, fullName: row.fullName, sede: row.sedeName },
      turn: { first: row.firstTurn, last: row.lastTurn },
      operator: row.operatorName,
    })),
  ];

  // La ficha del evento no guarda quien la edito; solo su creador.
  if (scope.participationId === undefined) {
    items.push({
      type: 'event_created',
      at: event.createdAt,
      event: { id: event.id, name: event.name },
      actor: event.creatorName,
    });
    if (event.updatedAt.getTime() > event.createdAt.getTime()) {
      items.push({
        type: 'event_updated',
        at: event.updatedAt,
        event: { id: event.id, name: event.name },
        actor: null,
      });
    }
  }

  return items.sort((left, right) => right.at.getTime() - left.at.getTime()).slice(0, limit);
}

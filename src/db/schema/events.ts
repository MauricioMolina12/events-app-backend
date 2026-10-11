import { sql } from 'drizzle-orm';
import { check, index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';
import { createdAtColumn, idColumn, timestampColumn, updatedAtColumn } from './columns';
import { users } from './auth';

/* ------------------------------------------------------------------ *
 * Eventos, establecimientos y participaciones.
 * ------------------------------------------------------------------ */

export const EVENT_STATUSES = ['draft', 'published', 'closed', 'archived'] as const;
export type EventStatus = (typeof EVENT_STATUSES)[number];

export const ESTABLISHMENT_STATUSES = ['active', 'inactive'] as const;
export type EstablishmentStatus = (typeof ESTABLISHMENT_STATUSES)[number];

export const PARTICIPATION_STATUSES = ['open', 'closed', 'cancelled'] as const;
export type ParticipationStatus = (typeof PARTICIPATION_STATUSES)[number];

/**
 * Eventos.
 *
 * Las ventanas de tiempo son del evento y sirven de valor por defecto; cada
 * participacion (sede) puede sobrescribirlas.
 */
export const events = sqliteTable(
  'events',
  {
    id: idColumn(),
    /** Identificador legible en URL (`/eventos/dia-del-nino`). Unico. */
    slug: text('slug').notNull(),
    name: text('name').notNull(),
    description: text('description'),
    /** Zona horaria de presentacion; las fechas se guardan siempre en UTC. */
    timezone: text('timezone').notNull().default('America/Bogota'),
    startsAt: timestampColumn('starts_at'),
    endsAt: timestampColumn('ends_at'),
    registrationOpensAt: timestampColumn('registration_opens_at'),
    registrationClosesAt: timestampColumn('registration_closes_at'),
    /** Cupo general: techo de personas (titulares + acompanantes) entre las sedes. */
    capacity: integer('capacity').notNull().default(0),
    status: text('status', { enum: EVENT_STATUSES }).notNull().default('draft'),
    createdBy: text('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAtColumn(),
    updatedAt: updatedAtColumn(),
  },
  (table) => [
    uniqueIndex('events_slug_unique').on(table.slug),
    index('events_status_idx').on(table.status),
    check(
      'events_window_check',
      sql`${table.registrationOpensAt} IS NULL OR ${table.registrationClosesAt} IS NULL OR ${table.registrationOpensAt} <= ${table.registrationClosesAt}`,
    ),
    check('events_capacity_check', sql`${table.capacity} >= 0`),
  ],
);

/**
 * Establecimientos (sedes).
 *
 * `code` es un identificador corto y estable para operacion y reportes.
 */
export const establishments = sqliteTable(
  'establishments',
  {
    id: idColumn(),
    code: text('code').notNull(),
    name: text('name').notNull(),
    city: text('city'),
    address: text('address'),
    status: text('status', { enum: ESTABLISHMENT_STATUSES }).notNull().default('active'),
    createdAt: createdAtColumn(),
    updatedAt: updatedAtColumn(),
  },
  (table) => [
    uniqueIndex('establishments_code_unique').on(table.code),
    index('establishments_status_idx').on(table.status),
  ],
);

/**
 * Participacion de un establecimiento en un evento.
 *
 * Es la unidad real de cupo: la misma persona puede registrarse en varios
 * establecimientos del mismo evento, pero solo una vez por establecimiento.
 *
 * Los contadores confirmados son la pieza que hace atomica la reserva de cupo
 * sin transacciones: la reserva es un
 * `UPDATE ... SET confirmed_titulares = confirmed_titulares + 1
 *  WHERE id = ? AND confirmed_titulares < titular_capacity`
 * y basta comprobar cuantas filas cambiaron. Los `CHECK` son la red de
 * seguridad: si algun camino del codigo intentara sobrepasar el cupo, la
 * escritura falla en la base de datos.
 */
export const eventEstablishments = sqliteTable(
  'event_establishments',
  {
    id: idColumn(),
    eventId: text('event_id')
      .notNull()
      .references(() => events.id, { onDelete: 'cascade' }),
    establishmentId: text('establishment_id')
      .notNull()
      .references(() => establishments.id, { onDelete: 'restrict' }),
    status: text('status', { enum: PARTICIPATION_STATUSES }).notNull().default('open'),
    /** Cupo de titulares (un QR por titular). */
    titularCapacity: integer('titular_capacity').notNull().default(0),
    /** Cupo total de acompanantes de la sede. */
    companionCapacity: integer('companion_capacity').notNull().default(0),
    confirmedTitulares: integer('confirmed_titulares').notNull().default(0),
    confirmedCompanions: integer('confirmed_companions').notNull().default(0),
    /** Ventanas propias de la sede; `NULL` hereda las del evento. */
    registrationOpensAt: timestampColumn('registration_opens_at'),
    registrationClosesAt: timestampColumn('registration_closes_at'),
    checkInOpensAt: timestampColumn('check_in_opens_at'),
    checkInClosesAt: timestampColumn('check_in_closes_at'),
    notes: text('notes'),
    createdAt: createdAtColumn(),
    updatedAt: updatedAtColumn(),
  },
  (table) => [
    uniqueIndex('event_establishments_event_establishment_unique').on(
      table.eventId,
      table.establishmentId,
    ),
    index('event_establishments_event_idx').on(table.eventId),
    index('event_establishments_establishment_idx').on(table.establishmentId),
    check(
      'event_establishments_titular_capacity_check',
      sql`${table.confirmedTitulares} >= 0 AND ${table.confirmedTitulares} <= ${table.titularCapacity}`,
    ),
    check(
      'event_establishments_companion_capacity_check',
      sql`${table.confirmedCompanions} >= 0 AND ${table.confirmedCompanions} <= ${table.companionCapacity}`,
    ),
    check(
      'event_establishments_registration_window_check',
      sql`${table.registrationOpensAt} IS NULL OR ${table.registrationClosesAt} IS NULL OR ${table.registrationOpensAt} <= ${table.registrationClosesAt}`,
    ),
  ],
);

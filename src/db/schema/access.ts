import { sql } from 'drizzle-orm';
import { check, index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';
import { users } from './auth';
import { createdAtColumn, idColumn, requiredTimestampColumn, timestampColumn, updatedAtColumn } from './columns';
import { eventEstablishments } from './events';
import { registrationCompanions, registrations } from './registrations';

/* ------------------------------------------------------------------ *
 * Turnos y control de acceso en puerta.
 * ------------------------------------------------------------------ */

export const SHIFT_STATUSES = ['scheduled', 'active', 'closed', 'cancelled'] as const;
export type ShiftStatus = (typeof SHIFT_STATUSES)[number];

export const SHIFT_ASSIGNMENT_STATUSES = ['assigned', 'checked_in', 'released', 'no_show'] as const;
export type ShiftAssignmentStatus = (typeof SHIFT_ASSIGNMENT_STATUSES)[number];

/**
 * Turnos de una sede dentro de un evento.
 *
 * El organizador define los turnos (etiqueta, horario y cupo) y la operacion en
 * puerta asigna cada registro a uno de ellos. Igual que en las participaciones,
 * `assigned_count` permite una asignacion atomica sin transacciones:
 * `UPDATE shifts SET assigned_count = assigned_count + 1
 *  WHERE id = ? AND assigned_count < capacity`.
 */
export const shifts = sqliteTable(
  'shifts',
  {
    id: idColumn(),
    participationId: text('participation_id')
      .notNull()
      .references(() => eventEstablishments.id, { onDelete: 'restrict' }),
    /** Codigo corto del turno dentro de la sede (`T1`, `T2`...). */
    code: text('code').notNull(),
    label: text('label').notNull(),
    startsAt: requiredTimestampColumn('starts_at'),
    endsAt: requiredTimestampColumn('ends_at'),
    capacity: integer('capacity').notNull(),
    assignedCount: integer('assigned_count').notNull().default(0),
    status: text('status', { enum: SHIFT_STATUSES }).notNull().default('scheduled'),
    createdAt: createdAtColumn(),
    updatedAt: updatedAtColumn(),
  },
  (table) => [
    uniqueIndex('shifts_participation_code_unique').on(table.participationId, table.code),
    index('shifts_participation_starts_idx').on(table.participationId, table.startsAt),
    index('shifts_status_idx').on(table.status),
    check(
      'shifts_assigned_count_check',
      sql`${table.assignedCount} >= 0 AND ${table.assignedCount} <= ${table.capacity}`,
    ),
    check('shifts_window_check', sql`${table.startsAt} <= ${table.endsAt}`),
  ],
);

/**
 * Asignacion de un turno a un registro.
 *
 * `TICKET_NOT_FOUND` se corresponde con la ausencia de una asignacion activa
 * para el QR escaneado; el indice unico parcial sobre `registration_id` (solo
 * estados activos) garantiza que un registro no pueda tener dos turnos vivos,
 * que es la base de `CHECK_IN_ALREADY_ASSIGNED`. Liberar un turno (`released`)
 * permite reasignarlo.
 */
export const shiftAssignments = sqliteTable(
  'shift_assignments',
  {
    id: idColumn(),
    shiftId: text('shift_id')
      .notNull()
      .references(() => shifts.id, { onDelete: 'restrict' }),
    registrationId: text('registration_id')
      .notNull()
      .references(() => registrations.id, { onDelete: 'restrict' }),
    status: text('status', { enum: SHIFT_ASSIGNMENT_STATUSES }).notNull().default('assigned'),
    assignedAt: requiredTimestampColumn('assigned_at'),
    assignedBy: text('assigned_by').references(() => users.id, { onDelete: 'set null' }),
    checkedInAt: timestampColumn('checked_in_at'),
    checkedInBy: text('checked_in_by').references(() => users.id, { onDelete: 'set null' }),
    releasedAt: timestampColumn('released_at'),
    releaseReason: text('release_reason'),
    updatedAt: updatedAtColumn(),
  },
  (table) => [
    uniqueIndex('shift_assignments_registration_active_unique')
      .on(table.registrationId)
      .where(sql`${table.status} IN ('assigned', 'checked_in')`),
    index('shift_assignments_shift_status_idx').on(table.shiftId, table.status),
    index('shift_assignments_registration_idx').on(table.registrationId),
  ],
);

/**
 * Ultimo turno entregado en cada sede.
 *
 * La asignacion hace un upsert que suma el tamano del grupo y, dentro del mismo
 * `db.batch`, inserta los turnos leyendo el valor resultante. SQLite ejecuta las
 * escrituras de una en una, asi que dos escaneos simultaneos nunca leen el mismo
 * contador; si la insercion falla, el batch se revierte y el numero no se pierde.
 */
export const turnCounters = sqliteTable(
  'turn_counters',
  {
    participationId: text('participation_id')
      .primaryKey()
      .references(() => eventEstablishments.id, { onDelete: 'restrict' }),
    lastNumber: integer('last_number').notNull().default(0),
    updatedAt: updatedAtColumn(),
  },
  (table) => [check('turn_counters_last_number_check', sql`${table.lastNumber} >= 0`)],
);

/**
 * Turno consecutivo de una persona, entregado al escanear el QR del titular.
 *
 * Un registro recibe un turno por persona: el titular en la posicion 0 y sus
 * acompanantes despues, con numeros seguidos. `full_name` es una copia: el turno
 * impreso no cambia aunque luego se corrija el nombre.
 */
export const turns = sqliteTable(
  'turns',
  {
    id: idColumn(),
    participationId: text('participation_id')
      .notNull()
      .references(() => eventEstablishments.id, { onDelete: 'restrict' }),
    registrationId: text('registration_id')
      .notNull()
      .references(() => registrations.id, { onDelete: 'restrict' }),
    companionId: text('companion_id').references(() => registrationCompanions.id, {
      onDelete: 'set null',
    }),
    position: integer('position').notNull(),
    fullName: text('full_name').notNull(),
    number: integer('number').notNull(),
    assignedAt: requiredTimestampColumn('assigned_at'),
    assignedBy: text('assigned_by').references(() => users.id, { onDelete: 'set null' }),
  },
  (table) => [
    uniqueIndex('turns_participation_number_unique').on(table.participationId, table.number),
    uniqueIndex('turns_registration_position_unique').on(table.registrationId, table.position),
    check('turns_number_check', sql`${table.number} >= 1`),
    check('turns_position_check', sql`${table.position} >= 0`),
  ],
);

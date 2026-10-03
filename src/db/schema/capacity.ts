import { sql } from 'drizzle-orm';
import { check, index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';
import { users } from './auth';
import { createdAtColumn, idColumn, timestampColumn } from './columns';
import { eventEstablishments } from './events';

/* ------------------------------------------------------------------ *
 * Ajustes de cupo con flujo de aprobacion.
 * ------------------------------------------------------------------ */

export const CAPACITY_ADJUSTMENT_STATUSES = ['pending', 'approved', 'rejected', 'cancelled'] as const;
export type CapacityAdjustmentStatus = (typeof CAPACITY_ADJUSTMENT_STATUSES)[number];

/**
 * Solicitudes de cambio de cupo de una sede.
 *
 * Cada fila guarda el cupo anterior y el propuesto: el historial queda completo
 * y un cambio siempre es auditable. El indice unico parcial sobre
 * `participation_id` (estado `pending`) impide dos solicitudes abiertas a la vez.
 *
 * Aprobar un ajuste que dejaria el cupo por debajo de los registros confirmados
 * falla: ademas de validarlo el servicio, los `CHECK` de `event_establishments`
 * lo bloquean en la base de datos.
 */
export const capacityAdjustments = sqliteTable(
  'capacity_adjustments',
  {
    id: idColumn(),
    participationId: text('participation_id')
      .notNull()
      .references(() => eventEstablishments.id, { onDelete: 'restrict' }),
    titularCapacityFrom: integer('titular_capacity_from').notNull(),
    titularCapacityTo: integer('titular_capacity_to').notNull(),
    companionCapacityFrom: integer('companion_capacity_from').notNull(),
    companionCapacityTo: integer('companion_capacity_to').notNull(),
    reason: text('reason').notNull(),
    status: text('status', { enum: CAPACITY_ADJUSTMENT_STATUSES }).notNull().default('pending'),
    requestedBy: text('requested_by').references(() => users.id, { onDelete: 'set null' }),
    resolvedBy: text('resolved_by').references(() => users.id, { onDelete: 'set null' }),
    resolvedAt: timestampColumn('resolved_at'),
    resolutionNotes: text('resolution_notes'),
    /** Momento en que el cupo nuevo se escribio en la participacion. */
    appliedAt: timestampColumn('applied_at'),
    createdAt: createdAtColumn(),
  },
  (table) => [
    uniqueIndex('capacity_adjustments_participation_pending_unique')
      .on(table.participationId)
      .where(sql`${table.status} = 'pending'`),
    index('capacity_adjustments_participation_status_idx').on(table.participationId, table.status),
    index('capacity_adjustments_status_created_idx').on(table.status, table.createdAt),
    check(
      'capacity_adjustments_targets_check',
      sql`${table.titularCapacityTo} >= 0 AND ${table.companionCapacityTo} >= 0`,
    ),
  ],
);

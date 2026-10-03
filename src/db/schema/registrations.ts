import { sql } from 'drizzle-orm';
import { check, index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';
import { createdAtColumn, idColumn, requiredTimestampColumn, timestampColumn, updatedAtColumn } from './columns';
import { eventEstablishments } from './events';

/* ------------------------------------------------------------------ *
 * Registros de participacion y acompanantes.
 * ------------------------------------------------------------------ */

export const DOCUMENT_TYPES = ['CC', 'TI', 'CE', 'PA', 'RC', 'NIT'] as const;
export type DocumentType = (typeof DOCUMENT_TYPES)[number];

export const REGISTRATION_STATUSES = ['confirmed', 'waitlisted', 'cancelled'] as const;
export type RegistrationStatus = (typeof REGISTRATION_STATUSES)[number];

export const REGISTRATION_SOURCES = ['public', 'admin'] as const;
export type RegistrationSource = (typeof REGISTRATION_SOURCES)[number];

/**
 * Registro de participacion (siempre es el titular; obtiene un unico QR).
 *
 * Invariantes:
 * - **Un documento, un registro por evento + establecimiento.** La participacion
 *   ya es la pareja (evento, establecimiento), por lo que el indice unico
 *   parcial sobre `(participation_id, document_type, document_number)` expresa
 *   la regla de forma transitiva y sin columnas duplicadas.
 * - El indice es **parcial** (`status <> 'cancelled'`): cancelar libera el
 *   documento, de modo que la persona puede volver a registrarse.
 * - `companions_count` es la unica fuente de verdad del cupo consumido; la fila
 *   de acompanantes es informativa.
 */
export const registrations = sqliteTable(
  'registrations',
  {
    id: idColumn(),
    participationId: text('participation_id')
      .notNull()
      .references(() => eventEstablishments.id, { onDelete: 'restrict' }),
    documentType: text('document_type', { enum: DOCUMENT_TYPES }).notNull(),
    /** Normalizado (sin puntos ni espacios) por el servicio. */
    documentNumber: text('document_number').notNull(),
    fullName: text('full_name').notNull(),
    email: text('email'),
    phone: text('phone'),
    companionsCount: integer('companions_count').notNull().default(0),
    status: text('status', { enum: REGISTRATION_STATUSES }).notNull().default('confirmed'),
    source: text('source', { enum: REGISTRATION_SOURCES }).notNull().default('public'),
    registeredAt: requiredTimestampColumn('registered_at'),
    cancelledAt: timestampColumn('cancelled_at'),
    cancelledReason: text('cancelled_reason'),
    createdAt: createdAtColumn(),
    updatedAt: updatedAtColumn(),
  },
  (table) => [
    uniqueIndex('registrations_participation_document_unique')
      .on(table.participationId, table.documentType, table.documentNumber)
      .where(sql`${table.status} <> 'cancelled'`),
    index('registrations_participation_status_idx').on(table.participationId, table.status),
    index('registrations_document_idx').on(table.documentType, table.documentNumber),
    check('registrations_companions_count_check', sql`${table.companionsCount} >= 0`),
  ],
);

/**
 * Acompanantes declarados por un registro.
 *
 * Se guardan aparte porque su numero es variable y solo el titular recibe QR.
 * `full_name` es obligatorio; el documento es opcional (menores de edad suelen
 * no tenerlo), y cuando existe no puede repetirse dentro del mismo registro.
 */
export const registrationCompanions = sqliteTable(
  'registration_companions',
  {
    id: idColumn(),
    registrationId: text('registration_id')
      .notNull()
      .references(() => registrations.id, { onDelete: 'cascade' }),
    fullName: text('full_name').notNull(),
    documentType: text('document_type', { enum: DOCUMENT_TYPES }),
    documentNumber: text('document_number'),
    createdAt: createdAtColumn(),
    updatedAt: updatedAtColumn(),
  },
  (table) => [
    index('registration_companions_registration_idx').on(table.registrationId),
    uniqueIndex('registration_companions_document_unique')
      .on(table.registrationId, table.documentType, table.documentNumber)
      .where(sql`${table.documentNumber} IS NOT NULL`),
  ],
);

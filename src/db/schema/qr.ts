import { sql } from 'drizzle-orm';
import { index, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';
import { createdAtColumn, idColumn, requiredTimestampColumn, timestampColumn } from './columns';
import { users } from './auth';
import { registrations } from './registrations';

/* ------------------------------------------------------------------ *
 * Codigos QR y auditoria de entregas.
 * ------------------------------------------------------------------ */

export const QR_CODE_STATUSES = ['active', 'revoked'] as const;
export type QrCodeStatus = (typeof QR_CODE_STATUSES)[number];

export const QR_DELIVERY_CHANNELS = ['email', 'whatsapp', 'manual'] as const;
export type QrDeliveryChannel = (typeof QR_DELIVERY_CHANNELS)[number];

export const QR_DELIVERY_STATUSES = ['queued', 'sent', 'failed'] as const;
export type QrDeliveryStatus = (typeof QR_DELIVERY_STATUSES)[number];

/**
 * Codigos QR emitidos.
 *
 * - El contenido del QR es un token aleatorio opaco **sin datos personales**;
 *   aqui solo se guarda su SHA-256. La verificacion en puerta hashea el token
 *   recibido y busca la coincidencia, asi que un volcado de la tabla no permite
 *   fabricar pases.
 * - El indice unico parcial `(registration_id) WHERE status = 'active'`
 *   garantiza **una sola QR activa por registro** (decision de Fase 1) sin
 *   necesidad de bloqueos: la emision hace `INSERT` y, si la QR anterior sigue
 *   activa, falla o se revoca primero.
 * - No se guardan imagenes: el SVG se genera al vuelo a partir del token.
 */
export const qrCodes = sqliteTable(
  'qr_codes',
  {
    id: idColumn(),
    registrationId: text('registration_id')
      .notNull()
      .references(() => registrations.id, { onDelete: 'cascade' }),
    /** SHA-256 (hex) del token impreso en el QR. */
    tokenHash: text('token_hash').notNull(),
    status: text('status', { enum: QR_CODE_STATUSES }).notNull().default('active'),
    issuedAt: requiredTimestampColumn('issued_at'),
    issuedBy: text('issued_by').references(() => users.id, { onDelete: 'set null' }),
    revokedAt: timestampColumn('revoked_at'),
    revokedBy: text('revoked_by').references(() => users.id, { onDelete: 'set null' }),
    revokedReason: text('revoked_reason'),
    createdAt: createdAtColumn(),
  },
  (table) => [
    uniqueIndex('qr_codes_token_hash_unique').on(table.tokenHash),
    uniqueIndex('qr_codes_active_per_registration_unique')
      .on(table.registrationId)
      .where(sql`${table.status} = 'active'`),
    index('qr_codes_registration_idx').on(table.registrationId),
  ],
);

/**
 * Auditoria de entregas del QR.
 *
 * El `EmailSender` inicial es un adaptador no-op; esta tabla deja constancia de
 * que se intento entregar y con que resultado, de modo que conectar un proveedor
 * real no cambie el dominio.
 */
export const qrDeliveries = sqliteTable(
  'qr_deliveries',
  {
    id: idColumn(),
    qrCodeId: text('qr_code_id')
      .notNull()
      .references(() => qrCodes.id, { onDelete: 'cascade' }),
    channel: text('channel', { enum: QR_DELIVERY_CHANNELS }).notNull(),
    /** Destino tal como se envio (email o telefono): dato necesario para auditar la entrega. */
    destination: text('destination').notNull(),
    status: text('status', { enum: QR_DELIVERY_STATUSES }).notNull().default('queued'),
    /** Adaptador usado: `noop` mientras no haya proveedor real. */
    provider: text('provider'),
    attemptedAt: requiredTimestampColumn('attempted_at'),
    sentAt: timestampColumn('sent_at'),
    errorMessage: text('error_message'),
    createdBy: text('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAtColumn(),
  },
  (table) => [
    index('qr_deliveries_qr_code_idx').on(table.qrCodeId),
    index('qr_deliveries_status_attempted_idx').on(table.status, table.attemptedAt),
  ],
);

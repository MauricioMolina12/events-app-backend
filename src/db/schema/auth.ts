import { index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';
import { createdAtColumn, idColumn, requiredTimestampColumn, timestampColumn, updatedAtColumn } from './columns';

/* ------------------------------------------------------------------ *
 * Usuarios y sesiones (Fase 4). El esquema se define ahora para que las
 * migraciones de Fase 4 no reescriban la linea base.
 * ------------------------------------------------------------------ */

export const USER_ROLES = ['admin', 'operator'] as const;
export type UserRole = (typeof USER_ROLES)[number];

export const USER_STATUSES = ['active', 'disabled'] as const;
export type UserStatus = (typeof USER_STATUSES)[number];

/**
 * Usuarios administrativos.
 *
 * La contrasena nunca se almacena: se guardan el derivado PBKDF2-SHA256, el
 * salt por usuario y el numero de iteraciones, de modo que el coste se pueda
 * subir sin invalidar los hashes existentes.
 */
export const users = sqliteTable(
  'users',
  {
    id: idColumn(),
    /** Email normalizado a minusculas; la unicidad es lo que impide duplicados. */
    email: text('email').notNull(),
    fullName: text('full_name').notNull(),
    /** Derivado PBKDF2-SHA256 en base64. Nunca la contrasena en claro. */
    passwordHash: text('password_hash').notNull(),
    passwordSalt: text('password_salt').notNull(),
    passwordIterations: integer('password_iterations').notNull(),
    role: text('role', { enum: USER_ROLES }).notNull().default('operator'),
    status: text('status', { enum: USER_STATUSES }).notNull().default('active'),
    /** Contador de fallos consecutivos; se reinicia al autenticar con exito. */
    failedLoginAttempts: integer('failed_login_attempts').notNull().default(0),
    /** Bloqueo temporal por fuerza bruta (`ACCOUNT_LOCKED`). */
    lockedUntil: timestampColumn('locked_until'),
    lastLoginAt: timestampColumn('last_login_at'),
    createdAt: createdAtColumn(),
    updatedAt: updatedAtColumn(),
  },
  (table) => [
    uniqueIndex('users_email_unique').on(table.email),
    index('users_status_idx').on(table.status),
  ],
);

/**
 * Sesiones activas.
 *
 * Solo se persiste el SHA-256 del token opaco: un volcado de la base de datos no
 * permite suplantar a nadie. La revocacion es inmediata (basta con marcar
 * `revoked_at`).
 */
export const sessions = sqliteTable(
  'sessions',
  {
    id: idColumn(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    tokenHash: text('token_hash').notNull(),
    createdAt: createdAtColumn(),
    expiresAt: requiredTimestampColumn('expires_at'),
    lastUsedAt: timestampColumn('last_used_at'),
    revokedAt: timestampColumn('revoked_at'),
    revokedReason: text('revoked_reason'),
  },
  (table) => [
    uniqueIndex('sessions_token_hash_unique').on(table.tokenHash),
    index('sessions_user_idx').on(table.userId),
    index('sessions_expires_at_idx').on(table.expiresAt),
  ],
);

/**
 * Intentos de autenticacion.
 *
 * Alimenta el bloqueo progresivo. La IP nunca se guarda en claro: se almacena un
 * hash, que basta para correlacionar intentos sin convertirse en dato personal.
 */
export const authAttempts = sqliteTable(
  'auth_attempts',
  {
    id: idColumn(),
    /** Email normalizado sobre el que se intento autenticar. */
    identifier: text('identifier').notNull(),
    succeeded: integer('succeeded', { mode: 'boolean' }).notNull(),
    sourceHash: text('source_hash'),
    attemptedAt: requiredTimestampColumn('attempted_at'),
  },
  (table) => [
    index('auth_attempts_identifier_time_idx').on(table.identifier, table.attemptedAt),
  ],
);

import { sql } from 'drizzle-orm';
import { check, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';
import { users } from './auth';
import { createdAtColumn, idColumn, updatedAtColumn } from './columns';
import { DEFAULT_PRIMARY_COLOR } from './workspace';

/**
 * Un cliente es el espacio de un operador.
 *
 * El correo sigue identificando la cuenta. El slug es publico y no cambia cuando
 * cambia el nombre comercial. Un operador tiene un solo cliente; el administrador
 * no es un cliente y ve todos.
 */

export const CLIENT_STATUSES = ['active', 'disabled'] as const;
export type ClientStatus = (typeof CLIENT_STATUSES)[number];

export const clients = sqliteTable(
  'clients',
  {
    id: idColumn(),
    slug: text('slug').notNull(),
    displayName: text('display_name').notNull(),
    nameCustomized: integer('name_customized', { mode: 'boolean' }).notNull().default(false),
    primaryColor: text('primary_color').notNull().default(DEFAULT_PRIMARY_COLOR),
    colorCustomized: integer('color_customized', { mode: 'boolean' }).notNull().default(false),
    ownerUserId: text('owner_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    status: text('status', { enum: CLIENT_STATUSES }).notNull().default('active'),
    createdAt: createdAtColumn(),
    updatedAt: updatedAtColumn(),
  },
  (table) => [
    uniqueIndex('clients_slug_unique').on(table.slug),
    uniqueIndex('clients_owner_unique').on(table.ownerUserId),
    check('clients_name_check', sql`length(${table.displayName}) BETWEEN 1 AND 80`),
    check(
      'clients_color_check',
      sql`${table.primaryColor} GLOB '#[0-9A-F][0-9A-F][0-9A-F][0-9A-F][0-9A-F][0-9A-F]'`,
    ),
    check('clients_name_flag_check', sql`${table.nameCustomized} IN (0, 1)`),
    check('clients_color_flag_check', sql`${table.colorCustomized} IN (0, 1)`),
    check('clients_status_check', sql`${table.status} IN ('active', 'disabled')`),
  ],
);

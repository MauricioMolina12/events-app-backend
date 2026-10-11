import { sql } from 'drizzle-orm';
import { check, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { users } from './auth';
import { createdAtColumn, updatedAtColumn } from './columns';

/**
 * Identidad compartida del unico espacio de trabajo de este despliegue.
 *
 * No hay organizaciones ni tenants: una fila (`id = 'default'`) guarda el nombre,
 * el color y las claves de los logotipos. El archivo vive en R2; aqui solo queda
 * la referencia. El tema claro/oscuro no va en esta tabla: es una preferencia
 * personal (`user_preferences`).
 */

export const THEME_PREFERENCES = ['light', 'dark', 'system'] as const;
export type ThemePreference = (typeof THEME_PREFERENCES)[number];

export const WORKSPACE_SETTINGS_ID = 'default';
export const DEFAULT_PRIMARY_COLOR = '#C81F68';
export const DEFAULT_WORKSPACE_NAME = 'Eventos Barby Toys & Cupidos';

export const workspaceSettings = sqliteTable(
  'workspace_settings',
  {
    id: text('id').primaryKey(),
    displayName: text('display_name').notNull(),
    /** `false` mientras el nombre sea el sugerido; un guardado manual lo deja en `true`. */
    nameCustomized: integer('name_customized', { mode: 'boolean' }).notNull().default(false),
    description: text('description'),
    logoKey: text('logo_key'),
    logoContentType: text('logo_content_type'),
    markKey: text('mark_key'),
    markContentType: text('mark_content_type'),
    primaryColor: text('primary_color').notNull().default(DEFAULT_PRIMARY_COLOR),
    /** `false` conserva la paleta del sistema de diseno; `true` aplica el hex guardado. */
    colorCustomized: integer('color_customized', { mode: 'boolean' }).notNull().default(false),
    createdAt: createdAtColumn(),
    updatedAt: updatedAtColumn(),
    updatedBy: text('updated_by').references(() => users.id, { onDelete: 'set null' }),
  },
  (table) => [
    check('workspace_settings_id_check', sql`${table.id} = 'default'`),
    check(
      'workspace_settings_name_check',
      sql`length(${table.displayName}) BETWEEN 1 AND 80`,
    ),
    check(
      'workspace_settings_description_check',
      sql`${table.description} IS NULL OR length(${table.description}) <= 280`,
    ),
    check(
      'workspace_settings_color_check',
      sql`${table.primaryColor} GLOB '#[0-9A-F][0-9A-F][0-9A-F][0-9A-F][0-9A-F][0-9A-F]'`,
    ),
  ],
);

export const userPreferences = sqliteTable(
  'user_preferences',
  {
    userId: text('user_id')
      .primaryKey()
      .references(() => users.id, { onDelete: 'cascade' }),
    theme: text('theme', { enum: THEME_PREFERENCES }).notNull().default('system'),
    updatedAt: updatedAtColumn(),
  },
  (table) => [
    check(
      'user_preferences_theme_check',
      sql`${table.theme} IN ('light', 'dark', 'system')`,
    ),
  ],
);

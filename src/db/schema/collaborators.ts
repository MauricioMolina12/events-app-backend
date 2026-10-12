import { index, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';
import { users } from './auth';
import { clients } from './clients';
import { createdAtColumn, idColumn, updatedAtColumn } from './columns';

/**
 * Grupos de colaboradores de un cliente.
 *
 * Todos los miembros de un grupo comparten los mismos modulos. El dueno del
 * cliente no vive aqui: es `clients.owner_user_id`.
 */
export const collaboratorGroups = sqliteTable(
  'collaborator_groups',
  {
    id: idColumn(),
    clientId: text('client_id')
      .notNull()
      .references(() => clients.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    /** JSON: lista de modulos (`dashboard`, `mesa`, `ingreso`, …). */
    modules: text('modules').notNull().default('[]'),
    createdAt: createdAtColumn(),
    updatedAt: updatedAtColumn(),
  },
  (table) => [
    index('collaborator_groups_client_idx').on(table.clientId),
  ],
);

export const collaboratorMembers = sqliteTable(
  'collaborator_members',
  {
    id: idColumn(),
    groupId: text('group_id')
      .notNull()
      .references(() => collaboratorGroups.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    createdAt: createdAtColumn(),
    updatedAt: updatedAtColumn(),
  },
  (table) => [
    uniqueIndex('collaborator_members_user_unique').on(table.userId),
    index('collaborator_members_group_idx').on(table.groupId),
  ],
);

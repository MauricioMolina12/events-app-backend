import { asc, eq } from 'drizzle-orm';
import type { Database } from '../../db/client';
import {
  DEFAULT_PRIMARY_COLOR,
  DEFAULT_WORKSPACE_NAME,
  THEME_PREFERENCES,
  WORKSPACE_SETTINGS_ID,
  userPreferences,
  users,
  workspaceSettings,
  type ThemePreference,
} from '../../db/schema';
import { displayNameFromEmail } from './display-name';

export type WorkspaceRow = typeof workspaceSettings.$inferSelect;

export interface WorkspacePatch {
  readonly displayName?: string;
  readonly description?: string | null;
  readonly primaryColor?: string;
  readonly nameCustomized?: boolean;
  readonly colorCustomized?: boolean;
  readonly logoKey?: string | null;
  readonly logoContentType?: string | null;
  readonly markKey?: string | null;
  readonly markContentType?: string | null;
}

export async function findWorkspace(db: Database): Promise<WorkspaceRow | undefined> {
  const [row] = await db
    .select()
    .from(workspaceSettings)
    .where(eq(workspaceSettings.id, WORKSPACE_SETTINGS_ID))
    .limit(1);
  return row;
}

/**
 * Crea la fila unica la primera vez.
 *
 * El nombre sale del correo del primer administrador y queda congelado: un
 * ingreso posterior no lo vuelve a calcular.
 */
export async function ensureWorkspace(db: Database, now: Date): Promise<WorkspaceRow> {
  const existing = await findWorkspace(db);
  if (existing) {
    return existing;
  }

  const owner = await findOwnerEmail(db);
  await db
    .insert(workspaceSettings)
    .values({
      id: WORKSPACE_SETTINGS_ID,
      displayName: owner ? displayNameFromEmail(owner) : DEFAULT_WORKSPACE_NAME,
      nameCustomized: false,
      description: null,
      logoKey: null,
      logoContentType: null,
      markKey: null,
      markContentType: null,
      primaryColor: DEFAULT_PRIMARY_COLOR,
      colorCustomized: false,
      createdAt: now,
      updatedAt: now,
      updatedBy: null,
    })
    .onConflictDoNothing();

  const created = await findWorkspace(db);
  if (!created) {
    throw new Error('No se pudo crear la configuracion del espacio.');
  }
  return created;
}

export async function updateWorkspace(
  db: Database,
  patch: WorkspacePatch,
  actorId: string | null,
  now: Date,
): Promise<WorkspaceRow> {
  await ensureWorkspace(db, now);
  await db
    .update(workspaceSettings)
    .set({
      ...patch,
      updatedAt: now,
      updatedBy: actorId,
    })
    .where(eq(workspaceSettings.id, WORKSPACE_SETTINGS_ID));

  const updated = await findWorkspace(db);
  if (!updated) {
    throw new Error('No se pudo leer la configuracion del espacio.');
  }
  return updated;
}

export async function findThemePreference(
  db: Database,
  userId: string,
): Promise<ThemePreference | null> {
  const [row] = await db
    .select({ theme: userPreferences.theme })
    .from(userPreferences)
    .where(eq(userPreferences.userId, userId))
    .limit(1);
  return row?.theme ?? null;
}

export async function saveThemePreference(
  db: Database,
  userId: string,
  theme: ThemePreference,
  now: Date,
): Promise<ThemePreference> {
  if (!THEME_PREFERENCES.includes(theme)) {
    throw new Error('Tema fuera del catalogo.');
  }
  await db
    .insert(userPreferences)
    .values({ userId, theme, updatedAt: now })
    .onConflictDoUpdate({
      target: userPreferences.userId,
      set: { theme, updatedAt: now },
    });
  return theme;
}

/** Primer administrador creado; si no hay, el usuario mas antiguo. */
export async function findOwnerEmail(db: Database): Promise<string | null> {
  const [admin] = await db
    .select({ email: users.email })
    .from(users)
    .where(eq(users.role, 'admin'))
    .orderBy(asc(users.createdAt))
    .limit(1);
  if (admin) {
    return admin.email;
  }
  const [anyone] = await db
    .select({ email: users.email })
    .from(users)
    .orderBy(asc(users.createdAt))
    .limit(1);
  return anyone?.email ?? null;
}

import { and, eq } from 'drizzle-orm';
import { AppError } from '../../core/errors/app-error';
import { ErrorCode } from '../../core/errors/error-codes';
import type { Database } from '../../db/client';
import { newId } from '../../db/helpers';
import { collaboratorGroups, collaboratorMembers, clients } from '../../db/schema';
import { findClientByOwner } from '../clients/clients.repository';
import { createUser } from '../users/users.service';
import type { AuthConfig } from '../../config/env';
import { findUserById } from '../users/users.repository';

export const PANEL_MODULES = [
  'dashboard',
  'mesa',
  'ingreso',
  'eventos',
  'sedes',
  'cupos',
  'configuracion',
  'colaboradores',
] as const;

export type PanelModule = (typeof PANEL_MODULES)[number];

export const OWNER_MODULES: readonly PanelModule[] = PANEL_MODULES;

export interface CollaboratorGroupView {
  readonly id: string;
  readonly name: string;
  readonly modules: readonly PanelModule[];
  readonly members: readonly CollaboratorMemberView[];
}

export interface CollaboratorMemberView {
  readonly id: string;
  readonly userId: string;
  readonly email: string;
  readonly fullName: string;
  readonly status: 'active' | 'disabled';
}

export interface AccessContext {
  readonly clientId: string | null;
  readonly owner: boolean;
  readonly modules: readonly PanelModule[];
}

function parseModules(raw: string): PanelModule[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed.filter((item): item is PanelModule =>
      PANEL_MODULES.includes(item as PanelModule),
    );
  } catch {
    return [];
  }
}

export async function resolveAccess(db: Database, userId: string, role: string): Promise<AccessContext> {
  if (role === 'admin') {
    return { clientId: null, owner: true, modules: OWNER_MODULES };
  }
  const owned = await findClientByOwner(db, userId);
  if (owned) {
    return { clientId: owned.id, owner: true, modules: OWNER_MODULES };
  }
  const membership = await findMembership(db, userId);
  if (!membership) {
    return { clientId: null, owner: false, modules: OWNER_MODULES };
  }
  return {
    clientId: membership.clientId,
    owner: false,
    modules: parseModules(membership.modules),
  };
}

export async function findMembership(
  db: Database,
  userId: string,
): Promise<{ clientId: string; groupId: string; modules: string } | null> {
  const [row] = await db
    .select({
      clientId: collaboratorGroups.clientId,
      groupId: collaboratorGroups.id,
      modules: collaboratorGroups.modules,
    })
    .from(collaboratorMembers)
    .innerJoin(collaboratorGroups, eq(collaboratorGroups.id, collaboratorMembers.groupId))
    .where(eq(collaboratorMembers.userId, userId))
    .limit(1);
  return row ?? null;
}

export async function getClientForActor(db: Database, userId: string) {
  const owned = await findClientByOwner(db, userId);
  if (owned) {
    return owned;
  }
  const membership = await findMembership(db, userId);
  if (!membership) {
    throw AppError.notFound(ErrorCode.NOT_FOUND, 'Este usuario no tiene un espacio de cliente.');
  }
  const [client] = await db.select().from(clients).where(eq(clients.id, membership.clientId)).limit(1);
  if (!client) {
    throw AppError.notFound(ErrorCode.NOT_FOUND, 'Este usuario no tiene un espacio de cliente.');
  }
  return client;
}

export async function listGroups(db: Database, clientId: string): Promise<CollaboratorGroupView[]> {
  const groups = await db
    .select()
    .from(collaboratorGroups)
    .where(eq(collaboratorGroups.clientId, clientId));
  const views: CollaboratorGroupView[] = [];
  for (const group of groups) {
    views.push(await presentGroup(db, group));
  }
  return views;
}

export async function createGroup(
  db: Database,
  clientId: string,
  input: { name: string; modules: readonly string[] },
  now: Date = new Date(),
): Promise<CollaboratorGroupView> {
  const name = input.name.trim();
  if (name.length < 2 || name.length > 80) {
    throw AppError.unprocessable(ErrorCode.VALIDATION_ERROR, 'El nombre del grupo no es valido.');
  }
  const [row] = await db
    .insert(collaboratorGroups)
    .values({
      id: newId(),
      clientId,
      name,
      modules: JSON.stringify(sanitizeModules(input.modules)),
      createdAt: now,
      updatedAt: now,
    })
    .returning();
  if (!row) {
    throw new Error('No se pudo crear el grupo.');
  }
  return presentGroup(db, row);
}

export async function updateGroup(
  db: Database,
  clientId: string,
  groupId: string,
  input: { name?: string; modules?: readonly string[] },
  now: Date = new Date(),
): Promise<CollaboratorGroupView> {
  const current = await getGroup(db, clientId, groupId);
  const [row] = await db
    .update(collaboratorGroups)
    .set({
      name: input.name?.trim() ?? current.name,
      modules:
        input.modules === undefined ? current.modules : JSON.stringify(sanitizeModules(input.modules)),
      updatedAt: now,
    })
    .where(and(eq(collaboratorGroups.id, groupId), eq(collaboratorGroups.clientId, clientId)))
    .returning();
  if (!row) {
    throw AppError.notFound(ErrorCode.NOT_FOUND, 'El grupo no existe.');
  }
  return presentGroup(db, row);
}

export async function addMember(
  db: Database,
  clientId: string,
  groupId: string,
  input: { email: string; fullName: string; password: string },
  config: AuthConfig,
  now: Date = new Date(),
): Promise<CollaboratorMemberView> {
  await getGroup(db, clientId, groupId);
  const user = await createUser(
    db,
    {
      email: input.email,
      fullName: input.fullName,
      password: input.password,
      role: 'operator',
      skipClient: true,
    },
    config,
    now,
  );
  const [member] = await db
    .insert(collaboratorMembers)
    .values({
      id: newId(),
      groupId,
      userId: user.id,
      createdAt: now,
      updatedAt: now,
    })
    .returning();
  if (!member) {
    throw new Error('No se pudo agregar el colaborador.');
  }
  return {
    id: member.id,
    userId: user.id,
    email: user.email,
    fullName: user.fullName,
    status: user.status,
  };
}

async function getGroup(db: Database, clientId: string, groupId: string) {
  const [row] = await db
    .select()
    .from(collaboratorGroups)
    .where(and(eq(collaboratorGroups.id, groupId), eq(collaboratorGroups.clientId, clientId)))
    .limit(1);
  if (!row) {
    throw AppError.notFound(ErrorCode.NOT_FOUND, 'El grupo no existe.');
  }
  return row;
}

async function presentGroup(
  db: Database,
  group: typeof collaboratorGroups.$inferSelect,
): Promise<CollaboratorGroupView> {
  const members = await db
    .select()
    .from(collaboratorMembers)
    .where(eq(collaboratorMembers.groupId, group.id));
  const people: CollaboratorMemberView[] = [];
  for (const member of members) {
    const user = await findUserById(db, member.userId);
    if (!user) {
      continue;
    }
    people.push({
      id: member.id,
      userId: user.id,
      email: user.email,
      fullName: user.fullName,
      status: user.status,
    });
  }
  return {
    id: group.id,
    name: group.name,
    modules: parseModules(group.modules),
    members: people,
  };
}

function sanitizeModules(modules: readonly string[]): PanelModule[] {
  return [...new Set(modules.filter((item): item is PanelModule => PANEL_MODULES.includes(item as PanelModule)))];
}

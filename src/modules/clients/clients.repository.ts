import { eq } from 'drizzle-orm';
import type { Database } from '../../db/client';
import { withConstraintTranslation } from '../../db/constraints';
import { newId } from '../../db/helpers';
import { clients, type ClientStatus } from '../../db/schema';
import { DEFAULT_PRIMARY_COLOR } from '../../db/schema/workspace';

export type ClientRow = typeof clients.$inferSelect;

export interface InsertClientInput {
  readonly slug: string;
  readonly displayName: string;
  readonly nameCustomized: boolean;
  readonly primaryColor?: string;
  readonly colorCustomized?: boolean;
  readonly ownerUserId: string;
  readonly status?: ClientStatus;
}

export async function findClientByOwner(db: Database, ownerUserId: string): Promise<ClientRow | null> {
  const [row] = await db.select().from(clients).where(eq(clients.ownerUserId, ownerUserId)).limit(1);
  return row ?? null;
}

export async function findClientBySlug(db: Database, slug: string): Promise<ClientRow | null> {
  const [row] = await db.select().from(clients).where(eq(clients.slug, slug)).limit(1);
  return row ?? null;
}

export async function findClientById(db: Database, id: string): Promise<ClientRow | null> {
  const [row] = await db.select().from(clients).where(eq(clients.id, id)).limit(1);
  return row ?? null;
}

export async function listClients(db: Database): Promise<ClientRow[]> {
  return db.select().from(clients).orderBy(clients.displayName);
}

export async function countActiveClients(db: Database): Promise<number> {
  const rows = await db.select({ id: clients.id }).from(clients).where(eq(clients.status, 'active'));
  return rows.length;
}

export async function insertClient(
  db: Database,
  input: InsertClientInput,
  now: Date = new Date(),
): Promise<ClientRow> {
  return withConstraintTranslation(async () => {
    const [row] = await db
      .insert(clients)
      .values({
        id: newId(),
        slug: input.slug,
        displayName: input.displayName,
        nameCustomized: input.nameCustomized,
        primaryColor: input.primaryColor ?? DEFAULT_PRIMARY_COLOR,
        colorCustomized: input.colorCustomized ?? false,
        ownerUserId: input.ownerUserId,
        status: input.status ?? 'active',
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    if (row === undefined) {
      throw new Error('El INSERT del cliente no devolvio ninguna fila.');
    }
    return row;
  });
}

export async function updateClient(
  db: Database,
  id: string,
  patch: Partial<Pick<ClientRow, 'displayName' | 'nameCustomized' | 'primaryColor' | 'colorCustomized' | 'status'>>,
  now: Date,
): Promise<ClientRow | null> {
  const [row] = await db
    .update(clients)
    .set({ ...patch, updatedAt: now })
    .where(eq(clients.id, id))
    .returning();
  return row ?? null;
}

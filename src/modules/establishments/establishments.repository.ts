import { and, asc, eq, type SQL } from 'drizzle-orm';
import type { Database } from '../../db/client';
import { withConstraintTranslation } from '../../db/constraints';
import { newId } from '../../db/helpers';
import { establishments, type EstablishmentStatus } from '../../db/schema';

/**
 * Repositorio de establecimientos (sedes).
 *
 * `code` es el identificador corto de operacion; la unicidad la garantiza el
 * indice `establishments_code_unique`, traducida por `constraints.ts`.
 */

export type EstablishmentRow = typeof establishments.$inferSelect;

export interface CreateEstablishmentInput {
  code: string;
  name: string;
  city?: string | null;
  address?: string | null;
  status?: EstablishmentStatus;
}

export type UpdateEstablishmentInput = Partial<Omit<CreateEstablishmentInput, 'code'>>;

export interface ListEstablishmentsOptions {
  status?: EstablishmentStatus;
}

export async function findEstablishmentById(
  db: Database,
  id: string,
): Promise<EstablishmentRow | null> {
  const [row] = await db.select().from(establishments).where(eq(establishments.id, id)).limit(1);
  return row ?? null;
}

export async function findEstablishmentByCode(
  db: Database,
  code: string,
): Promise<EstablishmentRow | null> {
  const [row] = await db
    .select()
    .from(establishments)
    .where(eq(establishments.code, code))
    .limit(1);
  return row ?? null;
}

export async function listEstablishments(
  db: Database,
  options: ListEstablishmentsOptions = {},
): Promise<EstablishmentRow[]> {
  const filters: SQL[] = [];
  if (options.status !== undefined) {
    filters.push(eq(establishments.status, options.status));
  }

  return db
    .select()
    .from(establishments)
    .where(filters.length > 0 ? and(...filters) : undefined)
    .orderBy(asc(establishments.name));
}

export async function insertEstablishment(
  db: Database,
  input: CreateEstablishmentInput,
  now: Date = new Date(),
): Promise<EstablishmentRow> {
  return withConstraintTranslation(async () => {
    const [row] = await db
      .insert(establishments)
      .values({
        id: newId(),
        code: input.code,
        name: input.name,
        city: input.city ?? null,
        address: input.address ?? null,
        status: input.status ?? 'active',
        createdAt: now,
        updatedAt: now,
      })
      .returning();

    if (row === undefined) {
      throw new Error('El INSERT del establecimiento no devolvio ninguna fila.');
    }
    return row;
  });
}

/** Actualiza los campos indicados; devuelve `null` si la sede no existe. */
export async function updateEstablishment(
  db: Database,
  id: string,
  changes: UpdateEstablishmentInput,
  now: Date = new Date(),
): Promise<EstablishmentRow | null> {
  const [row] = await db
    .update(establishments)
    .set({ ...changes, updatedAt: now })
    .where(eq(establishments.id, id))
    .returning();
  return row ?? null;
}

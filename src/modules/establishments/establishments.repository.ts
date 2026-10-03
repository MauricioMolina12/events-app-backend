import { and, asc, count, eq, inArray, or, sql, type SQL } from 'drizzle-orm';
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

/** Filtros del catalogo de sedes. */
export interface EstablishmentFilters {
  readonly status?: EstablishmentStatus;
  /** Texto libre buscado en codigo, nombre y ciudad, sin distinguir mayusculas. */
  readonly search?: string;
}

export interface ListEstablishmentsOptions extends EstablishmentFilters {
  limit?: number;
  offset?: number;
}

/** Limite por defecto de los listados; igual que el del catalogo de eventos. */
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

/**
 * Condiciones compartidas por el listado y su conteo.
 *
 * Un unico lugar para calcularlas evita que `meta.total` deje de corresponder con
 * las filas devueltas.
 */
function filterConditions(filters: EstablishmentFilters): SQL[] {
  const conditions: SQL[] = [];

  if (filters.status !== undefined) {
    conditions.push(eq(establishments.status, filters.status));
  }

  const search = filters.search?.trim().toLowerCase();
  if (search !== undefined && search !== '') {
    // `instr` en lugar de `LIKE`: evita escapar los comodines `%` y `_` del texto.
    const matching = or(
      sql`instr(lower(${establishments.code}), ${search}) > 0`,
      sql`instr(lower(${establishments.name}), ${search}) > 0`,
      sql`instr(lower(coalesce(${establishments.city}, '')), ${search}) > 0`,
    );
    if (matching !== undefined) {
      conditions.push(matching);
    }
  }

  return conditions;
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
  const limit = Math.min(options.limit ?? DEFAULT_LIMIT, MAX_LIMIT);
  const conditions = filterConditions(options);

  return db
    .select()
    .from(establishments)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(asc(establishments.name))
    .limit(limit)
    .offset(options.offset ?? 0);
}

/** Cuenta las sedes que cumplen los mismos filtros que `listEstablishments`. */
export async function countEstablishments(
  db: Database,
  filters: EstablishmentFilters = {},
): Promise<number> {
  const conditions = filterConditions(filters);
  const [row] = await db
    .select({ total: count() })
    .from(establishments)
    .where(conditions.length > 0 ? and(...conditions) : undefined);

  return row?.total ?? 0;
}

/**
 * Recupera varias sedes por identificador.
 *
 * Lo consume el catalogo de participaciones para resolver la sede de cada fila
 * sin que su repositorio consulte otra tabla. `ids` se corta a 100 entradas: es el
 * tope de parametros por consulta de D1 (un evento no llega a tantas sedes).
 */
export async function listEstablishmentsByIds(
  db: Database,
  ids: readonly string[],
): Promise<EstablishmentRow[]> {
  if (ids.length === 0) {
    return [];
  }

  return db
    .select()
    .from(establishments)
    .where(inArray(establishments.id, [...ids].slice(0, 100)));
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

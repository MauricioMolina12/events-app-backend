import { and, count, desc, eq, or, sql, type SQL } from 'drizzle-orm';
import type { Database } from '../../db/client';
import { withConstraintTranslation } from '../../db/constraints';
import { newId } from '../../db/helpers';
import { users, type UserRole, type UserStatus } from '../../db/schema';
import type { PasswordDigest } from '../auth/password';

/**
 * Repositorio de usuarios.
 *
 * Unico punto del proyecto que emite SQL sobre `users`: el modulo de auth lo usa
 * para autenticar (buscar por email, registrar la racha de fallos) y el modulo de
 * usuarios para administrar cuentas. No conoce Hono ni tipos HTTP: recibe y
 * devuelve filas de Drizzle, y el texto de las restricciones lo traduce
 * `constraints.ts`.
 */

export type UserRow = typeof users.$inferSelect;

export interface CreateUserInput extends PasswordDigest {
  email: string;
  fullName: string;
  role?: UserRole;
  status?: UserStatus;
}

/** Estado de bloqueo calculado por el servicio al fallar un login. */
export interface LoginFailureState {
  /** Fallos consecutivos de la racha actual. */
  failedLoginAttempts: number;
  /** `null` cuando el fallo no alcanzo el umbral de bloqueo. */
  lockedUntil: Date | null;
}

/** Filtros del listado administrativo. */
export interface UserFilters {
  readonly role?: UserRole;
  readonly status?: UserStatus;
  /** Texto libre buscado en email y nombre, sin distinguir mayusculas. */
  readonly search?: string;
}

export interface UserListOptions extends UserFilters {
  readonly limit: number;
  readonly offset: number;
}

/** Campos que el modulo de usuarios puede modificar de una cuenta. */
export interface UserProfileChanges {
  readonly email?: string;
  readonly fullName?: string;
  readonly role?: UserRole;
  readonly status?: UserStatus;
}

/**
 * Condiciones compartidas por el listado y su conteo.
 *
 * Deben calcularse en un unico lugar: si divergieran, `meta.total` dejaria de
 * corresponder con las filas devueltas.
 */
function filterConditions(filters: UserFilters): SQL[] {
  const conditions: SQL[] = [];

  if (filters.role !== undefined) {
    conditions.push(eq(users.role, filters.role));
  }
  if (filters.status !== undefined) {
    conditions.push(eq(users.status, filters.status));
  }

  const search = filters.search?.trim().toLowerCase();
  if (search !== undefined && search !== '') {
    // `instr` en lugar de `LIKE`: el texto del administrador puede contener `%`
    // o `_`, que en `LIKE` son comodines y exigirian escapar el patron.
    const matching = or(
      sql`instr(lower(${users.email}), ${search}) > 0`,
      sql`instr(lower(${users.fullName}), ${search}) > 0`,
    );
    if (matching !== undefined) {
      conditions.push(matching);
    }
  }

  return conditions;
}

export async function findUserById(db: Database, id: string): Promise<UserRow | null> {
  const [row] = await db.select().from(users).where(eq(users.id, id)).limit(1);
  return row ?? null;
}

/** Busca por email; el email debe llegar ya normalizado (`normalizeEmail`). */
export async function findUserByEmail(db: Database, email: string): Promise<UserRow | null> {
  const [row] = await db.select().from(users).where(eq(users.email, email)).limit(1);
  return row ?? null;
}

/**
 * Inserta un usuario.
 *
 * El email duplicado lo traduce `users_email_unique` a `EMAIL_ALREADY_USED`: no
 * se consulta antes, porque esa comprobacion seria una carrera.
 */
export async function insertUser(
  db: Database,
  input: CreateUserInput,
  now: Date = new Date(),
): Promise<UserRow> {
  return withConstraintTranslation(async () => {
    const [row] = await db
      .insert(users)
      .values({
        id: newId(),
        email: input.email,
        fullName: input.fullName,
        passwordHash: input.hash,
        passwordSalt: input.salt,
        passwordIterations: input.iterations,
        role: input.role ?? 'operator',
        status: input.status ?? 'active',
        failedLoginAttempts: 0,
        lockedUntil: null,
        lastLoginAt: null,
        createdAt: now,
        updatedAt: now,
      })
      .returning();

    if (row === undefined) {
      throw new Error('El INSERT del usuario no devolvio ninguna fila.');
    }
    return row;
  });
}

/**
 * Listado administrativo, ordenado por alta descendente.
 *
 * El orden incluye `id` como desempate: dos usuarios creados en el mismo
 * milisegundo no deben intercambiar posicion entre paginas.
 */
export async function listUsers(db: Database, options: UserListOptions): Promise<UserRow[]> {
  const conditions = filterConditions(options);

  return db
    .select()
    .from(users)
    .where(conditions.length === 0 ? undefined : and(...conditions))
    .orderBy(desc(users.createdAt), desc(users.id))
    .limit(options.limit)
    .offset(options.offset);
}

/** Total de filas que cumplen los filtros; alimenta `meta.total`. */
export async function countUsers(db: Database, filters: UserFilters = {}): Promise<number> {
  const conditions = filterConditions(filters);
  const [row] = await db
    .select({ total: count() })
    .from(users)
    .where(conditions.length === 0 ? undefined : and(...conditions));

  return row?.total ?? 0;
}

/**
 * Administradores activos.
 *
 * Es la comprobacion que evita que el sistema se quede sin nadie que pueda
 * administrarlo (`LAST_ADMIN_PROTECTED`).
 */
export async function countActiveAdmins(db: Database): Promise<number> {
  const [row] = await db
    .select({ total: count() })
    .from(users)
    .where(and(eq(users.role, 'admin'), eq(users.status, 'active')));

  return row?.total ?? 0;
}

/**
 * Actualiza los campos de perfil indicados.
 *
 * Solo se escriben las claves presentes en `changes`: un `undefined` no debe
 * traducirse en `NULL` sobre una columna obligatoria. Devuelve `null` si el
 * usuario desaparecio entre la lectura y la escritura.
 */
export async function updateUserProfile(
  db: Database,
  id: string,
  changes: UserProfileChanges,
  now: Date = new Date(),
): Promise<UserRow | null> {
  const values: Partial<typeof users.$inferInsert> = { updatedAt: now };

  if (changes.email !== undefined) {
    values.email = changes.email;
  }
  if (changes.fullName !== undefined) {
    values.fullName = changes.fullName;
  }
  if (changes.role !== undefined) {
    values.role = changes.role;
  }
  if (changes.status !== undefined) {
    values.status = changes.status;
  }

  return withConstraintTranslation(async () => {
    const [row] = await db.update(users).set(values).where(eq(users.id, id)).returning();
    return row ?? null;
  });
}

/** Rota el digest de la contrasena; no toca el estado de bloqueo. */
export async function updateUserPassword(
  db: Database,
  id: string,
  digest: PasswordDigest,
  now: Date = new Date(),
): Promise<UserRow | null> {
  const [row] = await db
    .update(users)
    .set({
      passwordHash: digest.hash,
      passwordSalt: digest.salt,
      passwordIterations: digest.iterations,
      updatedAt: now,
    })
    .where(eq(users.id, id))
    .returning();
  return row ?? null;
}

/** Persiste el resultado de un login fallido (racha y bloqueo). */
export async function updateUserLoginFailure(
  db: Database,
  id: string,
  state: LoginFailureState,
  now: Date = new Date(),
): Promise<UserRow | null> {
  const [row] = await db
    .update(users)
    .set({
      failedLoginAttempts: state.failedLoginAttempts,
      lockedUntil: state.lockedUntil,
      updatedAt: now,
    })
    .where(eq(users.id, id))
    .returning();
  return row ?? null;
}

/** Reinicia la racha de fallos y registra el ultimo acceso correcto. */
export async function updateUserLoginSuccess(
  db: Database,
  id: string,
  now: Date = new Date(),
): Promise<UserRow | null> {
  const [row] = await db
    .update(users)
    .set({
      failedLoginAttempts: 0,
      lockedUntil: null,
      lastLoginAt: now,
      updatedAt: now,
    })
    .where(eq(users.id, id))
    .returning();
  return row ?? null;
}

/**
 * Levanta el bloqueo por intentos fallidos.
 *
 * Acompana a la rotacion de contrasena: quien la olvido suele haber agotado los
 * intentos antes de pedir ayuda, y el bloqueo le impediria entrar con la
 * contrasena nueva.
 */
export async function clearUserLockout(
  db: Database,
  id: string,
  now: Date = new Date(),
): Promise<UserRow | null> {
  const [row] = await db
    .update(users)
    .set({ failedLoginAttempts: 0, lockedUntil: null, updatedAt: now })
    .where(eq(users.id, id))
    .returning();
  return row ?? null;
}

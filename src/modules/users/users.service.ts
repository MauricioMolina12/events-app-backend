import type { AuthConfig } from '../../config/env';
import { AppError } from '../../core/errors/app-error';
import { ErrorCode } from '../../core/errors/error-codes';
import type { Database } from '../../db/client';
import type { UserRole, UserStatus } from '../../db/schema';
import { normalizeEmail, revokeAllSessions } from '../auth/auth.service';
import { hashPassword } from '../auth/password';
import {
  clearUserLockout,
  countActiveAdmins,
  countUsers,
  findUserById,
  insertUser,
  listUsers,
  updateUserPassword,
  updateUserProfile,
  type UserFilters,
  type UserProfileChanges,
  type UserRow,
} from './users.repository';

/**
 * Reglas de administracion de cuentas.
 *
 * El servicio no conoce Hono: recibe la conexion, un reloj inyectable y comandos
 * ya validados, y responde con filas o con `AppError`. Las cookies, los estados
 * HTTP y el guard de rol los pone la capa de rutas.
 */

/** Longitud minima de una contrasena nueva. */
export const PASSWORD_MIN_LENGTH = 12;
/** Tope alineado con el del login, que rechaza contrasenas mas largas. */
export const PASSWORD_MAX_LENGTH = 200;
export const USER_LIST_DEFAULT_LIMIT = 20;
export const USER_LIST_MAX_LIMIT = 100;

export interface CreateUserCommand {
  readonly email: string;
  readonly fullName: string;
  readonly password: string;
  readonly role?: UserRole;
  readonly status?: UserStatus;
}

export interface UpdateUserCommand {
  readonly email?: string;
  readonly fullName?: string;
  readonly role?: UserRole;
  readonly status?: UserStatus;
}

export interface UserListQuery extends UserFilters {
  readonly limit?: number;
  readonly offset?: number;
}

export interface UserPage {
  readonly items: readonly UserRow[];
  readonly total: number;
  /** Tamano de pagina realmente aplicado, tras acotar el solicitado. */
  readonly limit: number;
  readonly offset: number;
}

export interface PasswordResetResult {
  readonly user: UserRow;
  readonly revokedSessions: number;
}

/**
 * Comprueba la politica de contrasenas.
 *
 * Vive en el servicio, y no solo en el esquema Zod de la ruta, porque el comando
 * de bootstrap que crea al primer administrador no pasa por HTTP.
 */
export function validatePassword(password: string): void {
  if (password.length < PASSWORD_MIN_LENGTH) {
    throw AppError.unprocessable(
      ErrorCode.VALIDATION_ERROR,
      `La contrasena debe tener al menos ${PASSWORD_MIN_LENGTH} caracteres.`,
      { details: { field: 'password', minLength: PASSWORD_MIN_LENGTH } },
    );
  }

  if (password.length > PASSWORD_MAX_LENGTH) {
    throw AppError.unprocessable(
      ErrorCode.VALIDATION_ERROR,
      `La contrasena no puede superar ${PASSWORD_MAX_LENGTH} caracteres.`,
      { details: { field: 'password', maxLength: PASSWORD_MAX_LENGTH } },
    );
  }
}

/**
 * Listado paginado de cuentas.
 *
 * El listado y su conteo se calculan con los mismos filtros para que
 * `meta.total` corresponda con lo que el cliente puede recorrer.
 */
export async function listUserAccounts(
  db: Database,
  query: UserListQuery = {},
): Promise<UserPage> {
  const limit = clampLimit(query.limit);
  const offset = Math.max(query.offset ?? 0, 0);
  const filters: UserFilters = { role: query.role, status: query.status, search: query.search };

  const [items, total] = await Promise.all([
    listUsers(db, { ...filters, limit, offset }),
    countUsers(db, filters),
  ]);

  return { items, total, limit, offset };
}

/** Devuelve la cuenta indicada o lanza `USER_NOT_FOUND`. */
export async function getUserById(db: Database, id: string): Promise<UserRow> {
  const user = await findUserById(db, id);
  if (user === null) {
    throw userNotFound(id);
  }
  return user;
}

/** Acota el tamano de pagina: un `limit` sin tope agotaria las filas de D1. */
function clampLimit(limit: number | undefined): number {
  if (limit === undefined) {
    return USER_LIST_DEFAULT_LIMIT;
  }
  return Math.min(Math.max(limit, 1), USER_LIST_MAX_LIMIT);
}

function userNotFound(id: string): AppError {
  return AppError.notFound(ErrorCode.USER_NOT_FOUND, 'El usuario no existe.', {
    details: { id },
  });
}

/**
 * Crea una cuenta con el digest derivado en el momento.
 *
 * No se comprueba antes si el email existe: la unicidad la garantiza el indice
 * `users_email_unique`, cuya violacion traduce `constraints.ts` a
 * `EMAIL_ALREADY_USED`. Consultar primero seria una carrera.
 */
export async function createUser(
  db: Database,
  command: CreateUserCommand,
  config: AuthConfig,
  now: Date = new Date(),
): Promise<UserRow> {
  validatePassword(command.password);
  const digest = await hashPassword(command.password, { iterations: config.pbkdf2Iterations });

  return insertUser(
    db,
    {
      email: normalizeEmail(command.email),
      fullName: command.fullName.trim(),
      role: command.role,
      status: command.status,
      ...digest,
    },
    now,
  );
}

/**
 * Actualiza el perfil de una cuenta.
 *
 * Un `PATCH` que no cambia nada no escribe: `updatedAt` solo avanza cuando hay
 * una modificacion real. La desactivacion cierra las sesiones vivas.
 */
export async function updateUser(
  db: Database,
  id: string,
  command: UpdateUserCommand,
  now: Date = new Date(),
): Promise<UserRow> {
  // Un cuerpo sin campos es un error del cliente, no una actualizacion vacia: si
  // se aceptara, el llamador no tendria forma de distinguirlo de un exito real.
  if (Object.values(command).every((field) => field === undefined)) {
    throw AppError.unprocessable(
      ErrorCode.VALIDATION_ERROR,
      'Debe indicar al menos un campo a modificar.',
      { details: { fields: ['email', 'fullName', 'role', 'status'] } },
    );
  }

  const user = await findUserById(db, id);
  if (user === null) {
    throw userNotFound(id);
  }

  const changes = profileChangesOf(user, command);
  if (Object.keys(changes).length === 0) {
    return user;
  }

  await assertKeepsAnAdmin(db, user, changes);

  const updated = await updateUserProfile(db, id, changes, now);
  if (updated === null) {
    throw userNotFound(id);
  }

  if (updated.status === 'disabled' && user.status !== 'disabled') {
    await revokeAllSessions(db, updated.id, 'user_disabled', now);
  }

  return updated;
}

/**
 * Rota la contrasena de una cuenta y cierra sus sesiones.
 *
 * La rotacion no seria efectiva si el token anterior siguiera vivo: se revocan
 * todas las sesiones del usuario, incluidas las del propio administrador que
 * cambia su contrasena (volvera a iniciar sesion).
 */
export async function resetUserPassword(
  db: Database,
  id: string,
  password: string,
  config: AuthConfig,
  now: Date = new Date(),
): Promise<PasswordResetResult> {
  validatePassword(password);

  const digest = await hashPassword(password, { iterations: config.pbkdf2Iterations });
  const updated = await updateUserPassword(db, id, digest, now);
  if (updated === null) {
    throw userNotFound(id);
  }

  // Quien olvido su contrasena suele haber agotado los intentos: sin levantar el
  // bloqueo, no podria entrar con la contrasena nueva.
  const cleared = await clearUserLockout(db, id, now);
  const revokedSessions = await revokeAllSessions(db, id, 'password_reset', now);

  return { user: cleared ?? updated, revokedSessions };
}

/**
 * Traduce el comando a los campos que realmente cambian.
 *
 * El email se normaliza igual que en el login: si no, `Ana@X.com` y `ana@x.com`
 * convivirian y el indice unico no las veria como duplicadas.
 */
function profileChangesOf(user: UserRow, command: UpdateUserCommand): UserProfileChanges {
  const changes: {
    email?: string;
    fullName?: string;
    role?: UserRole;
    status?: UserStatus;
  } = {};

  if (command.email !== undefined) {
    const email = normalizeEmail(command.email);
    if (email !== user.email) {
      changes.email = email;
    }
  }
  if (command.fullName !== undefined) {
    const fullName = command.fullName.trim();
    if (fullName !== user.fullName) {
      changes.fullName = fullName;
    }
  }
  if (command.role !== undefined && command.role !== user.role) {
    changes.role = command.role;
  }
  if (command.status !== undefined && command.status !== user.status) {
    changes.status = command.status;
  }

  return changes;
}

/**
 * Impide que el sistema se quede sin administradores activos.
 *
 * Cubre tambien al administrador que intenta degradarse o desactivarse a si
 * mismo: si es el unico, la operacion responde `LAST_ADMIN_PROTECTED` en lugar de
 * dejarlo fuera del sistema. Es una unica regla a proposito: una salvaguarda
 * adicional contra el auto-bloqueo seria redundante.
 */
async function assertKeepsAnAdmin(
  db: Database,
  user: UserRow,
  changes: UserProfileChanges,
): Promise<void> {
  const wasActiveAdmin = user.role === 'admin' && user.status === 'active';
  const staysActiveAdmin =
    (changes.role ?? user.role) === 'admin' && (changes.status ?? user.status) === 'active';

  if (!wasActiveAdmin || staysActiveAdmin) {
    return;
  }
  if ((await countActiveAdmins(db)) > 1) {
    return;
  }

  throw AppError.conflict(
    ErrorCode.LAST_ADMIN_PROTECTED,
    'No se puede degradar ni desactivar al ultimo administrador activo.',
  );
}

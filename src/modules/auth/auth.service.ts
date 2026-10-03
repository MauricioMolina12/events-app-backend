import type { AuthConfig } from '../../config/env';
import { AppError } from '../../core/errors/app-error';
import { ErrorCode } from '../../core/errors/error-codes';
import type { Database } from '../../db/client';
import {
  findUserByEmail,
  findUserById,
  updateUserLoginFailure,
  updateUserLoginSuccess,
  type UserRow,
} from '../users/users.repository';
import { timingSafeDigest, verifyPassword } from './password';
import {
  countRecentFailedAttempts,
  findSessionByTokenHash,
  insertAuthAttempt,
  insertSession,
  revokeSession,
  revokeUserSessions,
  touchSession,
  type SessionRow,
} from './auth.repository';
import { hashSessionToken, issueSessionToken, sessionExpiresAt } from './session';

/**
 * Reglas de autenticacion.
 *
 * El servicio no conoce Hono: recibe la conexion, la configuracion y un reloj
 * inyectable, y responde con filas o con `AuthResolution`. Las cookies y los
 * codigos HTTP los pone la capa de rutas y middlewares.
 */

/** Ventana en la que se cuentan los fallos para escalar el bloqueo. */
export const AUTH_ATTEMPT_WINDOW_MS = 15 * 60 * 1000;

/** Frecuencia con que se actualiza `last_used_at`: no se escribe en cada peticion. */
export const SESSION_TOUCH_INTERVAL_MS = 5 * 60 * 1000;

export interface LoginInput {
  email: string;
  password: string;
  /** Origen del intento (IP) ya hasheado; nunca la IP en claro. */
  sourceHash?: string | null;
}

export interface LoginOutcome {
  readonly user: UserRow;
  readonly session: SessionRow;
  /** Token en claro, unica vez que existe fuera de la cookie del cliente. */
  readonly token: string;
}

/** Resultado de resolver la cookie de una peticion. */
export type AuthResolution =
  | { readonly status: 'authenticated'; readonly user: UserRow; readonly session: SessionRow }
  | { readonly status: 'missing' }
  | { readonly status: 'expired' }
  | { readonly status: 'revoked' }
  | { readonly status: 'disabled' };

/**
 * Normaliza el email.
 *
 * El esquema almacena el email ya normalizado, de modo que el indice unico
 * `users_email_unique` sea la unica defensa posible contra duplicados: si el
 * servicio no normalizara, `Ana@X.com` y `ana@x.com` convivirian.
 */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/**
 * Autentica un par email/contrasena y emite una sesion.
 *
 * Bloqueo progresivo: al alcanzar cada multiplo del umbral dentro de la ventana,
 * la cuenta queda bloqueada el doble de tiempo que en la ronda anterior (con
 * tope). La respuesta es identica para email inexistente y contrasena incorrecta
 * para no permitir la enumeracion de cuentas.
 */
export async function login(
  db: Database,
  input: LoginInput,
  config: AuthConfig,
  now: Date = new Date(),
): Promise<LoginOutcome> {
  const identifier = normalizeEmail(input.email);
  const recentFailures = await countRecentFailedAttempts(
    db,
    identifier,
    new Date(now.getTime() - AUTH_ATTEMPT_WINDOW_MS),
  );
  const user = await findUserByEmail(db, identifier);

  if (user === null) {
    // Se deriva igual que si el email existiera y se descarta el resultado: el
    // tiempo de respuesta no debe revelar si la cuenta esta registrada.
    await verifyPassword(input.password, timingSafeDigest(config.pbkdf2Iterations));
    await registerFailure(db, identifier, input.sourceHash ?? null, now);
    throw invalidCredentials();
  }

  if (user.lockedUntil !== null && user.lockedUntil.getTime() > now.getTime()) {
    await registerFailure(db, identifier, input.sourceHash ?? null, now);
    throw accountLocked(user.lockedUntil);
  }

  const matches = await verifyPassword(input.password, {
    hash: user.passwordHash,
    salt: user.passwordSalt,
    iterations: user.passwordIterations,
  });

  if (!matches) {
    const failedLoginAttempts = user.failedLoginAttempts + 1;
    const multiplier = lockoutMultiplier(recentFailures + 1, config);
    const lockedUntil =
      multiplier === null
        ? null
        : new Date(now.getTime() + multiplier * config.lockoutMinutes * 60 * 1000);

    await updateUserLoginFailure(db, user.id, { failedLoginAttempts, lockedUntil }, now);
    await registerFailure(db, identifier, input.sourceHash ?? null, now);

    if (lockedUntil !== null) {
      throw accountLocked(lockedUntil);
    }
    throw invalidCredentials();
  }

  // La contrasena se verifica antes de mirar el estado: asi una cuenta
  // desactivada no se distingue de una inexistente para quien no la conoce.
  if (user.status === 'disabled') {
    await registerFailure(db, identifier, input.sourceHash ?? null, now);
    throw AppError.unauthorized(
      ErrorCode.ACCOUNT_DISABLED,
      'La cuenta esta desactivada. Solicita acceso a un administrador.',
    );
  }

  const authenticated = await updateUserLoginSuccess(db, user.id, now);
  const { token, tokenHash } = await issueSessionToken();
  const session = await insertSession(
    db,
    {
      userId: user.id,
      tokenHash,
      expiresAt: sessionExpiresAt(now, config.sessionTtlHours),
    },
    now,
  );
  await insertAuthAttempt(
    db,
    { identifier, succeeded: true, sourceHash: input.sourceHash ?? null },
    now,
  );

  return { user: authenticated ?? user, session, token };
}

/**
 * Resuelve el token de una peticion.
 *
 * Distingue cada motivo de rechazo (`missing`, `expired`, `revoked`,
 * `disabled`) porque el cliente debe poder reaccionar de forma distinta; los
 * middlewares los traducen a `UNAUTHENTICATED`, `SESSION_EXPIRED`,
 * `SESSION_REVOKED` y `ACCOUNT_DISABLED`.
 */
export async function resolveAuth(
  db: Database,
  token: string,
  now: Date = new Date(),
): Promise<AuthResolution> {
  if (token === '') {
    return { status: 'missing' };
  }

  const session = await findSessionByTokenHash(db, await hashSessionToken(token));
  if (session === null) {
    return { status: 'missing' };
  }
  if (session.revokedAt !== null) {
    return { status: 'revoked' };
  }
  if (session.expiresAt.getTime() <= now.getTime()) {
    return { status: 'expired' };
  }

  const user = await findUserById(db, session.userId);
  if (user === null) {
    return { status: 'missing' };
  }
  if (user.status === 'disabled') {
    return { status: 'disabled' };
  }

  // `last_used_at` se actualiza con pereza: escribir en cada peticion agotaria
  // las escrituras de D1 sin aportar informacion util.
  const lastUsedAt = session.lastUsedAt;
  if (lastUsedAt === null || now.getTime() - lastUsedAt.getTime() > SESSION_TOUCH_INTERVAL_MS) {
    await touchSession(db, session.id, now);
  }

  return { status: 'authenticated', user, session };
}

/**
 * Revoca la sesion indicada.
 *
 * Es idempotente: cerrar sesion dos veces (o con una sesion ya expirada) no es un
 * error para el cliente.
 */
export async function logout(
  db: Database,
  sessionId: string,
  now: Date = new Date(),
): Promise<boolean> {
  const revoked = await revokeSession(db, sessionId, 'logout', now);
  return revoked !== null;
}

/**
 * Cierra la sesion asociada a un token.
 *
 * No exige que la sesion siga siendo valida: cerrar sesion dos veces, o con una
 * sesion caducada, no es un error para el cliente. Devuelve `false` cuando la
 * cookie no corresponde a ninguna sesion.
 */
export async function logoutByToken(
  db: Database,
  token: string,
  now: Date = new Date(),
): Promise<boolean> {
  if (token === '') {
    return false;
  }

  const session = await findSessionByTokenHash(db, await hashSessionToken(token));
  return session === null ? false : logout(db, session.id, now);
}

/**
 * Revoca todas las sesiones vivas de un usuario.
 *
 * La usan los cambios de contrasena y la desactivacion de cuentas del modulo de
 * usuarios: sin esto, un token emitido antes del cambio seguiria siendo valido
 * hasta expirar. Devuelve cuantas sesiones se cerraron.
 */
export async function revokeAllSessions(
  db: Database,
  userId: string,
  reason: string,
  now: Date = new Date(),
): Promise<number> {
  return revokeUserSessions(db, userId, reason, now);
}

/** Multiplicador del bloqueo para el numero de fallos de la ventana. */
function lockoutMultiplier(failuresInWindow: number, config: AuthConfig): number | null {
  if (failuresInWindow < config.maxFailedAttempts) {
    return null;
  }

  const rounds = Math.floor(failuresInWindow / config.maxFailedAttempts) - 1;
  return Math.min(2 ** Math.max(rounds, 0), config.maxLockoutMultiplier);
}

/** Registra el intento fallido: alimenta la ventana del bloqueo progresivo. */
async function registerFailure(
  db: Database,
  identifier: string,
  sourceHash: string | null,
  now: Date,
): Promise<void> {
  await insertAuthAttempt(db, { identifier, succeeded: false, sourceHash }, now);
}

function invalidCredentials(): AppError {
  return AppError.unauthorized(ErrorCode.INVALID_CREDENTIALS, 'Email o contrasena incorrectos.');
}

function accountLocked(until: Date): AppError {
  return AppError.unauthorized(
    ErrorCode.ACCOUNT_LOCKED,
    'La cuenta esta bloqueada temporalmente por intentos fallidos.',
    { details: { lockedUntil: until.toISOString() } },
  );
}

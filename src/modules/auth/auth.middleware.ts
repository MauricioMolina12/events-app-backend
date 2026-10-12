import type { Context } from 'hono';
import { getCookie } from 'hono/cookie';
import { createMiddleware } from 'hono/factory';
import { readRuntimeConfig } from '../../config/env';
import { AppError } from '../../core/errors/app-error';
import { ErrorCode } from '../../core/errors/error-codes';
import type { AppEnv, AuthPrincipal, AuthSessionInfo } from '../../core/types/context';
import { createDb } from '../../db/client';
import type { UserRole } from '../../db/schema';
import { toAuthPrincipal, toAuthSessionInfo } from './auth.schemas';
import { resolveAuth } from './auth.service';

/**
 * Guards de autenticacion y autorizacion.
 *
 * `requireAuth` resuelve la cookie de sesion y publica el usuario en el
 * contexto; `requireRole` solo comprueba el rol. El orden importa: `requireRole`
 * exige que `requireAuth` haya corrido antes (y no hace su propia consulta).
 */

/** Token de la cookie de sesion; `''` cuando la peticion no la trae. */
export function sessionTokenOf(c: Context<AppEnv>): string {
  return getCookie(c, readRuntimeConfig(c.env).auth.cookieName) ?? '';
}

/**
 * Exige una sesion valida.
 *
 * Un token desconocido y un token ausente responden igual (`UNAUTHENTICATED`):
 * los demas motivos se distinguen porque el cliente debe reaccionar distinto
 * (sesion caducada o revocada se resuelven volviendo a iniciar sesion; cuenta
 * desactivada no).
 */
export const requireAuth = createMiddleware<AppEnv>(async (c, next) => {
  const resolution = await resolveAuth(createDb(c.env), sessionTokenOf(c));

  switch (resolution.status) {
    case 'authenticated': {
      const principal = toAuthPrincipal(resolution.user);
      const { resolveAccess } = await import('../collaborators/collaborators.service');
      const access = await resolveAccess(createDb(c.env), principal.id, principal.role);
      c.set('authUser', { ...principal, modules: [...access.modules] });
      c.set('authSession', toAuthSessionInfo(resolution.session));
      break;
    }
    case 'expired':
      throw AppError.unauthorized(
        ErrorCode.SESSION_EXPIRED,
        'La sesion expiro. Inicia sesion de nuevo.',
      );
    case 'revoked':
      throw AppError.unauthorized(
        ErrorCode.SESSION_REVOKED,
        'La sesion fue revocada. Inicia sesion de nuevo.',
      );
    case 'disabled':
      throw AppError.unauthorized(
        ErrorCode.ACCOUNT_DISABLED,
        'La cuenta esta desactivada. Solicita acceso a un administrador.',
      );
    case 'missing':
      throw AppError.unauthorized(
        ErrorCode.UNAUTHENTICATED,
        'Se requiere una sesion activa para realizar esta operacion.',
      );
  }

  await next();
});

/** Restringe una ruta a los roles indicados. Requiere `requireAuth` antes. */
export function requireRole(...roles: readonly UserRole[]) {
  return createMiddleware<AppEnv>(async (c, next) => {
    const user = currentAuthUser(c);

    if (!roles.includes(user.role)) {
      throw AppError.forbidden(
        ErrorCode.FORBIDDEN,
        'Tu rol no permite realizar esta operacion.',
      );
    }

    await next();
  });
}

/**
 * Usuario autenticado de la peticion.
 *
 * Falla con 401 si el guard no corrio: es preferible a un `undefined` silencioso
 * que acabaria escribiendo datos sin autor.
 */
export function currentAuthUser(c: Context<AppEnv>): AuthPrincipal {
  const user = c.get('authUser');

  if (user === undefined) {
    throw AppError.unauthorized(
      ErrorCode.UNAUTHENTICATED,
      'Se requiere una sesion activa para realizar esta operacion.',
    );
  }

  return user;
}

/** Sesion que sostiene la peticion; exige `requireAuth` antes. */
export function currentAuthSession(c: Context<AppEnv>): AuthSessionInfo {
  const session = c.get('authSession');

  if (session === undefined) {
    throw AppError.unauthorized(
      ErrorCode.UNAUTHENTICATED,
      'Se requiere una sesion activa para realizar esta operacion.',
    );
  }

  return session;
}

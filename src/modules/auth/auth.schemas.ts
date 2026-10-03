import { z } from '@hono/zod-openapi';
import type { AuthPrincipal, AuthSessionInfo } from '../../core/types/context';
import { USER_ROLES, USER_STATUSES } from '../../db/schema';
import type { UserRow } from '../users/users.repository';
import type { SessionRow } from './auth.repository';

/**
 * Esquemas y mapeos de presentacion del modulo de autenticacion.
 *
 * Se centralizan aqui para que ninguna ruta construya a mano la parte publica de
 * un usuario: es el unico punto donde se decide que campos salen al cliente.
 */

/** Usuario autenticado: identidad y rol, sin datos de credenciales. */
export const authenticatedUserSchema = z
  .object({
    id: z.string(),
    email: z.string(),
    fullName: z.string(),
    role: z.enum(USER_ROLES),
    status: z.enum(USER_STATUSES),
  })
  .openapi('AuthenticatedUser');

/** Sesion activa, expuesta solo con lo que el cliente necesita. */
export const activeSessionSchema = z
  .object({
    id: z.string(),
    expiresAt: z.string(),
  })
  .openapi('ActiveSession');

export function toAuthPrincipal(user: UserRow): AuthPrincipal {
  return {
    id: user.id,
    email: user.email,
    fullName: user.fullName,
    role: user.role,
    status: user.status,
  };
}

export function toAuthSessionInfo(session: SessionRow): AuthSessionInfo {
  return { id: session.id, expiresAt: session.expiresAt };
}

/** Forma publica de una sesion, con las fechas ya en ISO-8601. */
export function toActiveSession(session: AuthSessionInfo) {
  return { id: session.id, expiresAt: session.expiresAt.toISOString() };
}

import { z } from '@hono/zod-openapi';
import { toIsoString } from '../../db/helpers';
import { USER_ROLES, USER_STATUSES } from '../../db/schema';
import type { UserRow } from './users.repository';

/**
 * Esquemas y mapeos de presentacion del modulo de usuarios.
 *
 * La ficha administrativa es la unica forma publica de una cuenta que incluye
 * estado y bloqueo; el resto del sistema expone al usuario con
 * `auth.schemas.ts`. Ninguna de las dos incluye jamas el hash, el salt ni las
 * iteraciones de la contrasena.
 */

export const adminUserSchema = z
  .object({
    id: z.string(),
    email: z.string(),
    fullName: z.string(),
    role: z.enum(USER_ROLES),
    status: z.enum(USER_STATUSES),
    /** Fallos consecutivos de la racha actual de login. */
    failedLoginAttempts: z.number().int(),
    /** Fin del bloqueo temporal; `null` si la cuenta no esta bloqueada. */
    lockedUntil: z.string().nullable(),
    lastLoginAt: z.string().nullable(),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .openapi('AdminUser');

/** Ficha administrativa de una cuenta, con las fechas ya en ISO-8601. */
export function toAdminUser(user: UserRow) {
  return {
    id: user.id,
    email: user.email,
    fullName: user.fullName,
    role: user.role,
    status: user.status,
    failedLoginAttempts: user.failedLoginAttempts,
    lockedUntil: toIsoString(user.lockedUntil),
    lastLoginAt: toIsoString(user.lastLoginAt),
    createdAt: user.createdAt.toISOString(),
    updatedAt: user.updatedAt.toISOString(),
  };
}

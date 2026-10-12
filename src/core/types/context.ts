import type { Env } from 'hono';
import type { UserRole, UserStatus } from '../../db/schema';

/**
 * Usuario autenticado de la peticion.
 *
 * Es la forma que viaja en el contexto y en las respuestas de `/auth/*`: nunca
 * incluye el hash de la contrasena, el salt ni las iteraciones.
 */
export interface AuthPrincipal {
  readonly id: string;
  readonly email: string;
  readonly fullName: string;
  readonly role: UserRole;
  readonly status: UserStatus;
  readonly modules?: readonly string[];
}

/** Sesion validada que sostiene la autenticacion de la peticion. */
export interface AuthSessionInfo {
  readonly id: string;
  readonly expiresAt: Date;
}

/**
 * Variables disponibles durante el ciclo de vida de una peticion.
 *
 * `authUser` y `authSession` solo existen despues de `requireAuth`: cualquier
 * handler protegido los lee con `currentAuthUser()` / `currentAuthSession()`.
 */
export interface AppVariables {
  requestId: string;
  authUser?: AuthPrincipal;
  authSession?: AuthSessionInfo;
}

/**
 * Entorno de Hono del proyecto.
 *
 * `CloudflareBindings` lo genera `npm run cf-typegen` a partir de
 * `wrangler.jsonc`; por eso no se importa (es una interfaz global declarada en
 * `worker-configuration.d.ts`).
 */
export interface AppEnv extends Env {
  Bindings: CloudflareBindings;
  Variables: AppVariables;
}

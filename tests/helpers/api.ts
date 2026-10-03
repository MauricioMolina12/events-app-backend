import { SELF } from 'cloudflare:test';
import { loginAs, createTestUser } from './auth';

/**
 * Utilidades para las pruebas de rutas contra la aplicacion completa.
 *
 * Centralizan lo que si no acabaria duplicado en cada archivo: la peticion
 * autenticada con cookie, la lectura del codigo de error y el sembrado de una
 * sesion con un rol concreto.
 */

export const ADMIN_PASSWORD = 'contrasena-admin-1';
export const OPERATOR_PASSWORD = 'contrasena-operador-1';

/** Peticion autenticada contra la API real. */
export function api(path: string, cookie: string, init: RequestInit = {}): Promise<Response> {
  return SELF.fetch(`https://example.com/api/v1${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', cookie, ...(init.headers ?? {}) },
  });
}

/** Codigo de negocio del sobre de error. */
export async function errorCodeOf(response: Response): Promise<string> {
  const body = await response.json<{ success: false; error: { code: string } }>();
  return body.error.code;
}

export interface SeededSession {
  readonly id: string;
  readonly cookie: string;
}

/** Administrador sembrado junto a la cookie de su sesion. */
export async function seedAdmin(email = 'admin@example.com'): Promise<SeededSession> {
  const user = await createTestUser({ email, password: ADMIN_PASSWORD, role: 'admin' });
  return { id: user.id, cookie: await loginAs(email, ADMIN_PASSWORD) };
}

/** Operador sembrado junto a la cookie de su sesion. */
export async function seedOperator(
  email = 'operador@example.com',
  fullName = 'Operador Uno',
): Promise<SeededSession> {
  const user = await createTestUser({
    email,
    password: OPERATOR_PASSWORD,
    fullName,
    role: 'operator',
  });
  return { id: user.id, cookie: await loginAs(email, OPERATOR_PASSWORD) };
}

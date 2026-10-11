import { SELF, env } from 'cloudflare:test';
import { createDb } from '../../src/db/client';
import type { UserRole, UserStatus } from '../../src/db/schema';
import { insertUser, type UserRow } from '../../src/modules/users/users.repository';
import { hashPassword } from '../../src/modules/auth/password';

/**
 * Utilidades de autenticacion para los tests.
 *
 * Las contrasenas se derivan con pocas iteraciones (el minimo de `password.ts`):
 * el coste real de PBKDF2 se comprueba en `tests/unit/password.test.ts`, mientras
 * que aqui cada login con 210 000 iteraciones gastaria ~150 ms de CPU sin aportar
 * cobertura.
 */

export const TEST_PBKDF2_ITERATIONS = 1_000;

export interface CreateTestUserInput {
  email: string;
  password: string;
  fullName?: string;
  role?: UserRole;
  status?: UserStatus;
}

/** Inserta un usuario con el digest ya derivado, como lo haria el modulo de usuarios. */
export async function createTestUser(input: CreateTestUserInput): Promise<UserRow> {
  const digest = await hashPassword(input.password, { iterations: TEST_PBKDF2_ITERATIONS });

  return insertUser(createDb(env), {
    email: input.email.trim().toLowerCase(),
    fullName: input.fullName ?? 'Usuario de prueba',
    role: input.role,
    status: input.status,
    ...digest,
  });
}

/** `POST /auth/login` contra la aplicacion real. */
export function loginRequest(email: string, password: string): Promise<Response> {
  return SELF.fetch('https://example.com/api/v1/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
}

/** `POST /auth/signup` contra la aplicacion real. */
export function signupRequest(email: string, fullName: string, password: string): Promise<Response> {
  return SELF.fetch('https://example.com/api/v1/auth/signup', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, fullName, password }),
  });
}

/** Par `nombre=valor` de la cookie de sesion que devolvio el login. */
export function sessionCookieOf(response: Response): string {
  const header = response.headers.get('set-cookie') ?? '';
  const [cookie] = header.split(';');
  return cookie ?? '';
}

/** Token en claro de la cookie de sesion. */
export function sessionTokenOf(response: Response): string {
  return sessionCookieOf(response).replace(/^[^=]+=/u, '');
}

/** Inicia sesion y devuelve la cookie lista para enviar. */
export async function loginAs(email: string, password: string): Promise<string> {
  const response = await loginRequest(email, password);
  if (response.status !== 200) {
    throw new Error(`El login de prueba fallo con estado ${response.status}.`);
  }
  return sessionCookieOf(response);
}

/** Peticion autenticada con la cookie indicada. */
export function fetchWithCookie(path: string, cookie: string): Promise<Response> {
  return SELF.fetch(`https://example.com/api/v1${path}`, { headers: { cookie } });
}

import { SELF, env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { createDb } from '../../src/db/client';
import { insertSession } from '../../src/modules/auth/auth.repository';
import { issueSessionToken } from '../../src/modules/auth/session';
import {
  createTestUser,
  fetchWithCookie,
  loginAs,
  loginRequest,
  sessionTokenOf,
} from '../helpers/auth';
import { countRows, truncateAll } from '../helpers/database';

/**
 * Rutas de autenticacion contra la aplicacion completa y D1 real.
 *
 * Se cubre el contrato que consume el frontend: la cookie, el codigo de error de
 * cada motivo de rechazo y la garantia de que las credenciales nunca salen en una
 * respuesta.
 */

const db = createDb(env);
const PASSWORD = 'contrasena-segura-1';
/** Debe coincidir con `AUTH_MAX_FAILED_ATTEMPTS` de `wrangler.jsonc`. */
const MAX_FAILED_ATTEMPTS = 5;

interface ErrorBody {
  success: false;
  error: { code: string; message: string; details?: { lockedUntil?: string } };
}

interface SessionBody {
  success: true;
  data: {
    user: { id: string; email: string; fullName: string; role: string; status: string };
    session: { id: string; expiresAt: string };
  };
}

beforeEach(truncateAll);

async function errorCodeOf(response: Response): Promise<string> {
  const body = await response.json<ErrorBody>();
  return body.error.code;
}

/** Intentos registrados, filtrados por resultado. */
async function countAttempts(succeeded: boolean): Promise<number> {
  const row = await env.DB.prepare(
    'SELECT count(*) AS total FROM auth_attempts WHERE succeeded = ?',
  )
    .bind(succeeded ? 1 : 0)
    .first<{ total: number }>();

  return row?.total ?? 0;
}

describe('POST /auth/login', () => {
  it('emite una cookie HttpOnly y devuelve el usuario sin credenciales', async () => {
    const user = await createTestUser({
      email: 'admin@example.com',
      password: PASSWORD,
      fullName: 'Ana Admin',
      role: 'admin',
    });

    // El email llega con otra capitalizacion: el login debe normalizarlo.
    const response = await loginRequest('ADMIN@Example.com', PASSWORD);

    expect(response.status).toBe(200);

    const body = await response.json<SessionBody>();
    expect(body.data.user).toEqual({
      id: user.id,
      email: 'admin@example.com',
      fullName: 'Ana Admin',
      role: 'admin',
      status: 'active',
    });
    expect(new Date(body.data.session.expiresAt).getTime()).toBeGreaterThan(Date.now());

    const setCookie = response.headers.get('set-cookie') ?? '';
    expect(setCookie).toContain('events_session=');
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('SameSite=Lax');
    // En `local` no viaja `Secure`: sobre http el navegador descartaria la cookie.
    expect(setCookie).not.toContain('Secure');

    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain(user.passwordHash);
    expect(serialized).not.toContain(user.passwordSalt);
  });

  it('persiste solo el hash del token', async () => {
    await createTestUser({ email: 'operador@example.com', password: PASSWORD });

    const response = await loginRequest('operador@example.com', PASSWORD);
    const row = await env.DB.prepare('SELECT token_hash FROM sessions').first<{
      token_hash: string;
    }>();

    expect(await countRows('sessions')).toBe(1);
    expect(row?.token_hash).not.toBe(sessionTokenOf(response));
    expect(row?.token_hash).toMatch(/^[0-9a-f]{64}$/u);
  });

  it('responde 401 con INVALID_CREDENTIALS y registra el intento', async () => {
    await createTestUser({ email: 'operador@example.com', password: PASSWORD });

    const response = await loginRequest('operador@example.com', 'contrasena-equivocada');

    expect(response.status).toBe(401);
    await expect(errorCodeOf(response)).resolves.toBe('INVALID_CREDENTIALS');
    await expect(countAttempts(false)).resolves.toBe(1);
    await expect(countRows('sessions')).resolves.toBe(0);
  });

  it('no distingue un email inexistente de una contrasena incorrecta', async () => {
    const response = await loginRequest('nadie@example.com', PASSWORD);

    expect(response.status).toBe(401);
    await expect(errorCodeOf(response)).resolves.toBe('INVALID_CREDENTIALS');
    await expect(countAttempts(false)).resolves.toBe(1);
  });

  it('responde 401 con ACCOUNT_DISABLED a una cuenta desactivada', async () => {
    await createTestUser({ email: 'fuera@example.com', password: PASSWORD, status: 'disabled' });

    const response = await loginRequest('fuera@example.com', PASSWORD);

    expect(response.status).toBe(401);
    await expect(errorCodeOf(response)).resolves.toBe('ACCOUNT_DISABLED');
    await expect(countRows('sessions')).resolves.toBe(0);
  });

  it('bloquea la cuenta de forma progresiva tras varios intentos fallidos', async () => {
    await createTestUser({ email: 'bloqueada@example.com', password: PASSWORD });

    for (let attempt = 1; attempt < MAX_FAILED_ATTEMPTS; attempt += 1) {
      const response = await loginRequest('bloqueada@example.com', 'equivocada');

      expect(response.status).toBe(401);
      await expect(errorCodeOf(response)).resolves.toBe('INVALID_CREDENTIALS');
    }

    const locking = await loginRequest('bloqueada@example.com', 'equivocada');
    await expect(errorCodeOf(locking)).resolves.toBe('ACCOUNT_LOCKED');

    // Con la contrasena correcta sigue bloqueada: el bloqueo no depende de ellas.
    const stillLocked = await loginRequest('bloqueada@example.com', PASSWORD);
    const body = await stillLocked.json<ErrorBody>();

    expect(stillLocked.status).toBe(401);
    expect(body.error.code).toBe('ACCOUNT_LOCKED');
    expect(body.error.details?.lockedUntil).toBeTruthy();
    await expect(countRows('sessions')).resolves.toBe(0);
  });

  it('valida el cuerpo antes de tocar la base de datos', async () => {
    const response = await loginRequest('no-es-un-email', PASSWORD);

    expect(response.status).toBe(422);
    await expect(errorCodeOf(response)).resolves.toBe('VALIDATION_ERROR');
    await expect(countAttempts(false)).resolves.toBe(0);
  });
});

describe('GET /auth/me', () => {
  it('devuelve el usuario y la sesion con una cookie valida', async () => {
    const user = await createTestUser({ email: 'operador@example.com', password: PASSWORD });
    const cookie = await loginAs('operador@example.com', PASSWORD);

    const response = await fetchWithCookie('/auth/me', cookie);

    expect(response.status).toBe(200);

    const body = await response.json<SessionBody>();
    expect(body.data.user.id).toBe(user.id);
    expect(body.data.user.role).toBe('operator');
    expect(body.data.session.id).toBeTruthy();
  });

  it('responde 401 UNAUTHENTICATED sin cookie', async () => {
    const response = await SELF.fetch('https://example.com/api/v1/auth/me');

    expect(response.status).toBe(401);
    await expect(errorCodeOf(response)).resolves.toBe('UNAUTHENTICATED');
  });

  it('responde 401 UNAUTHENTICATED con un token desconocido', async () => {
    const response = await fetchWithCookie('/auth/me', 'events_session=token-inventado');

    expect(response.status).toBe(401);
    await expect(errorCodeOf(response)).resolves.toBe('UNAUTHENTICATED');
  });

  it('responde 401 SESSION_EXPIRED cuando la sesion caduco', async () => {
    const user = await createTestUser({ email: 'operador@example.com', password: PASSWORD });
    const { token, tokenHash } = await issueSessionToken();

    await insertSession(db, {
      userId: user.id,
      tokenHash,
      expiresAt: new Date(Date.now() - 60_000),
    });

    const response = await fetchWithCookie('/auth/me', `events_session=${token}`);

    expect(response.status).toBe(401);
    await expect(errorCodeOf(response)).resolves.toBe('SESSION_EXPIRED');
  });

  it('responde 401 ACCOUNT_DISABLED si la cuenta se desactiva tras el login', async () => {
    const user = await createTestUser({ email: 'operador@example.com', password: PASSWORD });
    const cookie = await loginAs('operador@example.com', PASSWORD);

    await env.DB.prepare('UPDATE users SET status = ? WHERE id = ?').bind('disabled', user.id).run();

    const response = await fetchWithCookie('/auth/me', cookie);

    expect(response.status).toBe(401);
    await expect(errorCodeOf(response)).resolves.toBe('ACCOUNT_DISABLED');
  });
});

describe('POST /auth/logout', () => {
  it('revoca la sesion y borra la cookie', async () => {
    await createTestUser({ email: 'operador@example.com', password: PASSWORD });
    const cookie = await loginAs('operador@example.com', PASSWORD);

    const response = await SELF.fetch('https://example.com/api/v1/auth/logout', {
      method: 'POST',
      headers: { cookie },
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ success: true, data: { revoked: true } });
    expect(response.headers.get('set-cookie')).toContain('Max-Age=0');

    // El token revocado deja de servir, y con el codigo que lo explica.
    const revoked = await fetchWithCookie('/auth/me', cookie);

    expect(revoked.status).toBe(401);
    await expect(errorCodeOf(revoked)).resolves.toBe('SESSION_REVOKED');
  });

  it('es idempotente: sin sesion responde 200 con revoked=false', async () => {
    const response = await SELF.fetch('https://example.com/api/v1/auth/logout', { method: 'POST' });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ success: true, data: { revoked: false } });
  });
});

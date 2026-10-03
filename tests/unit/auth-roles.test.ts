import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { isAppError } from '../../src/core/errors/app-error';
import { ErrorCode } from '../../src/core/errors/error-codes';
import type { AppEnv, AuthPrincipal } from '../../src/core/types/context';
import { currentAuthUser, requireRole } from '../../src/modules/auth/auth.middleware';

/**
 * Pruebas del guard de autorizacion.
 *
 * Se monta una app minima que inyecta el usuario como lo haria `requireAuth`: el
 * objetivo es aislar la matriz de roles de la base de datos y de la sesion.
 */

const ADMIN: AuthPrincipal = {
  id: 'user-admin',
  email: 'admin@example.com',
  fullName: 'Ana Admin',
  role: 'admin',
  status: 'active',
};

const OPERATOR: AuthPrincipal = { ...ADMIN, id: 'user-operator', role: 'operator' };

/** App con un endpoint protegido por los roles indicados. */
function appWithRoles(principal: AuthPrincipal | null, roles: readonly ('admin' | 'operator')[]) {
  const app = new Hono<AppEnv>();

  app.onError((error, c) => {
    if (isAppError(error)) {
      return c.json({ code: error.code }, error.status);
    }
    throw error;
  });

  app.get(
    '/protegido',
    async (c, next) => {
      if (principal !== null) {
        c.set('authUser', principal);
      }
      await next();
    },
    requireRole(...roles),
    (c) => c.json({ email: currentAuthUser(c).email }),
  );

  return app;
}

describe('requireRole', () => {
  it('permite el acceso al rol incluido', async () => {
    const response = await appWithRoles(ADMIN, ['admin']).request('/protegido');

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ email: 'admin@example.com' });
  });

  it('responde 403 cuando el rol autenticado no basta', async () => {
    const response = await appWithRoles(OPERATOR, ['admin']).request('/protegido');

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({ code: ErrorCode.FORBIDDEN });
  });

  it('acepta varios roles permitidos', async () => {
    const response = await appWithRoles(OPERATOR, ['admin', 'operator']).request('/protegido');

    expect(response.status).toBe(200);
  });

  it('responde 401 si el guard corre sin sesion previa', async () => {
    const response = await appWithRoles(null, ['admin']).request('/protegido');

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ code: ErrorCode.UNAUTHENTICATED });
  });
});

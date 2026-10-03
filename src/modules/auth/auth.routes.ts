import { OpenAPIHono, createRoute, z, type RouteHandler } from '@hono/zod-openapi';
import { deleteCookie, setCookie } from 'hono/cookie';
import { readRuntimeConfig } from '../../config/env';
import { sha256Hex } from '../../core/crypto/encoding';
import { errorResponse } from '../../core/http/error-response';
import { apiSuccess } from '../../core/http/responses';
import type { AppEnv } from '../../core/types/context';
import { createDb } from '../../db/client';
import {
  currentAuthSession,
  currentAuthUser,
  requireAuth,
  sessionTokenOf,
} from './auth.middleware';
import {
  activeSessionSchema,
  authenticatedUserSchema,
  toActiveSession,
  toAuthPrincipal,
} from './auth.schemas';
import { login, logoutByToken } from './auth.service';
import { expiredSessionCookieOptions, sessionCookieOptions, sessionCookieSettings } from './session';

/**
 * Rutas de autenticacion.
 *
 * `login` y `logout` son publicas (no pueden exigir sesion); `me` es la unica
 * protegida y sirve de comprobacion barata para el frontend.
 */

const loginRequestSchema = z
  .object({
    email: z.email().max(320),
    password: z.string().min(1).max(200),
  })
  .openapi('LoginRequest');

/** Cuerpo compartido por `login` y `me`: la sesion y su titular. */
const sessionPayloadSchema = z.object({
  user: authenticatedUserSchema,
  session: activeSessionSchema,
});

const loginResponseSchema = z
  .object({ success: z.literal(true), data: sessionPayloadSchema })
  .openapi('LoginResponse');

const loginRoute = createRoute({
  method: 'post',
  path: '/auth/login',
  tags: ['Autenticacion'],
  summary: 'Inicia sesion',
  description: [
    'Valida las credenciales y emite una cookie de sesion `HttpOnly`, `SameSite=Lax`',
    'y `Secure` fuera de `local`. El token en claro solo viaja en esa cookie.',
    '',
    'Responde 401 con `INVALID_CREDENTIALS` (email o contrasena incorrectos, mismo',
    'codigo para un email inexistente), `ACCOUNT_LOCKED` (bloqueo progresivo por',
    'intentos fallidos) o `ACCOUNT_DISABLED`.',
  ].join('\n'),
  request: {
    body: {
      required: true,
      content: { 'application/json': { schema: loginRequestSchema } },
    },
  },
  responses: {
    200: {
      description: 'Sesion emitida; la cookie viaja en `Set-Cookie`.',
      content: { 'application/json': { schema: loginResponseSchema } },
    },
    401: errorResponse(
      'Credenciales invalidas, cuenta bloqueada temporalmente o cuenta desactivada.',
    ),
    422: errorResponse('El cuerpo no cumple el formato esperado.'),
  },
});

const loginHandler: RouteHandler<typeof loginRoute, AppEnv> = async (c) => {
  const config = readRuntimeConfig(c.env);
  const credentials = c.req.valid('json');
  const clientIp = c.req.header('cf-connecting-ip');

  const outcome = await login(
    createDb(c.env),
    {
      email: credentials.email,
      password: credentials.password,
      // La IP se hashea: permite correlacionar intentos sin guardar un dato personal.
      sourceHash: clientIp === undefined || clientIp === '' ? null : await sha256Hex(clientIp),
    },
    config.auth,
  );

  const settings = sessionCookieSettings(config.auth);
  setCookie(c, settings.name, outcome.token, sessionCookieOptions(settings));

  return c.json(
    apiSuccess({
      user: toAuthPrincipal(outcome.user),
      session: toActiveSession({
        id: outcome.session.id,
        expiresAt: outcome.session.expiresAt,
      }),
    }),
    200,
  );
};

const logoutResponseSchema = z
  .object({ success: z.literal(true), data: z.object({ revoked: z.boolean() }) })
  .openapi('LogoutResponse');

const logoutRoute = createRoute({
  method: 'post',
  path: '/auth/logout',
  tags: ['Autenticacion'],
  summary: 'Cierra sesion',
  description:
    'Revoca la sesion asociada a la cookie y la elimina del navegador. Es idempotente: sin cookie o con una sesion ya cerrada responde 200 con `revoked: false`.',
  responses: {
    200: {
      description: 'Sesion revocada (o ya inexistente).',
      content: { 'application/json': { schema: logoutResponseSchema } },
    },
  },
});

const logoutHandler: RouteHandler<typeof logoutRoute, AppEnv> = async (c) => {
  const config = readRuntimeConfig(c.env);
  const settings = sessionCookieSettings(config.auth);
  const revoked = await logoutByToken(createDb(c.env), sessionTokenOf(c));

  // La cookie se borra siempre: si el token ya no existe, el navegador no debe
  // seguir enviando un valor inservible.
  deleteCookie(c, settings.name, expiredSessionCookieOptions(settings));

  return c.json(apiSuccess({ revoked }), 200);
};

const meResponseSchema = z
  .object({ success: z.literal(true), data: sessionPayloadSchema })
  .openapi('CurrentSessionResponse');

const meRoute = createRoute({
  method: 'get',
  path: '/auth/me',
  tags: ['Autenticacion'],
  middleware: [requireAuth],
  summary: 'Sesion actual',
  description:
    'Devuelve el usuario y la sesion activa. Responde 401 con `UNAUTHENTICATED` (sin cookie o token desconocido), `SESSION_EXPIRED`, `SESSION_REVOKED` o `ACCOUNT_DISABLED`.',
  responses: {
    200: {
      description: 'Sesion activa.',
      content: { 'application/json': { schema: meResponseSchema } },
    },
    401: errorResponse(
      'Sin sesion activa, sesion caducada o revocada, o cuenta desactivada.',
    ),
  },
});

const meHandler: RouteHandler<typeof meRoute, AppEnv> = (c) => {
  return c.json(
    apiSuccess({
      user: currentAuthUser(c),
      session: toActiveSession(currentAuthSession(c)),
    }),
    200,
  );
};

/** Registra las rutas de autenticacion. */
export function registerAuthRoutes(app: OpenAPIHono<AppEnv>): void {
  app.openapi(loginRoute, loginHandler);
  app.openapi(logoutRoute, logoutHandler);
  app.openapi(meRoute, meHandler);
}

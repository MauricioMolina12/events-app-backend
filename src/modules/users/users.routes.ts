import { OpenAPIHono, createRoute, z, type RouteHandler } from '@hono/zod-openapi';
import { readRuntimeConfig } from '../../config/env';
import { errorResponse } from '../../core/http/error-response';
import { apiSuccess } from '../../core/http/responses';
import type { AppEnv } from '../../core/types/context';
import { createDb } from '../../db/client';
import { USER_ROLES, USER_STATUSES } from '../../db/schema';
import { requireAuth, requireRole } from '../auth/auth.middleware';
import { adminUserSchema, toAdminUser } from './users.schemas';
import {
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  USER_LIST_DEFAULT_LIMIT,
  USER_LIST_MAX_LIMIT,
  createUser,
  getUserById,
  listUserAccounts,
  resetUserPassword,
  updateUser,
} from './users.service';

/**
 * Rutas administrativas de cuentas.
 *
 * Todas exigen `requireAuth` y `requireRole('admin')`: el primero resuelve la
 * cookie y publica el usuario; el segundo comprueba el rol que se acaba de leer
 * de la base de datos, de modo que degradar a un administrador surte efecto en su
 * siguiente peticion sin tocar la sesion.
 */

const userIdParamSchema = z.object({
  id: z.string().min(1).openapi({
    param: { name: 'id', in: 'path' },
    description: 'Identificador de la cuenta.',
  }),
});

const listUsersQuerySchema = z
  .object({
    role: z.enum(USER_ROLES).optional(),
    status: z.enum(USER_STATUSES).optional(),
    search: z
      .string()
      .trim()
      .min(1)
      .max(120)
      .optional()
      .openapi({ description: 'Filtra por email o nombre (sin distinguir mayusculas).' }),
    limit: z.coerce.number().int().min(1).max(USER_LIST_MAX_LIMIT).default(USER_LIST_DEFAULT_LIMIT),
    offset: z.coerce.number().int().min(0).default(0),
  })
  .openapi('UserListQuery');

const userResponseSchema = z
  .object({ success: z.literal(true), data: adminUserSchema })
  .openapi('UserResponse');

const userListResponseSchema = z
  .object({
    success: z.literal(true),
    data: z.array(adminUserSchema),
    meta: z.object({
      total: z.number().int(),
      limit: z.number().int(),
      offset: z.number().int(),
    }),
  })
  .openapi('UserListResponse');

const listUsersRoute = createRoute({
  method: 'get',
  path: '/users',
  tags: ['Usuarios'],
  middleware: [requireAuth, requireRole('admin')],
  summary: 'Lista las cuentas',
  description: [
    'Devuelve las cuentas ordenadas por alta descendente, con filtros opcionales',
    'por rol, estado y texto libre. `meta.total` cuenta todas las filas que',
    'cumplen los filtros, no solo las de la pagina.',
    '',
    'Los usuarios desactivados se incluyen: siguen existiendo para la auditoria y',
    'se localizan con `status=disabled`.',
  ].join('\n'),
  request: { query: listUsersQuerySchema },
  responses: {
    200: {
      description: 'Pagina de cuentas.',
      content: { 'application/json': { schema: userListResponseSchema } },
    },
    401: errorResponse('Sin sesion activa.'),
    403: errorResponse('La cuenta autenticada no es administradora.'),
  },
});

const listUsersHandler: RouteHandler<typeof listUsersRoute, AppEnv> = async (c) => {
  const page = await listUserAccounts(createDb(c.env), c.req.valid('query'));

  return c.json(
    apiSuccess(page.items.map(toAdminUser), {
      total: page.total,
      limit: page.limit,
      offset: page.offset,
    }),
    200,
  );
};

const createUserBodySchema = z
  .object({
    email: z.email().max(320).openapi({ example: 'operador@example.com' }),
    fullName: z.string().trim().min(1).max(160),
    password: z
      .string()
      .min(PASSWORD_MIN_LENGTH)
      .max(PASSWORD_MAX_LENGTH)
      .openapi({ description: `Minimo ${PASSWORD_MIN_LENGTH} caracteres.` }),
    role: z.enum(USER_ROLES).optional(),
    status: z.enum(USER_STATUSES).optional(),
  })
  .openapi('CreateUserRequest');

const createUserRoute = createRoute({
  method: 'post',
  path: '/users',
  tags: ['Usuarios'],
  middleware: [requireAuth, requireRole('admin')],
  summary: 'Crea una cuenta',
  description: [
    'Crea una cuenta con rol `operator` y estado `active` por defecto. La',
    'contrasena se deriva con PBKDF2-SHA256 dentro del Worker: no se almacena ni',
    'se devuelve en ningun momento.',
    '',
    'Responde 409 con `EMAIL_ALREADY_USED` cuando el email ya existe (se compara',
    'normalizado a minusculas) y 422 con `VALIDATION_ERROR` si la contrasena no',
    'cumple la politica.',
  ].join('\n'),
  request: {
    body: {
      required: true,
      content: { 'application/json': { schema: createUserBodySchema } },
    },
  },
  responses: {
    201: {
      description: 'Cuenta creada.',
      content: { 'application/json': { schema: userResponseSchema } },
    },
    401: errorResponse('Sin sesion activa.'),
    403: errorResponse('La cuenta autenticada no es administradora.'),
    409: errorResponse('Ya existe una cuenta con ese email.'),
    422: errorResponse('El cuerpo no cumple el formato esperado.'),
  },
});

const createUserHandler: RouteHandler<typeof createUserRoute, AppEnv> = async (c) => {
  const config = readRuntimeConfig(c.env);
  const user = await createUser(createDb(c.env), c.req.valid('json'), config.auth);

  return c.json(apiSuccess(toAdminUser(user)), 201);
};

const getUserRoute = createRoute({
  method: 'get',
  path: '/users/{id}',
  tags: ['Usuarios'],
  middleware: [requireAuth, requireRole('admin')],
  summary: 'Consulta una cuenta',
  description: 'Devuelve la ficha administrativa de una cuenta, con su estado y bloqueo.',
  request: { params: userIdParamSchema },
  responses: {
    200: {
      description: 'Cuenta encontrada.',
      content: { 'application/json': { schema: userResponseSchema } },
    },
    401: errorResponse('Sin sesion activa.'),
    403: errorResponse('La cuenta autenticada no es administradora.'),
    404: errorResponse('La cuenta no existe (`USER_NOT_FOUND`).'),
  },
});

const getUserHandler: RouteHandler<typeof getUserRoute, AppEnv> = async (c) => {
  const user = await getUserById(createDb(c.env), c.req.valid('param').id);

  return c.json(apiSuccess(toAdminUser(user)), 200);
};

const updateUserBodySchema = z
  .object({
    email: z.email().max(320).optional(),
    fullName: z.string().trim().min(1).max(160).optional(),
    role: z.enum(USER_ROLES).optional(),
    status: z.enum(USER_STATUSES).optional(),
  })
  .openapi('UpdateUserRequest');

const updateUserRoute = createRoute({
  method: 'patch',
  path: '/users/{id}',
  tags: ['Usuarios'],
  middleware: [requireAuth, requireRole('admin')],
  summary: 'Actualiza una cuenta',
  description: [
    'Modifica nombre, email, rol o estado; los campos ausentes se mantienen. El',
    'email se normaliza a minusculas y su duplicado responde 409',
    '`EMAIL_ALREADY_USED`.',
    '',
    'La ultima linea de defensa es la regla del ultimo administrador: un cambio',
    'que dejaria el sistema sin administradores activos responde 409 con',
    '`LAST_ADMIN_PROTECTED`, tambien cuando el administrador intenta degradarse o',
    'desactivarse a si mismo.',
    '',
    'Desactivar una cuenta (`status: "disabled"`) revoca sus sesiones vivas.',
  ].join('\n'),
  request: {
    params: userIdParamSchema,
    body: {
      required: true,
      content: { 'application/json': { schema: updateUserBodySchema } },
    },
  },
  responses: {
    200: {
      description: 'Cuenta actualizada.',
      content: { 'application/json': { schema: userResponseSchema } },
    },
    401: errorResponse('Sin sesion activa.'),
    403: errorResponse('La cuenta autenticada no es administradora.'),
    404: errorResponse('La cuenta no existe (`USER_NOT_FOUND`).'),
    409: errorResponse(
      'El email ya esta en uso (`EMAIL_ALREADY_USED`) o el cambio dejaria el sistema sin administradores (`LAST_ADMIN_PROTECTED`).',
    ),
    422: errorResponse('El cuerpo no cumple el formato esperado.'),
  },
});

const updateUserHandler: RouteHandler<typeof updateUserRoute, AppEnv> = async (c) => {
  const user = await updateUser(createDb(c.env), c.req.valid('param').id, c.req.valid('json'));

  return c.json(apiSuccess(toAdminUser(user)), 200);
};

const passwordResetBodySchema = z
  .object({
    password: z.string().min(PASSWORD_MIN_LENGTH).max(PASSWORD_MAX_LENGTH),
  })
  .openapi('UserPasswordResetRequest');

const passwordResetResponseSchema = z
  .object({
    success: z.literal(true),
    data: z.object({
      user: adminUserSchema,
      revokedSessions: z.number().int(),
    }),
  })
  .openapi('UserPasswordResetResponse');

const resetUserPasswordRoute = createRoute({
  method: 'post',
  path: '/users/{id}/password',
  tags: ['Usuarios'],
  middleware: [requireAuth, requireRole('admin')],
  summary: 'Rota la contrasena',
  description: [
    'Asigna una contrasena nueva, levanta el bloqueo por intentos fallidos y',
    'revoca todas las sesiones del usuario: el token anterior deja de servir de',
    'inmediato. `revokedSessions` informa cuantas se cerraron.',
    '',
    'Si el administrador rota su propia contrasena, su sesion tambien se cierra y',
    'debera iniciar sesion de nuevo.',
  ].join('\n'),
  request: {
    params: userIdParamSchema,
    body: {
      required: true,
      content: { 'application/json': { schema: passwordResetBodySchema } },
    },
  },
  responses: {
    200: {
      description: 'Contrasena rotada y sesiones revocadas.',
      content: { 'application/json': { schema: passwordResetResponseSchema } },
    },
    401: errorResponse('Sin sesion activa.'),
    403: errorResponse('La cuenta autenticada no es administradora.'),
    404: errorResponse('La cuenta no existe (`USER_NOT_FOUND`).'),
    422: errorResponse('La contrasena no cumple la politica.'),
  },
});

const resetUserPasswordHandler: RouteHandler<typeof resetUserPasswordRoute, AppEnv> = async (c) => {
  const config = readRuntimeConfig(c.env);
  const result = await resetUserPassword(
    createDb(c.env),
    c.req.valid('param').id,
    c.req.valid('json').password,
    config.auth,
  );

  return c.json(
    apiSuccess({ user: toAdminUser(result.user), revokedSessions: result.revokedSessions }),
    200,
  );
};

/** Registra las rutas administrativas de cuentas. */
export function registerUserRoutes(app: OpenAPIHono<AppEnv>): void {
  app.openapi(listUsersRoute, listUsersHandler);
  app.openapi(createUserRoute, createUserHandler);
  app.openapi(getUserRoute, getUserHandler);
  app.openapi(updateUserRoute, updateUserHandler);
  app.openapi(resetUserPasswordRoute, resetUserPasswordHandler);
}

import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { errorResponse } from '../../core/http/error-response';
import { apiSuccess } from '../../core/http/responses';
import type { AppEnv } from '../../core/types/context';
import { createDb } from '../../db/client';
import { THEME_PREFERENCES } from '../../db/schema';
import { requireAuth, requireRole, currentAuthUser } from '../auth/auth.middleware';
import {
  patchWorkspace,
  readPreferences,
  readWorkspace,
  restoreWorkspace,
  writePreferences,
} from './workspace.service';

/**
 * Identidad del espacio y preferencias personales.
 *
 * La lectura de la identidad es publica (la usa el catalogo y el panel). Escribirla
 * exige un administrador: no hay tenants, y un operador no puede cambiar la marca
 * compartida. El tema vive aparte, en la cuenta que hace la peticion.
 */

const workspaceSchema = z
  .object({
    displayName: z.string(),
    description: z.string().nullable(),
    nameCustomized: z.boolean(),
    primaryColor: z.string(),
    colorCustomized: z.boolean(),
    logoUrl: z.string().nullable(),
    markUrl: z.string().nullable(),
    updatedAt: z.string(),
  })
  .openapi('WorkspaceSettings');

const workspaceResponseSchema = z
  .object({ success: z.literal(true), data: workspaceSchema })
  .openapi('WorkspaceResponse');

const preferencesSchema = z
  .object({
    theme: z.enum(THEME_PREFERENCES),
    persisted: z.boolean(),
  })
  .openapi('UserPreferences');

const preferencesResponseSchema = z
  .object({ success: z.literal(true), data: preferencesSchema })
  .openapi('UserPreferencesResponse');

const patchBodySchema = z
  .object({
    displayName: z.string().trim().min(1).max(80).optional(),
    description: z.string().trim().max(280).nullable().optional(),
    primaryColor: z
      .string()
      .regex(/^#[0-9A-Fa-f]{6}$/)
      .optional(),
  })
  .openapi('UpdateWorkspaceRequest');

const preferencesBodySchema = z
  .object({ theme: z.enum(THEME_PREFERENCES) })
  .openapi('UpdatePreferencesRequest');

export function registerWorkspaceRoutes(api: OpenAPIHono<AppEnv>): void {
  api.openapi(getWorkspaceRoute, async (c) => {
    const data = await readWorkspace(createDb(c.env));
    return c.json(apiSuccess(data), 200);
  });

  api.openapi(patchWorkspaceRoute, async (c) => {
    const data = await patchWorkspace(
      createDb(c.env),
      currentAuthUser(c).id,
      c.req.valid('json'),
    );
    return c.json(apiSuccess(data), 200);
  });

  api.openapi(restoreWorkspaceRoute, async (c) => {
    const data = await restoreWorkspace(createDb(c.env), currentAuthUser(c).id);
    return c.json(apiSuccess(data), 200);
  });

  api.openapi(getPreferencesRoute, async (c) => {
    const data = await readPreferences(createDb(c.env), currentAuthUser(c).id);
    return c.json(apiSuccess(data), 200);
  });

  api.openapi(patchPreferencesRoute, async (c) => {
    const data = await writePreferences(
      createDb(c.env),
      currentAuthUser(c).id,
      c.req.valid('json').theme,
    );
    return c.json(apiSuccess(data), 200);
  });
}

const getWorkspaceRoute = createRoute({
  method: 'get',
  path: '/workspace',
  tags: ['Espacio'],
  summary: 'Identidad efectiva del espacio',
  description:
    'Devuelve el nombre, la descripcion, el color y las rutas de los logotipos. No requiere sesion. Si todavia no hay fila, la crea una sola vez con un nombre sugerido a partir del correo del primer administrador.',
  responses: {
    200: {
      description: 'Identidad vigente.',
      content: { 'application/json': { schema: workspaceResponseSchema } },
    },
  },
});

const patchWorkspaceRoute = createRoute({
  method: 'patch',
  path: '/workspace',
  tags: ['Espacio'],
  middleware: [requireAuth, requireRole('admin')] as const,
  summary: 'Actualiza nombre, descripcion o color',
  description:
    'Solo un administrador. Los campos omitidos no se modifican. Guardar `displayName` marca el nombre como personalizado y deja de ser el valor sugerido.',
  request: {
    body: { required: true, content: { 'application/json': { schema: patchBodySchema } } },
  },
  responses: {
    200: {
      description: 'Identidad actualizada.',
      content: { 'application/json': { schema: workspaceResponseSchema } },
    },
    401: errorResponse('Sin sesion activa.'),
    403: errorResponse('La cuenta autenticada no es administradora.'),
    422: errorResponse('Nombre, descripcion o color invalidos.'),
  },
});

const restoreWorkspaceRoute = createRoute({
  method: 'post',
  path: '/workspace/restore',
  tags: ['Espacio'],
  middleware: [requireAuth, requireRole('admin')] as const,
  summary: 'Restaura la identidad compartida',
  description:
    'Vuelve el color a la paleta de marca y regenera el nombre sugerido. No modifica cuentas ni el tema personal.',
  responses: {
    200: {
      description: 'Identidad restaurada.',
      content: { 'application/json': { schema: workspaceResponseSchema } },
    },
    401: errorResponse('Sin sesion activa.'),
    403: errorResponse('La cuenta autenticada no es administradora.'),
  },
});

const getPreferencesRoute = createRoute({
  method: 'get',
  path: '/me/preferences',
  tags: ['Espacio'],
  middleware: [requireAuth] as const,
  summary: 'Preferencias de la cuenta',
  description:
    'Hoy solo incluye el tema. `persisted: false` significa que la cuenta aun no guardo una preferencia y el cliente debe conservar la de este dispositivo.',
  responses: {
    200: {
      description: 'Preferencias de la cuenta autenticada.',
      content: { 'application/json': { schema: preferencesResponseSchema } },
    },
    401: errorResponse('Sin sesion activa.'),
  },
});

const patchPreferencesRoute = createRoute({
  method: 'patch',
  path: '/me/preferences',
  tags: ['Espacio'],
  middleware: [requireAuth] as const,
  summary: 'Guarda el tema de la cuenta',
  request: {
    body: { required: true, content: { 'application/json': { schema: preferencesBodySchema } } },
  },
  responses: {
    200: {
      description: 'Preferencia guardada.',
      content: { 'application/json': { schema: preferencesResponseSchema } },
    },
    401: errorResponse('Sin sesion activa.'),
    422: errorResponse('Tema no admitido.'),
  },
});

import { OpenAPIHono, createRoute, z, type RouteHandler } from '@hono/zod-openapi';
import { errorResponse } from '../../core/http/error-response';
import { apiSuccess } from '../../core/http/responses';
import type { AppEnv } from '../../core/types/context';
import { createDb } from '../../db/client';
import { currentAuthUser, requireAuth, requireRole } from '../auth/auth.middleware';
import { getClientForActor } from '../collaborators/collaborators.service';
import {
  getClientForOwner,
  listVisibleClients,
  patchClient,
  toPublicClient,
} from './clients.service';

const clientSchema = z
  .object({
    id: z.string(),
    slug: z.string(),
    displayName: z.string(),
    nameCustomized: z.boolean(),
    primaryColor: z.string(),
    colorCustomized: z.boolean(),
    status: z.enum(['active', 'disabled']),
  })
  .openapi('Client');

const patchSchema = z
  .object({
    displayName: z.string().trim().min(1).max(80).optional(),
    primaryColor: z.string().trim().optional(),
  })
  .openapi('UpdateClientRequest');

const listRoute = createRoute({
  method: 'get',
  path: '/clients',
  tags: ['Clientes'],
  middleware: [requireAuth, requireRole('admin')],
  summary: 'Lista los espacios de cliente activos',
  responses: {
    200: {
      description: 'Clientes activos.',
      content: {
        'application/json': {
          schema: z.object({ success: z.literal(true), data: z.array(clientSchema) }),
        },
      },
    },
    401: errorResponse('Sin sesion.'),
    403: errorResponse('Solo un administrador ve el listado de clientes.'),
  },
});

const meRoute = createRoute({
  method: 'get',
  path: '/clients/me',
  tags: ['Clientes'],
  middleware: [requireAuth, requireRole('operator')],
  summary: 'Espacio del operador autenticado',
  responses: {
    200: {
      description: 'Cliente propio.',
      content: {
        'application/json': { schema: z.object({ success: z.literal(true), data: clientSchema }) },
      },
    },
    401: errorResponse('Sin sesion.'),
    404: errorResponse('La cuenta no tiene un espacio de cliente.'),
  },
});

const patchRoute = createRoute({
  method: 'patch',
  path: '/clients/me',
  tags: ['Clientes'],
  middleware: [requireAuth, requireRole('operator')],
  summary: 'Actualiza el nombre comercial y el color del cliente',
  request: {
    body: { required: true, content: { 'application/json': { schema: patchSchema } } },
  },
  responses: {
    200: {
      description: 'Cliente actualizado.',
      content: {
        'application/json': { schema: z.object({ success: z.literal(true), data: clientSchema }) },
      },
    },
    401: errorResponse('Sin sesion.'),
    422: errorResponse('El nombre o el color no son validos.'),
  },
});

const listHandler: RouteHandler<typeof listRoute, AppEnv> = async (c) => {
  const rows = await listVisibleClients(createDb(c.env));
  return c.json(apiSuccess(rows.map(toPublicClient)), 200);
};

const meHandler: RouteHandler<typeof meRoute, AppEnv> = async (c) => {
  const row = await getClientForActor(createDb(c.env), currentAuthUser(c).id);
  return c.json(apiSuccess(toPublicClient(row)), 200);
};

const patchHandler: RouteHandler<typeof patchRoute, AppEnv> = async (c) => {
  const actor = currentAuthUser(c);
  const db = createDb(c.env);
  const current = await getClientForOwner(db, actor.id);
  const updated = await patchClient(db, current.id, c.req.valid('json'));
  return c.json(apiSuccess(toPublicClient(updated)), 200);
};

export function registerClientRoutes(app: OpenAPIHono<AppEnv>): void {
  app.openapi(listRoute, listHandler);
  app.openapi(meRoute, meHandler);
  app.openapi(patchRoute, patchHandler);
}

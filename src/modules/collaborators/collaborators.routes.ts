import { OpenAPIHono, createRoute, z, type RouteHandler } from '@hono/zod-openapi';
import { readRuntimeConfig } from '../../config/env';
import { AppError } from '../../core/errors/app-error';
import { ErrorCode } from '../../core/errors/error-codes';
import { errorResponse } from '../../core/http/error-response';
import { apiSuccess } from '../../core/http/responses';
import type { AppEnv } from '../../core/types/context';
import { createDb } from '../../db/client';
import { currentAuthUser, requireAuth, requireRole } from '../auth/auth.middleware';
import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from '../users/users.service';
import {
  PANEL_MODULES,
  addMember,
  createGroup,
  listGroups,
  resolveAccess,
  updateGroup,
} from './collaborators.service';

const moduleSchema = z.enum(PANEL_MODULES);

const memberSchema = z.object({
  id: z.string(),
  userId: z.string(),
  email: z.string(),
  fullName: z.string(),
  status: z.enum(['active', 'disabled']),
});

const groupSchema = z.object({
  id: z.string(),
  name: z.string(),
  modules: z.array(moduleSchema),
  members: z.array(memberSchema),
});

const listRoute = createRoute({
  method: 'get',
  path: '/collaborators',
  tags: ['Colaboradores'],
  middleware: [requireAuth, requireRole('admin', 'operator')],
  summary: 'Lista grupos y colaboradores del espacio',
  responses: {
    200: {
      description: 'Grupos del cliente.',
      content: {
        'application/json': {
          schema: z.object({ success: z.literal(true), data: z.array(groupSchema) }),
        },
      },
    },
    401: errorResponse('Sin sesion.'),
    403: errorResponse('Sin permisos.'),
  },
});

const createGroupRoute = createRoute({
  method: 'post',
  path: '/collaborators/groups',
  tags: ['Colaboradores'],
  middleware: [requireAuth, requireRole('admin', 'operator')],
  summary: 'Crea un grupo de colaboradores',
  request: {
    body: {
      required: true,
      content: {
        'application/json': {
          schema: z.object({
            name: z.string().trim().min(2).max(80),
            modules: z.array(moduleSchema).min(1),
          }),
        },
      },
    },
  },
  responses: {
    201: {
      description: 'Grupo creado.',
      content: {
        'application/json': {
          schema: z.object({ success: z.literal(true), data: groupSchema }),
        },
      },
    },
    401: errorResponse('Sin sesion.'),
  },
});

const updateGroupRoute = createRoute({
  method: 'patch',
  path: '/collaborators/groups/{id}',
  tags: ['Colaboradores'],
  middleware: [requireAuth, requireRole('admin', 'operator')],
  summary: 'Actualiza el nombre o los permisos de un grupo',
  request: {
    params: z.object({ id: z.string().min(1) }),
    body: {
      required: true,
      content: {
        'application/json': {
          schema: z.object({
            name: z.string().trim().min(2).max(80).optional(),
            modules: z.array(moduleSchema).min(1).optional(),
          }),
        },
      },
    },
  },
  responses: {
    200: {
      description: 'Grupo actualizado.',
      content: {
        'application/json': {
          schema: z.object({ success: z.literal(true), data: groupSchema }),
        },
      },
    },
  },
});

const addMemberRoute = createRoute({
  method: 'post',
  path: '/collaborators/groups/{id}/members',
  tags: ['Colaboradores'],
  middleware: [requireAuth, requireRole('admin', 'operator')],
  summary: 'Crea un colaborador dentro de un grupo',
  request: {
    params: z.object({ id: z.string().min(1) }),
    body: {
      required: true,
      content: {
        'application/json': {
          schema: z.object({
            email: z.email().max(320),
            fullName: z.string().trim().min(1).max(160),
            password: z.string().min(PASSWORD_MIN_LENGTH).max(PASSWORD_MAX_LENGTH),
          }),
        },
      },
    },
  },
  responses: {
    201: {
      description: 'Colaborador creado.',
      content: {
        'application/json': {
          schema: z.object({ success: z.literal(true), data: memberSchema }),
        },
      },
    },
  },
});

async function requireOwnerClient(c: Parameters<typeof currentAuthUser>[0]) {
  const actor = currentAuthUser(c);
  const db = createDb(c.env);
  const access = await resolveAccess(db, actor.id, actor.role);
  if (!access.owner || !access.clientId) {
    throw AppError.forbidden(ErrorCode.FORBIDDEN, 'Solo el dueno del espacio administra colaboradores.');
  }
  return { db, clientId: access.clientId };
}

const listHandler: RouteHandler<typeof listRoute, AppEnv> = async (c) => {
  const { db, clientId } = await requireOwnerClient(c);
  return c.json(apiSuccess(await listGroups(db, clientId)), 200);
};

const createGroupHandler: RouteHandler<typeof createGroupRoute, AppEnv> = async (c) => {
  const { db, clientId } = await requireOwnerClient(c);
  const group = await createGroup(db, clientId, c.req.valid('json'));
  return c.json(apiSuccess(group), 201);
};

const updateGroupHandler: RouteHandler<typeof updateGroupRoute, AppEnv> = async (c) => {
  const { db, clientId } = await requireOwnerClient(c);
  const group = await updateGroup(db, clientId, c.req.valid('param').id, c.req.valid('json'));
  return c.json(apiSuccess(group), 200);
};

const addMemberHandler: RouteHandler<typeof addMemberRoute, AppEnv> = async (c) => {
  const { db, clientId } = await requireOwnerClient(c);
  const config = readRuntimeConfig(c.env);
  const member = await addMember(db, clientId, c.req.valid('param').id, c.req.valid('json'), config.auth);
  return c.json(apiSuccess(member), 201);
};

export function registerCollaboratorRoutes(app: OpenAPIHono<AppEnv>): void {
  app.openapi(listRoute, listHandler);
  app.openapi(createGroupRoute, createGroupHandler);
  app.openapi(updateGroupRoute, updateGroupHandler);
  app.openapi(addMemberRoute, addMemberHandler);
}

import { OpenAPIHono, createRoute, z, type RouteHandler } from '@hono/zod-openapi';
import { errorResponse } from '../../core/http/error-response';
import { apiSuccess } from '../../core/http/responses';
import type { AppEnv } from '../../core/types/context';
import { createDb } from '../../db/client';
import { ESTABLISHMENT_STATUSES } from '../../db/schema';
import { requireAuth, requireRole } from '../auth/auth.middleware';
import {
  CODE_MAX_LENGTH,
  CODE_MIN_LENGTH,
  CODE_PATTERN,
  establishmentSchema,
  toEstablishment,
} from './establishments.schemas';
import {
  ESTABLISHMENT_LIST_DEFAULT_LIMIT,
  ESTABLISHMENT_LIST_MAX_LIMIT,
  createEstablishment,
  getEstablishmentById,
  listEstablishmentCatalog,
  updateEstablishment,
} from './establishments.service';

/**
 * Rutas del catalogo de sedes.
 *
 * Lectura, alta y actualizacion para `admin` y `operator`. Una sede no se
 * borra: se desactiva (`status: inactive`), porque
 * las participaciones, registros y accesos historicos la referencian.
 */

const establishmentCodeSchema = z
  .string()
  .trim()
  .min(CODE_MIN_LENGTH)
  .max(CODE_MAX_LENGTH)
  .regex(CODE_PATTERN)
  .openapi({
    example: 'sede-norte',
    description: 'Minusculas, digitos y guiones simples. Inmutable una vez creada la sede.',
  });

const establishmentIdParamSchema = z.object({
  id: z.string().min(1).openapi({
    param: { name: 'id', in: 'path' },
    description: 'Identificador del establecimiento.',
  }),
});

const listEstablishmentsQuerySchema = z
  .object({
    status: z.enum(ESTABLISHMENT_STATUSES).optional(),
    search: z
      .string()
      .trim()
      .min(1)
      .max(120)
      .optional()
      .openapi({ description: 'Filtra por codigo, nombre o ciudad (sin distinguir mayusculas).' }),
    limit: z.coerce
      .number()
      .int()
      .min(1)
      .max(ESTABLISHMENT_LIST_MAX_LIMIT)
      .default(ESTABLISHMENT_LIST_DEFAULT_LIMIT),
    offset: z.coerce.number().int().min(0).default(0),
  })
  .openapi('EstablishmentListQuery');

const establishmentResponseSchema = z
  .object({ success: z.literal(true), data: establishmentSchema })
  .openapi('EstablishmentResponse');

const establishmentListResponseSchema = z
  .object({
    success: z.literal(true),
    data: z.array(establishmentSchema),
    meta: z.object({
      total: z.number().int(),
      limit: z.number().int(),
      offset: z.number().int(),
    }),
  })
  .openapi('EstablishmentListResponse');

const listEstablishmentsRoute = createRoute({
  method: 'get',
  path: '/establishments',
  tags: ['Establecimientos'],
  middleware: [requireAuth, requireRole('admin', 'operator')],
  summary: 'Lista los establecimientos',
  description: [
    'Devuelve las sedes ordenadas por nombre, con filtros opcionales por estado y',
    'texto libre. `meta.total` cuenta todas las filas que cumplen los filtros, no',
    'solo las de la pagina.',
  ].join('\n'),
  request: { query: listEstablishmentsQuerySchema },
  responses: {
    200: {
      description: 'Pagina de establecimientos.',
      content: { 'application/json': { schema: establishmentListResponseSchema } },
    },
    401: errorResponse('Sin sesion activa.'),
    403: errorResponse('La cuenta autenticada no es `admin` ni `operator`.'),
  },
});

const listEstablishmentsHandler: RouteHandler<typeof listEstablishmentsRoute, AppEnv> = async (c) => {
  const page = await listEstablishmentCatalog(createDb(c.env), c.req.valid('query'));

  return c.json(
    apiSuccess(page.items.map(toEstablishment), {
      total: page.total,
      limit: page.limit,
      offset: page.offset,
    }),
    200,
  );
};

const getEstablishmentRoute = createRoute({
  method: 'get',
  path: '/establishments/{id}',
  tags: ['Establecimientos'],
  middleware: [requireAuth, requireRole('admin', 'operator')],
  summary: 'Consulta un establecimiento',
  description: 'Responde 404 con `ESTABLISHMENT_NOT_FOUND` si la sede no existe.',
  request: { params: establishmentIdParamSchema },
  responses: {
    200: {
      description: 'Establecimiento encontrado.',
      content: { 'application/json': { schema: establishmentResponseSchema } },
    },
    401: errorResponse('Sin sesion activa.'),
    403: errorResponse('La cuenta autenticada no es `admin` ni `operator`.'),
    404: errorResponse('El establecimiento no existe (`ESTABLISHMENT_NOT_FOUND`).'),
  },
});

const getEstablishmentHandler: RouteHandler<typeof getEstablishmentRoute, AppEnv> = async (c) => {
  const establishment = await getEstablishmentById(createDb(c.env), c.req.valid('param').id);

  return c.json(apiSuccess(toEstablishment(establishment)), 200);
};

const createEstablishmentBodySchema = z
  .object({
    code: establishmentCodeSchema,
    name: z.string().trim().min(1).max(160),
    city: z.string().trim().max(80).nullable().optional(),
    address: z.string().trim().max(200).nullable().optional(),
    status: z.enum(ESTABLISHMENT_STATUSES).optional(),
  })
  .openapi('CreateEstablishmentRequest');

const createEstablishmentRoute = createRoute({
  method: 'post',
  path: '/establishments',
  tags: ['Establecimientos'],
  middleware: [requireAuth, requireRole('admin', 'operator')],
  summary: 'Crea un establecimiento',
  description: [
    'La sede nace `active` (o en el estado indicado) y conserva el `code` para',
    'siempre.',
    '',
    'Responde 422 con `VALIDATION_ERROR` si el codigo no tiene el formato esperado',
    'y 409 con `ESTABLISHMENT_CODE_ALREADY_USED` si ya existe.',
  ].join('\n'),
  request: {
    body: {
      required: true,
      content: { 'application/json': { schema: createEstablishmentBodySchema } },
    },
  },
  responses: {
    201: {
      description: 'Establecimiento creado.',
      content: { 'application/json': { schema: establishmentResponseSchema } },
    },
    401: errorResponse('Sin sesion activa.'),
    403: errorResponse('La cuenta autenticada no es `admin` ni `operator`.'),
    409: errorResponse('El codigo ya esta en uso (`ESTABLISHMENT_CODE_ALREADY_USED`).'),
    422: errorResponse('El cuerpo no cumple el formato esperado.'),
  },
});

const createEstablishmentHandler: RouteHandler<typeof createEstablishmentRoute, AppEnv> = async (c) => {
  const body = c.req.valid('json');
  const establishment = await createEstablishment(createDb(c.env), {
    code: body.code,
    name: body.name,
    city: body.city ?? null,
    address: body.address ?? null,
    status: body.status,
  });

  return c.json(apiSuccess(toEstablishment(establishment)), 201);
};

const updateEstablishmentBodySchema = z
  .object({
    code: establishmentCodeSchema.optional(),
    name: z.string().trim().min(1).max(160).optional(),
    city: z.string().trim().max(80).nullable().optional(),
    address: z.string().trim().max(200).nullable().optional(),
    status: z.enum(ESTABLISHMENT_STATUSES).optional(),
  })
  .openapi('UpdateEstablishmentRequest');

const updateEstablishmentRoute = createRoute({
  method: 'patch',
  path: '/establishments/{id}',
  tags: ['Establecimientos'],
  middleware: [requireAuth, requireRole('admin', 'operator')],
  summary: 'Actualiza un establecimiento',
  description: [
    'Modifica los campos indicados; los ausentes se mantienen y `null` limpia el',
    'dato. El `code` es inmutable: enviarlo con otro valor responde 422 con el',
    'campo implicado.',
    '',
    'No existe `DELETE`: pasar la sede a `inactive` la retira del catalogo sin',
    'romper la trazabilidad de sus participaciones y registros.',
  ].join('\n'),
  request: {
    params: establishmentIdParamSchema,
    body: {
      required: true,
      content: { 'application/json': { schema: updateEstablishmentBodySchema } },
    },
  },
  responses: {
    200: {
      description: 'Establecimiento actualizado.',
      content: { 'application/json': { schema: establishmentResponseSchema } },
    },
    401: errorResponse('Sin sesion activa.'),
    403: errorResponse('La cuenta autenticada no es `admin` ni `operator`.'),
    404: errorResponse('El establecimiento no existe (`ESTABLISHMENT_NOT_FOUND`).'),
    422: errorResponse('El cuerpo no cumple el formato esperado.'),
  },
});

const updateEstablishmentHandler: RouteHandler<typeof updateEstablishmentRoute, AppEnv> = async (c) => {
  const body = c.req.valid('json');
  const establishment = await updateEstablishment(createDb(c.env), c.req.valid('param').id, {
    code: body.code,
    name: body.name,
    city: body.city,
    address: body.address,
    status: body.status,
  });

  return c.json(apiSuccess(toEstablishment(establishment)), 200);
};

/** Registra las rutas del catalogo de sedes. */
export function registerEstablishmentRoutes(app: OpenAPIHono<AppEnv>): void {
  app.openapi(listEstablishmentsRoute, listEstablishmentsHandler);
  app.openapi(getEstablishmentRoute, getEstablishmentHandler);
  app.openapi(createEstablishmentRoute, createEstablishmentHandler);
  app.openapi(updateEstablishmentRoute, updateEstablishmentHandler);
}

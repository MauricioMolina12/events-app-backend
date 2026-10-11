import { OpenAPIHono, createRoute, z, type RouteHandler } from '@hono/zod-openapi';
import { errorResponse } from '../../core/http/error-response';
import { apiSuccess } from '../../core/http/responses';
import type { AppEnv } from '../../core/types/context';
import { createDb } from '../../db/client';
import { REGISTRATION_STATUSES } from '../../db/schema';
import { requireAuth, requireRole } from '../auth/auth.middleware';
import {
  REGISTRATION_LIST_DEFAULT_LIMIT,
  REGISTRATION_LIST_MAX_LIMIT,
  cancelRegistration,
  createRegistration,
  getRegistrationDetail,
  listRegistrationCatalog,
} from './registrations.service';
import {
  cancelRegistrationRequestSchema,
  createRegistrationRequestSchema,
  registrationDetailSchema,
  registrationSchema,
  toRegistration,
  toRegistrationCompanion,
} from './registrations.schemas';

/**
 * Rutas de registros para el panel.
 *
 * El alta publica vive en `/public/registrations` (modulo de composicion): aqui
 * estan las operaciones de la mesa de registro, que comparten `admin` y `operator`
 * porque son parte de la jornada (atender, buscar y cancelar un registro), no de
 * la configuracion del catalogo.
 */

const registrationIdParamSchema = z.object({
  id: z.string().min(1).openapi({
    param: { name: 'id', in: 'path' },
    description: 'Identificador del registro.',
  }),
});

const listRegistrationsQuerySchema = z
  .object({
    participationId: z.string().min(1).optional().openapi({
      description: 'Filtra por sede del evento (la unidad de cupo).',
    }),
    status: z.enum(REGISTRATION_STATUSES).optional(),
    search: z
      .string()
      .trim()
      .min(1)
      .max(120)
      .optional()
      .openapi({ description: 'Filtra por nombre, documento o email (sin distinguir mayusculas).' }),
    limit: z.coerce
      .number()
      .int()
      .min(1)
      .max(REGISTRATION_LIST_MAX_LIMIT)
      .default(REGISTRATION_LIST_DEFAULT_LIMIT),
    offset: z.coerce.number().int().min(0).default(0),
  })
  .openapi('RegistrationListQuery');

const registrationResponseSchema = z
  .object({ success: z.literal(true), data: registrationSchema })
  .openapi('RegistrationResponse');

const registrationDetailResponseSchema = z
  .object({ success: z.literal(true), data: registrationDetailSchema })
  .openapi('RegistrationDetailResponse');

const registrationListResponseSchema = z
  .object({
    success: z.literal(true),
    data: z.array(registrationSchema),
    meta: z.object({
      total: z.number().int(),
      limit: z.number().int(),
      offset: z.number().int(),
    }),
  })
  .openapi('RegistrationListResponse');

const listRegistrationsRoute = createRoute({
  method: 'get',
  path: '/registrations',
  tags: ['Registros'],
  middleware: [requireAuth, requireRole('admin', 'operator')],
  summary: 'Lista los registros',
  description: [
    'Devuelve los registros ordenados por fecha de alta descendente, con filtros por',
    'sede, estado y texto libre sobre el nombre, el documento o el email.',
    '',
    'Un listado sin `participationId` recorre todas las sedes: `meta.total` acota el',
    'universo y conviene paginar con `limit` y `offset`.',
  ].join('\n'),
  request: { query: listRegistrationsQuerySchema },
  responses: {
    200: {
      description: 'Pagina de registros.',
      content: { 'application/json': { schema: registrationListResponseSchema } },
    },
    401: errorResponse('Sin sesion activa.'),
    403: errorResponse('La cuenta autenticada no es `admin` ni `operator`.'),
  },
});

const listRegistrationsHandler: RouteHandler<typeof listRegistrationsRoute, AppEnv> = async (c) => {
  const page = await listRegistrationCatalog(createDb(c.env), c.req.valid('query'));

  return c.json(
    apiSuccess(page.items.map(toRegistration), {
      total: page.total,
      limit: page.limit,
      offset: page.offset,
    }),
    200,
  );
};

const getRegistrationRoute = createRoute({
  method: 'get',
  path: '/registrations/{id}',
  tags: ['Registros'],
  middleware: [requireAuth, requireRole('admin', 'operator')],
  summary: 'Consulta un registro',
  description: [
    'Devuelve el registro con sus acompanantes y el cupo que consume',
    '(`companionsCount`). Responde 404 con `REGISTRATION_NOT_FOUND`.',
  ].join('\n'),
  request: { params: registrationIdParamSchema },
  responses: {
    200: {
      description: 'Registro encontrado.',
      content: { 'application/json': { schema: registrationDetailResponseSchema } },
    },
    401: errorResponse('Sin sesion activa.'),
    403: errorResponse('La cuenta autenticada no es `admin` ni `operator`.'),
    404: errorResponse('El registro no existe (`REGISTRATION_NOT_FOUND`).'),
  },
});

const getRegistrationHandler: RouteHandler<typeof getRegistrationRoute, AppEnv> = async (c) => {
  const detail = await getRegistrationDetail(createDb(c.env), c.req.valid('param').id);

  return c.json(
    apiSuccess({
      ...toRegistration(detail.registration),
      companions: detail.companions.map(toRegistrationCompanion),
    }),
    200,
  );
};

const createRegistrationRoute = createRoute({
  method: 'post',
  path: '/registrations',
  tags: ['Registros'],
  middleware: [requireAuth, requireRole('admin', 'operator')],
  summary: 'Registra a una persona desde el panel',
  description: [
    'Alta manual: la mesa de registro atiende a quien llega sin formulario. El',
    'registro queda marcado con `source: admin`.',
    '',
    'El cupo de la sede se reserva antes de escribir. Si la sede cerro entre la',
    'consulta y la reserva, o el cupo esta completo, responde 409 con',
    '`TITULAR_CAPACITY_EXCEEDED` o `COMPANION_CAPACITY_EXCEEDED`.',
    '',
    'Un documento solo puede ocupar **un lugar por evento**, sea de titular o de',
    'acompanante: el segundo intento responde 409 con `DUPLICATE_DOCUMENT` y',
    '`details` indica el documento normalizado, el rol con el que se intentaba, el rol',
    'con el que ya existe (`holder` o `companion`) y el campo a senalar. El documento',
    'se normaliza antes de comparar: `1.020.304.000` y `1020304000` son el mismo.',
    'Cancelar el registro libera el documento, de modo que la persona puede volver a',
    'inscribirse.',
  ].join('\n'),
  request: {
    body: {
      required: true,
      content: { 'application/json': { schema: createRegistrationRequestSchema } },
    },
  },
  responses: {
    201: {
      description: 'Registro creado.',
      content: { 'application/json': { schema: registrationDetailResponseSchema } },
    },
    401: errorResponse('Sin sesion activa.'),
    403: errorResponse('La cuenta autenticada no es `admin` ni `operator`.'),
    404: errorResponse('La sede no existe (`PARTICIPATION_NOT_FOUND`) o su evento no (`EVENT_NOT_FOUND`).'),
    409: errorResponse(
      'Cupo agotado de titulares o acompanantes, documento ya registrado en el evento (`DUPLICATE_DOCUMENT`), sede cerrada (`PARTICIPATION_CLOSED`), evento no publicado (`EVENT_NOT_REGISTRABLE`) o fuera de la ventana (`REGISTRATION_OUTSIDE_WINDOW`).',
    ),
    422: errorResponse(
      'El cuerpo no cumple el formato o la coherencia esperada (por ejemplo, el mismo documento dos veces en la misma solicitud).',
    ),
  },
});

const createRegistrationHandler: RouteHandler<typeof createRegistrationRoute, AppEnv> = async (c) => {
  const body = c.req.valid('json');
  const detail = await createRegistration(
    createDb(c.env),
    {
      participationId: body.participationId,
      documentType: body.documentType,
      documentNumber: body.documentNumber,
      fullName: body.fullName,
      email: body.email,
      phone: body.phone,
      requiresElectronicInvoice: body.requiresElectronicInvoice,
      companions: body.companions,
      source: 'admin',
    },
  );

  return c.json(
    apiSuccess({
      ...toRegistration(detail.registration),
      companions: detail.companions.map(toRegistrationCompanion),
    }),
    201,
  );
};

const cancelRegistrationRoute = createRoute({
  method: 'post',
  path: '/registrations/{id}/cancel',
  tags: ['Registros'],
  middleware: [requireAuth, requireRole('admin', 'operator')],
  summary: 'Cancela un registro',
  description: [
    'El motivo es obligatorio: queda guardado junto a la fecha de cancelacion, que',
    'es lo que despues explica por que volvio el cupo.',
    '',
    'En la misma operacion se devuelve el cupo del titular y de sus acompanantes y se',
    'revoca el QR activo; el documento queda libre para volver a registrarse. Un',
    'registro ya cancelado responde 409 con `REGISTRATION_ALREADY_CANCELLED`.',
  ].join('\n'),
  request: {
    params: registrationIdParamSchema,
    body: {
      required: true,
      content: { 'application/json': { schema: cancelRegistrationRequestSchema } },
    },
  },
  responses: {
    200: {
      description: 'Registro cancelado.',
      content: { 'application/json': { schema: registrationResponseSchema } },
    },
    401: errorResponse('Sin sesion activa.'),
    403: errorResponse('La cuenta autenticada no es `admin` ni `operator`.'),
    404: errorResponse('El registro no existe (`REGISTRATION_NOT_FOUND`).'),
    409: errorResponse('El registro ya estaba cancelado (`REGISTRATION_ALREADY_CANCELLED`).'),
    422: errorResponse('El motivo no cumple el formato esperado.'),
  },
});

const cancelRegistrationHandler: RouteHandler<typeof cancelRegistrationRoute, AppEnv> = async (c) => {
  const cancelled = await cancelRegistration(createDb(c.env), c.req.valid('param').id, {
    reason: c.req.valid('json').reason,
  });

  return c.json(apiSuccess(toRegistration(cancelled)), 200);
};

/** Registra las rutas de registros del panel. */
export function registerRegistrationRoutes(app: OpenAPIHono<AppEnv>): void {
  app.openapi(listRegistrationsRoute, listRegistrationsHandler);
  app.openapi(getRegistrationRoute, getRegistrationHandler);
  app.openapi(createRegistrationRoute, createRegistrationHandler);
  app.openapi(cancelRegistrationRoute, cancelRegistrationHandler);
}

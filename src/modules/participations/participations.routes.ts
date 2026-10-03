import { OpenAPIHono, createRoute, z, type RouteHandler } from '@hono/zod-openapi';
import { errorResponse } from '../../core/http/error-response';
import { apiSuccess } from '../../core/http/responses';
import type { AppEnv } from '../../core/types/context';
import { createDb } from '../../db/client';
import { fromIsoString } from '../../db/helpers';
import { PARTICIPATION_STATUSES } from '../../db/schema';
import { requireAuth, requireRole } from '../auth/auth.middleware';
import { participationSchema, toParticipation } from './participations.schemas';
import {
  PARTICIPATION_LIST_DEFAULT_LIMIT,
  PARTICIPATION_LIST_MAX_LIMIT,
  createParticipation,
  getParticipationDetail,
  listParticipationCatalog,
  updateParticipation,
} from './participations.service';

/**
 * Rutas del catalogo de participaciones (una sede dentro de un evento).
 *
 * Es el catalogo donde se dimensiona cada sede: los cupos y las ventanas propias
 * viven aqui, no en el evento. La lectura la comparten `admin` y `operator`; la
 * escritura es exclusiva del `admin`.
 */

/** Fecha ISO-8601 en UTC; `null` limpia el campo. */
const participationDateSchema = z
  .iso.datetime()
  .openapi({
    example: '2026-04-25T15:00:00.000Z',
    description: 'ISO-8601 en UTC. `null` borra la fecha.',
  })
  .nullable()
  .optional();

const participationIdParamSchema = z.object({
  id: z.string().min(1).openapi({
    param: { name: 'id', in: 'path' },
    description: 'Identificador de la participacion.',
  }),
});

const listParticipationsQuerySchema = z
  .object({
    eventId: z.string().min(1).optional(),
    establishmentId: z.string().min(1).optional(),
    status: z.enum(PARTICIPATION_STATUSES).optional(),
    limit: z.coerce
      .number()
      .int()
      .min(1)
      .max(PARTICIPATION_LIST_MAX_LIMIT)
      .default(PARTICIPATION_LIST_DEFAULT_LIMIT),
    offset: z.coerce.number().int().min(0).default(0),
  })
  .openapi('ParticipationListQuery');

const participationResponseSchema = z
  .object({ success: z.literal(true), data: participationSchema })
  .openapi('ParticipationResponse');

const participationListResponseSchema = z
  .object({
    success: z.literal(true),
    data: z.array(participationSchema),
    meta: z.object({
      total: z.number().int(),
      limit: z.number().int(),
      offset: z.number().int(),
    }),
  })
  .openapi('ParticipationListResponse');

const listParticipationsRoute = createRoute({
  method: 'get',
  path: '/participations',
  tags: ['Participaciones'],
  middleware: [requireAuth, requireRole('admin', 'operator')],
  summary: 'Lista las participaciones',
  description: [
    'Devuelve las sedes participantes con su establecimiento ya resuelto y el cupo',
    'disponible (`available*`). Se filtra por evento, sede y estado.',
    '',
    'Un listado sin `eventId` recorre todo el catalogo: `meta.total` acota el',
    'universo y conviene paginar con `limit` y `offset`.',
  ].join('\n'),
  request: { query: listParticipationsQuerySchema },
  responses: {
    200: {
      description: 'Pagina de participaciones.',
      content: { 'application/json': { schema: participationListResponseSchema } },
    },
    401: errorResponse('Sin sesion activa.'),
    403: errorResponse('La cuenta autenticada no es `admin` ni `operator`.'),
  },
});

const listParticipationsHandler: RouteHandler<typeof listParticipationsRoute, AppEnv> = async (c) => {
  const page = await listParticipationCatalog(createDb(c.env), c.req.valid('query'));

  return c.json(
    apiSuccess(
      page.items.map((item) => toParticipation(item.participation, item.establishment)),
      { total: page.total, limit: page.limit, offset: page.offset },
    ),
    200,
  );
};

const getParticipationRoute = createRoute({
  method: 'get',
  path: '/participations/{id}',
  tags: ['Participaciones'],
  middleware: [requireAuth, requireRole('admin', 'operator')],
  summary: 'Consulta una participacion',
  description: 'Responde 404 con `PARTICIPATION_NOT_FOUND` si la sede no participa en el evento.',
  request: { params: participationIdParamSchema },
  responses: {
    200: {
      description: 'Participacion encontrada.',
      content: { 'application/json': { schema: participationResponseSchema } },
    },
    401: errorResponse('Sin sesion activa.'),
    403: errorResponse('La cuenta autenticada no es `admin` ni `operator`.'),
    404: errorResponse('La participacion no existe (`PARTICIPATION_NOT_FOUND`).'),
  },
});

const getParticipationHandler: RouteHandler<typeof getParticipationRoute, AppEnv> = async (c) => {
  const view = await getParticipationDetail(createDb(c.env), c.req.valid('param').id);

  return c.json(apiSuccess(toParticipation(view.participation, view.establishment)), 200);
};

const createParticipationBodySchema = z
  .object({
    eventId: z.string().min(1).openapi({ description: 'Evento al que se suma la sede.' }),
    establishmentId: z.string().min(1).openapi({ description: 'Sede que participa.' }),
    titularCapacity: z.number().int().min(0).max(100_000),
    companionCapacity: z.number().int().min(0).max(100_000),
    status: z.enum(PARTICIPATION_STATUSES).optional(),
    registrationOpensAt: participationDateSchema,
    registrationClosesAt: participationDateSchema,
    checkInOpensAt: participationDateSchema,
    checkInClosesAt: participationDateSchema,
    notes: z.string().trim().max(500).nullable().optional(),
  })
  .openapi('CreateParticipationRequest');

const createParticipationRoute = createRoute({
  method: 'post',
  path: '/participations',
  tags: ['Participaciones'],
  middleware: [requireAuth, requireRole('admin')],
  summary: 'Agrega una sede a un evento',
  description: [
    'Crea la participacion con sus cupos iniciales. Aqui el cupo se fija sin',
    'restriccion: todavia no hay registros confirmados que proteger.',
    '',
    'Responde 404 con `EVENT_NOT_FOUND` o `ESTABLISHMENT_NOT_FOUND`; 409 con',
    '`PARTICIPATION_ALREADY_EXISTS` si la sede ya participa en el evento, con',
    '`EVENT_NOT_REGISTRABLE` si el evento esta cerrado o archivado, y 422 si la sede',
    'esta inactiva o una ventana quedo invertida.',
  ].join('\n'),
  request: {
    body: {
      required: true,
      content: { 'application/json': { schema: createParticipationBodySchema } },
    },
  },
  responses: {
    201: {
      description: 'Participacion creada.',
      content: { 'application/json': { schema: participationResponseSchema } },
    },
    401: errorResponse('Sin sesion activa.'),
    403: errorResponse('La cuenta autenticada no es administradora.'),
    404: errorResponse('El evento o el establecimiento no existen.'),
    409: errorResponse(
      'La sede ya participa (`PARTICIPATION_ALREADY_EXISTS`) o el evento no admite nuevas sedes (`EVENT_NOT_REGISTRABLE`).',
    ),
    422: errorResponse('El cuerpo no cumple el formato o la coherencia esperada.'),
  },
});

const createParticipationHandler: RouteHandler<typeof createParticipationRoute, AppEnv> = async (c) => {
  const body = c.req.valid('json');
  const view = await createParticipation(createDb(c.env), {
    eventId: body.eventId,
    establishmentId: body.establishmentId,
    titularCapacity: body.titularCapacity,
    companionCapacity: body.companionCapacity,
    status: body.status,
    registrationOpensAt: toDateOrNull(body.registrationOpensAt),
    registrationClosesAt: toDateOrNull(body.registrationClosesAt),
    checkInOpensAt: toDateOrNull(body.checkInOpensAt),
    checkInClosesAt: toDateOrNull(body.checkInClosesAt),
    notes: body.notes ?? null,
  });

  return c.json(apiSuccess(toParticipation(view.participation, view.establishment)), 201);
};

const updateParticipationBodySchema = z
  .object({
    eventId: z.string().min(1).optional(),
    establishmentId: z.string().min(1).optional(),
    status: z.enum(PARTICIPATION_STATUSES).optional(),
    titularCapacity: z.number().int().min(0).max(100_000).optional(),
    companionCapacity: z.number().int().min(0).max(100_000).optional(),
    registrationOpensAt: participationDateSchema,
    registrationClosesAt: participationDateSchema,
    checkInOpensAt: participationDateSchema,
    checkInClosesAt: participationDateSchema,
    notes: z.string().trim().max(500).nullable().optional(),
  })
  .openapi('UpdateParticipationRequest');

const updateParticipationRoute = createRoute({
  method: 'patch',
  path: '/participations/{id}',
  tags: ['Participaciones'],
  middleware: [requireAuth, requireRole('admin')],
  summary: 'Actualiza una participacion',
  description: [
    'Modifica estado, cupos, ventanas o notas; los campos ausentes se mantienen y',
    '`null` limpia una fecha. `eventId` y `establishmentId` son inmutables.',
    '',
    'Reglas de negocio: 409 con `CAPACITY_ADJUSTMENT_REQUIRED` si se cambia el cupo',
    'habiendo registros confirmados (ese cambio entra por el flujo de aprobacion de',
    'la Fase 5), 409 con `PARTICIPATION_HAS_REGISTRATIONS` al cancelar una sede con',
    'registros confirmados y 409 con `STATUS_TRANSITION_INVALID` si la transicion no',
    'esta permitida (`cancelled` es terminal).',
  ].join('\n'),
  request: {
    params: participationIdParamSchema,
    body: {
      required: true,
      content: { 'application/json': { schema: updateParticipationBodySchema } },
    },
  },
  responses: {
    200: {
      description: 'Participacion actualizada.',
      content: { 'application/json': { schema: participationResponseSchema } },
    },
    401: errorResponse('Sin sesion activa.'),
    403: errorResponse('La cuenta autenticada no es administradora.'),
    404: errorResponse('La participacion no existe (`PARTICIPATION_NOT_FOUND`).'),
    409: errorResponse(
      'Cupo con registros confirmados (`CAPACITY_ADJUSTMENT_REQUIRED`), cancelacion con registros (`PARTICIPATION_HAS_REGISTRATIONS`) o transicion no permitida (`STATUS_TRANSITION_INVALID`).',
    ),
    422: errorResponse('El cuerpo no cumple el formato o la coherencia esperada.'),
  },
});

const updateParticipationHandler: RouteHandler<typeof updateParticipationRoute, AppEnv> = async (c) => {
  const body = c.req.valid('json');
  const view = await updateParticipation(createDb(c.env), c.req.valid('param').id, {
    eventId: body.eventId,
    establishmentId: body.establishmentId,
    status: body.status,
    titularCapacity: body.titularCapacity,
    companionCapacity: body.companionCapacity,
    registrationOpensAt: toDateOrNull(body.registrationOpensAt),
    registrationClosesAt: toDateOrNull(body.registrationClosesAt),
    checkInOpensAt: toDateOrNull(body.checkInOpensAt),
    checkInClosesAt: toDateOrNull(body.checkInClosesAt),
    notes: body.notes,
  });

  return c.json(apiSuccess(toParticipation(view.participation, view.establishment)), 200);
};

/** Convierte un ISO-8601 del cuerpo a `Date`; conserva `null` y `undefined`. */
function toDateOrNull(value: string | null | undefined): Date | null | undefined {
  return value === null || value === undefined ? value : fromIsoString(value);
}

/** Registra las rutas del catalogo de participaciones. */
export function registerParticipationRoutes(app: OpenAPIHono<AppEnv>): void {
  app.openapi(listParticipationsRoute, listParticipationsHandler);
  app.openapi(getParticipationRoute, getParticipationHandler);
  app.openapi(createParticipationRoute, createParticipationHandler);
  app.openapi(updateParticipationRoute, updateParticipationHandler);
}

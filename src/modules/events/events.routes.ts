import { OpenAPIHono, createRoute, z, type RouteHandler } from '@hono/zod-openapi';
import { AppError } from '../../core/errors/app-error';
import { ErrorCode } from '../../core/errors/error-codes';
import { errorResponse } from '../../core/http/error-response';
import { apiSuccess } from '../../core/http/responses';
import type { AppEnv } from '../../core/types/context';
import { createDb } from '../../db/client';
import { fromIsoString } from '../../db/helpers';
import { EVENT_STATUSES, REGISTRATION_SCOPES } from '../../db/schema';
import { currentAuthUser, requireAuth, requireRole } from '../auth/auth.middleware';
import { findClientById, findClientByOwner, listClients } from '../clients/clients.repository';
import { getUserById } from '../users/users.service';
import { assertCanManageEvent } from './event-access';
import { EVENT_CAPACITY_MAX } from './event-capacity';
import {
  SLUG_MAX_LENGTH,
  SLUG_MIN_LENGTH,
  SLUG_PATTERN,
  eventSchema,
  ticketDesignSchema,
  toEvent,
  type EventClientSummary,
} from './events.schemas';
import type { EventRow } from './events.repository';
import {
  EVENT_LIST_DEFAULT_LIMIT,
  EVENT_LIST_MAX_LIMIT,
  createEvent,
  getEventById,
  getEventByReference,
  listEventCatalog,
  updateEvent,
} from './events.service';

/**
 * Rutas del catalogo de eventos.
 *
 * La lectura la comparten `admin` y `operator`. El operador solo ve y edita los
 * eventos que un administrador le asigno (`createdBy`). Crear un evento es
 * exclusivo del administrador.
 * El catalogo publico, limitado a eventos publicados y con la disponibilidad de
 * cupos, llega con el registro publico de la Fase 5.
 */

/** Fecha ISO-8601 en UTC; `null` limpia el campo. */
const eventDateSchema = z
  .iso.datetime()
  .openapi({
    example: '2026-04-25T15:00:00.000Z',
    description: 'ISO-8601 en UTC. `null` borra la fecha.',
  })
  .nullable()
  .optional();

const eventSlugSchema = z
  .string()
  .trim()
  .min(SLUG_MIN_LENGTH)
  .max(SLUG_MAX_LENGTH)
  .regex(SLUG_PATTERN)
  .openapi({
    example: 'dia-del-nino-2026',
    description: 'Minusculas, digitos y guiones simples. Inmutable una vez creado el evento.',
  });

const eventReferenceParamSchema = z.object({
  idOrSlug: z.string().min(1).openapi({
    param: { name: 'idOrSlug', in: 'path' },
    description: 'Identificador del evento o su slug.',
  }),
});

const eventIdParamSchema = z.object({
  id: z.string().min(1).openapi({
    param: { name: 'id', in: 'path' },
    description: 'Identificador del evento.',
  }),
});

const listEventsQuerySchema = z
  .object({
    status: z.enum(EVENT_STATUSES).optional(),
    search: z
      .string()
      .trim()
      .min(1)
      .max(120)
      .optional()
      .openapi({ description: 'Filtra por slug o nombre (sin distinguir mayusculas).' }),
    limit: z.coerce.number().int().min(1).max(EVENT_LIST_MAX_LIMIT).default(EVENT_LIST_DEFAULT_LIMIT),
    offset: z.coerce.number().int().min(0).default(0),
  })
  .openapi('EventListQuery');

const eventResponseSchema = z
  .object({ success: z.literal(true), data: eventSchema })
  .openapi('EventResponse');

const eventListResponseSchema = z
  .object({
    success: z.literal(true),
    data: z.array(eventSchema),
    meta: z.object({
      total: z.number().int(),
      limit: z.number().int(),
      offset: z.number().int(),
    }),
  })
  .openapi('EventListResponse');

const listEventsRoute = createRoute({
  method: 'get',
  path: '/events',
  tags: ['Eventos'],
  middleware: [requireAuth, requireRole('admin', 'operator')],
  summary: 'Lista los eventos',
  description: [
    'Devuelve el catalogo ordenado por alta descendente, con filtros opcionales',
    'por estado y texto libre. `meta.total` cuenta todas las filas que cumplen los',
    'filtros, no solo las de la pagina.',
    '',
    'El operador solo recibe los eventos cuyo dueno es el (`createdBy`). El',
    'administrador opera todo el catalogo.',
  ].join('\n'),
  request: { query: listEventsQuerySchema },
  responses: {
    200: {
      description: 'Pagina de eventos.',
      content: { 'application/json': { schema: eventListResponseSchema } },
    },
    401: errorResponse('Sin sesion activa.'),
    403: errorResponse('La cuenta autenticada no es `admin` ni `operator`.'),
  },
});

const listEventsHandler: RouteHandler<typeof listEventsRoute, AppEnv> = async (c) => {
  const actor = currentAuthUser(c);
  const query = c.req.valid('query');
  const db = createDb(c.env);
  const page = await listEventCatalog(db, {
    ...query,
    createdBy: actor.role === 'operator' ? actor.id : undefined,
  });

  return c.json(
    apiSuccess(await presentEvents(db, page.items), {
      total: page.total,
      limit: page.limit,
      offset: page.offset,
    }),
    200,
  );
};

const getEventRoute = createRoute({
  method: 'get',
  path: '/events/{idOrSlug}',
  tags: ['Eventos'],
  middleware: [requireAuth, requireRole('admin', 'operator')],
  summary: 'Consulta un evento',
  description: [
    'Acepta el identificador o el slug del evento: el slug es el que aparece en',
    'las URL publicas. Responde 404 con `EVENT_NOT_FOUND` si no existe.',
  ].join('\n'),
  request: { params: eventReferenceParamSchema },
  responses: {
    200: {
      description: 'Evento encontrado.',
      content: { 'application/json': { schema: eventResponseSchema } },
    },
    401: errorResponse('Sin sesion activa.'),
    403: errorResponse('La cuenta autenticada no es `admin` ni `operator`.'),
    404: errorResponse('El evento no existe (`EVENT_NOT_FOUND`).'),
  },
});

const getEventHandler: RouteHandler<typeof getEventRoute, AppEnv> = async (c) => {
  const db = createDb(c.env);
  const event = await getEventByReference(db, c.req.valid('param').idOrSlug);
  assertCanManageEvent(currentAuthUser(c), event);
  return c.json(apiSuccess(await presentEvent(db, event)), 200);
};

const createEventBodySchema = z
  .object({
    slug: eventSlugSchema,
    name: z.string().trim().min(1).max(160),
    description: z.string().trim().max(1000).nullable().optional(),
    timezone: z
      .string()
      .trim()
      .min(1)
      .max(64)
      .optional()
      .openapi({ example: 'America/Bogota', description: 'Zona IANA de presentacion.' }),
    startsAt: eventDateSchema,
    endsAt: eventDateSchema,
    registrationOpensAt: eventDateSchema,
    registrationClosesAt: eventDateSchema,
    capacity: z.number().int().min(0).max(EVENT_CAPACITY_MAX).openapi({
      example: 200,
      description:
        'Cupo general del evento. La suma de titulares y acompanantes de las sedes no puede superarlo.',
    }),
    status: z.enum(EVENT_STATUSES).optional(),
    ownerId: z
      .string()
      .min(1)
      .optional()
      .openapi({
        description:
          'Operador activo al que queda asignado el evento. Si se omite, el dueno es el administrador que lo crea.',
      }),
    registrationScope: z.enum(REGISTRATION_SCOPES).optional(),
    ticketDesign: ticketDesignSchema.nullable().optional(),
  })
  .openapi('CreateEventRequest');

const createEventRoute = createRoute({
  method: 'post',
  path: '/events',
  tags: ['Eventos'],
  middleware: [requireAuth, requireRole('admin')],
  summary: 'Crea un evento',
  description: [
    'El evento nace en `draft` (o en el estado indicado) y conserva el `slug` para',
    'siempre: es el identificador publico del evento.',
    '',
    'Validaciones: 422 con `VALIDATION_ERROR` si el slug no tiene el formato',
    'esperado, si la zona horaria no existe o si una ventana de tiempo esta',
    'invertida (`endsAt` antes de `startsAt`, o cierre de registro antes de la',
    'apertura); 409 con `STATUS_TRANSITION_INVALID` si se intenta crear el evento',
    'directamente en `closed`; 409 con `EVENT_SLUG_ALREADY_USED` si el slug ya',
    'existe; y `capacity` es el techo de personas que se reparte entre las sedes.',
  ].join('\n'),
  request: {
    body: {
      required: true,
      content: { 'application/json': { schema: createEventBodySchema } },
    },
  },
  responses: {
    201: {
      description: 'Evento creado.',
      content: { 'application/json': { schema: eventResponseSchema } },
    },
    401: errorResponse('Sin sesion activa.'),
    403: errorResponse('La cuenta autenticada no es administradora.'),
    409: errorResponse(
      'El slug ya esta en uso (`EVENT_SLUG_ALREADY_USED`) o el estado inicial no es alcanzable (`STATUS_TRANSITION_INVALID`).',
    ),
    422: errorResponse('El cuerpo no cumple el formato o la coherencia esperada.'),
  },
});

const createEventHandler: RouteHandler<typeof createEventRoute, AppEnv> = async (c) => {
  const body = c.req.valid('json');
  const db = createDb(c.env);
  const createdBy = await resolveEventOwner(db, body.ownerId, currentAuthUser(c).id);
  const ownerClient = await findClientByOwner(db, createdBy);
  const event = await createEvent(db, {
    slug: body.slug,
    name: body.name,
    description: body.description ?? null,
    timezone: body.timezone,
    startsAt: toDateOrNull(body.startsAt),
    endsAt: toDateOrNull(body.endsAt),
    registrationOpensAt: toDateOrNull(body.registrationOpensAt),
    registrationClosesAt: toDateOrNull(body.registrationClosesAt),
    capacity: body.capacity,
    status: body.status,
    createdBy,
    clientId: ownerClient?.id ?? null,
    registrationScope: body.registrationScope,
    ticketDesign: body.ticketDesign === undefined ? undefined : serializeDesign(body.ticketDesign),
  });

  return c.json(apiSuccess(await presentEvent(db, event)), 201);
};

const updateEventBodySchema = z
  .object({
    slug: eventSlugSchema.optional(),
    name: z.string().trim().min(1).max(160).optional(),
    description: z.string().trim().max(1000).nullable().optional(),
    timezone: z.string().trim().min(1).max(64).optional(),
    startsAt: eventDateSchema,
    endsAt: eventDateSchema,
    registrationOpensAt: eventDateSchema,
    registrationClosesAt: eventDateSchema,
    capacity: z.number().int().min(0).max(EVENT_CAPACITY_MAX).optional(),
    status: z.enum(EVENT_STATUSES).optional(),
    registrationScope: z.enum(REGISTRATION_SCOPES).optional(),
    ticketDesign: ticketDesignSchema.nullable().optional(),
  })
  .openapi('UpdateEventRequest');

const updateEventRoute = createRoute({
  method: 'patch',
  path: '/events/{id}',
  tags: ['Eventos'],
  middleware: [requireAuth, requireRole('admin', 'operator')],
  summary: 'Actualiza un evento',
  description: [
    'Modifica los campos indicados; los ausentes se mantienen y `null` limpia una',
    'fecha. El `slug` es inmutable: enviarlo con otro valor responde 422 con el',
    'campo implicado.',
    '',
    'Los cambios de estado siguen el ciclo de vida `draft -> published -> closed ->',
    'archived` (reabrir el registro es `closed -> published`); `archived` es',
    'terminal y cualquier salto no admitido responde 409 con',
    '`STATUS_TRANSITION_INVALID`. Bajar `capacity` por debajo de lo ya asignado',
    'a las sedes responde 409 con `EVENT_CAPACITY_EXCEEDED`.',
  ].join('\n'),
  request: {
    params: eventIdParamSchema,
    body: {
      required: true,
      content: { 'application/json': { schema: updateEventBodySchema } },
    },
  },
  responses: {
    200: {
      description: 'Evento actualizado.',
      content: { 'application/json': { schema: eventResponseSchema } },
    },
    401: errorResponse('Sin sesion activa.'),
    403: errorResponse(
      'La cuenta no es administradora o el operador no es dueno de este evento.',
    ),
    404: errorResponse('El evento no existe (`EVENT_NOT_FOUND`).'),
    409: errorResponse(
      'El cambio de estado no esta permitido (`STATUS_TRANSITION_INVALID`) o el cupo general queda por debajo de lo asignado (`EVENT_CAPACITY_EXCEEDED`).',
    ),
    422: errorResponse('El cuerpo no cumple el formato o la coherencia esperada.'),
  },
});

const updateEventHandler: RouteHandler<typeof updateEventRoute, AppEnv> = async (c) => {
  const body = c.req.valid('json');
  const db = createDb(c.env);
  const existing = await getEventById(db, c.req.valid('param').id);
  assertCanManageEvent(currentAuthUser(c), existing);
  const event = await updateEvent(db, existing.id, {
    slug: body.slug,
    name: body.name,
    description: body.description,
    timezone: body.timezone,
    startsAt: toDateOrNull(body.startsAt),
    endsAt: toDateOrNull(body.endsAt),
    registrationOpensAt: toDateOrNull(body.registrationOpensAt),
    registrationClosesAt: toDateOrNull(body.registrationClosesAt),
    capacity: body.capacity,
    status: body.status,
    registrationScope: body.registrationScope,
    ticketDesign: body.ticketDesign === undefined ? undefined : serializeDesign(body.ticketDesign),
  });

  return c.json(apiSuccess(await presentEvent(db, event)), 200);
};

/**
 * El evento queda a nombre del operador elegido. Sin `ownerId`, el dueno es
 * el administrador que lo crea.
 */
async function resolveEventOwner(
  db: ReturnType<typeof createDb>,
  ownerId: string | undefined,
  adminId: string,
): Promise<string> {
  if (ownerId === undefined) {
    return adminId;
  }

  const owner = await getUserById(db, ownerId);
  if (owner.role !== 'operator' || owner.status !== 'active') {
    throw AppError.badRequest(
      ErrorCode.VALIDATION_ERROR,
      'El cliente del evento debe ser un operador activo.',
    );
  }

  return owner.id;
}

function clientSummary(
  row: { id: string; slug: string; displayName: string } | null | undefined,
): EventClientSummary | null {
  return row ? { id: row.id, slug: row.slug, displayName: row.displayName } : null;
}

async function presentEvent(db: Parameters<typeof findClientById>[0], event: EventRow) {
  const client = event.clientId ? await findClientById(db, event.clientId) : null;
  return toEvent(event, clientSummary(client));
}

async function presentEvents(db: Parameters<typeof listClients>[0], rows: readonly EventRow[]) {
  const catalog = await listClients(db);
  const byId = new Map(catalog.map((client) => [client.id, client]));
  return rows.map((event) =>
    toEvent(event, event.clientId ? clientSummary(byId.get(event.clientId)) : null),
  );
}

function serializeDesign(design: unknown): string | null {
  return design == null ? null : JSON.stringify(design);
}

/** Convierte un ISO-8601 del cuerpo a `Date`; conserva `null` y `undefined`. */
function toDateOrNull(value: string | null | undefined): Date | null | undefined {
  return value === null || value === undefined ? value : fromIsoString(value);
}

/** Registra las rutas del catalogo de eventos. */
export function registerEventRoutes(app: OpenAPIHono<AppEnv>): void {
  app.openapi(listEventsRoute, listEventsHandler);
  app.openapi(getEventRoute, getEventHandler);
  app.openapi(createEventRoute, createEventHandler);
  app.openapi(updateEventRoute, updateEventHandler);
}

import { OpenAPIHono, createRoute, z, type RouteHandler } from '@hono/zod-openapi';
import { errorResponse } from '../../core/http/error-response';
import { apiSuccess } from '../../core/http/responses';
import type { AppEnv } from '../../core/types/context';
import { createDb } from '../../db/client';
import { EVENT_STATUSES } from '../../db/schema';
import { currentAuthUser, requireAuth, requireRole } from '../auth/auth.middleware';
import { countActiveClients, findClientByOwner } from '../clients/clients.repository';
import {
  ACTIVITY_LIMITS,
  getOverview,
  getRecentActivity,
  getRegistrationTimeline,
  type ActivityItem,
} from './dashboard.service';

/**
 * Lecturas del tablero principal del panel.
 *
 * Las metricas de un evento se piden a `GET /check-in/summary`; estas rutas
 * completan la vista general, la evolucion y la actividad. Exigen la misma
 * sesion y roles que la mesa de registro porque la actividad muestra nombres.
 */

const isoOrNull = z.string().nullable().openapi({ format: 'date-time' });
const iso = z.string().openapi({ format: 'date-time' });

const PHASES = [
  'draft',
  'upcoming',
  'registration_open',
  'registration_closed',
  'in_progress',
  'finished',
  'archived',
] as const;

const overviewSchema = z
  .object({
    generatedAt: iso,
    events: z.object({
      total: z.number().int(),
      active: z.number().int().openapi({
        description: 'Eventos publicados o cerrados que aun no terminan.',
      }),
      byStatus: z.object(
        Object.fromEntries(EVENT_STATUSES.map((status) => [status, z.number().int()])) as Record<
          (typeof EVENT_STATUSES)[number],
          z.ZodNumber
        >,
      ),
    }),
    items: z.array(
      z.object({
        id: z.string(),
        slug: z.string(),
        name: z.string(),
        status: z.enum(EVENT_STATUSES),
        phase: z.enum(PHASES).openapi({
          description: 'Fase calculada con el estado y las fechas del evento.',
        }),
        timezone: z.string(),
        startsAt: isoOrNull,
        endsAt: isoOrNull,
        registrationOpensAt: isoOrNull,
        registrationClosesAt: isoOrNull,
        sedes: z.array(z.object({ participationId: z.string(), name: z.string() })),
        titulares: z.number().int(),
        people: z.number().int(),
        checkedIn: z.number().int(),
        attendanceRate: z.number().min(0).max(1),
        capacity: z.number().int(),
        companions: z.number().int(),
        available: z.number().int(),
        occupancy: z.number(),
        occupancyLevel: z.enum(['unassigned', 'normal', 'high', 'critical', 'full']),
        client: z
          .object({ id: z.string(), slug: z.string(), displayName: z.string() })
          .nullable(),
      }),
    ),
    clients: z.object({ total: z.number().int() }).nullable(),
  })
  .openapi('DashboardOverview');

const timelineSchema = z
  .object({
    timezone: z.string(),
    granularity: z.enum(['hour', 'day', 'week']),
    total: z.number().int(),
    last24h: z.number().int(),
    buckets: z.array(
      z.object({
        date: z.string().openapi({ description: 'Fecha local del evento (YYYY-MM-DD).' }),
        hour: z.number().int().nullable(),
        titulares: z.number().int(),
        people: z.number().int(),
        cumulative: z.number().int(),
      }),
    ),
  })
  .openapi('DashboardTimeline');

const activitySchema = z
  .discriminatedUnion('type', [
    z.object({
      type: z.literal('registration'),
      at: iso,
      registration: z.object({
        id: z.string(),
        fullName: z.string(),
        people: z.number().int(),
        sede: z.string(),
      }),
    }),
    z.object({
      type: z.literal('check_in'),
      at: iso,
      registration: z.object({ id: z.string(), fullName: z.string(), sede: z.string() }),
      turn: z.object({ first: z.number().int(), last: z.number().int().nullable() }),
      operator: z.string().nullable(),
    }),
    z.object({
      type: z.enum(['event_created', 'event_updated']),
      at: iso,
      event: z.object({ id: z.string(), name: z.string() }),
      actor: z.string().nullable(),
    }),
  ])
  .openapi('DashboardActivityItem');

const scopeQuery = {
  eventId: z.string().min(1).openapi({ description: 'Evento a consultar (id).' }),
  participationId: z
    .string()
    .min(1)
    .optional()
    .openapi({ description: 'Limita a una sede del evento; sin el, consolidado.' }),
};

const commonErrors = {
  401: errorResponse('Sin sesion activa.'),
  403: errorResponse('La cuenta autenticada no es `admin` ni `operator`.'),
};

const scopeErrors = {
  ...commonErrors,
  404: errorResponse('El evento (`EVENT_NOT_FOUND`) o la sede (`PARTICIPATION_NOT_FOUND`) no existen.'),
  422: errorResponse('Los parametros no cumplen el formato esperado.'),
};

const overviewRoute = createRoute({
  method: 'get',
  path: '/dashboard/overview',
  tags: ['Tablero'],
  middleware: [requireAuth, requireRole('admin', 'operator')],
  summary: 'Vista general de los eventos',
  description: [
    'Cantidad de eventos (total, activos y por estado) y, por evento, su fase,',
    'sedes, titulares, personas, ingresos y asistencia. Mismas definiciones que',
    '`GET /check-in/summary`.',
  ].join('\n'),
  responses: {
    200: {
      description: 'Vista general.',
      content: {
        'application/json': { schema: z.object({ success: z.literal(true), data: overviewSchema }) },
      },
    },
    ...commonErrors,
  },
});

const timelineRoute = createRoute({
  method: 'get',
  path: '/dashboard/registrations-timeline',
  tags: ['Tablero'],
  middleware: [requireAuth, requireRole('admin', 'operator')],
  summary: 'Evolucion de inscripciones confirmadas',
  description: [
    'Titulares inscritos por tramo en la zona horaria del evento: por hora si las',
    'inscripciones abarcan menos de dos dias, por dia hasta cuatro meses y por',
    'semana despues. Los tramos sin inscripciones vienen en cero.',
  ].join('\n'),
  request: { query: z.object(scopeQuery).openapi('DashboardScopeQuery') },
  responses: {
    200: {
      description: 'Serie temporal.',
      content: {
        'application/json': { schema: z.object({ success: z.literal(true), data: timelineSchema }) },
      },
    },
    ...scopeErrors,
  },
});

const activityRoute = createRoute({
  method: 'get',
  path: '/dashboard/activity',
  tags: ['Tablero'],
  middleware: [requireAuth, requireRole('admin', 'operator')],
  summary: 'Actividad reciente de un evento',
  description: [
    'Ultimas inscripciones confirmadas, ultimos ingresos por QR (uno por titular)',
    'y la creacion o ultima edicion del evento, de la mas reciente a la mas antigua.',
    'No incluye documentos ni datos de contacto.',
  ].join('\n'),
  request: {
    query: z
      .object({
        ...scopeQuery,
        limit: z.coerce
          .number()
          .int()
          .min(1)
          .max(ACTIVITY_LIMITS.maxLimit)
          .default(ACTIVITY_LIMITS.defaultLimit),
      })
      .openapi('DashboardActivityQuery'),
  },
  responses: {
    200: {
      description: 'Actividad.',
      content: {
        'application/json': {
          schema: z.object({ success: z.literal(true), data: z.array(activitySchema) }),
        },
      },
    },
    ...scopeErrors,
  },
});

const toIso = (date: Date | null): string | null => date?.toISOString() ?? null;

function toActivity(item: ActivityItem) {
  return { ...item, at: item.at.toISOString() };
}

const overviewHandler: RouteHandler<typeof overviewRoute, AppEnv> = async (c) => {
  const db = createDb(c.env);
  const actor = currentAuthUser(c);
  const owned = actor.role === 'operator' ? await findClientByOwner(db, actor.id) : null;
  const overview =
    actor.role === 'operator'
      ? owned
        ? await getOverview(db, { clientId: owned.id })
        : await getOverview(db, { clientId: 'none' })
      : await getOverview(db, { clientCount: await countActiveClients(db) });
  return c.json(
    apiSuccess({
      generatedAt: overview.generatedAt.toISOString(),
      events: overview.events,
      clients: overview.clients,
      items: overview.items.map((item) => ({
        ...item,
        sedes: [...item.sedes],
        startsAt: toIso(item.startsAt),
        endsAt: toIso(item.endsAt),
        registrationOpensAt: toIso(item.registrationOpensAt),
        registrationClosesAt: toIso(item.registrationClosesAt),
      })),
    }),
    200,
  );
};

const timelineHandler: RouteHandler<typeof timelineRoute, AppEnv> = async (c) => {
  const db = createDb(c.env);
  const clientId = await operatorClientFilter(db, currentAuthUser(c));
  const timeline = await getRegistrationTimeline(db, c.req.valid('query'), new Date(), clientId);
  return c.json(apiSuccess({ ...timeline, buckets: [...timeline.buckets] }), 200);
};

const activityHandler: RouteHandler<typeof activityRoute, AppEnv> = async (c) => {
  const { limit, ...scope } = c.req.valid('query');
  const db = createDb(c.env);
  const clientId = await operatorClientFilter(db, currentAuthUser(c));
  const items = await getRecentActivity(db, scope, limit, clientId);
  return c.json(apiSuccess(items.map(toActivity)), 200);
};

/** Registra las lecturas del tablero principal. */
export function registerDashboardRoutes(app: OpenAPIHono<AppEnv>): void {
  app.openapi(overviewRoute, overviewHandler);
  app.openapi(timelineRoute, timelineHandler);
  app.openapi(activityRoute, activityHandler);
}

async function operatorClientFilter(
  db: ReturnType<typeof createDb>,
  actor: { role: string; id: string },
): Promise<string | undefined> {
  if (actor.role !== 'operator') {
    return undefined;
  }
  return (await findClientByOwner(db, actor.id))?.id ?? 'none';
}

import { OpenAPIHono, createRoute, z, type RouteHandler } from '@hono/zod-openapi';
import { errorResponse } from '../../core/http/error-response';
import { apiSuccess } from '../../core/http/responses';
import type { AppEnv } from '../../core/types/context';
import { createDb } from '../../db/client';
import { DOCUMENT_TYPES } from '../../db/schema';
import { requireAuth, requireRole } from '../auth/auth.middleware';
import type { BoardRow } from './check-in-board.repository';
import {
  BOARD_PAGE_LIMITS,
  getBoardSummary,
  listBoardRegistrations,
  type BoardMetrics,
} from './check-in-board.service';

/**
 * Rutas de lectura de la mesa de registro.
 *
 * Exponen documentos y nombres, por eso exigen la misma sesion y los mismos roles
 * que el escaneo y el listado de registros del panel.
 */

const isoOrNull = z.string().nullable().openapi({ format: 'date-time' });

const metricsSchema = z
  .object({
    titulares: z.number().int().openapi({ description: 'Inscripciones confirmadas.' }),
    companions: z.number().int().openapi({ description: 'Acompanantes de esas inscripciones.' }),
    people: z.number().int().openapi({ description: '`titulares + companions`.' }),
    checkedIn: z.number().int().openapi({ description: 'Titulares cuyo QR ya se escaneo.' }),
    pending: z.number().int().openapi({ description: '`titulares - checkedIn`.' }),
    attendanceRate: z.number().min(0).max(1).openapi({ description: '`checkedIn / titulares`.' }),
    turnsIssued: z.number().int().openapi({
      description:
        'Turnos entregados (titulares y acompanantes). El turno del acompanante se entrega con el escaneo del titular.',
    }),
    lastCheckInAt: isoOrNull,
  })
  .openapi('CheckInMetrics');

const summarySchema = z
  .object({
    event: z.object({ id: z.string(), slug: z.string(), name: z.string() }),
    participationId: z.string().nullable(),
    totals: metricsSchema,
    sedes: z.array(
      metricsSchema.extend({
        participationId: z.string(),
        establishment: z.object({ id: z.string(), name: z.string(), city: z.string().nullable() }),
      }),
    ),
  })
  .openapi('CheckInSummary');

const boardRowSchema = z
  .object({
    id: z.string().openapi({ description: 'Folio de la inscripcion.' }),
    fullName: z.string(),
    documentType: z.enum(DOCUMENT_TYPES),
    documentNumber: z.string(),
    companionsCount: z.number().int(),
    people: z.number().int(),
    registeredAt: z.string().openapi({ format: 'date-time' }),
    sede: z.object({ id: z.string(), name: z.string(), city: z.string().nullable() }),
    checkIn: z.object({
      status: z.enum(['checked_in', 'pending']),
      at: isoOrNull,
      firstTurn: z.number().int().nullable(),
      lastTurn: z.number().int().nullable(),
      turnsCount: z.number().int(),
      operator: z.object({ id: z.string(), fullName: z.string() }).nullable(),
    }),
  })
  .openapi('CheckInBoardRow');

const eventQuery = z.string().min(1).openapi({ description: 'Evento a consultar (id).' });
const participationQuery = z
  .string()
  .min(1)
  .optional()
  .openapi({ description: 'Limita a una sede del evento; sin el, consolidado.' });

const summaryQuerySchema = z
  .object({ eventId: eventQuery, participationId: participationQuery })
  .openapi('CheckInSummaryQuery');

const listQuerySchema = z
  .object({
    eventId: eventQuery,
    participationId: participationQuery,
    checkIn: z.enum(['checked_in', 'pending']).optional(),
    search: z.string().trim().min(1).max(120).optional().openapi({
      description: 'Nombre, documento o folio (sin distinguir mayusculas).',
    }),
    sort: z.enum(['registeredAt', 'fullName', 'checkedInAt', 'turn']).default('registeredAt'),
    order: z.enum(['asc', 'desc']).default('desc'),
    limit: z.coerce
      .number()
      .int()
      .min(1)
      .max(BOARD_PAGE_LIMITS.maxLimit)
      .default(BOARD_PAGE_LIMITS.defaultLimit),
    offset: z.coerce.number().int().min(0).default(0),
  })
  .openapi('CheckInBoardQuery');

const summaryRoute = createRoute({
  method: 'get',
  path: '/check-in/summary',
  tags: ['Ingreso'],
  middleware: [requireAuth, requireRole('admin', 'operator')],
  summary: 'Metricas de inscripcion e ingreso de un evento',
  description: [
    'Totales del evento (o de una sede) y el desglose por sede. Cada inscripcion',
    'pertenece a una sola sede, asi que el consolidado es la suma de las sedes.',
    '',
    'Solo cuentan las inscripciones confirmadas. Un escaneo repetido no crea turnos y',
    'por tanto no cambia `checkedIn`.',
  ].join('\n'),
  request: { query: summaryQuerySchema },
  responses: {
    200: {
      description: 'Metricas.',
      content: {
        'application/json': {
          schema: z.object({ success: z.literal(true), data: summarySchema }),
        },
      },
    },
    401: errorResponse('Sin sesion activa.'),
    403: errorResponse('La cuenta autenticada no es `admin` ni `operator`.'),
    404: errorResponse('El evento (`EVENT_NOT_FOUND`) o la sede (`PARTICIPATION_NOT_FOUND`) no existen.'),
  },
});

const listRoute = createRoute({
  method: 'get',
  path: '/check-in/registrations',
  tags: ['Ingreso'],
  middleware: [requireAuth, requireRole('admin', 'operator')],
  summary: 'Inscripciones de un evento con su estado de ingreso',
  description: [
    'Inscripciones confirmadas con sede, turnos, hora de ingreso y operador que',
    'escaneo. Con `checkIn=checked_in&sort=checkedInAt&order=desc` es el historial',
    'de ingresos. Es solo lectura: los turnos se asignan en `POST /check-in/scan`.',
  ].join('\n'),
  request: { query: listQuerySchema },
  responses: {
    200: {
      description: 'Pagina de inscripciones.',
      content: {
        'application/json': {
          schema: z.object({
            success: z.literal(true),
            data: z.array(boardRowSchema),
            meta: z.object({ total: z.number().int(), limit: z.number().int(), offset: z.number().int() }),
          }),
        },
      },
    },
    401: errorResponse('Sin sesion activa.'),
    403: errorResponse('La cuenta autenticada no es `admin` ni `operator`.'),
    404: errorResponse('El evento no existe (`EVENT_NOT_FOUND`).'),
    422: errorResponse('Los filtros no cumplen el formato esperado.'),
  },
});

function toMetrics(metrics: BoardMetrics) {
  return { ...metrics, lastCheckInAt: metrics.lastCheckInAt?.toISOString() ?? null };
}

function toBoardRow(row: BoardRow) {
  return {
    id: row.id,
    fullName: row.fullName,
    documentType: row.documentType,
    documentNumber: row.documentNumber,
    companionsCount: row.companionsCount,
    people: row.companionsCount + 1,
    registeredAt: row.registeredAt.toISOString(),
    sede: { id: row.participationId, name: row.sedeName, city: row.sedeCity },
    checkIn: {
      status: row.checkedInAt === null ? ('pending' as const) : ('checked_in' as const),
      at: row.checkedInAt?.toISOString() ?? null,
      firstTurn: row.firstTurn,
      lastTurn: row.lastTurn,
      turnsCount: row.turnsCount,
      operator:
        row.operatorId === null || row.operatorName === null
          ? null
          : { id: row.operatorId, fullName: row.operatorName },
    },
  };
}

const summaryHandler: RouteHandler<typeof summaryRoute, AppEnv> = async (c) => {
  const query = c.req.valid('query');
  const summary = await getBoardSummary(createDb(c.env), query.eventId, query.participationId);
  return c.json(
    apiSuccess({
      ...summary,
      totals: toMetrics(summary.totals),
      sedes: summary.sedes.map((sede) => ({ ...sede, ...toMetrics(sede) })),
    }),
    200,
  );
};

const listHandler: RouteHandler<typeof listRoute, AppEnv> = async (c) => {
  const page = await listBoardRegistrations(createDb(c.env), c.req.valid('query'));
  return c.json(
    apiSuccess(page.items.map(toBoardRow), {
      total: page.total,
      limit: page.limit,
      offset: page.offset,
    }),
    200,
  );
};

/** Registra las lecturas de la mesa de registro. */
export function registerCheckInBoardRoutes(app: OpenAPIHono<AppEnv>): void {
  app.openapi(summaryRoute, summaryHandler);
  app.openapi(listRoute, listHandler);
}

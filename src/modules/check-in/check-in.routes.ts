import { OpenAPIHono, createRoute, z, type RouteHandler } from '@hono/zod-openapi';
import { errorResponse } from '../../core/http/error-response';
import { apiSuccess } from '../../core/http/responses';
import type { AppEnv } from '../../core/types/context';
import { createDb } from '../../db/client';
import { DOCUMENT_TYPES, REGISTRATION_STATUSES } from '../../db/schema';
import { currentAuthUser, requireAuth, requireRole } from '../auth/auth.middleware';
import { notifyCheckInAssigned, scheduleMail } from '../mail/notify';
import { listCompanions } from '../registrations/registrations.repository';
import {
  lookupTicket,
  scanTicket,
  searchTickets,
  type LookupTicketResult,
  type ScanTicketResult,
} from './check-in.service';

/**
 * Rutas de ingreso en puerta.
 *
 * El personal escanea el QR y el servidor primero identifica el registro. Los
 * turnos solo se asignan cuando confirman que el titular esta y cuales
 * acompanantes vinieron; el resto libera cupo.
 */

const codeRequestSchema = z
  .object({
    code: z.string().trim().min(1).max(200).openapi({
      description: 'Contenido del QR: el token del alta o, en su defecto, el id del registro.',
      example: '3f1b2c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d',
    }),
  })
  .openapi('CheckInLookupRequest');

const scanRequestSchema = codeRequestSchema
  .extend({
    holderPresent: z.boolean().openapi({
      description: '`true` si el titular esta en la puerta. Si no, no se asigna turno.',
    }),
    presentCompanionIds: z
      .array(z.string().trim().min(1).max(50))
      .max(2)
      .default([])
      .openapi({
        description: 'Acompanantes que estan en la puerta ahora. Los demas conservan el cupo.',
      }),
    releaseCompanionIds: z
      .array(z.string().trim().min(1).max(50))
      .max(2)
      .default([])
      .openapi({
        description: 'Acompanantes que no vendran: se libera su cupo y documento.',
      }),
  })
  .openapi('CheckInScanRequest');

const turnSchema = z
  .object({
    number: z.number().int().min(1),
    position: z.number().int().min(0),
    role: z.enum(['holder', 'companion']),
    fullName: z.string(),
  })
  .openapi('Turn');

const companionPreviewSchema = z
  .object({
    id: z.string(),
    fullName: z.string(),
    documentType: z.enum(DOCUMENT_TYPES).nullable(),
    documentNumber: z.string().nullable(),
    checkedIn: z.boolean(),
  })
  .openapi('CheckInCompanion');

const registrationPreviewSchema = z.object({
  id: z.string(),
  fullName: z.string(),
  documentType: z.enum(DOCUMENT_TYPES),
  documentNumber: z.string(),
  companionsCount: z.number().int(),
  status: z.enum(REGISTRATION_STATUSES),
});

const ticketViewSchema = z.object({
  alreadyAssigned: z.boolean().openapi({
    description: '`true` si el QR ya se habia escaneado: los numeros son los mismos.',
  }),
  assignedAt: z.string().openapi({ format: 'date-time' }),
  registration: registrationPreviewSchema,
  event: z.object({ id: z.string(), slug: z.string(), name: z.string() }),
  sede: z.object({ id: z.string(), name: z.string(), city: z.string().nullable() }),
  companions: z.array(companionPreviewSchema),
  turns: z.array(turnSchema),
});

const lookupResultSchema = ticketViewSchema.openapi('CheckInLookupResult');

const scanResultSchema = ticketViewSchema
  .extend({
    releasedCompanionsCount: z.number().int().min(0).openapi({
      description: 'Acompanantes que no llegaron y cuyo cupo se libero.',
    }),
  })
  .openapi('CheckInScanResult');

const lookupResponseSchema = z
  .object({ success: z.literal(true), data: lookupResultSchema })
  .openapi('CheckInLookupResponse');

const scanResponseSchema = z
  .object({ success: z.literal(true), data: scanResultSchema })
  .openapi('CheckInScanResponse');

const lookupRoute = createRoute({
  method: 'post',
  path: '/check-in/lookup',
  tags: ['Ingreso'],
  middleware: [requireAuth, requireRole('admin', 'operator')],
  summary: 'Identifica un QR sin asignar turnos',
  description: [
    'Devuelve el titular y sus acompanantes para que el personal confirme quien',
    'llego. Si el codigo ya tenia turnos, los incluye con `alreadyAssigned`.',
  ].join('\n'),
  request: {
    body: { required: true, content: { 'application/json': { schema: codeRequestSchema } } },
  },
  responses: {
    200: {
      description: 'Registro identificado. Todavia no hay turnos nuevos.',
      content: { 'application/json': { schema: lookupResponseSchema } },
    },
    401: errorResponse('Sin sesion activa.'),
    403: errorResponse('La cuenta autenticada no es `admin` ni `operator`.'),
    404: errorResponse('Ningun registro coincide con el codigo (`TICKET_NOT_FOUND`).'),
    409: errorResponse(
      'El QR fue revocado o la inscripcion cancelada (`QR_REVOKED`), o no esta confirmada (`TURN_ASSIGNMENT_CONFLICT`).',
    ),
    422: errorResponse('El contenido no es un QR de acceso (`QR_MALFORMED`).'),
  },
});

const scanRoute = createRoute({
  method: 'post',
  path: '/check-in/scan',
  tags: ['Ingreso'],
  middleware: [requireAuth, requireRole('admin', 'operator')],
  summary: 'Confirma la asistencia y asigna los turnos',
  description: [
    'Asigna un turno al titular y a cada acompanante marcado como presente.',
    'Los acompanantes que no vinieron liberan cupo y documento. Volver a',
    'escanear el mismo QR devuelve los turnos ya asignados con `alreadyAssigned`.',
  ].join('\n'),
  request: {
    body: { required: true, content: { 'application/json': { schema: scanRequestSchema } } },
  },
  responses: {
    200: {
      description: 'Turnos asignados (o ya existentes).',
      content: { 'application/json': { schema: scanResponseSchema } },
    },
    401: errorResponse('Sin sesion activa.'),
    403: errorResponse('La cuenta autenticada no es `admin` ni `operator`.'),
    404: errorResponse('Ningun registro coincide con el codigo (`TICKET_NOT_FOUND`).'),
    409: errorResponse(
      [
        'El QR fue revocado o la inscripcion cancelada (`QR_REVOKED`), no esta',
        'confirmada (`TURN_ASSIGNMENT_CONFLICT`), o el titular no esta',
        '(`CHECK_IN_HOLDER_ABSENT`).',
      ].join(' '),
    ),
    422: errorResponse('El contenido no es un QR de acceso (`QR_MALFORMED`).'),
  },
});

function toCompanions(companions: LookupTicketResult['companions'], turns: LookupTicketResult['turns']) {
  const checked = new Set(turns.map((turn) => turn.companionId).filter((id): id is string => id !== null));
  return companions.map((companion) => ({
    id: companion.id,
    fullName: companion.fullName,
    documentType: companion.documentType,
    documentNumber: companion.documentNumber,
    checkedIn: checked.has(companion.id),
  }));
}

function toTurns(turns: LookupTicketResult['turns']) {
  return turns.map((turn) => ({
    number: turn.number,
    position: turn.position,
    role: turn.position === 0 ? ('holder' as const) : ('companion' as const),
    fullName: turn.fullName,
  }));
}

function toTicketView(
  ticket: LookupTicketResult['ticket'],
  turns: LookupTicketResult['turns'],
  alreadyAssigned: boolean,
  companions: LookupTicketResult['companions'],
  companionsCount: number,
) {
  const assignedAt = turns[0]?.assignedAt ?? new Date();

  return {
    alreadyAssigned,
    assignedAt: assignedAt.toISOString(),
    registration: {
      id: ticket.registration.id,
      fullName: ticket.registration.fullName,
      documentType: ticket.registration.documentType,
      documentNumber: ticket.registration.documentNumber,
      companionsCount,
      status: ticket.registration.status,
    },
    event: ticket.event,
    sede: {
      id: ticket.participationId,
      name: ticket.establishment.name,
      city: ticket.establishment.city,
    },
    companions: toCompanions(companions, turns),
    turns: toTurns(turns),
  };
}

function toLookupResult(result: LookupTicketResult) {
  return toTicketView(
    result.ticket,
    result.turns,
    result.alreadyAssigned,
    result.companions,
    result.ticket.registration.companionsCount,
  );
}

function toScanResult(result: ScanTicketResult, companions: LookupTicketResult['companions']) {
  return {
    ...toTicketView(
      result.ticket,
      result.turns,
      result.alreadyAssigned,
      companions,
      result.ticket.registration.companionsCount - result.releasedCompanionsCount,
    ),
    releasedCompanionsCount: result.releasedCompanionsCount,
  };
}

const lookupHandler: RouteHandler<typeof lookupRoute, AppEnv> = async (c) => {
  const result = await lookupTicket(createDb(c.env), c.req.valid('json').code);
  return c.json(apiSuccess(toLookupResult(result)), 200);
};

const scanHandler: RouteHandler<typeof scanRoute, AppEnv> = async (c) => {
  const body = c.req.valid('json');
  const db = createDb(c.env);
  const result = await scanTicket(db, {
    code: body.code,
    actorId: currentAuthUser(c).id,
    holderPresent: body.holderPresent,
    presentCompanionIds: body.presentCompanionIds,
    releaseCompanionIds: body.releaseCompanionIds,
  });

  const remaining = await listCompanions(db, result.ticket.registration.id);

  if (!result.alreadyAssigned) {
    const sedeName = result.ticket.establishment.city
      ? `${result.ticket.establishment.name} · ${result.ticket.establishment.city}`
      : result.ticket.establishment.name;
    scheduleMail(
      c,
      notifyCheckInAssigned(c.env, {
        registrationId: result.ticket.registration.id,
        email: result.ticket.registration.email,
        fullName: result.ticket.registration.fullName,
        eventName: result.ticket.event.name,
        sedeName,
        turns: result.turns.map((turn) => ({
          number: turn.number,
          label: turn.position === 0 ? result.ticket.registration.fullName : turn.fullName,
        })),
      }),
    );
  }

  return c.json(apiSuccess(toScanResult(result, remaining)), 200);
};

const searchRequestSchema = z
  .object({
    eventId: z.string().trim().min(1),
    query: z.string().trim().min(2).max(120),
  })
  .openapi('CheckInSearchRequest');

const searchResponseSchema = z
  .object({ success: z.literal(true), data: z.array(lookupResultSchema) })
  .openapi('CheckInSearchResponse');

const searchRoute = createRoute({
  method: 'post',
  path: '/check-in/search',
  tags: ['Ingreso'],
  middleware: [requireAuth, requireRole('admin', 'operator')],
  summary: 'Busca una inscripcion por nombre, documento o folio',
  request: {
    body: { required: true, content: { 'application/json': { schema: searchRequestSchema } } },
  },
  responses: {
    200: {
      description: 'Coincidencias para confirmar en puerta.',
      content: { 'application/json': { schema: searchResponseSchema } },
    },
    401: errorResponse('Sin sesion activa.'),
    403: errorResponse('La cuenta autenticada no es `admin` ni `operator`.'),
  },
});

const searchHandler: RouteHandler<typeof searchRoute, AppEnv> = async (c) => {
  const body = c.req.valid('json');
  const results = await searchTickets(createDb(c.env), body);
  return c.json(apiSuccess(results.map(toLookupResult)), 200);
};

/** Registra las rutas de ingreso en puerta. */
export function registerCheckInRoutes(app: OpenAPIHono<AppEnv>): void {
  app.openapi(lookupRoute, lookupHandler);
  app.openapi(searchRoute, searchHandler);
  app.openapi(scanRoute, scanHandler);
}

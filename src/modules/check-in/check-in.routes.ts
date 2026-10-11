import { OpenAPIHono, createRoute, z, type RouteHandler } from '@hono/zod-openapi';
import { errorResponse } from '../../core/http/error-response';
import { apiSuccess } from '../../core/http/responses';
import type { AppEnv } from '../../core/types/context';
import { createDb } from '../../db/client';
import { DOCUMENT_TYPES, REGISTRATION_STATUSES } from '../../db/schema';
import { currentAuthUser, requireAuth, requireRole } from '../auth/auth.middleware';
import { scanTicket, type ScanTicketResult } from './check-in.service';

/**
 * Rutas de ingreso en puerta.
 *
 * Las usa el personal desde el panel: escanean el QR del comprobante y el servidor
 * asigna (o devuelve, si ya existian) los turnos del titular y sus acompanantes.
 */

const scanRequestSchema = z
  .object({
    code: z.string().trim().min(1).max(200).openapi({
      description: 'Contenido del QR: el token del alta o, en su defecto, el id del registro.',
      example: '3f1b2c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d',
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

const scanResultSchema = z
  .object({
    alreadyAssigned: z.boolean().openapi({
      description: '`true` si el QR ya se habia escaneado: los numeros son los mismos.',
    }),
    assignedAt: z.string().openapi({ format: 'date-time' }),
    registration: z.object({
      id: z.string(),
      fullName: z.string(),
      documentType: z.enum(DOCUMENT_TYPES),
      documentNumber: z.string(),
      companionsCount: z.number().int(),
      status: z.enum(REGISTRATION_STATUSES),
    }),
    event: z.object({ id: z.string(), slug: z.string(), name: z.string() }),
    sede: z.object({ id: z.string(), name: z.string(), city: z.string().nullable() }),
    turns: z.array(turnSchema),
  })
  .openapi('CheckInScanResult');

const scanResponseSchema = z
  .object({ success: z.literal(true), data: scanResultSchema })
  .openapi('CheckInScanResponse');

const scanRoute = createRoute({
  method: 'post',
  path: '/check-in/scan',
  tags: ['Ingreso'],
  middleware: [requireAuth, requireRole('admin', 'operator')],
  summary: 'Escanea un QR y asigna los turnos',
  description: [
    'Entrega un turno consecutivo por persona del registro: el titular primero y',
    'despues sus acompanantes. La numeracion es propia de cada sede y empieza en 1.',
    '',
    'El contador de la sede se incrementa y los turnos se insertan en una sola',
    'operacion atomica, asi que dos escaneos simultaneos nunca comparten numero. Volver',
    'a escanear el mismo QR devuelve los turnos ya asignados con `alreadyAssigned`.',
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
      'El QR fue revocado o la inscripcion cancelada (`QR_REVOKED`), o no esta confirmada (`TURN_ASSIGNMENT_CONFLICT`).',
    ),
    422: errorResponse('El contenido no es un QR de acceso (`QR_MALFORMED`).'),
  },
});

function toScanResult(result: ScanTicketResult) {
  const { registration, event, establishment } = result.ticket;
  const assignedAt = result.turns[0]?.assignedAt ?? new Date();

  return {
    alreadyAssigned: result.alreadyAssigned,
    assignedAt: assignedAt.toISOString(),
    registration: {
      id: registration.id,
      fullName: registration.fullName,
      documentType: registration.documentType,
      documentNumber: registration.documentNumber,
      companionsCount: registration.companionsCount,
      status: registration.status,
    },
    event,
    sede: { id: result.ticket.participationId, name: establishment.name, city: establishment.city },
    turns: result.turns.map((turn) => ({
      number: turn.number,
      position: turn.position,
      role: turn.position === 0 ? ('holder' as const) : ('companion' as const),
      fullName: turn.fullName,
    })),
  };
}

const scanHandler: RouteHandler<typeof scanRoute, AppEnv> = async (c) => {
  const result = await scanTicket(createDb(c.env), {
    code: c.req.valid('json').code,
    actorId: currentAuthUser(c).id,
  });
  return c.json(apiSuccess(toScanResult(result)), 200);
};

/** Registra las rutas de ingreso en puerta. */
export function registerCheckInRoutes(app: OpenAPIHono<AppEnv>): void {
  app.openapi(scanRoute, scanHandler);
}

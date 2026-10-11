import { OpenAPIHono, createRoute, z, type RouteHandler } from '@hono/zod-openapi';
import { errorResponse } from '../../core/http/error-response';
import { apiSuccess } from '../../core/http/responses';
import type { AppEnv } from '../../core/types/context';
import { createDb } from '../../db/client';
import {
  MAX_COMPANIONS_PER_REGISTRATION,
  addCompanionsRequestSchema,
  createRegistrationRequestSchema,
  holderCredentialsSchema,
} from '../registrations/registrations.schemas';
import {
  publicEventSchema,
  publicHolderRegistrationSchema,
  publicRegistrationReceiptSchema,
  toPublicRegistrationReceipt,
} from './public.schemas';
import {
  PUBLIC_EVENT_LIST_DEFAULT_LIMIT,
  PUBLIC_EVENT_LIST_MAX_LIMIT,
  addPublicCompanions,
  getPublicEvent,
  getPublicRegistration,
  listPublicEvents,
  lookupHolderRegistration,
  registerPublicAttendance,
} from './public.service';

/**
 * Rutas publicas del catalogo y del registro.
 *
 * Son las unicas que no piden sesion: quien se inscribe no es un operador. A cambio,
 * el alcance es el minimo: solo eventos publicados, solo sedes abiertas y solo la
 * disponibilidad necesaria para elegir donde registrarse. Nada de borradores, notas
 * internas ni auditoria.
 */

const eventSlugParamSchema = z.object({
  slug: z.string().min(1).openapi({
    param: { name: 'slug', in: 'path' },
    description: 'Slug del evento (tambien se acepta su identificador).',
  }),
});

const listPublicEventsQuerySchema = z
  .object({
    search: z
      .string()
      .trim()
      .min(1)
      .max(120)
      .optional()
      .openapi({ description: 'Texto libre buscado en el nombre y el slug del evento.' }),
    limit: z.coerce
      .number()
      .int()
      .min(1)
      .max(PUBLIC_EVENT_LIST_MAX_LIMIT)
      .default(PUBLIC_EVENT_LIST_DEFAULT_LIMIT),
    offset: z.coerce.number().int().min(0).default(0),
  })
  .openapi('PublicEventListQuery');

const publicEventResponseSchema = z
  .object({ success: z.literal(true), data: publicEventSchema })
  .openapi('PublicEventResponse');

const publicEventListResponseSchema = z
  .object({
    success: z.literal(true),
    data: z.array(publicEventSchema),
    meta: z.object({
      total: z.number().int(),
      limit: z.number().int(),
      offset: z.number().int(),
    }),
  })
  .openapi('PublicEventListResponse');

const publicRegistrationResponseSchema = z
  .object({ success: z.literal(true), data: publicRegistrationReceiptSchema })
  .openapi('PublicRegistrationResponse');

const listPublicEventsRoute = createRoute({
  method: 'get',
  path: '/public/events',
  tags: ['Publico'],
  summary: 'Lista los eventos abiertos al publico',
  description: [
    'Devuelve los eventos publicados con las sedes donde se puede uno inscribir.',
    '',
    'Cada sede incluye la disponibilidad (`availableTitulares`,',
    '`availableCompanions`), su ventana efectiva y `registrationOpen`, que resume las',
    'tres condiciones del alta: sede abierta, establecimiento activo y ventana vigente.',
    'Un evento publicado sin sedes abiertas se devuelve igual, con la lista vacia.',
  ].join('\n'),
  request: { query: listPublicEventsQuerySchema },
  responses: {
    200: {
      description: 'Pagina de eventos publicados.',
      content: { 'application/json': { schema: publicEventListResponseSchema } },
    },
  },
});

const listPublicEventsHandler: RouteHandler<typeof listPublicEventsRoute, AppEnv> = async (c) => {
  const page = await listPublicEvents(createDb(c.env), c.req.valid('query'));

  return c.json(
    apiSuccess([...page.items], {
      total: page.total,
      limit: page.limit,
      offset: page.offset,
    }),
    200,
  );
};

const getPublicEventRoute = createRoute({
  method: 'get',
  path: '/public/events/{slug}',
  tags: ['Publico'],
  summary: 'Consulta un evento publicado',
  description: [
    'Es la ficha que consume el formulario: nombre, descripcion, fechas y las sedes',
    'disponibles con su cupo y su ventana.',
    '',
    'Se admite el slug o el identificador. Un evento en borrador, cerrado o archivado',
    'responde 404 con `EVENT_NOT_FOUND`: desde fuera no se distingue de uno inexistente.',
  ].join('\n'),
  request: { params: eventSlugParamSchema },
  responses: {
    200: {
      description: 'Evento publicado.',
      content: { 'application/json': { schema: publicEventResponseSchema } },
    },
    404: errorResponse('El evento no existe o no esta publicado (`EVENT_NOT_FOUND`).'),
  },
});

const getPublicEventHandler: RouteHandler<typeof getPublicEventRoute, AppEnv> = async (c) => {
  const event = await getPublicEvent(createDb(c.env), c.req.valid('param').slug);

  return c.json(apiSuccess(event), 200);
};

const createPublicRegistrationRoute = createRoute({
  method: 'post',
  path: '/public/registrations',
  tags: ['Publico'],
  summary: 'Inscribe a una persona y a sus acompanantes',
  description: [
    'Alta del formulario publico. El cuerpo es el mismo que usa la mesa de registro:',
    'la sede elegida, los datos del titular y, si los hay, sus acompanantes.',
    '',
    'El cupo se reserva antes de escribir, asi que ante dos altas simultaneas por el',
    'ultimo lugar una prospera y la otra responde 409 con `TITULAR_CAPACITY_EXCEEDED`',
    '(o `COMPANION_CAPACITY_EXCEEDED` si lo que falta es cupo de acompanantes).',
    '',
    'El documento se normaliza antes de compararlo (`1.020.304.000` y `1020304000` son',
    'el mismo) y solo puede ocupar **un lugar por evento**, como titular o como',
    'acompanante: el segundo intento responde 409 con `DUPLICATE_DOCUMENT` y `details`',
    'con `document`, `role`, `registeredAs` y `field`. Fuera de la ventana de registro',
    'la respuesta es 409 con `REGISTRATION_OUTSIDE_WINDOW`.',
  ].join('\n'),
  request: {
    body: {
      required: true,
      content: { 'application/json': { schema: createRegistrationRequestSchema } },
    },
  },
  responses: {
    201: {
      description: 'Registro confirmado.',
      content: { 'application/json': { schema: publicRegistrationResponseSchema } },
    },
    404: errorResponse('La sede no existe (`PARTICIPATION_NOT_FOUND`) o su evento no (`EVENT_NOT_FOUND`).'),
    409: errorResponse(
      'Cupo agotado de titulares o acompanantes, documento ya registrado en el evento (`DUPLICATE_DOCUMENT`), sede cerrada (`PARTICIPATION_CLOSED`), evento no publicado (`EVENT_NOT_REGISTRABLE`) o fuera de la ventana (`REGISTRATION_OUTSIDE_WINDOW`).',
    ),
    422: errorResponse(
      'El cuerpo no cumple el formato o la coherencia esperada (por ejemplo, el mismo documento dos veces en la misma solicitud).',
    ),
  },
});

const createPublicRegistrationHandler: RouteHandler<
  typeof createPublicRegistrationRoute,
  AppEnv
> = async (c) => {
  const body = c.req.valid('json');
  const detail = await registerPublicAttendance(createDb(c.env), {
    participationId: body.participationId,
    documentType: body.documentType,
    documentNumber: body.documentNumber,
    fullName: body.fullName,
    email: body.email,
    phone: body.phone,
    requiresElectronicInvoice: body.requiresElectronicInvoice,
    companions: body.companions,
  });

  return c.json(apiSuccess(toPublicRegistrationReceipt(detail.registration, detail.qrToken)), 201);
};

const getPublicRegistrationRoute = createRoute({
  method: 'get',
  path: '/public/registrations/{id}',
  tags: ['Publico'],
  summary: 'Consulta el comprobante de una inscripcion',
  description: [
    'Devuelve el recibo del folio: titular, documento, acompanantes y estado.',
    'No reexpone el token del QR: ese valor solo viaja en el alta.',
  ].join('\n'),
  request: {
    params: z.object({
      id: z.string().min(1).openapi({
        param: { name: 'id', in: 'path' },
        description: 'Identificador del registro.',
      }),
    }),
  },
  responses: {
    200: {
      description: 'Comprobante encontrado.',
      content: { 'application/json': { schema: publicRegistrationResponseSchema } },
    },
    404: errorResponse('El registro no existe (`REGISTRATION_NOT_FOUND`).'),
  },
});

const getPublicRegistrationHandler: RouteHandler<
  typeof getPublicRegistrationRoute,
  AppEnv
> = async (c) => {
  const detail = await getPublicRegistration(createDb(c.env), c.req.valid('param').id);

  return c.json(apiSuccess(toPublicRegistrationReceipt(detail.registration)), 200);
};

const publicHolderRegistrationResponseSchema = z
  .object({ success: z.literal(true), data: publicHolderRegistrationSchema })
  .openapi('PublicHolderRegistrationResponse');

const notFoundHolder = errorResponse(
  'No hay una inscripcion vigente con ese documento y ese correo en el evento (`REGISTRATION_NOT_FOUND`).',
);

const lookupHolderRegistrationRoute = createRoute({
  method: 'post',
  path: '/public/registrations/lookup',
  tags: ['Publico'],
  summary: 'Ubica la inscripcion de un titular',
  description: [
    'El titular se identifica con el evento, su documento y el correo que declaro en el',
    'alta. Devuelve su recibo y `maxCompanions`, para saber cuantos acompanantes puede',
    'sumar todavia. Cualquier dato que no coincida responde el mismo 404.',
  ].join('\n'),
  request: {
    body: {
      required: true,
      content: { 'application/json': { schema: holderCredentialsSchema } },
    },
  },
  responses: {
    200: {
      description: 'Inscripcion encontrada.',
      content: { 'application/json': { schema: publicHolderRegistrationResponseSchema } },
    },
    404: notFoundHolder,
  },
});

const lookupHolderRegistrationHandler: RouteHandler<
  typeof lookupHolderRegistrationRoute,
  AppEnv
> = async (c) => {
  const registration = await lookupHolderRegistration(createDb(c.env), c.req.valid('json'));

  return c.json(
    apiSuccess({
      ...toPublicRegistrationReceipt(registration),
      maxCompanions: MAX_COMPANIONS_PER_REGISTRATION,
    }),
    200,
  );
};

const addPublicCompanionsRoute = createRoute({
  method: 'post',
  path: '/public/registrations/companions',
  tags: ['Publico'],
  summary: 'Agrega acompanantes a una inscripcion existente',
  description: [
    'El titular no se vuelve a inscribir: se identifica igual que en la consulta y',
    'envia solo los acompanantes nuevos, que entran en su misma sede y bajo su mismo QR.',
    '',
    `Un titular puede tener como maximo ${MAX_COMPANIONS_PER_REGISTRATION} acompanantes en total;`,
    'pasarse responde 409 con `COMPANION_LIMIT_REACHED`. Aplican las reglas del alta:',
    'cupo de acompanantes de la sede, ventana, sede abierta y documento unico por evento.',
  ].join('\n'),
  request: {
    body: {
      required: true,
      content: { 'application/json': { schema: addCompanionsRequestSchema } },
    },
  },
  responses: {
    201: {
      description: 'Acompanantes agregados.',
      content: { 'application/json': { schema: publicHolderRegistrationResponseSchema } },
    },
    404: notFoundHolder,
    409: errorResponse(
      'Tope de acompanantes (`COMPANION_LIMIT_REACHED`), cupo agotado (`COMPANION_CAPACITY_EXCEEDED`), documento ya registrado (`DUPLICATE_DOCUMENT`), sede cerrada o fuera de la ventana.',
    ),
    422: errorResponse('El cuerpo no cumple el formato esperado.'),
  },
});

const addPublicCompanionsHandler: RouteHandler<typeof addPublicCompanionsRoute, AppEnv> = async (
  c,
) => {
  const detail = await addPublicCompanions(createDb(c.env), c.req.valid('json'));

  return c.json(
    apiSuccess({
      ...toPublicRegistrationReceipt(detail.registration),
      maxCompanions: MAX_COMPANIONS_PER_REGISTRATION,
    }),
    201,
  );
};

/** Registra las rutas publicas (sin sesion) del catalogo y del registro. */
export function registerPublicRoutes(app: OpenAPIHono<AppEnv>): void {
  app.openapi(listPublicEventsRoute, listPublicEventsHandler);
  app.openapi(getPublicEventRoute, getPublicEventHandler);
  app.openapi(createPublicRegistrationRoute, createPublicRegistrationHandler);
  app.openapi(lookupHolderRegistrationRoute, lookupHolderRegistrationHandler);
  app.openapi(addPublicCompanionsRoute, addPublicCompanionsHandler);
  app.openapi(getPublicRegistrationRoute, getPublicRegistrationHandler);
}

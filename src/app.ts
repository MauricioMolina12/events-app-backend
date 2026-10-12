import { swaggerUI } from '@hono/swagger-ui';
import { OpenAPIHono } from '@hono/zod-openapi';
import { API_PREFIX, OPENAPI_DESCRIPTION, OPENAPI_TITLE, SERVICE_VERSION } from './config/constants';
import { createErrorHandler, createNotFoundHandler } from './core/errors/error-handler';
import { zodErrorToAppError } from './core/errors/validation-error';
import { corsMiddleware } from './core/middleware/cors';
import { requestLoggerMiddleware } from './core/middleware/logger';
import { requestIdMiddleware } from './core/middleware/request-id';
import type { AppEnv } from './core/types/context';
import { registerAuthRoutes } from './modules/auth/auth.routes';
import { registerCheckInBoardRoutes } from './modules/check-in/check-in-board.routes';
import { registerCheckInRoutes } from './modules/check-in/check-in.routes';
import { registerClientRoutes } from './modules/clients/clients.routes';
import { registerDashboardRoutes } from './modules/dashboard/dashboard.routes';
import { registerEstablishmentRoutes } from './modules/establishments/establishments.routes';
import { registerEventRoutes } from './modules/events/events.routes';
import { registerHealthRoutes } from './modules/health/health.routes';
import { registerParticipationRoutes } from './modules/participations/participations.routes';
import { registerPublicRoutes } from './modules/public/public.routes';
import { registerRegistrationRoutes } from './modules/registrations/registrations.routes';
import { registerUserRoutes } from './modules/users/users.routes';
import { registerWorkspaceRoutes } from './modules/workspace/workspace.routes';
import { registerCollaboratorRoutes } from './modules/collaborators/collaborators.routes';

/**
 * Construye la aplicacion Hono.
 *
 * Se expone como fabrica (y no como instancia global) para que los tests puedan
 * crear una app aislada por caso y para mantener el arranque libre de efectos
 * secundarios.
 */
export function createApp(): OpenAPIHono<AppEnv> {
  const app = new OpenAPIHono<AppEnv>({
    // Toda falla de validacion Zod termina en el manejador global de errores,
    // garantizando un unico formato de respuesta para el 422.
    defaultHook: (result) => {
      if (!result.success) {
        throw zodErrorToAppError(result.error, 'request');
      }
    },
  });

  /* --- Middleware global (el orden importa) --- */
  app.use('*', requestIdMiddleware);
  app.use('*', requestLoggerMiddleware);
  app.use('*', corsMiddleware());

  /* --- Manejo centralizado de errores --- */
  app.onError(createErrorHandler());
  app.notFound(createNotFoundHandler());

  /* --- Rutas de negocio versionadas --- */
  const api = new OpenAPIHono<AppEnv>({ strict: false });
  registerAuthRoutes(api);
  registerHealthRoutes(api);
  registerUserRoutes(api);
  registerClientRoutes(api);
  registerEventRoutes(api);
  registerEstablishmentRoutes(api);
  registerParticipationRoutes(api);
  registerRegistrationRoutes(api);
  registerPublicRoutes(api);
  registerCheckInRoutes(api);
  registerCheckInBoardRoutes(api);
  registerDashboardRoutes(api);
  registerWorkspaceRoutes(api);
  registerCollaboratorRoutes(api);
  app.route(API_PREFIX, api);

  /* --- Documentacion OpenAPI --- */
  app.doc(`${API_PREFIX}/openapi.json`, {
    openapi: '3.1.0',
    info: {
      title: OPENAPI_TITLE,
      version: SERVICE_VERSION,
      description: OPENAPI_DESCRIPTION,
    },
    tags: [
      { name: 'Sistema', description: 'Estado del servicio y documentacion.' },
      { name: 'Autenticacion', description: 'Sesion de operadores y administradores.' },
      { name: 'Usuarios', description: 'Alta y mantenimiento de cuentas (solo administradores).' },
      { name: 'Eventos', description: 'Catalogo de eventos y sus ventanas de registro.' },
      { name: 'Establecimientos', description: 'Catalogo de sedes.' },
      {
        name: 'Participaciones',
        description: 'Una sede dentro de un evento: cupos y ventanas propias.',
      },
      {
        name: 'Registros',
        description: 'Mesa de registro: alta manual, consulta y cancelacion.',
      },
      {
        name: 'Publico',
        description: 'Catalogo publicado y formulario de inscripcion (sin sesion).',
      },
      {
        name: 'Ingreso',
        description: 'Escaneo del QR en puerta y turnos consecutivos por sede.',
      },
      {
        name: 'Tablero',
        description: 'Vista general, evolucion de inscripciones y actividad reciente.',
      },
      {
        name: 'Espacio',
        description: 'Identidad compartida del espacio y tema personal de cada cuenta.',
      },
    ],
  });
  app.get(`${API_PREFIX}/docs`, swaggerUI({ url: `${API_PREFIX}/openapi.json` }));

  // La raiz redirige a la documentacion interactiva para que un humano que
  // abra el dominio del Worker encuentre algo util.
  app.get('/', (c) => c.redirect(`${API_PREFIX}/docs`, 302));

  return app;
}

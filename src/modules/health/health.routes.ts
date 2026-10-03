import { OpenAPIHono, createRoute, z, type RouteHandler } from '@hono/zod-openapi';
import { SERVICE_NAME, SERVICE_VERSION } from '../../config/constants';
import { readRuntimeConfig } from '../../config/env';
import { apiSuccess } from '../../core/http/responses';
import type { AppEnv } from '../../core/types/context';
import { checkDatabase } from '../../db/client';

const healthStatusSchema = z.enum(['ok', 'degraded']);

const healthResponseSchema = z
  .object({
    success: z.literal(true),
    data: z.object({
      status: healthStatusSchema,
      service: z.string(),
      version: z.string(),
      environment: z.enum(['local', 'development', 'production']),
      timestamp: z.string(),
      database: z.enum(['up', 'down', 'not_configured']),
    }),
  })
  .openapi('HealthResponse');

/** Estado agregado del servicio, derivado del esquema publicado. */
type HealthStatus = z.infer<typeof healthStatusSchema>;

const healthRoute = createRoute({
  method: 'get',
  path: '/health',
  tags: ['Sistema'],
  summary: 'Estado del servicio',
  description:
    'Devuelve el estado de la API y de su dependencia D1. Responde 503 cuando la base de datos esta configurada pero no responde.',
  responses: {
    200: {
      description: 'Servicio operativo.',
      content: { 'application/json': { schema: healthResponseSchema } },
    },
    503: {
      description: 'Servicio degradado: D1 no responde.',
      content: { 'application/json': { schema: healthResponseSchema } },
    },
  },
});

const healthHandler: RouteHandler<typeof healthRoute, AppEnv> = async (c) => {
  const config = readRuntimeConfig(c.env);
  const database = await checkDatabase(c.env);
  const status: HealthStatus = database === 'down' ? 'degraded' : 'ok';

  const body = apiSuccess({
    status,
    service: SERVICE_NAME,
    version: SERVICE_VERSION,
    environment: config.environment,
    timestamp: new Date().toISOString(),
    database,
  });

  return status === 'degraded' ? c.json(body, 503) : c.json(body, 200);
};

/** Registra las rutas de sistema (sin autenticacion). */
export function registerHealthRoutes(app: OpenAPIHono<AppEnv>): void {
  app.openapi(healthRoute, healthHandler);
}

import { createMiddleware } from 'hono/factory';
import type { AppEnv } from '../types/context';

/**
 * Registro estructurado de peticiones HTTP.
 *
 * Notas de privacidad: se registra `c.req.path` (sin query string) para que
 * parametros sensibles -por ejemplo tokens en enlaces de verificacion- nunca
 * terminen en los logs. No se registran cabeceras ni cuerpos.
 */
export const requestLoggerMiddleware = createMiddleware<AppEnv>(async (c, next) => {
  const startedAt = Date.now();

  await next();

  const status = c.res.status;
  const entry = {
    level: status >= 500 ? 'error' : status >= 400 ? 'warn' : 'info',
    msg: 'http_request',
    requestId: c.get('requestId'),
    method: c.req.method,
    path: c.req.path,
    status,
    durationMs: Date.now() - startedAt,
  };

  const line = JSON.stringify(entry);
  if (status >= 500) {
    console.error(line);
  } else if (status >= 400) {
    console.warn(line);
  } else {
    console.log(line);
  }
});

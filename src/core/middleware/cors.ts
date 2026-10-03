import type { Context, MiddlewareHandler } from 'hono';
import { cors } from 'hono/cors';
import { readRuntimeConfig } from '../../config/env';
import type { AppEnv } from '../types/context';

/** Cabeceras que el cliente puede enviar. Se mantiene en lista blanca explicita. */
const ALLOWED_HEADERS = ['Content-Type', 'Authorization', 'X-Request-Id'];
/** Cabeceras que la API expone al navegador. */
const EXPOSED_HEADERS = ['X-Request-Id'];
const ALLOWED_METHODS = ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'];

/**
 * CORS en lista blanca.
 *
 * El origen se resuelve contra `CORS_ORIGINS` (variable de entorno separada por
 * comas). Devuelve `null` cuando el origen no esta autorizado, de forma que el
 * navegador bloquee la respuesta. `credentials: true` es necesario porque la
 * sesion viaja en una cookie `HttpOnly`.
 */
export function corsMiddleware(): MiddlewareHandler<AppEnv> {
  return cors({
    // El parametro se anota de forma explicita: `cors()` de Hono no es generico
    // y, sin la anotacion, `c.env` quedaria sin tipo.
    origin: (origin: string, c: Context<AppEnv>) => {
      const { corsOrigins } = readRuntimeConfig(c.env);
      if (corsOrigins.length === 0) {
        return null;
      }
      return corsOrigins.includes(origin) ? origin : null;
    },
    allowMethods: ALLOWED_METHODS,
    allowHeaders: ALLOWED_HEADERS,
    exposeHeaders: EXPOSED_HEADERS,
    credentials: true,
    maxAge: 600,
  });
}

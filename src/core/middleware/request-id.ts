import { createMiddleware } from 'hono/factory';
import type { AppEnv } from '../types/context';

/**
 * Formato aceptado para un `x-request-id` entrante. Se restringe a caracteres
 * seguros para evitar inyeccion de cabeceras y valores arbitrarios en logs.
 */
const REQUEST_ID_PATTERN = /^[A-Za-z0-9._:-]{8,128}$/;

/**
 * Asigna un identificador unico a cada peticion.
 *
 * Si el cliente envia un `x-request-id` valido se reutiliza (permite
 * correlacionar en sistemas distribuidos); en caso contrario se genera.
 * El valor viaja en la cabecera de respuesta `x-request-id` y en el sobre de
 * error, lo que permite rastrear un fallo concreto en los logs.
 */
export const requestIdMiddleware = createMiddleware<AppEnv>(async (c, next) => {
  const incoming = c.req.header('x-request-id');
  const requestId =
    incoming !== undefined && REQUEST_ID_PATTERN.test(incoming) ? incoming : crypto.randomUUID();

  c.set('requestId', requestId);
  // Se fija antes de `next()` para que todas las respuestas creadas aguas abajo
  // (incluidas las del manejador de errores) incluyan la cabecera.
  c.header('x-request-id', requestId);

  await next();
});

/**
 * Constantes estaticas del servicio.
 *
 * El prefijo de la API es una constante y no una variable de entorno: las rutas
 * de Hono se registran al construir la app, antes de que los bindings esten
 * disponibles, por lo que un prefijo variable por entorno seria una trampa.
 */
export const API_PREFIX = '/api/v1';

export const SERVICE_NAME = 'events-api';
export const SERVICE_VERSION = '0.1.0';

export const OPENAPI_TITLE = 'Events API - Barby Toys & Cupidos';
export const OPENAPI_DESCRIPTION = [
  'API para el registro de participantes, la emision de codigos QR y la',
  'asignacion de turnos de acceso en los eventos de Barby Toys y Cupidos.',
  '',
  'Convenciones:',
  '- Todas las respuestas usan el sobre { success, data } o { success: false, error }.',
  '- Los errores se identifican por error.code (contrato estable), no por el mensaje.',
  '- Las fechas se expresan en ISO-8601 UTC.',
].join('\n');

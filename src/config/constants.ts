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

/**
 * Valores por defecto de la configuracion de autenticacion.
 *
 * Son el respaldo cuando el `var` correspondiente no esta definido y la fuente
 * unica que usan las primitivas puras (por ejemplo `hashPassword`), de modo que
 * el coste de derivacion no se duplique en cada archivo.
 */
export const AUTH_DEFAULTS = {
  /** PBKDF2-SHA256: por debajo de 210 000 el coste deja de ser disuasorio. */
  pbkdf2Iterations: 210_000,
  /** Duracion de una sesion; se renueva volviendo a iniciar sesion. */
  sessionTtlHours: 12,
  /** Nombre de la cookie que transporta el token opaco. */
  cookieName: 'events_session',
  /** Fallos consecutivos antes del primer bloqueo. */
  maxFailedAttempts: 5,
  /** Duracion del primer bloqueo, en minutos. */
  lockoutMinutes: 15,
  /** Tope del bloqueo progresivo: 15, 30, 60, 120... hasta 8x la base. */
  maxLockoutMultiplier: 8,
} as const;

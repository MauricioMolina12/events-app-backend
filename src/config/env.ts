import { AppError } from '../core/errors/app-error';
import { ErrorCode } from '../core/errors/error-codes';
import { AUTH_DEFAULTS } from './constants';

/** Entornos soportados. `local` tambien cubre el modo preview de Wrangler. */
export type RuntimeEnvironment = 'local' | 'development' | 'production';

const RUNTIME_ENVIRONMENTS: readonly RuntimeEnvironment[] = ['local', 'development', 'production'];

/** Parametros de autenticacion derivados de los `vars` del Worker. */
export interface AuthConfig {
  /** Iteraciones de PBKDF2-SHA256 con las que se crean los hashes nuevos. */
  readonly pbkdf2Iterations: number;
  /** Vida de una sesion, en horas. */
  readonly sessionTtlHours: number;
  /** Nombre de la cookie que transporta el token opaco. */
  readonly cookieName: string;
  /** `Secure` en la cookie: se desactiva solo en `local`, que va por http. */
  readonly secureCookies: boolean;
  /** Fallos dentro de la ventana que disparan el primer bloqueo. */
  readonly maxFailedAttempts: number;
  /** Duracion base del bloqueo, en minutos. */
  readonly lockoutMinutes: number;
  /** Tope del bloqueo progresivo, como multiplo de `lockoutMinutes`. */
  readonly maxLockoutMultiplier: number;
}

/** Configuracion de ejecucion derivada de los `vars` del Worker. */
export interface RuntimeConfig {
  readonly environment: RuntimeEnvironment;
  readonly corsOrigins: readonly string[];
  readonly auth: AuthConfig;
}

function parseEnvironment(value: string | undefined): RuntimeEnvironment {
  const raw = (value ?? 'local').trim().toLowerCase();
  const match = RUNTIME_ENVIRONMENTS.find((candidate) => candidate === raw);

  if (match === undefined) {
    throw new AppError(
      ErrorCode.INTERNAL_ERROR,
      500,
      `Configuracion invalida: ENVIRONMENT debe ser uno de ${RUNTIME_ENVIRONMENTS.join(' | ')}.`,
      { expose: true },
    );
  }

  return match;
}

function parseOrigins(value: string | undefined): string[] {
  if (value === undefined) {
    return [];
  }

  return value
    .split(',')
    .map((origin) => origin.trim())
    .filter((origin) => origin !== '');
}

interface IntBounds {
  readonly min: number;
  readonly max: number;
}

/**
 * Lee un `var` numerico.
 *
 * Un valor ausente cae al default; uno presente pero invalido es un error de
 * despliegue y falla ruidosamente, igual que un `ENVIRONMENT` desconocido.
 */
function parseInteger(
  name: string,
  value: string | undefined,
  fallback: number,
  bounds: IntBounds,
): number {
  const raw = (value ?? '').trim();
  if (raw === '') {
    return fallback;
  }

  const parsed = Number.parseInt(raw, 10);
  if (!Number.isInteger(parsed) || parsed < bounds.min || parsed > bounds.max) {
    throw new AppError(
      ErrorCode.INTERNAL_ERROR,
      500,
      `Configuracion invalida: ${name} debe ser un entero entre ${bounds.min} y ${bounds.max}.`,
      { expose: true },
    );
  }

  return parsed;
}

/** Nombre de cookie admisible segun RFC 6265 (un `token` sin separadores). */
const COOKIE_NAME_PATTERN = /^[A-Za-z0-9!#$%&'*+\-.^_`|~]{1,64}$/u;

function parseCookieName(value: string | undefined): string {
  const name = (value ?? '').trim() === '' ? AUTH_DEFAULTS.cookieName : (value ?? '').trim();

  if (!COOKIE_NAME_PATTERN.test(name)) {
    throw new AppError(
      ErrorCode.INTERNAL_ERROR,
      500,
      'Configuracion invalida: SESSION_COOKIE_NAME no es un nombre de cookie valido.',
      { expose: true },
    );
  }

  return name;
}

/**
 * Lee y valida la configuracion de runtime.
 *
 * Se resuelve por peticion porque los bindings solo estan disponibles dentro
 * del handler; el coste es despreciable y evita estado global mutable.
 */
export function readRuntimeConfig(env: CloudflareBindings): RuntimeConfig {
  const environment = parseEnvironment(env.ENVIRONMENT);

  return {
    environment,
    corsOrigins: parseOrigins(env.CORS_ORIGINS),
    auth: {
      pbkdf2Iterations: parseInteger(
        'PBKDF2_ITERATIONS',
        env.PBKDF2_ITERATIONS,
        AUTH_DEFAULTS.pbkdf2Iterations,
        { min: 1_000, max: 1_000_000 },
      ),
      sessionTtlHours: parseInteger(
        'SESSION_TTL_HOURS',
        env.SESSION_TTL_HOURS,
        AUTH_DEFAULTS.sessionTtlHours,
        { min: 1, max: 720 },
      ),
      cookieName: parseCookieName(env.SESSION_COOKIE_NAME),
      // En `local` el desarrollo ocurre sobre http: una cookie `Secure` seria
      // descartada por el navegador y el login pareceria roto.
      secureCookies: environment !== 'local',
      maxFailedAttempts: parseInteger(
        'AUTH_MAX_FAILED_ATTEMPTS',
        env.AUTH_MAX_FAILED_ATTEMPTS,
        AUTH_DEFAULTS.maxFailedAttempts,
        { min: 1, max: 100 },
      ),
      lockoutMinutes: parseInteger(
        'AUTH_LOCKOUT_MINUTES',
        env.AUTH_LOCKOUT_MINUTES,
        AUTH_DEFAULTS.lockoutMinutes,
        { min: 1, max: 1440 },
      ),
      maxLockoutMultiplier: AUTH_DEFAULTS.maxLockoutMultiplier,
    },
  };
}


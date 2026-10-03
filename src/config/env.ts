import { AppError } from '../core/errors/app-error';
import { ErrorCode } from '../core/errors/error-codes';

/** Entornos soportados. `local` tambien cubre el modo preview de Wrangler. */
export type RuntimeEnvironment = 'local' | 'development' | 'production';

const RUNTIME_ENVIRONMENTS: readonly RuntimeEnvironment[] = ['local', 'development', 'production'];

/** Configuracion de ejecucion derivada de los `vars` del Worker. */
export interface RuntimeConfig {
  readonly environment: RuntimeEnvironment;
  readonly corsOrigins: readonly string[];
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

/**
 * Lee y valida la configuracion de runtime.
 *
 * Se resuelve por peticion porque los bindings solo estan disponibles dentro
 * del handler; el coste es despreciable y evita estado global mutable.
 */
export function readRuntimeConfig(env: CloudflareBindings): RuntimeConfig {
  return {
    environment: parseEnvironment(env.ENVIRONMENT),
    corsOrigins: parseOrigins(env.CORS_ORIGINS),
  };
}

import type { Context } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { ZodError } from 'zod';
import { apiError } from '../http/responses';
import type { AppEnv } from '../types/context';
import { AppError, isAppError } from './app-error';
import { ErrorCode, type ErrorCodeValue } from './error-codes';
import { zodErrorToAppError } from './validation-error';

/** Mensajes genericos para errores que no deben exponer detalles internos. */
const FALLBACK_MESSAGES: Partial<Record<ErrorCodeValue, string>> = {
  [ErrorCode.INTERNAL_ERROR]: 'Ocurrio un error interno.',
  [ErrorCode.DATABASE_UNAVAILABLE]: 'La base de datos no esta disponible temporalmente.',
  [ErrorCode.SERVICE_UNAVAILABLE]: 'El servicio no esta disponible temporalmente.',
};

/** Traduce `HTTPException` de Hono a un codigo de error del catalogo. */
function httpStatusToErrorCode(status: number): ErrorCodeValue {
  switch (status) {
    case 400:
      return ErrorCode.VALIDATION_ERROR;
    case 401:
      return ErrorCode.UNAUTHENTICATED;
    case 403:
      return ErrorCode.FORBIDDEN;
    case 404:
      return ErrorCode.ROUTE_NOT_FOUND;
    case 405:
      return ErrorCode.METHOD_NOT_ALLOWED;
    case 413:
      return ErrorCode.PAYLOAD_TOO_LARGE;
    case 429:
      return ErrorCode.RATE_LIMITED;
    case 503:
      return ErrorCode.SERVICE_UNAVAILABLE;
    default:
      return status >= 500 ? ErrorCode.INTERNAL_ERROR : ErrorCode.VALIDATION_ERROR;
  }
}

/**
 * Normaliza cualquier error lanzado por la aplicacion a un `AppError`.
 *
 * Todo lo que no sea un `AppError` se considera un bug: se registra completo en
 * los logs y al cliente solo se le entrega un mensaje generico.
 */
export function normalizeError(error: unknown): AppError {
  if (isAppError(error)) {
    return error;
  }

  if (error instanceof ZodError) {
    return zodErrorToAppError(error, 'request');
  }

  if (error instanceof HTTPException) {
    return new AppError(httpStatusToErrorCode(error.status), error.status, error.message, {
      expose: error.status < 500,
      cause: error,
    });
  }

  if (error instanceof SyntaxError) {
    return new AppError(
      ErrorCode.MALFORMED_JSON,
      400,
      'El cuerpo de la solicitud no es un JSON valido.',
      { cause: error },
    );
  }

  return new AppError(ErrorCode.INTERNAL_ERROR, 500, 'Ocurrio un error interno.', {
    cause: error,
    expose: false,
  });
}

/** Serializa un error para el log, sin incluir el cuerpo de la peticion. */
function serializeError(error: AppError): Record<string, unknown> {
  const cause = error.cause instanceof Error ? error.cause : undefined;
  return {
    name: error.name,
    code: error.code,
    message: error.message,
    ...(error.status >= 500 && error.stack !== undefined ? { stack: error.stack } : {}),
    ...(cause !== undefined
      ? { cause: { name: cause.name, message: cause.message, stack: cause.stack } }
      : {}),
  };
}

/** Registra el error con la forma esperada por Workers Logs (JSON estructurado). */
function logError(error: AppError, c: Context<AppEnv>): void {
  const entry = {
    level: error.status >= 500 ? 'error' : 'warn',
    msg: 'request_error',
    requestId: c.get('requestId'),
    method: c.req.method,
    path: c.req.path,
    status: error.status,
    code: error.code,
    error: serializeError(error),
  };

  const line = JSON.stringify(entry);
  if (error.status >= 500) {
    console.error(line);
  } else {
    console.warn(line);
  }
}

/** Construye la respuesta HTTP de error respetando el sobre comun. */
export function errorResponse(error: AppError, c: Context<AppEnv>): Response {
  const message = error.expose
    ? error.message
    : (FALLBACK_MESSAGES[error.code] ?? 'Ocurrio un error interno.');

  const body = apiError(error.code, message, {
    details: error.expose ? error.details : undefined,
    requestId: c.get('requestId'),
  });

  // `details` es deliberadamente libre (unknown), por lo que el cuerpo se pasa
  // tal cual: los esquemas de error se validan en los tests de integracion.
  return c.json(body, error.status);
}

/** Manejador global de errores (`app.onError`). */
export function createErrorHandler() {
  return (error: unknown, c: Context<AppEnv>): Response => {
    const appError = normalizeError(error);
    logError(appError, c);
    return errorResponse(appError, c);
  };
}

/** Manejador de rutas inexistentes (`app.notFound`). */
export function createNotFoundHandler() {
  return (c: Context<AppEnv>): Response => {
    const error = AppError.notFound(
      ErrorCode.ROUTE_NOT_FOUND,
      `La ruta ${c.req.method} ${c.req.path} no existe.`,
    );
    logError(error, c);
    return errorResponse(error, c);
  };
}

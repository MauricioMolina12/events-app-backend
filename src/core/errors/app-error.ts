import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { ErrorCode, type ErrorCodeValue } from './error-codes';

export interface AppErrorOptions {
  /** Datos estructurados adicionales, seguros de exponer al cliente. */
  details?: unknown;
  /** Causa original. Se registra en logs, nunca se serializa al cliente. */
  cause?: unknown;
  /** Si es `false`, el mensaje se reemplaza por uno generico en la respuesta. */
  expose?: boolean;
}

/**
 * Error de aplicacion con codigo de negocio y estado HTTP.
 *
 * Regla: toda falla esperada del dominio se lanza como `AppError`. Cualquier
 * otro error que escape se considera un bug y se responde como `INTERNAL_ERROR`
 * sin filtrar detalles internos.
 */
export class AppError extends Error {
  readonly code: ErrorCodeValue;
  readonly status: ContentfulStatusCode;
  readonly details?: unknown;
  readonly expose: boolean;

  constructor(
    code: ErrorCodeValue,
    status: ContentfulStatusCode,
    message: string,
    options: AppErrorOptions = {},
  ) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = 'AppError';
    this.code = code;
    this.status = status;
    this.expose = options.expose ?? true;
    if (options.details !== undefined) {
      this.details = options.details;
    }
  }

  /** 400: la peticion esta mal formada a nivel semantico. */
  static badRequest(
    code: ErrorCodeValue = ErrorCode.VALIDATION_ERROR,
    message = 'La solicitud contiene datos invalidos.',
    options?: AppErrorOptions,
  ): AppError {
    return new AppError(code, 400, message, options);
  }

  /** 401: falta autenticacion o las credenciales no son validas. */
  static unauthorized(
    code: ErrorCodeValue = ErrorCode.UNAUTHENTICATED,
    message = 'Se requiere autenticacion para realizar esta operacion.',
    options?: AppErrorOptions,
  ): AppError {
    return new AppError(code, 401, message, options);
  }

  /** 403: autenticado pero sin permisos suficientes. */
  static forbidden(
    code: ErrorCodeValue = ErrorCode.FORBIDDEN,
    message = 'No tienes permisos para realizar esta operacion.',
    options?: AppErrorOptions,
  ): AppError {
    return new AppError(code, 403, message, options);
  }

  /** 404: el recurso solicitado no existe. */
  static notFound(
    code: ErrorCodeValue = ErrorCode.NOT_FOUND,
    message = 'El recurso solicitado no existe.',
    options?: AppErrorOptions,
  ): AppError {
    return new AppError(code, 404, message, options);
  }

  /** 409: conflicto con el estado actual del recurso. */
  static conflict(
    code: ErrorCodeValue,
    message: string,
    options?: AppErrorOptions,
  ): AppError {
    return new AppError(code, 409, message, options);
  }

  /** 422: sintaxis correcta pero datos que violan reglas de negocio. */
  static unprocessable(
    code: ErrorCodeValue,
    message: string,
    options?: AppErrorOptions,
  ): AppError {
    return new AppError(code, 422, message, options);
  }

  /** 429: limite de peticiones superado. */
  static tooManyRequests(
    code: ErrorCodeValue = ErrorCode.RATE_LIMITED,
    message = 'Demasiadas solicitudes. Intenta de nuevo en unos segundos.',
    options?: AppErrorOptions,
  ): AppError {
    return new AppError(code, 429, message, options);
  }

  /** 500: falla inesperada. El mensaje no se expone. */
  static internal(message = 'Ocurrio un error interno.', options?: AppErrorOptions): AppError {
    return new AppError(ErrorCode.INTERNAL_ERROR, 500, message, { ...options, expose: false });
  }
}

/** Type guard para distinguir errores de dominio de errores inesperados. */
export function isAppError(value: unknown): value is AppError {
  return value instanceof AppError;
}

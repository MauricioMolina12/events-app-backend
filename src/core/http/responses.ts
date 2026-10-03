/**
 * Sobres de respuesta de la API.
 *
 * Todas las respuestas (exito y error) comparten la misma forma para que el
 * cliente pueda ramificar con un unico discriminante binario: `success`.
 */
export interface ApiMeta {
  [key: string]: unknown;
}

export interface ApiSuccessBody<T> {
  success: true;
  data: T;
  meta?: ApiMeta;
}

export interface ApiErrorBody {
  success: false;
  error: {
    code: string;
    message: string;
    details?: unknown;
  };
  requestId?: string;
}

/** Construye el cuerpo de una respuesta exitosa. */
export function apiSuccess<T>(data: T, meta?: ApiMeta): ApiSuccessBody<T> {
  return meta === undefined ? { success: true, data } : { success: true, data, meta };
}

/** Construye el cuerpo de una respuesta de error. */
export function apiError(
  code: string,
  message: string,
  options: { details?: unknown; requestId?: string } = {},
): ApiErrorBody {
  const body: ApiErrorBody = { success: false, error: { code, message } };
  if (options.details !== undefined) {
    body.error.details = options.details;
  }
  if (options.requestId !== undefined) {
    body.requestId = options.requestId;
  }
  return body;
}

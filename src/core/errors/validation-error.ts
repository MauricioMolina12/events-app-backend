import type { ZodError } from 'zod';
import { AppError } from './app-error';
import { ErrorCode } from './error-codes';

/** Origen de la validacion fallida: parametros, query, cuerpo o cabeceras. */
export type ValidationTarget = 'json' | 'query' | 'param' | 'header' | 'cookie' | 'form';

interface ValidationIssue {
  path: string;
  code: string;
  message: string;
}

/**
 * Convierte un `ZodError` en un `AppError` 422 con la lista de campos invalidos.
 *
 * Solo se expone `path`, `code` y `message`: nunca el valor recibido, para no
 * filtrar datos personales en la respuesta ni en los logs.
 */
export function zodErrorToAppError(error: ZodError, target: ValidationTarget | string): AppError {
  const issues: ValidationIssue[] = error.issues.map((issue) => ({
    path: issue.path.map((segment) => String(segment)).join('.'),
    code: issue.code,
    message: issue.message,
  }));

  return new AppError(
    ErrorCode.VALIDATION_ERROR,
    422,
    'La solicitud no cumple el formato esperado.',
    { details: { target, issues } },
  );
}

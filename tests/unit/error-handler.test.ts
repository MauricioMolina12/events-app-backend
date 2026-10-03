import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { AppError, isAppError } from '../../src/core/errors/app-error';
import { ErrorCode } from '../../src/core/errors/error-codes';
import { normalizeError } from '../../src/core/errors/error-handler';
import { zodErrorToAppError } from '../../src/core/errors/validation-error';

describe('AppError', () => {
  it('conserva codigo, estado y mensaje', () => {
    const error = AppError.conflict(ErrorCode.DUPLICATE_REGISTRATION, 'Documento duplicado.');

    expect(isAppError(error)).toBe(true);
    expect(error.code).toBe(ErrorCode.DUPLICATE_REGISTRATION);
    expect(error.status).toBe(409);
    expect(error.message).toBe('Documento duplicado.');
    expect(error.expose).toBe(true);
  });

  it('marca como no expuestos los errores internos', () => {
    const error = AppError.internal('Fallo de SQL en la tabla registrations.');

    expect(error.status).toBe(500);
    expect(error.expose).toBe(false);
  });
});

describe('zodErrorToAppError', () => {
  it('convierte un ZodError en un 422 con las rutas invalidas y sin valores recibidos', () => {
    const schema = z.object({ documentNumber: z.string().min(5), email: z.email() });
    const result = schema.safeParse({ documentNumber: '12', email: 'no-es-email' });

    expect(result.success).toBe(false);
    if (result.success) {
      return;
    }

    const error = zodErrorToAppError(result.error, 'json');
    const details = error.details as { target: string; issues: { path: string }[] };

    expect(error.status).toBe(422);
    expect(error.code).toBe(ErrorCode.VALIDATION_ERROR);
    expect(details.target).toBe('json');
    expect(details.issues.map((issue) => issue.path).sort()).toEqual([
      'documentNumber',
      'email',
    ]);
    // Los valores enviados nunca deben viajar en los detalles del error.
    expect(JSON.stringify(error.details)).not.toContain('no-es-email');
  });
});

describe('normalizeError', () => {
  it('devuelve el mismo error cuando ya es un AppError', () => {
    const original = AppError.notFound(ErrorCode.EVENT_NOT_FOUND, 'Evento no encontrado.');
    expect(normalizeError(original)).toBe(original);
  });

  it('convierte un SyntaxError en MALFORMED_JSON 400', () => {
    const error = normalizeError(new SyntaxError('Unexpected token'));

    expect(error.code).toBe(ErrorCode.MALFORMED_JSON);
    expect(error.status).toBe(400);
    expect(error.expose).toBe(true);
  });

  it('convierte un error desconocido en INTERNAL_ERROR 500 no expuesto', () => {
    const error = normalizeError(new Error('D1_ERROR: no such table: registrations'));

    expect(error.code).toBe(ErrorCode.INTERNAL_ERROR);
    expect(error.status).toBe(500);
    expect(error.expose).toBe(false);

    const serialized = JSON.stringify(error);
    expect(serialized).not.toContain('no such table');
  });
});

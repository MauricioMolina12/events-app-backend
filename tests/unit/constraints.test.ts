import { describe, expect, it } from 'vitest';
import { isAppError } from '../../src/core/errors/app-error';
import { ErrorCode } from '../../src/core/errors/error-codes';
import {
  isCheckViolation,
  isForeignKeyViolation,
  isUniqueViolation,
  mapConstraintViolation,
  resolveConstraintViolation,
} from '../../src/db/constraints';

/**
 * Pruebas puras de la traduccion de restricciones de SQLite a errores de
 * dominio. Los mensajes replican el formato real que entrega D1 (los tests de
 * integracion comprueban ademas que el formato de verdad coincide).
 */
describe('traduccion de violaciones de restricciones', () => {
  it('reconoce el indice unico de documento por su nombre', () => {
    const error = new Error(
      "D1_ERROR: UNIQUE constraint failed: index 'registrations_participation_document_unique'",
    );

    expect(resolveConstraintViolation(error)?.code).toBe(ErrorCode.DUPLICATE_REGISTRATION);
    expect(resolveConstraintViolation(error)?.status).toBe(409);
  });

  it('reconoce la violacion cuando SQLite reporta columnas en lugar del indice', () => {
    const error = new Error('UNIQUE constraint failed: users.email');

    expect(resolveConstraintViolation(error)?.code).toBe(ErrorCode.EMAIL_ALREADY_USED);
  });

  it('reconoce el mensaje real de D1, que anexa el codigo extendido', () => {
    // Texto exacto observado en workerd (ver tests/integration/schema.test.ts).
    const error = new Error(
      'D1_ERROR: UNIQUE constraint failed: registrations.participation_id, registrations.document_type, registrations.document_number: SQLITE_CONSTRAINT (extended: SQLITE_CONSTRAINT_UNIQUE)',
    );

    expect(resolveConstraintViolation(error)?.code).toBe(ErrorCode.DUPLICATE_REGISTRATION);
    expect(resolveConstraintViolation(error)?.status).toBe(409);
  });

  it('traduce los CHECK de cupo a su codigo de negocio', () => {
    const titular = new Error(
      'D1_ERROR: CHECK constraint failed: event_establishments_titular_capacity_check',
    );
    const companion = new Error(
      'D1_ERROR: CHECK constraint failed: event_establishments_companion_capacity_check',
    );

    expect(resolveConstraintViolation(titular)?.code).toBe(ErrorCode.TITULAR_CAPACITY_EXCEEDED);
    expect(resolveConstraintViolation(companion)?.code).toBe(
      ErrorCode.COMPANION_CAPACITY_EXCEEDED,
    );
  });

  it('devuelve null para una restriccion no registrada', () => {
    const error = new Error("UNIQUE constraint failed: index 'sessions_token_hash_unique'");

    expect(resolveConstraintViolation(error)).toBeNull();
  });

  it('convierte lo desconocido en un error interno que conserva la causa', () => {
    const causa = new Error('UNIQUE constraint failed: index \'sessions_token_hash_unique\'');
    const error = mapConstraintViolation(causa);

    expect(error.code).toBe(ErrorCode.INTERNAL_ERROR);
    expect(error.status).toBe(500);
    expect(error.expose).toBe(false);
    expect(error.cause).toBe(causa);
  });

  it('no reescribe un AppError que ya venia traducido', () => {
    const original = mapConstraintViolation(new Error('UNIQUE constraint failed: users.email'));

    expect(mapConstraintViolation(original)).toBe(original);
    expect(isAppError(resolveConstraintViolation(original))).toBe(true);
  });

  it('clasifica el tipo de violacion', () => {
    expect(isUniqueViolation(new Error('UNIQUE constraint failed: users.email'))).toBe(true);
    expect(isUniqueViolation(new Error('CHECK constraint failed: shifts_assigned_count_check'))).toBe(
      false,
    );
    expect(isCheckViolation(new Error('CHECK constraint failed: shifts_assigned_count_check'))).toBe(
      true,
    );
    expect(isForeignKeyViolation(new Error('FOREIGN KEY constraint failed'))).toBe(true);
  });

  it('acepta el error como cadena, no solo como Error', () => {
    expect(resolveConstraintViolation('UNIQUE constraint failed: users.email')?.code).toBe(
      ErrorCode.EMAIL_ALREADY_USED,
    );
  });

  it('reconoce el error envuelto por Drizzle, que deja el texto real en cause', () => {
    const unique = wrappedDrizzleError(
      'D1_ERROR: UNIQUE constraint failed: establishments.code: SQLITE_CONSTRAINT (extended: SQLITE_CONSTRAINT_UNIQUE)',
    );
    const check = wrappedDrizzleError(
      'D1_ERROR: CHECK constraint failed: event_establishments_titular_capacity_check: SQLITE_CONSTRAINT (extended: SQLITE_CONSTRAINT_CHECK)',
    );

    expect(isUniqueViolation(unique)).toBe(true);
    expect(resolveConstraintViolation(unique)?.code).toBe(ErrorCode.VALIDATION_ERROR);
    expect(resolveConstraintViolation(check)?.code).toBe(ErrorCode.TITULAR_CAPACITY_EXCEEDED);
  });
});

/**
 * Error con la forma que produce Drizzle: mensaje propio y el fallo del driver en
 * `cause`. Es el caso real de los repositorios, donde la sentencia pasa por
 * `drizzle-orm` y el texto de SQLite nunca esta en el primer nivel.
 */
function wrappedDrizzleError(driverMessage: string): Error {
  return new Error(
    'Failed query: insert into "establishments" ("id", "code") values (?, ?)\nparams: est-2,est-1',
    { cause: new Error(driverMessage) },
  );
}

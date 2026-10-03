import { describe, expect, it } from 'vitest';
import { AppError } from '../../src/core/errors/app-error';
import { ErrorCode } from '../../src/core/errors/error-codes';
import {
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  validatePassword,
} from '../../src/modules/users/users.service';
import { toAdminUser } from '../../src/modules/users/users.schemas';
import type { UserRow } from '../../src/modules/users/users.repository';

/**
 * Pruebas puras del modulo de usuarios.
 *
 * La politica de contrasenas y el mapeo a la ficha publica no dependen de D1: se
 * ejercitan aqui para que un cambio en los limites o en los campos expuestos
 * falle sin necesidad de levantar el runtime.
 */

/** Captura el error sincrono que lanza `action`, o `null` si no lanzo. */
function capturedError(action: () => void): unknown {
  try {
    action();
    return null;
  } catch (error) {
    return error;
  }
}

const STORED_USER: UserRow = {
  id: 'user-1',
  email: 'operador@example.com',
  fullName: 'Operador Uno',
  passwordHash: 'hash-secreto',
  passwordSalt: 'salt-secreto',
  passwordIterations: 1_000,
  role: 'operator',
  status: 'active',
  failedLoginAttempts: 0,
  lockedUntil: null,
  lastLoginAt: null,
  createdAt: new Date('2026-01-01T10:00:00.000Z'),
  updatedAt: new Date('2026-01-01T10:00:00.000Z'),
};

describe('validatePassword', () => {
  it('acepta una contrasena de la longitud minima', () => {
    expect(capturedError(() => validatePassword('a'.repeat(PASSWORD_MIN_LENGTH)))).toBeNull();
  });

  it(`rechaza una contrasena de menos de ${PASSWORD_MIN_LENGTH} caracteres`, () => {
    const error = capturedError(() => validatePassword('a'.repeat(PASSWORD_MIN_LENGTH - 1)));

    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).code).toBe(ErrorCode.VALIDATION_ERROR);
    expect((error as AppError).status).toBe(422);
  });

  it(`rechaza una contrasena de mas de ${PASSWORD_MAX_LENGTH} caracteres`, () => {
    const error = capturedError(() => validatePassword('a'.repeat(PASSWORD_MAX_LENGTH + 1)));

    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).code).toBe(ErrorCode.VALIDATION_ERROR);
  });
});

describe('toAdminUser', () => {
  it('expone la ficha publica con fechas ISO y sin credenciales', () => {
    const publicUser = toAdminUser(STORED_USER);

    expect(publicUser).toEqual({
      id: 'user-1',
      email: 'operador@example.com',
      fullName: 'Operador Uno',
      role: 'operator',
      status: 'active',
      failedLoginAttempts: 0,
      lockedUntil: null,
      lastLoginAt: null,
      createdAt: '2026-01-01T10:00:00.000Z',
      updatedAt: '2026-01-01T10:00:00.000Z',
    });
    expect(JSON.stringify(publicUser)).not.toContain('secreto');
  });
});

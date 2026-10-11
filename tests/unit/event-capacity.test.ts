import { describe, expect, it } from 'vitest';
import { AppError } from '../../src/core/errors/app-error';
import { ErrorCode } from '../../src/core/errors/error-codes';
import { assertWithinEventCapacity } from '../../src/modules/events/event-capacity';

describe('assertWithinEventCapacity', () => {
  it('acepta cuando la suma cabe en el cupo general', () => {
    expect(() => assertWithinEventCapacity(20, 10, 10)).not.toThrow();
  });

  it('rechaza cuando titulares y acompanantes de las sedes rebasan el techo', () => {
    try {
      assertWithinEventCapacity(20, 10, 11);
      throw new Error('debio fallar');
    } catch (error) {
      expect(error).toBeInstanceOf(AppError);
      expect((error as AppError).code).toBe(ErrorCode.EVENT_CAPACITY_EXCEEDED);
    }
  });
});

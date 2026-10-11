import { describe, expect, it } from 'vitest';
import { AppError } from '../../src/core/errors/app-error';
import { ErrorCode } from '../../src/core/errors/error-codes';
import { assertCanManageEvent, canManageEvent } from '../../src/modules/events/event-access';

describe('canManageEvent', () => {
  it('permite al administrador cualquier evento', () => {
    expect(canManageEvent({ id: 'admin-1', role: 'admin' }, { createdBy: 'op-1' })).toBe(true);
    expect(canManageEvent({ id: 'admin-1', role: 'admin' }, { createdBy: null })).toBe(true);
  });

  it('permite al operador solo el evento que creo', () => {
    expect(canManageEvent({ id: 'op-1', role: 'operator' }, { createdBy: 'op-1' })).toBe(true);
    expect(canManageEvent({ id: 'op-1', role: 'operator' }, { createdBy: 'op-2' })).toBe(false);
    expect(canManageEvent({ id: 'op-1', role: 'operator' }, { createdBy: null })).toBe(false);
  });
});

describe('assertCanManageEvent', () => {
  it('rechaza al operador que no es dueno', () => {
    try {
      assertCanManageEvent({ id: 'op-1', role: 'operator' }, { createdBy: 'admin-1' });
      throw new Error('debio fallar');
    } catch (error) {
      expect(error).toBeInstanceOf(AppError);
      expect((error as AppError).code).toBe(ErrorCode.FORBIDDEN);
    }
  });
});

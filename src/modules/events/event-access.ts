import { AppError } from '../../core/errors/app-error';
import { ErrorCode } from '../../core/errors/error-codes';
import type { AuthPrincipal } from '../../core/types/context';

/**
 * Quien puede mutar un evento (ficha, sedes y cupos).
 *
 * El administrador opera todo el catalogo. El operador solo el evento que creo
 * (`createdBy`). Un evento sin dueno (semillas o cuentas borradas) queda en
 * manos del administrador.
 */
export function canManageEvent(
  actor: Pick<AuthPrincipal, 'id' | 'role'>,
  event: { createdBy: string | null },
): boolean {
  return actor.role === 'admin' || event.createdBy === actor.id;
}

export function assertCanManageEvent(
  actor: Pick<AuthPrincipal, 'id' | 'role'>,
  event: { createdBy: string | null },
): void {
  if (canManageEvent(actor, event)) {
    return;
  }

  throw AppError.forbidden(
    ErrorCode.FORBIDDEN,
    'Solo el dueno del evento o un administrador pueden modificarlo.',
  );
}

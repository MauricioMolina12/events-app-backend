import { AppError } from '../../core/errors/app-error';
import { ErrorCode } from '../../core/errors/error-codes';

/** Tope compartido con los cupos de cada sede. */
export const EVENT_CAPACITY_MAX = 100_000;

/**
 * Comprueba que asignar `additionalSeats` personas (titulares + acompanantes)
 * no rebase el cupo general del evento.
 *
 * `alreadyAllocated` es la suma de las otras sedes vigentes (no canceladas).
 */
export function assertWithinEventCapacity(
  eventCapacity: number,
  alreadyAllocated: number,
  additionalSeats: number,
): void {
  const requested = alreadyAllocated + additionalSeats;
  if (requested <= eventCapacity) {
    return;
  }

  throw AppError.conflict(
    ErrorCode.EVENT_CAPACITY_EXCEEDED,
    'La suma de cupos de las sedes no puede superar el cupo general del evento.',
    {
      details: {
        capacity: eventCapacity,
        allocated: alreadyAllocated,
        requested,
      },
    },
  );
}

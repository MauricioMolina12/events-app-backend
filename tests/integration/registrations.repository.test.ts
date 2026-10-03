import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { isAppError, type AppError } from '../../src/core/errors/app-error';
import { ErrorCode } from '../../src/core/errors/error-codes';
import { createDb } from '../../src/db/client';
import * as establishments from '../../src/modules/establishments/establishments.repository';
import * as events from '../../src/modules/events/events.repository';
import * as participations from '../../src/modules/participations/participations.repository';
import * as registrationsRepo from '../../src/modules/registrations/registrations.repository';
import { countRows, truncateAll } from '../helpers/database';

/**
 * Repositorio de registros de participacion contra D1 real.
 *
 * Los casos clave son los que no se pueden resolver con una lectura previa: el
 * documento duplicado, la atomicidad del alta con acompanantes y la cancelacion
 * con sus compensaciones.
 */

const db = createDb(env);
const NOW = new Date(1_760_000_000_000);

beforeEach(truncateAll);

async function expectAppError(action: () => Promise<unknown>): Promise<AppError> {
  try {
    await action();
  } catch (error) {
    if (isAppError(error)) {
      return error;
    }
    throw error;
  }
  throw new Error('La operacion debia fallar y no lo hizo.');
}

/** Evento + sede + participacion con cupos holgados (o los que pida el test). */
async function seedParticipation(
  options: { titularCapacity?: number; companionCapacity?: number } = {},
): Promise<participations.ParticipationRow> {
  const event = await events.insertEvent(
    db,
    { slug: 'evento-1', name: 'Evento 1', status: 'published' },
    NOW,
  );
  const establishment = await establishments.insertEstablishment(
    db,
    { code: 'norte', name: 'Sede Norte' },
    NOW,
  );

  return participations.insertParticipation(
    db,
    {
      eventId: event.id,
      establishmentId: establishment.id,
      titularCapacity: options.titularCapacity ?? 5,
      companionCapacity: options.companionCapacity ?? 5,
    },
    NOW,
  );
}

/** Alta simple de titular, como la haria el repositorio desde el servicio. */
async function registerTitular(
  participationId: string,
  documentNumber: string,
  now: Date = NOW,
): Promise<registrationsRepo.RegistrationRow> {
  const created = await registrationsRepo.createRegistration(
    db,
    {
      participationId,
      documentType: 'CC',
      documentNumber,
      fullName: `Titular ${documentNumber}`,
      email: `titular-${documentNumber}@example.com`,
      source: 'public',
    },
    now,
  );

  return created.registration;
}

describe('registrations.repository', () => {
  it('crea el registro y sus acompanantes en un solo grupo', async () => {
    const participation = await seedParticipation();

    const created = await registrationsRepo.createRegistration(
      db,
      {
        participationId: participation.id,
        documentType: 'CC',
        documentNumber: '10203040',
        fullName: 'Ana Perez',
        companions: [
          { fullName: 'Luis Perez', documentType: 'TI', documentNumber: '99001' },
          { fullName: 'Sofia Perez' },
        ],
      },
      NOW,
    );

    expect(created.registration.companionsCount).toBe(2);
    expect(created.companions).toHaveLength(2);

    const companions = await registrationsRepo.listCompanions(db, created.registration.id);

    expect(companions.map((row) => row.fullName)).toEqual(['Luis Perez', 'Sofia Perez']);
    expect(companions[1]?.documentNumber).toBeNull();
    expect(await countRows('registration_companions')).toBe(2);
  });

  it('es atomico: si un acompanante repite documento no queda ni el titular', async () => {
    const participation = await seedParticipation();

    const error = await expectAppError(() =>
      registrationsRepo.createRegistration(
        db,
        {
          participationId: participation.id,
          documentType: 'CC',
          documentNumber: '10203040',
          fullName: 'Ana Perez',
          companions: [
            { fullName: 'Luis Perez', documentType: 'TI', documentNumber: '5555' },
            { fullName: 'Otro Luis', documentType: 'TI', documentNumber: '5555' },
          ],
        },
        NOW,
      ),
    );

    expect(error.code).toBe(ErrorCode.VALIDATION_ERROR);

    // D1 ejecuta el grupo como una transaccion: no sobrevive la primera escritura.
    expect(await countRows('registrations')).toBe(0);
    expect(await countRows('registration_companions')).toBe(0);
  });

  it('rechaza el mismo documento en la misma sede', async () => {
    const participation = await seedParticipation();
    await registerTitular(participation.id, '10203040');

    const error = await expectAppError(() => registerTitular(participation.id, '10203040'));

    expect(error.code).toBe(ErrorCode.DUPLICATE_REGISTRATION);
    expect(error.status).toBe(409);
    expect(await countRows('registrations')).toBe(1);
  });

  it('permite volver a registrarse tras cancelar el registro anterior', async () => {
    const participation = await seedParticipation({ titularCapacity: 1 });
    const first = await registerTitular(participation.id, '10203040');
    await participations.reserveTitularCapacity(db, participation.id, NOW);

    const cancelled = await registrationsRepo.cancelRegistration(
      db,
      first.id,
      'solicitud del titular',
      NOW,
    );

    expect(cancelled?.status).toBe('cancelled');

    // El indice unico es parcial: cancelar libera el documento.
    const again = await registerTitular(participation.id, '10203040');
    expect(again.id).not.toBe(first.id);
    expect(await countRows('registrations')).toBe(2);
  });
});

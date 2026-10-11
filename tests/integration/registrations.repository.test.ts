import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { isAppError, type AppError } from '../../src/core/errors/app-error';
import { ErrorCode } from '../../src/core/errors/error-codes';
import { createDb } from '../../src/db/client';
import { registrationDocuments } from '../../src/db/schema';
import * as establishments from '../../src/modules/establishments/establishments.repository';
import * as events from '../../src/modules/events/events.repository';
import * as participations from '../../src/modules/participations/participations.repository';
import * as registrationsRepo from '../../src/modules/registrations/registrations.repository';
import { countRows, truncateAll } from '../helpers/database';

/**
 * Repositorio de registros de participacion contra D1 real.
 *
 * Los casos clave son los que no se pueden resolver con una lectura previa: el
 * documento duplicado en el evento (los dos roles y las dos sedes), la atomicidad
 * del alta con acompanantes y la cancelacion con sus compensaciones.
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
  options: {
    titularCapacity?: number;
    companionCapacity?: number;
    /** Slug del evento: dos eventos distintos en el mismo caso necesitan slugs distintos. */
    slug?: string;
    /** Codigo de la sede, por la misma razon. */
    code?: string;
  } = {},
): Promise<participations.ParticipationRow> {
  const event = await events.insertEvent(
    db,
    { slug: options.slug ?? 'evento-1', name: 'Evento 1', status: 'published' },
    NOW,
  );
  const establishment = await establishments.insertEstablishment(
    db,
    { code: options.code ?? 'norte', name: 'Sede Norte' },
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

/**
 * Otra sede del **mismo** evento.
 *
 * Es la pieza que distingue la regla vieja (un documento por sede) de la vigente
 * (un documento por evento): los casos de unicidad se prueban aqui.
 */
async function seedSiblingParticipation(
  eventId: string,
  code = 'sur',
): Promise<participations.ParticipationRow> {
  const establishment = await establishments.insertEstablishment(
    db,
    { code, name: `Sede ${code}` },
    NOW,
  );

  return participations.insertParticipation(
    db,
    { eventId, establishmentId: establishment.id, titularCapacity: 5, companionCapacity: 5 },
    NOW,
  );
}

/** Alta simple de titular, como la haria el repositorio desde el servicio. */
async function registerTitular(
  participation: participations.ParticipationRow,
  documentNumber: string,
  now: Date = NOW,
): Promise<registrationsRepo.RegistrationRow> {
  const created = await registrationsRepo.createRegistration(
    db,
    {
      eventId: participation.eventId,
      participationId: participation.id,
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
        eventId: participation.eventId,
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
    expect(created.registration.requiresElectronicInvoice).toBe(false);
  });

  it('guarda si el titular requiere facturacion electronica', async () => {
    const participation = await seedParticipation();

    const created = await registrationsRepo.createRegistration(
      db,
      {
        eventId: participation.eventId,
        participationId: participation.id,
        documentType: 'CC',
        documentNumber: '10203041',
        fullName: 'Ana Perez',
        requiresElectronicInvoice: true,
      },
      NOW,
    );

    expect(created.registration.requiresElectronicInvoice).toBe(true);
  });

  it('reserva los documentos del titular y de los acompanantes con documento', async () => {
    const participation = await seedParticipation();

    await registrationsRepo.createRegistration(
      db,
      {
        eventId: participation.eventId,
        participationId: participation.id,
        documentType: 'CC',
        documentNumber: '10203040',
        fullName: 'Ana Perez',
        companions: [
          { fullName: 'Luis Perez', documentType: 'TI', documentNumber: '99.001' },
          { fullName: 'Sofia Perez' },
        ],
      },
      NOW,
    );

    // El acompanante sin documento no ocupa lugar: no se puede validar lo que no
    // se recibe, asi que no entra en el registro centralizado.
    const rows = await db.select().from(registrationDocuments);
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => [row.role, row.documentNumber]).sort()).toEqual([
      ['companion', '99001'],
      ['holder', '10203040'],
    ]);
    expect(rows.every((row) => row.eventId === participation.eventId)).toBe(true);
    expect(rows.every((row) => row.status === 'active')).toBe(true);
  });

  it('es atomico: si un acompanante repite documento no queda ni el titular', async () => {
    const participation = await seedParticipation();

    const error = await expectAppError(() =>
      registrationsRepo.createRegistration(
        db,
        {
          eventId: participation.eventId,
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
    expect(await countRows('registration_documents')).toBe(0);
  });

  it('rechaza el mismo documento como titular en la misma sede', async () => {
    const participation = await seedParticipation();
    await registerTitular(participation, '10203040');

    const error = await expectAppError(() => registerTitular(participation, '10.203.040'));

    // El documento se normaliza antes de escribir, asi que el indice los ve iguales.
    expect(error.code).toBe(ErrorCode.DUPLICATE_DOCUMENT);
    expect(error.status).toBe(409);
    expect(await countRows('registrations')).toBe(1);
    expect(await countRows('registration_documents')).toBe(1);
  });

  it('rechaza el documento repetido en otra sede del mismo evento', async () => {
    const north = await seedParticipation();
    const south = await seedSiblingParticipation(north.eventId);
    await registerTitular(north, '10203040');

    // La regla es por evento: el cupo es por sede, pero la persona es una sola.
    const error = await expectAppError(() => registerTitular(south, '10203040'));

    expect(error.code).toBe(ErrorCode.DUPLICATE_DOCUMENT);
    expect(await countRows('registrations')).toBe(1);
  });

  it('rechaza como titular un documento que ya uso un acompanante del evento', async () => {
    const north = await seedParticipation();
    const south = await seedSiblingParticipation(north.eventId);

    await registrationsRepo.createRegistration(
      db,
      {
        eventId: north.eventId,
        participationId: north.id,
        documentType: 'CC',
        documentNumber: '10203040',
        fullName: 'Ana Perez',
        companions: [{ fullName: 'Luis Perez', documentType: 'TI', documentNumber: '99001' }],
      },
      NOW,
    );

    const error = await expectAppError(() =>
      registrationsRepo.createRegistration(
        db,
        {
          eventId: south.eventId,
          participationId: south.id,
          documentType: 'TI',
          documentNumber: '99001',
          fullName: 'Luis Perez',
        },
        NOW,
      ),
    );

    expect(error.code).toBe(ErrorCode.DUPLICATE_DOCUMENT);
    expect(await countRows('registrations')).toBe(1);
  });

  it('admite el mismo documento en eventos distintos', async () => {
    const firstEvent = await seedParticipation();
    const otherEvent = await seedParticipation({ slug: 'evento-2', code: 'centro' });

    await registerTitular(firstEvent, '10203040');
    const second = await registerTitular(otherEvent, '10203040');

    // El alcance es el evento: inscribirse dos veces en ferias distintas es valido.
    expect(second.id).not.toBeUndefined();
    expect(await countRows('registration_documents')).toBe(2);
  });

  it('libera los documentos al cancelar, tambien en otra sede del evento', async () => {
    const north = await seedParticipation({ titularCapacity: 1 });
    const south = await seedSiblingParticipation(north.eventId);
    const first = await registerTitular(north, '10203040');
    await participations.reserveTitularCapacity(db, north.id, NOW);

    const cancelled = await registrationsRepo.cancelRegistration(
      db,
      first.id,
      'solicitud del titular',
      NOW,
    );

    expect(cancelled?.status).toBe('cancelled');
    expect((await db.select().from(registrationDocuments))[0]?.status).toBe('released');

    // El indice es parcial: cancelar libera el documento para el evento completo.
    const again = await registerTitular(south, '10203040');
    expect(again.id).not.toBe(first.id);
    expect(await countRows('registrations')).toBe(2);
    expect(await countRows('registration_documents')).toBe(2);
  });
});

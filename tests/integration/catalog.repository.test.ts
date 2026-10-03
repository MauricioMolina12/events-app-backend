import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { isAppError, type AppError } from '../../src/core/errors/app-error';
import { ErrorCode } from '../../src/core/errors/error-codes';
import { createDb } from '../../src/db/client';
import * as establishments from '../../src/modules/establishments/establishments.repository';
import * as events from '../../src/modules/events/events.repository';
import * as participations from '../../src/modules/participations/participations.repository';
import { truncateAll } from '../helpers/database';

/**
 * Repositorios de catalogo (eventos, sedes y participaciones) contra D1 real,
 * dentro de workerd.
 *
 * Todo lo que se escribe aqui pasa por las mismas restricciones que en
 * produccion: los duplicados se provocan a proposito para comprobar que la
 * traduccion de errores funciona con los mensajes reales del driver.
 */

const db = createDb(env);

beforeEach(truncateAll);

/** Ejecuta una operacion que debe fallar y devuelve el `AppError` traducido. */
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

/**
 * Evento + sede + participacion con cupos holgados, listos para operar.
 *
 * Se crea por repositorio y no con SQL crudo para que el escenario de cada caso
 * nazca del mismo camino que usa la aplicacion.
 */
async function seedParticipation(
  options: { titularCapacity?: number; companionCapacity?: number } = {},
): Promise<{
  event: events.EventRow;
  establishment: establishments.EstablishmentRow;
  participation: participations.ParticipationRow;
}> {
  const now = new Date(1_760_000_000_000);
  const event = await events.insertEvent(
    db,
    { slug: 'evento-1', name: 'Evento 1', status: 'published' },
    now,
  );
  const establishment = await establishments.insertEstablishment(
    db,
    { code: 'norte', name: 'Sede Norte' },
    now,
  );
  const participation = await participations.insertParticipation(
    db,
    {
      eventId: event.id,
      establishmentId: establishment.id,
      titularCapacity: options.titularCapacity ?? 5,
      companionCapacity: options.companionCapacity ?? 5,
    },
    now,
  );

  return { event, establishment, participation };
}

describe('events.repository', () => {
  it('inserta un evento y lo recupera por id y por slug', async () => {
    const created = await events.insertEvent(db, {
      slug: 'feria-2026',
      name: 'Feria 2026',
      status: 'published',
    });

    expect(created.timezone).toBe('America/Bogota');
    expect(created.startsAt).toBeNull();
    expect(created.createdAt).toBeInstanceOf(Date);

    const byId = await events.findEventById(db, created.id);
    const bySlug = await events.findEventBySlug(db, 'feria-2026');

    expect(byId?.id).toBe(created.id);
    expect(bySlug?.id).toBe(created.id);
  });

  it('devuelve null cuando el evento no existe', async () => {
    expect(await events.findEventById(db, 'no-existe')).toBeNull();
    expect(await events.findEventBySlug(db, 'no-existe')).toBeNull();
  });

  it('lista eventos filtrando por estado', async () => {
    await events.insertEvent(db, { slug: 'publicado', name: 'Publicado', status: 'published' });
    await events.insertEvent(db, { slug: 'borrador', name: 'Borrador', status: 'draft' });

    const published = await events.listEvents(db, { status: 'published' });

    expect(published).toHaveLength(1);
    expect(published[0]?.slug).toBe('publicado');
    expect(await events.listEvents(db)).toHaveLength(2);
  });

  it('traduce el slug duplicado a un conflicto', async () => {
    await events.insertEvent(db, { slug: 'repetido', name: 'Primero' });

    const error = await expectAppError(() =>
      events.insertEvent(db, { slug: 'repetido', name: 'Segundo' }),
    );

    expect(error.status).toBe(409);
    expect(error.code).toBe(ErrorCode.EVENT_SLUG_ALREADY_USED);
  });

  it('actualiza solo los campos indicados', async () => {
    const created = await events.insertEvent(
      db,
      { slug: 'editado', name: 'Antes' },
      new Date(1_760_000_000_000),
    );

    const updated = await events.updateEvent(
      db,
      created.id,
      { name: 'Despues' },
      new Date(1_760_000_500_000),
    );

    expect(updated?.name).toBe('Despues');
    expect(updated?.slug).toBe('editado');
    expect(updated?.updatedAt.getTime()).toBe(1_760_000_500_000);
    expect(await events.updateEvent(db, 'no-existe', { name: 'X' })).toBeNull();
  });
});

describe('establishments.repository', () => {
  it('crea una sede y la encuentra por codigo', async () => {
    const created = await establishments.insertEstablishment(db, {
      code: 'sur',
      name: 'Sede Sur',
      city: 'Bogota',
      address: 'Carrera 50 # 22-10',
    });

    expect(created.status).toBe('active');

    const found = await establishments.findEstablishmentByCode(db, 'sur');
    expect(found?.id).toBe(created.id);
    expect(found?.city).toBe('Bogota');
  });

  it('rechaza un codigo de sede duplicado', async () => {
    await establishments.insertEstablishment(db, { code: 'sur', name: 'Sede Sur' });

    const error = await expectAppError(() =>
      establishments.insertEstablishment(db, { code: 'sur', name: 'Otra sede' }),
    );

    expect(error.status).toBe(409);
    expect(error.code).toBe(ErrorCode.ESTABLISHMENT_CODE_ALREADY_USED);
  });

  it('lista sedes activas ordenadas por nombre', async () => {
    await establishments.insertEstablishment(db, { code: 'z', name: 'Zeta' });
    await establishments.insertEstablishment(db, { code: 'a', name: 'Alfa' });
    await establishments.insertEstablishment(db, {
      code: 'i',
      name: 'Inactiva',
      status: 'inactive',
    });

    const active = await establishments.listEstablishments(db, { status: 'active' });

    expect(active.map((row) => row.code)).toEqual(['a', 'z']);
    expect(await establishments.listEstablishments(db)).toHaveLength(3);
  });

  it('actualiza solo los campos indicados', async () => {
    const created = await establishments.insertEstablishment(db, {
      code: 'norte',
      name: 'Sede Norte',
    });

    const updated = await establishments.updateEstablishment(db, created.id, {
      name: 'Sede Norte Renovada',
      status: 'inactive',
    });

    expect(updated?.name).toBe('Sede Norte Renovada');
    expect(updated?.code).toBe('norte');
    expect(updated?.status).toBe('inactive');
    expect(await establishments.updateEstablishment(db, 'no-existe', { name: 'X' })).toBeNull();
  });
});

describe('participations.repository', () => {
  it('crea la participacion con sus cupos y los contadores en cero', async () => {
    const { participation } = await seedParticipation({ titularCapacity: 3, companionCapacity: 5 });

    expect(participation.titularCapacity).toBe(3);
    expect(participation.companionCapacity).toBe(5);
    expect(participation.confirmedTitulares).toBe(0);
    expect(participation.confirmedCompanions).toBe(0);
    expect(participation.status).toBe('open');
  });

  it('traduce la participacion duplicada a PARTICIPATION_ALREADY_EXISTS', async () => {
    const { event, establishment } = await seedParticipation();

    const error = await expectAppError(() =>
      participations.insertParticipation(db, {
        eventId: event.id,
        establishmentId: establishment.id,
        titularCapacity: 1,
        companionCapacity: 0,
      }),
    );

    expect(error.code).toBe(ErrorCode.PARTICIPATION_ALREADY_EXISTS);
    expect(error.status).toBe(409);
  });

  it('encuentra la participacion por evento y sede', async () => {
    const { event, establishment, participation } = await seedParticipation();

    const found = await participations.findParticipationByEventAndEstablishment(
      db,
      event.id,
      establishment.id,
    );

    expect(found?.id).toBe(participation.id);
    expect(await participations.findParticipationById(db, 'no-existe')).toBeNull();
  });

  it('lista las participaciones de un evento', async () => {
    const { event } = await seedParticipation();
    const otraSede = await establishments.insertEstablishment(db, { code: 'sur', name: 'Sede Sur' });
    await participations.insertParticipation(db, {
      eventId: event.id,
      establishmentId: otraSede.id,
      titularCapacity: 1,
      companionCapacity: 0,
    });

    const rows = await participations.listParticipationsByEvent(db, event.id);

    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.eventId === event.id)).toBe(true);
  });

  it('ensureParticipation es idempotente y no sobreescribe los cupos existentes', async () => {
    const { event, establishment, participation } = await seedParticipation({ titularCapacity: 2 });

    const again = await participations.ensureParticipation(db, {
      eventId: event.id,
      establishmentId: establishment.id,
      titularCapacity: 99,
      companionCapacity: 99,
    });

    expect(again.id).toBe(participation.id);
    expect(again.titularCapacity).toBe(2);
    expect(await participations.listParticipationsByEvent(db, event.id)).toHaveLength(1);
  });

  it('reserva cupo de titular mientras haya disponibilidad', async () => {
    const { participation } = await seedParticipation({ titularCapacity: 2 });

    expect(await participations.reserveTitularCapacity(db, participation.id)).toBe(true);
    expect(await participations.reserveTitularCapacity(db, participation.id)).toBe(true);
    expect(await participations.reserveTitularCapacity(db, participation.id)).toBe(false);

    const current = await participations.findParticipationById(db, participation.id);
    expect(current?.confirmedTitulares).toBe(2);
  });

  it('no reserva cupo cuando la sede esta cerrada', async () => {
    const { participation } = await seedParticipation({ titularCapacity: 5 });
    await env.DB.prepare("UPDATE event_establishments SET status = 'closed' WHERE id = ?")
      .bind(participation.id)
      .run();

    expect(await participations.reserveTitularCapacity(db, participation.id)).toBe(false);
    expect(await participations.reserveCompanionCapacity(db, participation.id, 1)).toBe(false);
  });

  it('libera cupo sin bajar de cero', async () => {
    const { participation } = await seedParticipation({ titularCapacity: 1 });

    expect(await participations.releaseTitularCapacity(db, participation.id)).toBe(false);

    await participations.reserveTitularCapacity(db, participation.id);
    expect(await participations.releaseTitularCapacity(db, participation.id)).toBe(true);

    const current = await participations.findParticipationById(db, participation.id);
    expect(current?.confirmedTitulares).toBe(0);
    expect(await participations.releaseTitularCapacity(db, participation.id)).toBe(false);
  });

  it('reserva acompanantes de forma todo o nada', async () => {
    const { participation } = await seedParticipation({ companionCapacity: 3 });

    expect(await participations.reserveCompanionCapacity(db, participation.id, 2)).toBe(true);
    // 2 + 2 = 4 > 3: no entra ninguno de los dos acompanantes.
    expect(await participations.reserveCompanionCapacity(db, participation.id, 2)).toBe(false);

    const current = await participations.findParticipationById(db, participation.id);
    expect(current?.confirmedCompanions).toBe(2);

    expect(await participations.releaseCompanionCapacity(db, participation.id, 2)).toBe(true);
    expect(await participations.releaseCompanionCapacity(db, participation.id, 1)).toBe(false);
  });

  it('rechaza reservar un numero de cupos que no es entero positivo', async () => {
    const { participation } = await seedParticipation();

    await expect(
      participations.reserveCompanionCapacity(db, participation.id, 0),
    ).rejects.toThrow(/entero positivo/);
  });

  it('rechaza reducir el cupo por debajo de lo confirmado', async () => {
    const { participation } = await seedParticipation({ titularCapacity: 2 });
    await participations.reserveTitularCapacity(db, participation.id);
    await participations.reserveTitularCapacity(db, participation.id);

    const error = await expectAppError(() =>
      participations.updateCapacity(db, participation.id, {
        titularCapacity: 1,
        companionCapacity: 0,
      }),
    );

    expect(error.code).toBe(ErrorCode.TITULAR_CAPACITY_EXCEEDED);
    expect(error.status).toBe(409);
  });

  it('aplica un cupo nuevo valido', async () => {
    const { participation } = await seedParticipation();

    const updated = await participations.updateCapacity(db, participation.id, {
      titularCapacity: 10,
      companionCapacity: 20,
    });

    expect(updated?.titularCapacity).toBe(10);
    expect(updated?.companionCapacity).toBe(20);
    expect(
      await participations.updateCapacity(db, 'no-existe', {
        titularCapacity: 1,
        companionCapacity: 1,
      }),
    ).toBeNull();
  });
});

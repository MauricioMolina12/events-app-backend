import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { createDb } from '../../src/db/client';
import * as establishments from '../../src/modules/establishments/establishments.repository';
import * as events from '../../src/modules/events/events.repository';
import * as participations from '../../src/modules/participations/participations.repository';
import { api, errorCodeOf, seedAdmin, seedOperator } from '../helpers/api';
import { truncateAll } from '../helpers/database';

/**
 * Catalogo de participaciones contra la aplicacion completa y D1 real.
 *
 * El evento y la sede se siembran por repositorio (ya estan cubiertos por sus
 * propias pruebas) para concentrar cada caso en las reglas de este catalogo: la
 * composicion con la sede, el cupo disponible y las protecciones sobre los
 * registros confirmados. El cupo confirmado se simula reservando por repositorio,
 * porque el alta de registros llega en la Fase 5.
 */

const db = createDb(env);

interface ParticipationBody {
  id: string;
  eventId: string;
  establishmentId: string;
  status: string;
  titularCapacity: number;
  companionCapacity: number;
  confirmedTitulares: number;
  confirmedCompanions: number;
  availableTitulares: number;
  availableCompanions: number;
  registrationOpensAt: string | null;
  registrationClosesAt: string | null;
  checkInOpensAt: string | null;
  checkInClosesAt: string | null;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
  establishment: {
    id: string;
    code: string;
    name: string;
    city: string | null;
    status: string;
  };
}

interface ParticipationResponse {
  success: true;
  data: ParticipationBody;
}

interface ParticipationListResponse {
  success: true;
  data: ParticipationBody[];
  meta: { total: number; limit: number; offset: number };
}

beforeEach(truncateAll);

/** Evento y sede listos para armar participaciones. */
async function seedCatalog(status: 'draft' | 'published' = 'published'): Promise<{
  event: events.EventRow;
  establishment: establishments.EstablishmentRow;
}> {
  const event = await events.insertEvent(db, {
    slug: 'evento-base',
    name: 'Evento base',
    status,
  });
  const establishment = await establishments.insertEstablishment(db, {
    code: 'sede-norte',
    name: 'Sede Norte',
    city: 'Bogota',
  });

  return { event, establishment };
}

/** Crea una participacion por la API y devuelve la ficha creada. */
async function createParticipation(
  cookie: string,
  body: Record<string, unknown>,
): Promise<ParticipationBody> {
  const response = await api('/participations', cookie, {
    method: 'POST',
    body: JSON.stringify(body),
  });
  expect(response.status).toBe(201);
  return (await response.json<ParticipationResponse>()).data;
}

describe('autorizacion del catalogo de participaciones', () => {
  it('exige una sesion activa', async () => {
    const response = await api('/participations', '');

    expect(response.status).toBe(401);
    await expect(errorCodeOf(response)).resolves.toBe('UNAUTHENTICATED');
  });

  it('deja leer al operador pero no escribir', async () => {
    const operator = await seedOperator();

    const list = await api('/participations', operator.cookie);
    expect(list.status).toBe(200);

    const create = await api('/participations', operator.cookie, {
      method: 'POST',
      body: JSON.stringify({
        eventId: 'x',
        establishmentId: 'y',
        titularCapacity: 1,
        companionCapacity: 0,
      }),
    });
    expect(create.status).toBe(403);
    await expect(errorCodeOf(create)).resolves.toBe('FORBIDDEN');
  });
});

describe('POST /participations', () => {
  it('crea la participacion con la sede resuelta y el cupo disponible', async () => {
    const admin = await seedAdmin();
    const { event, establishment } = await seedCatalog();

    const participation = await createParticipation(admin.cookie, {
      eventId: event.id,
      establishmentId: establishment.id,
      titularCapacity: 10,
      companionCapacity: 5,
      notes: 'Sede principal',
    });

    expect(participation.status).toBe('open');
    expect(participation.confirmedTitulares).toBe(0);
    expect(participation.availableTitulares).toBe(10);
    expect(participation.availableCompanions).toBe(5);
    expect(participation.establishment).toEqual({
      id: establishment.id,
      code: 'sede-norte',
      name: 'Sede Norte',
      city: 'Bogota',
      status: 'active',
    });
  });

  it('responde EVENT_NOT_FOUND o ESTABLISHMENT_NOT_FOUND si falta algun extremo', async () => {
    const admin = await seedAdmin();
    const { event, establishment } = await seedCatalog();

    const sinEvento = await api('/participations', admin.cookie, {
      method: 'POST',
      body: JSON.stringify({
        eventId: '00000000-0000-4000-8000-000000000000',
        establishmentId: establishment.id,
        titularCapacity: 1,
        companionCapacity: 0,
      }),
    });
    expect(sinEvento.status).toBe(404);
    await expect(errorCodeOf(sinEvento)).resolves.toBe('EVENT_NOT_FOUND');

    const sinSede = await api('/participations', admin.cookie, {
      method: 'POST',
      body: JSON.stringify({
        eventId: event.id,
        establishmentId: '00000000-0000-4000-8000-000000000000',
        titularCapacity: 1,
        companionCapacity: 0,
      }),
    });
    expect(sinSede.status).toBe(404);
    await expect(errorCodeOf(sinSede)).resolves.toBe('ESTABLISHMENT_NOT_FOUND');
  });

  it('responde PARTICIPATION_ALREADY_EXISTS si la sede ya participa', async () => {
    const admin = await seedAdmin();
    const { event, establishment } = await seedCatalog();
    await createParticipation(admin.cookie, {
      eventId: event.id,
      establishmentId: establishment.id,
      titularCapacity: 1,
      companionCapacity: 0,
    });

    const response = await api('/participations', admin.cookie, {
      method: 'POST',
      body: JSON.stringify({
        eventId: event.id,
        establishmentId: establishment.id,
        titularCapacity: 2,
        companionCapacity: 0,
      }),
    });

    expect(response.status).toBe(409);
    await expect(errorCodeOf(response)).resolves.toBe('PARTICIPATION_ALREADY_EXISTS');
  });

  it('rechaza una sede inactiva', async () => {
    const admin = await seedAdmin();
    const { event } = await seedCatalog();
    const inactive = await establishments.insertEstablishment(db, {
      code: 'sede-vieja',
      name: 'Sede Vieja',
      status: 'inactive',
    });

    const response = await api('/participations', admin.cookie, {
      method: 'POST',
      body: JSON.stringify({
        eventId: event.id,
        establishmentId: inactive.id,
        titularCapacity: 1,
        companionCapacity: 0,
      }),
    });

    expect(response.status).toBe(422);
    await expect(errorCodeOf(response)).resolves.toBe('VALIDATION_ERROR');
  });

  it('rechaza sumar sedes a un evento cerrado', async () => {
    const admin = await seedAdmin();
    const { event, establishment } = await seedCatalog('draft');
    await events.updateEvent(db, event.id, { status: 'closed' });

    const response = await api('/participations', admin.cookie, {
      method: 'POST',
      body: JSON.stringify({
        eventId: event.id,
        establishmentId: establishment.id,
        titularCapacity: 1,
        companionCapacity: 0,
      }),
    });

    expect(response.status).toBe(409);
    await expect(errorCodeOf(response)).resolves.toBe('EVENT_NOT_REGISTRABLE');
  });

  it('rechaza un cierre de registro anterior a su apertura', async () => {
    const admin = await seedAdmin();
    const { event, establishment } = await seedCatalog();

    const response = await api('/participations', admin.cookie, {
      method: 'POST',
      body: JSON.stringify({
        eventId: event.id,
        establishmentId: establishment.id,
        titularCapacity: 1,
        companionCapacity: 0,
        registrationOpensAt: '2026-05-10T12:00:00.000Z',
        registrationClosesAt: '2026-05-01T12:00:00.000Z',
      }),
    });

    expect(response.status).toBe(422);
    await expect(errorCodeOf(response)).resolves.toBe('VALIDATION_ERROR');
  });
});

describe('GET /participations', () => {
  it('lista por evento con la sede resuelta y su cupo disponible', async () => {
    const admin = await seedAdmin();
    const { event, establishment } = await seedCatalog();
    const otraSede = await establishments.insertEstablishment(db, {
      code: 'sede-sur',
      name: 'Sede Sur',
    });
    await createParticipation(admin.cookie, {
      eventId: event.id,
      establishmentId: establishment.id,
      titularCapacity: 4,
      companionCapacity: 2,
    });
    await createParticipation(admin.cookie, {
      eventId: event.id,
      establishmentId: otraSede.id,
      titularCapacity: 7,
      companionCapacity: 0,
    });

    const response = await api(`/participations?eventId=${event.id}`, admin.cookie);

    expect(response.status).toBe(200);
    const body = await response.json<ParticipationListResponse>();
    expect(body.meta).toEqual({ total: 2, limit: 20, offset: 0 });
    expect(body.data.map((item) => item.establishment.code)).toEqual(['sede-norte', 'sede-sur']);
    expect(body.data[0]?.availableTitulares).toBe(4);
  });

  it('filtra por estado y pagina el resultado', async () => {
    const admin = await seedAdmin();
    const { event, establishment } = await seedCatalog();
    const otraSede = await establishments.insertEstablishment(db, {
      code: 'sede-sur',
      name: 'Sede Sur',
    });
    const cerrada = await createParticipation(admin.cookie, {
      eventId: event.id,
      establishmentId: establishment.id,
      titularCapacity: 4,
      companionCapacity: 2,
    });
    await createParticipation(admin.cookie, {
      eventId: event.id,
      establishmentId: otraSede.id,
      titularCapacity: 7,
      companionCapacity: 0,
    });

    const close = await api(`/participations/${cerrada.id}`, admin.cookie, {
      method: 'PATCH',
      body: JSON.stringify({ status: 'closed' }),
    });
    expect(close.status).toBe(200);

    const closed = await api('/participations?status=closed', admin.cookie);
    const closedBody = await closed.json<ParticipationListResponse>();
    expect(closedBody.meta.total).toBe(1);
    expect(closedBody.data[0]?.id).toBe(cerrada.id);

    const page = await api('/participations?limit=1&offset=1', admin.cookie);
    const pageBody = await page.json<ParticipationListResponse>();
    expect(pageBody.data).toHaveLength(1);
    expect(pageBody.meta).toEqual({ total: 2, limit: 1, offset: 1 });
  });
});

describe('GET /participations/{id}', () => {
  it('devuelve la participacion y responde PARTICIPATION_NOT_FOUND si no existe', async () => {
    const admin = await seedAdmin();
    const { event, establishment } = await seedCatalog();
    const participation = await createParticipation(admin.cookie, {
      eventId: event.id,
      establishmentId: establishment.id,
      titularCapacity: 4,
      companionCapacity: 2,
    });

    const found = await api(`/participations/${participation.id}`, admin.cookie);
    expect(found.status).toBe(200);
    const foundBody = await found.json<ParticipationResponse>();
    expect(foundBody.data.establishment.code).toBe('sede-norte');

    const missing = await api('/participations/no-existe', admin.cookie);
    expect(missing.status).toBe(404);
    await expect(errorCodeOf(missing)).resolves.toBe('PARTICIPATION_NOT_FOUND');
  });
});

describe('PATCH /participations/{id}', () => {
  it('edita el cupo mientras no haya registros confirmados', async () => {
    const admin = await seedAdmin();
    const { event, establishment } = await seedCatalog();
    const participation = await createParticipation(admin.cookie, {
      eventId: event.id,
      establishmentId: establishment.id,
      titularCapacity: 4,
      companionCapacity: 2,
    });

    const response = await api(`/participations/${participation.id}`, admin.cookie, {
      method: 'PATCH',
      body: JSON.stringify({ titularCapacity: 8, notes: 'Cupo ampliado' }),
    });

    expect(response.status).toBe(200);
    const body = await response.json<ParticipationResponse>();
    expect(body.data.titularCapacity).toBe(8);
    expect(body.data.availableTitulares).toBe(8);
    expect(body.data.notes).toBe('Cupo ampliado');
  });

  it('exige el flujo de aprobacion si hay registros confirmados', async () => {
    const admin = await seedAdmin();
    const { event, establishment } = await seedCatalog();
    const participation = await createParticipation(admin.cookie, {
      eventId: event.id,
      establishmentId: establishment.id,
      titularCapacity: 4,
      companionCapacity: 0,
    });
    // El alta de registros llega en la Fase 5; aqui se reserva por repositorio.
    await participations.reserveTitularCapacity(db, participation.id);

    const response = await api(`/participations/${participation.id}`, admin.cookie, {
      method: 'PATCH',
      body: JSON.stringify({ titularCapacity: 10 }),
    });

    expect(response.status).toBe(409);
    const body = await response.json<{
      error: { code: string; details: { confirmedTitulares: number } };
    }>();
    expect(body.error.code).toBe('CAPACITY_ADJUSTMENT_REQUIRED');
    expect(body.error.details.confirmedTitulares).toBe(1);
  });

  it('cierra y reabre el registro de la sede', async () => {
    const admin = await seedAdmin();
    const { event, establishment } = await seedCatalog();
    const participation = await createParticipation(admin.cookie, {
      eventId: event.id,
      establishmentId: establishment.id,
      titularCapacity: 4,
      companionCapacity: 2,
    });

    const close = await api(`/participations/${participation.id}`, admin.cookie, {
      method: 'PATCH',
      body: JSON.stringify({ status: 'closed' }),
    });
    expect(close.status).toBe(200);
    expect((await close.json<ParticipationResponse>()).data.status).toBe('closed');

    const reopen = await api(`/participations/${participation.id}`, admin.cookie, {
      method: 'PATCH',
      body: JSON.stringify({ status: 'open' }),
    });
    expect(reopen.status).toBe(200);
    expect((await reopen.json<ParticipationResponse>()).data.status).toBe('open');
  });

  it('cancela una sede sin registros y no la reabre', async () => {
    const admin = await seedAdmin();
    const { event, establishment } = await seedCatalog();
    const participation = await createParticipation(admin.cookie, {
      eventId: event.id,
      establishmentId: establishment.id,
      titularCapacity: 4,
      companionCapacity: 2,
    });

    const cancel = await api(`/participations/${participation.id}`, admin.cookie, {
      method: 'PATCH',
      body: JSON.stringify({ status: 'cancelled' }),
    });
    expect(cancel.status).toBe(200);
    expect((await cancel.json<ParticipationResponse>()).data.status).toBe('cancelled');

    const reopen = await api(`/participations/${participation.id}`, admin.cookie, {
      method: 'PATCH',
      body: JSON.stringify({ status: 'open' }),
    });
    expect(reopen.status).toBe(409);
    await expect(errorCodeOf(reopen)).resolves.toBe('STATUS_TRANSITION_INVALID');
  });

  it('no cancela una sede con registros confirmados', async () => {
    const admin = await seedAdmin();
    const { event, establishment } = await seedCatalog();
    const participation = await createParticipation(admin.cookie, {
      eventId: event.id,
      establishmentId: establishment.id,
      titularCapacity: 4,
      companionCapacity: 2,
    });
    await participations.reserveCompanionCapacity(db, participation.id, 2);

    const response = await api(`/participations/${participation.id}`, admin.cookie, {
      method: 'PATCH',
      body: JSON.stringify({ status: 'cancelled' }),
    });

    expect(response.status).toBe(409);
    await expect(errorCodeOf(response)).resolves.toBe('PARTICIPATION_HAS_REGISTRATIONS');
  });

  it('no permite mover la participacion de evento o de sede', async () => {
    const admin = await seedAdmin();
    const { event, establishment } = await seedCatalog();
    const otraSede = await establishments.insertEstablishment(db, {
      code: 'sede-sur',
      name: 'Sede Sur',
    });
    const participation = await createParticipation(admin.cookie, {
      eventId: event.id,
      establishmentId: establishment.id,
      titularCapacity: 4,
      companionCapacity: 2,
    });

    const response = await api(`/participations/${participation.id}`, admin.cookie, {
      method: 'PATCH',
      body: JSON.stringify({ establishmentId: otraSede.id }),
    });

    expect(response.status).toBe(422);
    await expect(errorCodeOf(response)).resolves.toBe('VALIDATION_ERROR');
  });

  it('responde PARTICIPATION_NOT_FOUND si la participacion no existe', async () => {
    const admin = await seedAdmin();

    const response = await api(
      '/participations/00000000-0000-4000-8000-000000000000',
      admin.cookie,
      { method: 'PATCH', body: JSON.stringify({ notes: 'Fantasma' }) },
    );

    expect(response.status).toBe(404);
    await expect(errorCodeOf(response)).resolves.toBe('PARTICIPATION_NOT_FOUND');
  });
});

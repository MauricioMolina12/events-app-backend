import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { createDb } from '../../src/db/client';
import * as establishments from '../../src/modules/establishments/establishments.repository';
import * as events from '../../src/modules/events/events.repository';
import * as participations from '../../src/modules/participations/participations.repository';
import { api, errorCodeOf, seedAdmin, seedOperator } from '../helpers/api';
import { truncateAll } from '../helpers/database';

/**
 * Mesa de registro: las metricas y el listado se leen de lo que escribe el escaneo.
 *
 * Los casos fijan las definiciones: solo cuentan las confirmadas, un titular con
 * ingreso deja de estar pendiente, reescanear no suma, las sedes no se mezclan y el
 * consolidado es la suma exacta de las sedes.
 */

const db = createDb(env);
const NOW = new Date(1_760_000_000_000);
const UNKNOWN_ID = '00000000-0000-4000-8000-000000000000';

interface Metrics {
  titulares: number;
  companions: number;
  people: number;
  checkedIn: number;
  pending: number;
  attendanceRate: number;
  turnsIssued: number;
  lastCheckInAt: string | null;
}

interface Summary {
  totals: Metrics;
  participationId: string | null;
  sedes: (Metrics & { participationId: string; establishment: { name: string } })[];
}

interface BoardRow {
  id: string;
  fullName: string;
  documentNumber: string;
  people: number;
  sede: { id: string; name: string };
  checkIn: {
    status: 'checked_in' | 'pending';
    at: string | null;
    firstTurn: number | null;
    lastTurn: number | null;
    turnsCount: number;
    operator: { fullName: string } | null;
  };
}

interface BoardPage {
  data: BoardRow[];
  meta: { total: number; limit: number; offset: number };
}

beforeEach(truncateAll);

async function seedSede(eventId: string, code: string, name: string): Promise<string> {
  const establishment = await establishments.insertEstablishment(
    db,
    { code, name, city: 'Bogota' },
    NOW,
  );
  const participation = await participations.insertParticipation(
    db,
    { eventId, establishmentId: establishment.id, titularCapacity: 50, companionCapacity: 50 },
    NOW,
  );
  return participation.id;
}

async function seedEvent(slug = 'madrugon-2026'): Promise<{ eventId: string; barby: string; cupidos: string }> {
  const event = await events.insertEvent(db, { slug, name: 'Madrugon 2026', status: 'published' }, NOW);
  return {
    eventId: event.id,
    barby: await seedSede(event.id, `${slug}-barby`, 'Barby Toys'),
    cupidos: await seedSede(event.id, `${slug}-cupidos`, 'Cupidos'),
  };
}

let documentSeq = 50_000_000;

async function register(
  cookie: string,
  participationId: string,
  options: { companions?: readonly string[]; fullName?: string; documentNumber?: string } = {},
): Promise<string> {
  documentSeq += 1;
  const response = await api('/registrations', cookie, {
    method: 'POST',
    body: JSON.stringify({
      participationId,
      documentType: 'CC',
      documentNumber: options.documentNumber ?? String(documentSeq),
      fullName: options.fullName ?? `Titular ${documentSeq}`,
      companions: (options.companions ?? []).map((fullName) => ({ fullName })),
    }),
  });
  expect(response.status).toBe(201);
  return (await response.json<{ data: { id: string } }>()).data.id;
}

async function scan(cookie: string, code: string): Promise<void> {
  const response = await api('/check-in/scan', cookie, {
    method: 'POST',
    body: JSON.stringify({ code }),
  });
  expect(response.status).toBe(200);
}

async function summary(cookie: string, eventId: string, participationId?: string): Promise<Summary> {
  const query = new URLSearchParams({ eventId, ...(participationId ? { participationId } : {}) });
  const response = await api(`/check-in/summary?${query}`, cookie);
  expect(response.status).toBe(200);
  return (await response.json<{ data: Summary }>()).data;
}

async function board(cookie: string, params: Record<string, string>): Promise<BoardPage> {
  const response = await api(`/check-in/registrations?${new URLSearchParams(params)}`, cookie);
  expect(response.status).toBe(200);
  return response.json<BoardPage>();
}

describe('GET /check-in/summary', () => {
  it('cuenta confirmadas, personas e ingresos con las mismas definiciones del escaner', async () => {
    const { cookie } = await seedOperator();
    const { eventId, barby } = await seedEvent();
    const first = await register(cookie, barby, { companions: ['Luis Paz', 'Marta Gil'] });
    await register(cookie, barby, { companions: ['Eva Sol'] });
    const cancelled = await register(cookie, barby, { companions: ['Rosa Mar'] });
    await api(`/registrations/${cancelled}/cancel`, cookie, {
      method: 'POST',
      body: JSON.stringify({ reason: 'No asistira al evento.' }),
    });

    await scan(cookie, first);
    const { totals } = await summary(cookie, eventId);

    expect(totals).toMatchObject({
      titulares: 2,
      companions: 3,
      people: 5,
      checkedIn: 1,
      pending: 1,
      attendanceRate: 0.5,
      turnsIssued: 3,
    });
    expect(totals.lastCheckInAt).not.toBeNull();
  });

  it('un escaneo repetido no suma ingresos ni turnos', async () => {
    const { cookie } = await seedOperator();
    const { eventId, barby } = await seedEvent();
    const id = await register(cookie, barby, { companions: ['Luis Paz'] });

    await scan(cookie, id);
    const before = (await summary(cookie, eventId)).totals;
    await scan(cookie, id);
    await scan(cookie, id);
    const after = (await summary(cookie, eventId)).totals;

    expect(after.checkedIn).toBe(1);
    expect(after.turnsIssued).toBe(2);
    expect(after).toEqual(before);
  });

  it('separa las sedes y el consolidado es su suma exacta', async () => {
    const { cookie } = await seedOperator();
    const { eventId, barby, cupidos } = await seedEvent();
    const a = await register(cookie, barby, { companions: ['Luis Paz'] });
    await register(cookie, barby);
    const c = await register(cookie, cupidos, { companions: ['Eva Sol', 'Ana Ruiz'] });
    await scan(cookie, a);
    await scan(cookie, c);

    const all = await summary(cookie, eventId);
    const onlyBarby = await summary(cookie, eventId, barby);
    const byName = Object.fromEntries(all.sedes.map((sede) => [sede.establishment.name, sede]));

    expect(byName['Barby Toys']).toMatchObject({ titulares: 2, people: 3, checkedIn: 1, pending: 1 });
    expect(byName['Cupidos']).toMatchObject({ titulares: 1, people: 3, checkedIn: 1, pending: 0 });
    expect(all.totals).toMatchObject({ titulares: 3, people: 6, checkedIn: 2, pending: 1, turnsIssued: 5 });
    expect(onlyBarby.participationId).toBe(barby);
    expect(onlyBarby.totals).toMatchObject({ titulares: 2, people: 3, checkedIn: 1, turnsIssued: 2 });
    expect(onlyBarby.sedes).toHaveLength(2);
  });

  it('no mezcla eventos y rechaza una sede ajena', async () => {
    const { cookie } = await seedAdmin();
    const main = await seedEvent('madrugon-2026');
    const other = await seedEvent('otro-evento');
    await register(cookie, other.barby);

    expect((await summary(cookie, main.eventId)).totals.titulares).toBe(0);

    const foreign = await api(
      `/check-in/summary?eventId=${main.eventId}&participationId=${other.barby}`,
      cookie,
    );
    expect(foreign.status).toBe(404);
    expect(await errorCodeOf(foreign)).toBe('PARTICIPATION_NOT_FOUND');

    const unknown = await api(`/check-in/summary?eventId=${UNKNOWN_ID}`, cookie);
    expect(unknown.status).toBe(404);
    expect(await errorCodeOf(unknown)).toBe('EVENT_NOT_FOUND');
  });

  it('exige sesion de personal', async () => {
    const response = await api(`/check-in/summary?eventId=${UNKNOWN_ID}`, '');
    expect(response.status).toBe(401);
    const list = await api(`/check-in/registrations?eventId=${UNKNOWN_ID}`, '');
    expect(list.status).toBe(401);
  });
});

describe('GET /check-in/registrations', () => {
  it('un titular con ingreso no aparece como pendiente', async () => {
    const { cookie } = await seedOperator();
    const { eventId, barby } = await seedEvent();
    const inside = await register(cookie, barby, { companions: ['Luis Paz'] });
    const waiting = await register(cookie, barby);
    await scan(cookie, inside);

    const pending = await board(cookie, { eventId, checkIn: 'pending' });
    const checked = await board(cookie, { eventId, checkIn: 'checked_in' });

    expect(pending.data.map((row) => row.id)).toEqual([waiting]);
    expect(checked.data.map((row) => row.id)).toEqual([inside]);
    expect(checked.data[0]?.checkIn).toMatchObject({
      status: 'checked_in',
      firstTurn: 1,
      lastTurn: 2,
      turnsCount: 2,
      operator: { fullName: 'Operador Uno' },
    });
    expect(pending.data[0]?.checkIn).toMatchObject({ status: 'pending', at: null, firstTurn: null });
  });

  it('filtra por sede y busca por nombre, documento con puntos o folio', async () => {
    const { cookie } = await seedOperator();
    const { eventId, barby, cupidos } = await seedEvent();
    const ana = await register(cookie, barby, { fullName: 'Ana Perez', documentNumber: '1020304050' });
    await register(cookie, barby, { fullName: 'Bruno Diaz' });
    await register(cookie, cupidos, { fullName: 'Carla Ana Gil' });

    const bySede = await board(cookie, { eventId, participationId: cupidos });
    expect(bySede.data.map((row) => row.sede.name)).toEqual(['Cupidos']);

    const byName = await board(cookie, { eventId, search: 'ANA', sort: 'fullName', order: 'asc' });
    expect(byName.data.map((row) => row.fullName)).toEqual(['Ana Perez', 'Carla Ana Gil']);

    const byDocument = await board(cookie, { eventId, search: '1.020.304' });
    expect(byDocument.data.map((row) => row.id)).toEqual([ana]);

    const byFolio = await board(cookie, { eventId, search: ana.slice(0, 8).toUpperCase() });
    expect(byFolio.data.map((row) => row.id)).toEqual([ana]);
  });

  it('pagina con el total del filtro y sin repetir filas', async () => {
    const { cookie } = await seedOperator();
    const { eventId, barby } = await seedEvent();
    for (let index = 0; index < 5; index += 1) {
      await register(cookie, barby);
    }

    const first = await board(cookie, { eventId, limit: '2', offset: '0', sort: 'fullName', order: 'asc' });
    const second = await board(cookie, { eventId, limit: '2', offset: '2', sort: 'fullName', order: 'asc' });
    const third = await board(cookie, { eventId, limit: '2', offset: '4', sort: 'fullName', order: 'asc' });

    expect(first.meta).toEqual({ total: 5, limit: 2, offset: 0 });
    const ids = [...first.data, ...second.data, ...third.data].map((row) => row.id);
    expect(new Set(ids).size).toBe(5);
    expect(third.data).toHaveLength(1);
  });

  it('el historial ordena por hora de ingreso y deja los pendientes al final', async () => {
    const { cookie } = await seedOperator();
    const { eventId, barby, cupidos } = await seedEvent();
    const early = await register(cookie, barby);
    const late = await register(cookie, cupidos, { companions: ['Eva Sol'] });
    const never = await register(cookie, barby);
    await scan(cookie, early);
    await new Promise((resolve) => setTimeout(resolve, 5));
    await scan(cookie, late);

    const history = await board(cookie, { eventId, checkIn: 'checked_in', sort: 'checkedInAt', order: 'desc' });
    expect(history.data.map((row) => row.id)).toEqual([late, early]);
    expect(history.data[0]?.checkIn.firstTurn).toBe(1);

    const byTurn = await board(cookie, { eventId, sort: 'turn', order: 'asc' });
    expect(byTurn.data.at(-1)?.id).toBe(never);
  });

  it('el escaner sigue funcionando igual y su ingreso se ve en el listado', async () => {
    const { cookie } = await seedOperator();
    const { eventId, barby } = await seedEvent();
    const id = await register(cookie, barby);

    expect((await board(cookie, { eventId })).data[0]?.checkIn.status).toBe('pending');
    await scan(cookie, id);
    expect((await board(cookie, { eventId })).data[0]?.checkIn.status).toBe('checked_in');
  });
});

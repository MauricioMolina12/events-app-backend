import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { createDb } from '../../src/db/client';
import * as establishments from '../../src/modules/establishments/establishments.repository';
import * as events from '../../src/modules/events/events.repository';
import * as participations from '../../src/modules/participations/participations.repository';
import { api, errorCodeOf, seedOperator } from '../helpers/api';
import { truncateAll } from '../helpers/database';

/**
 * Tablero principal: la vista general, la evolucion y la actividad usan las mismas
 * definiciones que la mesa (`GET /check-in/summary`), asi que ambas pantallas no
 * pueden contradecirse.
 */

const db = createDb(env);
const NOW = new Date(1_760_000_000_000);
const UNKNOWN_ID = '00000000-0000-4000-8000-000000000000';

interface OverviewEvent {
  id: string;
  name: string;
  status: string;
  phase: string;
  sedes: { participationId: string; name: string }[];
  titulares: number;
  people: number;
  checkedIn: number;
  attendanceRate: number;
}

interface Overview {
  events: { total: number; active: number; byStatus: Record<string, number> };
  items: OverviewEvent[];
}

interface Timeline {
  granularity: string;
  total: number;
  last24h: number;
  buckets: { date: string; hour: number | null; titulares: number; people: number; cumulative: number }[];
}

type Activity =
  | { type: 'registration'; at: string; registration: Record<string, unknown> }
  | { type: 'check_in'; at: string; registration: Record<string, unknown>; operator: string | null }
  | { type: 'event_created' | 'event_updated'; at: string; event: { name: string } };

beforeEach(truncateAll);

async function seedSede(eventId: string, code: string, name: string): Promise<string> {
  const establishment = await establishments.insertEstablishment(db, { code, name, city: 'Bogota' }, NOW);
  const participation = await participations.insertParticipation(
    db,
    { eventId, establishmentId: establishment.id, titularCapacity: 50, companionCapacity: 50 },
    NOW,
  );
  return participation.id;
}

async function seedEvent(
  slug: string,
  options: Partial<Parameters<typeof events.insertEvent>[1]> = {},
): Promise<{ eventId: string; barby: string; cupidos: string }> {
  const event = await events.insertEvent(
    db,
    { slug, name: `Evento ${slug}`, status: 'published', ...options },
    NOW,
  );
  return {
    eventId: event.id,
    barby: await seedSede(event.id, `${slug}-barby`, 'Barby Toys'),
    cupidos: await seedSede(event.id, `${slug}-cupidos`, 'Cupidos'),
  };
}

let documentSeq = 70_000_000;

async function register(cookie: string, participationId: string, companions: readonly string[] = []) {
  documentSeq += 1;
  const response = await api('/registrations', cookie, {
    method: 'POST',
    body: JSON.stringify({
      participationId,
      documentType: 'CC',
      documentNumber: String(documentSeq),
      fullName: `Titular ${documentSeq}`,
      companions: companions.map((fullName) => ({ fullName })),
    }),
  });
  expect(response.status).toBe(201);
  return (await response.json<{ data: { id: string } }>()).data.id;
}

async function scan(cookie: string, code: string): Promise<void> {
  const response = await api('/check-in/scan', cookie, { method: 'POST', body: JSON.stringify({ code }) });
  expect(response.status).toBe(200);
}

async function read<T>(cookie: string, path: string): Promise<T> {
  const response = await api(path, cookie);
  expect(response.status).toBe(200);
  return (await response.json<{ data: T }>()).data;
}

describe('GET /dashboard/overview', () => {
  it('cuenta eventos por estado y solo considera activos los que no terminaron', async () => {
    const { cookie } = await seedOperator();
    await seedEvent('madrugon-2026');
    await seedEvent('borrador', { status: 'draft' });
    await seedEvent('pasado', {
      startsAt: new Date(Date.now() - 10 * 86_400_000),
      endsAt: new Date(Date.now() - 9 * 86_400_000),
    });

    const overview = await read<Overview>(cookie, '/dashboard/overview');
    const phases = Object.fromEntries(overview.items.map((item) => [item.name, item.phase]));

    expect(overview.events).toMatchObject({
      total: 3,
      active: 1,
      byStatus: { draft: 1, published: 2, closed: 0, archived: 0 },
    });
    expect(phases).toEqual({
      'Evento madrugon-2026': 'registration_open',
      'Evento borrador': 'draft',
      'Evento pasado': 'finished',
    });
    expect(overview.items[0]?.name).toBe('Evento madrugon-2026');
  });

  it('coincide con la mesa: titulares, personas e ingresos unicos por evento', async () => {
    const { cookie } = await seedOperator();
    const main = await seedEvent('madrugon-2026');
    const other = await seedEvent('otro');
    const a = await register(cookie, main.barby, ['Luis Paz', 'Marta Gil']);
    await register(cookie, main.cupidos);
    await register(cookie, other.barby, ['Eva Sol']);
    await scan(cookie, a);
    await scan(cookie, a);

    const overview = await read<Overview>(cookie, '/dashboard/overview');
    const byId = Object.fromEntries(overview.items.map((item) => [item.id, item]));
    const summary = await read<{ totals: Record<string, number> }>(
      cookie,
      `/check-in/summary?eventId=${main.eventId}`,
    );

    expect(byId[main.eventId]).toMatchObject({ titulares: 2, people: 4, checkedIn: 1, attendanceRate: 0.5 });
    expect(byId[main.eventId]?.sedes.map((sede) => sede.name)).toEqual(['Barby Toys', 'Cupidos']);
    expect(byId[other.eventId]).toMatchObject({ titulares: 1, people: 2, checkedIn: 0, attendanceRate: 0 });
    expect(summary.totals).toMatchObject({
      titulares: byId[main.eventId]?.titulares,
      people: byId[main.eventId]?.people,
      checkedIn: byId[main.eventId]?.checkedIn,
    });
  });

  it('exige sesion de personal', async () => {
    expect((await api('/dashboard/overview', '')).status).toBe(401);
  });
});

describe('GET /dashboard/registrations-timeline', () => {
  it('cuenta titulares confirmados por sede y en el consolidado', async () => {
    const { cookie } = await seedOperator();
    const { eventId, barby, cupidos } = await seedEvent('madrugon-2026');
    await register(cookie, barby, ['Luis Paz']);
    await register(cookie, barby);
    await register(cookie, cupidos);
    const cancelled = await register(cookie, cupidos);
    await api(`/registrations/${cancelled}/cancel`, cookie, {
      method: 'POST',
      body: JSON.stringify({ reason: 'No asistira al evento.' }),
    });

    const all = await read<Timeline>(cookie, `/dashboard/registrations-timeline?eventId=${eventId}`);
    const onlyBarby = await read<Timeline>(
      cookie,
      `/dashboard/registrations-timeline?eventId=${eventId}&participationId=${barby}`,
    );

    expect(all).toMatchObject({ granularity: 'hour', total: 3, last24h: 3 });
    expect(all.buckets.at(-1)).toMatchObject({ cumulative: 3, people: 4 });
    expect(onlyBarby).toMatchObject({ total: 2, last24h: 2 });
  });

  it('un evento sin inscripciones devuelve una serie vacia', async () => {
    const { cookie } = await seedOperator();
    const { eventId } = await seedEvent('vacio');
    const timeline = await read<Timeline>(cookie, `/dashboard/registrations-timeline?eventId=${eventId}`);
    expect(timeline).toMatchObject({ total: 0, last24h: 0, buckets: [] });
  });

  it('rechaza eventos inexistentes y sedes ajenas', async () => {
    const { cookie } = await seedOperator();
    const main = await seedEvent('madrugon-2026');
    const other = await seedEvent('otro');

    const unknown = await api(`/dashboard/registrations-timeline?eventId=${UNKNOWN_ID}`, cookie);
    expect(unknown.status).toBe(404);
    expect(await errorCodeOf(unknown)).toBe('EVENT_NOT_FOUND');

    const foreign = await api(
      `/dashboard/registrations-timeline?eventId=${main.eventId}&participationId=${other.barby}`,
      cookie,
    );
    expect(foreign.status).toBe(404);
    expect(await errorCodeOf(foreign)).toBe('PARTICIPATION_NOT_FOUND');
  });
});

describe('GET /dashboard/activity', () => {
  it('lista inscripciones e ingresos sin repetir reescaneos ni exponer documentos', async () => {
    const { cookie } = await seedOperator();
    const { eventId, barby } = await seedEvent('madrugon-2026');
    const id = await register(cookie, barby, ['Luis Paz']);
    await scan(cookie, id);
    await scan(cookie, id);

    const response = await api(`/dashboard/activity?eventId=${eventId}`, cookie);
    expect(response.status).toBe(200);
    const raw = await response.text();
    const items = (JSON.parse(raw) as { data: Activity[] }).data;

    expect(items.filter((item) => item.type === 'check_in')).toHaveLength(1);
    expect(items[0]).toMatchObject({
      type: 'check_in',
      registration: { id, sede: 'Barby Toys' },
      operator: 'Operador Uno',
    });
    expect(items.some((item) => item.type === 'registration')).toBe(true);
    expect(items.some((item) => item.type === 'event_created')).toBe(true);
    for (const field of ['documentNumber', 'documentType', 'email', 'phone']) {
      expect(raw).not.toContain(`"${field}"`);
    }
  });

  it('respeta la sede y el limite', async () => {
    const { cookie } = await seedOperator();
    const { eventId, barby, cupidos } = await seedEvent('madrugon-2026');
    await register(cookie, barby);
    await register(cookie, barby);
    await register(cookie, cupidos);

    const onlyCupidos = await read<Activity[]>(
      cookie,
      `/dashboard/activity?eventId=${eventId}&participationId=${cupidos}`,
    );
    expect(onlyCupidos).toHaveLength(1);
    expect(onlyCupidos[0]).toMatchObject({ type: 'registration', registration: { sede: 'Cupidos' } });

    const limited = await read<Activity[]>(cookie, `/dashboard/activity?eventId=${eventId}&limit=2`);
    expect(limited).toHaveLength(2);
  });

  it('exige sesion de personal', async () => {
    expect((await api(`/dashboard/activity?eventId=${UNKNOWN_ID}`, '')).status).toBe(401);
  });
});

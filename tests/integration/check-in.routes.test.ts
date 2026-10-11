import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { sha256Hex } from '../../src/core/crypto/encoding';
import { createDb } from '../../src/db/client';
import * as establishments from '../../src/modules/establishments/establishments.repository';
import * as events from '../../src/modules/events/events.repository';
import * as participations from '../../src/modules/participations/participations.repository';
import { api, errorCodeOf, seedAdmin, seedOperator } from '../helpers/api';
import { countRows, truncateAll } from '../helpers/database';

/**
 * Ingreso en puerta: el QR entrega turnos consecutivos por sede.
 *
 * Lo que importa probar es la numeracion: seguida dentro de un grupo, continua
 * entre registros, independiente entre sedes, estable al reescanear y sin
 * repetidos cuando dos escaneos llegan a la vez.
 */

const db = createDb(env);
const NOW = new Date(1_760_000_000_000);
const UNKNOWN_ID = '00000000-0000-4000-8000-000000000000';

interface TurnBody {
  number: number;
  position: number;
  role: 'holder' | 'companion';
  fullName: string;
}

interface ScanBody {
  alreadyAssigned: boolean;
  registration: { id: string; fullName: string };
  event: { slug: string };
  sede: { id: string; name: string };
  turns: TurnBody[];
}

beforeEach(truncateAll);

async function seedSede(eventId: string, code: string): Promise<participations.ParticipationRow> {
  const establishment = await establishments.insertEstablishment(
    db,
    { code, name: `Sede ${code}`, city: 'Bogota' },
    NOW,
  );
  return participations.insertParticipation(
    db,
    { eventId, establishmentId: establishment.id, titularCapacity: 20, companionCapacity: 20 },
    NOW,
  );
}

async function seedCatalog(): Promise<{ norte: string; sur: string }> {
  const event = await events.insertEvent(
    db,
    { slug: 'evento-1', name: 'Evento 1', status: 'published' },
    NOW,
  );
  const norte = await seedSede(event.id, 'norte');
  const sur = await seedSede(event.id, 'sur');
  return { norte: norte.id, sur: sur.id };
}

let documentSeq = 10_000_000;

async function register(
  cookie: string,
  participationId: string,
  companions: readonly string[] = [],
): Promise<string> {
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

function scan(cookie: string, code: string): Promise<Response> {
  return api('/check-in/scan', cookie, { method: 'POST', body: JSON.stringify({ code }) });
}

async function readScan(cookie: string, code: string): Promise<ScanBody> {
  const response = await scan(cookie, code);
  expect(response.status).toBe(200);
  return (await response.json<{ data: ScanBody }>()).data;
}

const numbersOf = (body: ScanBody): number[] => body.turns.map((turn) => turn.number);

describe('POST /check-in/scan', () => {
  it('asigna un turno por persona, titular primero, con numeros seguidos', async () => {
    const { cookie } = await seedOperator();
    const { norte } = await seedCatalog();
    const id = await register(cookie, norte, ['Luis', 'Marta']);

    const body = await readScan(cookie, id);

    expect(body.alreadyAssigned).toBe(false);
    expect(body.turns).toEqual([
      { number: 1, position: 0, role: 'holder', fullName: expect.stringContaining('Titular') },
      { number: 2, position: 1, role: 'companion', fullName: 'Luis' },
      { number: 3, position: 2, role: 'companion', fullName: 'Marta' },
    ]);
    expect(body.sede.id).toBe(norte);
  });

  it('continua la numeracion entre registros y la reinicia en cada sede', async () => {
    const { cookie } = await seedAdmin();
    const { norte, sur } = await seedCatalog();
    const first = await register(cookie, norte, ['Luis']);
    const second = await register(cookie, norte);
    const other = await register(cookie, sur, ['Eva']);

    expect(numbersOf(await readScan(cookie, first))).toEqual([1, 2]);
    expect(numbersOf(await readScan(cookie, other))).toEqual([1, 2]);
    expect(numbersOf(await readScan(cookie, second))).toEqual([3]);
  });

  it('reescanear devuelve los mismos turnos sin gastar numeros', async () => {
    const { cookie } = await seedOperator();
    const { norte } = await seedCatalog();
    const first = await register(cookie, norte, ['Luis']);
    const second = await register(cookie, norte);

    await readScan(cookie, first);
    const again = await readScan(cookie, first);

    expect(again.alreadyAssigned).toBe(true);
    expect(numbersOf(again)).toEqual([1, 2]);
    expect(numbersOf(await readScan(cookie, second))).toEqual([3]);
    expect(await countRows('turns')).toBe(3);
  });

  it('no repite numeros con escaneos simultaneos', async () => {
    const { cookie } = await seedOperator();
    const { norte } = await seedCatalog();
    const ids = await Promise.all([
      register(cookie, norte, ['Ana Ruiz']),
      register(cookie, norte, ['Beto Gil', 'Carla Paz']),
      register(cookie, norte),
      register(cookie, norte, ['Dario Sol']),
    ]);

    const results = await Promise.all([...ids, ids[0] as string].map((id) => readScan(cookie, id)));
    const numbers = results.slice(0, ids.length).flatMap(numbersOf).sort((a, b) => a - b);

    expect(numbers).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(numbersOf(results[4] as ScanBody)).toEqual(numbersOf(results[0] as ScanBody));
    expect(await countRows('turns')).toBe(8);
  });

  it('acepta el token del QR ademas del id del registro', async () => {
    const { cookie } = await seedOperator();
    const { norte } = await seedCatalog();
    const id = await register(cookie, norte);
    // El alta ya emitio un QR cuyo token no se devuelve; se fija uno conocido.
    const token = crypto.randomUUID();
    await env.DB.prepare('UPDATE qr_codes SET token_hash = ? WHERE registration_id = ?')
      .bind(await sha256Hex(token), id)
      .run();

    const body = await readScan(cookie, `  ${token.toUpperCase()} `);

    expect(body.registration.id).toBe(id);
    expect(numbersOf(body)).toEqual([1]);
  });

  it('rechaza una inscripcion cancelada sin asignar turno', async () => {
    const { cookie } = await seedOperator();
    const { norte } = await seedCatalog();
    const id = await register(cookie, norte);
    const cancel = await api(`/registrations/${id}/cancel`, cookie, {
      method: 'POST',
      body: JSON.stringify({ reason: 'No asistira al evento.' }),
    });
    expect(cancel.status).toBe(200);

    const response = await scan(cookie, id);

    expect(response.status).toBe(409);
    expect(await errorCodeOf(response)).toBe('QR_REVOKED');
    expect(await countRows('turns')).toBe(0);
  });

  it('distingue un codigo desconocido de uno mal formado', async () => {
    const { cookie } = await seedOperator();
    await seedCatalog();

    const unknown = await scan(cookie, UNKNOWN_ID);
    expect(unknown.status).toBe(404);
    expect(await errorCodeOf(unknown)).toBe('TICKET_NOT_FOUND');

    const malformed = await scan(cookie, 'https://example.com/otra-cosa');
    expect(malformed.status).toBe(422);
    expect(await errorCodeOf(malformed)).toBe('QR_MALFORMED');
  });

  it('exige sesion', async () => {
    const response = await api('/check-in/scan', '', {
      method: 'POST',
      body: JSON.stringify({ code: UNKNOWN_ID }),
    });
    expect(response.status).toBe(401);
  });
});

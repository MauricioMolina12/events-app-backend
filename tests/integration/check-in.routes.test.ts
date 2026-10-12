import { env } from 'cloudflare:test';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { sha256Hex } from '../../src/core/crypto/encoding';
import { createDb } from '../../src/db/client';
import { eventEstablishments, registrationDocuments, registrations } from '../../src/db/schema';
import * as establishments from '../../src/modules/establishments/establishments.repository';
import * as events from '../../src/modules/events/events.repository';
import * as participations from '../../src/modules/participations/participations.repository';
import { api, errorCodeOf, seedAdmin, seedOperator } from '../helpers/api';
import { countRows, truncateAll } from '../helpers/database';

/**
 * Ingreso en puerta: el QR identifica el registro; los turnos salen solo despues
 * de confirmar titular y acompanantes. Quien no llego libera cupo.
 */

const db = createDb(env);
const NOW = new Date(1_760_000_000_000);
const UNKNOWN_ID = '00000000-0000-4000-8000-000000000000';

interface CompanionBody {
  id: string;
  fullName: string;
  documentType: string | null;
  documentNumber: string | null;
}

interface TurnBody {
  number: number;
  position: number;
  role: 'holder' | 'companion';
  fullName: string;
}

interface LookupBody {
  alreadyAssigned: boolean;
  registration: { id: string; fullName: string; companionsCount: number };
  event: { slug: string };
  sede: { id: string; name: string };
  companions: CompanionBody[];
  turns: TurnBody[];
}

interface ScanBody extends LookupBody {
  releasedCompanionsCount: number;
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
  companions: readonly (string | { fullName: string; documentType: string; documentNumber: string })[] = [],
): Promise<string> {
  documentSeq += 1;
  const response = await api('/registrations', cookie, {
    method: 'POST',
    body: JSON.stringify({
      participationId,
      documentType: 'CC',
      documentNumber: String(documentSeq),
      fullName: `Titular ${documentSeq}`,
      companions: companions.map((companion) =>
        typeof companion === 'string' ? { fullName: companion } : companion,
      ),
    }),
  });
  expect(response.status).toBe(201);
  return (await response.json<{ data: { id: string } }>()).data.id;
}

function lookup(cookie: string, code: string): Promise<Response> {
  return api('/check-in/lookup', cookie, { method: 'POST', body: JSON.stringify({ code }) });
}

async function readLookup(cookie: string, code: string): Promise<LookupBody> {
  const response = await lookup(cookie, code);
  expect(response.status).toBe(200);
  return (await response.json<{ data: LookupBody }>()).data;
}

function scan(
  cookie: string,
  code: string,
  attendance: {
    holderPresent: boolean;
    presentCompanionIds?: readonly string[];
    releaseCompanionIds?: readonly string[];
  },
): Promise<Response> {
  return api('/check-in/scan', cookie, {
    method: 'POST',
    body: JSON.stringify({
      code,
      holderPresent: attendance.holderPresent,
      presentCompanionIds: attendance.presentCompanionIds ?? [],
      releaseCompanionIds: attendance.releaseCompanionIds ?? [],
    }),
  });
}

async function readScan(
  cookie: string,
  code: string,
  presentCompanionIds: readonly string[] = [],
): Promise<ScanBody> {
  const response = await scan(cookie, code, { holderPresent: true, presentCompanionIds });
  expect(response.status).toBe(200);
  return (await response.json<{ data: ScanBody }>()).data;
}

async function confirmAll(cookie: string, code: string): Promise<ScanBody> {
  const preview = await readLookup(cookie, code);
  return readScan(
    cookie,
    code,
    preview.companions.map((companion) => companion.id),
  );
}

const numbersOf = (body: LookupBody): number[] => body.turns.map((turn) => turn.number);

describe('POST /check-in/lookup', () => {
  it('identifica el registro y sus acompanantes sin asignar turnos', async () => {
    const { cookie } = await seedOperator();
    const { norte } = await seedCatalog();
    const id = await register(cookie, norte, ['Luis', 'Marta']);

    const body = await readLookup(cookie, id);

    expect(body.alreadyAssigned).toBe(false);
    expect(body.turns).toEqual([]);
    expect(body.companions.map((companion) => companion.fullName)).toEqual(['Luis', 'Marta']);
    expect(await countRows('turns')).toBe(0);
  });

  it('exige sesion', async () => {
    const response = await api('/check-in/lookup', '', {
      method: 'POST',
      body: JSON.stringify({ code: UNKNOWN_ID }),
    });
    expect(response.status).toBe(401);
  });
});

describe('POST /check-in/scan', () => {
  it('asigna un turno por persona presente, titular primero, con numeros seguidos', async () => {
    const { cookie } = await seedOperator();
    const { norte } = await seedCatalog();
    const id = await register(cookie, norte, ['Luis', 'Marta']);

    const body = await confirmAll(cookie, id);

    expect(body.alreadyAssigned).toBe(false);
    expect(body.releasedCompanionsCount).toBe(0);
    expect(body.turns).toEqual([
      { number: 1, position: 0, role: 'holder', fullName: expect.stringContaining('Titular') },
      { number: 2, position: 1, role: 'companion', fullName: 'Luis' },
      { number: 3, position: 2, role: 'companion', fullName: 'Marta' },
    ]);
    expect(body.sede.id).toBe(norte);
  });

  it('no asigna turno si el titular no esta', async () => {
    const { cookie } = await seedOperator();
    const { norte } = await seedCatalog();
    const id = await register(cookie, norte, ['Luis']);

    const response = await scan(cookie, id, { holderPresent: false });

    expect(response.status).toBe(409);
    expect(await errorCodeOf(response)).toBe('CHECK_IN_HOLDER_ABSENT');
    expect(await countRows('turns')).toBe(0);
    expect(await countRows('registration_companions')).toBe(1);
  });

  it('libera el cupo y el documento de los acompanantes que no llegaron', async () => {
    const { cookie } = await seedOperator();
    const { norte } = await seedCatalog();
    const releasedDocument = '1099001122';
    const id = await register(cookie, norte, [
      'Luis',
      { fullName: 'Marta', documentType: 'CC', documentNumber: releasedDocument },
    ]);

    const preview = await readLookup(cookie, id);
    const luis = preview.companions.find((companion) => companion.fullName === 'Luis');
    expect(luis).toBeDefined();

    const marta = preview.companions.find((companion) => companion.fullName === 'Marta');
    const response = await scan(cookie, id, {
      holderPresent: true,
      presentCompanionIds: [luis!.id],
      releaseCompanionIds: marta ? [marta.id] : [],
    });
    expect(response.status).toBe(200);
    const body = (await response.json<{ data: ScanBody }>()).data;

    expect(body.releasedCompanionsCount).toBe(1);
    expect(body.registration.companionsCount).toBe(1);
    expect(body.turns.map((turn) => turn.fullName)).toEqual([
      expect.stringContaining('Titular'),
      'Luis',
    ]);
    expect(body.companions.map((companion) => companion.fullName)).toEqual(['Luis']);

    const [registration] = await db
      .select()
      .from(registrations)
      .where(eq(registrations.id, id));
    expect(registration?.companionsCount).toBe(1);

    const [sede] = await db
      .select()
      .from(eventEstablishments)
      .where(eq(eventEstablishments.id, norte));
    expect(sede?.confirmedCompanions).toBe(1);

    const [document] = await db
      .select()
      .from(registrationDocuments)
      .where(eq(registrationDocuments.documentNumber, releasedDocument));
    expect(document?.status).toBe('released');

    const reused = await register(cookie, norte, []);
    const reuse = await api('/registrations', cookie, {
      method: 'POST',
      body: JSON.stringify({
        participationId: norte,
        documentType: 'CC',
        documentNumber: String(++documentSeq),
        fullName: `Titular ${documentSeq}`,
        companions: [{ fullName: 'Nueva', documentType: 'CC', documentNumber: releasedDocument }],
      }),
    });
    expect(reuse.status).toBe(201);
    expect(reused).toBeTruthy();
  });

  it('continua la numeracion entre registros y la reinicia en cada sede', async () => {
    const { cookie } = await seedAdmin();
    const { norte, sur } = await seedCatalog();
    const first = await register(cookie, norte, ['Luis']);
    const second = await register(cookie, norte);
    const other = await register(cookie, sur, ['Eva']);

    expect(numbersOf(await confirmAll(cookie, first))).toEqual([1, 2]);
    expect(numbersOf(await confirmAll(cookie, other))).toEqual([1, 2]);
    expect(numbersOf(await confirmAll(cookie, second))).toEqual([3]);
  });

  it('reescanear devuelve los mismos turnos sin gastar numeros', async () => {
    const { cookie } = await seedOperator();
    const { norte } = await seedCatalog();
    const first = await register(cookie, norte, ['Luis']);
    const second = await register(cookie, norte);

    await confirmAll(cookie, first);
    const again = await confirmAll(cookie, first);

    expect(again.alreadyAssigned).toBe(true);
    expect(numbersOf(again)).toEqual([1, 2]);
    expect(numbersOf(await confirmAll(cookie, second))).toEqual([3]);
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

    const results = await Promise.all([...ids, ids[0] as string].map((id) => confirmAll(cookie, id)));
    const numbers = results.slice(0, ids.length).flatMap(numbersOf).sort((a, b) => a - b);

    expect(numbers).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(numbersOf(results[4] as ScanBody)).toEqual(numbersOf(results[0] as ScanBody));
    expect(await countRows('turns')).toBe(8);
  });

  it('acepta el token del QR ademas del id del registro', async () => {
    const { cookie } = await seedOperator();
    const { norte } = await seedCatalog();
    const id = await register(cookie, norte);
    const token = crypto.randomUUID();
    await env.DB.prepare('UPDATE qr_codes SET token_hash = ? WHERE registration_id = ?')
      .bind(await sha256Hex(token), id)
      .run();

    const body = await confirmAll(cookie, `  ${token.toUpperCase()} `);

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

    const response = await scan(cookie, id, { holderPresent: true });

    expect(response.status).toBe(409);
    expect(await errorCodeOf(response)).toBe('QR_REVOKED');
    expect(await countRows('turns')).toBe(0);
  });

  it('distingue un codigo desconocido de uno mal formado', async () => {
    const { cookie } = await seedOperator();
    await seedCatalog();

    const unknown = await scan(cookie, UNKNOWN_ID, { holderPresent: true });
    expect(unknown.status).toBe(404);
    expect(await errorCodeOf(unknown)).toBe('TICKET_NOT_FOUND');

    const malformed = await scan(cookie, 'https://example.com/otra-cosa', { holderPresent: true });
    expect(malformed.status).toBe(422);
    expect(await errorCodeOf(malformed)).toBe('QR_MALFORMED');
  });

  it('exige sesion', async () => {
    const response = await api('/check-in/scan', '', {
      method: 'POST',
      body: JSON.stringify({ code: UNKNOWN_ID, holderPresent: true }),
    });
    expect(response.status).toBe(401);
  });
});

import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { createDb } from '../../src/db/client';
import * as establishments from '../../src/modules/establishments/establishments.repository';
import * as events from '../../src/modules/events/events.repository';
import * as participations from '../../src/modules/participations/participations.repository';
import { findRegistrationById } from '../../src/modules/registrations/registrations.repository';
import { api, errorCodeOf, seedAdmin } from '../helpers/api';
import { truncateAll } from '../helpers/database';

/**
 * Catalogo publico y alta del formulario contra la aplicacion completa y D1 real.
 *
 * Es la superficie sin sesion, asi que los casos que importan son de alcance: que no
 * se filtre un borrador, que no se ofrezca una sede cerrada ni una sede apagada, que
 * `registrationOpen` diga lo mismo que el alta va a aceptar, y que el alta publica
 * comparta las reglas de cupo, documento duplicado y ventana de la mesa de registro.
 *
 * El evento, la sede y la participacion se siembran por repositorio (ya estan
 * cubiertos por sus propias pruebas) para concentrar cada caso en estas rutas.
 */

const db = createDb(env);
/** Instante de siembra: cualquier `now` real es posterior. */
const NOW = new Date(1_760_000_000_000);
const HOUR = 3_600_000;
const UNKNOWN_ID = '00000000-0000-4000-8000-000000000000';

/** Ventana ya cerrada: el alta, que usa el reloj real, queda fuera. */
const CLOSED_BEFORE = new Date(Date.now() - HOUR);
/** Extremos vigentes en el momento de la prueba. */
const OPEN_FROM = new Date(Date.now() - HOUR);
const OPEN_TO = new Date(Date.now() + HOUR);

interface PublicEstablishmentBody {
  id: string;
  name: string;
  city: string | null;
}

interface PublicParticipationBody {
  id: string;
  establishment: PublicEstablishmentBody;
  availableTitulares: number;
  availableCompanions: number;
  registrationOpensAt: string | null;
  registrationClosesAt: string | null;
  registrationOpen: boolean;
}

interface PublicEventBody {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  timezone: string;
  startsAt: string | null;
  endsAt: string | null;
  registrationOpensAt: string | null;
  registrationClosesAt: string | null;
  participations: PublicParticipationBody[];
}

interface PublicEventResponse {
  success: true;
  data: PublicEventBody;
}

interface PublicEventListResponse {
  success: true;
  data: PublicEventBody[];
  meta: { total: number; limit: number; offset: number };
}

interface PublicReceiptBody {
  id: string;
  participationId: string;
  documentType: string;
  documentNumber: string;
  fullName: string;
  companionsCount: number;
  status: string;
  registeredAt: string;
}

interface PublicReceiptResponse {
  success: true;
  data: PublicReceiptBody;
}

interface RegistrationListResponse {
  success: true;
  data: Array<{ id: string; source: string }>;
  meta: { total: number };
}

/** Sobre de error con los `details` que consume el formulario publico. */
interface ErrorBody {
  success: false;
  error: { code: string; message: string; details?: unknown };
}

beforeEach(truncateAll);

/** Evento publicado (salvo que el caso diga otra cosa). */
function seedEvent(options: Partial<events.CreateEventInput> = {}): Promise<events.EventRow> {
  return events.insertEvent(
    db,
    { slug: 'feria', name: 'Feria 2026', status: 'published', ...options },
    NOW,
  );
}

/** Sede activa (salvo que el caso diga otra cosa). */
function seedEstablishment(
  options: Partial<establishments.CreateEstablishmentInput> = {},
): Promise<establishments.EstablishmentRow> {
  return establishments.insertEstablishment(
    db,
    { code: 'norte', name: 'Sede Norte', city: 'Bogota', ...options },
    NOW,
  );
}

/** Sede del evento con cupos holgados; la ventana la define el evento. */
function seedParticipation(
  eventId: string,
  establishmentId: string,
  options: Partial<participations.CreateParticipationInput> = {},
): Promise<participations.ParticipationRow> {
  return participations.insertParticipation(
    db,
    { eventId, establishmentId, titularCapacity: 5, companionCapacity: 5, ...options },
    NOW,
  );
}

/** Cuerpo del formulario con lo minimo; el caso cambia lo que necesite. */
function formBody(
  participationId: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    participationId,
    documentType: 'CC',
    documentNumber: '10203040',
    fullName: 'Ana Perez',
    ...overrides,
  };
}

/** Alta publica: la ruta no pide sesion, asi que no se envia cookie. */
function register(body: Record<string, unknown>): Promise<Response> {
  return api('/public/registrations', '', { method: 'POST', body: JSON.stringify(body) });
}

/** Ficha publica que se espera visible. */
async function publicEvent(reference: string): Promise<PublicEventBody> {
  const response = await api(`/public/events/${reference}`, '');
  expect(response.status).toBe(200);
  return (await response.json<PublicEventResponse>()).data;
}

describe('catalogo publico de eventos', () => {
  it('no pide sesion y solo ofrece eventos publicados', async () => {
    await seedEvent();
    await seedEvent({ slug: 'borrador', name: 'Borrador', status: 'draft' });

    const response = await api('/public/events', '');

    expect(response.status).toBe(200);
    const page = await response.json<PublicEventListResponse>();
    expect(page.meta.total).toBe(1);
    expect(page.data.map((event) => event.slug)).toEqual(['feria']);
  });

  it('resuelve la ficha por slug o por identificador', async () => {
    const event = await seedEvent();
    const establishment = await seedEstablishment();
    await seedParticipation(event.id, establishment.id);

    const bySlug = await publicEvent('feria');
    expect(bySlug.id).toBe(event.id);
    expect(bySlug.name).toBe('Feria 2026');
    expect(bySlug.participations).toHaveLength(1);

    const byId = await publicEvent(event.id);
    expect(byId.id).toBe(event.id);
    expect(byId.participations[0].establishment).toEqual({
      id: establishment.id,
      name: 'Sede Norte',
      city: 'Bogota',
    });
  });

  it('un evento no publicado responde 404 igual que uno inexistente', async () => {
    await seedEvent({ slug: 'borrador', name: 'Borrador', status: 'draft' });
    await seedEvent({ slug: 'cerrado', name: 'Cerrado', status: 'closed' });
    await seedEvent({ slug: 'archivado', name: 'Archivado', status: 'archived' });

    for (const reference of ['borrador', 'cerrado', 'archivado', UNKNOWN_ID]) {
      const response = await api(`/public/events/${reference}`, '');

      expect(response.status).toBe(404);
      await expect(errorCodeOf(response)).resolves.toBe('EVENT_NOT_FOUND');
    }
  });

  it('deja fuera las sedes cerradas y los establecimientos apagados', async () => {
    const event = await seedEvent();
    const north = await seedEstablishment();
    const inactive = await seedEstablishment({ code: 'sur', name: 'Sede Sur', status: 'inactive' });
    const closed = await seedEstablishment({ code: 'centro', name: 'Sede Centro' });

    const open = await seedParticipation(event.id, north.id);
    await seedParticipation(event.id, inactive.id);
    await seedParticipation(event.id, closed.id, { status: 'closed' });

    const view = await publicEvent(event.slug);

    expect(view.participations.map((seat) => seat.id)).toEqual([open.id]);
    expect(view.participations[0].establishment.name).toBe('Sede Norte');
  });

  it('devuelve un evento publicado sin sedes abiertas con la lista vacia', async () => {
    const event = await seedEvent();
    const establishment = await seedEstablishment({ status: 'inactive' });
    await seedParticipation(event.id, establishment.id);

    const view = await publicEvent(event.slug);

    expect(view.participations).toEqual([]);
  });

  it('la sede trae su cupo disponible y la ventana heredada del evento', async () => {
    const event = await seedEvent({ registrationClosesAt: OPEN_TO });
    const establishment = await seedEstablishment();
    const participation = await seedParticipation(event.id, establishment.id, {
      titularCapacity: 3,
      companionCapacity: 2,
    });

    const view = await publicEvent(event.slug);
    const [seat] = view.participations;

    expect(seat.id).toBe(participation.id);
    expect(seat.availableTitulares).toBe(3);
    expect(seat.availableCompanions).toBe(2);
    expect(seat.registrationOpensAt).toBeNull();
    expect(seat.registrationClosesAt).toBe(OPEN_TO.toISOString());
    expect(seat.registrationOpen).toBe(true);

    expect((await register(formBody(participation.id))).status).toBe(201);

    const after = await publicEvent(event.slug);
    expect(after.participations[0].availableTitulares).toBe(2);
  });

  it('registrationOpen es falso cuando el evento ya cerro su ventana', async () => {
    const event = await seedEvent({ registrationClosesAt: CLOSED_BEFORE });
    const establishment = await seedEstablishment();
    await seedParticipation(event.id, establishment.id);

    const view = await publicEvent(event.slug);

    expect(view.participations[0].registrationClosesAt).toBe(CLOSED_BEFORE.toISOString());
    expect(view.participations[0].registrationOpen).toBe(false);
  });

  it('la sede puede abrir su propia ventana sobre un evento ya cerrado', async () => {
    const event = await seedEvent({ registrationClosesAt: CLOSED_BEFORE });
    const establishment = await seedEstablishment();
    const participation = await seedParticipation(event.id, establishment.id, {
      registrationOpensAt: OPEN_FROM,
      registrationClosesAt: OPEN_TO,
    });

    const view = await publicEvent(event.slug);

    expect(view.participations[0].registrationOpen).toBe(true);
    expect(view.participations[0].registrationClosesAt).toBe(OPEN_TO.toISOString());
    expect((await register(formBody(participation.id))).status).toBe(201);
  });

  it('filtra por texto libre y acota la pagina', async () => {
    await seedEvent();
    await seedEvent({ slug: 'feria-sur', name: 'Feria del Sur' });
    await seedEvent({ slug: 'otro', name: 'Otro evento' });

    const search = await api('/public/events?search=feria', '');
    expect((await search.json<PublicEventListResponse>()).meta.total).toBe(2);

    const response = await api('/public/events?limit=1&offset=1', '');
    const page = await response.json<PublicEventListResponse>();

    expect(page.meta).toEqual({ total: 3, limit: 1, offset: 1 });
    expect(page.data).toHaveLength(1);
  });
});

describe('alta desde el formulario publico', () => {
  it('confirma el registro sin sesion y se marca con origen publico', async () => {
    const admin = await seedAdmin();
    const event = await seedEvent();
    const establishment = await seedEstablishment();
    const participation = await seedParticipation(event.id, establishment.id);

    const response = await register(
      formBody(participation.id, {
        documentNumber: '1.020.304.000',
        email: 'ana@example.com',
        companions: [
          { fullName: 'Luis Perez', documentType: 'TI', documentNumber: '99.001' },
          { fullName: 'Sofia Perez' },
        ],
      }),
    );

    expect(response.status).toBe(201);
    const receipt = (await response.json<PublicReceiptResponse>()).data;

    expect(receipt).toMatchObject({
      participationId: participation.id,
      documentType: 'CC',
      documentNumber: '1020304000',
      fullName: 'Ana Perez',
      companionsCount: 2,
      status: 'confirmed',
    });
    expect(receipt.registeredAt).toBe(new Date(receipt.registeredAt).toISOString());

    // El panel ve el alta como cualquier otra, con su origen declarado.
    const list = await api(`/registrations?participationId=${participation.id}`, admin.cookie);
    const page = await list.json<RegistrationListResponse>();
    expect(page.meta.total).toBe(1);
    expect(page.data[0].id).toBe(receipt.id);
    expect(page.data[0].source).toBe('public');
  });

  it('guarda si el titular requiere facturacion electronica', async () => {
    const event = await seedEvent();
    const establishment = await seedEstablishment();
    const participation = await seedParticipation(event.id, establishment.id);

    const yes = await register(
      formBody(participation.id, {
        documentNumber: '10203041',
        requiresElectronicInvoice: true,
      }),
    );
    expect(yes.status).toBe(201);
    const yesId = (await yes.json<PublicReceiptResponse>()).data.id;
    expect((await findRegistrationById(db, yesId))?.requiresElectronicInvoice).toBe(true);

    const no = await register(
      formBody(participation.id, {
        documentNumber: '10203042',
        requiresElectronicInvoice: false,
      }),
    );
    expect(no.status).toBe(201);
    const noId = (await no.json<PublicReceiptResponse>()).data.id;
    expect((await findRegistrationById(db, noId))?.requiresElectronicInvoice).toBe(false);
  });

  it('comparte las reglas de cupo de la mesa de registro', async () => {
    const event = await seedEvent();
    const establishment = await seedEstablishment();
    const participation = await seedParticipation(event.id, establishment.id, {
      titularCapacity: 1,
    });

    expect((await register(formBody(participation.id))).status).toBe(201);

    const noRoom = await register(formBody(participation.id, { documentNumber: '99887766' }));

    expect(noRoom.status).toBe(409);
    await expect(errorCodeOf(noRoom)).resolves.toBe('TITULAR_CAPACITY_EXCEEDED');

    const view = await publicEvent(event.slug);
    expect(view.participations[0].availableTitulares).toBe(0);
  });

  it('rechaza el documento duplicado en el evento y da el detalle al frontend', async () => {
    const event = await seedEvent();
    const north = await seedEstablishment();
    const south = await seedEstablishment({ code: 'sur', name: 'Sede Sur' });
    const inNorth = await seedParticipation(event.id, north.id);
    const inSouth = await seedParticipation(event.id, south.id);

    const first = await register(formBody(inNorth.id, { documentNumber: '1.020.304.000' }));
    expect(first.status).toBe(201);

    const duplicate = await register(formBody(inNorth.id, { documentNumber: '1020304000' }));
    expect(duplicate.status).toBe(409);
    const error = await duplicate.json<ErrorBody>();
    expect(error.success).toBe(false);
    expect(error.error.code).toBe('DUPLICATE_DOCUMENT');
    expect(error.error.details).toEqual({
      document: '1020304000',
      role: 'holder',
      registeredAs: 'holder',
      field: 'documentNumber',
    });

    // La regla es del evento, no de la sede: tampoco entra en otra sede.
    const elsewhere = await register(formBody(inSouth.id, { documentNumber: '1.020.304.000' }));
    expect(elsewhere.status).toBe(409);
    await expect(errorCodeOf(elsewhere)).resolves.toBe('DUPLICATE_DOCUMENT');

    // En otro evento la misma persona si puede inscribirse.
    const otherEvent = await seedEvent({ slug: 'otra-feria', name: 'Otra feria' });
    const otherSeat = await seedEstablishment({ code: 'centro', name: 'Sede Centro' });
    const inOtherEvent = await seedParticipation(otherEvent.id, otherSeat.id);
    const allowed = await register(formBody(inOtherEvent.id, { documentNumber: '1.020.304.000' }));
    expect(allowed.status).toBe(201);
  });

  it('rechaza como acompanante un documento ya usado en el evento', async () => {
    const event = await seedEvent();
    const establishment = await seedEstablishment();
    const participation = await seedParticipation(event.id, establishment.id);

    const first = await register(formBody(participation.id));
    expect(first.status).toBe(201);

    const duplicate = await register(
      formBody(participation.id, {
        documentNumber: '99887766',
        fullName: 'Otra titular',
        companions: [
          { fullName: 'Ana Perez', documentType: 'CC', documentNumber: '10.203.040' },
        ],
      }),
    );

    expect(duplicate.status).toBe(409);
    const error = await duplicate.json<ErrorBody>();
    expect(error.error.code).toBe('DUPLICATE_DOCUMENT');
    expect(error.error.message).toBe('El documento ingresado ya se encuentra registrado en este evento.');
    expect(error.error.details).toEqual({
      document: '10203040',
      role: 'companion',
      registeredAs: 'holder',
      field: 'companions[0].documentNumber',
    });
  });

  it('rechaza el alta si la sede cerro, la sede esta apagada o el evento no esta publicado', async () => {
    const event = await seedEvent();
    const closedSeat = await seedEstablishment({ code: 'centro', name: 'Sede Centro' });
    const inactiveSeat = await seedEstablishment({ code: 'sur', name: 'Sede Sur', status: 'inactive' });

    const closedParticipation = await seedParticipation(event.id, closedSeat.id, {
      status: 'closed',
    });
    const inactiveParticipation = await seedParticipation(event.id, inactiveSeat.id);

    for (const participationId of [closedParticipation.id, inactiveParticipation.id]) {
      const response = await register(formBody(participationId));

      expect(response.status).toBe(409);
      await expect(errorCodeOf(response)).resolves.toBe('PARTICIPATION_CLOSED');
    }

    const draft = await seedEvent({ slug: 'borrador', name: 'Borrador', status: 'draft' });
    const draftSeat = await seedEstablishment({ code: 'norte-2', name: 'Sede Dos' });
    const draftParticipation = await seedParticipation(draft.id, draftSeat.id);

    const draftResponse = await register(formBody(draftParticipation.id));
    expect(draftResponse.status).toBe(409);
    await expect(errorCodeOf(draftResponse)).resolves.toBe('EVENT_NOT_REGISTRABLE');
  });

  it('rechaza el alta fuera de la ventana del evento', async () => {
    const event = await seedEvent({ registrationClosesAt: CLOSED_BEFORE });
    const establishment = await seedEstablishment();
    const participation = await seedParticipation(event.id, establishment.id);

    const response = await register(formBody(participation.id));

    expect(response.status).toBe(409);
    await expect(errorCodeOf(response)).resolves.toBe('REGISTRATION_OUTSIDE_WINDOW');
  });

  it('responde 404 si la sede no existe y 422 si el cuerpo no es coherente', async () => {
    const missingSeat = await register(formBody(UNKNOWN_ID));
    expect(missingSeat.status).toBe(404);
    await expect(errorCodeOf(missingSeat)).resolves.toBe('PARTICIPATION_NOT_FOUND');

    const event = await seedEvent();
    const establishment = await seedEstablishment();
    const participation = await seedParticipation(event.id, establishment.id);

    const incomplete = await register({
      participationId: participation.id,
      documentType: 'CC',
      documentNumber: '10203040',
    });
    expect(incomplete.status).toBe(422);
    await expect(errorCodeOf(incomplete)).resolves.toBe('VALIDATION_ERROR');

    const halfDocument = await register(
      formBody(participation.id, {
        companions: [{ fullName: 'Luis Perez', documentNumber: '99001' }],
      }),
    );
    expect(halfDocument.status).toBe(422);
    await expect(errorCodeOf(halfDocument)).resolves.toBe('VALIDATION_ERROR');
  });
});

interface HolderRegistrationResponse {
  success: true;
  data: PublicReceiptBody & { maxCompanions: number };
}

function lookup(body: Record<string, unknown>): Promise<Response> {
  return api('/public/registrations/lookup', '', { method: 'POST', body: JSON.stringify(body) });
}

function addCompanions(body: Record<string, unknown>): Promise<Response> {
  return api('/public/registrations/companions', '', {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

describe('acompanantes agregados despues del alta', () => {
  /** Titular inscrito con correo y, si el caso lo pide, acompanantes desde el alta. */
  async function seedHolder(companions: Array<Record<string, unknown>> = []) {
    const event = await seedEvent();
    const establishment = await seedEstablishment();
    const participation = await seedParticipation(event.id, establishment.id);
    const response = await register(
      formBody(participation.id, {
        documentNumber: '1.020.304.000',
        email: 'ana@example.com',
        companions,
      }),
    );
    expect(response.status).toBe(201);
    const receipt = (await response.json<PublicReceiptResponse>()).data;
    const credentials = {
      event: event.slug,
      documentType: 'CC',
      documentNumber: '1020304000',
      email: 'ANA@example.com ',
    };
    return { event, participation, receipt, credentials };
  }

  it('ubica la inscripcion del titular con documento y correo', async () => {
    const { receipt, credentials } = await seedHolder([{ fullName: 'Luis Perez' }]);

    const response = await lookup(credentials);

    expect(response.status).toBe(200);
    const found = (await response.json<HolderRegistrationResponse>()).data;
    expect(found).toMatchObject({ id: receipt.id, companionsCount: 1, maxCompanions: 2 });
  });

  it('responde lo mismo si el documento o el correo no coinciden', async () => {
    const { credentials } = await seedHolder();

    for (const body of [
      { ...credentials, email: 'otra@example.com' },
      { ...credentials, documentNumber: '99999999' },
      { ...credentials, event: 'no-existe' },
    ]) {
      const response = await lookup(body);
      expect(response.status).toBe(404);
      await expect(errorCodeOf(response)).resolves.toBe('REGISTRATION_NOT_FOUND');
    }
  });

  it('suma acompanantes al mismo registro y consume cupo de la sede', async () => {
    const { event, receipt, credentials } = await seedHolder([{ fullName: 'Luis Perez' }]);

    const response = await addCompanions({
      ...credentials,
      companions: [{ fullName: 'Sofia Perez', documentType: 'TI', documentNumber: '99.002' }],
    });

    expect(response.status).toBe(201);
    const updated = (await response.json<HolderRegistrationResponse>()).data;
    expect(updated).toMatchObject({ id: receipt.id, companionsCount: 2 });

    const view = await publicEvent(event.slug);
    expect(view.participations[0].availableCompanions).toBe(3);

    // El documento del nuevo acompanante ya ocupa su lugar en el evento.
    const reused = await register(
      formBody(view.participations[0].id, { documentType: 'TI', documentNumber: '99002' }),
    );
    expect(reused.status).toBe(409);
    await expect(errorCodeOf(reused)).resolves.toBe('DUPLICATE_DOCUMENT');
  });

  it('no deja pasar del tope de dos acompanantes por titular', async () => {
    const { event, credentials } = await seedHolder([
      { fullName: 'Luis Perez' },
      { fullName: 'Sofia Perez' },
    ]);

    const full = await addCompanions({ ...credentials, companions: [{ fullName: 'Tercera Persona' }] });
    expect(full.status).toBe(409);
    const error = await full.json<ErrorBody>();
    expect(error.error.code).toBe('COMPANION_LIMIT_REACHED');
    expect(error.error.details).toMatchObject({ max: 2, current: 2, requested: 1 });

    const view = await publicEvent(event.slug);
    expect(view.participations[0].availableCompanions).toBe(3);
  });

  it('cuenta los que ya tiene: con uno, no admite dos mas', async () => {
    const { credentials } = await seedHolder([{ fullName: 'Luis Perez' }]);

    const response = await addCompanions({
      ...credentials,
      companions: [{ fullName: 'Sofia Perez' }, { fullName: 'Tercera Persona' }],
    });

    expect(response.status).toBe(409);
    await expect(errorCodeOf(response)).resolves.toBe('COMPANION_LIMIT_REACHED');
  });

  it('rechaza al titular como su propio acompanante', async () => {
    const { credentials } = await seedHolder();

    const response = await addCompanions({
      ...credentials,
      companions: [{ fullName: 'Ana Perez', documentType: 'CC', documentNumber: '1020304000' }],
    });

    expect(response.status).toBe(422);
    await expect(errorCodeOf(response)).resolves.toBe('VALIDATION_ERROR');
  });

  it('rechaza un acompanante cuyo documento ya esta en el evento y no gasta cupo', async () => {
    const { event, participation, credentials } = await seedHolder();
    const other = await register(
      formBody(participation.id, { documentNumber: '77778888', fullName: 'Otra Titular' }),
    );
    expect(other.status).toBe(201);

    const response = await addCompanions({
      ...credentials,
      companions: [{ fullName: 'Otra Titular', documentType: 'CC', documentNumber: '77778888' }],
    });

    expect(response.status).toBe(409);
    const error = await response.json<ErrorBody>();
    expect(error.error.code).toBe('DUPLICATE_DOCUMENT');
    expect(error.error.details).toMatchObject({ field: 'companions[0].documentNumber' });

    const view = await publicEvent(event.slug);
    expect(view.participations[0].availableCompanions).toBe(5);
  });

  it('rechaza un alta con mas de dos acompanantes', async () => {
    const event = await seedEvent();
    const establishment = await seedEstablishment();
    const participation = await seedParticipation(event.id, establishment.id);

    const response = await register(
      formBody(participation.id, {
        companions: [{ fullName: 'Uno Perez' }, { fullName: 'Dos Perez' }, { fullName: 'Tres Perez' }],
      }),
    );

    expect(response.status).toBe(422);
    await expect(errorCodeOf(response)).resolves.toBe('VALIDATION_ERROR');
  });
});



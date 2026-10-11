import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { createDb } from '../../src/db/client';
import * as establishments from '../../src/modules/establishments/establishments.repository';
import * as events from '../../src/modules/events/events.repository';
import * as participations from '../../src/modules/participations/participations.repository';
import { api, errorCodeOf, seedAdmin, seedOperator } from '../helpers/api';
import { truncateAll } from '../helpers/database';

/**
 * Rutas de registros del panel contra la aplicacion completa y D1 real.
 *
 * La mesa de registro es donde el cupo se consume a mano, asi que los casos que
 * importan son los de la reserva: dos altas por el ultimo lugar, el cupo de
 * acompanantes que falta (y la devolucion del titular), el documento duplicado
 * normalizado y la cancelacion que devuelve cupo y libera el documento.
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

interface ParticipationBody {
  id: string;
  confirmedTitulares: number;
  confirmedCompanions: number;
  availableTitulares: number;
  availableCompanions: number;
}

interface RegistrationBody {
  id: string;
  participationId: string;
  documentType: string;
  documentNumber: string;
  fullName: string;
  email: string | null;
  phone: string | null;
  companionsCount: number;
  status: string;
  source: string;
  registeredAt: string;
  cancelledAt: string | null;
  cancelledReason: string | null;
}

interface RegistrationCompanionBody {
  id: string;
  fullName: string;
  documentType: string | null;
  documentNumber: string | null;
  createdAt: string;
}

interface ParticipationResponse {
  success: true;
  data: ParticipationBody;
}

interface RegistrationResponse {
  success: true;
  data: RegistrationBody;
}

interface RegistrationDetailResponse {
  success: true;
  data: RegistrationBody & { companions: RegistrationCompanionBody[] };
}

interface RegistrationListResponse {
  success: true;
  data: RegistrationBody[];
  meta: { total: number; limit: number; offset: number };
}

beforeEach(truncateAll);

interface SeedOptions {
  readonly event?: Partial<events.CreateEventInput>;
  readonly establishment?: Partial<establishments.CreateEstablishmentInput>;
  readonly participation?: Partial<participations.CreateParticipationInput>;
}

/** Evento publicado, sede activa y participacion abierta, con cupos holgados. */
async function seedCatalog(options: SeedOptions = {}): Promise<{
  event: events.EventRow;
  establishment: establishments.EstablishmentRow;
  participation: participations.ParticipationRow;
}> {
  const event = await events.insertEvent(
    db,
    { slug: 'evento-1', name: 'Evento 1', status: 'published', ...options.event },
    NOW,
  );
  const establishment = await establishments.insertEstablishment(
    db,
    { code: 'norte', name: 'Sede Norte', city: 'Bogota', ...options.establishment },
    NOW,
  );
  const participation = await participations.insertParticipation(
    db,
    {
      eventId: event.id,
      establishmentId: establishment.id,
      titularCapacity: 5,
      companionCapacity: 5,
      ...options.participation,
    },
    NOW,
  );

  return { event, establishment, participation };
}

/** Cuerpo del alta con los datos minimos y lo que el caso quiera cambiar. */
function registrationBody(
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

function postRegistration(
  cookie: string,
  body: Record<string, unknown>,
): Promise<Response> {
  return api('/registrations', cookie, { method: 'POST', body: JSON.stringify(body) });
}

/** Alta que se espera exitosa: devuelve la ficha creada. */
async function readRegistration(
  cookie: string,
  body: Record<string, unknown>,
): Promise<RegistrationBody> {
  const response = await postRegistration(cookie, body);
  expect(response.status).toBe(201);
  return (await response.json<RegistrationResponse>()).data;
}

/** Cupo consumido en la sede, tal como lo expone el catalogo del panel. */
async function capacityOf(cookie: string, participationId: string): Promise<ParticipationBody> {
  const response = await api(`/participations/${participationId}`, cookie);
  expect(response.status).toBe(200);
  return (await response.json<ParticipationResponse>()).data;
}

/**
 * Otra sede del mismo evento.
 *
 * Es la pieza que separa la regla vieja (un documento por sede) de la vigente (un
 * documento por evento): la unicidad se comprueba cruzando sedes.
 */
async function seedSiblingSeat(
  eventId: string,
  code = 'sur',
): Promise<participations.ParticipationRow> {
  const establishment = await establishments.insertEstablishment(
    db,
    { code, name: `Sede ${code}`, city: 'Bogota' },
    NOW,
  );

  return participations.insertParticipation(
    db,
    { eventId, establishmentId: establishment.id, titularCapacity: 5, companionCapacity: 5 },
    NOW,
  );
}

interface ErrorBody {
  success: false;
  error: { code: string; message: string; details?: Record<string, unknown> };
}

/** Error completo: el codigo no basta para comprobar los `details` que usa el frontend. */
async function errorBodyOf(response: Response): Promise<ErrorBody['error']> {
  return (await response.json<ErrorBody>()).error;
}

/** Cancela un registro desde el panel y comprueba que la operacion prospero. */
async function cancelRegistration(cookie: string, id: string): Promise<void> {
  const response = await api(`/registrations/${id}/cancel`, cookie, {
    method: 'POST',
    body: JSON.stringify({ reason: 'La persona aviso que no puede asistir.' }),
  });

  expect(response.status).toBe(200);
}

describe('autorizacion de los registros', () => {
  it('exige una sesion activa para la mesa de registro', async () => {
    const list = await api('/registrations', '');
    expect(list.status).toBe(401);
    await expect(errorCodeOf(list)).resolves.toBe('UNAUTHENTICATED');

    const create = await postRegistration('', registrationBody(UNKNOWN_ID));
    expect(create.status).toBe(401);
    await expect(errorCodeOf(create)).resolves.toBe('UNAUTHENTICATED');
  });

  it('deja al operador atender y buscar dentro de la jornada', async () => {
    const operator = await seedOperator();
    const { participation } = await seedCatalog();

    const created = await postRegistration(operator.cookie, registrationBody(participation.id));
    expect(created.status).toBe(201);
    expect((await created.json<RegistrationResponse>()).data.source).toBe('admin');

    const list = await api('/registrations', operator.cookie);
    expect(list.status).toBe(200);
    expect((await list.json<RegistrationListResponse>()).meta.total).toBe(1);
  });
});

describe('alta manual desde el panel', () => {
  it('crea el registro con sus acompanantes y normaliza el documento', async () => {
    const admin = await seedAdmin();
    const { participation } = await seedCatalog();

    const response = await postRegistration(
      admin.cookie,
      registrationBody(participation.id, {
        documentNumber: '1.020.304.000',
        email: 'ana@example.com',
        phone: '+57 300 123 4567',
        companions: [
          { fullName: 'Luis Perez', documentType: 'TI', documentNumber: '99.001' },
          { fullName: 'Sofia Perez' },
        ],
      }),
    );

    expect(response.status).toBe(201);
    const created = (await response.json<RegistrationResponse>()).data;

    expect(created).toMatchObject({
      participationId: participation.id,
      documentType: 'CC',
      documentNumber: '1020304000',
      fullName: 'Ana Perez',
      phone: '+57 300 123 4567',
      companionsCount: 2,
      status: 'confirmed',
      source: 'admin',
      cancelledAt: null,
      cancelledReason: null,
    });
    expect(created.registeredAt).toBe(new Date(created.registeredAt).toISOString());

    const detail = await api(`/registrations/${created.id}`, admin.cookie);
    expect(detail.status).toBe(200);
    const companions = (await detail.json<RegistrationDetailResponse>()).data.companions;

    expect(companions.map((companion) => companion.fullName)).toEqual(['Luis Perez', 'Sofia Perez']);
    expect(companions.map((companion) => companion.documentNumber)).toEqual(['99001', null]);
  });

  it('reserva el cupo antes de escribir: el ultimo lugar es de uno solo', async () => {
    const admin = await seedAdmin();
    const { participation } = await seedCatalog({ participation: { titularCapacity: 1 } });

    const first = await postRegistration(admin.cookie, registrationBody(participation.id));
    expect(first.status).toBe(201);

    const second = await postRegistration(
      admin.cookie,
      registrationBody(participation.id, { documentNumber: '99887766', fullName: 'Luis Gomez' }),
    );

    expect(second.status).toBe(409);
    await expect(errorCodeOf(second)).resolves.toBe('TITULAR_CAPACITY_EXCEEDED');

    const capacity = await capacityOf(admin.cookie, participation.id);
    expect(capacity.confirmedTitulares).toBe(1);
    expect(capacity.availableTitulares).toBe(0);
  });

  it('devuelve el cupo del titular cuando falta el de acompanantes', async () => {
    const admin = await seedAdmin();
    const { participation } = await seedCatalog({ participation: { companionCapacity: 1 } });

    const failed = await postRegistration(
      admin.cookie,
      registrationBody(participation.id, {
        companions: [
          { fullName: 'Luis Perez', documentType: 'TI', documentNumber: '99001' },
          { fullName: 'Sofia Perez' },
        ],
      }),
    );

    expect(failed.status).toBe(409);
    await expect(errorCodeOf(failed)).resolves.toBe('COMPANION_CAPACITY_EXCEEDED');

    // La reserva del titular se libera: un alta fallida no deja cupo vendido.
    const capacity = await capacityOf(admin.cookie, participation.id);
    expect(capacity.confirmedTitulares).toBe(0);
    expect(capacity.confirmedCompanions).toBe(0);

    const retry = await postRegistration(
      admin.cookie,
      registrationBody(participation.id, {
        companions: [{ fullName: 'Luis Perez', documentType: 'TI', documentNumber: '99001' }],
      }),
    );
    expect(retry.status).toBe(201);
  });

  it('rechaza el documento duplicado sin gastar cupo y con el detalle del motivo', async () => {
    const admin = await seedAdmin();
    const { participation } = await seedCatalog();

    await readRegistration(
      admin.cookie,
      registrationBody(participation.id, { documentNumber: '1.020.304.000' }),
    );

    const duplicate = await postRegistration(
      admin.cookie,
      registrationBody(participation.id, { documentNumber: '1020304000', fullName: 'Otra persona' }),
    );

    expect(duplicate.status).toBe(409);
    const error = await errorBodyOf(duplicate);
    expect(error.code).toBe('DUPLICATE_DOCUMENT');
    // El documento viaja normalizado y los roles dicen quien lo ocupa y quien lo pedia.
    expect(error.details).toEqual({
      document: '1020304000',
      role: 'holder',
      registeredAs: 'holder',
      field: 'documentNumber',
    });

    // El duplicado no consume cupo: la sede sigue con un solo titular.
    expect((await capacityOf(admin.cookie, participation.id)).confirmedTitulares).toBe(1);
  });

  it('rechaza el mismo documento en otra sede del evento', async () => {
    const admin = await seedAdmin();
    const { event, participation } = await seedCatalog();
    const south = await seedSiblingSeat(event.id);

    await readRegistration(admin.cookie, registrationBody(participation.id));

    // El cupo es por sede, pero la persona es una sola dentro del evento.
    const duplicate = await postRegistration(admin.cookie, registrationBody(south.id));

    expect(duplicate.status).toBe(409);
    expect((await errorBodyOf(duplicate)).code).toBe('DUPLICATE_DOCUMENT');
    expect((await capacityOf(admin.cookie, south.id)).confirmedTitulares).toBe(0);
  });

  it('rechaza como titular el documento que ya uso un acompanante', async () => {
    const admin = await seedAdmin();
    const { event, participation } = await seedCatalog();
    const south = await seedSiblingSeat(event.id);

    await readRegistration(
      admin.cookie,
      registrationBody(participation.id, {
        companions: [{ fullName: 'Luis Perez', documentType: 'TI', documentNumber: '99.001' }],
      }),
    );

    const duplicate = await postRegistration(
      admin.cookie,
      registrationBody(south.id, {
        documentType: 'TI',
        documentNumber: '99001',
        fullName: 'Luis Perez',
      }),
    );

    expect(duplicate.status).toBe(409);
    const error = await errorBodyOf(duplicate);
    expect(error.code).toBe('DUPLICATE_DOCUMENT');
    expect(error.message).toBe(
      'Este documento ya esta registrado como acompanante de otra persona.',
    );
    expect(error.details).toEqual({
      document: '99001',
      role: 'holder',
      registeredAs: 'companion',
      field: 'documentNumber',
    });
  });

  it('rechaza como acompanante el documento de un titular', async () => {
    const admin = await seedAdmin();
    const { event, participation } = await seedCatalog();
    const south = await seedSiblingSeat(event.id);

    await readRegistration(admin.cookie, registrationBody(participation.id));

    const duplicate = await postRegistration(
      admin.cookie,
      registrationBody(south.id, {
        documentNumber: '55667788',
        fullName: 'Otra titular',
        companions: [
          { fullName: 'Ana Perez', documentType: 'CC', documentNumber: '10.203.040' },
        ],
      }),
    );

    expect(duplicate.status).toBe(409);
    const error = await errorBodyOf(duplicate);
    expect(error.code).toBe('DUPLICATE_DOCUMENT');
    expect(error.message).toBe('El documento ingresado ya se encuentra registrado en este evento.');
    // El campo senala el acompanante exacto que esta mal, no el titular.
    expect(error.details).toEqual({
      document: '10203040',
      role: 'companion',
      registeredAs: 'holder',
      field: 'companions[0].documentNumber',
    });
    expect((await capacityOf(admin.cookie, south.id)).confirmedTitulares).toBe(0);
  });

  it('rechaza como acompanante el documento de otro acompanante', async () => {
    const admin = await seedAdmin();
    const { event, participation } = await seedCatalog();
    const south = await seedSiblingSeat(event.id);

    await readRegistration(
      admin.cookie,
      registrationBody(participation.id, {
        companions: [{ fullName: 'Luis Perez', documentType: 'TI', documentNumber: '99001' }],
      }),
    );

    const duplicate = await postRegistration(
      admin.cookie,
      registrationBody(south.id, {
        documentNumber: '55667788',
        fullName: 'Otra titular',
        companions: [{ fullName: 'Luis Perez', documentType: 'TI', documentNumber: '99.001' }],
      }),
    );

    expect(duplicate.status).toBe(409);
    const error = await errorBodyOf(duplicate);
    expect(error.code).toBe('DUPLICATE_DOCUMENT');
    expect(error.details).toEqual({
      document: '99001',
      role: 'companion',
      registeredAs: 'companion',
      field: 'companions[0].documentNumber',
    });
  });

  it('rechaza el mismo documento dos veces dentro de una solicitud', async () => {
    const admin = await seedAdmin();
    const { participation } = await seedCatalog();

    // El titular repetido como acompanante es un cuerpo incoherente (422), no un
    // choque con el estado del evento (409): se detecta antes de tocar la base.
    const response = await postRegistration(
      admin.cookie,
      registrationBody(participation.id, {
        documentNumber: '10203040',
        companions: [
          { fullName: 'Ana Perez', documentType: 'CC', documentNumber: '10.203.040' },
        ],
      }),
    );

    expect(response.status).toBe(422);
    const error = await errorBodyOf(response);
    expect(error.code).toBe('VALIDATION_ERROR');
    expect(error.details).toMatchObject({ field: 'companions[0].documentNumber' });
  });

  it('admite el mismo documento en eventos distintos', async () => {
    const admin = await seedAdmin();
    const first = await seedCatalog();
    const other = await seedCatalog({
      event: { slug: 'evento-2', name: 'Evento 2' },
      establishment: { code: 'centro', name: 'Sede Centro' },
    });

    const inFirst = await postRegistration(admin.cookie, registrationBody(first.participation.id));
    const inOther = await postRegistration(admin.cookie, registrationBody(other.participation.id));

    // El alcance es el evento: la misma persona puede inscribirse en otra feria.
    expect(inFirst.status).toBe(201);
    expect(inOther.status).toBe(201);
  });

  it('mantiene la unicidad ante dos altas simultaneas con el mismo documento', async () => {
    const admin = await seedAdmin();
    const { participation } = await seedCatalog();

    // Sin transacciones interactivas el pre-chequeo puede perder la carrera: la
    // garantia es el indice unico. Cualquiera de los dos ordenes es valido, pero
    // nunca pueden quedar dos registros con el mismo documento.
    const responses = await Promise.all([
      postRegistration(admin.cookie, registrationBody(participation.id)),
      postRegistration(
        admin.cookie,
        registrationBody(participation.id, { fullName: 'Ana P. Perez' }),
      ),
    ]);

    expect(responses.map((response) => response.status).sort()).toEqual([201, 409]);

    const rejected = responses.find((response) => response.status === 409);
    expect((await errorBodyOf(rejected as Response)).code).toBe('DUPLICATE_DOCUMENT');

    // El cupo no se duplica: la reserva de la alta perdida se devuelve.
    const capacity = await capacityOf(admin.cookie, participation.id);
    expect(capacity.confirmedTitulares).toBe(1);
    expect(capacity.availableTitulares).toBe(4);
  });

  it('libera el documento para todo el evento al cancelar', async () => {
    const admin = await seedAdmin();
    const { event, participation } = await seedCatalog();
    const south = await seedSiblingSeat(event.id);
    const created = await readRegistration(admin.cookie, registrationBody(participation.id));

    await cancelRegistration(admin.cookie, created.id);

    // El mismo documento vuelve a tener lugar, incluso en otra sede del evento.
    const again = await postRegistration(admin.cookie, registrationBody(south.id));
    expect(again.status).toBe(201);
  });

  it('traduce el choque del indice cuando el pre-chequeo no puede verlo', async () => {
    const admin = await seedAdmin();
    const { participation } = await seedCatalog();

    // Fila sembrada por fuera del servicio: no tiene documentos asociados, de modo
    // que el pre-chequeo no puede verla y la peticion choca contra el indice. La
    // respuesta sigue siendo un error del catalogo, no un 500.
    await env.DB.prepare(
      'INSERT INTO registrations (id, participation_id, document_type, document_number, full_name, companions_count, status, source, registered_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?)',
    )
      .bind(
        'reg-legacy',
        participation.id,
        'CC',
        '10203040',
        'Titular sembrado',
        'confirmed',
        'admin',
        NOW.getTime(),
        NOW.getTime(),
        NOW.getTime(),
      )
      .run();

    const response = await postRegistration(admin.cookie, registrationBody(participation.id));

    expect(response.status).toBe(409);
    await expect(errorCodeOf(response)).resolves.toBe('DUPLICATE_DOCUMENT');
    // La reserva de cupo se devuelve: el alta fallida no deja cupo vendido.
    expect((await capacityOf(admin.cookie, participation.id)).confirmedTitulares).toBe(0);
  });

  it('responde 404 si la sede no existe', async () => {
    const admin = await seedAdmin();

    const response = await postRegistration(admin.cookie, registrationBody(UNKNOWN_ID));

    expect(response.status).toBe(404);
    await expect(errorCodeOf(response)).resolves.toBe('PARTICIPATION_NOT_FOUND');
  });
});

describe('precondiciones del alta', () => {
  it('rechaza el alta si el evento no esta publicado', async () => {
    const admin = await seedAdmin();

    for (const status of ['draft', 'closed', 'archived'] as const) {
      const { participation } = await seedCatalog({
        event: { slug: `evento-${status}`, status },
        establishment: { code: `sede-${status}` },
      });

      const response = await postRegistration(admin.cookie, registrationBody(participation.id));

      expect(response.status).toBe(409);
      await expect(errorCodeOf(response)).resolves.toBe('EVENT_NOT_REGISTRABLE');
    }
  });

  it('rechaza el alta si la sede cerro o su establecimiento esta inactivo', async () => {
    const admin = await seedAdmin();
    const closed = await seedCatalog({ participation: { status: 'closed' } });

    const closedResponse = await postRegistration(
      admin.cookie,
      registrationBody(closed.participation.id),
    );

    expect(closedResponse.status).toBe(409);
    await expect(errorCodeOf(closedResponse)).resolves.toBe('PARTICIPATION_CLOSED');

    const inactive = await seedCatalog({
      event: { slug: 'evento-2' },
      establishment: { code: 'sur', status: 'inactive' },
    });

    const inactiveResponse = await postRegistration(
      admin.cookie,
      registrationBody(inactive.participation.id),
    );

    expect(inactiveResponse.status).toBe(409);
    await expect(errorCodeOf(inactiveResponse)).resolves.toBe('PARTICIPATION_CLOSED');
  });

  it('rechaza el alta fuera de la ventana y respeta la que define la sede', async () => {
    const admin = await seedAdmin();
    const { event, participation } = await seedCatalog({
      event: { registrationClosesAt: CLOSED_BEFORE },
    });

    const outside = await postRegistration(admin.cookie, registrationBody(participation.id));

    expect(outside.status).toBe(409);
    await expect(errorCodeOf(outside)).resolves.toBe('REGISTRATION_OUTSIDE_WINDOW');

    // La sede manda: una segunda sede con ventana propia admite el alta aunque el
    // evento ya haya cerrado la suya.
    const other = await establishments.insertEstablishment(
      db,
      { code: 'sur', name: 'Sede Sur', city: 'Medellin' },
      NOW,
    );

    const withOwnWindow = await participations.insertParticipation(
      db,
      {
        eventId: event.id,
        establishmentId: other.id,
        titularCapacity: 5,
        companionCapacity: 5,
        registrationOpensAt: OPEN_FROM,
        registrationClosesAt: OPEN_TO,
      },
      NOW,
    );

    const open = await postRegistration(admin.cookie, registrationBody(withOwnWindow.id));
    expect(open.status).toBe(201);
  });

  it('rechaza un cuerpo incoherente antes de tocar la sede', async () => {
    const admin = await seedAdmin();
    const { participation } = await seedCatalog();

    const response = await postRegistration(
      admin.cookie,
      registrationBody(participation.id, {
        companions: [{ fullName: 'Luis Perez', documentNumber: '99001' }],
      }),
    );

    expect(response.status).toBe(422);
    await expect(errorCodeOf(response)).resolves.toBe('VALIDATION_ERROR');
  });
});

describe('consulta y listado de registros', () => {
  it('lista los registros y filtra por sede, texto libre y estado', async () => {
    const admin = await seedAdmin();
    const first = await seedCatalog();
    const second = await seedCatalog({ event: { slug: 'evento-2' }, establishment: { code: 'sur' } });

    await readRegistration(
      admin.cookie,
      registrationBody(first.participation.id, { documentNumber: '10203040', fullName: 'Ana Perez' }),
    );
    await readRegistration(
      admin.cookie,
      registrationBody(first.participation.id, { documentNumber: '99887766', fullName: 'Luis Gomez' }),
    );
    await readRegistration(
      admin.cookie,
      registrationBody(second.participation.id, { documentNumber: '55443322', fullName: 'Ana Torres' }),
    );

    const byParticipation = await api(
      `/registrations?participationId=${first.participation.id}`,
      admin.cookie,
    );
    expect(byParticipation.status).toBe(200);
    const page = await byParticipation.json<RegistrationListResponse>();
    expect(page.meta.total).toBe(2);
    expect(page.data.map((row) => row.fullName).sort()).toEqual(['Ana Perez', 'Luis Gomez']);
    expect(page.data.every((row) => row.participationId === first.participation.id)).toBe(true);

    const byName = await api('/registrations?search=perez', admin.cookie);
    expect((await byName.json<RegistrationListResponse>()).meta.total).toBe(1);

    // El documento se busca normalizado, sin puntos ni guiones.
    const byDocument = await api('/registrations?search=99887766', admin.cookie);
    const documentPage = await byDocument.json<RegistrationListResponse>();
    expect(documentPage.meta.total).toBe(1);
    expect(documentPage.data[0].fullName).toBe('Luis Gomez');

    const byStatus = await api('/registrations?status=cancelled', admin.cookie);
    expect((await byStatus.json<RegistrationListResponse>()).meta.total).toBe(0);
  });

  it('acota la pagina con limit y offset', async () => {
    const admin = await seedAdmin();
    const { participation } = await seedCatalog();

    await readRegistration(admin.cookie, registrationBody(participation.id));
    await readRegistration(
      admin.cookie,
      registrationBody(participation.id, { documentNumber: '99887766', fullName: 'Luis Gomez' }),
    );

    // El listado es cronologico inverso: el ultimo alta encabeza la primera pagina.
    const newest = await api('/registrations?limit=1&offset=0', admin.cookie);
    const newestPage = await newest.json<RegistrationListResponse>();
    expect(newestPage.meta).toEqual({ total: 2, limit: 1, offset: 0 });
    expect(newestPage.data[0].fullName).toBe('Luis Gomez');

    const response = await api('/registrations?limit=1&offset=1', admin.cookie);
    expect(response.status).toBe(200);
    const page = await response.json<RegistrationListResponse>();

    expect(page.meta).toEqual({ total: 2, limit: 1, offset: 1 });
    expect(page.data).toHaveLength(1);
    expect(page.data[0].fullName).toBe('Ana Perez');
  });

  it('devuelve el registro con sus acompanantes y 404 si no existe', async () => {
    const admin = await seedAdmin();
    const { participation } = await seedCatalog();

    const created = await readRegistration(
      admin.cookie,
      registrationBody(participation.id, {
        companions: [{ fullName: 'Sofia Perez' }],
      }),
    );

    const detail = await api(`/registrations/${created.id}`, admin.cookie);
    expect(detail.status).toBe(200);
    const body = (await detail.json<RegistrationDetailResponse>()).data;
    expect(body.id).toBe(created.id);
    expect(body.companions).toHaveLength(1);
    expect(body.companions[0].fullName).toBe('Sofia Perez');
    expect(body.companions[0].documentNumber).toBeNull();

    const missing = await api(`/registrations/${UNKNOWN_ID}`, admin.cookie);
    expect(missing.status).toBe(404);
    await expect(errorCodeOf(missing)).resolves.toBe('REGISTRATION_NOT_FOUND');
  });
});

describe('cancelacion desde el panel', () => {
  it('cancela, guarda el motivo y libera cupo y documento', async () => {
    const admin = await seedAdmin();
    const { participation } = await seedCatalog({ participation: { titularCapacity: 1 } });
    const created = await readRegistration(admin.cookie, registrationBody(participation.id));

    const cancel = await api(`/registrations/${created.id}/cancel`, admin.cookie, {
      method: 'POST',
      body: JSON.stringify({ reason: 'La persona aviso que no puede asistir.' }),
    });

    expect(cancel.status).toBe(200);
    const cancelled = (await cancel.json<RegistrationResponse>()).data;
    expect(cancelled.status).toBe('cancelled');
    expect(cancelled.cancelledAt).not.toBeNull();
    expect(cancelled.cancelledReason).toBe('La persona aviso que no puede asistir.');

    const capacity = await capacityOf(admin.cookie, participation.id);
    expect(capacity.confirmedTitulares).toBe(0);
    expect(capacity.availableTitulares).toBe(1);

    // El indice unico es parcial: el mismo documento vuelve a tener lugar.
    const again = await postRegistration(admin.cookie, registrationBody(participation.id));
    expect(again.status).toBe(201);
  });

  it('responde 409 si el registro ya estaba cancelado', async () => {
    const admin = await seedAdmin();
    const { participation } = await seedCatalog();
    const created = await readRegistration(admin.cookie, registrationBody(participation.id));
    const cancel = (reason: string): Promise<Response> =>
      api(`/registrations/${created.id}/cancel`, admin.cookie, {
        method: 'POST',
        body: JSON.stringify({ reason }),
      });

    expect((await cancel('Primera cancelacion de la persona.')).status).toBe(200);

    const second = await cancel('Segundo intento sobre el mismo registro.');
    expect(second.status).toBe(409);
    await expect(errorCodeOf(second)).resolves.toBe('REGISTRATION_ALREADY_CANCELLED');
  });

  it('exige el motivo y 404 si el registro no existe', async () => {
    const admin = await seedAdmin();
    const { participation } = await seedCatalog();
    const created = await readRegistration(admin.cookie, registrationBody(participation.id));

    const withoutReason = await api(`/registrations/${created.id}/cancel`, admin.cookie, {
      method: 'POST',
      body: JSON.stringify({}),
    });

    expect(withoutReason.status).toBe(422);
    await expect(errorCodeOf(withoutReason)).resolves.toBe('VALIDATION_ERROR');

    const missing = await api(`/registrations/${UNKNOWN_ID}/cancel`, admin.cookie, {
      method: 'POST',
      body: JSON.stringify({ reason: 'Registro que no existe en la base.' }),
    });

    expect(missing.status).toBe(404);
    await expect(errorCodeOf(missing)).resolves.toBe('REGISTRATION_NOT_FOUND');
  });
});





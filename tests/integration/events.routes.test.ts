import { beforeEach, describe, expect, it } from 'vitest';
import { api, errorCodeOf, seedAdmin, seedOperator } from '../helpers/api';
import { truncateAll } from '../helpers/database';

/**
 * Catalogo de eventos contra la aplicacion completa y D1 real.
 *
 * Se cubre el contrato que consume el panel: la matriz de autorizacion, las
 * validaciones que evitan que una restriccion de SQLite termine en 500 (formato
 * del slug, zona horaria y coherencia de ventanas) y el ciclo de vida de estados.
 */

interface EventBody {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  timezone: string;
  startsAt: string | null;
  endsAt: string | null;
  registrationOpensAt: string | null;
  registrationClosesAt: string | null;
  status: string;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
}

interface EventResponse {
  success: true;
  data: EventBody;
}

interface EventListResponse {
  success: true;
  data: EventBody[];
  meta: { total: number; limit: number; offset: number };
}

beforeEach(truncateAll);

/** Crea un evento por la API y devuelve la ficha creada. */
async function createEvent(cookie: string, body: Record<string, unknown>): Promise<EventBody> {
  const response = await api('/events', cookie, { method: 'POST', body: JSON.stringify(body) });
  expect(response.status).toBe(201);
  return (await response.json<EventResponse>()).data;
}

/** Cambia el estado de un evento y devuelve el codigo HTTP. */
async function patchEvent(
  cookie: string,
  id: string,
  body: Record<string, unknown>,
): Promise<Response> {
  return api(`/events/${id}`, cookie, { method: 'PATCH', body: JSON.stringify(body) });
}

describe('autorizacion del catalogo de eventos', () => {
  it('exige una sesion activa', async () => {
    const response = await api('/events', '');

    expect(response.status).toBe(401);
    await expect(errorCodeOf(response)).resolves.toBe('UNAUTHENTICATED');
  });

  it('deja leer al operador pero no escribir', async () => {
    const operator = await seedOperator();

    const list = await api('/events', operator.cookie);
    expect(list.status).toBe(200);

    const create = await api('/events', operator.cookie, {
      method: 'POST',
      body: JSON.stringify({ slug: 'del-operador', name: 'No permitido' }),
    });
    expect(create.status).toBe(403);
    await expect(errorCodeOf(create)).resolves.toBe('FORBIDDEN');
  });
});

describe('POST /events', () => {
  it('crea el evento en borrador con las fechas en ISO-8601 UTC', async () => {
    const admin = await seedAdmin();

    const event = await createEvent(admin.cookie, {
      slug: 'dia-del-nino',
      name: 'Dia del Nino',
      description: 'Jornada recreativa',
      startsAt: '2026-04-25T15:00:00.000Z',
      registrationOpensAt: '2026-04-01T12:00:00.000Z',
      registrationClosesAt: '2026-04-20T12:00:00.000Z',
    });

    expect(event.status).toBe('draft');
    expect(event.timezone).toBe('America/Bogota');
    expect(event.startsAt).toBe('2026-04-25T15:00:00.000Z');
    expect(event.registrationOpensAt).toBe('2026-04-01T12:00:00.000Z');
    expect(event.endsAt).toBeNull();
    expect(event.createdBy).toBe(admin.id);
  });

  it('rechaza un slug que no cumple el formato', async () => {
    const admin = await seedAdmin();

    const response = await api('/events', admin.cookie, {
      method: 'POST',
      body: JSON.stringify({ slug: 'Dia Del Nino', name: 'Con mayusculas y espacios' }),
    });

    expect(response.status).toBe(422);
    await expect(errorCodeOf(response)).resolves.toBe('VALIDATION_ERROR');
  });

  it('rechaza una zona horaria inexistente', async () => {
    const admin = await seedAdmin();

    const response = await api('/events', admin.cookie, {
      method: 'POST',
      body: JSON.stringify({ slug: 'zona-rara', name: 'Zona rara', timezone: 'Marte/Olympus' }),
    });

    expect(response.status).toBe(422);
    await expect(errorCodeOf(response)).resolves.toBe('VALIDATION_ERROR');
  });

  it('rechaza un cierre de registro anterior a su apertura', async () => {
    const admin = await seedAdmin();

    const response = await api('/events', admin.cookie, {
      method: 'POST',
      body: JSON.stringify({
        slug: 'ventana-invertida',
        name: 'Ventana invertida',
        registrationOpensAt: '2026-04-20T12:00:00.000Z',
        registrationClosesAt: '2026-04-01T12:00:00.000Z',
      }),
    });

    expect(response.status).toBe(422);
    await expect(errorCodeOf(response)).resolves.toBe('VALIDATION_ERROR');
  });

  it('responde EVENT_SLUG_ALREADY_USED si el slug ya existe', async () => {
    const admin = await seedAdmin();
    await createEvent(admin.cookie, { slug: 'feria-2026', name: 'Feria 2026' });

    const response = await api('/events', admin.cookie, {
      method: 'POST',
      body: JSON.stringify({ slug: 'feria-2026', name: 'Feria repetida' }),
    });

    expect(response.status).toBe(409);
    await expect(errorCodeOf(response)).resolves.toBe('EVENT_SLUG_ALREADY_USED');
  });

  it('no permite nacer en un estado que no sea alcanzable', async () => {
    const admin = await seedAdmin();

    const response = await api('/events', admin.cookie, {
      method: 'POST',
      body: JSON.stringify({ slug: 'nacido-cerrado', name: 'Nacido cerrado', status: 'closed' }),
    });

    expect(response.status).toBe(409);
    await expect(errorCodeOf(response)).resolves.toBe('STATUS_TRANSITION_INVALID');
  });
});

describe('GET /events', () => {
  it('lista con filtros, busqueda y paginacion', async () => {
    const admin = await seedAdmin();
    await createEvent(admin.cookie, {
      slug: 'feria-norte',
      name: 'Feria Norte',
      status: 'published',
    });
    await createEvent(admin.cookie, {
      slug: 'feria-sur',
      name: 'Feria Sur',
      status: 'published',
    });
    await createEvent(admin.cookie, { slug: 'borrador-interno', name: 'Borrador' });

    const published = await api('/events?status=published', admin.cookie);
    expect(published.status).toBe(200);
    const publishedBody = await published.json<EventListResponse>();
    expect(publishedBody.data).toHaveLength(2);
    expect(publishedBody.meta.total).toBe(2);
    expect(publishedBody.data.every((item) => item.status === 'published')).toBe(true);

    const searched = await api('/events?search=borrador', admin.cookie);
    const searchedBody = await searched.json<EventListResponse>();
    expect(searchedBody.meta.total).toBe(1);
    expect(searchedBody.data[0]?.slug).toBe('borrador-interno');

    const page = await api('/events?limit=1&offset=1', admin.cookie);
    const pageBody = await page.json<EventListResponse>();
    expect(pageBody.data).toHaveLength(1);
    expect(pageBody.meta).toEqual({ total: 3, limit: 1, offset: 1 });
  });
});

describe('GET /events/{idOrSlug}', () => {
  it('acepta el identificador o el slug', async () => {
    const admin = await seedAdmin();
    const event = await createEvent(admin.cookie, { slug: 'dia-de-la-madre', name: 'Dia madre' });

    const byId = await api(`/events/${event.id}`, admin.cookie);
    expect(byId.status).toBe(200);
    const byIdBody = await byId.json<EventResponse>();
    expect(byIdBody.data.slug).toBe('dia-de-la-madre');

    const bySlug = await api('/events/dia-de-la-madre', admin.cookie);
    expect(bySlug.status).toBe(200);
    const bySlugBody = await bySlug.json<EventResponse>();
    expect(bySlugBody.data.id).toBe(event.id);
  });

  it('responde EVENT_NOT_FOUND si el evento no existe', async () => {
    const admin = await seedAdmin();

    const response = await api('/events/no-existe', admin.cookie);

    expect(response.status).toBe(404);
    await expect(errorCodeOf(response)).resolves.toBe('EVENT_NOT_FOUND');
  });
});

describe('PATCH /events/{id}', () => {
  it('actualiza solo los campos enviados', async () => {
    const admin = await seedAdmin();
    const event = await createEvent(admin.cookie, {
      slug: 'actualizable',
      name: 'Nombre original',
      description: 'Descripcion original',
    });

    const response = await patchEvent(admin.cookie, event.id, { name: 'Nombre nuevo' });

    expect(response.status).toBe(200);
    const body = await response.json<EventResponse>();
    expect(body.data.name).toBe('Nombre nuevo');
    expect(body.data.description).toBe('Descripcion original');
    expect(body.data.slug).toBe('actualizable');
  });

  it('recorre el ciclo de vida y bloquea los saltos no permitidos', async () => {
    const admin = await seedAdmin();
    const event = await createEvent(admin.cookie, { slug: 'ciclo-de-vida', name: 'Ciclo' });

    for (const status of ['published', 'closed', 'published', 'archived']) {
      const response = await patchEvent(admin.cookie, event.id, { status });
      expect(response.status).toBe(200);
    }

    const rejected = await patchEvent(admin.cookie, event.id, { status: 'published' });
    expect(rejected.status).toBe(409);
    await expect(errorCodeOf(rejected)).resolves.toBe('STATUS_TRANSITION_INVALID');
  });

  it('no permite cambiar el slug', async () => {
    const admin = await seedAdmin();
    const event = await createEvent(admin.cookie, { slug: 'slug-fijo', name: 'Slug fijo' });

    const response = await patchEvent(admin.cookie, event.id, { slug: 'slug-nuevo' });

    expect(response.status).toBe(422);
    await expect(errorCodeOf(response)).resolves.toBe('VALIDATION_ERROR');
  });

  it('valida la ventana sobre el resultado combinado', async () => {
    const admin = await seedAdmin();
    const event = await createEvent(admin.cookie, {
      slug: 'ventana-combinada',
      name: 'Ventana',
      startsAt: '2026-04-25T15:00:00.000Z',
    });

    // El `endsAt` es anterior al `startsAt` ya almacenado: la incoherencia la
    // provoca la combinacion, no el cuerpo por si solo.
    const response = await patchEvent(admin.cookie, event.id, {
      endsAt: '2026-04-24T15:00:00.000Z',
    });

    expect(response.status).toBe(422);
    await expect(errorCodeOf(response)).resolves.toBe('VALIDATION_ERROR');
  });

  it('borra una fecha con `null`', async () => {
    const admin = await seedAdmin();
    const event = await createEvent(admin.cookie, {
      slug: 'con-descripcion',
      name: 'Con descripcion',
      description: 'Se va a borrar',
    });

    const response = await patchEvent(admin.cookie, event.id, { description: null });

    expect(response.status).toBe(200);
    const body = await response.json<EventResponse>();
    expect(body.data.description).toBeNull();
  });

  it('responde EVENT_NOT_FOUND si el evento no existe', async () => {
    const admin = await seedAdmin();

    const response = await patchEvent(
      admin.cookie,
      '00000000-0000-4000-8000-000000000000',
      { name: 'Fantasma' },
    );

    expect(response.status).toBe(404);
    await expect(errorCodeOf(response)).resolves.toBe('EVENT_NOT_FOUND');
  });
});

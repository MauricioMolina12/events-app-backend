import { beforeEach, describe, expect, it } from 'vitest';
import { api, errorCodeOf, seedAdmin, seedOperator } from '../helpers/api';
import { truncateAll } from '../helpers/database';

/**
 * Catalogo de sedes contra la aplicacion completa y D1 real.
 *
 * Cubre la matriz de autorizacion, el formato del codigo, la inmutabilidad del
 * codigo y el filtrado del listado.
 */

interface EstablishmentBody {
  id: string;
  code: string;
  name: string;
  city: string | null;
  address: string | null;
  status: string;
  createdAt: string;
  updatedAt: string;
}

interface EstablishmentResponse {
  success: true;
  data: EstablishmentBody;
}

interface EstablishmentListResponse {
  success: true;
  data: EstablishmentBody[];
  meta: { total: number; limit: number; offset: number };
}

beforeEach(truncateAll);

/** Crea una sede por la API y devuelve la ficha creada. */
async function createEstablishment(
  cookie: string,
  body: Record<string, unknown>,
): Promise<EstablishmentBody> {
  const response = await api('/establishments', cookie, {
    method: 'POST',
    body: JSON.stringify(body),
  });
  expect(response.status).toBe(201);
  return (await response.json<EstablishmentResponse>()).data;
}

describe('autorizacion del catalogo de sedes', () => {
  it('exige una sesion activa', async () => {
    const response = await api('/establishments', '');

    expect(response.status).toBe(401);
    await expect(errorCodeOf(response)).resolves.toBe('UNAUTHENTICATED');
  });

  it('deja leer al operador pero no escribir', async () => {
    const operator = await seedOperator();

    const list = await api('/establishments', operator.cookie);
    expect(list.status).toBe(200);

    const create = await api('/establishments', operator.cookie, {
      method: 'POST',
      body: JSON.stringify({ code: 'sede-prohibida', name: 'No permitida' }),
    });
    expect(create.status).toBe(403);
    await expect(errorCodeOf(create)).resolves.toBe('FORBIDDEN');
  });
});

describe('POST /establishments', () => {
  it('crea la sede activa', async () => {
    const admin = await seedAdmin();

    const establishment = await createEstablishment(admin.cookie, {
      code: 'sede-norte',
      name: 'Sede Norte',
      city: 'Bogota',
      address: 'Calle 100 # 15-20',
    });

    expect(establishment.code).toBe('sede-norte');
    expect(establishment.status).toBe('active');
    expect(establishment.city).toBe('Bogota');
  });

  it('rechaza un codigo que no cumple el formato', async () => {
    const admin = await seedAdmin();

    const response = await api('/establishments', admin.cookie, {
      method: 'POST',
      body: JSON.stringify({ code: 'Sede Norte', name: 'Con espacios' }),
    });

    expect(response.status).toBe(422);
    await expect(errorCodeOf(response)).resolves.toBe('VALIDATION_ERROR');
  });

  it('responde ESTABLISHMENT_CODE_ALREADY_USED si el codigo ya existe', async () => {
    const admin = await seedAdmin();
    await createEstablishment(admin.cookie, { code: 'sede-sur', name: 'Sede Sur' });

    const response = await api('/establishments', admin.cookie, {
      method: 'POST',
      body: JSON.stringify({ code: 'sede-sur', name: 'Sede repetida' }),
    });

    expect(response.status).toBe(409);
    await expect(errorCodeOf(response)).resolves.toBe('ESTABLISHMENT_CODE_ALREADY_USED');
  });
});

describe('GET /establishments', () => {
  it('lista con filtros, busqueda y paginacion', async () => {
    const admin = await seedAdmin();
    await createEstablishment(admin.cookie, {
      code: 'sede-alfa',
      name: 'Alfa',
      city: 'Bogota',
    });
    await createEstablishment(admin.cookie, { code: 'sede-zeta', name: 'Zeta', city: 'Cali' });
    await createEstablishment(admin.cookie, {
      code: 'sede-inactiva',
      name: 'Inactiva',
      city: 'Medellin',
      status: 'inactive',
    });

    const active = await api('/establishments?status=active', admin.cookie);
    expect(active.status).toBe(200);
    const activeBody = await active.json<EstablishmentListResponse>();
    expect(activeBody.meta.total).toBe(2);
    expect(activeBody.data.map((item) => item.code)).toEqual(['sede-alfa', 'sede-zeta']);

    const searched = await api('/establishments?search=medellin', admin.cookie);
    const searchedBody = await searched.json<EstablishmentListResponse>();
    expect(searchedBody.meta.total).toBe(1);
    expect(searchedBody.data[0]?.code).toBe('sede-inactiva');

    const page = await api('/establishments?limit=2&offset=2', admin.cookie);
    const pageBody = await page.json<EstablishmentListResponse>();
    expect(pageBody.data).toHaveLength(1);
    expect(pageBody.meta).toEqual({ total: 3, limit: 2, offset: 2 });
  });
});

describe('GET /establishments/{id}', () => {
  it('devuelve la sede y responde ESTABLISHMENT_NOT_FOUND si no existe', async () => {
    const admin = await seedAdmin();
    const establishment = await createEstablishment(admin.cookie, {
      code: 'sede-centro',
      name: 'Sede Centro',
    });

    const found = await api(`/establishments/${establishment.id}`, admin.cookie);
    expect(found.status).toBe(200);
    const foundBody = await found.json<EstablishmentResponse>();
    expect(foundBody.data.code).toBe('sede-centro');

    const missing = await api('/establishments/no-existe', admin.cookie);
    expect(missing.status).toBe(404);
    await expect(errorCodeOf(missing)).resolves.toBe('ESTABLISHMENT_NOT_FOUND');
  });
});

describe('PATCH /establishments/{id}', () => {
  it('actualiza los campos enviados y no toca el codigo', async () => {
    const admin = await seedAdmin();
    const establishment = await createEstablishment(admin.cookie, {
      code: 'sede-editable',
      name: 'Nombre original',
      city: 'Bogota',
    });

    const response = await api(`/establishments/${establishment.id}`, admin.cookie, {
      method: 'PATCH',
      body: JSON.stringify({ name: 'Nombre nuevo', status: 'inactive' }),
    });

    expect(response.status).toBe(200);
    const body = await response.json<EstablishmentResponse>();
    expect(body.data.name).toBe('Nombre nuevo');
    expect(body.data.status).toBe('inactive');
    expect(body.data.city).toBe('Bogota');
    expect(body.data.code).toBe('sede-editable');
  });

  it('no permite cambiar el codigo', async () => {
    const admin = await seedAdmin();
    const establishment = await createEstablishment(admin.cookie, {
      code: 'codigo-fijo',
      name: 'Codigo fijo',
    });

    const response = await api(`/establishments/${establishment.id}`, admin.cookie, {
      method: 'PATCH',
      body: JSON.stringify({ code: 'codigo-nuevo' }),
    });

    expect(response.status).toBe(422);
    await expect(errorCodeOf(response)).resolves.toBe('VALIDATION_ERROR');
  });

  it('responde ESTABLISHMENT_NOT_FOUND si la sede no existe', async () => {
    const admin = await seedAdmin();

    const response = await api(
      '/establishments/00000000-0000-4000-8000-000000000000',
      admin.cookie,
      { method: 'PATCH', body: JSON.stringify({ name: 'Fantasma' }) },
    );

    expect(response.status).toBe(404);
    await expect(errorCodeOf(response)).resolves.toBe('ESTABLISHMENT_NOT_FOUND');
  });
});

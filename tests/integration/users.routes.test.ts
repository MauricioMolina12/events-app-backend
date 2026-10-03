import { SELF } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { OPERATOR_PASSWORD, api, errorCodeOf, seedAdmin, seedOperator } from '../helpers/api';
import { loginAs, loginRequest, createTestUser } from '../helpers/auth';
import { truncateAll } from '../helpers/database';

/**
 * Rutas administrativas de cuentas contra la aplicacion completa y D1 real.
 *
 * Se cubre el contrato que consume el panel: la matriz de autorizacion, la
 * paginacion del listado, la proteccion del ultimo administrador y el efecto de
 * la desactivacion y de la rotacion de contrasena sobre las sesiones.
 */

const NEW_PASSWORD = 'contrasena-rotada-1';

interface ErrorBody {
  success: false;
  error: { code: string; message: string };
}

interface AdminUserBody {
  id: string;
  email: string;
  fullName: string;
  role: string;
  status: string;
  failedLoginAttempts: number;
  lockedUntil: string | null;
  lastLoginAt: string | null;
  createdAt: string;
  updatedAt: string;
}

interface UserBody {
  success: true;
  data: AdminUserBody;
}

interface UserListBody {
  success: true;
  data: AdminUserBody[];
  meta: { total: number; limit: number; offset: number };
}

interface PasswordResetBody {
  success: true;
  data: { user: AdminUserBody; revokedSessions: number };
}

beforeEach(truncateAll);

describe('autorizacion del modulo de usuarios', () => {
  it('exige una sesion activa', async () => {
    const response = await SELF.fetch('https://example.com/api/v1/users');

    expect(response.status).toBe(401);
    await expect(errorCodeOf(response)).resolves.toBe('UNAUTHENTICATED');
  });

  it('reserva el listado y el alta a los administradores', async () => {
    const operator = await seedOperator();

    const list = await api('/users', operator.cookie);
    expect(list.status).toBe(403);
    await expect(errorCodeOf(list)).resolves.toBe('FORBIDDEN');

    const create = await api('/users', operator.cookie, {
      method: 'POST',
      body: JSON.stringify({
        email: 'nuevo@example.com',
        fullName: 'Nuevo Operador',
        password: NEW_PASSWORD,
      }),
    });
    expect(create.status).toBe(403);
    await expect(errorCodeOf(create)).resolves.toBe('FORBIDDEN');
  });
});

describe('GET /users', () => {
  it('lista las cuentas con el total de las filas filtradas', async () => {
    const admin = await seedAdmin();
    await seedOperator();

    const response = await api('/users?limit=1', admin.cookie);

    expect(response.status).toBe(200);
    const body = await response.json<UserListBody>();
    expect(body.data).toHaveLength(1);
    // `meta.total` cuenta las filas que cumplen los filtros, no la pagina.
    expect(body.meta).toEqual({ total: 2, limit: 1, offset: 0 });

    const [first] = body.data;
    expect(first?.email).toBeTruthy();
    expect(first).not.toHaveProperty('passwordHash');
    expect(first).not.toHaveProperty('passwordSalt');
    expect(JSON.stringify(body)).not.toContain('password');
  });

  it('pagina con offset sin repetir filas', async () => {
    const admin = await seedAdmin();
    await seedOperator('operador.uno@example.com', 'Operador Uno');
    await seedOperator('operador.dos@example.com', 'Operador Dos');

    const firstPage = await api('/users?limit=2&offset=0', admin.cookie);
    const secondPage = await api('/users?limit=2&offset=2', admin.cookie);

    const first = await firstPage.json<UserListBody>();
    const second = await secondPage.json<UserListBody>();

    expect(first.data).toHaveLength(2);
    expect(second.data).toHaveLength(1);
    expect(second.meta).toEqual({ total: 3, limit: 2, offset: 2 });

    const firstIds = first.data.map((user) => user.id);
    const secondIds = second.data.map((user) => user.id);
    expect(firstIds.some((id) => secondIds.includes(id))).toBe(false);
  });

  it('filtra por rol, estado y texto libre', async () => {
    const admin = await seedAdmin();
    await seedOperator('ana.torres@example.com', 'Ana Torres');
    await createTestUser({
      email: 'beto.ruiz@example.com',
      password: OPERATOR_PASSWORD,
      fullName: 'Beto Ruiz',
      role: 'operator',
      status: 'disabled',
    });

    const operators = await (await api('/users?role=operator', admin.cookie)).json<UserListBody>();
    expect(operators.meta.total).toBe(2);

    const disabled = await (await api('/users?status=disabled', admin.cookie)).json<UserListBody>();
    expect(disabled.data.map((user) => user.email)).toEqual(['beto.ruiz@example.com']);

    // La busqueda ignora mayusculas y alcanza al nombre, no solo al email.
    const search = await (await api('/users?search=tOrReS', admin.cookie)).json<UserListBody>();
    expect(search.data.map((user) => user.fullName)).toEqual(['Ana Torres']);
  });
});

describe('POST /users', () => {
  it('crea una cuenta capaz de iniciar sesion, con el email normalizado', async () => {
    const admin = await seedAdmin();

    const response = await api('/users', admin.cookie, {
      method: 'POST',
      body: JSON.stringify({
        email: 'Nuevo.Operador@Example.com',
        fullName: 'Nuevo Operador',
        password: NEW_PASSWORD,
      }),
    });

    expect(response.status).toBe(201);
    const body = await response.json<UserBody>();
    expect(body.data).toMatchObject({
      email: 'nuevo.operador@example.com',
      fullName: 'Nuevo Operador',
      role: 'operator',
      status: 'active',
      failedLoginAttempts: 0,
      lastLoginAt: null,
    });
    expect(JSON.stringify(body)).not.toContain('password');

    // El digest se deriva con la configuracion del Worker: el login lo demuestra.
    await expect(loginAs('nuevo.operador@example.com', NEW_PASSWORD)).resolves.toContain(
      'events_session=',
    );
  });

  it('rechaza un email ya registrado, sin importar las mayusculas', async () => {
    const admin = await seedAdmin('admin@example.com');

    const response = await api('/users', admin.cookie, {
      method: 'POST',
      body: JSON.stringify({
        email: 'ADMIN@Example.com',
        fullName: 'Administrador Duplicado',
        password: NEW_PASSWORD,
      }),
    });

    expect(response.status).toBe(409);
    await expect(errorCodeOf(response)).resolves.toBe('EMAIL_ALREADY_USED');
  });

  it('rechaza una contrasena que no cumple la politica', async () => {
    const admin = await seedAdmin();

    const response = await api('/users', admin.cookie, {
      method: 'POST',
      body: JSON.stringify({
        email: 'corta@example.com',
        fullName: 'Contrasena Corta',
        password: 'corta-1',
      }),
    });

    expect(response.status).toBe(422);
    await expect(errorCodeOf(response)).resolves.toBe('VALIDATION_ERROR');
  });
});

describe('GET /users/{id}', () => {
  it('devuelve la ficha administrativa', async () => {
    const admin = await seedAdmin();
    const operator = await seedOperator();

    const response = await api(`/users/${operator.id}`, admin.cookie);

    expect(response.status).toBe(200);
    const body = await response.json<UserBody>();
    expect(body.data).toMatchObject({
      id: operator.id,
      email: 'operador@example.com',
      role: 'operator',
      status: 'active',
      lockedUntil: null,
    });
    expect(body.data.createdAt).toMatch(/Z$/u);
  });

  it('responde USER_NOT_FOUND si la cuenta no existe', async () => {
    const admin = await seedAdmin();

    const response = await api('/users/00000000-0000-4000-8000-000000000000', admin.cookie);

    expect(response.status).toBe(404);
    await expect(errorCodeOf(response)).resolves.toBe('USER_NOT_FOUND');
  });
});

describe('PATCH /users/{id}', () => {
  it('actualiza el nombre y el rol', async () => {
    const admin = await seedAdmin();
    const operator = await seedOperator();

    const response = await api(`/users/${operator.id}`, admin.cookie, {
      method: 'PATCH',
      body: JSON.stringify({ fullName: '  Operador Renombrado  ', role: 'admin' }),
    });

    expect(response.status).toBe(200);
    const body = await response.json<UserBody>();
    expect(body.data.fullName).toBe('Operador Renombrado');
    expect(body.data.role).toBe('admin');
  });

  it('rechaza el cambio que dejaria el sistema sin administradores', async () => {
    const admin = await seedAdmin();

    const demote = await api(`/users/${admin.id}`, admin.cookie, {
      method: 'PATCH',
      body: JSON.stringify({ role: 'operator' }),
    });
    expect(demote.status).toBe(409);
    await expect(errorCodeOf(demote)).resolves.toBe('LAST_ADMIN_PROTECTED');

    const disable = await api(`/users/${admin.id}`, admin.cookie, {
      method: 'PATCH',
      body: JSON.stringify({ status: 'disabled' }),
    });
    expect(disable.status).toBe(409);
    await expect(errorCodeOf(disable)).resolves.toBe('LAST_ADMIN_PROTECTED');

    // El rechazo no dejo efectos: la sesion y el rol siguen intactos.
    const me = await api('/auth/me', admin.cookie);
    expect(me.status).toBe(200);
  });

  it('permite degradarse cuando queda otro administrador', async () => {
    const admin = await seedAdmin('admin@example.com');
    await seedAdmin('admin.dos@example.com');

    const response = await api(`/users/${admin.id}`, admin.cookie, {
      method: 'PATCH',
      body: JSON.stringify({ role: 'operator' }),
    });

    expect(response.status).toBe(200);
    const body = await response.json<UserBody>();
    expect(body.data.role).toBe('operator');

    // El rol se lee de la base en cada peticion: el guard reacciona sin tocar la sesion.
    const list = await api('/users', admin.cookie);
    expect(list.status).toBe(403);
  });

  it('rechaza un email ya en uso', async () => {
    const admin = await seedAdmin('admin@example.com');
    const operator = await seedOperator('operador@example.com');

    const response = await api(`/users/${operator.id}`, admin.cookie, {
      method: 'PATCH',
      body: JSON.stringify({ email: 'admin@example.com' }),
    });

    expect(response.status).toBe(409);
    await expect(errorCodeOf(response)).resolves.toBe('EMAIL_ALREADY_USED');
  });

  it('revoca las sesiones al desactivar la cuenta', async () => {
    const admin = await seedAdmin();
    const operator = await seedOperator();

    const response = await api(`/users/${operator.id}`, admin.cookie, {
      method: 'PATCH',
      body: JSON.stringify({ status: 'disabled' }),
    });

    expect(response.status).toBe(200);
    const body = await response.json<UserBody>();
    expect(body.data.status).toBe('disabled');

    const me = await api('/auth/me', operator.cookie);
    expect(me.status).toBe(401);
    await expect(errorCodeOf(me)).resolves.toBe('SESSION_REVOKED');
  });

  it('responde USER_NOT_FOUND si la cuenta no existe', async () => {
    const admin = await seedAdmin();

    const response = await api('/users/00000000-0000-4000-8000-000000000000', admin.cookie, {
      method: 'PATCH',
      body: JSON.stringify({ fullName: 'Fantasma' }),
    });

    expect(response.status).toBe(404);
    await expect(errorCodeOf(response)).resolves.toBe('USER_NOT_FOUND');
  });
});

describe('POST /users/{id}/password', () => {
  it('rota la contrasena y revoca las sesiones de la cuenta', async () => {
    const admin = await seedAdmin();
    const operator = await seedOperator();

    const response = await api(`/users/${operator.id}/password`, admin.cookie, {
      method: 'POST',
      body: JSON.stringify({ password: NEW_PASSWORD }),
    });

    expect(response.status).toBe(200);
    const body = await response.json<PasswordResetBody>();
    expect(body.data.revokedSessions).toBe(1);
    expect(body.data.user.failedLoginAttempts).toBe(0);
    expect(body.data.user.lockedUntil).toBeNull();

    // La cookie anterior deja de servir de inmediato.
    const me = await api('/auth/me', operator.cookie);
    expect(me.status).toBe(401);
    await expect(errorCodeOf(me)).resolves.toBe('SESSION_REVOKED');

    const previous = await loginRequest('operador@example.com', OPERATOR_PASSWORD);
    expect(previous.status).toBe(401);
    await expect(errorCodeOf(previous)).resolves.toBe('INVALID_CREDENTIALS');

    await expect(loginAs('operador@example.com', NEW_PASSWORD)).resolves.toContain(
      'events_session=',
    );
  });

  it('rechaza una contrasena que no cumple la politica', async () => {
    const admin = await seedAdmin();
    const operator = await seedOperator();

    const response = await api(`/users/${operator.id}/password`, admin.cookie, {
      method: 'POST',
      body: JSON.stringify({ password: 'corta-1' }),
    });

    expect(response.status).toBe(422);
    await expect(errorCodeOf(response)).resolves.toBe('VALIDATION_ERROR');
  });

  it('responde USER_NOT_FOUND si la cuenta no existe', async () => {
    const admin = await seedAdmin();

    const response = await api(
      '/users/00000000-0000-4000-8000-000000000000/password',
      admin.cookie,
      { method: 'POST', body: JSON.stringify({ password: NEW_PASSWORD }) },
    );

    expect(response.status).toBe(404);
    await expect(errorCodeOf(response)).resolves.toBe('USER_NOT_FOUND');
  });
});


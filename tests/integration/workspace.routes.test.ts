import { SELF } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { api, errorCodeOf, seedAdmin, seedOperator } from '../helpers/api';
import { truncateAll } from '../helpers/database';

beforeEach(truncateAll);

describe('identidad del espacio', () => {
  it('sugiere el nombre del primer administrador y no lo recalcula', async () => {
    await seedAdmin('mauricio.molina@gmail.com');
    const first = await SELF.fetch('https://example.com/api/v1/workspace');
    expect(first.status).toBe(200);
    const created = await first.json<{
      data: { displayName: string; nameCustomized: boolean };
    }>();
    expect(created.data.displayName).toBe('Mauricio Molina');
    expect(created.data.nameCustomized).toBe(false);

    await seedAdmin('ventas-corporativas@empresa.com');
    const second = await SELF.fetch('https://example.com/api/v1/workspace');
    const again = await second.json<{ data: { displayName: string } }>();
    expect(again.data.displayName).toBe('Mauricio Molina');
  });

  it('exige administrador para guardar y no pisa un nombre ya personalizado', async () => {
    const admin = await seedAdmin('soporte@barbytoys.com');
    const operator = await seedOperator();

    const anonymous = await api('/workspace', '', {
      method: 'PATCH',
      body: JSON.stringify({ displayName: 'Ajeno' }),
    });
    expect(anonymous.status).toBe(401);

    const forbidden = await api('/workspace', operator.cookie, {
      method: 'PATCH',
      body: JSON.stringify({ displayName: 'Ajeno' }),
    });
    expect(forbidden.status).toBe(403);
    expect(await errorCodeOf(forbidden)).toBe('FORBIDDEN');

    const saved = await api('/workspace', admin.cookie, {
      method: 'PATCH',
      body: JSON.stringify({
        displayName: 'Barby Toys',
        description: 'Registro de eventos',
        primaryColor: '#112233',
      }),
    });
    expect(saved.status).toBe(200);
    const body = await saved.json<{
      data: { displayName: string; description: string; primaryColor: string; nameCustomized: boolean; colorCustomized: boolean };
    }>();
    expect(body.data).toMatchObject({
      displayName: 'Barby Toys',
      description: 'Registro de eventos',
      primaryColor: '#112233',
      nameCustomized: true,
      colorCustomized: true,
    });

    const reread = await SELF.fetch('https://example.com/api/v1/workspace');
    const persisted = await reread.json<{ data: { displayName: string } }>();
    expect(persisted.data.displayName).toBe('Barby Toys');
  });

  it('rechaza colores que no son hexadecimales', async () => {
    const admin = await seedAdmin();
    const response = await api('/workspace', admin.cookie, {
      method: 'PATCH',
      body: JSON.stringify({ primaryColor: 'red' }),
    });
    expect(response.status).toBe(422);
    expect(await errorCodeOf(response)).toBe('VALIDATION_ERROR');
  });

  it('guarda el tema por cuenta y no lo comparte', async () => {
    const admin = await seedAdmin();
    const operator = await seedOperator();

    const missing = await api('/me/preferences', operator.cookie);
    expect(missing.status).toBe(200);
    expect(await missing.json()).toMatchObject({ data: { theme: 'system', persisted: false } });

    const saved = await api('/me/preferences', admin.cookie, {
      method: 'PATCH',
      body: JSON.stringify({ theme: 'dark' }),
    });
    expect(saved.status).toBe(200);

    const operatorStill = await api('/me/preferences', operator.cookie);
    expect(await operatorStill.json()).toMatchObject({ data: { persisted: false } });
    const adminAgain = await api('/me/preferences', admin.cookie);
    expect(await adminAgain.json()).toMatchObject({ data: { theme: 'dark', persisted: true } });
  });

  it('restaurar la identidad no borra cuentas', async () => {
    const admin = await seedAdmin('mauricio.molina@gmail.com');
    await api('/workspace', admin.cookie, {
      method: 'PATCH',
      body: JSON.stringify({ displayName: 'Nombre manual' }),
    });

    const restored = await api('/workspace/restore', admin.cookie, { method: 'POST' });
    expect(restored.status).toBe(200);
    const body = await restored.json<{
      data: { displayName: string; nameCustomized: boolean; colorCustomized: boolean };
    }>();
    expect(body.data.displayName).toBe('Mauricio Molina');
    expect(body.data.nameCustomized).toBe(false);
    expect(body.data.colorCustomized).toBe(false);

    const me = await api('/auth/me', admin.cookie);
    expect(me.status).toBe(200);
  });
});

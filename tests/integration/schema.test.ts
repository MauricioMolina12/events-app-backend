import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { countRows, truncateAll } from '../helpers/database';

/**
 * Comprueba que las migraciones de `migrations/` (aplicadas por el setup) crean el
 * esquema completo y que las restricciones que sostienen los invariantes estan
 * realmente activas.
 *
 * Aqui se usa SQL crudo a proposito: no se prueba el codigo de la aplicacion,
 * sino la base de datos.
 */

const EXPECTED_TABLES = [
  'auth_attempts',
  'capacity_adjustments',
  'd1_migrations',
  'establishments',
  'event_establishments',
  'events',
  'qr_codes',
  'qr_deliveries',
  'registration_companions',
  'registrations',
  'sessions',
  'shift_assignments',
  'shifts',
] as const;

/** Indices que solo valen si son parciales: si perdieran el `WHERE`, el invariante caeria. */
const EXPECTED_PARTIAL_INDEXES = [
  'capacity_adjustments_participation_pending_unique',
  'qr_codes_active_per_registration_unique',
  'registration_companions_document_unique',
  'registrations_participation_document_unique',
  'shift_assignments_registration_active_unique',
] as const;

/** Epoch en milisegundos, igual que escribe la aplicacion. */
const NOW = 1_760_000_000_000;

interface SchemaObject {
  name: string;
  sql: string | null;
}

async function listSchemaObjects(type: 'table' | 'index'): Promise<SchemaObject[]> {
  const { results } = await env.DB.prepare(
    "SELECT name, sql FROM sqlite_master WHERE type = ? AND name NOT LIKE 'sqlite_%' ORDER BY name",
  )
    .bind(type)
    .all<SchemaObject>();

  return results;
}

/** Inserta un evento, una sede y su participacion con SQL crudo. */
async function seedCatalog(
  options: { titularCapacity?: number; companionCapacity?: number } = {},
): Promise<{ participationId: string }> {
  await env.DB.batch([
    env.DB.prepare(
      'INSERT INTO events (id, slug, name, timezone, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).bind('evt-1', 'evt-1', 'Evento de prueba', 'America/Bogota', 'published', NOW, NOW),
    env.DB.prepare(
      'INSERT INTO establishments (id, code, name, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
    ).bind('est-1', 'est-1', 'Sede 1', 'active', NOW, NOW),
    env.DB.prepare(
      'INSERT INTO event_establishments (id, event_id, establishment_id, status, titular_capacity, companion_capacity, confirmed_titulares, confirmed_companions, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 0, 0, ?, ?)',
    ).bind(
      'part-1',
      'evt-1',
      'est-1',
      'open',
      options.titularCapacity ?? 2,
      options.companionCapacity ?? 2,
      NOW,
      NOW,
    ),
  ]);

  return { participationId: 'part-1' };
}

/** Registro minimo, sin acompanantes. */
async function insertRegistration(participationId: string, id = 'reg-1'): Promise<string> {
  await env.DB.prepare(
    'INSERT INTO registrations (id, participation_id, document_type, document_number, full_name, companions_count, status, source, registered_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?)',
  )
    .bind(id, participationId, 'CC', '100', 'Titular', 'confirmed', 'admin', NOW, NOW, NOW)
    .run();

  return id;
}

beforeEach(truncateAll);

describe('esquema en D1', () => {
  it('crea todas las tablas del modelo de datos', async () => {
    const tables = (await listSchemaObjects('table')).map((row) => row.name);

    for (const expected of EXPECTED_TABLES) {
      expect(tables).toContain(expected);
    }
  });

  it('deja constancia de la migracion aplicada', async () => {
    expect(await countRows('d1_migrations')).toBeGreaterThan(0);
  });

  it('declara los indices de invariantes como parciales', async () => {
    const indexes = await listSchemaObjects('index');

    for (const name of EXPECTED_PARTIAL_INDEXES) {
      const index = indexes.find((row) => row.name === name);
      expect(index, `falta el indice ${name}`).toBeDefined();
      expect(index?.sql ?? '', `el indice ${name} no es parcial`).toContain('WHERE');
    }
  });

  it('limita los predicados de los indices parciales al caso que protegen', async () => {
    const indexes = await listSchemaObjects('index');
    const document = indexes.find(
      (row) => row.name === 'registrations_participation_document_unique',
    );
    const qr = indexes.find((row) => row.name === 'qr_codes_active_per_registration_unique');

    // Cancelar libera el documento: el indice debe ignorar los cancelados.
    expect(document?.sql ?? '').toContain('cancelled');
    // Una QR revocada no cuenta: el indice solo mira las activas.
    expect(qr?.sql ?? '').toContain('active');
  });
});

describe('restricciones activas en la base de datos', () => {
  it('rechaza un cupo confirmado por encima de la capacidad', async () => {
    await seedCatalog({ titularCapacity: 1 });

    await expect(
      env.DB.prepare('UPDATE event_establishments SET confirmed_titulares = 2 WHERE id = ?')
        .bind('part-1')
        .run(),
    ).rejects.toThrow(/event_establishments_titular_capacity_check/);
  });

  it('impide dos participaciones del mismo establecimiento en el mismo evento', async () => {
    await seedCatalog();

    await expect(
      env.DB.prepare(
        "INSERT INTO event_establishments (id, event_id, establishment_id, status, titular_capacity, companion_capacity, confirmed_titulares, confirmed_companions, created_at, updated_at) VALUES ('part-2', 'evt-1', 'est-1', 'open', 1, 1, 0, 0, ?, ?)",
      )
        .bind(NOW, NOW)
        .run(),
    ).rejects.toThrow(/UNIQUE constraint failed/);
  });

  it('exige que la participacion apunte a un evento existente', async () => {
    await expect(
      env.DB.prepare(
        "INSERT INTO event_establishments (id, event_id, establishment_id, status, titular_capacity, companion_capacity, confirmed_titulares, confirmed_companions, created_at, updated_at) VALUES ('part-9', 'evt-inexistente', 'est-1', 'open', 1, 1, 0, 0, ?, ?)",
      )
        .bind(NOW, NOW)
        .run(),
    ).rejects.toThrow(/FOREIGN KEY constraint failed/);
  });

  it('protege las sedes con participaciones frente al borrado', async () => {
    await seedCatalog();

    await expect(
      env.DB.prepare('DELETE FROM establishments WHERE id = ?').bind('est-1').run(),
    ).rejects.toThrow(/FOREIGN KEY constraint failed/);
  });

  it('borra los acompanantes en cascada con su registro', async () => {
    const { participationId } = await seedCatalog();

    await env.DB.batch([
      env.DB.prepare(
        'INSERT INTO registrations (id, participation_id, document_type, document_number, full_name, companions_count, status, source, registered_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?)',
      ).bind('reg-1', participationId, 'CC', '100', 'Titular', 'confirmed', 'admin', NOW, NOW, NOW),
      env.DB.prepare(
        'INSERT INTO registration_companions (id, registration_id, full_name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
      ).bind('comp-1', 'reg-1', 'Acompanante', NOW, NOW),
    ]);

    expect(await countRows('registration_companions')).toBe(1);

    await env.DB.prepare('DELETE FROM registrations WHERE id = ?').bind('reg-1').run();

    expect(await countRows('registration_companions')).toBe(0);
  });

  it('mantiene una sola QR activa por registro', async () => {
    const { participationId } = await seedCatalog();
    const registrationId = await insertRegistration(participationId);

    const insertQr = (id: string, status: string): Promise<unknown> =>
      env.DB.prepare(
        'INSERT INTO qr_codes (id, registration_id, token_hash, status, issued_at, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      )
        .bind(id, registrationId, `hash-${id}`, status, NOW, NOW)
        .run();

    await insertQr('qr-1', 'active');
    await expect(insertQr('qr-2', 'active')).rejects.toThrow(/UNIQUE constraint failed/);

    await env.DB.prepare("UPDATE qr_codes SET status = 'revoked', revoked_at = ? WHERE id = 'qr-1'")
      .bind(NOW)
      .run();

    await insertQr('qr-2', 'active');
    expect(await countRows('qr_codes')).toBe(2);
  });

  it('permite un solo turno activo por registro y lo libera al marcarlo', async () => {
    const { participationId } = await seedCatalog();
    const registrationId = await insertRegistration(participationId);

    await env.DB.prepare(
      'INSERT INTO shifts (id, participation_id, code, label, starts_at, ends_at, capacity, assigned_count, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)',
    )
      .bind('shift-1', participationId, 'T1', 'Turno 1', NOW, NOW + 3_600_000, 1, 'scheduled', NOW, NOW)
      .run();

    const assign = (id: string, status: string): Promise<unknown> =>
      env.DB.prepare(
        'INSERT INTO shift_assignments (id, shift_id, registration_id, status, assigned_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
      )
        .bind(id, 'shift-1', registrationId, status, NOW, NOW)
        .run();

    await assign('sa-1', 'assigned');
    await expect(assign('sa-2', 'checked_in')).rejects.toThrow(/UNIQUE constraint failed/);

    // Al liberarlo, el turno vuelve a estar disponible para ese registro.
    await env.DB.prepare(
      "UPDATE shift_assignments SET status = 'released', released_at = ? WHERE id = 'sa-1'",
    )
      .bind(NOW)
      .run();
    await assign('sa-3', 'assigned');

    expect(await countRows('shift_assignments')).toBe(2);

    // El contador del turno tambien esta protegido por CHECK.
    await expect(
      env.DB.prepare('UPDATE shifts SET assigned_count = 2 WHERE id = ?').bind('shift-1').run(),
    ).rejects.toThrow(/shifts_assigned_count_check/);
  });

  it('reporta el codigo extendido de SQLite en los mensajes de restriccion', async () => {
    const { participationId } = await seedCatalog();

    // Texto exacto de D1: la lista de columnas va seguida de ": SQLITE_CONSTRAINT".
    // Es el formato que `src/db/constraints.ts` debe saber reconocer; si el driver
    // cambiara el texto, los repositorios devolverian INTERNAL_ERROR en lugar del
    // error de negocio. Estas aserciones son la alerta temprana.
    await expect(
      env.DB.prepare(
        'INSERT INTO establishments (id, code, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
      )
        .bind('est-2', 'est-1', 'Codigo repetido', NOW, NOW)
        .run(),
    ).rejects.toThrow(
      /UNIQUE constraint failed: establishments\.code: SQLITE_CONSTRAINT \(extended: SQLITE_CONSTRAINT_UNIQUE\)/,
    );

    await expect(
      env.DB.prepare('UPDATE event_establishments SET confirmed_titulares = 3 WHERE id = ?')
        .bind(participationId)
        .run(),
    ).rejects.toThrow(
      /CHECK constraint failed: event_establishments_titular_capacity_check: SQLITE_CONSTRAINT/,
    );

    await expect(
      env.DB.prepare(
        'INSERT INTO shifts (id, participation_id, code, label, starts_at, ends_at, capacity, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      )
        .bind('shift-x', 'part-inexistente', 'T2', 'Turno 2', NOW, NOW, 1, NOW, NOW)
        .run(),
    ).rejects.toThrow(/FOREIGN KEY constraint failed: SQLITE_CONSTRAINT/);
  });
});

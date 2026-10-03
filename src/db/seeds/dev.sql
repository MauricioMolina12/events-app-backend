-- Datos de desarrollo para `npm run db:seed:local`.
--
-- Identificadores fijos para que el seed sea idempotente: volver a ejecutarlo no
-- duplica filas. Las fechas se guardan como epoch en milisegundos (UTC), igual
-- que las escribe la aplicacion.
--
-- La contrasena de un usuario NO se puede sembrar aqui (se deriva con PBKDF2 en
-- el Worker); el usuario administrador se crea con el comando de la Fase 4.

INSERT INTO establishments (id, code, name, city, address, status, created_at, updated_at)
VALUES
  ('11111111-1111-4111-8111-111111111111', 'norte', 'Colegio Norte', 'Bogota', 'Calle 100 # 15-20', 'active', CAST(strftime('%s', 'now') AS INTEGER) * 1000, CAST(strftime('%s', 'now') AS INTEGER) * 1000),
  ('22222222-2222-4222-8222-222222222222', 'sur', 'Colegio Sur', 'Bogota', 'Carrera 50 # 22-10', 'active', CAST(strftime('%s', 'now') AS INTEGER) * 1000, CAST(strftime('%s', 'now') AS INTEGER) * 1000)
ON CONFLICT (id) DO NOTHING;

INSERT INTO events (id, slug, name, description, timezone, starts_at, ends_at, registration_opens_at, registration_closes_at, status, created_by, created_at, updated_at)
VALUES (
  '33333333-3333-4333-8333-333333333333',
  'dia-del-nino-2026',
  'Dia del Nino 2026',
  'Evento de prueba para desarrollo local.',
  'America/Bogota',
  (CAST(strftime('%s', 'now') AS INTEGER) + 604800) * 1000,
  (CAST(strftime('%s', 'now') AS INTEGER) + 612000) * 1000,
  CAST(strftime('%s', 'now') AS INTEGER) * 1000,
  (CAST(strftime('%s', 'now') AS INTEGER) + 604800) * 1000,
  'published',
  NULL,
  CAST(strftime('%s', 'now') AS INTEGER) * 1000,
  CAST(strftime('%s', 'now') AS INTEGER) * 1000
)
ON CONFLICT (id) DO NOTHING;

-- Participaciones: mismo evento en dos sedes, con cupos distintos.
INSERT INTO event_establishments (id, event_id, establishment_id, status, titular_capacity, companion_capacity, confirmed_titulares, confirmed_companions, notes, created_at, updated_at)
VALUES
  ('44444444-4444-4444-8444-444444444444', '33333333-3333-4333-8333-333333333333', '11111111-1111-4111-8111-111111111111', 'open', 100, 200, 0, 0, 'Sede principal', CAST(strftime('%s', 'now') AS INTEGER) * 1000, CAST(strftime('%s', 'now') AS INTEGER) * 1000),
  ('55555555-5555-4555-8555-555555555555', '33333333-3333-4333-8333-333333333333', '22222222-2222-4222-8222-222222222222', 'open', 60, 120, 0, 0, 'Sede alterna', CAST(strftime('%s', 'now') AS INTEGER) * 1000, CAST(strftime('%s', 'now') AS INTEGER) * 1000)
ON CONFLICT (id) DO NOTHING;

-- Turnos de la sede principal, con cupo por franja.
INSERT INTO shifts (id, participation_id, code, label, starts_at, ends_at, capacity, assigned_count, status, created_at, updated_at)
VALUES
  ('66666666-6666-4666-8666-666666666666', '44444444-4444-4444-8444-444444444444', 'T1', 'Turno 08:00 - 10:00', (CAST(strftime('%s', 'now') AS INTEGER) + 604800) * 1000, (CAST(strftime('%s', 'now') AS INTEGER) + 605800) * 1000, 40, 0, 'scheduled', CAST(strftime('%s', 'now') AS INTEGER) * 1000, CAST(strftime('%s', 'now') AS INTEGER) * 1000),
  ('77777777-7777-4777-8777-777777777777', '44444444-4444-4444-8444-444444444444', 'T2', 'Turno 10:00 - 12:00', (CAST(strftime('%s', 'now') AS INTEGER) + 605800) * 1000, (CAST(strftime('%s', 'now') AS INTEGER) + 606600) * 1000, 40, 0, 'scheduled', CAST(strftime('%s', 'now') AS INTEGER) * 1000, CAST(strftime('%s', 'now') AS INTEGER) * 1000)
ON CONFLICT (id) DO NOTHING;

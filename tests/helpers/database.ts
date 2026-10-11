import { env } from 'cloudflare:test';

/**
 * Orden de borrado: primero las tablas que dependen de otras.
 *
 * Se usa SQL crudo a proposito: la limpieza debe funcionar aunque un repositorio
 * este roto, y no debe disparar traducciones de restricciones.
 */
const TABLES_IN_DELETE_ORDER = [
  'user_preferences',
  'workspace_settings',
  'turns',
  'turn_counters',
  'registration_documents',
  'qr_deliveries',
  'qr_codes',
  'shift_assignments',
  'shifts',
  'capacity_adjustments',
  'registration_companions',
  'registrations',
  'event_establishments',
  'events',
  'establishments',
  'sessions',
  'auth_attempts',
  'users',
] as const;

/**
 * Vacia todas las tablas de dominio.
 *
 * El plugin aisla el storage por archivo de test, no por test: los archivos que
 * escriben datos limpian en `beforeEach` para no depender del orden ni del numero
 * de casos. La tabla `d1_migrations` se respeta: el esquema se aplica una sola vez
 * por archivo.
 */
export async function truncateAll(): Promise<void> {
  await env.DB.batch(
    TABLES_IN_DELETE_ORDER.map((table) => env.DB.prepare(`DELETE FROM ${table}`)),
  );
}

/** Cuenta las filas de una tabla; util para comprobar que no quedo basura. */
export async function countRows(table: string): Promise<number> {
  const row = await env.DB.prepare(`SELECT count(*) AS total FROM ${table}`).first<{
    total: number;
  }>();
  return row?.total ?? 0;
}

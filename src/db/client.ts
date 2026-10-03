import { drizzle, type DrizzleD1Database } from 'drizzle-orm/d1';
import * as schema from './schema';

/**
 * Conexion Drizzle usada por los repositorios.
 *
 * El esquema se pasa completo para habilitar la API relacional (`db.query.*`)
 * ademas del constructor de consultas.
 */
export type Database = DrizzleD1Database<typeof schema>;

/**
 * Crea la conexion Drizzle sobre el binding D1.
 *
 * No se cachea: cada invocacion del Worker tiene su propio contexto de I/O y
 * compartir clientes entre peticiones es una fuente clasica de bugs.
 */
export function createDb(env: CloudflareBindings): Database {
  return drizzle(env.DB, { schema });
}

export type DatabaseStatus = 'up' | 'down' | 'not_configured';

/**
 * Comprobacion barata de disponibilidad de D1.
 *
 * Se usa en `/health`. Un fallo de base de datos no debe tumbar el reporte de
 * estado: se captura y se informa como `down`.
 */
export async function checkDatabase(env: CloudflareBindings): Promise<DatabaseStatus> {
  if (env.DB === undefined) {
    return 'not_configured';
  }

  try {
    await env.DB.prepare('SELECT 1 AS ok').first();
    return 'up';
  } catch (error) {
    console.error(
      JSON.stringify({
        level: 'error',
        msg: 'database_unreachable',
        error: error instanceof Error ? error.message : String(error),
      }),
    );
    return 'down';
  }
}

import { defineConfig } from 'drizzle-kit';

/**
 * Configuracion de Drizzle Kit.
 *
 * Solo interviene en la GENERACION del SQL (`npm run db:generate`). La
 * aplicacion de las migraciones la hace Wrangler (`npm run db:migrate:local` y
 * `npm run db:migrate:remote`), que es quien conoce el binding D1 de cada
 * entorno y quien mantiene la tabla de control `d1_migrations`.
 *
 * Los archivos de `migrations/` se versionan: son la fuente de verdad del
 * esquema, no el estado de una base de datos concreta.
 */
export default defineConfig({
  dialect: 'sqlite',
  schema: './src/db/schema/index.ts',
  out: './migrations',
  verbose: true,
  // Exige confirmacion explicita para cambios destructivos en `drizzle-kit push`.
  strict: true,
});

import { applyD1Migrations, env } from 'cloudflare:test';

/**
 * Aplica las migraciones de `migrations/` sobre la base de datos de pruebas.
 *
 * - Las migraciones llegan como binding `TEST_MIGRATIONS` (ver `vitest.config.ts`)
 *   porque workerd no puede leer el sistema de archivos.
 * - El storage esta aislado por archivo de test: cada archivo aplica las
 *   migraciones sobre su propia copia. `applyD1Migrations` es idempotente, deja
 *   el registro en la tabla `d1_migrations`.
 * - El orden importa: los tests que escriben datos limpian en `beforeEach`, nunca
 *   el esquema.
 */
await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);

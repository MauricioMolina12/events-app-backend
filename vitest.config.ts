import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';

/**
 * Configuracion de pruebas.
 *
 * Los tests se ejecutan dentro del runtime de Workers (workerd, via Miniflare)
 * reutilizando la configuracion de `wrangler.jsonc`, por lo que el binding D1
 * `DB` esta disponible igual que en produccion.
 *
 * Migraciones: dentro de workerd no hay acceso al sistema de archivos, asi que
 * `readD1Migrations()` lee `migrations/` en el proceso de Node y las inyecta como
 * el binding `TEST_MIGRATIONS`. `tests/setup/apply-migrations.ts` las aplica
 * antes de cada archivo de test.
 *
 * Aislamiento: el plugin aisla el storage por ARCHIVO de test, no por test. Los
 * casos de un mismo archivo comparten el estado de la base de datos, por lo que
 * los tests que escriben limpian en `beforeEach`.
 */
export default defineConfig(async () => {
  const migrations = await readD1Migrations('./migrations');

  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: './wrangler.jsonc' },
        miniflare: { bindings: { TEST_MIGRATIONS: migrations } },
      }),
    ],
    test: {
      include: ['tests/**/*.test.ts'],
      setupFiles: ['./tests/setup/apply-migrations.ts'],
      // Sin `globals`: cada test importa describe/it/expect explicitamente.
    },
  };
});


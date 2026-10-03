import { cloudflareTest } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';

/**
 * Configuracion de pruebas.
 *
 * Los tests se ejecutan dentro del runtime de Workers (workerd, via Miniflare)
 * reutilizando la configuracion de `wrangler.jsonc`, por lo que el binding D1
 * `DB` esta disponible igual que en produccion.
 *
 * Aislamiento: el plugin aisla el storage por ARCHIVO de test, no por test. Los
 * casos de un mismo archivo comparten el estado de la base de datos.
 */
export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: './wrangler.jsonc' },
    }),
  ],
  test: {
    include: ['tests/**/*.test.ts'],
    // Sin `globals`: cada test importa describe/it/expect explicitamente.
  },
});

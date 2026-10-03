import type { D1Migration } from 'cloudflare:test';

/**
 * Tipos exclusivos del entorno de pruebas.
 *
 * `TEST_MIGRATIONS` no es un binding de la aplicacion (no aparece en
 * `wrangler.jsonc`), asi que no lo genera `npm run cf-typegen`: lo inyecta
 * `vitest.config.ts` con `readD1Migrations()`.
 */
declare global {
  namespace Cloudflare {
    interface Env {
      TEST_MIGRATIONS: D1Migration[];
    }
  }
}

export {};

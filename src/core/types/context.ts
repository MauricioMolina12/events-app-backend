import type { Env } from 'hono';

/**
 * Variables disponibles durante el ciclo de vida de una peticion.
 * La Fase 4 anadira aqui `authUser` (usuario autenticado) y `session`.
 */
export interface AppVariables {
  requestId: string;
}

/**
 * Entorno de Hono del proyecto.
 *
 * `CloudflareBindings` lo genera `npm run cf-typegen` a partir de
 * `wrangler.jsonc`; por eso no se importa (es una interfaz global declarada en
 * `worker-configuration.d.ts`).
 */
export interface AppEnv extends Env {
  Bindings: CloudflareBindings;
  Variables: AppVariables;
}

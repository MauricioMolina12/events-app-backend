import { createApp } from './app';

/**
 * Punto de entrada del Worker.
 *
 * `wrangler.jsonc` apunta a este archivo (`main`). La aplicacion Hono se
 * construye una sola vez por isolate; todo el estado mutable vive en D1.
 */
const app = createApp();

export default app;

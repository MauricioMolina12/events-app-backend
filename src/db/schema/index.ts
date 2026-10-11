/**
 * Punto unico de exportacion del esquema.
 *
 * `drizzle.config.ts` apunta aqui, y los repositorios importan las tablas desde
 * este modulo en lugar de hacerlo desde cada archivo. Todo lo que se agregue a
 * `src/db/schema/` debe reexportarse para que Drizzle Kit lo vea.
 */
export * from './auth';
export * from './events';
export * from './registrations';
export * from './qr';
export * from './access';
export * from './capacity';
export * from './workspace';

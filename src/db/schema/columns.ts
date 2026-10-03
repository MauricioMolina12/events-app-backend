import { integer, text } from 'drizzle-orm/sqlite-core';

/**
 * Columnas y convenciones compartidas por todo el esquema.
 *
 * - **Claves primarias**: UUID v4 en `text`, generados por el dominio
 *   (`newId()`). Son opacos (no se enumeran recursos con un id secuencial) y
 *   permiten construir la fila completa antes de escribir, requisito para
 *   agrupar escrituras con `env.DB.batch([...])`.
 * - **Fechas**: epoch en milisegundos (INTEGER, UTC). Drizzle las expone como
 *   `Date` y la capa HTTP las serializa a ISO-8601. Ordenar y comparar enteros
 *   elimina los errores de formato y de zona horaria.
 * - **Booleanos**: INTEGER 0/1 mediante `mode: 'boolean'`.
 * - Las marcas de tiempo las fija el repositorio, nunca la base de datos: sin
 *   `DEFAULT` el valor es explicito, testeable y reproducible.
 */

/** Clave primaria: UUID v4 en texto. */
export function idColumn() {
  return text('id').primaryKey();
}

/** Marca temporal de creacion (obligatoria). */
export function createdAtColumn() {
  return integer('created_at', { mode: 'timestamp_ms' }).notNull();
}

/** Marca temporal de ultima modificacion (obligatoria). */
export function updatedAtColumn() {
  return integer('updated_at', { mode: 'timestamp_ms' }).notNull();
}

/** Marca temporal opcional: `NULL` significa "todavia no ha ocurrido". */
export function timestampColumn(name: string) {
  return integer(name, { mode: 'timestamp_ms' });
}

/** Marca temporal obligatoria con nombre libre. */
export function requiredTimestampColumn(name: string) {
  return integer(name, { mode: 'timestamp_ms' }).notNull();
}

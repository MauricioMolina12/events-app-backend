/**
 * Utilidades de identificacion y tiempo compartidas por los repositorios.
 *
 * Las fechas viven en la base de datos como epoch en milisegundos (UTC) y se
 * convierten a ISO-8601 solo al construir la respuesta HTTP.
 */

/** Identificador opaco (UUID v4) para nuevas filas. */
export function newId(): string {
  return crypto.randomUUID();
}

/** Fuente de tiempo inyectable: los servicios la reciben para poder testearse. */
export type Clock = () => Date;

/** Reloj real del runtime. */
export const systemClock: Clock = () => new Date();

/** Serializa una fecha al ISO-8601 UTC que expone la API. `null` se propaga. */
export function toIsoString(value: Date | null | undefined): string | null {
  return value === null || value === undefined ? null : value.toISOString();
}

/** Reconstruye una fecha a partir de un ISO-8601 recibido del cliente. */
export function fromIsoString(value: string): Date {
  return new Date(value);
}

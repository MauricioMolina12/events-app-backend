/**
 * Reglas de paginacion compartidas por los listados.
 *
 * Un `limit` sin tope permitiria pedir la tabla entera y agotar la memoria del
 * isolate: todos los modulos acotan con el mismo criterio y devuelven el tamano
 * realmente aplicado en `meta.limit`, para que el cliente pueda recorrer las
 * paginas sin adivinar.
 */

export interface PaginationLimits {
  /** Tamano de pagina cuando el cliente no lo indica. */
  readonly defaultLimit: number;
  /** Tope duro por pagina. */
  readonly maxLimit: number;
}

/** Acota el tamano de pagina solicitado al rango admitido. */
export function clampLimit(requested: number | undefined, limits: PaginationLimits): number {
  if (requested === undefined) {
    return limits.defaultLimit;
  }
  return Math.min(Math.max(requested, 1), limits.maxLimit);
}

/** Desplazamiento no negativo; un `offset` negativo se trata como cero. */
export function clampOffset(offset: number | undefined): number {
  return Math.max(offset ?? 0, 0);
}

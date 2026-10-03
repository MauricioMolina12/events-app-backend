import { z } from '@hono/zod-openapi';
import { ESTABLISHMENT_STATUSES } from '../../db/schema';
import type { EstablishmentRow } from './establishments.repository';

/**
 * Esquemas y mapeos de presentacion del catalogo de sedes.
 *
 * `code` es el identificador corto que usa la operacion (planillas, reportes) y
 * viaja tal cual; el nombre es lo que ve el publico.
 */

/** Formato del codigo: minusculas, digitos y guiones simples. */
export const CODE_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const CODE_MIN_LENGTH = 2;
export const CODE_MAX_LENGTH = 32;

export const establishmentSchema = z
  .object({
    id: z.string(),
    code: z.string(),
    name: z.string(),
    city: z.string().nullable(),
    address: z.string().nullable(),
    status: z.enum(ESTABLISHMENT_STATUSES),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .openapi('Establishment');

/** Resumen de sede: lo que necesita quien lee una participacion o un registro. */
export const establishmentSummarySchema = z
  .object({
    id: z.string(),
    code: z.string(),
    name: z.string(),
    city: z.string().nullable(),
    status: z.enum(ESTABLISHMENT_STATUSES),
  })
  .openapi('EstablishmentSummary');

/** Sede lista para responder, con las fechas ya en ISO-8601. */
export function toEstablishment(establishment: EstablishmentRow) {
  return {
    id: establishment.id,
    code: establishment.code,
    name: establishment.name,
    city: establishment.city,
    address: establishment.address,
    status: establishment.status,
    createdAt: establishment.createdAt.toISOString(),
    updatedAt: establishment.updatedAt.toISOString(),
  };
}

/** Recorte de la sede para las respuestas que la acompanan. */
export function toEstablishmentSummary(establishment: EstablishmentRow) {
  return {
    id: establishment.id,
    code: establishment.code,
    name: establishment.name,
    city: establishment.city,
    status: establishment.status,
  };
}

/** Forma publica de la sede cuando acompana a otra entidad (participacion). */
export type EstablishmentSummary = ReturnType<typeof toEstablishmentSummary>;

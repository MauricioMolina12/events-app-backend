import { z } from '@hono/zod-openapi';
import { toIsoString } from '../../db/helpers';
import { EVENT_STATUSES } from '../../db/schema';
import type { EventRow } from './events.repository';

/**
 * Esquemas y mapeos de presentacion del catalogo de eventos.
 *
 * Las fechas se guardan en UTC y se exponen en ISO-8601; `timezone` solo indica a
 * la interfaz en que zona presentarlas. El `slug` viaja tal cual: es el
 * identificador publico del evento.
 */

/** Formato del slug: minusculas, digitos y guiones simples. */
export const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const SLUG_MIN_LENGTH = 3;
export const SLUG_MAX_LENGTH = 80;

export const eventSchema = z
  .object({
    id: z.string(),
    slug: z.string(),
    name: z.string(),
    description: z.string().nullable(),
    timezone: z.string(),
    startsAt: z.string().nullable(),
    endsAt: z.string().nullable(),
    registrationOpensAt: z.string().nullable(),
    registrationClosesAt: z.string().nullable(),
    status: z.enum(EVENT_STATUSES),
    createdBy: z.string().nullable(),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .openapi('Event');

/** Evento listo para responder, con las fechas ya en ISO-8601. */
export function toEvent(event: EventRow) {
  return {
    id: event.id,
    slug: event.slug,
    name: event.name,
    description: event.description,
    timezone: event.timezone,
    startsAt: toIsoString(event.startsAt),
    endsAt: toIsoString(event.endsAt),
    registrationOpensAt: toIsoString(event.registrationOpensAt),
    registrationClosesAt: toIsoString(event.registrationClosesAt),
    status: event.status,
    createdBy: event.createdBy,
    createdAt: event.createdAt.toISOString(),
    updatedAt: event.updatedAt.toISOString(),
  };
}

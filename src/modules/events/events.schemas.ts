import { z } from '@hono/zod-openapi';
import { toIsoString } from '../../db/helpers';
import { EVENT_STATUSES, REGISTRATION_SCOPES } from '../../db/schema';
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

export const ticketDesignSchema = z
  .object({
    bgColor: z.string().regex(/^#[0-9A-Fa-f]{6}$/).optional(),
    textColor: z.string().regex(/^#[0-9A-Fa-f]{6}$/).optional(),
    accentColor: z.string().regex(/^#[0-9A-Fa-f]{6}$/).optional(),
    titleWeight: z.number().int().min(400).max(900).optional(),
    titleSize: z.number().min(12).max(48).optional(),
    titleX: z.number().min(0).max(100).optional(),
    titleY: z.number().min(0).max(100).optional(),
    qrX: z.number().min(0).max(100).optional(),
    qrY: z.number().min(0).max(100).optional(),
    qrSize: z.number().min(80).max(240).optional(),
    fieldWeight: z.number().int().min(400).max(800).optional(),
  })
  .openapi('TicketDesign');

export type TicketDesign = z.infer<typeof ticketDesignSchema>;

export function parseTicketDesign(raw: string | null): TicketDesign | null {
  if (!raw) {
    return null;
  }
  try {
    const parsed = ticketDesignSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

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
    capacity: z.number().int(),
    status: z.enum(EVENT_STATUSES),
    registrationScope: z.enum(REGISTRATION_SCOPES),
    ticketDesign: ticketDesignSchema.nullable(),
    createdBy: z.string().nullable(),
    client: z
      .object({
        id: z.string(),
        slug: z.string(),
        displayName: z.string(),
      })
      .nullable(),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .openapi('Event');

export interface EventClientSummary {
  readonly id: string;
  readonly slug: string;
  readonly displayName: string;
}

/** Evento listo para responder, con las fechas ya en ISO-8601. */
export function toEvent(event: EventRow, client: EventClientSummary | null = null) {
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
    capacity: event.capacity,
    status: event.status,
    registrationScope: event.registrationScope,
    ticketDesign: parseTicketDesign(event.ticketDesign),
    createdBy: event.createdBy,
    client,
    createdAt: event.createdAt.toISOString(),
    updatedAt: event.updatedAt.toISOString(),
  };
}

import { z } from '@hono/zod-openapi';
import { toIsoString } from '../../db/helpers';
import { PARTICIPATION_STATUSES } from '../../db/schema';
import {
  establishmentSummarySchema,
  type EstablishmentSummary,
} from '../establishments/establishments.schemas';
import type { ParticipationRow } from './participations.repository';

/**
 * Esquemas y mapeos de presentacion del catalogo de participaciones.
 *
 * Una participacion es la sede dentro de un evento y la unidad real de cupo: los
 * campos derivados (`available*`) evitan que el cliente tenga que restarlos.
 */

export const participationSchema = z
  .object({
    id: z.string(),
    eventId: z.string(),
    establishmentId: z.string(),
    status: z.enum(PARTICIPATION_STATUSES),
    titularCapacity: z.number().int(),
    companionCapacity: z.number().int(),
    confirmedTitulares: z.number().int(),
    confirmedCompanions: z.number().int(),
    /** Cupo libre de titulares: `titularCapacity - confirmedTitulares`. */
    availableTitulares: z.number().int(),
    /** Cupo libre de acompanantes: `companionCapacity - confirmedCompanions`. */
    availableCompanions: z.number().int(),
    registrationOpensAt: z.string().nullable(),
    registrationClosesAt: z.string().nullable(),
    checkInOpensAt: z.string().nullable(),
    checkInClosesAt: z.string().nullable(),
    notes: z.string().nullable(),
    createdAt: z.string(),
    updatedAt: z.string(),
    /** Sede participante, resuelta por el servicio de establecimientos. */
    establishment: establishmentSummarySchema,
  })
  .openapi('Participation');

/** Participacion lista para responder, con las fechas ya en ISO-8601. */
export function toParticipation(
  participation: ParticipationRow,
  establishment: EstablishmentSummary,
) {
  return {
    id: participation.id,
    eventId: participation.eventId,
    establishmentId: participation.establishmentId,
    status: participation.status,
    titularCapacity: participation.titularCapacity,
    companionCapacity: participation.companionCapacity,
    confirmedTitulares: participation.confirmedTitulares,
    confirmedCompanions: participation.confirmedCompanions,
    availableTitulares: participation.titularCapacity - participation.confirmedTitulares,
    availableCompanions: participation.companionCapacity - participation.confirmedCompanions,
    registrationOpensAt: toIsoString(participation.registrationOpensAt),
    registrationClosesAt: toIsoString(participation.registrationClosesAt),
    checkInOpensAt: toIsoString(participation.checkInOpensAt),
    checkInClosesAt: toIsoString(participation.checkInClosesAt),
    notes: participation.notes,
    createdAt: participation.createdAt.toISOString(),
    updatedAt: participation.updatedAt.toISOString(),
    establishment,
  };
}

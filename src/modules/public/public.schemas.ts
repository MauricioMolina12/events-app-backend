import { z } from '@hono/zod-openapi';
import { toIsoString } from '../../db/helpers';
import { DOCUMENT_TYPES, REGISTRATION_STATUSES } from '../../db/schema';
import type { EstablishmentRow } from '../establishments/establishments.repository';
import type { EventRow } from '../events/events.repository';
import type { ParticipationRow } from '../participations/participations.repository';
import type { RegistrationRow } from '../registrations/registrations.repository';
import {
  effectiveRegistrationWindow,
  isWithinRegistrationWindow,
  type RegistrationWindowSource,
} from '../registrations/registrations.service';

/**
 * Esquemas y mapeos del catalogo publico.
 *
 * Estas formas son las unicas que ve quien llega desde fuera: se recortan a lo que
 * la inscripcion necesita (que sede, cuantos cupos quedan y si el registro esta
 * abierto) y omiten todo lo operativo (estados internos, notas, auditoria, cupos
 * comprometidos por sede).
 *
 * La ventana y la apertura del registro se calculan con las mismas funciones que
 * usa el alta (`registrations.service`): el catalogo no puede decir "abierto" y el
 * alta responder `REGISTRATION_OUTSIDE_WINDOW`.
 */

/** Sede tal como se ofrece al publico: como llegar, sin datos de operacion. */
export const publicEstablishmentSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    city: z.string().nullable(),
  })
  .openapi('PublicEstablishment');

/** Una sede dentro de un evento: la unidad donde la persona se inscribe. */
export const publicParticipationSchema = z
  .object({
    id: z.string(),
    establishment: publicEstablishmentSchema,
    /** Cupo libre de titulares; negativo nunca, porque el servicio acota al reservar. */
    availableTitulares: z.number().int(),
    availableCompanions: z.number().int(),
    registrationOpensAt: z.string().nullable(),
    registrationClosesAt: z.string().nullable(),
    /** `true` si en este momento el alta seria aceptada en esta sede. */
    registrationOpen: z.boolean(),
  })
  .openapi('PublicParticipation');

/** Evento publicado, con las sedes donde todavia se puede uno inscribir. */
export const publicEventSchema = z
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
    participations: z.array(publicParticipationSchema),
  })
  .openapi('PublicEvent');

/** Confirmacion del alta: lo que la persona declaro, sin datos de operacion. */
export const publicRegistrationReceiptSchema = z
  .object({
    id: z.string(),
    participationId: z.string(),
    documentType: z.enum(DOCUMENT_TYPES),
    documentNumber: z.string(),
    fullName: z.string(),
    companionsCount: z.number().int(),
    status: z.enum(REGISTRATION_STATUSES),
    registeredAt: z.string(),
    /**
     * Token en claro del pase. Solo viaja en el alta (`POST`); la consulta del
     * folio no lo reexpone porque de la base solo queda el hash.
     */
    qrToken: z.string().optional(),
  })
  .openapi('PublicRegistrationReceipt');

/**
 * Registro que un titular gestiona con sus credenciales: el recibo y el tope de
 * acompanantes, para que el formulario sepa cuantos puede sumar todavia.
 */
export const publicHolderRegistrationSchema = publicRegistrationReceiptSchema
  .extend({
    maxCompanions: z.number().int(),
  })
  .openapi('PublicHolderRegistration');

/** Sede publica: solo lo que ayuda a reconocerla y llegar a ella. */
export function toPublicEstablishment(establishment: EstablishmentRow) {
  return {
    id: establishment.id,
    name: establishment.name,
    city: establishment.city,
  };
}

/**
 * Sede dentro de un evento, con la ventana efectiva ya resuelta.
 *
 * `registrationOpen` no mira solo la ventana: exige tambien que la sede siga
 * abierta y el establecimiento activo, que son las otras dos condiciones del alta.
 */
export function toPublicParticipation(
  participation: ParticipationRow,
  establishment: EstablishmentRow,
  eventWindow: RegistrationWindowSource,
  now: Date,
) {
  const window = effectiveRegistrationWindow(eventWindow, participation);

  return {
    id: participation.id,
    establishment: toPublicEstablishment(establishment),
    availableTitulares: participation.titularCapacity - participation.confirmedTitulares,
    availableCompanions: participation.companionCapacity - participation.confirmedCompanions,
    registrationOpensAt: toIsoString(window.opensAt),
    registrationClosesAt: toIsoString(window.closesAt),
    registrationOpen:
      participation.status === 'open' &&
      establishment.status === 'active' &&
      isWithinRegistrationWindow(window, now),
  };
}

/** Participacion publica lista para responder. */
export type PublicParticipation = ReturnType<typeof toPublicParticipation>;

/** Evento publicado con sus sedes; es la ficha que consume el formulario. */
export function toPublicEvent(event: EventRow, participations: readonly PublicParticipation[]) {
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
    participations: [...participations],
  };
}

/** Evento publico listo para responder. */
export type PublicEvent = ReturnType<typeof toPublicEvent>;

/** Confirmacion del alta lista para responder. */
export function toPublicRegistrationReceipt(registration: RegistrationRow, qrToken?: string) {
  return {
    id: registration.id,
    participationId: registration.participationId,
    documentType: registration.documentType,
    documentNumber: registration.documentNumber,
    fullName: registration.fullName,
    companionsCount: registration.companionsCount,
    status: registration.status,
    registeredAt: registration.registeredAt.toISOString(),
    ...(qrToken !== undefined ? { qrToken } : {}),
  };
}

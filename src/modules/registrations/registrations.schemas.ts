import { z } from '@hono/zod-openapi';
import { toIsoString } from '../../db/helpers';
import { DOCUMENT_TYPES, REGISTRATION_SOURCES, REGISTRATION_STATUSES } from '../../db/schema';
import type { RegistrationCompanionRow, RegistrationRow } from './registrations.repository';

/**
 * Esquemas y mapeos de presentacion de los registros.
 *
 * El documento viaja tal como lo escribe la persona y se guarda normalizado
 * (mayusculas, solo letras y digitos): asi `1.020.304.000` y `1020304000` son el
 * mismo documento para el indice unico por sede. La normalizacion la aplica el
 * servicio antes de escribir, no el cliente.
 */

/** Formato del documento ya normalizado. */
export const DOCUMENT_NUMBER_PATTERN = /^[A-Z0-9]{4,20}$/;

/** Caracteres admitidos en el documento de entrada: separadores de lectura. */
export const DOCUMENT_NUMBER_INPUT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9\s.-]*$/;

/**
 * Tope de acompanantes por titular, sumando los del alta y los agregados despues.
 *
 * Acota el cuerpo de la peticion y, con el, el cupo que una sola alta puede
 * reservar de golpe; el servicio lo vuelve a comprobar antes de escribir.
 */
export const MAX_COMPANIONS_PER_REGISTRATION = 2;

/** Nombre de una persona (titular o acompanante). */
const fullNameSchema = z.string().trim().min(3).max(120);

export const documentNumberInputSchema = z
  .string()
  .trim()
  .min(4)
  .max(30)
  .regex(DOCUMENT_NUMBER_INPUT_PATTERN)
  .openapi({
    example: '1.020.304.000',
    description: 'Se normaliza antes de guardarlo: mayusculas y sin puntos ni espacios.',
  });

/** Acompanante declarado en el alta. */
export const companionRequestSchema = z
  .object({
    fullName: fullNameSchema,
    documentType: z.enum(DOCUMENT_TYPES).nullable().optional(),
    documentNumber: documentNumberInputSchema.nullable().optional(),
  })
  .openapi('RegistrationCompanionRequest');

/**
 * Cuerpo del alta de un registro.
 *
 * Lo comparten el alta publica y el alta manual del panel: el unico cambio es el
 * `source` que fija cada ruta.
 */
export const createRegistrationRequestSchema = z
  .object({
    participationId: z.string().min(1).openapi({
      description: 'Sede del evento en la que se registra (la unidad de cupo).',
    }),
    documentType: z.enum(DOCUMENT_TYPES),
    documentNumber: documentNumberInputSchema,
    fullName: fullNameSchema,
    email: z.email().max(320).nullable().optional(),
    phone: z
      .string()
      .trim()
      .min(7)
      .max(20)
      .regex(/^[+]?[0-9\s()-]+$/)
      .nullable()
      .optional(),
    requiresElectronicInvoice: z.boolean().default(false).openapi({
      description: 'Si el titular requiere facturacion electronica. Por ahora solo se almacena.',
    }),
    companions: z.array(companionRequestSchema).max(MAX_COMPANIONS_PER_REGISTRATION).optional(),
  })
  .openapi('CreateRegistrationRequest');

/**
 * Datos con los que un titular se identifica sin sesion para gestionar su registro.
 *
 * El documento ubica el registro (es unico por evento) y el correo declarado en el
 * alta lo confirma: con solo el documento, cualquiera podria sumar personas al
 * registro de otro.
 */
export const holderCredentialsSchema = z
  .object({
    event: z.string().trim().min(1).openapi({
      description: 'Slug o identificador del evento.',
    }),
    documentType: z.enum(DOCUMENT_TYPES),
    documentNumber: documentNumberInputSchema,
    email: z.string().trim().pipe(z.email().max(320)),
  })
  .openapi('HolderCredentials');

/** Cuerpo para sumar acompanantes a un registro existente. */
export const addCompanionsRequestSchema = holderCredentialsSchema
  .extend({
    companions: z.array(companionRequestSchema).min(1).max(MAX_COMPANIONS_PER_REGISTRATION),
  })
  .openapi('AddCompanionsRequest');

/** Cuerpo de la cancelacion: el motivo queda en la bitacora del registro. */
export const cancelRegistrationRequestSchema = z
  .object({
    reason: z.string().trim().min(3).max(200).openapi({
      example: 'La persona aviso que no puede asistir.',
    }),
  })
  .openapi('CancelRegistrationRequest');

/** Acompanante tal como se responde. */
export const registrationCompanionSchema = z
  .object({
    id: z.string(),
    fullName: z.string(),
    documentType: z.enum(DOCUMENT_TYPES).nullable(),
    documentNumber: z.string().nullable(),
    createdAt: z.string(),
  })
  .openapi('RegistrationCompanion');

export const registrationSchema = z
  .object({
    id: z.string(),
    participationId: z.string(),
    documentType: z.enum(DOCUMENT_TYPES),
    documentNumber: z.string(),
    fullName: z.string(),
    email: z.string().nullable(),
    phone: z.string().nullable(),
    /** Cupo de acompanantes consumido por este registro. */
    companionsCount: z.number().int(),
    status: z.enum(REGISTRATION_STATUSES),
    source: z.enum(REGISTRATION_SOURCES),
    registeredAt: z.string(),
    cancelledAt: z.string().nullable(),
    cancelledReason: z.string().nullable(),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .openapi('Registration');

/** Registro con sus acompanantes; es la forma de la consulta individual. */
export const registrationDetailSchema = registrationSchema
  .extend({ companions: z.array(registrationCompanionSchema) })
  .openapi('RegistrationDetail');

/** Registro listo para responder, con las fechas ya en ISO-8601. */
export function toRegistration(registration: RegistrationRow) {
  return {
    id: registration.id,
    participationId: registration.participationId,
    documentType: registration.documentType,
    documentNumber: registration.documentNumber,
    fullName: registration.fullName,
    email: registration.email,
    phone: registration.phone,
    companionsCount: registration.companionsCount,
    requiresElectronicInvoice: registration.requiresElectronicInvoice,
    status: registration.status,
    source: registration.source,
    registeredAt: registration.registeredAt.toISOString(),
    cancelledAt: toIsoString(registration.cancelledAt),
    cancelledReason: registration.cancelledReason,
    createdAt: registration.createdAt.toISOString(),
    updatedAt: registration.updatedAt.toISOString(),
  };
}

/** Acompanante listo para responder. */
export function toRegistrationCompanion(companion: RegistrationCompanionRow) {
  return {
    id: companion.id,
    fullName: companion.fullName,
    documentType: companion.documentType,
    documentNumber: companion.documentNumber,
    createdAt: companion.createdAt.toISOString(),
  };
}

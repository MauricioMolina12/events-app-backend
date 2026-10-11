import { sha256Hex } from '../../core/crypto/encoding';
import { AppError } from '../../core/errors/app-error';
import { ErrorCode } from '../../core/errors/error-codes';
import type { Database } from '../../db/client';
import { listCompanions } from '../registrations/registrations.repository';
import {
  assignTurns,
  findQrCodeByTokenHash,
  findTicketContext,
  listTurns,
  type TicketContext,
  type TurnRow,
} from './check-in.repository';

/**
 * Ingreso en puerta: el QR de un registro entrega un turno consecutivo por persona.
 *
 * El primer escaneo asigna los turnos (titular primero, luego sus acompanantes en
 * orden de alta); los siguientes devuelven los mismos numeros con
 * `alreadyAssigned`, de modo que volver a escanear nunca consume numeros.
 */

export interface ScanTicketInput {
  readonly code: string;
  readonly actorId: string | null;
}

export interface ScanTicketResult {
  readonly ticket: TicketContext;
  readonly turns: readonly TurnRow[];
  readonly alreadyAssigned: boolean;
}

/** Los QR guardan el token del alta; los comprobantes sin token muestran el id del registro. */
const CODE_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function scanTicket(
  db: Database,
  input: ScanTicketInput,
  now: Date = new Date(),
): Promise<ScanTicketResult> {
  const code = input.code.trim().toLowerCase();
  if (!CODE_PATTERN.test(code)) {
    throw AppError.unprocessable(ErrorCode.QR_MALFORMED, 'El codigo escaneado no es un QR de acceso.');
  }

  const ticket = await resolveTicket(db, code);
  const { registration } = ticket;

  if (registration.status === 'cancelled') {
    throw AppError.conflict(ErrorCode.QR_REVOKED, 'La inscripcion fue cancelada; el codigo ya no es valido.');
  }
  if (registration.status !== 'confirmed') {
    throw AppError.conflict(
      ErrorCode.TURN_ASSIGNMENT_CONFLICT,
      'La inscripcion no tiene cupo confirmado; no se puede asignar turno.',
    );
  }

  const existing = await listTurns(db, registration.id);
  if (existing.length > 0) {
    return { ticket, turns: existing, alreadyAssigned: true };
  }

  const companions = await listCompanions(db, registration.id);
  const assigned = await assignTurns(
    db,
    {
      participationId: ticket.participationId,
      registrationId: registration.id,
      assignedBy: input.actorId,
      people: [
        { position: 0, fullName: registration.fullName, companionId: null },
        ...companions.map((companion, index) => ({
          position: index + 1,
          fullName: companion.fullName,
          companionId: companion.id,
        })),
      ],
    },
    now,
  );

  if (assigned === null) {
    return { ticket, turns: await listTurns(db, registration.id), alreadyAssigned: true };
  }
  return { ticket, turns: assigned, alreadyAssigned: false };
}

async function resolveTicket(db: Database, code: string): Promise<TicketContext> {
  const qr = await findQrCodeByTokenHash(db, await sha256Hex(code));
  if (qr !== null && qr.status === 'revoked') {
    throw AppError.conflict(ErrorCode.QR_REVOKED, 'Este codigo fue revocado.');
  }

  const ticket = await findTicketContext(db, qr?.registrationId ?? code);
  if (ticket === null) {
    throw AppError.notFound(ErrorCode.TICKET_NOT_FOUND, 'No existe una inscripcion con este codigo.');
  }
  return ticket;
}

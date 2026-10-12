import { and, eq, like, or, type SQL } from 'drizzle-orm';
import { sha256Hex } from '../../core/crypto/encoding';
import { AppError } from '../../core/errors/app-error';
import { ErrorCode } from '../../core/errors/error-codes';
import type { Database } from '../../db/client';
import { eventEstablishments, registrationCompanions, registrations } from '../../db/schema';
import {
  listCompanions,
  releaseNoShowCompanions,
  type RegistrationCompanionRow,
} from '../registrations/registrations.repository';
import {
  assignTurns,
  findQrCodeByTokenHash,
  findTicketContext,
  listTurns,
  type TicketContext,
  type TurnRow,
} from './check-in.repository';

/**
 * Ingreso en puerta: el QR identifica el registro; los turnos se asignan a quien
 * esta presente. Los acompanantes que no llegaron todavia conservan su cupo
 * para un reescaneo. Solo se libera cupo si el personal lo pide.
 */

export interface LookupTicketResult {
  readonly ticket: TicketContext;
  readonly companions: readonly RegistrationCompanionRow[];
  readonly turns: readonly TurnRow[];
  readonly alreadyAssigned: boolean;
}

export interface ScanTicketInput {
  readonly code: string;
  readonly actorId: string | null;
  readonly holderPresent: boolean;
  readonly presentCompanionIds: readonly string[];
  readonly releaseCompanionIds?: readonly string[];
}

export interface ScanTicketResult {
  readonly ticket: TicketContext;
  readonly turns: readonly TurnRow[];
  readonly alreadyAssigned: boolean;
  readonly releasedCompanionsCount: number;
}

const CODE_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function lookupTicket(db: Database, code: string): Promise<LookupTicketResult> {
  const ticket = await resolveReadyTicket(db, code);
  const [companions, turns] = await Promise.all([
    listCompanions(db, ticket.registration.id),
    listTurns(db, ticket.registration.id),
  ]);

  return {
    ticket,
    companions,
    turns,
    alreadyAssigned: turns.some((turn) => turn.position === 0),
  };
}

export async function searchTickets(
  db: Database,
  input: { eventId: string; query: string },
): Promise<LookupTicketResult[]> {
  const query = input.query.trim();
  if (query.length < 2) {
    return [];
  }

  const normalized = query.toUpperCase().replace(/[^A-Z0-9]/g, '');
  const likeTerm = `%${query.replace(/[%_]/g, '')}%`;
  const matches: SQL[] = [like(registrations.fullName, likeTerm)];
  if (CODE_PATTERN.test(query)) {
    matches.push(eq(registrations.id, query.toLowerCase()));
  }
  if (normalized.length >= 4) {
    matches.push(eq(registrations.documentNumber, normalized));
  }

  const titularRows = await db
    .select({ id: registrations.id })
    .from(registrations)
    .innerJoin(eventEstablishments, eq(eventEstablishments.id, registrations.participationId))
    .where(
      and(
        eq(eventEstablishments.eventId, input.eventId),
        eq(registrations.status, 'confirmed'),
        or(...matches),
      ),
    )
    .limit(8);

  const companionMatches: SQL[] = [like(registrationCompanions.fullName, likeTerm)];
  if (normalized.length >= 4) {
    companionMatches.push(eq(registrationCompanions.documentNumber, normalized));
  }

  const companionRows = await db
    .select({ id: registrations.id })
    .from(registrationCompanions)
    .innerJoin(registrations, eq(registrations.id, registrationCompanions.registrationId))
    .innerJoin(eventEstablishments, eq(eventEstablishments.id, registrations.participationId))
    .where(
      and(
        eq(eventEstablishments.eventId, input.eventId),
        eq(registrations.status, 'confirmed'),
        or(...companionMatches),
      ),
    )
    .limit(8);

  const rows = [...titularRows, ...companionRows];

  const ids = [...new Set(rows.map((row) => row.id))];
  const results: LookupTicketResult[] = [];
  for (const id of ids) {
    results.push(await lookupTicket(db, id));
  }
  return results;
}

export async function scanTicket(
  db: Database,
  input: ScanTicketInput,
  now: Date = new Date(),
): Promise<ScanTicketResult> {
  const ticket = await resolveReadyTicket(db, input.code);
  const { registration } = ticket;
  const companions = await listCompanions(db, registration.id);
  const presentIds = uniqueIds(input.presentCompanionIds);
  const releaseIds = uniqueIds(input.releaseCompanionIds ?? []);
  assertKnownCompanions(companions, [...presentIds, ...releaseIds]);

  const existing = await listTurns(db, registration.id);
  const holderTurned = existing.some((turn) => turn.position === 0);

  if (holderTurned) {
    return continueAttendance(db, ticket, companions, existing, presentIds, releaseIds, input.actorId, now);
  }

  if (!input.holderPresent) {
    throw AppError.conflict(
      ErrorCode.CHECK_IN_HOLDER_ABSENT,
      'El titular no esta presente; el codigo es suyo y no se asigna turno.',
    );
  }

  const present = companions.filter((companion) => presentIds.includes(companion.id));
  const assigned = await assignTurns(
    db,
    {
      participationId: ticket.participationId,
      registrationId: registration.id,
      assignedBy: input.actorId,
      people: [
        { position: 0, fullName: registration.fullName, companionId: null },
        ...present.map((companion, index) => ({
          position: index + 1,
          fullName: companion.fullName,
          companionId: companion.id,
        })),
      ],
    },
    now,
  );

  if (assigned === null) {
    return continueAttendance(
      db,
      ticket,
      companions,
      await listTurns(db, registration.id),
      presentIds,
      releaseIds,
      input.actorId,
      now,
    );
  }

  const released = await releaseExplicit(db, ticket, companions, releaseIds, now);
  return {
    ticket,
    turns: assigned,
    alreadyAssigned: false,
    releasedCompanionsCount: released,
  };
}

async function continueAttendance(
  db: Database,
  ticket: TicketContext,
  companions: readonly RegistrationCompanionRow[],
  existing: readonly TurnRow[],
  presentIds: readonly string[],
  releaseIds: readonly string[],
  actorId: string | null,
  now: Date,
): Promise<ScanTicketResult> {
  const checked = new Set(existing.map((turn) => turn.companionId).filter((id): id is string => id !== null));
  const arriving = companions.filter(
    (companion) => presentIds.includes(companion.id) && !checked.has(companion.id),
  );
  const maxPosition = existing.reduce((max, turn) => Math.max(max, turn.position), 0);

  let turns = [...existing];
  if (arriving.length > 0) {
    const extra = await assignTurns(
      db,
      {
        participationId: ticket.participationId,
        registrationId: ticket.registration.id,
        assignedBy: actorId,
        people: arriving.map((companion, index) => ({
          position: maxPosition + 1 + index,
          fullName: companion.fullName,
          companionId: companion.id,
        })),
      },
      now,
    );
    if (extra) {
      turns = [...existing, ...extra];
    } else {
      turns = await listTurns(db, ticket.registration.id);
    }
  }

  const remaining = companions.filter((companion) => !checked.has(companion.id) && !arriving.some((item) => item.id === companion.id));
  const released = await releaseExplicit(db, ticket, remaining, releaseIds, now);

  return {
    ticket,
    turns,
    alreadyAssigned: arriving.length === 0,
    releasedCompanionsCount: released,
  };
}

async function releaseExplicit(
  db: Database,
  ticket: TicketContext,
  companions: readonly RegistrationCompanionRow[],
  releaseIds: readonly string[],
  now: Date,
): Promise<number> {
  const noShows = companions.filter((companion) => releaseIds.includes(companion.id));
  if (noShows.length === 0) {
    return 0;
  }
  await releaseNoShowCompanions(
    db,
    {
      participationId: ticket.participationId,
      registrationId: ticket.registration.id,
      companions: noShows,
    },
    now,
  );
  return noShows.length;
}

function assertKnownCompanions(
  companions: readonly RegistrationCompanionRow[],
  ids: readonly string[],
): void {
  const known = new Set(companions.map((companion) => companion.id));
  const unknown = ids.filter((id) => !known.has(id));
  if (unknown.length > 0) {
    throw AppError.unprocessable(
      ErrorCode.VALIDATION_ERROR,
      'Hay acompanantes que no pertenecen a esta inscripcion.',
      { details: { field: 'presentCompanionIds', unknown } },
    );
  }
}

async function resolveReadyTicket(db: Database, rawCode: string): Promise<TicketContext> {
  const code = rawCode.trim().toLowerCase();
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

  return ticket;
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

function uniqueIds(ids: readonly string[]): string[] {
  return [...new Set(ids.map((id) => id.trim()).filter((id) => id.length > 0))];
}

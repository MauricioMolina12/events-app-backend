import { AppError } from '../../core/errors/app-error';
import { ErrorCode } from '../../core/errors/error-codes';
import { clampLimit, clampOffset, type PaginationLimits } from '../../core/http/pagination';
import type { Database } from '../../db/client';
import {
  getActiveClientBySlug,
  listVisibleClients,
  toPublicClient,
} from '../clients/clients.service';
import type { EstablishmentRow } from '../establishments/establishments.repository';
import { listEstablishmentSummaries } from '../establishments/establishments.service';
import type { EventRow } from '../events/events.repository';
import { getEventByReference, listEventCatalog } from '../events/events.service';
import type { ParticipationRow } from '../participations/participations.repository';
import { listParticipationsByEvents } from '../participations/participations.service';
import {
  addCompanionsToRegistration,
  createRegistration,
  findHolderRegistration,
  getRegistrationDetail,
  type AddCompanionsCommand,
  type CreateRegistrationCommand,
  type HolderCredentials,
  type RegistrationDetail,
} from '../registrations/registrations.service';
import type { RegistrationRow } from '../registrations/registrations.repository';
import {
  toPublicEvent,
  toPublicParticipation,
  type PublicEvent,
  type PublicParticipation,
} from './public.schemas';

/**
 * Composicion del catalogo publico.
 *
 * Es el unico modulo que lee datos sin autenticacion, y por eso solo compone
 * servicios ya existentes (eventos, participaciones, sedes, registros): no abre
 * camino nuevo a la base de datos ni duplica reglas.
 *
 * El alcance es deliberadamente estrecho. Se ofrecen los eventos publicados con sus
 * sedes abiertas y la disponibilidad derivada, porque es lo que el formulario
 * necesita; quedan fuera los borradores, las sedes cerradas y todo lo operativo.
 */

export const PUBLIC_EVENT_LIST_DEFAULT_LIMIT = 10;
export const PUBLIC_EVENT_LIST_MAX_LIMIT = 50;

/** Reglas de paginacion del catalogo publico: mas cortas que las del panel. */
const PUBLIC_EVENT_PAGE_LIMITS: PaginationLimits = {
  defaultLimit: PUBLIC_EVENT_LIST_DEFAULT_LIMIT,
  maxLimit: PUBLIC_EVENT_LIST_MAX_LIMIT,
};

export interface PublicEventListQuery {
  /** Texto libre buscado en el nombre y el slug del evento. */
  readonly search?: string;
  readonly limit?: number;
  readonly offset?: number;
  readonly clientId?: string;
}

export interface PublicEventPage {
  readonly items: readonly PublicEvent[];
  readonly total: number;
  /** Tamano de pagina realmente aplicado, tras acotar el solicitado. */
  readonly limit: number;
  readonly offset: number;
}

/**
 * Eventos publicados, con sus sedes abiertas y el cupo disponible.
 *
 * Solo entra lo que se puede inscribir hoy: eventos `published` y participaciones
 * `open`. Si un evento queda sin sedes abiertas se devuelve igual, con la lista
 * vacia: es informacion util para quien consulta antes de la apertura.
 */
export async function listPublicEvents(
  db: Database,
  query: PublicEventListQuery = {},
  now: Date = new Date(),
): Promise<PublicEventPage> {
  const limit = clampLimit(query.limit, PUBLIC_EVENT_PAGE_LIMITS);
  const offset = clampOffset(query.offset);
  const page = await listEventCatalog(db, {
    status: 'published',
    search: query.search,
    clientId: query.clientId,
    limit,
    offset,
  });

  return {
    items: await withPublicParticipations(db, page.items, now),
    total: page.total,
    limit: page.limit,
    offset: page.offset,
  };
}

/**
 * Ficha publica de un evento, por `slug` o por identificador.
 *
 * Un evento que no esta publicado responde 404 y no 403: desde fuera no debe
 * distinguirse "existe pero no se puede ver" de "no existe".
 */
export async function getPublicEvent(
  db: Database,
  reference: string,
  now: Date = new Date(),
): Promise<PublicEvent> {
  const event = await getEventByReference(db, reference);

  if (event.status !== 'published') {
    throw AppError.notFound(ErrorCode.EVENT_NOT_FOUND, 'El evento no existe o no esta publicado.', {
      details: { reference },
    });
  }

  const participations = await publicParticipationsByEvent(db, [event], now);

  return toPublicEvent(event, participations.get(event.id) ?? []);
}

export async function listPublicClientDirectory(db: Database) {
  return (await listVisibleClients(db)).map((row) => toPublicClient(row));
}

export async function listPublicClientEvents(
  db: Database,
  slug: string,
  query: PublicEventListQuery = {},
  now: Date = new Date(),
): Promise<PublicEventPage> {
  const client = await getActiveClientBySlug(db, slug);
  return listPublicEvents(db, { ...query, clientId: client.id }, now);
}

/**
 * Alta desde el formulario publico.
 *
 * Es la misma operacion que la mesa de registro ejecuta a mano: mismas validaciones,
 * misma reserva de cupo y mismos errores. Lo unico propio es la marca de origen.
 */
export async function registerPublicAttendance(
  db: Database,
  command: CreateRegistrationCommand,
  now: Date = new Date(),
): Promise<RegistrationDetail> {
  return createRegistration(db, { ...command, source: 'public' }, now);
}

/** Registro del titular que se identifica con evento, documento y correo. */
export async function lookupHolderRegistration(
  db: Database,
  credentials: HolderCredentials,
): Promise<RegistrationRow> {
  return (await findHolderRegistration(db, credentials)).registration;
}

/** Acompanantes agregados despues del alta, por el propio titular. */
export async function addPublicCompanions(
  db: Database,
  command: AddCompanionsCommand,
  now: Date = new Date(),
): Promise<RegistrationDetail> {
  return addCompanionsToRegistration(db, command, now);
}

/**
 * Recibo publico de un folio. Un id desconocido responde 404: no se distingue
 * "cancelado" de "nunca existio" mas alla del `status` cuando si existe.
 */
export async function getPublicRegistration(
  db: Database,
  id: string,
): Promise<RegistrationDetail> {
  return getRegistrationDetail(db, id);
}

export async function searchPublicRegistrations(
  db: Database,
  input: { event: string; query: string },
): Promise<RegistrationDetail[]> {
  const query = input.query.trim();
  if (query.length < 2) {
    return [];
  }
  const event = await getEventByReference(db, input.event);
  if (event.status !== 'published') {
    throw AppError.notFound(ErrorCode.EVENT_NOT_FOUND, 'El evento no existe.', {
      details: { event: input.event },
    });
  }
  const { searchTickets } = await import('../check-in/check-in.service');
  const hits = await searchTickets(db, { eventId: event.id, query });
  const details: RegistrationDetail[] = [];
  for (const hit of hits) {
    details.push(await getRegistrationDetail(db, hit.ticket.registration.id));
  }
  return details;
}

/** Cada evento con las sedes abiertas que le corresponden, ya mapeadas. */
async function withPublicParticipations(
  db: Database,
  events: readonly EventRow[],
  now: Date,
): Promise<PublicEvent[]> {
  const participations = await publicParticipationsByEvent(db, events, now);

  return events.map((event) => toPublicEvent(event, participations.get(event.id) ?? []));
}

/**
 * Sedes abiertas de una pagina de eventos, agrupadas por evento.
 *
 * Se resuelve con una consulta por lote (participaciones) y otra por lote (sedes):
 * el catalogo publico es la lectura mas expuesta del sistema y no puede caer en una
 * consulta por evento.
 */
async function publicParticipationsByEvent(
  db: Database,
  events: readonly EventRow[],
  now: Date,
): Promise<Map<string, PublicParticipation[]>> {
  const grouped = new Map<string, PublicParticipation[]>();

  if (events.length === 0) {
    return grouped;
  }

  const participations = await listParticipationsByEvents(
    db,
    events.map((event) => event.id),
    { status: 'open' },
  );
  const establishments = await establishmentIndex(db, participations);
  const eventsById = new Map(events.map((event) => [event.id, event]));

  for (const participation of participations) {
    const event = eventsById.get(participation.eventId);
    const establishment = establishments.get(participation.establishmentId);

    // Una sede apagada no se ofrece, pero tampoco rompe el catalogo: se omite.
    if (event === undefined || establishment === undefined || establishment.status !== 'active') {
      continue;
    }

    const current = grouped.get(event.id) ?? [];
    current.push(toPublicParticipation(participation, establishment, event, now));
    grouped.set(event.id, current);
  }

  return grouped;
}

/** Sedes de una pagina de participaciones, en una sola consulta por lote. */
async function establishmentIndex(
  db: Database,
  participations: readonly ParticipationRow[],
): Promise<Map<string, EstablishmentRow>> {
  const ids = [...new Set(participations.map((participation) => participation.establishmentId))];

  if (ids.length === 0) {
    return new Map();
  }

  const establishments = await listEstablishmentSummaries(db, ids);

  return new Map(establishments.map((establishment) => [establishment.id, establishment]));
}
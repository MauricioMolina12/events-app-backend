import { describe, expect, it } from 'vitest';
import { AppError } from '../../src/core/errors/app-error';
import { ErrorCode } from '../../src/core/errors/error-codes';
import { clampLimit, clampOffset } from '../../src/core/http/pagination';
import type { EstablishmentRow } from '../../src/modules/establishments/establishments.repository';
import {
  toEstablishment,
  toEstablishmentSummary,
} from '../../src/modules/establishments/establishments.schemas';
import type { EventRow } from '../../src/modules/events/events.repository';
import { toEvent } from '../../src/modules/events/events.schemas';
import {
  EVENT_STATUS_TRANSITIONS,
  assertEventStatusTransition,
  assertTimezone,
  assertWindowCoherent as assertEventWindow,
} from '../../src/modules/events/events.service';
import type { ParticipationRow } from '../../src/modules/participations/participations.repository';
import { toParticipation } from '../../src/modules/participations/participations.schemas';
import {
  PARTICIPATION_STATUS_TRANSITIONS,
  assertParticipationStatusTransition,
  assertWindowCoherent as assertParticipationWindow,
} from '../../src/modules/participations/participations.service';

/**
 * Pruebas puras del catalogo (eventos, sedes y participaciones).
 *
 * Las transiciones de estado, la validacion de zonas y ventanas y los mapeos a la
 * ficha publica no dependen de D1: se ejercitan aqui para que un cambio en las
 * reglas o en los campos expuestos falle sin levantar el runtime.
 */

/** Captura el error sincrono que lanza `action`, o `null` si no lanzo. */
function capturedError(action: () => void): unknown {
  try {
    action();
    return null;
  } catch (error) {
    return error;
  }
}

const EVENT_ROW: EventRow = {
  id: 'event-1',
  slug: 'feria-2026',
  name: 'Feria 2026',
  description: null,
  timezone: 'America/Bogota',
  startsAt: new Date('2026-04-25T15:00:00.000Z'),
  endsAt: null,
  registrationOpensAt: null,
  registrationClosesAt: null,
  status: 'published',
  createdBy: 'user-1',
  createdAt: new Date('2026-01-01T10:00:00.000Z'),
  updatedAt: new Date('2026-01-02T10:00:00.000Z'),
};

const ESTABLISHMENT_ROW: EstablishmentRow = {
  id: 'establishment-1',
  code: 'sede-norte',
  name: 'Sede Norte',
  city: 'Bogota',
  address: null,
  status: 'active',
  createdAt: new Date('2026-01-01T10:00:00.000Z'),
  updatedAt: new Date('2026-01-02T10:00:00.000Z'),
};

const PARTICIPATION_ROW: ParticipationRow = {
  id: 'participation-1',
  eventId: 'event-1',
  establishmentId: 'establishment-1',
  status: 'open',
  titularCapacity: 10,
  companionCapacity: 4,
  confirmedTitulares: 3,
  confirmedCompanions: 4,
  registrationOpensAt: new Date('2026-04-01T12:00:00.000Z'),
  registrationClosesAt: null,
  checkInOpensAt: null,
  checkInClosesAt: null,
  notes: null,
  createdAt: new Date('2026-01-01T10:00:00.000Z'),
  updatedAt: new Date('2026-01-02T10:00:00.000Z'),
};

describe('transiciones de estado', () => {
  it('admite los pasos del ciclo de vida y el no-op', () => {
    expect(capturedError(() => assertEventStatusTransition('draft', 'published'))).toBeNull();
    expect(capturedError(() => assertEventStatusTransition('closed', 'published'))).toBeNull();
    expect(capturedError(() => assertEventStatusTransition('published', 'published'))).toBeNull();
    expect(capturedError(() => assertParticipationStatusTransition('open', 'closed'))).toBeNull();
    expect(capturedError(() => assertParticipationStatusTransition('closed', 'cancelled'))).toBeNull();
  });

  it('rechaza los saltos no permitidos con STATUS_TRANSITION_INVALID', () => {
    const eventError = capturedError(() => assertEventStatusTransition('archived', 'draft'));
    expect(eventError).toBeInstanceOf(AppError);
    expect((eventError as AppError).code).toBe(ErrorCode.STATUS_TRANSITION_INVALID);
    expect((eventError as AppError).status).toBe(409);

    const participationError = capturedError(() =>
      assertParticipationStatusTransition('cancelled', 'open'),
    );
    expect((participationError as AppError).code).toBe(ErrorCode.STATUS_TRANSITION_INVALID);
  });

  it('declara `archived` y `cancelled` como estados terminales', () => {
    expect(EVENT_STATUS_TRANSITIONS.archived).toEqual([]);
    expect(PARTICIPATION_STATUS_TRANSITIONS.cancelled).toEqual([]);
  });
});

describe('validacion de zonas y ventanas', () => {
  it('acepta una zona IANA valida y rechaza una inexistente', () => {
    expect(capturedError(() => assertTimezone('America/Bogota'))).toBeNull();
    expect(capturedError(() => assertTimezone(undefined))).toBeNull();

    const error = capturedError(() => assertTimezone('Marte/Olympus'));
    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).code).toBe(ErrorCode.VALIDATION_ERROR);
    expect((error as AppError).status).toBe(422);
  });

  it('rechaza una ventana invertida y tolera los extremos ausentes', () => {
    expect(
      capturedError(() =>
        assertEventWindow({
          startsAt: new Date('2026-04-25T15:00:00.000Z'),
          endsAt: new Date('2026-04-24T15:00:00.000Z'),
        }),
      ),
    ).toBeInstanceOf(AppError);

    expect(
      capturedError(() =>
        assertEventWindow({
          startsAt: new Date('2026-04-25T15:00:00.000Z'),
          endsAt: new Date('2026-04-26T15:00:00.000Z'),
          registrationOpensAt: null,
          registrationClosesAt: null,
        }),
      ),
    ).toBeNull();

    expect(
      capturedError(() =>
        assertParticipationWindow({
          checkInOpensAt: new Date('2026-04-25T18:00:00.000Z'),
          checkInClosesAt: new Date('2026-04-25T17:00:00.000Z'),
        }),
      ),
    ).toBeInstanceOf(AppError);
  });
});

describe('mapeos de presentacion', () => {
  it('expone el evento con las fechas en ISO-8601', () => {
    expect(toEvent(EVENT_ROW)).toEqual({
      id: 'event-1',
      slug: 'feria-2026',
      name: 'Feria 2026',
      description: null,
      timezone: 'America/Bogota',
      startsAt: '2026-04-25T15:00:00.000Z',
      endsAt: null,
      registrationOpensAt: null,
      registrationClosesAt: null,
      status: 'published',
      createdBy: 'user-1',
      createdAt: '2026-01-01T10:00:00.000Z',
      updatedAt: '2026-01-02T10:00:00.000Z',
    });
  });

  it('expone la sede completa y su resumen', () => {
    expect(toEstablishment(ESTABLISHMENT_ROW).code).toBe('sede-norte');
    expect(toEstablishmentSummary(ESTABLISHMENT_ROW)).toEqual({
      id: 'establishment-1',
      code: 'sede-norte',
      name: 'Sede Norte',
      city: 'Bogota',
      status: 'active',
    });
  });

  it('calcula el cupo disponible de la participacion', () => {
    const view = toParticipation(PARTICIPATION_ROW, toEstablishmentSummary(ESTABLISHMENT_ROW));

    expect(view.availableTitulares).toBe(7);
    expect(view.availableCompanions).toBe(0);
    expect(view.registrationOpensAt).toBe('2026-04-01T12:00:00.000Z');
    expect(view.registrationClosesAt).toBeNull();
    expect(view.establishment.code).toBe('sede-norte');
  });
});

describe('paginacion compartida', () => {
  const limits = { defaultLimit: 20, maxLimit: 100 };

  it('aplica el defecto, el tope y el minimo', () => {
    expect(clampLimit(undefined, limits)).toBe(20);
    expect(clampLimit(5, limits)).toBe(5);
    expect(clampLimit(500, limits)).toBe(100);
    expect(clampLimit(0, limits)).toBe(1);
  });

  it('trata un desplazamiento negativo como cero', () => {
    expect(clampOffset(undefined)).toBe(0);
    expect(clampOffset(-5)).toBe(0);
    expect(clampOffset(7)).toBe(7);
  });
});

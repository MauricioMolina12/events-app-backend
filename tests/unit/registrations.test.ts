import { describe, expect, it } from 'vitest';
import { AppError } from '../../src/core/errors/app-error';
import { ErrorCode } from '../../src/core/errors/error-codes';
import type { EstablishmentRow } from '../../src/modules/establishments/establishments.repository';
import type { EventRow } from '../../src/modules/events/events.repository';
import type { ParticipationRow } from '../../src/modules/participations/participations.repository';
import {
  toPublicEstablishment,
  toPublicEvent,
  toPublicParticipation,
  toPublicRegistrationReceipt,
} from '../../src/modules/public/public.schemas';
import type { RegistrationRow } from '../../src/modules/registrations/registrations.repository';
import { MAX_COMPANIONS_PER_REGISTRATION } from '../../src/modules/registrations/registrations.schemas';
import {
  assertDocumentNumber,
  assertEventPublished,
  assertParticipationAcceptsRegistrations,
  assertRegistrationWindow,
  collectRequestDocuments,
  duplicateDocumentError,
  effectiveRegistrationWindow,
  isWithinRegistrationWindow,
  normalizeCompanions,
  normalizeDocumentNumber,
  resolveDuplicateDocument,
  type NormalizedCompanion,
} from '../../src/modules/registrations/registrations.service';

/**
 * Pruebas puras del alta de registros y de la ficha publica.
 *
 * La normalizacion del documento, la validacion de acompanantes, la ventana
 * efectiva y las precondiciones de estado no dependen de D1: se ejercitan aqui
 * para que un cambio en las reglas o en los campos expuestos falle sin levantar
 * el runtime. La ficha publica se arma con los mismos mapeos que usa la API, de
 * modo que no pueda decir "abierto" cuando el alta responderia
 * `REGISTRATION_OUTSIDE_WINDOW`.
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
  capacity: 100,
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
  confirmedCompanions: 1,
  registrationOpensAt: null,
  registrationClosesAt: null,
  checkInOpensAt: null,
  checkInClosesAt: null,
  notes: null,
  createdAt: new Date('2026-01-01T10:00:00.000Z'),
  updatedAt: new Date('2026-01-02T10:00:00.000Z'),
};

const REGISTRATION_ROW: RegistrationRow = {
  id: 'registration-1',
  participationId: 'participation-1',
  documentType: 'CC',
  documentNumber: '10203040',
  fullName: 'Ana Perez',
  email: 'ana@example.com',
  phone: null,
  companionsCount: 2,
  status: 'confirmed',
  source: 'public',
  registeredAt: new Date('2026-01-03T10:00:00.000Z'),
  cancelledAt: null,
  cancelledReason: null,
  createdAt: new Date('2026-01-03T10:00:00.000Z'),
  updatedAt: new Date('2026-01-03T10:00:00.000Z'),
};

/** Ventana vigente de la ficha publica y el instante en el que se consulta. */
const EVENT_WINDOW = {
  registrationOpensAt: new Date('2026-04-01T00:00:00.000Z'),
  registrationClosesAt: new Date('2026-04-10T00:00:00.000Z'),
};
const INSIDE_WINDOW = new Date('2026-04-02T00:00:00.000Z');

describe('normalizacion del documento', () => {
  it('quita los separadores de lectura y pasa a mayusculas', () => {
    expect(normalizeDocumentNumber(' 1.020-304 000 ')).toBe('1020304000');
    expect(normalizeDocumentNumber('cc 12.34-5')).toBe('CC12345');
  });

  it('acepta el documento ya normalizado y rechaza lo que no puede serlo', () => {
    expect(capturedError(() => assertDocumentNumber('1020304000'))).toBeNull();
    expect(capturedError(() => assertDocumentNumber('AB1234'))).toBeNull();

    const tooShort = capturedError(() => assertDocumentNumber('123'));
    expect(tooShort).toBeInstanceOf(AppError);
    expect((tooShort as AppError).code).toBe(ErrorCode.VALIDATION_ERROR);
    expect((tooShort as AppError).status).toBe(422);

    // El formato se comprueba despues de normalizar: los puntos ya no existen.
    expect(capturedError(() => assertDocumentNumber('1.020.304.000'))).toBeInstanceOf(AppError);
  });
});

describe('normalizacion de acompanantes', () => {
  it('normaliza el documento y admite acompanantes sin documento', () => {
    const companions = normalizeCompanions([
      { fullName: ' Luis Perez ', documentType: 'TI', documentNumber: '99.001' },
      { fullName: 'Sofia Perez' },
    ]);

    expect(companions).toEqual([
      { fullName: 'Luis Perez', documentType: 'TI', documentNumber: '99001' },
      { fullName: 'Sofia Perez', documentType: null, documentNumber: null },
    ]);
  });

  it('rechaza un documento a medias', () => {
    const withoutNumber = capturedError(() =>
      normalizeCompanions([{ fullName: 'Luis Perez', documentType: 'TI' }]),
    );

    expect(withoutNumber).toBeInstanceOf(AppError);
    expect((withoutNumber as AppError).code).toBe(ErrorCode.VALIDATION_ERROR);
    expect((withoutNumber as AppError).status).toBe(422);

    expect(
      capturedError(() =>
        normalizeCompanions([{ fullName: 'Luis Perez', documentNumber: '99001' }]),
      ),
    ).toBeInstanceOf(AppError);
  });

  it('rechaza que el titular figure tambien como acompanante', () => {
    const error = capturedError(() =>
      normalizeCompanions(
        [{ fullName: 'Ana Perez', documentType: 'CC', documentNumber: '10203040' }],
        { documentType: 'CC', documentNumber: '10203040' },
      ),
    );

    expect((error as AppError).code).toBe(ErrorCode.VALIDATION_ERROR);
    expect((error as AppError).details).toMatchObject({
      field: 'companions[0].documentNumber',
    });
  });

  it('rechaza documentos repetidos entre acompanantes', () => {
    const error = capturedError(() =>
      normalizeCompanions([
        { fullName: 'Luis Perez', documentType: 'TI', documentNumber: '5555' },
        { fullName: 'Otro Luis', documentType: 'TI', documentNumber: '5.555' },
      ]),
    );

    expect((error as AppError).code).toBe(ErrorCode.VALIDATION_ERROR);
  });

  it('acota el numero de acompanantes por registro', () => {
    const companions = Array.from(
      { length: MAX_COMPANIONS_PER_REGISTRATION + 1 },
      (_, index) => ({ fullName: `Acompanante ${index}` }),
    );

    const error = capturedError(() => normalizeCompanions(companions));

    expect((error as AppError).code).toBe(ErrorCode.VALIDATION_ERROR);
    expect((error as AppError).status).toBe(422);
  });
});

describe('ventana efectiva de registro', () => {
  const eventWindow = {
    registrationOpensAt: new Date('2026-04-01T00:00:00.000Z'),
    registrationClosesAt: new Date('2026-04-10T00:00:00.000Z'),
  };
  const participationWindow = {
    registrationOpensAt: new Date('2026-04-05T00:00:00.000Z'),
    registrationClosesAt: null,
  };

  it('la sede sobrescribe la ventana del evento y hereda los extremos que no define', () => {
    expect(effectiveRegistrationWindow(eventWindow, participationWindow)).toEqual({
      opensAt: participationWindow.registrationOpensAt,
      closesAt: eventWindow.registrationClosesAt,
    });

    expect(
      effectiveRegistrationWindow(eventWindow, {
        registrationOpensAt: null,
        registrationClosesAt: participationWindow.registrationOpensAt,
      }),
    ).toEqual({
      opensAt: eventWindow.registrationOpensAt,
      closesAt: participationWindow.registrationOpensAt,
    });
  });

  it('sin ventana en ninguno de los dos el registro solo depende del estado', () => {
    expect(
      effectiveRegistrationWindow(
        { registrationOpensAt: null, registrationClosesAt: null },
        { registrationOpensAt: null, registrationClosesAt: null },
      ),
    ).toEqual({ opensAt: null, closesAt: null });
  });

  it('solo acepta un instante dentro de la ventana', () => {
    const window = {
      opensAt: eventWindow.registrationOpensAt,
      closesAt: eventWindow.registrationClosesAt,
    };

    expect(isWithinRegistrationWindow(window, INSIDE_WINDOW)).toBe(true);
    expect(isWithinRegistrationWindow(window, new Date('2026-03-31T23:59:59.000Z'))).toBe(false);
    expect(isWithinRegistrationWindow(window, new Date('2026-04-10T00:00:01.000Z'))).toBe(false);

    // Un extremo ausente no filtra.
    expect(isWithinRegistrationWindow({ opensAt: null, closesAt: null }, INSIDE_WINDOW)).toBe(true);
  });

  it('fuera de la ventana el alta se rechaza con 409 y sus extremos', () => {
    const window = { opensAt: null, closesAt: eventWindow.registrationClosesAt };
    const outside = new Date('2026-04-11T00:00:00.000Z');

    const error = capturedError(() => assertRegistrationWindow(window, outside));

    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).code).toBe(ErrorCode.REGISTRATION_OUTSIDE_WINDOW);
    expect((error as AppError).status).toBe(409);
    expect((error as AppError).details).toEqual({
      opensAt: null,
      closesAt: '2026-04-10T00:00:00.000Z',
      now: '2026-04-11T00:00:00.000Z',
    });

    expect(capturedError(() => assertRegistrationWindow(window, INSIDE_WINDOW))).toBeNull();
  });
});

describe('precondiciones de estado del alta', () => {
  it('solo los eventos publicados admiten registros', () => {
    expect(capturedError(() => assertEventPublished('published'))).toBeNull();

    for (const status of ['draft', 'closed', 'archived'] as const) {
      const error = capturedError(() => assertEventPublished(status));

      expect(error).toBeInstanceOf(AppError);
      expect((error as AppError).code).toBe(ErrorCode.EVENT_NOT_REGISTRABLE);
      expect((error as AppError).status).toBe(409);
      expect((error as AppError).details).toEqual({ status });
    }
  });

  it('la sede debe estar abierta y su establecimiento activo', () => {
    expect(capturedError(() => assertParticipationAcceptsRegistrations('open', 'active'))).toBeNull();

    for (const [status, establishmentStatus] of [
      ['closed', 'active'],
      ['cancelled', 'active'],
      ['open', 'inactive'],
    ] as const) {
      const error = capturedError(() =>
        assertParticipationAcceptsRegistrations(status, establishmentStatus),
      );

      expect(error).toBeInstanceOf(AppError);
      expect((error as AppError).code).toBe(ErrorCode.PARTICIPATION_CLOSED);
      expect((error as AppError).status).toBe(409);
      expect((error as AppError).details).toEqual({ status, establishmentStatus });
    }
  });
});

describe('unicidad de documentos dentro del evento', () => {
  const COMPANIONS: NormalizedCompanion[] = [
    { fullName: 'Luis Perez', documentType: 'TI', documentNumber: '99001' },
    { fullName: 'Sofia Perez', documentType: null, documentNumber: null },
  ];
  const REGISTERED_HOLDER = {
    documentType: 'CC' as const,
    documentNumber: '10203040',
    role: 'holder' as const,
  };

  it('reune el documento del titular y los de sus acompanantes, con su campo', () => {
    expect(collectRequestDocuments('CC', '10203040', COMPANIONS)).toEqual([
      { role: 'holder', documentType: 'CC', documentNumber: '10203040', field: 'documentNumber' },
      {
        role: 'companion',
        documentType: 'TI',
        documentNumber: '99001',
        field: 'companions[0].documentNumber',
      },
    ]);
  });

  it('no incluye a los acompanantes sin documento: no hay dato que comparar', () => {
    expect(collectRequestDocuments('CC', '10203040', [COMPANIONS[1] as NormalizedCompanion])).toHaveLength(
      1,
    );
  });

  it('resuelve el conflicto en el orden de la solicitud, no en el de la base', () => {
    const requested = collectRequestDocuments('CC', '10203040', COMPANIONS);
    const registered = [
      { documentType: 'TI' as const, documentNumber: '99001', role: 'companion' as const },
      REGISTERED_HOLDER,
    ];

    // El titular manda aunque la base haya devuelto primero el acompanante.
    expect(resolveDuplicateDocument(requested, registered)).toEqual({
      document: '10203040',
      role: 'holder',
      registeredAs: 'holder',
      field: 'documentNumber',
    });
  });

  it('detecta el documento del acompanante y lo ubica en su campo', () => {
    const requested = collectRequestDocuments('CC', '55667788', COMPANIONS);

    expect(
      resolveDuplicateDocument(requested, [
        { documentType: 'TI', documentNumber: '99001', role: 'companion' },
      ]),
    ).toEqual({
      document: '99001',
      role: 'companion',
      registeredAs: 'companion',
      field: 'companions[0].documentNumber',
    });
  });

  it('no hay conflicto si ningun documento de la solicitud esta ocupado', () => {
    expect(resolveDuplicateDocument(collectRequestDocuments('CC', '10203040'), [])).toBeNull();
    expect(
      resolveDuplicateDocument(collectRequestDocuments('CC', '10203040'), [
        { documentType: 'CC', documentNumber: '99887766', role: 'holder' },
      ]),
    ).toBeNull();
  });

  it('el mensaje depende del rol con el que el documento ya existe', () => {
    const asHolder = duplicateDocumentError({
      document: '10203040',
      role: 'holder',
      registeredAs: 'holder',
      field: 'documentNumber',
    });

    expect(asHolder.code).toBe(ErrorCode.DUPLICATE_DOCUMENT);
    expect(asHolder.status).toBe(409);
    expect(asHolder.message).toBe('El documento ingresado ya se encuentra registrado en este evento.');
    expect(asHolder.details).toEqual({
      document: '10203040',
      role: 'holder',
      registeredAs: 'holder',
      field: 'documentNumber',
    });

    const asCompanion = duplicateDocumentError({
      document: '99001',
      role: 'holder',
      registeredAs: 'companion',
      field: 'documentNumber',
    });

    expect(asCompanion.message).toBe(
      'Este documento ya esta registrado como acompanante de otra persona.',
    );
  });
});

describe('ficha publica del catalogo', () => {
  it('expone la sede con lo necesario para llegar a ella', () => {
    expect(toPublicEstablishment(ESTABLISHMENT_ROW)).toEqual({
      id: 'establishment-1',
      name: 'Sede Norte',
      city: 'Bogota',
    });
  });

  it('calcula la disponibilidad y resume la apertura del registro', () => {
    const view = toPublicParticipation(
      PARTICIPATION_ROW,
      ESTABLISHMENT_ROW,
      EVENT_WINDOW,
      INSIDE_WINDOW,
    );

    expect(view.availableTitulares).toBe(7);
    expect(view.availableCompanions).toBe(3);
    expect(view.registrationOpensAt).toBe('2026-04-01T00:00:00.000Z');
    expect(view.registrationClosesAt).toBe('2026-04-10T00:00:00.000Z');
    expect(view.registrationOpen).toBe(true);
    expect(view.establishment.name).toBe('Sede Norte');
  });

  it('registrationOpen exige sede abierta, establecimiento activo y ventana vigente', () => {
    const closedParticipation = { ...PARTICIPATION_ROW, status: 'closed' as const };
    const inactiveEstablishment = { ...ESTABLISHMENT_ROW, status: 'inactive' as const };
    const afterWindow = new Date('2026-04-11T00:00:00.000Z');

    expect(
      toPublicParticipation(closedParticipation, ESTABLISHMENT_ROW, EVENT_WINDOW, INSIDE_WINDOW)
        .registrationOpen,
    ).toBe(false);
    expect(
      toPublicParticipation(PARTICIPATION_ROW, inactiveEstablishment, EVENT_WINDOW, INSIDE_WINDOW)
        .registrationOpen,
    ).toBe(false);
    expect(
      toPublicParticipation(PARTICIPATION_ROW, ESTABLISHMENT_ROW, EVENT_WINDOW, afterWindow)
        .registrationOpen,
    ).toBe(false);
  });

  it('el evento publico no expone estados internos ni auditoria', () => {
    const participation = toPublicParticipation(
      PARTICIPATION_ROW,
      ESTABLISHMENT_ROW,
      EVENT_WINDOW,
      INSIDE_WINDOW,
    );
    const view = toPublicEvent(EVENT_ROW, [participation]);

    expect(view).toEqual({
      id: 'event-1',
      slug: 'feria-2026',
      name: 'Feria 2026',
      description: null,
      timezone: 'America/Bogota',
      startsAt: '2026-04-25T15:00:00.000Z',
      endsAt: null,
      registrationOpensAt: null,
      registrationClosesAt: null,
      participations: [participation],
    });
    expect(view).not.toHaveProperty('status');
    expect(view).not.toHaveProperty('createdBy');
  });

  it('el recibo del alta solo devuelve lo que la persona declaro', () => {
    const receipt = toPublicRegistrationReceipt(REGISTRATION_ROW);

    expect(receipt).toEqual({
      id: 'registration-1',
      participationId: 'participation-1',
      documentType: 'CC',
      documentNumber: '10203040',
      fullName: 'Ana Perez',
      companionsCount: 2,
      status: 'confirmed',
      registeredAt: '2026-01-03T10:00:00.000Z',
    });
    expect(receipt).not.toHaveProperty('cancelledReason');
    expect(receipt).not.toHaveProperty('source');
  });
});

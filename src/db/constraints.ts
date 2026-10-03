import { AppError, isAppError } from '../core/errors/app-error';
import { ErrorCode } from '../core/errors/error-codes';

/**
 * Traduccion de violaciones de restricciones de SQLite a errores de dominio.
 *
 * D1 no expone un tipo de error por restriccion, solo un mensaje. Los formatos
 * que interesa reconocer son:
 *
 * ```text
 * UNIQUE constraint failed: index 'registrations_participation_document_unique'
 * UNIQUE constraint failed: users.email
 * CHECK constraint failed: event_establishments_titular_capacity_check
 * FOREIGN KEY constraint failed
 * ```
 *
 * Sobre eso, dos ruidos propios del stack que este modulo absorbe:
 *
 * 1. D1 anexa el codigo extendido al texto
 *    (`... : SQLITE_CONSTRAINT (extended: SQLITE_CONSTRAINT_UNIQUE)`), asi que el
 *    objetivo se recorta en el primer `:`.
 * 2. Drizzle envuelve el fallo en `DrizzleQueryError` y deja el mensaje del driver
 *    en `cause`; por eso se recorren los mensajes de toda la cadena.
 *
 * Este modulo es el **unico** lugar del proyecto donde se interpretan esos
 * textos. El resto del codigo captura `AppError` con codigos estables, de modo
 * que los indices son la ultima linea de defensa y no una fuente de errores
 * opacos (`INTERNAL_ERROR`).
 */

interface UniqueInvariant {
  /** Nombre del indice unico (siempre explicito en este esquema). */
  index: string;
  /** Columnas implicadas, para el caso en que SQLite reporte la lista de columnas. */
  columns: readonly string[];
  /** Error de dominio equivalente. */
  error: () => AppError;
}

/**
 * Profundidad maxima al recorrer la cadena de `cause` de un error.
 *
 * Dos niveles bastan hoy (`DrizzleQueryError` -> error de D1); el limite existe
 * para no recorrer sin fin una cadena ciclica.
 */
const MAX_CAUSE_DEPTH = 5;

interface CheckInvariant {
  /** Nombre del CHECK tal como se declaro en la migracion. */
  name: string;
  error: () => AppError;
}

/**
 * Invariantes de unicidad del esquema.
 *
 * Cualquier indice unico nuevo debe registrarse aqui; si no, el choque de la
 * restriccion se reportaria como error interno.
 */
export const UNIQUE_INVARIANTS: readonly UniqueInvariant[] = [
  {
    index: 'users_email_unique',
    columns: ['users.email'],
    error: () =>
      AppError.conflict(ErrorCode.EMAIL_ALREADY_USED, 'Ya existe un usuario con ese email.'),
  },
  {
    // El catalogo no tiene un codigo dedicado para el slug: la Fase 4 validara
    // antes para poder responder 400 con el campo implicado. Este mapeo evita un
    // 500 si esa validacion se salta (carrera entre la lectura y la escritura).
    index: 'events_slug_unique',
    columns: ['events.slug'],
    error: () =>
      AppError.conflict(ErrorCode.VALIDATION_ERROR, 'Ya existe un evento con ese slug.'),
  },
  {
    index: 'establishments_code_unique',
    columns: ['establishments.code'],
    error: () =>
      AppError.conflict(
        ErrorCode.VALIDATION_ERROR,
        'Ya existe un establecimiento con ese codigo.',
      ),
  },
  {
    index: 'event_establishments_event_establishment_unique',
    columns: ['event_establishments.event_id', 'event_establishments.establishment_id'],
    error: () =>
      AppError.conflict(
        ErrorCode.PARTICIPATION_ALREADY_EXISTS,
        'El establecimiento ya participa en este evento.',
      ),
  },
  {
    index: 'registrations_participation_document_unique',
    columns: [
      'registrations.participation_id',
      'registrations.document_type',
      'registrations.document_number',
    ],
    error: () =>
      AppError.conflict(
        ErrorCode.DUPLICATE_REGISTRATION,
        'Ya existe un registro con ese documento en este establecimiento.',
      ),
  },
  {
    index: 'registration_companions_document_unique',
    columns: [
      'registration_companions.registration_id',
      'registration_companions.document_type',
      'registration_companions.document_number',
    ],
    error: () =>
      AppError.unprocessable(
        ErrorCode.VALIDATION_ERROR,
        'El mismo documento no puede repetirse entre los acompanantes de un registro.',
      ),
  },
  {
    index: 'qr_codes_active_per_registration_unique',
    columns: ['qr_codes.registration_id'],
    error: () =>
      AppError.conflict(ErrorCode.QR_ALREADY_ACTIVE, 'El registro ya tiene un codigo QR activo.'),
  },
  {
    index: 'shift_assignments_registration_active_unique',
    columns: ['shift_assignments.registration_id'],
    error: () =>
      AppError.conflict(
        ErrorCode.CHECK_IN_ALREADY_ASSIGNED,
        'El registro ya tiene un turno asignado.',
      ),
  },
  {
    index: 'capacity_adjustments_participation_pending_unique',
    columns: ['capacity_adjustments.participation_id'],
    error: () =>
      AppError.conflict(
        ErrorCode.CAPACITY_ADJUSTMENT_INVALID,
        'Ya existe una solicitud de ajuste de cupo pendiente para esta sede.',
      ),
  },
];

/**
 * Invariantes de integridad comprobados por `CHECK`.
 *
 * Son la red de seguridad de los contadores de cupo: si un camino del codigo
 * intenta sobrepasarlos, el error se traduce igual que si lo hubiera detectado
 * el servicio.
 */
export const CHECK_INVARIANTS: readonly CheckInvariant[] = [
  {
    name: 'event_establishments_titular_capacity_check',
    error: () =>
      AppError.conflict(
        ErrorCode.TITULAR_CAPACITY_EXCEEDED,
        'El cupo de titulares de la sede esta completo.',
      ),
  },
  {
    name: 'event_establishments_companion_capacity_check',
    error: () =>
      AppError.conflict(
        ErrorCode.COMPANION_CAPACITY_EXCEEDED,
        'El cupo de acompanantes de la sede esta completo.',
      ),
  },
  {
    name: 'shifts_assigned_count_check',
    error: () => AppError.conflict(ErrorCode.TURN_ASSIGNMENT_CONFLICT, 'El turno ya esta completo.'),
  },
];

/**
 * Texto util del error: los mensajes de toda la cadena de `cause`, unidos.
 *
 * No basta con `error.message` porque **Drizzle envuelve** el fallo del driver:
 * lanza `DrizzleQueryError` con el mensaje `Failed query: ...` y deja el texto
 * real de SQLite en `cause`. Sin recorrer la cadena, ninguna restriccion se
 * reconoceria y todo choque terminaria como `INTERNAL_ERROR`.
 */
function errorMessage(error: unknown): string {
  const messages: string[] = [];
  const visited = new Set<unknown>();
  let current: unknown = error;

  while (current !== null && current !== undefined && messages.length < MAX_CAUSE_DEPTH) {
    if (visited.has(current)) {
      break;
    }
    visited.add(current);

    if (current instanceof Error) {
      messages.push(current.message);
      current = current.cause;
      continue;
    }

    messages.push(typeof current === 'string' ? current : String(current));
    break;
  }

  return messages.join(' | ');
}

/**
 * Extrae el objetivo de una violacion de unicidad (nombre de indice o columnas).
 *
 * D1 no entrega el mensaje "limpio" de SQLite: le añade el codigo extendido, de
 * modo que el texto real es
 * `UNIQUE constraint failed: users.email: SQLITE_CONSTRAINT (extended: SQLITE_CONSTRAINT_UNIQUE)`.
 * Por eso se corta en el primer `:` antes de comparar.
 */
function uniqueTarget(message: string): string {
  const indexMatch = /index '([^']+)'/.exec(message);
  if (indexMatch?.[1] !== undefined) {
    return indexMatch[1];
  }
  const [, reported = ''] = message.split('UNIQUE constraint failed:');
  const [columns = ''] = reported.split(':');
  return columns.trim();
}

/** Extrae el nombre del `CHECK` que fallo. */
function checkTarget(message: string): string | null {
  const match = /CHECK constraint failed: ([A-Za-z0-9_]+)/.exec(message);
  return match?.[1] ?? null;
}

/** `true` si el error corresponde a un indice unico o a una clave primaria. */
export function isUniqueViolation(error: unknown): boolean {
  return errorMessage(error).includes('UNIQUE constraint failed');
}

/** `true` si el error corresponde a un `CHECK` que fallo. */
export function isCheckViolation(error: unknown): boolean {
  return errorMessage(error).includes('CHECK constraint failed');
}

/** `true` si el error corresponde a una clave foranea inexistente o protegida. */
export function isForeignKeyViolation(error: unknown): boolean {
  return errorMessage(error).includes('FOREIGN KEY constraint failed');
}

/**
 * Convierte una violacion de restriccion conocida en su `AppError`.
 * Devuelve `null` cuando el error no coincide con ninguna restriccion registrada.
 */
export function resolveConstraintViolation(error: unknown): AppError | null {
  if (isAppError(error)) {
    return error;
  }

  const message = errorMessage(error);

  if (message.includes('UNIQUE constraint failed')) {
    const target = uniqueTarget(message);
    const invariant = UNIQUE_INVARIANTS.find(
      (candidate) => candidate.index === target || candidate.columns.join(', ') === target,
    );
    return invariant?.error() ?? null;
  }

  if (message.includes('CHECK constraint failed')) {
    const target = checkTarget(message);
    if (target === null) {
      return null;
    }
    const invariant = CHECK_INVARIANTS.find((candidate) => candidate.name === target);
    return invariant?.error() ?? null;
  }

  return null;
}

/**
 * Traduce una violacion de restriccion; cualquier otro error se reporta como
 * interno, conservando la causa para el log.
 */
export function mapConstraintViolation(error: unknown): AppError {
  return (
    resolveConstraintViolation(error) ??
    AppError.internal('Fallo una restriccion no reconocida de la base de datos.', { cause: error })
  );
}

/**
 * Ejecuta una escritura traduciendo las restricciones de SQLite.
 *
 * Es el envoltorio que usan los repositorios: al llamador solo le llegan
 * `AppError` del catalogo.
 */
export async function withConstraintTranslation<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    throw mapConstraintViolation(error);
  }
}


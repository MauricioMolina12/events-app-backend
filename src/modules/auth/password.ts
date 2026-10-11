import { AUTH_DEFAULTS, PBKDF2_MAX_ITERATIONS } from '../../config/constants';
import {
  base64ToBytes,
  bytesToBase64,
  constantTimeEqual,
  randomBytes,
} from '../../core/crypto/encoding';

/**
 * Derivacion y verificacion de contrasenas con PBKDF2-SHA256 (WebCrypto).
 *
 * El digest guarda el salt y el numero de iteraciones empleadas: subir el coste
 * en el futuro no invalida los hashes existentes, porque cada usuario se
 * verifica con los parametros con los que fue creado. La contrasena en claro
 * nunca se persiste ni se registra en logs.
 */

/** Longitud del salt por usuario, en bytes. */
const SALT_BYTES = 16;
/** Longitud del derivado, en bits (32 bytes). */
const KEY_LENGTH_BITS = 256;
/** Suelo de iteraciones: valores menores solo tienen sentido en tests. */
export const MIN_PBKDF2_ITERATIONS = 1_000;

export interface PasswordDigest {
  /** Derivado PBKDF2-SHA256 en base64. */
  readonly hash: string;
  /** Salt por usuario en base64. */
  readonly salt: string;
  /** Iteraciones empleadas, persistidas junto al hash. */
  readonly iterations: number;
}

export interface HashPasswordOptions {
  iterations?: number;
  /** Salt explicito; solo los tests lo fijan para obtener un digest estable. */
  salt?: Uint8Array;
}

/** Deriva el digest de una contrasena. */
export async function hashPassword(
  password: string,
  options: HashPasswordOptions = {},
): Promise<PasswordDigest> {
  const requestedIterations = options.iterations ?? AUTH_DEFAULTS.pbkdf2Iterations;
  if (!Number.isInteger(requestedIterations) || requestedIterations > PBKDF2_MAX_ITERATIONS) {
    throw new RangeError(
      `PBKDF2 iteration counts must not exceed ${PBKDF2_MAX_ITERATIONS} in Cloudflare Workers.`,
    );
  }

  const iterations = Math.max(requestedIterations, MIN_PBKDF2_ITERATIONS);
  const salt = options.salt ?? randomBytes(SALT_BYTES);
  const derived = await deriveBits(password, salt, iterations);

  return { hash: bytesToBase64(derived), salt: bytesToBase64(salt), iterations };
}

/** Verifica una contrasena contra el digest persistido, en tiempo constante. */
export async function verifyPassword(password: string, digest: PasswordDigest): Promise<boolean> {
  const derived = await deriveBits(password, base64ToBytes(digest.salt), digest.iterations);
  return constantTimeEqual(derived, base64ToBytes(digest.hash));
}

/**
 * Digest de relleno para emails inexistentes.
 *
 * El servicio lo verifica y descarta el resultado. Sin esta llamada, un email
 * desconocido responderia perceptiblemente mas rapido que uno valido con
 * contrasena incorrecta: seria posible enumerar cuentas midiendo el tiempo.
 */
export function timingSafeDigest(
  iterations: number = AUTH_DEFAULTS.pbkdf2Iterations,
): PasswordDigest {
  return {
    hash: bytesToBase64(new Uint8Array(KEY_LENGTH_BITS / 8)),
    salt: bytesToBase64(new Uint8Array(SALT_BYTES)),
    iterations,
  };
}

async function deriveBits(
  password: string,
  salt: Uint8Array,
  iterations: number,
): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(password),
    'PBKDF2',
    false,
    ['deriveBits'],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations },
    key,
    KEY_LENGTH_BITS,
  );
  return new Uint8Array(bits);
}

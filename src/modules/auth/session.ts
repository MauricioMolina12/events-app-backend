import type { CookieOptions } from 'hono/utils/cookie';
import type { AuthConfig, RuntimeEnvironment } from '../../config/env';
import { bytesToBase64Url, randomBytes, sha256Hex } from '../../core/crypto/encoding';

/**
 * Sesiones: token opaco, su hash y los atributos de la cookie que lo transporta.
 *
 * El token en claro solo existe en la respuesta del login; en D1 se persiste su
 * SHA-256. Un volcado de la base de datos no permite suplantar a nadie y la
 * revocacion es inmediata (basta con marcar `revoked_at`).
 */

/** Entropia del token: 256 bits, 43 caracteres en base64 URL-safe. */
const TOKEN_BYTES = 32;

export interface IssuedSessionToken {
  /** Valor en claro; se entrega al cliente y no se persiste nunca. */
  readonly token: string;
  /** SHA-256 en hexadecimal, la columna `sessions.token_hash`. */
  readonly tokenHash: string;
}

/** Emite un token nuevo junto con el hash que se guardara. */
export async function issueSessionToken(): Promise<IssuedSessionToken> {
  const token = bytesToBase64Url(randomBytes(TOKEN_BYTES));
  return { token, tokenHash: await sha256Hex(token) };
}

/** Hash del token recibido: permite localizarlo por el indice unico. */
export function hashSessionToken(token: string): Promise<string> {
  return sha256Hex(token);
}

/** Momento de expiracion de una sesion emitida en `issuedAt`. */
export function sessionExpiresAt(issuedAt: Date, ttlHours: number): Date {
  return new Date(issuedAt.getTime() + ttlHours * 60 * 60 * 1000);
}

export interface SessionCookieSettings {
  readonly name: string;
  readonly ttlHours: number;
  /** `false` solo en `local`, donde el desarrollo ocurre sobre http. */
  readonly secure: boolean;
  readonly sameSite: 'Lax' | 'None';
}

/**
 * Atributos de la cookie de sesion.
 *
 * - `HttpOnly`: el token no es accesible desde JavaScript (mitiga XSS).
 * - `SameSite=Lax` en local/production; `None` en development para que el
 *   frontend localhost pueda enviar la cookie al Worker remoto.
 * - `Secure`: obligatorio fuera de `local`; en http el navegador la descartaria.
 * - `Path=/`: la cookie viaja en toda la API, no solo bajo `/auth`.
 */
export function sessionCookieOptions(settings: SessionCookieSettings): CookieOptions {
  return {
    path: '/',
    httpOnly: true,
    sameSite: settings.sameSite,
    secure: settings.secure,
    maxAge: settings.ttlHours * 60 * 60,
  };
}

/** Atributos para borrar la cookie: deben coincidir `path` y `secure`. */
export function expiredSessionCookieOptions(settings: SessionCookieSettings): CookieOptions {
  return {
    path: '/',
    httpOnly: true,
    sameSite: settings.sameSite,
    secure: settings.secure,
    maxAge: 0,
  };
}

/** Extrae de la configuracion de runtime lo que la cookie necesita. */
export function sessionCookieSettings(config: AuthConfig): SessionCookieSettings {
  return {
    name: config.cookieName,
    ttlHours: config.sessionTtlHours,
    secure: config.secureCookies,
    sameSite: config.cookieSameSite,
  };
}

/**
 * Origen de `ng serve` contra el Worker remoto. Solo ese caso es cross-site:
 * el sitio en Vercel pide `/api` en su propio host y debe usar `Lax`.
 */
const LOCAL_CROSS_SITE_ORIGIN = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;

/**
 * `SameSite` de la cookie segun quien llama.
 *
 * En development el valor por defecto de la config es `None`, para que
 * localhost pueda hablar con el Worker. Safari, en cambio, no conserva una
 * cookie `None` aunque la respuesta llegue por el proxy del propio sitio: el
 * panel aparece y la siguiente peticion vuelve sin sesion. Para cualquier
 * origen que no sea el frontend local, la cookie es `Lax`.
 */
export function sameSiteForOrigin(
  environment: RuntimeEnvironment,
  origin: string | undefined,
): SessionCookieSettings['sameSite'] {
  const localFrontend = origin !== undefined && LOCAL_CROSS_SITE_ORIGIN.test(origin);
  if (environment === 'development' && localFrontend) {
    return 'None';
  }
  return 'Lax';
}

/** Ajustes de cookie para esta peticion, con el `SameSite` que el origen admite. */
export function cookieSettingsForRequest(
  config: AuthConfig,
  environment: RuntimeEnvironment,
  origin: string | undefined,
): SessionCookieSettings {
  return {
    ...sessionCookieSettings(config),
    sameSite: sameSiteForOrigin(environment, origin),
  };
}

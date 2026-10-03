/**
 * Codificacion de bytes y primitivas criptograficas compartidas.
 *
 * Todo lo que D1 guarda como "hash" (contrasenas, tokens de sesion) se produce
 * aqui: los repositorios y servicios solo ven texto en base64 o hexadecimal,
 * nunca bytes. Ninguna funcion de este modulo conoce el dominio.
 */

/** Bytes aleatorios criptograficamente seguros. */
export function randomBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return bytes;
}

/** Base64 estandar con relleno: el formato de `hash` y `salt` en `users`. */
export function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

/** Reconstruye los bytes de un base64 estandar emitido por `bytesToBase64`. */
export function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

/**
 * Base64 URL-safe sin relleno.
 *
 * Es el formato de los tokens que viajan en cookies y, mas adelante, en enlaces
 * de verificacion: sin `+`, `/` ni `=`, el valor sobrevive a un copiar y pegar
 * sin escapes.
 */
export function bytesToBase64Url(bytes: Uint8Array): string {
  return bytesToBase64(bytes).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '');
}

/** Inversa de `bytesToBase64Url`; se usa en los tests y al verificar tokens. */
export function base64UrlToBytes(value: string): Uint8Array {
  const normalized = value.replaceAll('-', '+').replaceAll('_', '/');
  const remainder = normalized.length % 4;
  const padding = remainder === 0 ? '' : '='.repeat(4 - remainder);
  return base64ToBytes(normalized + padding);
}

/** Hexadecimal en minusculas: el formato de `sessions.token_hash`. */
export function bytesToHex(bytes: Uint8Array): string {
  let hex = '';
  for (const byte of bytes) {
    hex += byte.toString(16).padStart(2, '0');
  }
  return hex;
}

/**
 * Comparacion en tiempo constante.
 *
 * La longitud se compara en claro a proposito: en este proyecto los valores
 * comparados son siempre derivados de longitud fija (32 bytes), asi que la
 * diferencia de longitud no revela nada util al atacante.
 */
export function constantTimeEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) {
    return false;
  }

  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= (left[index] ?? 0) ^ (right[index] ?? 0);
  }
  return difference === 0;
}

/** SHA-256 en hexadecimal; permite indexar sesiones sin persistir el token. */
export async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return bytesToHex(new Uint8Array(digest));
}

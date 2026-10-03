import { describe, expect, it } from 'vitest';
import {
  base64ToBytes,
  base64UrlToBytes,
  bytesToBase64,
  bytesToBase64Url,
  bytesToHex,
  constantTimeEqual,
  randomBytes,
  sha256Hex,
} from '../../src/core/crypto/encoding';

/**
 * Pruebas de las primitivas de codificacion y hashing.
 *
 * Son funciones puras: si fallan, cualquier verificacion de contrasena o de
 * sesion falla en silencio, por eso se cubren antes que el resto del modulo.
 */
describe('codificacion de bytes', () => {
  it('recorre base64 sin perder bytes', () => {
    const original = new Uint8Array([0, 1, 2, 127, 128, 254, 255]);

    expect(Array.from(base64ToBytes(bytesToBase64(original)))).toEqual(Array.from(original));
  });

  it('produce base64 URL-safe sin relleno', () => {
    // Estos bytes generan `+/+/` en base64 estandar: es el peor caso para la
    // variante URL-safe, la misma que viaja en la cookie de sesion.
    const bytes = new Uint8Array([251, 255, 191]);

    expect(bytesToBase64(bytes)).toBe('+/+/');
    expect(bytesToBase64Url(bytes)).toBe('-_-_');
    expect(Array.from(base64UrlToBytes('-_-_'))).toEqual([251, 255, 191]);
  });

  it('elimina solo el relleno sobrante en base64 URL', () => {
    const twoBytes = new Uint8Array([1, 2]);

    expect(bytesToBase64(twoBytes)).toMatch(/=$/u);
    expect(bytesToBase64Url(twoBytes)).not.toContain('=');
    expect(Array.from(base64UrlToBytes(bytesToBase64Url(twoBytes)))).toEqual([1, 2]);
  });

  it('escribe hexadecimal en minusculas y dos digitos por byte', () => {
    expect(bytesToHex(new Uint8Array([0, 15, 255]))).toBe('000fff');
  });

  it('calcula SHA-256 con el vector conocido de "abc"', async () => {
    await expect(sha256Hex('abc')).resolves.toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });

  it('compara en tiempo constante', () => {
    expect(constantTimeEqual(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2, 3]))).toBe(true);
    expect(constantTimeEqual(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2, 4]))).toBe(false);
    expect(constantTimeEqual(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2]))).toBe(false);
  });

  it('genera la cantidad de bytes pedida y sin repetir el valor', () => {
    const first = randomBytes(32);
    const second = randomBytes(32);

    expect(first).toHaveLength(32);
    expect(Array.from(first)).not.toEqual(Array.from(second));
  });
});

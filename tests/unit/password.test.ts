import { describe, expect, it } from 'vitest';
import { base64ToBytes } from '../../src/core/crypto/encoding';
import {
  MIN_PBKDF2_ITERATIONS,
  hashPassword,
  timingSafeDigest,
  verifyPassword,
} from '../../src/modules/auth/password';

/**
 * Pruebas de la derivacion de contrasenas.
 *
 * Se usan pocas iteraciones para que la suite siga siendo rapida; el valor real
 * de produccion (210 000) se comprueba en los tests de configuracion.
 */
const FAST = { iterations: 2_000 };

describe('derivacion de contrasenas (PBKDF2-SHA256)', () => {
  it('verifica la contrasena correcta y rechaza la incorrecta', async () => {
    const digest = await hashPassword('contrasena-correcta', FAST);

    await expect(verifyPassword('contrasena-correcta', digest)).resolves.toBe(true);
    await expect(verifyPassword('contrasena-incorrecta', digest)).resolves.toBe(false);
  });

  it('usa un salt distinto en cada derivacion', async () => {
    const first = await hashPassword('misma-contrasena', FAST);
    const second = await hashPassword('misma-contrasena', FAST);

    expect(first.salt).not.toBe(second.salt);
    expect(first.hash).not.toBe(second.hash);
  });

  it('persiste las iteraciones para poder verificar hashes ya existentes', async () => {
    const digest = await hashPassword('contrasena-larga', { iterations: 3_000 });

    expect(digest.iterations).toBe(3_000);
    await expect(verifyPassword('contrasena-larga', digest)).resolves.toBe(true);
  });

  it('no baja del suelo de iteraciones aunque se pida menos', async () => {
    const digest = await hashPassword('x', { iterations: 1 });

    expect(digest.iterations).toBe(MIN_PBKDF2_ITERATIONS);
  });

  it('produce un derivado de 32 bytes y un salt de 16, en base64', async () => {
    const digest = await hashPassword('contrasena', FAST);

    expect(base64ToBytes(digest.hash)).toHaveLength(32);
    expect(base64ToBytes(digest.salt)).toHaveLength(16);
  });

  it('rechaza un digest manipulado', async () => {
    const digest = await hashPassword('contrasena', FAST);
    const tamperedHash = `${digest.hash.startsWith('A') ? 'B' : 'A'}${digest.hash.slice(1)}`;

    await expect(verifyPassword('contrasena', { ...digest, hash: tamperedHash })).resolves.toBe(false);
  });

  it('el digest de relleno no valida ninguna contrasena', async () => {
    // Es el que se verifica cuando el email no existe, solo para igualar el
    // tiempo de respuesta y no permitir enumerar cuentas.
    const digest = timingSafeDigest(1_000);

    expect(digest.iterations).toBe(1_000);
    await expect(verifyPassword('cualquier-contrasena', digest)).resolves.toBe(false);
  });
});

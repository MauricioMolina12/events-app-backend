import { describe, expect, it } from 'vitest';
import type { AuthConfig } from '../../src/config/env';
import {
  expiredSessionCookieOptions,
  hashSessionToken,
  issueSessionToken,
  sessionCookieOptions,
  sessionCookieSettings,
  sessionExpiresAt,
} from '../../src/modules/auth/session';

/**
 * Pruebas de emision de tokens y atributos de la cookie.
 *
 * El caso clave es que el token nunca se persiste en claro: lo que viaja a D1 es
 * su SHA-256, y de ese hash no se puede volver al token.
 */
const SETTINGS = { name: 'events_session', ttlHours: 12, secure: true };

const AUTH_CONFIG: AuthConfig = {
  pbkdf2Iterations: 1_000,
  sessionTtlHours: 12,
  cookieName: 'events_session',
  secureCookies: true,
  maxFailedAttempts: 5,
  lockoutMinutes: 15,
  maxLockoutMultiplier: 8,
};

describe('sesiones', () => {
  it('emite un token opaco de 256 bits y devuelve su hash', async () => {
    const { token, tokenHash } = await issueSessionToken();

    expect(token).toHaveLength(43);
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/u);
    expect(tokenHash).toMatch(/^[0-9a-f]{64}$/u);
    await expect(hashSessionToken(token)).resolves.toBe(tokenHash);
  });

  it('no repite tokens entre emisiones', async () => {
    const first = await issueSessionToken();
    const second = await issueSessionToken();

    expect(first.token).not.toBe(second.token);
  });

  it('no permite recuperar el token a partir del hash', async () => {
    const { token, tokenHash } = await issueSessionToken();

    expect(tokenHash).not.toBe(token);
    expect(tokenHash).not.toContain(token);
  });

  it('calcula la expiracion a partir del TTL', () => {
    const issuedAt = new Date('2026-01-01T00:00:00.000Z');

    expect(sessionExpiresAt(issuedAt, 12).toISOString()).toBe('2026-01-01T12:00:00.000Z');
    expect(sessionExpiresAt(issuedAt, 1).toISOString()).toBe('2026-01-01T01:00:00.000Z');
  });

  it('fija los atributos de seguridad de la cookie', () => {
    const options = sessionCookieOptions(SETTINGS);

    expect(options.path).toBe('/');
    expect(options.httpOnly).toBe(true);
    expect(options.sameSite).toBe('Lax');
    expect(options.secure).toBe(true);
    expect(options.maxAge).toBe(12 * 60 * 60);
  });

  it('omite Secure solo cuando el entorno es local', () => {
    expect(sessionCookieOptions({ ...SETTINGS, secure: false }).secure).toBe(false);
    expect(expiredSessionCookieOptions({ ...SETTINGS, secure: true }).maxAge).toBe(0);
  });

  it('deriva los ajustes de la cookie de la configuracion de runtime', () => {
    expect(sessionCookieSettings(AUTH_CONFIG)).toEqual({
      name: 'events_session',
      ttlHours: 12,
      secure: true,
    });
    expect(sessionCookieSettings({ ...AUTH_CONFIG, cookieName: 'sid' }).name).toBe('sid');
  });
});

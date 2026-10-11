import { describe, expect, it } from 'vitest';
import type { AuthConfig } from '../../src/config/env';
import {
  cookieSettingsForRequest,
  expiredSessionCookieOptions,
  hashSessionToken,
  issueSessionToken,
  sameSiteForOrigin,
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
const SETTINGS = { name: 'events_session', ttlHours: 12, secure: true, sameSite: 'Lax' as const };

const AUTH_CONFIG: AuthConfig = {
  pbkdf2Iterations: 1_000,
  sessionTtlHours: 12,
  cookieName: 'events_session',
  secureCookies: true,
  cookieSameSite: 'Lax',
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

  it('permite cookies cross-site solo con la politica configurada para desarrollo', () => {
    const settings = sessionCookieSettings({ ...AUTH_CONFIG, cookieSameSite: 'None' });
    const options = sessionCookieOptions(settings);

    expect(options.sameSite).toBe('None');
    expect(options.secure).toBe(true);
  });

  it('omite Secure solo cuando el entorno es local', () => {
    expect(sessionCookieOptions({ ...SETTINGS, secure: false }).secure).toBe(false);
    expect(expiredSessionCookieOptions({ ...SETTINGS, secure: true }).maxAge).toBe(0);
  });

  it('usa SameSite=None solo para el frontend local contra el worker de development', () => {
    expect(sameSiteForOrigin('development', 'http://localhost:4200')).toBe('None');
    expect(sameSiteForOrigin('development', 'http://127.0.0.1:4200')).toBe('None');
    expect(sameSiteForOrigin('development', 'https://grow-events-star-grow-studio.vercel.app')).toBe(
      'Lax',
    );
    expect(sameSiteForOrigin('development', undefined)).toBe('Lax');
    expect(sameSiteForOrigin('production', 'http://localhost:4200')).toBe('Lax');
    expect(sameSiteForOrigin('local', 'http://localhost:4200')).toBe('Lax');
  });

  it('aplica ese SameSite en los ajustes de la peticion', () => {
    const hosted = cookieSettingsForRequest(
      { ...AUTH_CONFIG, cookieSameSite: 'None' },
      'development',
      'https://grow-events-star-grow-studio.vercel.app',
    );
    const local = cookieSettingsForRequest(
      { ...AUTH_CONFIG, cookieSameSite: 'None' },
      'development',
      'http://localhost:4200',
    );

    expect(hosted.sameSite).toBe('Lax');
    expect(local.sameSite).toBe('None');
  });

  it('deriva los ajustes de la cookie de la configuracion de runtime', () => {
    expect(sessionCookieSettings(AUTH_CONFIG)).toEqual({
      name: 'events_session',
      ttlHours: 12,
      secure: true,
      sameSite: 'Lax',
    });
    expect(sessionCookieSettings({ ...AUTH_CONFIG, cookieName: 'sid' }).name).toBe('sid');
  });
});

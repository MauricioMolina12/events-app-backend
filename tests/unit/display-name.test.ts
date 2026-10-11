import { describe, expect, it } from 'vitest';
import { displayNameFromEmail, GENERATED_NAME_FALLBACK } from '../../src/modules/workspace/display-name';

describe('displayNameFromEmail', () => {
  it('separa puntos, guiones y guiones bajos y capitaliza', () => {
    expect(displayNameFromEmail('mauricio.molina@gmail.com')).toBe('Mauricio Molina');
    expect(displayNameFromEmail('soporte@barbytoys.com')).toBe('Soporte');
    expect(displayNameFromEmail('ventas-corporativas@empresa.com')).toBe('Ventas Corporativas');
    expect(displayNameFromEmail('juan_perez.dev@empresa.com')).toBe('Juan Perez Dev');
  });

  it('conserva numeros y no usa el dominio', () => {
    expect(displayNameFromEmail('user2@empresa.com')).toBe('User2');
    expect(displayNameFromEmail('juan.2@empresa.com')).toBe('Juan 2');
    expect(displayNameFromEmail('123@empresa.com')).toBe('123');
    expect(displayNameFromEmail('ana@empresa.com')).not.toContain('empresa');
  });

  it('usa un nombre alternativo cuando el local no aporta palabras', () => {
    expect(displayNameFromEmail('@empresa.com')).toBe(GENERATED_NAME_FALLBACK);
    expect(displayNameFromEmail('---@empresa.com')).toBe(GENERATED_NAME_FALLBACK);
    expect(displayNameFromEmail('...@empresa.com')).toBe(GENERATED_NAME_FALLBACK);
  });
});

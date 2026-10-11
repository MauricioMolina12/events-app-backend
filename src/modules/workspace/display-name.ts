/**
 * Nombre legible sugerido a partir del correo del propietario.
 *
 * Solo se usa al crear la configuracion del espacio, cuando nadie ha escrito un
 * nombre a mano. No incluye el dominio y no se vuelve a calcular en cada sesion.
 */

export const GENERATED_NAME_FALLBACK = 'Espacio de trabajo';
export const WORKSPACE_NAME_MAX = 80;

export function displayNameFromEmail(email: string): string {
  const at = email.indexOf('@');
  const local = (at === -1 ? email : email.slice(0, at)).trim();
  const pieces = local
    .replace(/[.+_-]+/g, ' ')
    .split(/\s+/)
    .flatMap((part) => part.split(/(?<=\p{Ll})(?=\p{Lu})/u))
    .map((part) => part.replace(/[^\p{L}\p{N}]+/gu, ''))
    .filter((part) => part.length > 0);

  if (pieces.length === 0) {
    return GENERATED_NAME_FALLBACK;
  }

  const titled = pieces.map(titleCaseWord).join(' ').replace(/\s+/g, ' ').trim();
  if (titled.length === 0) {
    return GENERATED_NAME_FALLBACK;
  }

  return titled.slice(0, WORKSPACE_NAME_MAX);
}

function titleCaseWord(word: string): string {
  if (/^\p{N}+$/u.test(word)) {
    return word;
  }
  const lower = word.toLocaleLowerCase('es-CO');
  return lower.charAt(0).toLocaleUpperCase('es-CO') + lower.slice(1);
}

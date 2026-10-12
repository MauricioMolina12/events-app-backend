/** Slug publico estable. Sale del correo, no del nombre comercial. */
export function clientSlugFromEmail(email: string): string {
  const at = email.indexOf('@');
  const local = (at > 0 ? email.slice(0, at) : email).trim().toLowerCase();
  const slug = local
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return slug.length >= 2 ? slug : 'cliente';
}

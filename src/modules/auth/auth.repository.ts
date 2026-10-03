import { and, eq, gt, isNull } from 'drizzle-orm';
import type { Database } from '../../db/client';
import { withConstraintTranslation } from '../../db/constraints';
import { newId } from '../../db/helpers';
import { authAttempts, sessions } from '../../db/schema';

/**
 * Repositorio de sesiones e intentos de autenticacion.
 *
 * Unico punto del proyecto que emite SQL sobre `sessions` y `auth_attempts`; las
 * sentencias sobre `users` viven en `modules/users/users.repository.ts`, del que
 * este modulo solo consume las consultas de autenticacion. No conoce Hono ni
 * tipos HTTP y el texto de las restricciones lo traduce `constraints.ts`.
 */

export type SessionRow = typeof sessions.$inferSelect;
export type AuthAttemptRow = typeof authAttempts.$inferSelect;

export interface InsertSessionInput {
  userId: string;
  tokenHash: string;
  expiresAt: Date;
}

export interface InsertAuthAttemptInput {
  identifier: string;
  succeeded: boolean;
  sourceHash?: string | null;
}

export async function insertSession(
  db: Database,
  input: InsertSessionInput,
  now: Date = new Date(),
): Promise<SessionRow> {
  return withConstraintTranslation(async () => {
    const [row] = await db
      .insert(sessions)
      .values({
        id: newId(),
        userId: input.userId,
        tokenHash: input.tokenHash,
        createdAt: now,
        expiresAt: input.expiresAt,
        lastUsedAt: now,
        revokedAt: null,
        revokedReason: null,
      })
      .returning();

    if (row === undefined) {
      throw new Error('El INSERT de la sesion no devolvio ninguna fila.');
    }
    return row;
  });
}

/**
 * Localiza una sesion por el hash del token.
 *
 * Devuelve la fila aunque este revocada o caducada: el servicio necesita
 * distinguir `SESSION_EXPIRED` de `SESSION_REVOKED` para responder con el codigo
 * correcto.
 */
export async function findSessionByTokenHash(
  db: Database,
  tokenHash: string,
): Promise<SessionRow | null> {
  const [row] = await db
    .select()
    .from(sessions)
    .where(eq(sessions.tokenHash, tokenHash))
    .limit(1);
  return row ?? null;
}

/** Marca el uso de una sesion valida (una escritura como mucho cada pocos minutos). */
export async function touchSession(
  db: Database,
  id: string,
  now: Date = new Date(),
): Promise<void> {
  await db.update(sessions).set({ lastUsedAt: now }).where(eq(sessions.id, id));
}

/** Revoca una sesion. Devuelve `null` si ya no existe o ya estaba revocada. */
export async function revokeSession(
  db: Database,
  id: string,
  reason: string,
  now: Date = new Date(),
): Promise<SessionRow | null> {
  const [row] = await db
    .update(sessions)
    .set({ revokedAt: now, revokedReason: reason })
    .where(and(eq(sessions.id, id), isNull(sessions.revokedAt)))
    .returning();
  return row ?? null;
}

/**
 * Revoca todas las sesiones vivas de un usuario.
 *
 * Es la respuesta a un cambio de contrasena o a la desactivacion de la cuenta:
 * sin esto, el token anterior seguiria siendo valido hasta expirar.
 */
export async function revokeUserSessions(
  db: Database,
  userId: string,
  reason: string,
  now: Date = new Date(),
): Promise<number> {
  const revoked = await db
    .update(sessions)
    .set({ revokedAt: now, revokedReason: reason })
    .where(and(eq(sessions.userId, userId), isNull(sessions.revokedAt)))
    .returning({ id: sessions.id });
  return revoked.length;
}

/** Registra un intento de autenticacion (exitoso o no) para auditoria y bloqueo. */
export async function insertAuthAttempt(
  db: Database,
  input: InsertAuthAttemptInput,
  now: Date = new Date(),
): Promise<void> {
  await db.insert(authAttempts).values({
    id: newId(),
    identifier: input.identifier,
    succeeded: input.succeeded,
    sourceHash: input.sourceHash ?? null,
    attemptedAt: now,
  });
}

/**
 * Cuenta los intentos fallidos recientes de un identificador.
 *
 * Es lo que hace progresivo el bloqueo: pasada la ventana, un atacante que
 * reanuda el ataque vuelve a empezar desde el primer multiplicador, pero la
 * racha persistida en `users` sigue creciendo.
 */
export async function countRecentFailedAttempts(
  db: Database,
  identifier: string,
  since: Date,
): Promise<number> {
  const rows = await db
    .select({ id: authAttempts.id })
    .from(authAttempts)
    .where(
      and(
        eq(authAttempts.identifier, identifier),
        eq(authAttempts.succeeded, false),
        gt(authAttempts.attemptedAt, since),
      ),
    );
  return rows.length;
}

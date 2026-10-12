import { AppError } from '../../core/errors/app-error';
import { ErrorCode } from '../../core/errors/error-codes';
import type { Database } from '../../db/client';
import { DEFAULT_PRIMARY_COLOR } from '../../db/schema/workspace';
import { displayNameFromEmail } from '../workspace/display-name';
import { clientSlugFromEmail } from './client-slug';
import {
  findClientById,
  findClientByOwner,
  findClientBySlug,
  insertClient,
  listClients,
  updateClient,
  type ClientRow,
} from './clients.repository';

const COLOR = /^#[0-9A-F]{6}$/;

export interface ClientProfile {
  readonly id: string;
  readonly email: string;
  readonly fullName: string;
  readonly status: 'active' | 'disabled';
}

export function toPublicClient(row: ClientRow) {
  return {
    id: row.id,
    slug: row.slug,
    displayName: row.displayName,
    nameCustomized: row.nameCustomized,
    primaryColor: row.primaryColor,
    colorCustomized: row.colorCustomized,
    status: row.status,
  };
}

/** Crea el espacio del operador si todavia no existe. No pisa un cliente ya guardado. */
export async function ensureClientForOperator(
  db: Database,
  user: ClientProfile,
  now: Date = new Date(),
): Promise<ClientRow> {
  const existing = await findClientByOwner(db, user.id);
  if (existing) {
    return existing;
  }

  const named = user.fullName.trim();
  const displayName = (named.length > 0 ? named : displayNameFromEmail(user.email)).slice(0, 80);
  const base = clientSlugFromEmail(user.email);
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const slug = attempt === 0 ? base : `${base}-${attempt + 1}`.slice(0, 48);
    try {
      return await insertClient(
        db,
        {
          slug,
          displayName,
          nameCustomized: named.length > 0,
          ownerUserId: user.id,
          status: user.status === 'active' ? 'active' : 'disabled',
        },
        now,
      );
    } catch (error) {
      if (error instanceof AppError && error.status === 409) {
        const raced = await findClientByOwner(db, user.id);
        if (raced) {
          return raced;
        }
        continue;
      }
      throw error;
    }
  }
  throw AppError.conflict(ErrorCode.VALIDATION_ERROR, 'No se pudo reservar un identificador publico.');
}

export async function getClientForOwner(db: Database, ownerUserId: string): Promise<ClientRow> {
  const row = await findClientByOwner(db, ownerUserId);
  if (row === null) {
    throw AppError.notFound(ErrorCode.NOT_FOUND, 'Este usuario no tiene un espacio de cliente.');
  }
  return row;
}

export async function getActiveClientBySlug(db: Database, slug: string): Promise<ClientRow> {
  const row = await findClientBySlug(db, slug);
  if (row === null || row.status !== 'active') {
    throw AppError.notFound(ErrorCode.NOT_FOUND, 'El cliente no existe.');
  }
  return row;
}

export async function listVisibleClients(db: Database): Promise<ClientRow[]> {
  return (await listClients(db)).filter((row) => row.status === 'active');
}

export interface ClientPatch {
  readonly displayName?: string;
  readonly primaryColor?: string;
}

/** El nombre y el color solo cambian si el cuerpo los trae. El slug no se toca. */
export async function patchClient(db: Database, id: string, patch: ClientPatch, now: Date = new Date()): Promise<ClientRow> {
  const current = await findClientById(db, id);
  if (current === null) {
    throw AppError.notFound(ErrorCode.NOT_FOUND, 'El cliente no existe.');
  }
  const next: Parameters<typeof updateClient>[2] = {};
  if (patch.displayName !== undefined) {
    const name = patch.displayName.trim();
    if (name.length === 0 || name.length > 80) {
      throw AppError.unprocessable(ErrorCode.VALIDATION_ERROR, 'El nombre comercial debe tener entre 1 y 80 caracteres.');
    }
    next.displayName = name;
    next.nameCustomized = true;
  }
  if (patch.primaryColor !== undefined) {
    const color = patch.primaryColor.trim().toUpperCase();
    if (!COLOR.test(color)) {
      throw AppError.unprocessable(ErrorCode.VALIDATION_ERROR, 'El color principal debe ser un hexadecimal.');
    }
    next.primaryColor = color;
    next.colorCustomized = color !== DEFAULT_PRIMARY_COLOR;
  }
  if (Object.keys(next).length === 0) {
    return current;
  }
  const updated = await updateClient(db, id, next, now);
  if (updated === null) {
    throw AppError.notFound(ErrorCode.NOT_FOUND, 'El cliente no existe.');
  }
  return updated;
}

export async function syncClientStatus(
  db: Database,
  ownerUserId: string,
  status: 'active' | 'disabled',
  now: Date,
): Promise<void> {
  const row = await findClientByOwner(db, ownerUserId);
  if (row === null || row.status === status) {
    return;
  }
  await updateClient(db, row.id, { status }, now);
}

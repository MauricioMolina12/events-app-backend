import { AppError } from '../../core/errors/app-error';
import { ErrorCode } from '../../core/errors/error-codes';
import type { Database } from '../../db/client';
import {
  DEFAULT_PRIMARY_COLOR,
  DEFAULT_WORKSPACE_NAME,
  type ThemePreference,
} from '../../db/schema';
import { systemClock, toIsoString, type Clock } from '../../db/helpers';
import { displayNameFromEmail, WORKSPACE_NAME_MAX } from './display-name';
import {
  ensureWorkspace,
  findOwnerEmail,
  findThemePreference,
  saveThemePreference,
  updateWorkspace,
  type WorkspaceRow,
} from './workspace.repository';

export interface WorkspaceView {
  readonly displayName: string;
  readonly description: string | null;
  readonly nameCustomized: boolean;
  readonly primaryColor: string;
  readonly colorCustomized: boolean;
  readonly logoUrl: string | null;
  readonly markUrl: string | null;
  readonly updatedAt: string;
}

export interface WorkspaceTextPatch {
  readonly displayName?: string;
  readonly description?: string | null;
  readonly primaryColor?: string;
}

const HEX_COLOR = /^#[0-9A-Fa-f]{6}$/;

export async function readWorkspace(db: Database, clock: Clock = systemClock): Promise<WorkspaceView> {
  return toView(await ensureWorkspace(db, clock()));
}

export async function patchWorkspace(
  db: Database,
  actorId: string,
  patch: WorkspaceTextPatch,
  clock: Clock = systemClock,
): Promise<WorkspaceView> {
  if (
    patch.displayName === undefined &&
    patch.description === undefined &&
    patch.primaryColor === undefined
  ) {
    throw AppError.unprocessable(
      ErrorCode.VALIDATION_ERROR,
      'No hay cambios para guardar.',
    );
  }

  const next: {
    displayName?: string;
    description?: string | null;
    primaryColor?: string;
    nameCustomized?: boolean;
    colorCustomized?: boolean;
  } = {};

  if (patch.displayName !== undefined) {
    const name = patch.displayName.trim();
    if (name.length < 1 || name.length > WORKSPACE_NAME_MAX) {
      throw AppError.unprocessable(ErrorCode.VALIDATION_ERROR, 'El nombre no es valido.');
    }
    next.displayName = name;
    next.nameCustomized = true;
  }

  if (patch.description !== undefined) {
    if (patch.description === null) {
      next.description = null;
    } else {
      const description = patch.description.trim();
      if (description.length > 280) {
        throw AppError.unprocessable(
          ErrorCode.VALIDATION_ERROR,
          'La descripcion admite hasta 280 caracteres.',
        );
      }
      next.description = description.length === 0 ? null : description;
    }
  }

  if (patch.primaryColor !== undefined) {
    if (!HEX_COLOR.test(patch.primaryColor)) {
      throw AppError.unprocessable(
        ErrorCode.VALIDATION_ERROR,
        'El color debe ser un hexadecimal de 6 digitos.',
      );
    }
    next.primaryColor = patch.primaryColor.toUpperCase();
    next.colorCustomized = true;
  }

  return toView(await updateWorkspace(db, next, actorId, clock()));
}

/**
 * Vuelve la identidad compartida a sus valores iniciales.
 *
 * No toca usuarios, sesiones ni preferencias personales. El logotipo no se
 * guarda todavia: no hay almacenamiento de archivos en este despliegue.
 */
export async function restoreWorkspace(
  db: Database,
  actorId: string,
  clock: Clock = systemClock,
): Promise<WorkspaceView> {
  await ensureWorkspace(db, clock());
  const owner = await findOwnerEmail(db);
  const updated = await updateWorkspace(
    db,
    {
      displayName: owner ? displayNameFromEmail(owner) : DEFAULT_WORKSPACE_NAME,
      nameCustomized: false,
      description: null,
      primaryColor: DEFAULT_PRIMARY_COLOR,
      colorCustomized: false,
      logoKey: null,
      logoContentType: null,
      markKey: null,
      markContentType: null,
    },
    actorId,
    clock(),
  );
  return toView(updated);
}

export async function readPreferences(
  db: Database,
  userId: string,
): Promise<{ readonly theme: ThemePreference; readonly persisted: boolean }> {
  const theme = await findThemePreference(db, userId);
  return theme === null ? { theme: 'system', persisted: false } : { theme, persisted: true };
}

export async function writePreferences(
  db: Database,
  userId: string,
  theme: ThemePreference,
  clock: Clock = systemClock,
): Promise<{ readonly theme: ThemePreference; readonly persisted: true }> {
  await saveThemePreference(db, userId, theme, clock());
  return { theme, persisted: true };
}

function toView(row: WorkspaceRow): WorkspaceView {
  const version = row.updatedAt.getTime();
  return {
    displayName: row.displayName,
    description: row.description,
    nameCustomized: row.nameCustomized,
    primaryColor: row.primaryColor,
    colorCustomized: row.colorCustomized,
    logoUrl: row.logoKey ? `workspace/logo?v=${version}` : null,
    markUrl: row.markKey ? `workspace/mark?v=${version}` : null,
    updatedAt: toIsoString(row.updatedAt) ?? row.updatedAt.toISOString(),
  };
}

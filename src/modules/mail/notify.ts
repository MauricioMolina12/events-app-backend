import type { Context } from 'hono';
import type { AppEnv } from '../../core/types/context';
import { createDb, type Database } from '../../db/client';
import { getEventById } from '../events/events.service';
import { getParticipationDetail } from '../participations/participations.service';
import { findActiveQrCodeId, recordQrDelivery } from './deliveries.repository';
import {
  createMailer,
  normalizeRecipient,
  readMailConfig,
  receiptUrl,
  type Mailer,
  type MailMessage,
} from './mailer';
import { checkInEmail, registrationReceiptEmail } from './templates';

export interface RegistrationMailInput {
  readonly registrationId: string;
  readonly email: string | null;
  readonly fullName: string;
  readonly qrCodeId: string;
  readonly participationId: string;
}

export interface CheckInMailInput {
  readonly registrationId: string;
  readonly email: string | null;
  readonly fullName: string;
  readonly eventName: string;
  readonly sedeName: string;
  readonly turns: readonly { readonly number: number; readonly label: string }[];
}

/**
 * Envia el comprobante despues del alta. Nunca relanza: el alta ya respondio.
 */
export async function notifyRegistrationCreated(
  env: CloudflareBindings,
  input: RegistrationMailInput,
): Promise<void> {
  const to = normalizeRecipient(input.email);
  if (to === null) {
    return;
  }

  const db = createDb(env);
  const context = await loadVenue(db, input.participationId);
  const appUrl = readMailConfig(env).appUrl;
  const message = registrationReceiptEmail({
    fullName: input.fullName,
    eventName: context.eventName,
    sedeName: context.sedeName,
    folio: input.registrationId,
    receiptUrl: receiptUrl(appUrl, input.registrationId),
  });

  await deliverAndRecord(db, createMailer(env), {
    qrCodeId: input.qrCodeId,
    destination: to,
    message,
  });
}

/**
 * Avisa el ingreso en el primer escaneo. Un reescaneo no debe llamarla.
 */
export async function notifyCheckInAssigned(
  env: CloudflareBindings,
  input: CheckInMailInput,
): Promise<void> {
  const to = normalizeRecipient(input.email);
  if (to === null) {
    return;
  }

  const db = createDb(env);
  const qrCodeId = await findActiveQrCodeId(db, input.registrationId);
  const message = checkInEmail({
    fullName: input.fullName,
    eventName: input.eventName,
    sedeName: input.sedeName,
    turns: input.turns,
  });

  await deliverAndRecord(db, createMailer(env), {
    qrCodeId,
    destination: to,
    message,
  });
}

export function scheduleMail(c: Context<AppEnv>, task: Promise<void>): void {
  c.executionCtx.waitUntil(
    task.catch((error) => {
      console.error(
        JSON.stringify({
          level: 'error',
          msg: 'mail_notify_failed',
          error: error instanceof Error ? error.message : 'unknown',
        }),
      );
    }),
  );
}

async function deliverAndRecord(
  db: Database,
  mailer: Mailer,
  input: {
    readonly qrCodeId: string | null;
    readonly destination: string;
    readonly message: MailMessage;
  },
): Promise<void> {
  const addressed = { ...input.message, to: input.destination };
  try {
    await mailer.send(addressed);
    if (input.qrCodeId !== null) {
      await recordQrDelivery(db, {
        qrCodeId: input.qrCodeId,
        destination: input.destination,
        status: 'sent',
        provider: mailer.provider,
      });
    }
  } catch (error) {
    if (input.qrCodeId !== null) {
      await recordQrDelivery(db, {
        qrCodeId: input.qrCodeId,
        destination: input.destination,
        status: 'failed',
        provider: mailer.provider,
        errorMessage: error instanceof Error ? error.message.slice(0, 240) : 'unknown',
      });
    }
  }
}

async function loadVenue(
  db: Database,
  participationId: string,
): Promise<{ readonly eventName: string; readonly sedeName: string }> {
  try {
    const { participation, establishment } = await getParticipationDetail(db, participationId);
    const event = await getEventById(db, participation.eventId);
    const sedeName = establishment.city
      ? `${establishment.name} · ${establishment.city}`
      : establishment.name;
    return { eventName: event.name, sedeName };
  } catch {
    return { eventName: 'el evento', sedeName: 'la sede' };
  }
}

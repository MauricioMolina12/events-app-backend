import { and, eq } from 'drizzle-orm';
import type { Database } from '../../db/client';
import { newId } from '../../db/helpers';
import { qrCodes, qrDeliveries, type QrDeliveryStatus } from '../../db/schema';

export interface RecordQrDeliveryInput {
  readonly qrCodeId: string;
  readonly destination: string;
  readonly status: QrDeliveryStatus;
  readonly provider: string;
  readonly errorMessage?: string | null;
  readonly now?: Date;
}

export async function findActiveQrCodeId(
  db: Database,
  registrationId: string,
): Promise<string | null> {
  const [row] = await db
    .select({ id: qrCodes.id })
    .from(qrCodes)
    .where(and(eq(qrCodes.registrationId, registrationId), eq(qrCodes.status, 'active')))
    .limit(1);

  return row?.id ?? null;
}

export async function recordQrDelivery(
  db: Database,
  input: RecordQrDeliveryInput,
): Promise<void> {
  const now = input.now ?? new Date();
  await db.insert(qrDeliveries).values({
    id: newId(),
    qrCodeId: input.qrCodeId,
    channel: 'email',
    destination: input.destination,
    status: input.status,
    provider: input.provider,
    attemptedAt: now,
    sentAt: input.status === 'sent' ? now : null,
    errorMessage: input.errorMessage ?? null,
    createdBy: null,
    createdAt: now,
  });
}

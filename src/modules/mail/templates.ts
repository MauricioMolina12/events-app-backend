import type { MailMessage } from './mailer';

export interface RegistrationReceiptCopy {
  readonly fullName: string;
  readonly eventName: string;
  readonly sedeName: string;
  readonly folio: string;
  readonly receiptUrl: string;
}

export interface CheckInCopy {
  readonly fullName: string;
  readonly eventName: string;
  readonly sedeName: string;
  readonly turns: readonly { readonly number: number; readonly label: string }[];
}

export function registrationReceiptEmail(copy: RegistrationReceiptCopy): MailMessage {
  const subject = `Tu inscripción a ${copy.eventName}`;
  const text = [
    `Hola, ${copy.fullName}.`,
    '',
    `Tu inscripción a ${copy.eventName} en ${copy.sedeName} quedó confirmada.`,
    `Folio: ${copy.folio}`,
    '',
    'Guarda este enlace: es tu comprobante y el código QR para ingresar.',
    copy.receiptUrl,
    '',
    'Star Grow Studio',
  ].join('\n');

  return {
    to: '',
    subject,
    text,
    html: layout({
      title: subject,
      intro: `Hola, ${escapeHtml(copy.fullName)}.`,
      body: `<p>Tu inscripción a <strong>${escapeHtml(copy.eventName)}</strong> en ${escapeHtml(copy.sedeName)} quedó confirmada.</p>
<p>Folio: <strong>${escapeHtml(copy.folio)}</strong></p>
<p>Guarda este enlace: es tu comprobante y el código QR para ingresar.</p>`,
      actionLabel: 'Ver mi comprobante',
      actionHref: copy.receiptUrl,
    }),
  };
}

export function checkInEmail(copy: CheckInCopy): MailMessage {
  const subject = `Registramos tu ingreso a ${copy.eventName}`;
  const turnsText = copy.turns
    .map((turn) => `  · ${turn.label}: turno ${turn.number}`)
    .join('\n');
  const turnsHtml = copy.turns
    .map((turn) => `<li>${escapeHtml(turn.label)}: <strong>${turn.number}</strong></li>`)
    .join('');

  const text = [
    `Hola, ${copy.fullName}.`,
    '',
    `Ya registramos tu ingreso a ${copy.eventName} en ${copy.sedeName}.`,
    'Tus turnos:',
    turnsText,
    '',
    'Star Grow Studio',
  ].join('\n');

  return {
    to: '',
    subject,
    text,
    html: layout({
      title: subject,
      intro: `Hola, ${escapeHtml(copy.fullName)}.`,
      body: `<p>Ya registramos tu ingreso a <strong>${escapeHtml(copy.eventName)}</strong> en ${escapeHtml(copy.sedeName)}.</p>
<p>Tus turnos:</p>
<ul>${turnsHtml}</ul>`,
    }),
  };
}

function layout(input: {
  readonly title: string;
  readonly intro: string;
  readonly body: string;
  readonly actionLabel?: string;
  readonly actionHref?: string;
}): string {
  const action =
    input.actionLabel !== undefined && input.actionHref !== undefined
      ? `<p style="margin:24px 0"><a href="${escapeHtml(input.actionHref)}" style="display:inline-block;padding:12px 18px;border-radius:8px;background:#6d28d9;color:#fff;text-decoration:none;font-weight:600">${escapeHtml(input.actionLabel)}</a></p>`
      : '';

  return `<!doctype html>
<html lang="es">
  <body style="margin:0;padding:24px;background:#0b1020;color:#e8e6f0;font-family:Georgia,serif">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;margin:0 auto;background:#14182b;border-radius:16px;padding:28px">
      <tr><td>
        <p style="margin:0 0 4px;color:#a9a3c2;font-size:12px;letter-spacing:0.08em;text-transform:uppercase">Star Grow Studio</p>
        <h1 style="margin:0 0 16px;font-size:22px;line-height:1.3;color:#fff">${escapeHtml(input.title)}</h1>
        <p>${input.intro}</p>
        ${input.body}
        ${action}
        <p style="margin:28px 0 0;color:#a9a3c2;font-size:13px">Si no te inscribiste, puedes ignorar este mensaje.</p>
      </td></tr>
    </table>
  </body>
</html>`;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

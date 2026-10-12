/**
 * Puerto de correo transaccional.
 *
 * El dominio no conoce Resend: las rutas piden un `Mailer` y registran el
 * resultado en `qr_deliveries`. Sin `RESEND_API_KEY` el adaptador es un no-op
 * que falla de forma explicita, para que el alta y el escaneo sigan
 * respondiendo y la auditoria deje constancia.
 */

export interface MailMessage {
  readonly to: string;
  readonly subject: string;
  readonly text: string;
  readonly html: string;
}

export interface Mailer {
  readonly provider: string;
  send(message: MailMessage): Promise<void>;
}

export interface MailConfig {
  readonly apiKey: string | undefined;
  readonly from: string;
  readonly appUrl: string;
}

const DEFAULT_FROM = 'Star Grow Studio <onboarding@resend.dev>';
const DEFAULT_APP_URL = 'https://stargrowstudio.vercel.app';

export function readMailConfig(env: CloudflareBindings): MailConfig {
  return {
    apiKey: optionalBinding(env, 'RESEND_API_KEY'),
    from: optionalBinding(env, 'MAIL_FROM') ?? DEFAULT_FROM,
    appUrl: stripTrailingSlash(optionalBinding(env, 'PUBLIC_APP_URL') ?? DEFAULT_APP_URL),
  };
}

export function createMailer(env: CloudflareBindings): Mailer {
  const config = readMailConfig(env);
  if (config.apiKey === undefined) {
    return createUnconfiguredMailer();
  }
  return createResendMailer(config.apiKey, config.from);
}

export function createUnconfiguredMailer(): Mailer {
  return {
    provider: 'noop',
    async send(): Promise<void> {
      throw new Error('RESEND_API_KEY no configurada');
    },
  };
}

export function createResendMailer(apiKey: string, from: string): Mailer {
  return {
    provider: 'resend',
    async send(message: MailMessage): Promise<void> {
      const response = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          from,
          to: [message.to],
          subject: message.subject,
          html: message.html,
          text: message.text,
        }),
      });

      if (!response.ok) {
        const body = await response.text();
        throw new Error(`Resend ${response.status}: ${body.slice(0, 180)}`);
      }
    },
  };
}

export function normalizeRecipient(email: string | null | undefined): string | null {
  const trimmed = email?.trim().toLowerCase() ?? '';
  return trimmed.includes('@') ? trimmed : null;
}

export function receiptUrl(appUrl: string, registrationId: string): string {
  return `${stripTrailingSlash(appUrl)}/inscripcion/${registrationId}`;
}

function stripTrailingSlash(value: string): string {
  return value.replace(/\/+$/u, '');
}

function optionalBinding(env: CloudflareBindings, name: string): string | undefined {
  const value = (env as unknown as Record<string, unknown>)[name];
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}

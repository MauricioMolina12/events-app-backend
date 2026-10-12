import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createResendMailer,
  createUnconfiguredMailer,
  normalizeRecipient,
  readMailConfig,
  receiptUrl,
} from '../../src/modules/mail/mailer';
import { checkInEmail, registrationReceiptEmail } from '../../src/modules/mail/templates';

describe('normalizeRecipient', () => {
  it('acepta un correo con espacios y lo deja en minusculas', () => {
    expect(normalizeRecipient('  Ana@Example.com ')).toBe('ana@example.com');
  });

  it('rechaza un valor vacio o sin arroba', () => {
    expect(normalizeRecipient(null)).toBeNull();
    expect(normalizeRecipient('   ')).toBeNull();
    expect(normalizeRecipient('sin-correo')).toBeNull();
  });
});

describe('receiptUrl', () => {
  it('arma el enlace publico del comprobante sin barra final duplicada', () => {
    expect(receiptUrl('https://stargrowstudio.vercel.app/', 'reg-1')).toBe(
      'https://stargrowstudio.vercel.app/inscripcion/reg-1',
    );
  });
});

describe('plantillas', () => {
  it('el comprobante nombra el evento, el folio y el enlace', () => {
    const message = registrationReceiptEmail({
      fullName: 'Ana Pérez',
      eventName: 'Gran madrugón 2026',
      sedeName: 'Barby Toys · Bogotá',
      folio: 'folio-1',
      receiptUrl: 'https://stargrowstudio.vercel.app/inscripcion/folio-1',
    });

    expect(message.subject).toContain('Gran madrugón 2026');
    expect(message.text).toContain('Ana Pérez');
    expect(message.text).toContain('folio-1');
    expect(message.text).toContain('https://stargrowstudio.vercel.app/inscripcion/folio-1');
    expect(message.html).toContain('Ver mi comprobante');
    expect(message.html).not.toContain('<script');
  });

  it('el ingreso lista los turnos sin datos de documento', () => {
    const message = checkInEmail({
      fullName: 'Ana Pérez',
      eventName: 'Gran madrugón 2026',
      sedeName: 'Barby Toys',
      turns: [
        { number: 12, label: 'Ana Pérez' },
        { number: 13, label: 'Luis Pérez' },
      ],
    });

    expect(message.subject).toContain('ingreso');
    expect(message.text).toContain('turno 12');
    expect(message.text).toContain('Luis Pérez');
    expect(message.text).not.toContain('CC');
  });
});

describe('mailer', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('lee la URL publica y el remitente de los bindings', () => {
    const config = readMailConfig({
      PUBLIC_APP_URL: 'https://stargrowstudio.vercel.app/',
      MAIL_FROM: 'Eventos <hola@stargrowstudio.com>',
    } as CloudflareBindings);

    expect(config.appUrl).toBe('https://stargrowstudio.vercel.app');
    expect(config.from).toBe('Eventos <hola@stargrowstudio.com>');
    expect(config.apiKey).toBeUndefined();
  });

  it('sin clave el adaptador explica que falta configurar Resend', async () => {
    const mailer = createUnconfiguredMailer();
    await expect(mailer.send({ to: 'a@b.co', subject: 'x', text: 'x', html: 'x' })).rejects.toThrow(
      /RESEND_API_KEY/,
    );
    expect(mailer.provider).toBe('noop');
  });

  it('Resend envia el JSON esperado y falla con el status del proveedor', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      text: async () => '{"message":"invalid"}',
    });
    vi.stubGlobal('fetch', fetchMock);

    const mailer = createResendMailer('re_test', 'Star Grow Studio <onboarding@resend.dev>');
    await expect(
      mailer.send({
        to: 'ana@example.com',
        subject: 'Hola',
        text: 'Hola',
        html: '<p>Hola</p>',
      }),
    ).rejects.toThrow(/Resend 401/);

    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.resend.com/emails',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ Authorization: 'Bearer re_test' }),
      }),
    );
  });
});

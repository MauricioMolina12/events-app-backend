import { SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

interface HealthBody {
  success: boolean;
  data: {
    status: 'ok' | 'degraded';
    service: string;
    version: string;
    environment: string;
    timestamp: string;
    database: 'up' | 'down' | 'not_configured';
  };
}

describe('GET /api/v1/health', () => {
  it('responde 200 con el estado del servicio y D1 operativo', async () => {
    const response = await SELF.fetch('https://example.com/api/v1/health');

    expect(response.status).toBe(200);

    const body = await response.json<HealthBody>();

    expect(body.success).toBe(true);
    expect(body.data.status).toBe('ok');
    expect(body.data.service).toBe('events-api');
    expect(body.data.environment).toBe('local');
    expect(body.data.database).toBe('up');
    expect(Number.isNaN(Date.parse(body.data.timestamp))).toBe(false);
  });

  it('incluye la cabecera x-request-id en la respuesta', async () => {
    const response = await SELF.fetch('https://example.com/api/v1/health');
    expect(response.headers.get('x-request-id')).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });
});

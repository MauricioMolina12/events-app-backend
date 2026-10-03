import { SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

interface ErrorBody {
  success: false;
  error: { code: string; message: string };
  requestId?: string;
}

const KNOWN_REQUEST_ID = 'req-abc12345';

describe('contrato de la API', () => {
  it('responde 404 con el sobre de error comun', async () => {
    const response = await SELF.fetch('https://example.com/api/v1/ruta-inexistente');

    expect(response.status).toBe(404);

    const body = await response.json<ErrorBody>();

    expect(body.success).toBe(false);
    expect(body.error.code).toBe('ROUTE_NOT_FOUND');
    expect(body.requestId).toBeTruthy();
  });

  it('reutiliza un x-request-id valido y descarta uno invalido', async () => {
    const reusing = await SELF.fetch('https://example.com/api/v1/health', {
      headers: { 'x-request-id': KNOWN_REQUEST_ID },
    });
    expect(reusing.headers.get('x-request-id')).toBe(KNOWN_REQUEST_ID);

    const rejecting = await SELF.fetch('https://example.com/api/v1/health', {
      headers: { 'x-request-id': 'no' },
    });
    expect(rejecting.headers.get('x-request-id')).not.toBe('no');
  });

  it('aplica CORS solo a los origenes autorizados', async () => {
    const allowed = await SELF.fetch('https://example.com/api/v1/health', {
      headers: { Origin: 'http://localhost:5173' },
    });
    expect(allowed.headers.get('access-control-allow-origin')).toBe('http://localhost:5173');
    expect(allowed.headers.get('access-control-allow-credentials')).toBe('true');

    const blocked = await SELF.fetch('https://example.com/api/v1/health', {
      headers: { Origin: 'https://evil.example.com' },
    });
    expect(blocked.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('publica el documento OpenAPI con las rutas bajo el prefijo versionado', async () => {
    const response = await SELF.fetch('https://example.com/api/v1/openapi.json');
    expect(response.status).toBe(200);

    const document = await response.json<{
      openapi: string;
      info: { title: string; version: string };
      paths: Record<string, unknown>;
    }>();

    expect(document.openapi).toBe('3.1.0');
    expect(document.info.version).toBe('0.1.0');
    expect(Object.keys(document.paths)).toContain('/api/v1/health');
  });

  it('sirve la documentacion interactiva en /api/v1/docs', async () => {
    const response = await SELF.fetch('https://example.com/api/v1/docs');
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/html');
  });
});

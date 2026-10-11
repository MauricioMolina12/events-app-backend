import { describe, expect, it } from 'vitest';
import { inspectLogo } from '../../src/modules/workspace/logo-file';

const PNG = Uint8Array.from(
  atob(
    'iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAAL0lEQVR4nO3OIQEAAAgDMJpQj6i0ghg3E/Or7bmkEhAQEBAQEBAQEBAQEBAQSAceDyo4iBJTKloAAAAASUVORK5CYII=',
  ),
  (char) => char.charCodeAt(0),
);

describe('inspectLogo', () => {
  it('acepta un PNG real y lee sus dimensiones', () => {
    expect(inspectLogo(PNG)).toEqual({
      ok: true,
      contentType: 'image/png',
      width: 32,
      height: 32,
    });
  });

  it('rechaza SVG y bytes que no son una imagen', () => {
    const svg = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"></svg>');
    expect(inspectLogo(svg)).toEqual({ ok: false, reason: 'type' });
    expect(inspectLogo(new Uint8Array([0, 1, 2, 3]))).toEqual({ ok: false, reason: 'type' });
  });

  it('rechaza un PNG mas chico que el minimo', () => {
    const tiny = PNG.slice();
    tiny[16] = 0;
    tiny[17] = 0;
    tiny[18] = 0;
    tiny[19] = 8;
    expect(inspectLogo(tiny)).toEqual({ ok: false, reason: 'dimensions' });
  });
});

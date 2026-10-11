/**
 * Inspeccion de logotipos.
 *
 * El tipo se decide por la firma del archivo, no por el nombre ni por el
 * `Content-Type` que envia el cliente. SVG queda fuera: servirlo tal cual
 * permite incrustar script.
 */

export const LOGO_MAX_BYTES = 1_500_000;
export const LOGO_MIN_EDGE = 16;
export const LOGO_MAX_EDGE = 2048;

export const LOGO_CONTENT_TYPES = ['image/png', 'image/jpeg', 'image/webp'] as const;
export type LogoContentType = (typeof LOGO_CONTENT_TYPES)[number];

export type LogoInspection =
  | { readonly ok: true; readonly contentType: LogoContentType; readonly width: number; readonly height: number }
  | { readonly ok: false; readonly reason: 'type' | 'dimensions' };

export function inspectLogo(bytes: Uint8Array): LogoInspection {
  const image = sniff(bytes);
  if (image === null) {
    return { ok: false, reason: 'type' };
  }
  if (
    image.width < LOGO_MIN_EDGE ||
    image.height < LOGO_MIN_EDGE ||
    image.width > LOGO_MAX_EDGE ||
    image.height > LOGO_MAX_EDGE
  ) {
    return { ok: false, reason: 'dimensions' };
  }
  return { ok: true, contentType: image.contentType, width: image.width, height: image.height };
}

interface SniffedImage {
  readonly contentType: LogoContentType;
  readonly width: number;
  readonly height: number;
}

function sniff(bytes: Uint8Array): SniffedImage | null {
  return sniffPng(bytes) ?? sniffJpeg(bytes) ?? sniffWebp(bytes);
}

function sniffPng(bytes: Uint8Array): SniffedImage | null {
  const signature = [137, 80, 78, 71, 13, 10, 26, 10];
  if (bytes.length < 24 || !signature.every((value, index) => bytes[index] === value)) {
    return null;
  }
  const ihdr = readAscii(bytes, 12, 4);
  if (ihdr !== 'IHDR') {
    return null;
  }
  return {
    contentType: 'image/png',
    width: readUint32BE(bytes, 16),
    height: readUint32BE(bytes, 20),
  };
}

function sniffJpeg(bytes: Uint8Array): SniffedImage | null {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) {
    return null;
  }
  let offset = 2;
  while (offset + 3 < bytes.length) {
    if (bytes[offset] !== 0xff) {
      return null;
    }
    while (bytes[offset] === 0xff && offset < bytes.length) {
      offset += 1;
    }
    const marker = bytes[offset];
    if (marker === undefined) {
      return null;
    }
    offset += 1;
    if (marker === 0xd9 || marker === 0xda) {
      return null;
    }
    if (marker >= 0xd0 && marker <= 0xd8) {
      continue;
    }
    if (offset + 1 >= bytes.length) {
      return null;
    }
    const length = readUint16BE(bytes, offset);
    if (length < 2 || offset + length > bytes.length) {
      return null;
    }
    const isSof =
      marker === 0xc0 ||
      marker === 0xc1 ||
      marker === 0xc2 ||
      marker === 0xc3 ||
      marker === 0xc5 ||
      marker === 0xc6 ||
      marker === 0xc7 ||
      marker === 0xc9 ||
      marker === 0xca ||
      marker === 0xcb ||
      marker === 0xcd ||
      marker === 0xce ||
      marker === 0xcf;
    if (isSof && length >= 7) {
      return {
        contentType: 'image/jpeg',
        height: readUint16BE(bytes, offset + 3),
        width: readUint16BE(bytes, offset + 5),
      };
    }
    offset += length;
  }
  return null;
}

function sniffWebp(bytes: Uint8Array): SniffedImage | null {
  if (bytes.length < 30 || readAscii(bytes, 0, 4) !== 'RIFF' || readAscii(bytes, 8, 4) !== 'WEBP') {
    return null;
  }
  const chunk = readAscii(bytes, 12, 4);
  if (chunk === 'VP8X' && bytes.length >= 30) {
    return {
      contentType: 'image/webp',
      width: 1 + readUint24LE(bytes, 24),
      height: 1 + readUint24LE(bytes, 27),
    };
  }
  if (chunk === 'VP8 ' && bytes.length >= 30 && bytes[23] === 0x9d && bytes[24] === 0x01 && bytes[25] === 0x2a) {
    return {
      contentType: 'image/webp',
      width: readUint16LE(bytes, 26) & 0x3fff,
      height: readUint16LE(bytes, 28) & 0x3fff,
    };
  }
  if (chunk === 'VP8L' && bytes.length >= 25 && bytes[20] === 0x2f) {
    const bits = readUint32LE(bytes, 21);
    return {
      contentType: 'image/webp',
      width: (bits & 0x3fff) + 1,
      height: ((bits >> 14) & 0x3fff) + 1,
    };
  }
  return null;
}

function readAscii(bytes: Uint8Array, offset: number, length: number): string {
  let text = '';
  for (let index = 0; index < length; index += 1) {
    text += String.fromCharCode(bytes[offset + index] ?? 0);
  }
  return text;
}

function readUint16BE(bytes: Uint8Array, offset: number): number {
  return ((bytes[offset] ?? 0) << 8) | (bytes[offset + 1] ?? 0);
}

function readUint32BE(bytes: Uint8Array, offset: number): number {
  return (
    ((bytes[offset] ?? 0) * 0x1000000) +
    ((bytes[offset + 1] ?? 0) << 16) +
    ((bytes[offset + 2] ?? 0) << 8) +
    (bytes[offset + 3] ?? 0)
  );
}

function readUint16LE(bytes: Uint8Array, offset: number): number {
  return (bytes[offset] ?? 0) | ((bytes[offset + 1] ?? 0) << 8);
}

function readUint24LE(bytes: Uint8Array, offset: number): number {
  return (bytes[offset] ?? 0) | ((bytes[offset + 1] ?? 0) << 8) | ((bytes[offset + 2] ?? 0) << 16);
}

function readUint32LE(bytes: Uint8Array, offset: number): number {
  return (
    (bytes[offset] ?? 0) |
    ((bytes[offset + 1] ?? 0) << 8) |
    ((bytes[offset + 2] ?? 0) << 16) |
    ((bytes[offset + 3] ?? 0) << 24)
  );
}

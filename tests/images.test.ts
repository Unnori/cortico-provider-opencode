import { describe, expect, it } from 'vitest';
import type { Request } from 'cortico/protocol/open-responses/index.ts';
import { message, record } from 'cortico/protocol/open-responses/context.ts';
import {
  CROWDED_IMAGE_COUNT,
  CROWDED_LONG_SIDE_LIMIT,
  LONG_SIDE_LIMIT,
  fitsLimit,
  guardedMedia,
  imageSize,
  longSideLimit,
  supportsImageMime,
  sanitizeNativeImages,
  requestImageCount,
  type DroppedImage,
} from '../src/images.ts';

/** A minimal PNG: signature, IHDR with the given dimensions, then filler. */
function png(width: number, height: number): Buffer {
  const bytes = Buffer.alloc(64);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes, 0);
  bytes.writeUInt32BE(13, 8);
  bytes.write('IHDR', 12, 'ascii');
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  return bytes;
}

/** A minimal JPEG: SOI, APP0 (length 16), then an SOF0 carrying the dimensions. */
function jpeg(width: number, height: number): Buffer {
  const app0 = Buffer.alloc(18);
  app0[0] = 0xff;
  app0[1] = 0xe0;
  app0.writeUInt16BE(16, 2);
  app0.write('JFIF', 4, 'ascii');
  const sof = Buffer.alloc(19);
  sof[0] = 0xff;
  sof[1] = 0xc0;
  sof.writeUInt16BE(17, 2);
  sof[4] = 8;
  sof.writeUInt16BE(height, 5);
  sof.writeUInt16BE(width, 7);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app0, sof]);
}

function webp(kind: 'VP8X' | 'VP8 ' | 'VP8L', width: number, height: number): Buffer {
  const bytes = Buffer.alloc(kind === 'VP8L' ? 26 : 30);
  bytes.write('RIFF', 0, 'ascii');
  bytes.writeUInt32LE(bytes.length - 8, 4);
  bytes.write('WEBP', 8, 'ascii');
  bytes.write(kind, 12, 'ascii');
  bytes.writeUInt32LE(bytes.length - 20, 16);
  if (kind === 'VP8X') {
    bytes.writeUIntLE(width - 1, 24, 3);
    bytes.writeUIntLE(height - 1, 27, 3);
  } else if (kind === 'VP8 ') {
    Buffer.from([0x9d, 0x01, 0x2a]).copy(bytes, 23);
    bytes.writeUInt16LE(width, 26);
    bytes.writeUInt16LE(height, 28);
  } else {
    bytes[20] = 0x2f;
    bytes.writeUInt32LE((width - 1) | ((height - 1) << 14), 21);
  }
  return bytes;
}

describe('image formats', () => {
  it('advertises only the formats whose bytes the guard accepts', () => {
    for (const mime of ['image/png', 'image/jpeg', 'image/webp']) expect(supportsImageMime(mime)).toBe(true);
    for (const mime of ['image/gif', 'image/bmp', 'image/svg+xml', 'image/avif', 'text/plain']) expect(supportsImageMime(mime)).toBe(false);
  });
});

describe('image dimensions', () => {
  it('reads a PNG from its IHDR', () => {
    expect(imageSize(png(430, 15222))).toEqual({ width: 430, height: 15222 });
  });

  it('reads a JPEG from its frame header, after skipping APPn segments', () => {
    expect(imageSize(jpeg(413, 14602))).toEqual({ width: 413, height: 14602 });
  });

  it('accepts JPEG fill bytes but rejects truncated segments', () => {
    const original = jpeg(413, 500);
    const padded = Buffer.concat([original.subarray(0, 2), Buffer.from([0xff, 0xff]), original.subarray(2)]);
    expect(imageSize(padded)).toEqual({ width: 413, height: 500 });
    expect(imageSize(original.subarray(0, original.length - 1))).toBeNull();
  });

  it.each(['VP8X', 'VP8 ', 'VP8L'] as const)('reads a %s WebP header, including short lossless images', (kind) => {
    expect(imageSize(webp(kind, 436, 503))).toEqual({ width: 436, height: 503 });
  });

  it('does not accept a partial PNG signature or an invalid first chunk', () => {
    const partial = png(10, 20);
    partial[4] = 0;
    expect(imageSize(partial)).toBeNull();
    const invalidChunk = png(10, 20);
    invalidChunk.write('IDAT', 12, 'ascii');
    expect(imageSize(invalidChunk)).toBeNull();
  });

  it('reports nothing for bytes whose format carries no readable header', () => {
    expect(imageSize(Buffer.from('not an image at all'))).toBeNull();
    expect(imageSize(Buffer.alloc(4))).toBeNull();
  });
});

describe('limits', () => {
  it('drops to the crowded limit once the request carries that many images', () => {
    expect(longSideLimit(CROWDED_IMAGE_COUNT - 1)).toBe(LONG_SIDE_LIMIT);
    expect(longSideLimit(CROWDED_IMAGE_COUNT)).toBe(CROWDED_LONG_SIDE_LIMIT);
  });

  it('compares the long side, whichever axis it is on', () => {
    expect(fitsLimit({ width: 430, height: 15222 }, 1)).toBe(false);
    expect(fitsLimit({ width: 15222, height: 430 }, 1)).toBe(false);
    expect(fitsLimit({ width: 436, height: 503 }, 1)).toBe(true);
  });

  it('rejects an unreadable header so it cannot poison history replay', () => {
    expect(fitsLimit(null, 1)).toBe(false);
  });
});

describe('guarded media', () => {
  const live: Record<string, Buffer> = { small: png(436, 503), tall: png(413, 14602) };

  it('leaves an oversized image out and keeps the others', () => {
    const dropped: string[] = [];
    const media = guardedMedia({
      enabled: () => true,
      read: (handle) => live[handle] ?? null,
      onDropped: ({ handle }) => dropped.push(handle),
    });

    expect(media.read('tall')).toBeNull();
    expect(media.read('small')).not.toBeNull();
    expect(dropped).toEqual(['tall']);
  });

  it.each(['GIF87a', 'GIF89a'])('drops %s bytes on every replay and records the detected format', (signature) => {
    const dropped: DroppedImage[] = [];
    const media = guardedMedia({
      enabled: () => true,
      read: () => Buffer.from(signature + 'payload'),
      onDropped: (info) => dropped.push(info),
    });
    for (let pass = 0; pass < 3; pass++) expect(media.read('gif')).toBeNull();
    expect(dropped).toEqual(Array.from({ length: 3 }, () => ({ handle: 'gif', reason: 'unsupported-format', mime: 'image/gif' })));
  });

  it('drops unknown formats and malformed supported headers with distinct reasons', () => {
    const dropped: DroppedImage[] = [];
    const bytes = new Map([
      ['unknown', Buffer.from('<svg/>')],
      ['invalid', png(0, 20)],
    ]);
    const media = guardedMedia({ enabled: () => true, read: (handle) => bytes.get(handle) ?? null, onDropped: (info) => dropped.push(info) });
    expect(media.read('unknown')).toBeNull();
    expect(media.read('invalid')).toBeNull();
    expect(dropped).toEqual([
      { handle: 'unknown', reason: 'unsupported-format', mime: null },
      { handle: 'invalid', reason: 'invalid-header', mime: 'image/png' },
    ]);
  });

  it('keeps PNG, JPEG and all three WebP encodings', () => {
    for (const bytes of [png(10, 20), jpeg(10, 20), webp('VP8X', 10, 20), webp('VP8 ', 10, 20), webp('VP8L', 10, 20)]) {
      const media = guardedMedia({ enabled: () => true, read: () => bytes });
      expect(media.read('supported')).toBe(bytes);
    }
  });

  it('applies the crowded limit to the fifteenth distinct image in one pass', () => {
    const bytes = new Map<string, Buffer>();
    for (let i = 0; i < CROWDED_IMAGE_COUNT; i++) {
      bytes.set(`img${i}`, i === CROWDED_IMAGE_COUNT - 1 ? png(8192, 8192) : png(400, 400));
    }
    const dropped: number[] = [];
    const media = guardedMedia({
      enabled: () => true,
      read: (handle) => bytes.get(handle) ?? null,
      onDropped: (info) => { if (info.reason === 'dimensions') dropped.push(info.limit); },
    }).forRequest(CROWDED_IMAGE_COUNT);
    for (let i = 0; i < CROWDED_IMAGE_COUNT; i++) media.read(`img${i}`);
    // 8192 fits alone but not in a crowd, so only the fifteenth image is refused.
    expect(dropped).toEqual([CROWDED_LONG_SIDE_LIMIT]);
  });

  it('keeps concurrent and subsequent render passes independent', () => {
    const guard = guardedMedia({ enabled: () => true, read: () => png(8192, 8192) });
    const crowded = guard.forRequest(CROWDED_IMAGE_COUNT);
    const roomy = guard.forRequest(1);
    expect(crowded.read('img0')).toBeNull();
    expect(roomy.read('img0')).not.toBeNull();
    expect(crowded.read('img0')).toBeNull();
    expect(roomy.read('img0')).not.toBeNull();
  });

  it('applies the crowded limit from the first image and does not reset on repeated handles', () => {
    const dropped: number[] = [];
    const media = guardedMedia({
      enabled: () => true,
      read: () => png(8192, 8192),
      onDropped: (info) => { if (info.reason === 'dimensions') dropped.push(info.count); },
    }).forRequest(CROWDED_IMAGE_COUNT);
    for (let i = 0; i < CROWDED_IMAGE_COUNT - 1; i++) media.read(`img${i}`);
    media.read('img5');
    expect(dropped).toEqual(Array(CROWDED_IMAGE_COUNT).fill(CROWDED_IMAGE_COUNT));
  });

  it('leaves a handle it cannot read alone', () => {
    const media = guardedMedia({ enabled: () => true, read: () => null });
    expect(media.read('missing')).toBeNull();
  });
});

describe('native inline image sanitization', () => {
  const gif = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');

  it('filters inline GIFs and malformed data URLs without mutating request input', () => {
    const good = png(10, 20);
    const request: Request = { model: 'test', input: [{ type: 'message', role: 'user', content: [
      { type: 'input_text', text: 'please continue' },
      { type: 'input_image', image_url: `  data:image/png;base64,${gif.toString('base64')}\n` },
      { type: 'input_image', image_url: 'data:image/png;base64,???' },
      { type: 'input_image', image_url: `data:image/gif;base64,${good.toString('base64')}` },
      { type: 'input_image', image_url: 'https://example.invalid/image.png' },
    ] }] };
    const original = structuredClone(request);
    const dropped: DroppedImage[] = [];
    const media = guardedMedia({ enabled: () => true, read: () => null, onDropped: (info) => dropped.push(info) });
    const options = sanitizeNativeImages(request, {}, media);
    const serialized = JSON.stringify(options.context);
    expect(serialized).not.toContain(gif.toString('base64'));
    expect(serialized).not.toContain('???');
    expect(serialized).toContain(`data:image/png;base64,${good.toString('base64')}`);
    expect(serialized).toContain('https://example.invalid/image.png');
    expect(serialized).toContain('please continue');
    expect(request).toEqual(original);
    expect(dropped.map((info) => info.reason)).toEqual(['unsupported-format', 'invalid-data-url']);
  });

  it('sanitizes the effective context, including tool outputs and blob MIME labels', () => {
    const good = png(10, 20);
    const context = [
      record({ type: 'function_call_output', call_id: 'call', output: [
        { type: 'input_image', image_url: `data:image/png;base64,${gif.toString('base64')}` },
      ] }),
      message('user', 'saved attachment fallback', { blobs: [
        { handle: 'good', mime: 'image/gif', fallbackText: 'saved attachment fallback' },
        { handle: 'bad', mime: 'image/png', fallbackText: 'bad attachment fallback' },
      ] }),
    ];
    const original = structuredClone(context);
    const media = guardedMedia({ enabled: () => true, read: (handle) => handle === 'good' ? good : gif });
    const result = sanitizeNativeImages({ input: 'ignored input' }, { context }, media);
    expect(result.context?.[1].context.blobs).toEqual([{ handle: 'good', mime: 'image/png', fallbackText: 'saved attachment fallback' }]);
    expect(JSON.stringify(result.context)).not.toContain(gif.toString('base64'));
    expect(context).toEqual(original);
  });

  it('includes inline parts and every repeated blob occurrence in the request count', () => {
    const context = [message('user', 'images', { blobs: Array.from({ length: 14 }, () => ({
      handle: 'repeated', mime: 'image/png', fallbackText: 'image',
    })) }), record({ type: 'message', role: 'user', content: [
      { type: 'input_image', image_url: `data:image/png;base64,${png(8192, 8192).toString('base64')}` },
    ] })];
    const request: Request = { input: [] };
    expect(requestImageCount(request, { context })).toBe(15);
    const media = guardedMedia({ enabled: () => true, read: () => png(10, 20) });
    const result = sanitizeNativeImages(request, { context }, media);
    expect(JSON.stringify(result.context)).not.toContain(png(8192, 8192).toString('base64'));
  });

  it('does not let rejected GIFs force a valid large image into the crowded tier', () => {
    const good = png(8192, 8192);
    const context = [message('user', 'images', { blobs: [
      ...Array.from({ length: 14 }, () => ({ handle: 'gif', mime: 'image/gif', fallbackText: 'GIF' })),
      { handle: 'good', mime: 'image/png', fallbackText: 'PNG' },
    ] })];
    const media = guardedMedia({ enabled: () => true, read: (handle) => handle === 'good' ? good : gif });
    const result = sanitizeNativeImages({ input: [] }, { context }, media);
    expect(result.context?.[0].context.blobs).toEqual([{ handle: 'good', mime: 'image/png', fallbackText: 'PNG' }]);
  });
});

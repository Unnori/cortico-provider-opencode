import { describe, expect, it } from 'vitest';
import {
  CROWDED_IMAGE_COUNT,
  CROWDED_LONG_SIDE_LIMIT,
  LONG_SIDE_LIMIT,
  fitsLimit,
  guardedMedia,
  imageSize,
  longSideLimit,
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

describe('image dimensions', () => {
  it('reads a PNG from its IHDR', () => {
    expect(imageSize(png(430, 15222))).toEqual({ width: 430, height: 15222 });
  });

  it('reads a JPEG from its frame header, after skipping APPn segments', () => {
    expect(imageSize(jpeg(413, 14602))).toEqual({ width: 413, height: 14602 });
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

  it('lets an unreadable header through rather than guessing a rejection', () => {
    expect(fitsLimit(null, 1)).toBe(true);
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

  it('applies the crowded limit to the fifteenth distinct image in one pass', () => {
    const bytes = new Map<string, Buffer>();
    for (let i = 0; i < CROWDED_IMAGE_COUNT; i++) {
      bytes.set(`img${i}`, i === CROWDED_IMAGE_COUNT - 1 ? png(8192, 8192) : png(400, 400));
    }
    const dropped: number[] = [];
    const media = guardedMedia({
      enabled: () => true,
      read: (handle) => bytes.get(handle) ?? null,
      onDropped: ({ limit }) => dropped.push(limit),
    });
    for (let i = 0; i < CROWDED_IMAGE_COUNT; i++) media.read(`img${i}`);
    // 8192 fits alone but not in a crowd, so only the fifteenth image is refused.
    expect(dropped).toEqual([CROWDED_LONG_SIDE_LIMIT]);
  });

  it('starts a new pass when an already-counted handle comes round again', () => {
    const media = guardedMedia({ enabled: () => true, read: () => png(8192, 8192) });
    // A second pass renders the same first attachment again; the count has to start over or the roomy
    // limit would never apply again.
    for (let i = 0; i < CROWDED_IMAGE_COUNT - 1; i++) expect(media.read(`img${i}`)).not.toBeNull();
    expect(media.read('img0')).not.toBeNull();
  });

  it('counts a handle once even when the pass renders it in two places', () => {
    const dropped: number[] = [];
    const media = guardedMedia({
      enabled: () => true,
      read: () => png(8192, 8192),
      onDropped: ({ count }) => dropped.push(count),
    });
    for (let i = 0; i < CROWDED_IMAGE_COUNT - 1; i++) media.read(`img${i}`);
    // The same handle twice in one pass must not reset the count: the request still carries the images.
    media.read('img5');
    expect(dropped).toEqual([]);
  });

  it('leaves a handle it cannot read alone', () => {
    const media = guardedMedia({ enabled: () => true, read: () => null });
    expect(media.read('missing')).toBeNull();
  });
});

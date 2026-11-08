/**
 * Image dimension limits, checked before bytes reach the request.
 *
 * A provider cannot send whatever it is handed: upstreams reject images over a pixel limit, and a
 * rejected image stays in the conversation, so every later turn fails the same way until the history
 * is trimmed. Returning null from `CompatMediaOptions.read` drops that one image from the request —
 * the framework keeps the message and sends the attachment's `fallbackText` in its place — which
 * leaves the conversation usable instead of blocked.
 *
 * Only the header is parsed: JPEG SOF, PNG IHDR and WebP VP8X state their dimensions within the first
 * bytes, so no image decoder is needed to decide.
 */

export interface ImageSize {
  width: number;
  height: number;
}

/** The long side DeepSeek accepts without counting the images in one request. */
export const LONG_SIDE_LIMIT = 8192;

/** The long side DeepSeek accepts once a request carries this many images or more. */
export const CROWDED_IMAGE_COUNT = 15;

/** The long side DeepSeek accepts in a request holding `CROWDED_IMAGE_COUNT` images or more. */
export const CROWDED_LONG_SIDE_LIMIT = 4096;

/**
 * Dimensions from the image bytes, or null when the format is not one whose header carries them.
 * Reads no more than the bytes needed, and never throws: an unreadable image is treated as unknown.
 */
export function imageSize(bytes: Buffer): ImageSize | null {
  if (bytes.length < 8) return null;
  return pngSize(bytes) ?? jpegSize(bytes) ?? webpSize(bytes);
}

function pngSize(bytes: Buffer): ImageSize | null {
  // IHDR is the first chunk of every PNG: signature, then width and height as big-endian u32.
  if (bytes.length < 24) return null;
  if (bytes[0] !== 0x89 || bytes[1] !== 0x50 || bytes[2] !== 0x4e || bytes[3] !== 0x47) return null;
  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  return width > 0 && height > 0 ? { width, height } : null;
}

function jpegSize(bytes: Buffer): ImageSize | null {
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  let at = 2;
  while (at + 9 < bytes.length) {
    if (bytes[at] !== 0xff) {
      at += 1;
      continue;
    }
    const marker = bytes[at + 1]!;
    // SOF0…SOF15 carry the dimensions; C4, C8 and CC are not frame headers.
    const isFrame = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    const length = bytes.readUInt16BE(at + 2);
    if (isFrame) {
      const height = bytes.readUInt16BE(at + 5);
      const width = bytes.readUInt16BE(at + 7);
      return width > 0 && height > 0 ? { width, height } : null;
    }
    if (length < 2) return null;
    at += 2 + length;
  }
  return null;
}

function webpSize(bytes: Buffer): ImageSize | null {
  if (bytes.length < 30) return null;
  if (bytes.toString('ascii', 0, 4) !== 'RIFF') return null;
  if (bytes.toString('ascii', 8, 12) !== 'WEBP') return null;
  const kind = bytes.toString('ascii', 12, 16);
  if (kind === 'VP8X') {
    // Canvas width and height are stored as 24-bit values minus one.
    const width = 1 + (bytes.readUIntLE(24, 3) & 0xffffff);
    const height = 1 + (bytes.readUIntLE(27, 3) & 0xffffff);
    return width > 0 && height > 0 ? { width, height } : null;
  }
  if (kind === 'VP8 ') {
    const width = bytes.readUInt16LE(26) & 0x3fff;
    const height = bytes.readUInt16LE(28) & 0x3fff;
    return width > 0 && height > 0 ? { width, height } : null;
  }
  if (kind === 'VP8L') {
    const bits = bytes.readUInt32LE(21);
    const width = 1 + (bits & 0x3fff);
    const height = 1 + ((bits >> 14) & 0x3fff);
    return width > 0 && height > 0 ? { width, height } : null;
  }
  return null;
}

/**
 * The long side this request may send. With `count` images in the request, the limit drops once the
 * request reaches the crowded threshold.
 */
export function longSideLimit(count: number): number {
  return count >= CROWDED_IMAGE_COUNT ? CROWDED_LONG_SIDE_LIMIT : LONG_SIDE_LIMIT;
}

/** Whether this image fits the limit that applies to a request carrying `count` images. */
export function fitsLimit(size: ImageSize | null, count: number): boolean {
  // An image whose header could not be read is left to the upstream: guessing a rejection would drop
  // pictures the service accepts.
  if (!size) return true;
  return Math.max(size.width, size.height) <= longSideLimit(count);
}

export interface MediaGuardOptions {
  enabled: () => boolean;
  read: (handle: string) => Buffer | null;
  /** Called for each image left out of a request, so the reason reaches the run log. */
  onDropped?: (info: { handle: string; size: ImageSize; limit: number; count: number }) => void;
  /** How many images a request may carry before the crowded limit applies; 0 disables the guard. */
  tier?: () => number;
}

/**
 * Wraps the media reader so an image over the current limit is left out of the request.
 *
 * The framework calls `enabled()` once per render pass in the Chat dialect but once per item in the
 * Responses dialect, so the counter cannot hang off `enabled()`. It resets when a handle it has
 * already counted comes round again — the same attachments are rendered once per pass, and no
 * request repeats a handle within one pass.
 */
export function guardedMedia(opts: MediaGuardOptions): { enabled: () => boolean; read: (handle: string) => Buffer | null } {
  let counted = new Set<string>();
  return {
    enabled: () => opts.enabled(),
    read: (handle: string) => {
      const bytes = opts.read(handle);
      if (!bytes) return null;
      if (counted.has(handle)) counted = new Set<string>();
      const size = imageSize(bytes);
      const count = counted.size + 1;
      if (!fitsLimit(size, count)) {
        if (size) opts.onDropped?.({ handle, size, limit: longSideLimit(count), count });
        // Return null and the framework sends the attachment's fallbackText instead of the image.
        return null;
      }
      counted.add(handle);
      return bytes;
    },
  };
}

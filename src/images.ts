/**
 * Image format and dimension limits, checked before bytes reach the request.
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
import type { GenerateOptions } from 'cortico/core/generation.ts';
import type { Request } from 'cortico/protocol/open-responses/index.ts';
import type { CompatMediaOptions } from 'cortico/providers/transport/history.ts';
import { requestContext } from 'cortico/providers/transport/native-input.ts';
import type { NativeChatMessage } from 'cortico/providers/transport/native-types.ts';

export interface ImageSize {
  width: number;
  height: number;
}

/** The common formats accepted across the gateway's image-capable upstreams. */
const SUPPORTED_IMAGE_MIMES = ['image/png', 'image/jpeg', 'image/webp'] as const;
type ImageMime = (typeof SUPPORTED_IMAGE_MIMES)[number];

export function supportsImageMime(mime: string): mime is ImageMime {
  return (SUPPORTED_IMAGE_MIMES as readonly string[]).includes(mime);
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Inspect bytes, not the attachment's MIME label: a GIF renamed to PNG is still rejected upstream. */
function imageMime(bytes: Buffer): ImageMime | 'image/gif' | null {
  if (bytes.subarray(0, 8).equals(PNG_SIGNATURE)) return 'image/png';
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes.length >= 12 && bytes.toString('latin1', 0, 4) === 'RIFF' && bytes.toString('latin1', 8, 12) === 'WEBP') return 'image/webp';
  const signature = bytes.toString('latin1', 0, 6);
  if (signature === 'GIF87a' || signature === 'GIF89a') return 'image/gif';
  return null;
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
  if (!bytes.subarray(0, 8).equals(PNG_SIGNATURE) || bytes.readUInt32BE(8) !== 13 || bytes.toString('latin1', 12, 16) !== 'IHDR') return null;
  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  return width > 0 && height > 0 ? { width, height } : null;
}

function jpegSize(bytes: Buffer): ImageSize | null {
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  let at = 2;
  while (at < bytes.length) {
    if (bytes[at++] !== 0xff) return null;
    // JPEG permits repeated FF fill bytes before a marker.
    while (at < bytes.length && bytes[at] === 0xff) at += 1;
    if (at >= bytes.length) return null;
    const marker = bytes[at++];
    if (marker === 0x00 || marker === 0xd9 || marker === 0xda) return null;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) continue;
    if (at + 2 > bytes.length) return null;
    const length = bytes.readUInt16BE(at);
    if (length < 2 || at + length > bytes.length) return null;
    // SOF0…SOF15 carry the dimensions; C4, C8 and CC are not frame headers.
    const isFrame = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isFrame) {
      if (length < 8) return null;
      const height = bytes.readUInt16BE(at + 3);
      const width = bytes.readUInt16BE(at + 5);
      return width > 0 && height > 0 ? { width, height } : null;
    }
    at += length;
  }
  return null;
}

function webpSize(bytes: Buffer): ImageSize | null {
  if (bytes.length < 20) return null;
  if (bytes.toString('latin1', 0, 4) !== 'RIFF') return null;
  if (bytes.toString('latin1', 8, 12) !== 'WEBP') return null;
  const kind = bytes.toString('latin1', 12, 16);
  if (kind === 'VP8X') {
    if (bytes.length < 30) return null;
    // Canvas width and height are stored as 24-bit values minus one.
    const width = 1 + (bytes.readUIntLE(24, 3) & 0xffffff);
    const height = 1 + (bytes.readUIntLE(27, 3) & 0xffffff);
    return width > 0 && height > 0 ? { width, height } : null;
  }
  if (kind === 'VP8 ') {
    if (bytes.length < 30 || bytes[23] !== 0x9d || bytes[24] !== 0x01 || bytes[25] !== 0x2a) return null;
    const width = bytes.readUInt16LE(26) & 0x3fff;
    const height = bytes.readUInt16LE(28) & 0x3fff;
    return width > 0 && height > 0 ? { width, height } : null;
  }
  if (kind === 'VP8L') {
    if (bytes.length < 25 || bytes[20] !== 0x2f) return null;
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
  // Unknown or malformed headers must not poison every later replay of this conversation.
  if (!size) return false;
  return Math.max(size.width, size.height) <= longSideLimit(count);
}

export type DroppedImage =
  | { handle: string; reason: 'unsupported-format'; mime: string | null }
  | { handle: string; reason: 'invalid-data-url'; mime: null }
  | { handle: string; reason: 'invalid-header'; mime: ImageMime }
  | { handle: string; reason: 'dimensions'; mime: ImageMime; size: ImageSize; limit: number; count: number };

export interface MediaGuardOptions {
  enabled: () => boolean;
  read: (handle: string) => Buffer | null;
  /** Called for each image left out of a request, so the reason reaches the run log. */
  onDropped?: (info: DroppedImage) => void;
}

interface GuardedMedia extends CompatMediaOptions {
  forRequest(count: number): GuardedMedia;
  inline(url: string, handle: string): string | null;
}

/**
 * Wraps the media reader so unsupported, unreadable or oversized images are left out of the request.
 * Each render uses its complete image count. Readers share no mutable counters across concurrent
 * requests or history replays; repeated handles count as repeated wire images.
 */
export function guardedMedia(opts: MediaGuardOptions): GuardedMedia {
  const scoped = (count: number): GuardedMedia => {
    const check = (bytes: Buffer, handle: string): ImageMime | null => {
      const mime = imageMime(bytes);
      if (!mime || !supportsImageMime(mime)) {
        opts.onDropped?.({ handle, reason: 'unsupported-format', mime });
        return null;
      }
      const size = imageSize(bytes);
      if (!size) {
        opts.onDropped?.({ handle, reason: 'invalid-header', mime });
        return null;
      }
      if (!fitsLimit(size, count)) {
        opts.onDropped?.({ handle, reason: 'dimensions', mime, size, limit: longSideLimit(count), count });
        // Return null and the framework sends the attachment's fallbackText instead of the image.
        return null;
      }
      return mime;
    };
    return {
      enabled: () => opts.enabled(),
      forRequest: scoped,
      read: (handle) => {
        const bytes = opts.read(handle);
        return bytes && check(bytes, handle) ? bytes : null;
      },
      inline: (url, handle) => {
        url = url.trim();
        // Remote URLs are owned by the caller/upstream. Never fetch them from the provider process.
        if (!/^data:/i.test(url)) return url;
        const match = /^data:([^;,]+);base64,([a-z\d+/]*={0,2})$/i.exec(url);
        if (!match || match[2].length % 4 === 1) {
          opts.onDropped?.({ handle, reason: 'invalid-data-url', mime: null });
          return null;
        }
        const bytes = Buffer.from(match[2], 'base64');
        const mime = check(bytes, handle);
        return mime ? `data:${mime};base64,${bytes.toString('base64')}` : null;
      },
    };
  };
  return scoped(1);
}

export function mediaForRequest(media: CompatMediaOptions | undefined, count: number): CompatMediaOptions | undefined {
  return (media as Partial<GuardedMedia> | undefined)?.forRequest?.(count) ?? media;
}

export function chatImageCount(messages: readonly NativeChatMessage[]): number {
  return messages.reduce((count, message) => count
    + (message.blobs?.filter((ref) => ref.mime.startsWith('image/')).length ?? 0)
    + (message.parts?.filter((part) => part.type === 'image_url').length ?? 0), 0);
}

export function requestImageCount(request: Request, options: GenerateOptions): number {
  return requestContext(request, options).reduce((count, entry) => {
    const item = entry.item;
    const parts = item.type === 'message' ? item.content : item.type === 'function_call_output' ? item.output : undefined;
    return count + (entry.context.blobs?.filter((ref) => ref.mime.startsWith('image/')).length ?? 0)
      + (Array.isArray(parts) ? parts.filter((part) => part.type === 'input_image').length : 0);
  }, 0);
}

/**
 * Native image parts bypass the framework's blob reader. Inspect inline bytes too, and normalize
 * MIME labels on retained blobs, using copied records so stored history remains untouched.
 */
export function sanitizeNativeImages(request: Request, options: GenerateOptions, media?: CompatMediaOptions): GenerateOptions {
  const guard = media as Partial<GuardedMedia> | undefined;
  if (!guard?.forRequest || !guard.inline) return options;
  const sanitize = (records: ReturnType<typeof requestContext>, scoped: GuardedMedia) => records.map((entry, itemIndex) => {
    const item = entry.item;
    const field = item.type === 'message' ? 'content' : item.type === 'function_call_output' ? 'output' : undefined;
    const parts = item.type === 'message' ? item.content : item.type === 'function_call_output' ? item.output : undefined;
    const content = Array.isArray(parts) ? parts.map((part, partIndex) => {
      if (part.type !== 'input_image' || !part.image_url) return part;
      const url = scoped.inline(part.image_url, `inline:${itemIndex}:${partIndex}`);
      return url ? { ...part, image_url: url } : { type: 'input_text' as const, text: '[Image omitted: unsupported or invalid image]' };
    }) : parts;
    const blobs = scoped.enabled() ? entry.context.blobs?.flatMap((ref) => {
      if (!ref.mime.startsWith('image/')) return [ref];
      const bytes = scoped.read(ref.handle);
      if (!bytes) return [];
      const mime = imageMime(bytes)!;
      return [mime === ref.mime ? ref : { ...ref, mime }];
    }) : entry.context.blobs;
    return { ...entry, item: field ? { ...item, [field]: content } : item, context: { ...entry.context, blobs } };
  });
  // Remove invalid candidates first: rejected GIFs must not push an otherwise valid PNG into the
  // crowded tier. Only the remaining images can appear together in the outgoing request.
  const context = sanitize(requestContext(request, options), guard.forRequest(1));
  const prepared = { ...options, context };
  const count = requestImageCount(request, prepared);
  return count >= CROWDED_IMAGE_COUNT ? { ...options, context: sanitize(context, guard.forRequest(count)) } : prepared;
}

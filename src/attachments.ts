import { createHash } from 'node:crypto';
import { isUtf8 } from 'node:buffer';
import type { BlobRef } from 'cortico/core/types.ts';
import type { GenerateOptions } from 'cortico/core/generation.ts';
import type { Request } from 'cortico/protocol/open-responses/index.ts';
import { requestContext } from 'cortico/providers/transport/native-input.ts';
import type { Protocol } from './address.ts';
import { canonicalMime, declaredInput, type ModelFacts } from './model-metadata.ts';
import { imageSize, longSideLimit, supportsImageMime } from './images.ts';
import { protocolAccepts } from './protocol-contract.ts';
import { attachmentWindow } from './attachment-window.ts';

export const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;
export const MAX_REQUEST_MEDIA_BYTES = 40 * 1024 * 1024;
type Part = Record<string, any>;
export interface AttachmentPolicy {
  facts?: ModelFacts;
  protocol: Protocol;
  images?: boolean;
  audio?: boolean;
  video?: boolean;
  files?: boolean;
  enabled?: boolean;
  read(handle: string): Buffer | null;
  rejected?: Set<string>;
  dropped?(reason: string, mime: string): void;
}

export function supportsAttachment(policy: Pick<AttachmentPolicy, 'facts' | 'protocol' | 'images' | 'audio' | 'video' | 'files' | 'enabled'>, mime: string): boolean {
  mime = canonicalMime(mime);
  if (policy.enabled === false) return false;
  // Adapter policy: audio and video use only the explicitly selected native Gemini protocol.
  if (!protocolAccepts(policy.protocol, mime)) return false;
  if (mime.startsWith('image/') && policy.images === false) return false;
  if (mime.startsWith('audio/') && policy.audio === false) return false;
  if (mime.startsWith('video/') && policy.video === false) return false;
  if (!/^(image|audio|video)\//.test(mime) && policy.files === false) return false;
  const declared = policy.facts?.input ? declaredInput(policy.facts, mime)
    : mime.startsWith('image/') && policy.images === true && supportsImageMime(mime);
  if (!declared) return false;
  return true;
}

function sniff(bytes: Buffer, claimed: string): string | null {
  const head = bytes.toString('latin1', 0, 16);
  if (head.startsWith('\x89PNG\r\n\x1a\n')) return 'image/png';
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'image/jpeg';
  if (/^GIF8[79]a/.test(head)) return 'image/gif';
  if (head.startsWith('BM')) return 'image/bmp';
  if (head.startsWith('%PDF-')) return 'application/pdf';
  if (head.startsWith('RIFF')) {
    if (head.slice(8, 12) === 'WEBP') return 'image/webp';
    if (head.slice(8, 12) === 'WAVE') return 'audio/wav';
    if (head.slice(8, 12) === 'AVI ') return 'video/x-msvideo';
  }
  if (head.startsWith('fLaC')) return 'audio/flac';
  if (head.startsWith('OggS')) return claimed.startsWith('video/') ? 'video/ogg' : 'audio/ogg';
  if (bytes[0] === 255 && (bytes[1] & 0xf6) === 0xf0) return 'audio/aac';
  if (head.startsWith('ID3') || (bytes[0] === 255 && (bytes[1] & 0xe0) === 0xe0)) return 'audio/mpeg';
  if (head.startsWith('FORM') && ['AIFF', 'AIFC'].includes(head.slice(8, 12))) return 'audio/aiff';
  if (head.slice(4, 8) === 'ftyp') {
    if (/hei[cf]|mif1/.test(head.slice(8))) return claimed === 'image/heif' ? claimed : 'image/heic';
    return claimed.startsWith('audio/') ? 'audio/mp4' : 'video/mp4';
  }
  if (head.startsWith('\x1aE\xdf\xa3')) return claimed.startsWith('audio/') ? 'audio/webm' : 'video/webm';
  if (claimed.startsWith('image/') || claimed === 'application/pdf') return null;
  // Exact model declarations can include raw PCM or other binary formats without a magic header.
  return claimed;
}

/** Inspect GIF blocks without decoding pixels; OpenAI image input excludes animation. */
function singleFrameGif(bytes: Buffer): boolean {
  if (bytes.length < 13) return false;
  let offset = 13 + (bytes[10] & 0x80 ? 3 * 2 ** ((bytes[10] & 7) + 1) : 0);
  let frames = 0;
  const skipBlocks = () => {
    while (offset < bytes.length) {
      const size = bytes[offset++];
      if (!size) return true;
      offset += size;
    }
    return false;
  };
  while (offset < bytes.length) {
    const block = bytes[offset++];
    if (block === 0x3b) return frames === 1;
    if (block === 0x21) { offset++; if (!skipBlocks()) return false; }
    else if (block === 0x2c) {
      if (++frames > 1 || offset + 9 > bytes.length) return false;
      const flags = bytes[offset + 8];
      offset += 9 + (flags & 0x80 ? 3 * 2 ** ((flags & 7) + 1) : 0);
      offset++; // LZW code size
      if (!skipBlocks()) return false;
    } else return false;
  }
  return false;
}

export function parseDataUrl(value: string): { mime: string; bytes: Buffer } | null {
  if (value.length > Math.ceil(MAX_ATTACHMENT_BYTES / 3) * 4 + 256) return null;
  const match = /^data:([^;,]+);base64,([a-z\d+/]*={0,2})$/i.exec(value.trim());
  if (!match || match[2].length % 4 === 1) return null;
  return { mime: canonicalMime(match[1]), bytes: Buffer.from(match[2], 'base64') };
}

/** Copy effective history and lift supported bytes into native parts; never mutate stored records. */
export function prepareAttachments(request: Request, options: GenerateOptions, policy: AttachmentPolicy, textOnly = false) {
  const candidates: Array<{ bytes: Buffer; mime: string; hash: string; part: Part; size: ReturnType<typeof imageSize> }> = [];
  let total = 0;
  const omit = (reason: string, mime: string): Part => {
    policy.dropped?.(reason, mime);
    return { type: 'input_text', text: `[Attachment omitted: ${reason} (${mime})]` };
  };
  const admit = (bytes: Buffer, claimed: string, name?: string): Part => {
    const mime = sniff(bytes, canonicalMime(claimed));
    if (textOnly || !mime || !supportsAttachment(policy, mime)) return omit('unsupported type or disabled', mime ?? claimed);
    if (!bytes.length || bytes.length > MAX_ATTACHMENT_BYTES || total + bytes.length > MAX_REQUEST_MEDIA_BYTES) return omit('size limit', mime);
    if (mime === 'image/gif' && ['chat', 'responses'].includes(policy.protocol) && !singleFrameGif(bytes)) return omit('animated or invalid GIF', mime);
    if (mime === 'text/plain' && !isUtf8(bytes)) return omit('invalid UTF-8 text', mime);
    const hash = createHash('sha256').update(mime).update(bytes).digest('hex');
    if (policy.rejected?.has(hash)) return omit('previously rejected by upstream', mime);
    let size = mime.startsWith('image/') ? imageSize(bytes) : null;
    if (mime === 'image/gif' && bytes.length >= 10) size = { width: bytes.readUInt16LE(6), height: bytes.readUInt16LE(8) };
    if (mime === 'image/bmp' && bytes.length >= 26) size = { width: Math.abs(bytes.readInt32LE(18)), height: Math.abs(bytes.readInt32LE(22)) };
    if (['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/bmp'].includes(mime) && (!size || !size.width || !size.height)) return omit('invalid image header', mime);
    if (size && Math.max(size.width, size.height) > longSideLimit(1)) return omit('image dimensions', mime);
    total += bytes.length;
    const data = `data:${mime};base64,${bytes.toString('base64')}`;
    const part: Part = mime.startsWith('image/') ? { type: 'input_image', image_url: data }
      : { type: 'input_file', filename: name ?? `attachment.${mime.split('/')[1]}`, file_data: data };
    candidates.push({ bytes, mime, hash, part, size });
    return part;
  };
  const history = requestContext(request, options);
  const from = attachmentWindow(history);
  const historical = (name: string): Part => ({ type: 'input_text', text: `[Previous attachment: ${name}; original omitted from this request. Reattach to inspect the original.]` });
  const context = history.map((entry, index) => {
    const item = entry.item;
    if (item.type !== 'message' && item.type !== 'function_call_output') return entry;
    const field = item.type === 'message' ? 'content' : 'output';
    const content = item.type === 'message' ? item.content : item.output;
    if (!entry.context.blobs?.length && (!Array.isArray(content) || !content.some(part => ['input_image', 'input_file', 'input_audio', 'input_video'].includes(part.type)))) return entry;
    const parts: Part[] = typeof content === 'string' ? [{ type: 'input_text', text: content }] : (content ?? []).map((raw): Part => {
      const part = raw as Part;
      if (!['input_image', 'input_file', 'input_audio', 'input_video'].includes(part.type)) return part;
      if (index < from) return historical(String(part.filename ?? part.type));
      const url = part.image_url ?? part.file_data ?? part.video_url;
      const data = typeof url === 'string' ? parseDataUrl(url) : part.type === 'input_audio' && part.input_audio?.data
        ? parseDataUrl(`data:audio/${part.input_audio.format};base64,${part.input_audio.data}`) : null;
      if (!data) return omit('unreadable inline media', 'unknown');
      return admit(data.bytes, data.mime, part.filename);
    });
    for (const ref of entry.context.blobs ?? []) {
      if (ref.fallbackText && !parts.some(part => typeof part.text === 'string' && part.text.includes(ref.fallbackText))) parts.push({ type: 'input_text', text: ref.fallbackText });
      if (index < from) {
        if (!ref.fallbackText) parts.push(historical(ref.name ?? ref.mime));
        continue;
      }
      if (textOnly || policy.enabled === false) { parts.push(omit('disabled or text fallback', ref.mime)); continue; }
      let bytes: Buffer | null = null;
      try { bytes = policy.read(ref.handle); } catch { /* Unreadable media keeps its fallback text. */ }
      if (bytes) parts.push(admit(bytes, ref.mime, ref.name));
      else policy.dropped?.('unreadable attachment', ref.mime);
    }
    return { ...entry, item: { ...item, [field]: parts }, context: { ...entry.context, blobs: [] as BlobRef[] } } as typeof entry;
  });
  const imageCount = candidates.filter(candidate => candidate.mime.startsWith('image/')).length;
  for (const candidate of candidates) if (candidate.size && Math.max(candidate.size.width, candidate.size.height) > longSideLimit(imageCount)) {
    Object.keys(candidate.part).forEach(key => delete candidate.part[key]);
    Object.assign(candidate.part, omit('image dimensions', candidate.mime));
  }
  return { options: { ...options, context }, hashes: candidates.filter(candidate => candidate.part.type !== 'input_text').map(candidate => candidate.hash) };
}

/** Chat's file bridge is also used by the Messages/Gemini translators. */
export function chatMediaParts(messages: Array<Record<string, any>>): Array<Record<string, any>> {
  return messages.map(message => ({ ...message, content: Array.isArray(message.content) ? message.content.map((part: Part) => {
    if (part.type !== 'file') return part;
    const data = parseDataUrl(String(part.file?.file_data ?? ''));
    if (!data) return part;
    if (data.mime.startsWith('audio/')) return { type: 'input_audio', input_audio: { data: data.bytes.toString('base64'), format: data.mime === 'audio/mpeg' ? 'mp3' : data.mime.split('/')[1] } };
    if (data.mime.startsWith('video/')) return { type: 'video_url', video_url: { url: part.file.file_data } };
    return part;
  }) : message.content }));
}

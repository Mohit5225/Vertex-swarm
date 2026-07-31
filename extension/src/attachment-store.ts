import * as crypto from 'crypto';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';

const MIME_TO_EXT: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/bmp': 'bmp',
};

const ACCEPTED_MIME_TYPES = new Set(Object.keys(MIME_TO_EXT));

export interface AttachmentSaveLimits {
  maxFileBytes: number;
  maxCountPerMessage: number;
}

const DEFAULT_SAVE_LIMITS: AttachmentSaveLimits = {
  maxFileBytes: 10 * 1024 * 1024,
  maxCountPerMessage: 8,
};

export interface ChatAttachmentRecord {
  id: string;
  filename: string;
  mimeType: string;
  size: number;
  /** Relative to chat dir, e.g. attachments/abc123.png */
  relativePath: string;
}

export interface IncomingAttachmentPayload {
  id: string;
  filename: string;
  mimeType: string;
  /** Base64-encoded file bytes */
  dataBase64: string;
}

const detectImageMimeType = (buffer: Buffer): string | null => {
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return 'image/png';
  }
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return 'image/jpeg';
  }
  if (buffer.length >= 6 && buffer.subarray(0, 6).toString('ascii') === 'GIF87a') {
    return 'image/gif';
  }
  if (buffer.length >= 6 && buffer.subarray(0, 6).toString('ascii') === 'GIF89a') {
    return 'image/gif';
  }
  if (
    buffer.length >= 12
    && buffer.subarray(0, 4).toString('ascii') === 'RIFF'
    && buffer.subarray(8, 12).toString('ascii') === 'WEBP'
  ) {
    return 'image/webp';
  }
  if (buffer.length >= 2 && buffer[0] === 0x42 && buffer[1] === 0x4d) {
    return 'image/bmp';
  }
  return null;
};

export class AttachmentStore {
  private readonly baseDir: string;

  constructor(baseDir?: string) {
    this.baseDir = baseDir ?? path.join(os.homedir(), '.vertex-swarm');
  }

  private chatDir(chatId: string): string {
    return path.join(this.baseDir, 'chats', chatId);
  }

  private attachmentsDir(chatId: string): string {
    return path.join(this.chatDir(chatId), 'attachments');
  }

  resolveAbsolutePath(chatId: string, relativePath: string): string {
    const chatRoot = path.resolve(this.chatDir(chatId));
    const attachmentsRoot = path.resolve(this.attachmentsDir(chatId));
    const normalized = relativePath.replace(/\\/g, '/').replace(/^\/+/, '');
    if (normalized.includes('..')) {
      throw new Error(`Invalid attachment path: ${relativePath}`);
    }

    const resolved = path.resolve(chatRoot, normalized);
    if (
      resolved !== attachmentsRoot
      && !resolved.startsWith(`${attachmentsRoot}${path.sep}`)
    ) {
      throw new Error(`Attachment path escapes attachments root: ${relativePath}`);
    }

    return resolved;
  }

  async saveAttachments(
    chatId: string,
    items: IncomingAttachmentPayload[],
    limits: AttachmentSaveLimits = DEFAULT_SAVE_LIMITS,
  ): Promise<ChatAttachmentRecord[]> {
    if (items.length === 0) {
      return [];
    }
    if (items.length > limits.maxCountPerMessage) {
      throw new Error(`Maximum ${limits.maxCountPerMessage} attachments per message.`);
    }

    const attachmentsDir = this.attachmentsDir(chatId);
    const stagingDir = path.join(attachmentsDir, `.staging-${crypto.randomUUID()}`);
    await fs.mkdir(stagingDir, { recursive: true });

    const staged: Array<{ record: ChatAttachmentRecord; stagingPath: string }> = [];

    try {
      for (const item of items) {
        const buffer = Buffer.from(item.dataBase64, 'base64');
        if (buffer.byteLength > limits.maxFileBytes) {
          const limitMb = Math.round(limits.maxFileBytes / (1024 * 1024));
          throw new Error(`Attachment "${item.filename}" exceeds the ${limitMb} MB limit.`);
        }

        const detectedMime = detectImageMimeType(buffer);
        if (!detectedMime || !ACCEPTED_MIME_TYPES.has(detectedMime)) {
          throw new Error(`Attachment "${item.filename}" is not a supported image file.`);
        }

        const ext = this.resolveExtension(item.filename, detectedMime);
        const id = item.id || crypto.randomUUID();
        const relativePath = path.posix.join('attachments', `${id}.${ext}`);
        const stagingPath = path.join(stagingDir, `${id}.${ext}`);

        await fs.writeFile(stagingPath, buffer);

        staged.push({
          record: {
            id,
            filename: item.filename,
            mimeType: detectedMime,
            size: buffer.byteLength,
            relativePath,
          },
          stagingPath,
        });
      }

      await fs.mkdir(attachmentsDir, { recursive: true });

      for (const entry of staged) {
        const finalPath = this.resolveAbsolutePath(chatId, entry.record.relativePath);
        await fs.rename(entry.stagingPath, finalPath);
      }

      return staged.map((entry) => entry.record);
    } catch (error) {
      await fs.rm(stagingDir, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    } finally {
      await fs.rm(stagingDir, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  private resolveExtension(filename: string, mimeType: string): string {
    const fromName = path.extname(filename).replace(/^\./, '').toLowerCase();
    if (fromName && fromName !== 'svg') {
      return fromName;
    }
    return MIME_TO_EXT[mimeType.toLowerCase()] ?? 'bin';
  }
}

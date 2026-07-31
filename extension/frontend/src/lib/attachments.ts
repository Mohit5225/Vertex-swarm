export interface ChatAttachment {
  id: string;
  filename: string;
  mimeType: string;
  size: number;
  /** Webview URI or blob/data URL for display */
  uri: string;
}

export interface DraftAttachment {
  id: string;
  file: File;
  previewUrl: string;
  filename: string;
  mimeType: string;
  size: number;
}

export const ACCEPTED_IMAGE_TYPES = [
  'image/png',
  'image/jpeg',
  'image/jpg',
  'image/gif',
  'image/webp',
  'image/svg+xml',
  'image/bmp',
] as const;

export const ACCEPTED_IMAGE_INPUT = ACCEPTED_IMAGE_TYPES.join(',');

export interface ImageSaveLimits {
  maxAttachments: number;
  maxAttachmentBytes: number;
}

export const isImageMimeType = (mimeType: string): boolean =>
  mimeType.startsWith('image/');

export const createDraftAttachment = (
  file: File,
  limits: ImageSaveLimits,
): DraftAttachment | null => {
  if (!isImageMimeType(file.type)) {
    return null;
  }
  if (file.size > limits.maxAttachmentBytes) {
    return null;
  }

  return {
    id: `att-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
    file,
    previewUrl: URL.createObjectURL(file),
    filename: file.name,
    mimeType: file.type || 'image/png',
    size: file.size,
  };
};

export const fileToBase64 = (file: File): Promise<string> =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result;
      if (typeof result !== 'string') {
        reject(new Error('Failed to read file'));
        return;
      }
      const comma = result.indexOf(',');
      resolve(comma >= 0 ? result.slice(comma + 1) : result);
    };
    reader.onerror = () => reject(reader.error ?? new Error('Failed to read file'));
    reader.readAsDataURL(file);
  });

export const revokeDraftAttachments = (attachments: DraftAttachment[]): void => {
  for (const attachment of attachments) {
    URL.revokeObjectURL(attachment.previewUrl);
  }
};

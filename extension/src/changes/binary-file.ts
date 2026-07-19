import * as path from 'path';

const BINARY_EXTENSIONS = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'ico', 'bmp', 'avif',
  'pdf', 'zip', 'gz', 'bz2', 'xz', '7z', 'rar', 'tar',
  'wasm', 'exe', 'dll', 'so', 'dylib', 'bin', 'dat',
  'woff', 'woff2', 'ttf', 'otf', 'eot',
  'mp3', 'mp4', 'mov', 'avi', 'mkv', 'wav', 'flac', 'ogg',
  'sqlite', 'db', 'pyc', 'class', 'jar', 'parquet',
]);

export function isBinaryExtension(filePath: string): boolean {
  const extension = path.extname(filePath).replace(/^\./, '').toLowerCase();
  return extension ? BINARY_EXTENSIONS.has(extension) : false;
}

export function isBinaryBuffer(data: Uint8Array): boolean {
  if (data.length === 0) {
    return false;
  }

  const sampleLength = Math.min(data.length, 8192);
  for (let index = 0; index < sampleLength; index += 1) {
    if (data[index] === 0) {
      return true;
    }
  }

  return false;
}

export function isBinaryFile(filePath: string, data: Uint8Array): boolean {
  return isBinaryExtension(filePath) || isBinaryBuffer(data);
}

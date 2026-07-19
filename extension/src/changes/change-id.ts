export function normalizePathKey(value: string): string {
  return value.replace(/\\/g, '/').replace(/^\.\//, '').toLowerCase();
}

export function buildChangeId(requestId: string | undefined, relativePath: string): string {
  const pathKey = normalizePathKey(relativePath);
  if (requestId) {
    return `${requestId}::${pathKey}`;
  }
  return pathKey;
}

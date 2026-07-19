import * as vscode from 'vscode';

export function extractMutationPaths(
  args: Record<string, unknown>,
  resolvePath: (filePath: string) => vscode.Uri
): vscode.Uri[] {
  const uriMap = new Map<string, vscode.Uri>();
  const action = args.action;
  const payload = args.payload;

  if (!payload || typeof payload !== 'object' || typeof action !== 'string') {
    return [];
  }

  const payloadRecord = payload as Record<string, unknown>;

  const pushPath = (filePath: unknown) => {
    if (!filePath || typeof filePath !== 'string') {
      return;
    }

    try {
      const uri = resolvePath(filePath);
      uriMap.set(uri.toString(), uri);
    } catch {
      const uri = vscode.Uri.file(filePath);
      uriMap.set(uri.toString(), uri);
    }
  };

  const pushMany = (paths: unknown) => {
    if (!Array.isArray(paths)) {
      return;
    }
    for (const entry of paths) {
      if (typeof entry === 'string') {
        pushPath(entry);
      } else if (entry && typeof entry === 'object') {
        const record = entry as { path?: unknown; TargetFile?: unknown };
        pushPath(record.path ?? record.TargetFile);
      }
    }
  };

  const isFileWrite = [
    'write_file',
    'replace_file_content',
    'multi_replace_file_content',
    'edit_file',
    'create_file',
  ].includes(action);

  if (isFileWrite) {
    const filesPayload = payloadRecord.files;
    if (action === 'create_file' && Array.isArray(filesPayload)) {
      for (const file of filesPayload) {
        if (file && typeof file === 'object' && typeof (file as { path?: unknown }).path === 'string') {
          pushPath((file as { path: string }).path);
        }
      }
    } else {
      pushPath(payloadRecord.TargetFile || payloadRecord.path || payloadRecord.target);
      pushMany(payloadRecord.paths);
      pushMany(payloadRecord.targets);
      pushMany(payloadRecord.files);
    }
  } else if (['delete_file', 'delete_path'].includes(action)) {
    pushPath(payloadRecord.TargetPath || payloadRecord.path || payloadRecord.target);
    pushMany(payloadRecord.paths);
  } else if (action === 'rename_path') {
    pushPath(payloadRecord.oldPath);
    pushPath(payloadRecord.newPath);
  }

  return Array.from(uriMap.values());
}

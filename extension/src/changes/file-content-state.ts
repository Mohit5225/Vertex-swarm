import * as vscode from 'vscode';
import { isBinaryFile } from './binary-file';

export type FileContentState =
  | { kind: 'missing' }
  | { kind: 'directory' }
  | { kind: 'binary'; byteSize: number }
  | { kind: 'text'; text: string; byteSize: number };

export async function readWorkspaceFileState(uri: vscode.Uri): Promise<FileContentState> {
  try {
    const stat = await vscode.workspace.fs.stat(uri);
    if (stat.type === vscode.FileType.Directory) {
      return { kind: 'directory' };
    }

    const data = await vscode.workspace.fs.readFile(uri);
    if (isBinaryFile(uri.fsPath, data)) {
      return { kind: 'binary', byteSize: data.byteLength };
    }

    return {
      kind: 'text',
      text: Buffer.from(data).toString('utf8'),
      byteSize: data.byteLength,
    };
  } catch {
    return { kind: 'missing' };
  }
}

export function stateHasContent(state: FileContentState): boolean {
  return state.kind === 'text' || state.kind === 'binary';
}

export function stateByteSize(state: FileContentState): number {
  if (state.kind === 'text' || state.kind === 'binary') {
    return state.byteSize;
  }
  return 0;
}

export function stateText(state: FileContentState): string {
  return state.kind === 'text' ? state.text : '';
}

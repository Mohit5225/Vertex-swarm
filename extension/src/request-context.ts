import type { RequestContextPayload } from './types/index';

export interface RequestContextSelectionSnapshot {
  startLine: number;
  startColumn: number;
  endLine: number;
  endColumn: number;
  text: string;
}

export interface RequestContextSnapshot {
  activeFile?: {
    path: string;
    languageId?: string;
    selection?: RequestContextSelectionSnapshot;
  };
  activeTerminal?: {
    name: string;
  };
  workspaceFolders?: string[];
}

export function createRequestContext(
  snapshot: RequestContextSnapshot
): RequestContextPayload | undefined {
  const activeFile = snapshot.activeFile
    ? {
        path: snapshot.activeFile.path,
        languageId: snapshot.activeFile.languageId,
        ...(snapshot.activeFile.selection ? { selection: snapshot.activeFile.selection } : {}),
      }
    : undefined;

  const activeTerminal = snapshot.activeTerminal
    ? {
        name: snapshot.activeTerminal.name,
      }
    : undefined;

  const workspaceFolders = snapshot.workspaceFolders?.filter((folder) => Boolean(folder.trim()));

  if (!activeFile && !activeTerminal && (!workspaceFolders || workspaceFolders.length === 0)) {
    return undefined;
  }

  return {
    ...(activeFile ? { activeFile } : {}),
    ...(activeTerminal ? { activeTerminal } : {}),
    ...(workspaceFolders && workspaceFolders.length > 0 ? { workspaceFolders } : {}),
  };
}
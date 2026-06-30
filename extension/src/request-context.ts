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
    shell?: string;
    cwd?: string;
  };
  activeTerminals?: {
    name: string;
    purpose: string;
    isBusy: boolean;
  }[];
  os?: string;
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
        shell: snapshot.activeTerminal.shell,
        cwd: snapshot.activeTerminal.cwd,
      }
    : undefined;
    
  const activeTerminals = snapshot.activeTerminals;

  const workspaceFolders = snapshot.workspaceFolders?.filter((folder) => Boolean(folder.trim()));

  if (!activeFile && !activeTerminal && (!activeTerminals || activeTerminals.length === 0) && (!workspaceFolders || workspaceFolders.length === 0)) {
    return undefined;
  }

  return {
    ...(activeFile ? { activeFile } : {}),
    ...(activeTerminal ? { activeTerminal } : {}),
    ...(activeTerminals && activeTerminals.length > 0 ? { activeTerminals } : {}),
    ...(snapshot.os ? { os: snapshot.os } : {}),
    ...(workspaceFolders && workspaceFolders.length > 0 ? { workspaceFolders } : {}),
  };
}
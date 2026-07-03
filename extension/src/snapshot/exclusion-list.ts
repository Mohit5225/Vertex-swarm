import * as vscode from 'vscode';

// Folders/files that we never want to snapshot, and we silently skip them
// because they are generally not valid direct-edit targets for the agent.
const SILENT_EXCLUSIONS = [
  '/.git/',
  '/node_modules/',
  '/.venv/',
  '/dist/',
  '/build/',
];

// Folders/files that are valid edit targets, but we skip them for security reasons.
// If the agent edits these, we should warn the user that they are not protected by Undo.
const WARNED_EXCLUSIONS = [
  '/.env',
];

export function classifyFileForSnapshot(uri: vscode.Uri): 'include' | 'silent-skip' | 'warned-skip' {
  const fsPath = uri.fsPath.replace(/\\/g, '/'); // Normalize for string matching

  for (const exclusion of SILENT_EXCLUSIONS) {
    if (fsPath.includes(exclusion)) {
      return 'silent-skip';
    }
  }

  for (const exclusion of WARNED_EXCLUSIONS) {
    if (fsPath.includes(exclusion)) {
      return 'warned-skip';
    }
  }

  return 'include';
}

/** workspace_ops actions that mutate the filesystem (not reads / search / list). */
export const MUTATION_ACTIONS = new Set([
  'write_file',
  'write_to_file',
  'replace_file_content',
  'multi_replace_file_content',
  'edit_file',
  'create_file',
  'delete_file',
  'delete_path',
  'rename_path',
]);

export function isMutationAction(action: unknown): boolean {
  return typeof action === 'string' && MUTATION_ACTIONS.has(action);
}

export function isApplyMode(mode: unknown): boolean {
  return mode === 'apply';
}

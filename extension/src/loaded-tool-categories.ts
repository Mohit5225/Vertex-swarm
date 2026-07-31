import type { SessionEvent } from './types/index';

/** Must match backend prompt_loader.SUPPORTED_CATEGORIES */
export const KNOWN_LOADABLE_CATEGORIES = new Set([
  'workspace_ops',
  'terminal_ops',
  'plan_tool',
  'todo_tool',
  'web_search',
  'spawn_subagent',
  'hil_tool',
]);

export function parseLoadedCategoriesFromEvent(event: SessionEvent): string[] | null {
  const phase = event.metadata?.phase;
  if (phase !== 'tools_loaded' && phase !== 'tool_context_loaded') {
    return null;
  }

  const rawCategories = event.metadata?.categories;
  if (!Array.isArray(rawCategories) || rawCategories.length === 0) {
    return null;
  }

  const verified: string[] = [];
  for (const item of rawCategories) {
    if (typeof item !== 'string' || !KNOWN_LOADABLE_CATEGORIES.has(item)) {
      return null;
    }
    verified.push(item);
  }

  return verified.length > 0 ? verified : null;
}

export function parseActiveToolCategoriesFromWorkingMemory(
  workingMemory: Record<string, unknown> | null | undefined,
): string[] {
  if (!workingMemory) {
    return [];
  }

  const raw = workingMemory.active_tool_categories;
  if (!Array.isArray(raw)) {
    return [];
  }

  return raw.filter(
    (item): item is string =>
      typeof item === 'string' && KNOWN_LOADABLE_CATEGORIES.has(item),
  );
}

export function mergeLoadedToolCategories(
  existing: string[],
  incoming: string[],
): string[] {
  return [...new Set([...existing, ...incoming])];
}

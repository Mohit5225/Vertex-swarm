import { type SessionEvent } from '../store/chatStore'
import { getEventPhase } from './sessionEvents'

/** Must match backend prompt_loader.SUPPORTED_CATEGORIES */
const KNOWN_LOADABLE_CATEGORIES = new Set([
  'workspace_ops',
  'terminal_ops',
  'plan_tool',
  'todo_tool',
  'web_search',
  'spawn_subagent',
  'hil_tool',
])

export function parseVerifiedLoadedCategories(event: SessionEvent): string[] | null {
  const phase = getEventPhase(event)
  if (phase !== 'tools_loaded' && phase !== 'tool_context_loaded') {
    return null
  }

  const rawCategories = event.metadata?.categories
  if (!Array.isArray(rawCategories) || rawCategories.length === 0) {
    return null
  }

  const verified: string[] = []
  for (const item of rawCategories) {
    if (typeof item !== 'string' || !KNOWN_LOADABLE_CATEGORIES.has(item)) {
      return null
    }
    verified.push(item)
  }

  return verified.length > 0 ? verified : null
}

export function formatLoadedToolsDisplayLabel(categories: string[]): string {
  return categories
    .map((category) => `Loaded ${category} tool with guidance`)
    .join('\n')
}

/** Returns a display label only when the event carries verified category metadata. */
export function loadedToolsLabelFromStatusEvent(event: SessionEvent): string | null {
  const categories = parseVerifiedLoadedCategories(event)
  if (!categories) {
    return null
  }
  return formatLoadedToolsDisplayLabel(categories)
}

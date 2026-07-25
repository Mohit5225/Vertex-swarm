export interface SlashCommand {
  id: string
  command: string
  title: string
  description: string
  insertPrefix: string
  activatesDeepPlan?: boolean
}

export const DEEP_PLAN_COMMAND = '/deep-plan'

export const SLASH_COMMANDS: SlashCommand[] = [
  {
    id: 'deep-plan',
    command: DEEP_PLAN_COMMAND,
    title: 'Deep plan',
    description: 'Spawn specialised agents for detailed planning',
    insertPrefix: `${DEEP_PLAN_COMMAND} `,
    activatesDeepPlan: true,
  },
]

export const hasDeepPlanPrefix = (text: string): boolean =>
  text.trimStart().toLowerCase().startsWith(DEEP_PLAN_COMMAND)

/** True while user is still typing the slash command token (before a space). */
export const isTypingSlashCommand = (text: string): boolean => {
  const head = text.trimStart().split('\n')[0] ?? ''
  return head.startsWith('/') && !head.slice(1).includes(' ')
}

export const filterSlashCommands = (query: string): SlashCommand[] => {
  const q = query.toLowerCase().replace(/^\//, '')
  if (!q) {
    return SLASH_COMMANDS
  }
  return SLASH_COMMANDS.filter(
    (cmd) =>
      cmd.command.toLowerCase().includes(q) ||
      cmd.title.toLowerCase().includes(q)
  )
}

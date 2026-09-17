import { TOOL_INPUT_MAX, TOOL_INPUT_TEXT_BUDGETS } from './tool-input-budget'

export type ToolCommandPayload = {
  kind: 'shell-command'
  command: string
  truncated?: true
}

/** Retain command input, independently of any effects reported by its result.
 * Like edits, oversized inputs shrink until their serialized JSON fits. */
export function safeToolCommandJson(toolName: string, input: unknown): string | undefined {
  const name = (toolName.split('__').pop() ?? toolName).toLowerCase().replace(/[_-]/g, '')
  if (!['bash', 'execcommand', 'shellcommand'].includes(name)) return undefined
  if (!input || typeof input !== 'object' || Array.isArray(input)) return undefined
  const record = input as Record<string, unknown>
  const command = typeof record.command === 'string' ? record.command : record.cmd
  if (typeof command !== 'string') return undefined
  const encode = (text: string, truncated?: true): string =>
    JSON.stringify({
      kind: 'shell-command',
      command: text,
      ...(truncated ? { truncated } : {}),
    } satisfies ToolCommandPayload)
  // Avoid serializing an arbitrarily large command just to reject it.
  if (command.length <= TOOL_INPUT_MAX) {
    const raw = encode(command)
    if (raw.length <= TOOL_INPUT_MAX) return raw
  }
  for (const budget of TOOL_INPUT_TEXT_BUDGETS) {
    const raw = encode(command.slice(0, budget), true)
    if (raw.length <= TOOL_INPUT_MAX) return raw
  }
  return undefined
}

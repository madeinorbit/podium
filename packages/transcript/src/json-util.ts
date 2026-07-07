/**
 * Small pure JSON-shape helpers shared by the per-agent transcript parsers.
 * Moved from @podium/agent-bridge's discovery/jsonl.ts (which re-exports them
 * for its own consumers) so the parsers carry no dependency on discovery.
 */

export function contentToText(value: unknown): string {
  if (typeof value === 'string') return value
  if (!Array.isArray(value)) return contentPartToText(value)

  return value
    .map(contentPartToText)
    .filter((part) => part.length > 0)
    .join('\n')
}

function contentPartToText(value: unknown): string {
  if (typeof value === 'string') return value
  if (!isRecord(value)) return ''

  if (typeof value.text === 'string') return value.text
  if (typeof value.content === 'string') return value.content
  if (Array.isArray(value.content)) return contentToText(value.content)

  if (value.type === 'tool_use' && typeof value.name === 'string') {
    return `[tool_use:${value.name}]`
  }

  return ''
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function stringField(value: Record<string, unknown>, key: string): string | undefined {
  const field = value[key]
  return typeof field === 'string' && field.length > 0 ? field : undefined
}

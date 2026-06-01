import type {
  AgentConversationDiagnostic,
  AgentConversationRole,
} from './types.js'

type ParseJsonLinesContext = {
  providerId: string
  path: string
  root?: string
}

export function parseJsonLines(
  text: string,
  context: ParseJsonLinesContext,
): { records: unknown[]; diagnostics: AgentConversationDiagnostic[] } {
  const records: unknown[] = []
  const diagnostics: AgentConversationDiagnostic[] = []
  const lines = text.split(/\r?\n/)

  for (const [index, line] of lines.entries()) {
    const trimmed = line.trim()
    if (trimmed.length === 0) continue

    try {
      records.push(JSON.parse(trimmed) as unknown)
    } catch (cause) {
      diagnostics.push({
        severity: 'warning',
        providerId: context.providerId,
        root: context.root,
        path: context.path,
        message: `Could not parse JSONL line ${index + 1} in ${context.path}`,
        cause,
      })
    }
  }

  return { records, diagnostics }
}

export function mapConversationRole(role: unknown): AgentConversationRole {
  switch (role) {
    case 'user':
    case 'assistant':
    case 'system':
    case 'tool':
      return role
    case 'developer':
      return 'system'
    default:
      return 'unknown'
  }
}

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

export function numberField(value: Record<string, unknown>, key: string): number | undefined {
  const field = value[key]
  return typeof field === 'number' && Number.isFinite(field) ? field : undefined
}

export function dateField(value: Record<string, unknown>, key: string): Date | undefined {
  const field = stringField(value, key)
  if (!field) return undefined

  const date = new Date(field)
  return Number.isNaN(date.getTime()) ? undefined : date
}

export function dateFromEpochMillis(value: unknown): Date | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? undefined : date
}

export function compactText(value: string | undefined): string | undefined {
  if (!value) return undefined
  const trimmed = value.replace(/\s+/g, ' ').trim()
  return trimmed.length > 0 ? trimmed : undefined
}

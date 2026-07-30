import { open } from 'node:fs/promises'
import { stringField } from '@podium/transcript'

// Moved to @podium/transcript (the parsers there need them); re-exported for
// this package's discovery providers, which imported them from here.
export { contentToText, isRecord, stringField } from '@podium/transcript'

import type { AgentConversationDiagnostic, AgentConversationRole } from './types.js'

type ParseJsonLinesContext = {
  providerId: string
  path: string
  root?: string
}

export const DEFAULT_JSONL_HEAD_BYTES = 64 * 1024
export const DEFAULT_JSONL_HEAD_LINES = 50

export async function readJsonLinesHead(
  file: string,
  context: ParseJsonLinesContext,
  options: { maxBytes?: number; maxLines?: number } = {},
): Promise<{ records: unknown[]; diagnostics: AgentConversationDiagnostic[] }> {
  const maxBytes = options.maxBytes ?? DEFAULT_JSONL_HEAD_BYTES
  const maxLines = options.maxLines ?? DEFAULT_JSONL_HEAD_LINES
  const handle = await open(file, 'r')

  try {
    const buffer = Buffer.alloc(maxBytes)
    const { bytesRead } = await handle.read(buffer, 0, maxBytes, 0)
    let text = buffer.subarray(0, bytesRead).toString('utf8')

    if (bytesRead === maxBytes) {
      const lastLf = text.lastIndexOf('\n')
      const lastCr = text.lastIndexOf('\r')
      const lastLineBreak = Math.max(lastLf, lastCr)
      text = lastLineBreak >= 0 ? text.slice(0, lastLineBreak + 1) : ''
    }

    const lines = text.split(/\r?\n/).slice(0, maxLines)
    return parseJsonLines(lines.join('\n'), context)
  } finally {
    await handle.close()
  }
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

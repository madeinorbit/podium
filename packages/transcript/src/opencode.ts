import type { TranscriptItem } from '@podium/protocol'
/**
 * One row of opencode's SQLite `part` join (message + part payloads). The type
 * lives here — next to the pure part→items mapper — so the parser package needs
 * no SQLite dependency; @podium/agent-bridge's opencode DB reader produces rows
 * of this shape and re-exports the type for compatibility.
 */
export type OpencodeMessagePartRow = {
  messageId: string
  partId: string
  sessionId: string
  timeCreated: number
  timeUpdated: number
  messageData: string
  partData: string
}

import { toolInputPreview } from './claude'

/** Normalize one opencode message+part row into Podium chat transcript items. */
export function opencodePartToItems(row: OpencodeMessagePartRow): TranscriptItem[] {
  const messageInfo = parseJsonRecord(row.messageData)
  const part = parseJsonRecord(row.partData)
  if (!messageInfo || !part) return []

  const role = stringField(messageInfo, 'role')
  const partType = stringField(part, 'type')
  const ts = epochToIso(row.timeUpdated ?? row.timeCreated)

  switch (partType) {
    case 'text': {
      const text = stringField(part, 'text')
      if (!text) return []
      if (role === 'user') {
        return [
          {
            id: stableId('opencode-user', `${row.partId}:${text}`),
            role: 'user',
            ...(ts ? { ts } : {}),
            text,
          },
        ]
      }
      if (role === 'assistant') {
        return [
          {
            id: stableId('opencode-assistant', `${row.partId}:${text}`),
            role: 'assistant',
            ...(ts ? { ts } : {}),
            text,
          },
        ]
      }
      return []
    }
    case 'tool': {
      const toolName = stringField(part, 'tool') ?? 'tool'
      const state = recordField(part, 'state')
      const input = state ? recordField(state, 'input') : undefined
      const output = state ? stringField(state, 'output') : undefined
      const callId = stringField(part, 'callID')
      const items: TranscriptItem[] = [
        {
          id: stableId('opencode-tool', `${row.partId}:${toolName}`),
          role: 'tool',
          ...(ts ? { ts } : {}),
          text: toolName,
          toolName,
          ...(input !== undefined ? { toolInput: toolInputPreview(input) } : {}),
          ...(callId ? { toolUseId: callId } : {}),
        },
      ]
      if (output) {
        items.push({
          id: stableId('opencode-tool-result', `${row.partId}:${callId ?? ''}:${output}`),
          role: 'tool',
          ...(ts ? { ts } : {}),
          text: output,
          toolName,
          toolResult: output,
          ...(callId ? { toolUseId: callId } : {}),
        })
      }
      return items
    }
    default:
      return []
  }
}

export function opencodeRowsToItems(rows: OpencodeMessagePartRow[]): TranscriptItem[] {
  const items: TranscriptItem[] = []
  for (const row of rows) items.push(...opencodePartToItems(row))
  return items
}

export function classifyOpencodeIdleText(text: string | undefined): {
  kind: 'done' | 'question'
  summary?: string
} {
  const summary = text?.trim()
  if (!summary) return { kind: 'done' }
  if (/\?\s*$/.test(summary.slice(-120)))
    return { kind: 'question', summary: summary.slice(0, 140) }
  return { kind: 'done', summary: summary.slice(0, 140) }
}

function parseJsonRecord(raw: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(raw)
    return isRecord(parsed) ? parsed : undefined
  } catch {
    return undefined
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function recordField(v: Record<string, unknown>, key: string): Record<string, unknown> | undefined {
  const field = v[key]
  return isRecord(field) ? field : undefined
}

function stringField(v: Record<string, unknown>, key: string): string | undefined {
  const field = v[key]
  return typeof field === 'string' && field.length > 0 ? field : undefined
}

function epochToIso(ms: number | undefined): string | undefined {
  if (ms === undefined || !Number.isFinite(ms) || ms <= 0) return undefined
  return new Date(ms).toISOString()
}

function stableId(prefix: string, seed: string): string {
  let hash = 0
  for (let i = 0; i < seed.length; i++) hash = (hash * 31 + seed.charCodeAt(i)) >>> 0
  return `${prefix}-${hash.toString(16)}`
}

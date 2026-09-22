import type { TranscriptItem } from '@podium/model'
import { opencodeDbPathForSession } from '../../opencode/db.js'
import {
  encodeCursor,
  type OpencodeMessagePartRow,
  type SqliteTranscriptLocator,
} from '../../transcript-types.js'
export type { OpencodeMessagePartRow } from '../../transcript-types.js'
import {
  type Declared,
  type HarnessTranscript,
  supported,
  unsupported,
  type TranscriptSourceInput,
} from '../../manifest.js'
import { toolInputPreview } from '../claude-code/transcript.js'
import { safeToolEditJsonFromInput } from '../shared/tool-edit.js'

/** Normalize one opencode message+part row into Podium chat transcript items. */
export function opencodePartToItems(row: OpencodeMessagePartRow): TranscriptItem[] {
  const messageInfo = parseJsonRecord(row.messageData)
  const part = parseJsonRecord(row.partData)
  if (!messageInfo || !part) return []

  const role = stringField(messageInfo, 'role')
  const partType = stringField(part, 'type')
  const ts = epochToIso(row.timeUpdated ?? row.timeCreated)
  // Identity excludes mutable payloads and timestamps. The paging cursor keeps
  // timeCreated separately; tool calls/results occupy stable slots 0 and 1.
  const itemId = (sub: number): string =>
    encodeCursor({ fileId: opencodeFileId(row.sessionId), offset: 0, uuid: row.partId, sub })
  const aborted = isOpencodeMessageAborted(messageInfo)
  if (partType === 'interrupt' && aborted) {
    return [
      {
        id: itemId(0),
        role: 'user',
        ...(ts ? { ts } : {}),
        text: '[Request interrupted by user]',
        event: 'interrupt',
      },
    ]
  }
  // The abort envelope owns the whole assistant message. Text/tool rows can be
  // observed before the synthetic interrupt row and must not survive it as a
  // natural completion beside the provider's durable interruption marker.
  if (aborted) return []

  switch (partType) {
    case 'text': {
      const text = stringField(part, 'text')
      if (!text) return []
      if (role === 'user') {
        return [
          {
            id: itemId(0),
            role: 'user',
            ...(ts ? { ts } : {}),
            text,
          },
        ]
      }
      if (role === 'assistant') {
        return [
          {
            id: itemId(0),
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
      const toolInputJson = input ? safeToolEditJsonFromInput(toolName, input) : undefined
      const items: TranscriptItem[] = [
        {
          id: itemId(0),
          role: 'tool',
          ...(ts ? { ts } : {}),
          text: toolName,
          toolName,
          ...(input !== undefined ? { toolInput: toolInputPreview(input) } : {}),
          ...(toolInputJson ? { toolInputJson } : {}),
          ...(callId ? { toolUseId: callId } : {}),
        },
      ]
      if (output) {
        items.push({
          id: itemId(1),
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

export function isOpencodeMessageAborted(message: Record<string, unknown>): boolean {
  const error = recordField(message, 'error')
  const name = error ? stringField(error, 'name') : undefined
  return name === 'MessageAborted' || name === 'MessageAbortedError'
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

/**
 * Stable cursor namespace for an opencode session.
 *
 * Kept next to the part mapper (one definition): the live driver observer and
 * the on-demand SQLite read stamp the EXACT SAME scheme, so live deltas and
 * read pages interoperate (the client can dedup/subscribe-from-cursor).
 */
/** UNBRANDED BY DECISION: a provider/harness-native session id, not a Podium SessionId. */
export function opencodeFileId(sessionId: string): string {
  return `opencode:${sessionId}`
}

// ---------------------------------------------------------------------------
// Transcript section: sqlite-store grammar (POD-4471), the ONE authoritative
// transcript definition for this harness (spec §4): data plus pure functions,
// never a source. HOST-ONLY READS: the lake serves opencode transcripts live
// off the machine's database until the database itself is mirrored (open
// point) — never from a lake copy; the Store builds that source from the
// locator below (`transcriptSourceFromGrammar`, `store/sources/sqlite.ts`).
// ---------------------------------------------------------------------------

export const opencodeTranscript: Declared<HarnessTranscript> = supported({
  // SQLite-backed — no file chain; the Store's DB source serves the same cursor
  // contract as the chain reader.
  storage: 'sqlite',
  recordToItems: unsupported('opencode maps typed SQLite rows rather than native JSONL records'),
  recordRuntime: unsupported('opencode reports no model, effort or context use in its records'),
  recordColor: unsupported('opencode has no identity-colour record'),
  chainPaths: unsupported('opencode stores transcripts in SQLite — there are no files to chain'),
  sqliteLocator: supported(
    (input: TranscriptSourceInput): SqliteTranscriptLocator | undefined => {
      // No resume value → nothing to read; the Store hands back an inert empty
      // source so the caller need not special-case it.
      if (!input.resumeValue) return undefined
      const databasePath = opencodeDbPathForSession({
        homeDir: input.homeDir,
        podiumSessionId: input.podiumSessionId,
        resumeValue: input.resumeValue,
      })
      return {
        sessionKey: input.resumeValue,
        ...(input.homeDir !== undefined ? { homeDir: input.homeDir } : {}),
        ...(databasePath ? { databasePath } : {}),
      }
    },
  ),
})

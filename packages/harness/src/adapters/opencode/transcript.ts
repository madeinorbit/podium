import type { TranscriptItem } from '@podium/model'
import {
  loadOpencodeTranscriptTail,
  opencodeDbPathForSession,
  openOpencodeDb,
} from '../../opencode/db.js'
import { sliceItemsByAnchor, type TranscriptSource } from '../../store/source.js'
import { supported, unsupported, type TranscriptSourceInput } from '../../manifest.js'
/**
 * One row of opencode's SQLite `part` join (message + part payloads). The type
 * lives here — next to the pure part→items mapper — so the parser package needs
 * no SQLite dependency; @podium/harness's opencode DB reader produces rows
 * of this shape and re-exports the type for compatibility.
 */
export type OpencodeMessagePartRow = {
  messageId: string
  partId: string
  /** UNBRANDED BY DECISION: a provider/harness-native session id, not a Podium SessionId. */
  sessionId: string
  timeCreated: number
  timeUpdated: number
  messageData: string
  partData: string
}

import { toolInputPreview } from '../claude-code/transcript.js'
import { encodeCursor } from '../../store/cursor-codec.js'
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

/**
 * Map opencode part rows to cursor-stamped items, stamping each item with a
 * cursor that encodes the part's position in the session's total
 * `(time_created, id, sub)` order. One part → 0..N items (a tool part is a call +
 * a result), so each item gets its own `sub` index within the part.
 *
 *   - `offset` = `row.timeCreated` (the DB's primary order key)
 *   - `uuid`   = `row.partId`      (disambiguates same-`time_created` ties; the
 *                                   secondary `id` order key)
 *   - `sub`    = item index within the part
 *
 * The triple is the part-position analog of the file `(offset, uuid, sub)` and
 * yields a total order matching the DB's `(time_created, id, sub)`. The cursor
 * namespace (`fileId`) is derived from `sessionId` here so callers pass only
 * `(rows, sessionId)` — they never construct the fileId themselves.
 */
export function stampOpencodeItems(
  rows: OpencodeMessagePartRow[],
  /** UNBRANDED BY DECISION: a provider/harness-native session id, not a Podium SessionId. */
  sessionId: string,
): TranscriptItem[] {
  const fileId = opencodeFileId(sessionId)
  const out: TranscriptItem[] = []
  for (const row of rows) {
    const items = opencodePartToItems(row)
    for (let sub = 0; sub < items.length; sub++) {
      const item = items[sub]
      if (!item) continue
      out.push({
        ...item,
        ...(item.event === 'interrupt'
          ? {}
          : { cursor: encodeCursor({ fileId, offset: row.timeCreated, uuid: row.partId, sub }) }),
      })
    }
  }
  return out
}

// ---------------------------------------------------------------------------
// Transcript section: sqlite-store grammar + source (POD-4471), the ONE
// authoritative transcript definition for this harness (spec §4). HOST-ONLY:
// the lake serves opencode transcripts live off the machine's database until
// the database itself is mirrored (open point) — never from a lake copy.
// ---------------------------------------------------------------------------


/**
 * Source for opencode. opencode stores transcript "parts" in SQLite ordered by
 * `(time_updated ASC, id ASC)`. A single session's parts are bounded (≤8000, the
 * `loadOpencodeTranscriptTail` cap), so loading them in one indexed query is
 * cheap and IS the bounded read — there is no per-call full-DB scan beyond this
 * one session's capped part list. We then build the full ordered item list and
 * index-slice it in memory, exactly matching `readTranscriptSlice`'s semantics.
 */
/** UNBRANDED BY DECISION: a provider/harness-native session id, not a Podium SessionId. */
export function opencodeDbSource(input: {
  sessionId: string
  homeDir?: string
  databasePath?: string
}): TranscriptSource {
  return {
    readSlice: async (opts) => {
      if (opts.limit <= 0) return { items: [], hasMore: false }
      const db = openOpencodeDb(input.homeDir, input.databasePath)
      if (!db) return { items: [], hasMore: false }
      let rows: OpencodeMessagePartRow[]
      try {
        rows = loadOpencodeTranscriptTail(db, input.sessionId)
      } catch {
        return { items: [], hasMore: false }
      } finally {
        db.close()
      }
      // ASC by (time_updated, id); each part expands to 0..N stamped items in
      // intra-part order, so `all` is the session's full transcript in total order.
      const all = stampOpencodeItems(rows, input.sessionId)
      return sliceItemsByAnchor(all, opts)
    },
  }
}

export const opencodeTranscript = supported({
  // SQLite-backed — no file chain; the DB source serves the same cursor
  // contract as the chain reader.
  storage: 'sqlite',
  recordToItems: unsupported('opencode maps typed SQLite rows rather than native JSONL records'),
  recordRuntime: unsupported('opencode reports no model, effort or context use in its records'),
  recordColor: unsupported('opencode has no identity-colour record'),
  chainPaths: unsupported('opencode stores transcripts in SQLite — there are no files to chain'),
  async sourceFor(input: TranscriptSourceInput) {
    // No resume value → nothing to read; hand back an inert empty source so
    // the caller need not special-case it.
    if (!input.resumeValue) {
      return { readSlice: async () => ({ items: [], hasMore: false }) }
    }
    const databasePath = opencodeDbPathForSession({
      homeDir: input.homeDir,
      podiumSessionId: input.podiumSessionId,
      resumeValue: input.resumeValue,
    })
    return opencodeDbSource({
      sessionId: input.resumeValue,
      ...(input.homeDir !== undefined ? { homeDir: input.homeDir } : {}),
      ...(databasePath ? { databasePath } : {}),
    })
  },
})

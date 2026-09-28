/**
 * THE ONE ENGINE-HOST HISTORY READ (POD-4784, ADR 10 Decision B).
 *
 * History is at-rest data: no family answers transcript.history from a
 * protocol call or from process memory; the protocol stream carries deltas
 * only. The three engine hosts (codex, opencode, grok-acp) share this ONE
 * implementation over `transcriptSourceFromGrammar` — the same shape as the
 * terminal host's `readHistory` (`apps/daemon/src/runtime/host.ts`) and the
 * contract host's (`apps/daemon/src/host-runtime.ts` ~:1267): resolve the
 * session's transcript source from the family's adapter grammar and slice it
 * with Store cursors.
 *
 * A session with no readable transcript yet (a thread before its first turn,
 * a database with no messages, a missing chat-history file) reads as an
 * empty page, never an error: the slice layer returns empty for a missing
 * chain, a missing file or a missing database. A foreign cursor refuses with
 * `invalid_value`, exactly as the terminal and headless hosts do.
 */

import type { SessionId } from '@podium/model'
import type { RuntimeHistoryPage, RuntimeHistoryRange } from '@podium/protocol/daemon'
import type { HarnessTranscript } from '../../manifest.js'
import { declaredValue, type Declared } from '../../transcript-types.js'
import { transcriptSourceFromGrammar } from '../../store/store.js'
import { DriverRefusalError } from '../errors.js'

export interface EngineHistorySession {
  sessionId: SessionId
  cwd: string
  resume?: { kind: string; value: string }
  pathHint?: string
}

export type EngineHistoryRange = Omit<RuntimeHistoryRange, 'direction'> & {
  direction?: RuntimeHistoryRange['direction']
}

/**
 * Resolve the session's transcript source from the family's adapter grammar
 * and slice it with Store cursors. The grammar selects the at-rest store
 * (rollout JSONL chain, sqlite database, chat-history file); the protocol
 * client is never consulted.
 */
export async function readEngineHistoryFromGrammar(
  grammarDecl: Declared<HarnessTranscript>,
  session: EngineHistorySession,
  range: EngineHistoryRange,
  homeDir?: string,
): Promise<RuntimeHistoryPage> {
  const segmentId = `history:${session.sessionId}:${session.resume?.value ?? ''}`
  if (range.from && (range.from.segmentId !== segmentId || !range.from.pathHint)) {
    throw new DriverRefusalError(
      { reason: 'invalid_value', detail: 'foreign history cursor' },
      'transcript.history',
    )
  }
  const grammar = declaredValue(grammarDecl)
  if (!grammar) return { items: [], hasMore: false }
  const source = await transcriptSourceFromGrammar(grammar, {
    podiumSessionId: session.sessionId,
    cwd: session.cwd,
    ...(session.resume?.value ? { resumeValue: session.resume.value } : {}),
    ...(session.pathHint ? { pathHint: session.pathHint } : {}),
    ...(homeDir ? { homeDir } : {}),
  })
  const slice = await source.readSlice({
    ...(range.from ? { anchor: range.from.pathHint } : {}),
    direction: range.direction ?? 'before',
    limit: range.limit,
  })
  const cursor = (anchor: string) => ({ segmentId, pathHint: anchor, components: {} })
  return {
    items: slice.items,
    ...(slice.head ? { head: cursor(slice.head) } : {}),
    ...(slice.tail ? { tail: cursor(slice.tail) } : {}),
    hasMore: slice.hasMore,
  }
}

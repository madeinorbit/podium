import { open, readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { type StatTick, scheduleStatPoll } from '@podium/transcript'
import { LineDecoder } from '../jsonl-stream.js'
import { locatePiSessionFile, piSessionDir, piSessionIdFromPath } from '../pi/paths.js'
import { withEventTime } from './reducer.js'
import { type AgentStateEvent, type AgentStateProvider, withStateChannel } from './types.js'

const POLL_MS = 700
const TAIL_BYTES = 128 * 1024
const FRESH_SESSION_MARGIN_MS = 5_000

export interface PiStateObserver {
  readonly path: string | undefined
  stop(): void
}

/**
 * Pi has no shell-hook surface (its instrumentation is in-process TypeScript
 * extensions), so the daemon reads state the way it does for Cursor: a poll
 * channel tailing the session JSONL. An assistant entry's `stopReason` is the
 * turn boundary — `stop` ends a turn, `toolUse` is intermediate, `error` fails
 * it, `aborted` is an interrupt.
 */
export const piStateProvider: AgentStateProvider = {
  instrumentation() {
    return { args: [] }
  },
  translate: async (payload) => withStateChannel(translatePiRecord(payload), 'poll'),
  bootEvents: async (opts) => withStateChannel(await piBootEvents(opts), 'poll'),
}

export function translatePiRecord(record: unknown): AgentStateEvent[] {
  if (!isRecord(record)) return []
  const type = stringField(record, 'type')
  const at = stringField(record, 'timestamp')
  if (type === 'session') return withEventTime([{ kind: 'session_started' }], at)
  if (type === 'compaction') {
    return withEventTime(
      [
        { kind: 'compaction', phase: 'start' },
        { kind: 'compaction', phase: 'end' },
      ],
      at,
    )
  }
  if (type !== 'message') return []
  const message = recordField(record, 'message')
  if (!message) return []
  switch (stringField(message, 'role')) {
    case 'user':
      return withEventTime([{ kind: 'prompt_submitted' }], at)
    case 'toolResult':
    case 'bashExecution':
      return withEventTime([{ kind: 'activity' }], at)
    case 'assistant':
      return withEventTime([assistantEvent(message)], at)
    default:
      return []
  }
}

function assistantEvent(message: Record<string, unknown>): AgentStateEvent {
  switch (stringField(message, 'stopReason')) {
    case 'toolUse':
      return { kind: 'activity' }
    case 'error':
      return {
        kind: 'turn_failed',
        errorClass: stringField(message, 'errorMessage') ?? 'provider error',
        // Pi retries transient provider errors itself (auto_retry); a repeated
        // failure lands as further error entries, so each one is reported as-is.
        retryable: true,
      }
    case 'aborted':
      return { kind: 'turn_completed', verdict: { kind: 'interrupted' } }
    default:
      return { kind: 'turn_completed', verdict: classifyAssistantText(message) }
  }
}

const QUESTIONISH =
  /(\?\s*$)|(\b(would you like|do you want|should i|shall i|which (one|option)|let me know)\b[^.]*\?)/i

function classifyAssistantText(message: Record<string, unknown>): {
  kind: 'done' | 'question'
  summary?: string
} {
  const text = assistantText(message)
  if (text && QUESTIONISH.test(text.slice(-400))) {
    const summary =
      text
        .split('\n')
        .filter((line) => line.trim())
        .at(-1) ?? text
    return { kind: 'question', summary: summary.trim().slice(0, 140) }
  }
  return { kind: 'done' }
}

function assistantText(message: Record<string, unknown>): string {
  const content = message.content
  if (!Array.isArray(content)) return typeof content === 'string' ? content : ''
  return content
    .map((part) => (isRecord(part) && part.type === 'text' ? stringField(part, 'text') : undefined))
    .filter((part): part is string => !!part)
    .join('\n')
    .trim()
}

/** Idle verdict from the tail of a session file: the last assistant entry. */
export function classifyPiIdleTranscript(
  records: unknown[],
): { kind: 'done' | 'question' | 'interrupted'; summary?: string; at?: string } | undefined {
  for (let i = records.length - 1; i >= 0; i--) {
    const record = records[i]
    if (!isRecord(record) || stringField(record, 'type') !== 'message') continue
    const message = recordField(record, 'message')
    if (!message || stringField(message, 'role') !== 'assistant') continue
    const event = assistantEvent(message)
    const at = stringField(record, 'timestamp')
    if (event.kind !== 'turn_completed') return undefined
    const verdict = event.verdict ?? { kind: 'done' as const }
    if (verdict.kind !== 'done' && verdict.kind !== 'question' && verdict.kind !== 'interrupted')
      return undefined
    return {
      kind: verdict.kind,
      ...(verdict.summary ? { summary: verdict.summary } : {}),
      ...(at ? { at } : {}),
    }
  }
  return undefined
}

async function piBootEvents(opts: {
  cwd: string
  resumeValue?: string
  homeDir?: string
  pathHint?: string
}): Promise<AgentStateEvent[]> {
  if (opts.resumeValue) {
    try {
      const path = await locatePiSessionFile({
        cwd: opts.cwd,
        sessionId: opts.resumeValue,
        ...(opts.homeDir ? { homeDir: opts.homeDir } : {}),
        ...(opts.pathHint ? { pathHint: opts.pathHint } : {}),
      })
      if (path) {
        const verdict = classifyPiIdleTranscript(await readPiTranscriptTail(path))
        if (verdict) {
          const { at, ...rest } = verdict
          return [{ kind: 'turn_completed', verdict: rest, ...(at ? { at } : {}) }]
        }
      }
    } catch {
      // Missing/unreadable transcript falls back to a bare boot event.
    }
  }
  return [{ kind: 'session_started' }]
}

/** The newest session file in a cwd's bucket, optionally not older than `sinceMs`. */
export async function findLatestPiSessionFile(opts: {
  cwd: string
  homeDir?: string
  sinceMs?: number
}): Promise<string | undefined> {
  const dir = piSessionDir(opts.cwd, opts.homeDir)
  let names: string[]
  try {
    names = await readdir(dir)
  } catch {
    return undefined
  }
  const candidates: { path: string; mtimeMs: number }[] = []
  for (const name of names) {
    if (!name.endsWith('.jsonl')) continue
    const path = join(dir, name)
    try {
      const info = await stat(path)
      if (opts.sinceMs !== undefined && info.mtimeMs < opts.sinceMs - FRESH_SESSION_MARGIN_MS) {
        continue
      }
      candidates.push({ path, mtimeMs: info.mtimeMs })
    } catch {
      // Raced with a delete; skip.
    }
  }
  candidates.sort((left, right) => right.mtimeMs - left.mtimeMs)
  return candidates[0]?.path
}

/**
 * Per-session Pi observation: locate the session file (by id when known, else
 * the newest file in the cwd bucket created after spawn), announce it, and tail
 * it for state events. A known id whose file does not exist yet (a headless
 * session before its first turn writes) keeps polling until it appears.
 */
export function observePiState(opts: {
  cwd: string
  resumeValue?: string
  homeDir?: string
  pathHint?: string
  startedAtMs?: number
  pollMs?: number
  statTick?: StatTick
  onSession?: (sessionId: string, path: string) => void
  onEvents: (events: AgentStateEvent[]) => void
}): PiStateObserver {
  const pollMs = opts.pollMs ?? POLL_MS
  const startedAtMs = opts.startedAtMs ?? Date.now()
  let stopped = false
  let attached: { sessionId: string; path: string } | undefined
  let tail: PiStateObserver | undefined
  let locating = false

  const attach = (sessionId: string, path: string): void => {
    if (stopped || attached?.path === path) return
    tail?.stop()
    attached = { sessionId, path }
    opts.onSession?.(sessionId, path)
    tail = tailPiTranscript(path, opts.onEvents, { pollMs, statTick: opts.statTick })
  }

  const locate = async (): Promise<void> => {
    if (stopped || attached || locating) return
    locating = true
    try {
      if (opts.resumeValue) {
        const path = await locatePiSessionFile({
          cwd: opts.cwd,
          sessionId: opts.resumeValue,
          ...(opts.homeDir ? { homeDir: opts.homeDir } : {}),
          ...(opts.pathHint ? { pathHint: opts.pathHint } : {}),
        })
        if (path) attach(opts.resumeValue, path)
        return
      }
      const path = await findLatestPiSessionFile({
        cwd: opts.cwd,
        ...(opts.homeDir ? { homeDir: opts.homeDir } : {}),
        sinceMs: startedAtMs,
      })
      const sessionId = path ? piSessionIdFromPath(path) : undefined
      if (path && sessionId) attach(sessionId, path)
    } finally {
      locating = false
    }
  }

  const stopLocating = scheduleStatPoll(
    () => {
      if (attached) {
        stopLocating()
        return
      }
      void locate()
    },
    { statTick: opts.statTick, pollMs },
  )
  void locate()

  return {
    get path() {
      return attached?.path
    },
    stop() {
      stopped = true
      stopLocating()
      tail?.stop()
    },
  }
}

function tailPiTranscript(
  path: string,
  onEvents: (events: AgentStateEvent[]) => void,
  opts: { pollMs?: number; statTick?: StatTick } = {},
): PiStateObserver {
  let offset = 0
  const decoder = new LineDecoder()
  let first = true
  let dropLeadingPartial = false
  let stopped = false
  let reading = false

  const readNew = async (): Promise<void> => {
    if (reading || stopped) return
    reading = true
    try {
      const handle = await open(path, 'r')
      try {
        const { size } = await handle.stat()
        if (first) {
          const start = Math.max(0, size - TAIL_BYTES)
          offset = start
          dropLeadingPartial = start > 0
          first = false
        }
        if (size < offset) {
          offset = 0
          decoder.reset()
          dropLeadingPartial = false
        }
        if (size === offset) return
        const chunk = Buffer.alloc(size - offset)
        await handle.read(chunk, 0, chunk.length, offset)
        offset = size
        let lines = decoder.push(chunk)
        if (dropLeadingPartial && lines.length > 0) {
          lines = lines.slice(1)
          dropLeadingPartial = false
        }
        const events: AgentStateEvent[] = []
        for (const line of lines) {
          const trimmed = line.trim()
          if (!trimmed) continue
          try {
            events.push(...translatePiRecord(JSON.parse(trimmed) as unknown))
          } catch {
            // Torn writes are ignored; the next poll catches up.
          }
        }
        if (events.length > 0) onEvents(events)
      } finally {
        await handle.close()
      }
    } catch {
      // The file may vanish (session deleted) or not exist yet.
    } finally {
      reading = false
    }
  }

  const stopPolling = scheduleStatPoll(() => void readNew(), {
    statTick: opts.statTick,
    pollMs: opts.pollMs ?? POLL_MS,
  })
  void readNew()

  return {
    path,
    stop() {
      stopped = true
      stopPolling()
    },
  }
}

export async function readPiTranscriptTail(path: string): Promise<unknown[]> {
  const handle = await open(path, 'r')
  try {
    const { size } = await handle.stat()
    const start = Math.max(0, size - TAIL_BYTES)
    const buffer = Buffer.alloc(Math.min(size, TAIL_BYTES))
    await handle.read(buffer, 0, buffer.length, start)
    let text = buffer.toString('utf8')
    if (start > 0) {
      const firstBreak = text.indexOf('\n')
      text = firstBreak >= 0 ? text.slice(firstBreak + 1) : ''
    }
    const records: unknown[] = []
    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trim()
      if (!trimmed) continue
      try {
        records.push(JSON.parse(trimmed) as unknown)
      } catch {
        // Skip torn final writes.
      }
    }
    return records
  } finally {
    await handle.close()
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function recordField(value: Record<string, unknown>, key: string) {
  const field = value[key]
  return isRecord(field) ? field : undefined
}

function stringField(value: Record<string, unknown>, key: string): string | undefined {
  const field = value[key]
  return typeof field === 'string' && field.length > 0 ? field : undefined
}

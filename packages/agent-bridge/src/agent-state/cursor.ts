import type { Dirent } from 'node:fs'
import { open, readdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { LineDecoder } from '../jsonl-stream.js'
import {
  cursorProjectSlug,
  cursorRoot,
  cursorSessionPaths,
  type CursorSessionPaths,
} from '../cursor/paths.js'
import type { AgentStateEvent, AgentStateProvider } from './types.js'

const POLL_MS = 700
const TAIL_BYTES = 128 * 1024
const FRESH_SESSION_MARGIN_MS = 5_000

export interface CursorStateObserver {
  readonly path: string | undefined
  stop(): void
}

export const cursorStateProvider: AgentStateProvider = {
  instrumentation() {
    return { args: [] }
  },
  translate: translateCursorRecord,
  bootEvents: cursorBootEvents,
}

export async function translateCursorRecord(record: unknown): Promise<AgentStateEvent[]> {
  if (!isRecord(record)) return []

  const turnType = stringField(record, 'type')
  if (turnType === 'turn_ended') {
    const status = stringField(record, 'status')
    if (status === 'error' || status === 'failed') {
      return [{ kind: 'turn_failed', errorClass: status, retryable: false }]
    }
    return [{ kind: 'turn_completed', verdict: await classifyCursorTurnEnd(record) }]
  }

  const role = stringField(record, 'role')
  if (role === 'user') return [{ kind: 'prompt_submitted' }]
  if (role === 'assistant') {
    const message = recordField(record, 'message')
    const hasTool = Array.isArray(message?.content)
      ? message.content.some(
          (part) =>
            isRecord(part) &&
            (stringField(part, 'type') === 'tool_use' || stringField(part, 'type') === 'tool_call'),
        )
      : false
    return [{ kind: 'activity' }, ...(hasTool ? [] : [])]
  }
  return []
}

export function classifyCursorIdleTranscript(
  records: unknown[],
): { kind: 'done' | 'question' | 'approval'; summary?: string } | undefined {
  for (let i = records.length - 1; i >= 0; i--) {
    const record = records[i]
    if (!isRecord(record) || stringField(record, 'role') !== 'assistant') continue
    const message = recordField(record, 'message')
    const text = cursorMessageText(message?.content)
    if (!text) continue
    if (QUESTIONISH.test(text.slice(-400))) {
      const summary =
        text
          .split('\n')
          .filter((line) => line.trim())
          .at(-1) ?? text
      return { kind: 'question', summary: summary.trim().slice(0, 140) }
    }
    return { kind: 'done' }
  }
  return undefined
}

export async function findLatestCursorSessionPaths(opts: {
  cwd: string
  homeDir?: string
  sinceMs?: number
}): Promise<CursorSessionPaths | undefined> {
  const transcriptsRoot = join(
    cursorRoot(opts.homeDir),
    'projects',
    cursorProjectSlug(opts.cwd),
    'agent-transcripts',
  )
  let entries: Dirent<string>[]
  try {
    entries = await readdir(transcriptsRoot, { withFileTypes: true })
  } catch {
    return undefined
  }

  const candidates: { paths: CursorSessionPaths; mtimeMs: number }[] = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const paths = cursorSessionPaths({
      cwd: opts.cwd,
      chatId: entry.name,
      ...(opts.homeDir ? { homeDir: opts.homeDir } : {}),
    })
    try {
      const info = await stat(paths.transcriptPath)
      if (opts.sinceMs !== undefined && info.mtimeMs < opts.sinceMs - FRESH_SESSION_MARGIN_MS) {
        continue
      }
      candidates.push({ paths, mtimeMs: info.mtimeMs })
    } catch {
      // Directory may exist before the jsonl is written.
    }
  }

  candidates.sort((left, right) => right.mtimeMs - left.mtimeMs)
  return candidates[0]?.paths
}

export function observeCursorState(opts: {
  cwd: string
  resumeValue?: string
  homeDir?: string
  startedAtMs?: number
  pollMs?: number
  onSession?: (chatId: string) => void
  onEvents: (events: AgentStateEvent[]) => void
}): CursorStateObserver {
  const pollMs = opts.pollMs ?? POLL_MS
  const startedAtMs = opts.startedAtMs ?? Date.now()
  let stopped = false
  let attached: CursorSessionPaths | undefined
  let updateTail: CursorStateObserver | undefined

  const attach = (paths: CursorSessionPaths): void => {
    if (attached?.chatId === paths.chatId) return
    updateTail?.stop()
    attached = paths
    opts.onSession?.(paths.chatId)
    updateTail = tailCursorTranscript(paths, opts.onEvents, { pollMs })
  }

  const discover = async (): Promise<void> => {
    if (stopped || attached) return
    const paths = await findLatestCursorSessionPaths({
      cwd: opts.cwd,
      ...(opts.homeDir ? { homeDir: opts.homeDir } : {}),
      sinceMs: startedAtMs,
    })
    if (paths && !stopped) attach(paths)
  }

  let discoverTimer: ReturnType<typeof setInterval> | undefined
  if (opts.resumeValue) {
    attach(
      cursorSessionPaths({
        cwd: opts.cwd,
        chatId: opts.resumeValue,
        ...(opts.homeDir ? { homeDir: opts.homeDir } : {}),
      }),
    )
  } else {
    discoverTimer = setInterval(() => void discover(), pollMs)
    discoverTimer.unref?.()
    void discover()
  }

  return {
    get path() {
      return updateTail?.path
    },
    stop() {
      stopped = true
      if (discoverTimer) clearInterval(discoverTimer)
      updateTail?.stop()
    },
  }
}

async function cursorBootEvents(opts: {
  cwd: string
  resumeValue?: string
  homeDir?: string
}): Promise<AgentStateEvent[]> {
  if (opts.resumeValue) {
    const paths = cursorSessionPaths({
      cwd: opts.cwd,
      chatId: opts.resumeValue,
      ...(opts.homeDir ? { homeDir: opts.homeDir } : {}),
    })
    try {
      const verdict = classifyCursorIdleTranscript(await readCursorTranscriptTail(paths.transcriptPath))
      if (verdict) return [{ kind: 'turn_completed', verdict }]
    } catch {
      // Missing/unreadable transcript falls back to a bare boot event.
    }
  }
  return [{ kind: 'session_started' }]
}

async function classifyCursorTurnEnd(
  record: Record<string, unknown>,
): Promise<{ kind: 'done' | 'question' | 'approval'; summary?: string } | undefined> {
  const summary = stringField(record, 'summary')
  if (summary && QUESTIONISH.test(summary.slice(-400))) {
    return { kind: 'question', summary: summary.trim().slice(0, 140) }
  }
  return summary ? { kind: 'done', summary: summary.trim().slice(0, 140) } : { kind: 'done' }
}

function tailCursorTranscript(
  paths: CursorSessionPaths,
  onEvents: (events: AgentStateEvent[]) => void,
  opts: { pollMs?: number } = {},
): CursorStateObserver {
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
      const handle = await open(paths.transcriptPath, 'r')
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
            const record = JSON.parse(trimmed) as unknown
            events.push(...(await translateCursorRecord(record)))
          } catch {
            // Torn writes are ignored; the next poll catches up.
          }
        }
        if (events.length > 0) onEvents(events)
      } finally {
        await handle.close()
      }
    } catch {
      // File may not exist until Cursor finishes session initialization.
    } finally {
      reading = false
    }
  }

  const timer = setInterval(() => void readNew(), opts.pollMs ?? POLL_MS)
  timer.unref?.()
  void readNew()

  return {
    path: paths.transcriptPath,
    stop() {
      stopped = true
      clearInterval(timer)
    },
  }
}

async function readCursorTranscriptTail(path: string): Promise<unknown[]> {
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

function cursorMessageText(content: unknown): string {
  if (typeof content === 'string') return content.trim()
  if (!Array.isArray(content)) return ''
  return content
    .map((block) => {
      if (typeof block === 'string') return block
      if (isRecord(block) && stringField(block, 'type') === 'text') {
        return stringField(block, 'text') ?? ''
      }
      return ''
    })
    .filter(Boolean)
    .join('\n')
    .trim()
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function recordField(value: unknown, key: string): Record<string, unknown> | undefined {
  if (!isRecord(value)) return undefined
  const field = value[key]
  return isRecord(field) ? field : undefined
}

function stringField(value: unknown, key: string): string | undefined {
  if (!isRecord(value)) return undefined
  const field = value[key]
  return typeof field === 'string' && field.length > 0 ? field : undefined
}

const QUESTIONISH =
  /(\?\s*$)|\b(should i|shall i|want me to|would you like|let me know|which (one|option|approach)|do you want)\b/i
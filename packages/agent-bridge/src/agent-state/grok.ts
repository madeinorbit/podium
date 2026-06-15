import type { Dirent } from 'node:fs'
import { open, readdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { LineDecoder } from '../jsonl-stream.js'
import type { AgentStateEvent, AgentStateProvider } from './types.js'

const POLL_MS = 700
const TAIL_BYTES = 128 * 1024
const FRESH_SESSION_MARGIN_MS = 5_000

export interface GrokSessionPaths {
  sessionId: string
  sessionDir: string
  summaryPath: string
  updatesPath: string
  chatHistoryPath: string
}

export interface GrokStateObserver {
  readonly path: string | undefined
  stop(): void
}

export const grokStateProvider: AgentStateProvider = {
  instrumentation() {
    // Grok has no safe per-process --settings equivalent. State is observed from
    // its live session files instead, so no argv or project file mutation is needed.
    return { args: [] }
  },
  translate: translateGrokUpdatePayload,
  bootEvents: grokBootEvents,
}

export function grokSessionPaths(opts: {
  cwd: string
  sessionId: string
  homeDir?: string
}): GrokSessionPaths {
  const sessionDir = join(
    grokRoot(opts.homeDir),
    'sessions',
    encodeURIComponent(opts.cwd),
    opts.sessionId,
  )
  return {
    sessionId: opts.sessionId,
    sessionDir,
    summaryPath: join(sessionDir, 'summary.json'),
    updatesPath: join(sessionDir, 'updates.jsonl'),
    chatHistoryPath: join(sessionDir, 'chat_history.jsonl'),
  }
}

export async function translateGrokUpdatePayload(payload: unknown): Promise<AgentStateEvent[]> {
  if (!isRecord(payload)) return []
  const method = stringField(payload, 'method')
  if (method !== 'session/update' && method !== '_x.ai/session/update') return []
  const params = recordField(payload, 'params')
  const update = recordField(params, 'update')
  if (!update) return []

  const sessionUpdate = normalizeName(stringField(update, 'sessionUpdate'))
  switch (sessionUpdate) {
    case 'user_message_chunk':
      return [{ kind: 'prompt_submitted' }]
    case 'agent_thought_chunk':
    case 'agent_message_chunk':
    case 'tool_call_update':
    case 'tool_result_update':
      return [{ kind: 'activity' }]
    case 'hook_execution':
      return await grokHookEvents(update, payload)
    default:
      return []
  }
}

export function classifyGrokIdleTranscript(
  records: unknown[],
): { kind: 'done' | 'question' | 'approval'; summary?: string } | undefined {
  for (let i = records.length - 1; i >= 0; i--) {
    const record = records[i]
    if (!isRecord(record) || record.type !== 'assistant') continue
    const text =
      grokContentText(record.content) || grokContentText(recordField(record, 'message')?.content)
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

export async function findLatestGrokSessionPaths(opts: {
  cwd: string
  homeDir?: string
  sinceMs?: number
}): Promise<GrokSessionPaths | undefined> {
  const workspaceDir = join(grokRoot(opts.homeDir), 'sessions', encodeURIComponent(opts.cwd))
  let entries: Dirent<string>[]
  try {
    entries = await readdir(workspaceDir, { withFileTypes: true })
  } catch {
    return undefined
  }

  const candidates: { paths: GrokSessionPaths; mtimeMs: number }[] = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const paths = grokSessionPaths({ cwd: opts.cwd, sessionId: entry.name, homeDir: opts.homeDir })
    try {
      const info = await stat(paths.summaryPath)
      if (opts.sinceMs !== undefined && info.mtimeMs < opts.sinceMs - FRESH_SESSION_MARGIN_MS) {
        continue
      }
      candidates.push({ paths, mtimeMs: info.mtimeMs })
    } catch {
      // Directory exists before summary.json is committed. Try again on the next poll.
    }
  }

  candidates.sort((left, right) => right.mtimeMs - left.mtimeMs)
  return candidates[0]?.paths
}

export function observeGrokState(opts: {
  cwd: string
  resumeValue?: string
  homeDir?: string
  startedAtMs?: number
  pollMs?: number
  onSession?: (sessionId: string) => void
  onEvents: (events: AgentStateEvent[]) => void
}): GrokStateObserver {
  const pollMs = opts.pollMs ?? POLL_MS
  const startedAtMs = opts.startedAtMs ?? Date.now()
  let stopped = false
  let attached: GrokSessionPaths | undefined
  let updateTail: GrokStateObserver | undefined

  const attach = (paths: GrokSessionPaths): void => {
    if (attached?.sessionId === paths.sessionId) return
    updateTail?.stop()
    attached = paths
    opts.onSession?.(paths.sessionId)
    updateTail = tailGrokUpdates(paths, opts.onEvents, { pollMs })
  }

  const discover = async (): Promise<void> => {
    if (stopped || attached) return
    const paths = await findLatestGrokSessionPaths({
      cwd: opts.cwd,
      ...(opts.homeDir ? { homeDir: opts.homeDir } : {}),
      sinceMs: startedAtMs,
    })
    if (paths && !stopped) attach(paths)
  }

  let discoverTimer: ReturnType<typeof setInterval> | undefined
  if (opts.resumeValue) {
    attach(grokSessionPaths({ cwd: opts.cwd, sessionId: opts.resumeValue, homeDir: opts.homeDir }))
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

async function grokBootEvents(opts: {
  cwd: string
  resumeValue?: string
  homeDir?: string
}): Promise<AgentStateEvent[]> {
  if (opts.resumeValue) {
    const paths = grokSessionPaths({
      cwd: opts.cwd,
      sessionId: opts.resumeValue,
      ...(opts.homeDir ? { homeDir: opts.homeDir } : {}),
    })
    try {
      const verdict = classifyGrokIdleTranscript(
        await readGrokChatHistoryTail(paths.chatHistoryPath),
      )
      if (verdict) return [{ kind: 'turn_completed', verdict }]
    } catch {
      // Missing/unreadable chat history falls back to a bare boot event.
    }
  }
  return [{ kind: 'session_started' }]
}

async function grokHookEvents(
  update: Record<string, unknown>,
  payload: Record<string, unknown>,
): Promise<AgentStateEvent[]> {
  switch (
    normalizeName(stringField(update, 'event_name') ?? stringField(update, 'hook_event_name'))
  ) {
    case 'session_start':
      return [{ kind: 'session_started' }]
    case 'user_prompt_submit':
      return [{ kind: 'prompt_submitted' }]
    case 'pre_tool_use':
    case 'post_tool_use':
      return [{ kind: 'activity' }]
    case 'stop': {
      const verdict = await classifyStopPayload(payload)
      return [{ kind: 'turn_completed', ...(verdict ? { verdict } : {}) }]
    }
    case 'stop_failure': {
      const errorClass =
        stringField(update, 'error_type') ?? stringField(update, 'errorType') ?? 'unknown'
      return [{ kind: 'turn_failed', errorClass, retryable: RETRYABLE.has(errorClass) }]
    }
    case 'pre_compact':
      return [{ kind: 'compaction', phase: 'start' }]
    case 'post_compact':
      return [{ kind: 'compaction', phase: 'end' }]
    case 'task_created':
      return [{ kind: 'task_delta', delta: 1 }]
    case 'task_completed':
      return [{ kind: 'task_delta', delta: -1 }]
    case 'session_end':
      return [{ kind: 'session_ended' }]
    default:
      return []
  }
}

function tailGrokUpdates(
  paths: GrokSessionPaths,
  onEvents: (events: AgentStateEvent[]) => void,
  opts: { pollMs?: number } = {},
): GrokStateObserver {
  let offset = 0
  const decoder = new LineDecoder()
  let first = true
  let dropLeadingPartial = false
  let stopped = false
  let reading = false
  let observedWork = false

  const readNew = async (): Promise<void> => {
    if (reading || stopped) return
    reading = true
    try {
      const handle = await open(paths.updatesPath, 'r')
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
            const payload = isRecord(record)
              ? { ...record, chat_history_path: paths.chatHistoryPath }
              : record
            const next = await translateGrokUpdatePayload(payload)
            if (isAvailableCommandsUpdate(payload) && observedWork) {
              next.push({ kind: 'turn_completed' })
            }
            for (const event of next) {
              observedWork = updateObservedWork(observedWork, event)
              events.push(event)
            }
          } catch {
            // Torn writes or unexpected records are ignored; the next poll catches up.
          }
        }
        if (events.length > 0) onEvents(events)
      } finally {
        await handle.close()
      }
    } catch {
      // File may not exist until Grok finishes session initialization.
    } finally {
      reading = false
    }
  }

  const timer = setInterval(() => void readNew(), opts.pollMs ?? POLL_MS)
  timer.unref?.()
  void readNew()

  return {
    path: paths.updatesPath,
    stop() {
      stopped = true
      clearInterval(timer)
    },
  }
}

function isAvailableCommandsUpdate(payload: unknown): boolean {
  if (!isRecord(payload)) return false
  const params = recordField(payload, 'params')
  const update = recordField(params, 'update')
  return normalizeName(stringField(update, 'sessionUpdate')) === 'available_commands_update'
}

function updateObservedWork(current: boolean, event: AgentStateEvent): boolean {
  switch (event.kind) {
    case 'prompt_submitted':
    case 'activity':
      return true
    case 'compaction':
      return event.phase === 'start' ? true : current
    case 'turn_completed':
    case 'turn_failed':
    case 'needs_user':
    case 'session_ended':
    case 'session_started':
      return false
    case 'task_delta':
      return current
  }
}

async function classifyStopPayload(
  payload: Record<string, unknown>,
): Promise<{ kind: 'done' | 'question' | 'approval'; summary?: string } | undefined> {
  const path = stringField(payload, 'chat_history_path')
  if (!path) return undefined
  try {
    return classifyGrokIdleTranscript(await readGrokChatHistoryTail(path))
  } catch {
    return undefined
  }
}

async function readGrokChatHistoryTail(path: string): Promise<unknown[]> {
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

function grokRoot(homeDir: string | undefined): string {
  if (homeDir) return join(homeDir, '.grok')
  return process.env.GROK_HOME || join(homedir(), '.grok')
}

function grokContentText(content: unknown): string {
  if (typeof content === 'string') return content.trim()
  if (!Array.isArray(content)) return ''
  return content
    .map((block) => {
      if (typeof block === 'string') return block
      if (isRecord(block) && typeof block.text === 'string') return block.text
      return ''
    })
    .filter(Boolean)
    .join('\n')
    .trim()
}

function normalizeName(value: string | undefined): string | undefined {
  return value
    ?.replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/-/g, '_')
    .toLowerCase()
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

const RETRYABLE = new Set([
  'rate_limit',
  'overloaded',
  'server_error',
  'max_output_tokens',
  'unknown',
])

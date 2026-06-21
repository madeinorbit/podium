import type { TranscriptItem } from '@podium/protocol'
import { withEventTime } from './reducer.js'
import type { AgentStateEvent, AgentStateProvider } from './types.js'

/** An opencode row's `time_updated` (epoch ms) as ISO event-time, or undefined. */
function isoFromMs(ms: number | undefined): string | undefined {
  return typeof ms === 'number' && ms > 0 ? new Date(ms).toISOString() : undefined
}

type OpencodeDbModule = typeof import('../opencode/db.js')
type OpencodeTranscriptModule = typeof import('../transcript/opencode.js')
type OpencodeRuntime = OpencodeDbModule & OpencodeTranscriptModule
type OpencodeSessionRow = import('../opencode/db.js').OpencodeSessionRow
type OpencodeDb = ReturnType<OpencodeDbModule['openOpencodeDb']>

const POLL_MS = 700
const FRESH_SESSION_MARGIN_MS = 5_000

let runtimePromise: Promise<OpencodeRuntime> | undefined

async function loadOpencodeRuntime(): Promise<OpencodeRuntime> {
  runtimePromise ??= Promise.all([
    import('../opencode/db.js'),
    import('../transcript/opencode.js'),
  ]).then(([db, transcript]) => ({ ...db, ...transcript }) as OpencodeRuntime)
  return runtimePromise
}

async function maybeLoadOpencodeRuntime(): Promise<OpencodeRuntime | undefined> {
  try {
    return await loadOpencodeRuntime()
  } catch {
    runtimePromise = undefined
    return undefined
  }
}

export interface OpencodeStateObserver {
  readonly sessionId: string | undefined
  stop(): void
}

export const opencodeStateProvider: AgentStateProvider = {
  instrumentation() {
    return { args: [] }
  },
  translate: async () => [],
  bootEvents: opencodeBootEvents,
}

export function observeOpencodeState(opts: {
  cwd: string
  resumeValue?: string
  homeDir?: string
  startedAtMs?: number
  pollMs?: number
  onSession?: (sessionId: string) => void
  onEvents: (events: AgentStateEvent[]) => void
  onTranscriptItems?: (items: TranscriptItem[], reset: boolean) => void
}): OpencodeStateObserver {
  const pollMs = opts.pollMs ?? POLL_MS
  const startedAtMs = opts.startedAtMs ?? Date.now()
  let stopped = false
  let attached: OpencodeSessionRow | undefined
  let lastPartTime = 0
  let lastCompacting: number | null | undefined
  let firstTranscript = true

  // A single opencode DB handle reused across every ~700ms poll tick (was opened
  // and closed per tick, per call). A `readOnly` SQLite handle re-reads the latest
  // committed snapshot on each query, so reuse stays correct under live writes. Any
  // query error drops the handle (via `dropDb`) so the next call reopens — a broken
  // handle is never reused. Closed once in `stop()`.
  let db: OpencodeDb | undefined
  const getDb = (rt: OpencodeRuntime): OpencodeDb => {
    db ??= rt.openOpencodeDb(opts.homeDir)
    return db
  }
  const dropDb = (): void => {
    try {
      db?.close()
    } catch {
      // already closed / errored — discard the reference either way
    }
    db = undefined
  }

  // Last DB mtime the hot poll path observed. The opencode DB is WAL-mode, so
  // `opencodeDbMtimeMs` watches the `.db` + its `-wal`/`-shm` sidecars: when none
  // advanced since the last tick the per-tick queries are skipped (the cached state
  // is unchanged). `undefined` (a stat failure) is treated as "unknown" — we never
  // skip on uncertainty, so a fresh read always runs.
  let lastPollMtimeMs: number | undefined

  const attach = (session: OpencodeSessionRow): void => {
    if (attached?.id === session.id) return
    attached = session
    lastPartTime = 0
    lastCompacting = session.timeCompacting
    firstTranscript = true
    // Force the next poll tick to read regardless of the mtime gate, so a freshly
    // attached session isn't skipped on a coincidentally-equal mtime.
    lastPollMtimeMs = undefined
    opts.onSession?.(session.id)
    void emitTranscript(true)
  }

  const discover = async (): Promise<void> => {
    if (stopped || attached) return
    const rt = await maybeLoadOpencodeRuntime()
    if (!rt || stopped || attached) return
    const handle = getDb(rt)
    if (!handle) return
    try {
      const session = rt.findLatestOpencodeSession(
        handle,
        opts.cwd,
        startedAtMs - FRESH_SESSION_MARGIN_MS,
      )
      if (session && !stopped) attach(session)
    } catch {
      dropDb()
    }
  }

  const emitTranscript = async (reset = false): Promise<void> => {
    if (!attached || !opts.onTranscriptItems) return
    const rt = await maybeLoadOpencodeRuntime()
    if (!rt || !attached) return
    const handle = getDb(rt)
    if (!handle) return
    try {
      const rows = firstTranscript
        ? rt.loadOpencodeTranscriptTail(handle, attached.id)
        : rt.loadOpencodeMessageParts(handle, attached.id, lastPartTime)
      if (rows.length === 0) return
      lastPartTime = Math.max(lastPartTime, ...rows.map((r) => r.timeUpdated))
      const items = rt.opencodeRowsToItems(rows)
      if (items.length > 0) {
        opts.onTranscriptItems(items, reset || firstTranscript)
        firstTranscript = false
      }
    } catch {
      dropDb()
    }
  }

  const tick = async (): Promise<void> => {
    if (stopped || !attached) return
    const rt = await maybeLoadOpencodeRuntime()
    if (!rt || stopped || !attached) return
    const handle = getDb(rt)
    if (!handle) return
    try {
      const session = rt.getOpencodeSession(handle, attached.id)
      if (!session) return
      const events: AgentStateEvent[] = []
      if (session.timeCompacting && session.timeCompacting !== lastCompacting) {
        events.push(
          ...withEventTime(
            [{ kind: 'compaction', phase: 'start' }],
            isoFromMs(session.timeCompacting),
          ),
        )
      } else if (!session.timeCompacting && lastCompacting) {
        events.push({ kind: 'compaction', phase: 'end' })
      }
      lastCompacting = session.timeCompacting

      const rows = rt.loadOpencodeMessageParts(handle, attached.id, lastPartTime)
      if (rows.length > 0) {
        lastPartTime = Math.max(lastPartTime, ...rows.map((r) => r.timeUpdated))
        for (const row of rows) {
          const messageInfo = parseJson(row.messageData)
          const part = parseJson(row.partData)
          const role = messageInfo ? stringField(messageInfo, 'role') : undefined
          const partType = part ? stringField(part, 'type') : undefined
          // The row's time_updated is the event-time. opencode replays the whole
          // history on attach (lastPartTime starts at 0), so stamping keeps that
          // replay from restamping recency to "now".
          const at = isoFromMs(row.timeUpdated)
          const rowEvents: AgentStateEvent[] = []
          if (role === 'user' && partType === 'text') rowEvents.push({ kind: 'prompt_submitted' })
          else if (partType === 'text' || partType === 'tool') rowEvents.push({ kind: 'activity' })
          else if (partType === 'step-finish') {
            rowEvents.push({
              kind: 'turn_completed',
              verdict: rt.classifyOpencodeIdleText(lastAssistantText(rt, handle, attached.id)?.text),
            })
          }
          events.push(...withEventTime(rowEvents, at))
        }
        if (opts.onTranscriptItems) {
          const items = rows.flatMap((row) => rt.opencodePartToItems(row))
          if (items.length > 0) opts.onTranscriptItems(items, false)
        }
      }
      if (events.length > 0) opts.onEvents(events)
    } catch {
      dropDb()
    }
  }

  // The hot path: run the two per-tick reads only when the DB (or its WAL sidecars)
  // changed since the last tick. An unknown mtime (stat failed) reads anyway.
  const pollOnce = async (): Promise<void> => {
    if (stopped || !attached) return
    const rt = await maybeLoadOpencodeRuntime()
    if (!rt || stopped || !attached) return
    const mtimeMs = rt.opencodeDbMtimeMs(opts.homeDir)
    if (mtimeMs !== undefined && mtimeMs === lastPollMtimeMs) return
    lastPollMtimeMs = mtimeMs
    await emitTranscript(false)
    await tick()
  }

  if (opts.resumeValue) {
    void (async () => {
      const rt = await maybeLoadOpencodeRuntime()
      if (!rt || stopped) return
      const handle = getDb(rt)
      if (!handle) return
      try {
        const session = rt.getOpencodeSession(handle, opts.resumeValue ?? '')
        if (session && !stopped) attach(session)
      } catch {
        dropDb()
      }
    })()
  }

  const discoverTimer = opts.resumeValue ? undefined : setInterval(() => void discover(), pollMs)
  discoverTimer?.unref?.()
  if (!opts.resumeValue) void discover()

  const pollTimer = setInterval(() => void pollOnce(), pollMs)
  pollTimer.unref?.()

  return {
    get sessionId() {
      return attached?.id
    },
    stop() {
      stopped = true
      if (discoverTimer) clearInterval(discoverTimer)
      clearInterval(pollTimer)
      dropDb()
    },
  }
}

async function opencodeBootEvents(opts: {
  cwd: string
  resumeValue?: string
  homeDir?: string
}): Promise<AgentStateEvent[]> {
  const rt = await maybeLoadOpencodeRuntime()
  if (!rt) return [{ kind: 'session_started' }]
  const db = rt.openOpencodeDb(opts.homeDir)
  if (!db) return [{ kind: 'session_started' }]
  try {
    const sessionId = opts.resumeValue
    if (!sessionId) return [{ kind: 'session_started' }]
    const last = lastAssistantText(rt, db, sessionId)
    if (last) {
      // Stamp the assistant row's time_updated so re-seeding this idle session on
      // reattach restores its real last-active time, not the reattach moment.
      const at = isoFromMs(last.timeUpdated)
      return [
        {
          kind: 'turn_completed',
          verdict: rt.classifyOpencodeIdleText(last.text),
          ...(at ? { at } : {}),
        },
      ]
    }
    return [{ kind: 'session_started' }]
  } finally {
    db.close()
  }
}

function lastAssistantText(
  rt: OpencodeRuntime,
  db: OpencodeDb,
  sessionId: string,
): { text: string; timeUpdated: number } | undefined {
  if (!db) return undefined
  const rows = rt.loadOpencodeTranscriptTail(db, sessionId, 200)
  for (let i = rows.length - 1; i >= 0; i--) {
    const row = rows[i]
    if (!row) continue
    const messageInfo = parseJson(row.messageData)
    const part = parseJson(row.partData)
    if (stringField(messageInfo ?? {}, 'role') !== 'assistant') continue
    if (stringField(part ?? {}, 'type') !== 'text') continue
    const text = stringField(part ?? {}, 'text')
    if (text) return { text, timeUpdated: row.timeUpdated }
  }
  return undefined
}

function parseJson(raw: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(raw)
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined
  } catch {
    return undefined
  }
}

function stringField(v: Record<string, unknown>, key: string): string | undefined {
  const field = v[key]
  return typeof field === 'string' && field.length > 0 ? field : undefined
}

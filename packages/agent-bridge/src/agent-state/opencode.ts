import type { TranscriptItem } from '@podium/protocol'
import type { AgentStateEvent, AgentStateProvider } from './types.js'

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

  const attach = (session: OpencodeSessionRow): void => {
    if (attached?.id === session.id) return
    attached = session
    lastPartTime = 0
    lastCompacting = session.timeCompacting
    firstTranscript = true
    opts.onSession?.(session.id)
    void emitTranscript(true)
  }

  const discover = async (): Promise<void> => {
    if (stopped || attached) return
    const rt = await maybeLoadOpencodeRuntime()
    if (!rt || stopped || attached) return
    const db = rt.openOpencodeDb(opts.homeDir)
    if (!db) return
    try {
      const session = rt.findLatestOpencodeSession(
        db,
        opts.cwd,
        startedAtMs - FRESH_SESSION_MARGIN_MS,
      )
      if (session && !stopped) attach(session)
    } finally {
      db.close()
    }
  }

  const emitTranscript = async (reset = false): Promise<void> => {
    if (!attached || !opts.onTranscriptItems) return
    const rt = await maybeLoadOpencodeRuntime()
    if (!rt || !attached) return
    const db = rt.openOpencodeDb(opts.homeDir)
    if (!db) return
    try {
      const rows = firstTranscript
        ? rt.loadOpencodeTranscriptTail(db, attached.id)
        : rt.loadOpencodeMessageParts(db, attached.id, lastPartTime)
      if (rows.length === 0) return
      lastPartTime = Math.max(lastPartTime, ...rows.map((r) => r.timeUpdated))
      const items = rt.opencodeRowsToItems(rows)
      if (items.length > 0) {
        opts.onTranscriptItems(items, reset || firstTranscript)
        firstTranscript = false
      }
    } finally {
      db.close()
    }
  }

  const tick = async (): Promise<void> => {
    if (stopped || !attached) return
    const rt = await maybeLoadOpencodeRuntime()
    if (!rt || stopped || !attached) return
    const db = rt.openOpencodeDb(opts.homeDir)
    if (!db) return
    try {
      const session = rt.getOpencodeSession(db, attached.id)
      if (!session) return
      const events: AgentStateEvent[] = []
      if (session.timeCompacting && session.timeCompacting !== lastCompacting) {
        events.push({ kind: 'compaction', phase: 'start' })
      } else if (!session.timeCompacting && lastCompacting) {
        events.push({ kind: 'compaction', phase: 'end' })
      }
      lastCompacting = session.timeCompacting

      const rows = rt.loadOpencodeMessageParts(db, attached.id, lastPartTime)
      if (rows.length > 0) {
        lastPartTime = Math.max(lastPartTime, ...rows.map((r) => r.timeUpdated))
        for (const row of rows) {
          const messageInfo = parseJson(row.messageData)
          const part = parseJson(row.partData)
          const role = messageInfo ? stringField(messageInfo, 'role') : undefined
          const partType = part ? stringField(part, 'type') : undefined
          if (role === 'user' && partType === 'text') events.push({ kind: 'prompt_submitted' })
          else if (partType === 'text' || partType === 'tool') events.push({ kind: 'activity' })
          else if (partType === 'step-finish') {
            const text = lastAssistantText(rt, db, attached.id)
            events.push({
              kind: 'turn_completed',
              verdict: rt.classifyOpencodeIdleText(text),
            })
          }
        }
        if (opts.onTranscriptItems) {
          const items = rows.flatMap((row) => rt.opencodePartToItems(row))
          if (items.length > 0) opts.onTranscriptItems(items, false)
        }
      }
      if (events.length > 0) opts.onEvents(events)
    } finally {
      db.close()
    }
  }

  if (opts.resumeValue) {
    void (async () => {
      const rt = await maybeLoadOpencodeRuntime()
      if (!rt || stopped) return
      const db = rt.openOpencodeDb(opts.homeDir)
      if (!db) return
      try {
        const session = rt.getOpencodeSession(db, opts.resumeValue ?? '')
        if (session && !stopped) attach(session)
      } finally {
        db.close()
      }
    })()
  }

  const discoverTimer = opts.resumeValue ? undefined : setInterval(() => void discover(), pollMs)
  discoverTimer?.unref?.()
  if (!opts.resumeValue) void discover()

  const pollTimer = setInterval(() => {
    void emitTranscript(false)
    void tick()
  }, pollMs)
  pollTimer.unref?.()

  return {
    get sessionId() {
      return attached?.id
    },
    stop() {
      stopped = true
      if (discoverTimer) clearInterval(discoverTimer)
      clearInterval(pollTimer)
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
    const text = lastAssistantText(rt, db, sessionId)
    if (text) return [{ kind: 'turn_completed', verdict: rt.classifyOpencodeIdleText(text) }]
    return [{ kind: 'session_started' }]
  } finally {
    db.close()
  }
}

function lastAssistantText(
  rt: OpencodeRuntime,
  db: OpencodeDb,
  sessionId: string,
): string | undefined {
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
    if (text) return text
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

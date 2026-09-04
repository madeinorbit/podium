import type { TranscriptItem } from '@podium/model'
import { type StatTick, scheduleStatPoll } from '@podium/transcript'
import { withEventTime } from './reducer.js'
import { type AgentStateEvent, type AgentStateProvider, withStateChannel } from './types.js'

/** An opencode row's `time_updated` (epoch ms) as ISO event-time, or undefined. */
function isoFromMs(ms: number | undefined): string | undefined {
  return typeof ms === 'number' && ms > 0 ? new Date(ms).toISOString() : undefined
}

type OpencodeDbModule = typeof import('../opencode/db.js')
type OpencodeTranscriptModule = typeof import('@podium/transcript')
// The cursor-stamping helper lives in the source layer (shared with the on-demand
// read path) so live deltas and reads carry IDENTICAL cursors; lazy-load it the
// same way so observing opencode state stays optional (no eager SQLite import).
type OpencodeSourceModule = Pick<typeof import('@podium/transcript'), 'stampOpencodeItems'>
type OpencodeRuntime = OpencodeDbModule & OpencodeTranscriptModule & OpencodeSourceModule
type OpencodeSessionRow = import('../opencode/db.js').OpencodeSessionRow
type OpencodeDb = ReturnType<OpencodeDbModule['openOpencodeDb']>

const POLL_MS = 700
const FRESH_SESSION_MARGIN_MS = 5_000

let runtimePromise: Promise<OpencodeRuntime> | undefined

async function loadOpencodeRuntime(): Promise<OpencodeRuntime> {
  runtimePromise ??= Promise.all([
    import('../opencode/db.js'),
    import('@podium/transcript'),
    import('@podium/transcript'),
  ]).then(([db, transcript, source]) => ({ ...db, ...transcript, ...source }) as OpencodeRuntime)
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
  /** UNBRANDED BY DECISION: a provider/harness-native session id, not a Podium SessionId. */
  readonly sessionId: string | undefined
  stop(): void
}

export const opencodeStateProvider: AgentStateProvider = {
  instrumentation() {
    return { args: [] }
  },
  translate: async () => withStateChannel([], 'poll'),
  bootEvents: async (opts) => withStateChannel(await opencodeBootEvents(opts), 'poll'),
}

export function observeOpencodeState(opts: {
  cwd: string
  /** Stable Podium row identity; used to select a session-owned store. */
  podiumSessionId?: string
  resumeValue?: string
  homeDir?: string
  /** Explicit store path for tests/embedders that already selected one. */
  databasePath?: string
  startedAtMs?: number
  pollMs?: number
  statTick?: StatTick
  /** UNBRANDED BY DECISION: a provider/harness-native session id, not a Podium SessionId. */
  onSession?: (sessionId: string) => void
  onModel?: (model: string, effort?: string) => void
  onEvents: (events: AgentStateEvent[]) => void
  onTranscriptItems?: (items: TranscriptItem[], reset: boolean) => void
}): OpencodeStateObserver {
  const pollMs = opts.pollMs ?? POLL_MS
  const startedAtMs = opts.startedAtMs ?? Date.now()
  let stopped = false
  let attached: OpencodeSessionRow | undefined
  let lastPartTime = 0
  let lastPartId: string | undefined
  let lastCompacting: number | null | undefined
  let lastObservedModel: string | undefined
  let lastObservedEffort: string | undefined
  let firstTranscript = true
  let identityFailureReported = false
  const completedAbortedMessageIds = new Set<string>()
  const emittedInterruptMarkerIds = new Set<string>()
  let turnAwaitingTerminal = false

  // A single opencode DB handle reused across every ~700ms poll tick (was opened
  // and closed per tick, per call). A `readOnly` SQLite handle re-reads the latest
  // committed snapshot on each query, so reuse stays correct under live writes. Any
  // query error drops the handle (via `dropDb`) so the next call reopens — a broken
  // handle is never reused. Closed once in `stop()`.
  let db: OpencodeDb | undefined
  const databasePathFor = (rt: OpencodeRuntime): string | undefined =>
    opts.databasePath ??
    rt.opencodeDbPathForSession({
      homeDir: opts.homeDir,
      podiumSessionId: opts.podiumSessionId,
      resumeValue: opts.resumeValue,
    })
  const getDb = (rt: OpencodeRuntime): OpencodeDb => {
    db ??= rt.openOpencodeDb(opts.homeDir, databasePathFor(rt))
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
    lastPartId = undefined
    lastCompacting = session.timeCompacting
    lastObservedModel = undefined
    lastObservedEffort = undefined
    firstTranscript = true
    completedAbortedMessageIds.clear()
    emittedInterruptMarkerIds.clear()
    turnAwaitingTerminal = false
    // Force the next poll tick to read regardless of the mtime gate, so a freshly
    // attached session isn't skipped on a coincidentally-equal mtime.
    lastPollMtimeMs = undefined
    opts.onSession?.(session.id)
    const observed = parseOpencodeModel(session.model)
    if (observed.model) {
      lastObservedModel = observed.model
      lastObservedEffort = observed.effort
      opts.onModel?.(observed.model, observed.effort)
    }
  }

  const discover = async (): Promise<void> => {
    if (stopped || attached) return
    const rt = await maybeLoadOpencodeRuntime()
    if (!rt || stopped || attached) return
    const handle = getDb(rt)
    if (!handle) return
    try {
      const candidates = rt.findOpencodeSessions(
        handle,
        opts.cwd,
        startedAtMs - FRESH_SESSION_MARGIN_MS,
      )
      if (candidates.length === 0) return
      const databasePath = databasePathFor(rt)
      if (!databasePath) {
        if (!identityFailureReported) {
          identityFailureReported = true
          opts.onEvents([
            {
              kind: 'turn_failed',
              errorClass: 'transcript_identity_unavailable',
              retryable: false,
              detail:
                'OpenCode transcript withheld: no session-specific store was selected; refusing cwd-based discovery.',
            },
          ])
        }
        return
      }
      const session = candidates[0]
      if (session && !stopped) attach(session)
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
      const observed = parseOpencodeModel(session.model)
      if (
        observed.model &&
        (observed.model !== lastObservedModel || observed.effort !== lastObservedEffort)
      ) {
        lastObservedModel = observed.model
        lastObservedEffort = observed.effort
        opts.onModel?.(observed.model, observed.effort)
      }
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

      const rows = firstTranscript
        ? rt.loadOpencodeTranscriptTail(handle, attached.id)
        : rt.loadOpencodeMessageParts(handle, attached.id, lastPartTime, lastPartId)
      if (rows.length > 0) {
        let resetForAbortedMessage = false
        const last = rows.at(-1)
        if (last) {
          lastPartTime = last.timeUpdated
          lastPartId = last.partId
        }
        for (const row of rows) {
          if (row.timeUpdated < startedAtMs) continue
          const messageInfo = parseJson(row.messageData)
          const part = parseJson(row.partData)
          const role = messageInfo ? stringField(messageInfo, 'role') : undefined
          const partType = part ? stringField(part, 'type') : undefined
          // The row's time_updated is the event-time. opencode replays the whole
          // history on attach (lastPartTime starts at 0), so stamping keeps that
          // replay from restamping recency to "now".
          const at = isoFromMs(row.timeUpdated)
          const rowEvents: AgentStateEvent[] = []
          const aborted = messageInfo ? rt.isOpencodeMessageAborted(messageInfo) : false
          if (aborted) {
            // The synthetic row confirms the verdict. Every ordinary row still repeats
            // the aborted envelope and must remain silent even when it arrives later.
            if (partType === 'interrupt' && !completedAbortedMessageIds.has(row.messageId)) {
              completedAbortedMessageIds.add(row.messageId)
              resetForAbortedMessage = true
              turnAwaitingTerminal = false
              rowEvents.push({ kind: 'turn_completed', verdict: { kind: 'interrupted' } })
            }
          } else if (role === 'user' && partType === 'text') {
            turnAwaitingTerminal = true
            rowEvents.push({ kind: 'prompt_submitted' })
          } else if (partType === 'text' || partType === 'tool')
            rowEvents.push({ kind: 'activity' })
          else if (partType === 'step-finish') {
            turnAwaitingTerminal = false
            rowEvents.push({
              kind: 'turn_completed',
              verdict: rt.classifyOpencodeIdleText(
                lastAssistantText(rt, handle, attached.id)?.text,
              ),
            })
          }
          events.push(...withEventTime(rowEvents, at))
        }
        if (opts.onTranscriptItems) {
          // An abort changes the meaning of every row in its assistant message.
          // Rebuild from the durable tail once so text already rendered before
          // the error envelope arrived is removed, while the stable provider
          // marker remains the sole visible interruption record.
          const transcriptRows = resetForAbortedMessage
            ? rt.loadOpencodeTranscriptTail(handle, attached.id)
            : rows
          const transcriptReset = resetForAbortedMessage || firstTranscript
          const items = rt
            .stampOpencodeItems(transcriptRows, attached.id)
            .filter(
              (item) =>
                transcriptReset ||
                item.event !== 'interrupt' ||
                !emittedInterruptMarkerIds.has(item.id),
            )
          for (const item of items) {
            if (item.event === 'interrupt') emittedInterruptMarkerIds.add(item.id)
          }
          if (items.length > 0 || transcriptReset) opts.onTranscriptItems(items, transcriptReset)
        }
        firstTranscript = false
      }
      if (events.length > 0) opts.onEvents(events)
    } catch {
      dropDb()
    }
  }

  // The hot path: run the per-tick read only when the DB (or its WAL sidecars)
  // changed since the last tick. An unknown mtime (stat failed) reads anyway.
  //
  // ONE READER PER CURSOR (POD-2801). The first tick reads one bounded tail;
  // later ticks read cursor deltas. Rows older than this observation are sent
  // only to the transcript plane, while rows at or after startedAtMs drive both
  // transcript and state. A freshly minted resume id therefore cannot make an
  // initial-tail reader consume the first live turn before the state reader.
  //
  // An open turn overrides the mtime gate. OpenCode can commit step-finish less
  // than one filesystem timestamp tick after its text row. Equality then is not
  // proof that the provider store is unchanged: skipping forever strands the
  // causal turn at activity. A durable user row opens this confirmation loop;
  // the provider step-finish or abort row closes it. Idle sessions keep the gate.
  const pollOnce = async (): Promise<void> => {
    if (stopped || !attached) return
    const rt = await maybeLoadOpencodeRuntime()
    if (!rt || stopped || !attached) return
    const mtimeMs = rt.opencodeDbMtimeMs(opts.homeDir, databasePathFor(rt))
    if (mtimeMs !== undefined && mtimeMs === lastPollMtimeMs && !turnAwaitingTerminal) return
    lastPollMtimeMs = mtimeMs
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

  const stopDiscovery = opts.resumeValue
    ? undefined
    : scheduleStatPoll(() => void discover(), {
        statTick: opts.statTick,
        pollMs,
      })
  if (!opts.resumeValue) void discover()

  const stopPolling = scheduleStatPoll(() => void pollOnce(), {
    statTick: opts.statTick,
    pollMs,
  })

  return {
    get sessionId() {
      return attached?.id
    },
    stop() {
      stopped = true
      stopDiscovery?.()
      stopPolling()
      dropDb()
    },
  }
}

async function opencodeBootEvents(opts: {
  cwd: string
  podiumSessionId?: string
  resumeValue?: string
  homeDir?: string
  databasePath?: string
}): Promise<AgentStateEvent[]> {
  const rt = await maybeLoadOpencodeRuntime()
  if (!rt) return [{ kind: 'session_started' }]
  const databasePath =
    opts.databasePath ??
    rt.opencodeDbPathForSession({
      homeDir: opts.homeDir,
      podiumSessionId: opts.podiumSessionId,
      resumeValue: opts.resumeValue,
    })
  const db = rt.openOpencodeDb(opts.homeDir, databasePath)
  if (!db) return [{ kind: 'session_started' }]
  try {
    const sessionId = opts.resumeValue
    if (!sessionId) return [{ kind: 'session_started' }]
    const last = lastAssistantCompletion(rt, db, sessionId)
    if (last) {
      // Stamp the assistant row's time_updated so re-seeding this idle session on
      // reattach restores its real last-active time, not the reattach moment.
      const at = isoFromMs(last.timeUpdated)
      return [
        {
          kind: 'turn_completed',
          verdict: last.interrupted
            ? { kind: 'interrupted' }
            : rt.classifyOpencodeIdleText(last.text),
          ...(at ? { at } : {}),
        },
      ]
    }
    return [{ kind: 'session_started' }]
  } finally {
    db.close()
  }
}

function lastAssistantCompletion(
  rt: OpencodeRuntime,
  db: OpencodeDb,
  sessionId: string,
): { text?: string; timeUpdated: number; interrupted: boolean } | undefined {
  if (!db) return undefined
  const rows = rt.loadOpencodeTranscriptTail(db, sessionId, 200)
  let latestMessageId: string | undefined
  let latestTimeUpdated = 0
  let latestInterrupted = false
  for (let i = rows.length - 1; i >= 0; i--) {
    const row = rows[i]
    if (!row) continue
    const messageInfo = parseJson(row.messageData)
    if (stringField(messageInfo ?? {}, 'role') !== 'assistant') continue
    latestMessageId ??= row.messageId
    if (row.messageId !== latestMessageId) break
    latestTimeUpdated = Math.max(latestTimeUpdated, row.timeUpdated)
    latestInterrupted ||= messageInfo ? rt.isOpencodeMessageAborted(messageInfo) : false
    const part = parseJson(row.partData)
    if (stringField(part ?? {}, 'type') !== 'text') continue
    const text = stringField(part ?? {}, 'text')
    if (text) return { text, timeUpdated: latestTimeUpdated, interrupted: latestInterrupted }
  }
  return latestMessageId
    ? { timeUpdated: latestTimeUpdated, interrupted: latestInterrupted }
    : undefined
}

function lastAssistantText(
  rt: OpencodeRuntime,
  db: OpencodeDb,
  /** UNBRANDED BY DECISION: a provider/harness-native session id, not a Podium SessionId. */
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

function parseOpencodeModel(raw: string | null | undefined): {
  model?: string
  effort?: string
} {
  if (!raw) return {}
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    return {}
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {}
  const record = value as Record<string, unknown>
  const id = typeof record.id === 'string' && record.id.trim() ? record.id.trim() : undefined
  const provider =
    typeof record.providerID === 'string' && record.providerID.trim()
      ? record.providerID.trim()
      : undefined
  const model = id ? (id.includes('/') || !provider ? id : provider + '/' + id) : undefined
  const effort =
    typeof record.variant === 'string' && record.variant.trim() ? record.variant.trim() : undefined
  return { ...(model ? { model } : {}), ...(effort ? { effort } : {}) }
}

/**
 * Client switch-latency collector [POD-701]: one correlated ClientSwitchTrace
 * per user gesture that switches the focused session, showing where the time
 * went until the view became interactable (chat typeable/scrollable / terminal keystroke-ready).
 *
 * Always-on and inert-cheap: when no trace is active every mark() call is a
 * single null check. At most ONE trace is in flight at a time — a new gesture
 * finalizes (as timed out) whatever hadn't quiesced yet.
 *
 * Terminal lifecycle events are not re-instrumented here: the collector taps
 * the existing terminal-diagnostics ring (via the `__podiumTerminalDiagnostics`
 * global its module registers) and forwards the traced session's events as
 * `term:<event>` marks.
 */

import type { IssueId, SessionId } from '@podium/model'
import { type ClientSwitchTrace, SWITCH_TRACE_MARKS, type SwitchMark } from '@podium/protocol'

type MarkMeta = NonNullable<SwitchMark['meta']>

interface ActiveTrace {
  switchId: string
  startedAt: number
  sessionId: SessionId
  issueId: IssueId | null
  t0: number
  marks: SwitchMark[]
  meta: MarkMeta
  timer: ReturnType<typeof setTimeout>
}

/** Bounded ring of finalized traces exposed via getRecentSwitchTraces(). */
const RING_MAX = 50
/** Wire-schema cap on marks per trace (clientSwitchTraceSchema.marks). */
const MARKS_MAX = 200
/** A trace that never quiesces finalizes with timedOut after this long. */
const QUIESCE_TIMEOUT_MS = 10_000
/** Per-mark metadata bounds mirror switchMarkMetaSchema in the protocol. */
const MARK_META_MAX_ENTRIES = 16
const MARK_META_MAX_KEY_LENGTH = 64
const MARK_META_MAX_STRING_LENGTH = 256
/** Diagnostic mark emitted for browser main-thread long tasks. */
const MAIN_THREAD_LONGTASK_MARK = 'main:longtask'

/** Marks that must be recorded at most once — quiesce sentinels. */
const ONCE_MARKS: ReadonlySet<string> = new Set(Object.values(SWITCH_TRACE_MARKS))

/** Terminal-diagnostics lifecycle events worth forwarding as `term:` marks.
 *  Deliberately excludes chatty per-frame/state events. */
const TERM_FORWARD = new Set([
  'mount',
  'connection:attached',
  'connection:reset',
  'ready',
  'reveal:start',
  'reveal:measured',
  'reveal:recover-renderer',
  'reveal:resize-send',
  'fit:measured',
  'fit:action',
  'panel:active-change',
])

/** Hiding/revealing a warm terminal is diagnostic context, not terminal work
 * that the current view owes before its own interactable sentinel. */
const TERM_NON_QUIESCING_MARKS = new Set(['term:panel:active-change'])
let active: ActiveTrace | null = null
const recent: ClientSwitchTrace[] = []
let reporter: ((trace: ClientSwitchTrace) => void) | null = null
let termTapInstalled = false
let longTaskObserver: PerformanceObserver | null = null

const now = (): number =>
  typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now()

function newSwitchId(): string {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return crypto.randomUUID()
    }
  } catch {
    // fall through
  }
  return `sw-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

/**
 * Optional principal-scoped ui-state reader bound by the composition root.
 * The URL query `?switchTrace=1` or the principal-scoped device-local UI state
 * opts into long-task observation and console output; feature code never reaches localStorage
 * directly (POD-329).
 */
let switchTraceUi: { get(key: string): string | null } | null = null

/** Bind the ui-state source that controls optional diagnostics. */
export function bindSwitchTraceUi(ui: { get(key: string): string | null } | null): void {
  switchTraceUi = ui
}

function switchTraceEnabled(): boolean {
  try {
    if (typeof location !== 'undefined') {
      const value = new URLSearchParams(location.search).get('switchTrace')
      if (value === '1' || value === 'true') return true
    }
    // Key spelling lives only in ui-state.ts (SWITCH_TRACE_KEY).
    const value = switchTraceUi?.get('podium.' + 'switchTrace')
    return value === '1' || value === 'true'
  } catch {
    return false
  }
}

/** Minimal structural view of the terminal-diagnostics global — the collector
 *  reads it through globalThis so client-core never runtime-imports the
 *  terminal stack (xterm) just to correlate lifecycle events. */
interface TerminalDiagnosticsTap {
  onTrace(listener: (entry: { sessionId: SessionId; event: string }) => void): () => void
}

function boundedMarkMeta(meta: MarkMeta): MarkMeta | undefined {
  const bounded: MarkMeta = {}
  let count = 0
  for (const [key, value] of Object.entries(meta)) {
    if (count >= MARK_META_MAX_ENTRIES) break
    const boundedKey = key.slice(0, MARK_META_MAX_KEY_LENGTH)
    bounded[boundedKey] =
      typeof value === 'string' ? value.slice(0, MARK_META_MAX_STRING_LENGTH) : value
    count += 1
  }
  return count > 0 ? bounded : undefined
}

function stopLongTaskObserver(): void {
  longTaskObserver?.disconnect()
  longTaskObserver = null
}

function startLongTaskObserver(t: ActiveTrace): void {
  if (typeof PerformanceObserver === 'undefined') return
  const supported = PerformanceObserver.supportedEntryTypes
  if (Array.isArray(supported) && !supported.includes('longtask')) return

  let observer: PerformanceObserver | null = null
  try {
    observer = new PerformanceObserver((list) => {
      if (active !== t) return
      for (const entry of list.getEntries()) {
        const startMs = entry.startTime - t.t0
        const endMs = startMs + entry.duration
        if (endMs <= 0) continue
        markSwitch(t.sessionId, MAIN_THREAD_LONGTASK_MARK, {
          startMs,
          endMs,
          durationMs: entry.duration,
        })
      }
    })
    observer.observe({ type: 'longtask', buffered: true })
    longTaskObserver = observer
  } catch {
    observer?.disconnect()
  }
}

/** Lazily tap the terminal-diagnostics stream (once) so the traced session's
 *  lifecycle events land in the active trace as `term:<event>` marks. Retries
 *  on later gestures if the terminal module hasn't loaded yet. */
function ensureTerminalTap(): void {
  if (termTapInstalled) return
  const diagnostics = (
    globalThis as { __podiumTerminalDiagnostics?: Partial<TerminalDiagnosticsTap> }
  ).__podiumTerminalDiagnostics
  if (typeof diagnostics?.onTrace !== 'function') return
  termTapInstalled = true
  diagnostics.onTrace((entry) => {
    const t = active
    if (!t || entry.sessionId !== t.sessionId) return
    if (!TERM_FORWARD.has(entry.event)) return
    markSwitch(entry.sessionId, `term:${entry.event}`)
    // A warm reveal never re-fires the mount's one-shot `ready`; retain the
    // reveal's measured/refit point as a lifecycle mark. AgentPanel records
    // `term:interactable` separately after the visible terminal can accept input.
    if (entry.event === 'reveal:measured') markSwitch(entry.sessionId, SWITCH_TRACE_MARKS.termReady)
  })
}

function quiesced(marks: readonly SwitchMark[]): boolean {
  let chatSeen = false
  let termSeen = false
  let chatInteractable = false
  let termInteractable = false
  for (const m of marks) {
    if (m.name.startsWith('chat:') || m.name.startsWith('transcript:')) chatSeen = true
    if (m.name.startsWith('term:') && !TERM_NON_QUIESCING_MARKS.has(m.name)) termSeen = true
    if (m.name === SWITCH_TRACE_MARKS.chatInteractable) chatInteractable = true
    if (m.name === SWITCH_TRACE_MARKS.termInteractable) termInteractable = true
  }
  // Every subsystem that showed activity must have reached its interactable
  // sentinel, and at least one sentinel must exist at all.
  return (
    (chatInteractable || termInteractable) &&
    (!chatSeen || chatInteractable) &&
    (!termSeen || termInteractable)
  )
}

function finalize(t: ActiveTrace, timedOut: boolean): void {
  if (active === t) active = null
  clearTimeout(t.timer)
  stopLongTaskObserver()
  const chatPainted = t.marks.some((m) => m.name === SWITCH_TRACE_MARKS.chatFirstPaint)
  const chatInteractable = t.marks.some((m) => m.name === SWITCH_TRACE_MARKS.chatInteractable)
  const termReady = t.marks.some((m) => m.name === SWITCH_TRACE_MARKS.termReady)
  const termInteractable = t.marks.some((m) => m.name === SWITCH_TRACE_MARKS.termInteractable)
  const trace: ClientSwitchTrace = {
    switchId: t.switchId,
    startedAt: t.startedAt,
    sessionId: t.sessionId,
    issueId: t.issueId,
    mode:
      chatInteractable || chatPainted
        ? 'chat'
        : termInteractable || termReady
          ? 'native'
          : 'unknown',
    cold: t.marks.some((m) => m.name === 'panel:mount'),
    totalMs: timedOut ? now() - t.t0 : t.marks.reduce((max, m) => Math.max(max, m.atMs), 0),
    timedOut,
    marks: t.marks,
    ...(Object.keys(t.meta).length > 0 ? { meta: t.meta } : {}),
  }
  recent.push(trace)
  if (recent.length > RING_MAX) recent.splice(0, recent.length - RING_MAX)
  if (reporter) {
    try {
      reporter(trace)
    } catch {
      // the reporter is fire-and-forget; never throw into the UI
    }
  }
  if (switchTraceEnabled()) {
    console.debug(
      `[podium switch] ${trace.mode}${trace.cold ? ' cold' : ''}${trace.timedOut ? ' TIMEOUT' : ''} ` +
        `${Math.round(trace.totalMs)}ms session=${trace.sessionId} marks=${trace.marks.length}`,
      trace.meta ?? {},
    )
    console.table(
      trace.marks.map((m) => ({
        name: m.name,
        atMs: Math.round(m.atMs * 10) / 10,
        meta: m.meta ?? {},
      })),
    )
  }
}

/**
 * Start a switch trace at the user gesture (t0 = performance.now()). Replaces
 * any in-flight trace: the old one is finalized first, flagged `timedOut` if
 * it hadn't quiesced. Callers should skip no-op switches (already-active pane).
 */
export function beginSwitch(input: { sessionId: SessionId; issueId?: IssueId | null }): void {
  if (active) finalize(active, true)
  ensureTerminalTap()
  const t: ActiveTrace = {
    switchId: newSwitchId(),
    startedAt: Date.now(),
    sessionId: input.sessionId,
    issueId: input.issueId ?? null,
    t0: now(),
    marks: [],
    meta: {},
    timer: setTimeout(() => {
      if (active) finalize(active, true)
    }, QUIESCE_TIMEOUT_MS),
  }
  active = t
  if (switchTraceEnabled()) startLongTaskObserver(t)
}

/**
 * Record a named point in the active trace — a no-op (one null check) unless a
 * trace is in flight AND targets `sessionId`. `meta` merges into the trace's
 * free-form counters. Finalizes the trace when it quiesces (chat/terminal
 * interactable — see quiesced()); paint and transport-ready remain diagnostic marks.
 */
export function markSwitch(sessionId: SessionId, name: string, meta?: MarkMeta): void {
  const t = active
  if (!t || t.sessionId !== sessionId) return
  if (ONCE_MARKS.has(name) && t.marks.some((m) => m.name === name)) return
  const bounded = meta ? boundedMarkMeta(meta) : undefined
  if (t.marks.length < MARKS_MAX) {
    t.marks.push({
      name,
      atMs: now() - t.t0,
      ...(bounded ? { meta: bounded } : {}),
    })
  }
  if (bounded) Object.assign(t.meta, bounded)
  if (quiesced(t.marks)) finalize(t, false)
}

/** True when a switch trace is in flight for `sessionId` — lets hot paths skip
 *  scheduling work (e.g. paint rAFs) when nothing is being traced. */
export function isSwitchTraced(sessionId: SessionId): boolean {
  return active !== null && active.sessionId === sessionId
}

/** Most recent finalized traces, oldest first (bounded ring of 50). */
export function getRecentSwitchTraces(): ClientSwitchTrace[] {
  return recent.slice()
}

/** Install the finalize sink (e.g. trpc.perf.report). Pass null to clear. */
export function setSwitchTraceReporter(fn: ((trace: ClientSwitchTrace) => void) | null): void {
  reporter = fn
}

/** Test seam: drop the active trace (without reporting) and clear the ring. */
export function resetSwitchTraces(): void {
  if (active) clearTimeout(active.timer)
  stopLongTaskObserver()
  active = null
  recent.length = 0
}

/**
 * Introspection global, mirroring `__podiumTerminalDiagnostics`: lets the
 * Playwright harness (and a curious devtools user) pull recent traces without
 * an app-level export. Registered unconditionally — it holds no data until a
 * gesture is traced and the ring is bounded.
 */
Object.defineProperty(globalThis, '__podiumSwitchTraces', {
  value: { recent: getRecentSwitchTraces },
  configurable: true,
})

declare global {
  // eslint-disable-next-line no-var -- global debugging API intentionally uses a var declaration.
  var __podiumSwitchTraces: { recent(): ClientSwitchTrace[] } | undefined
}

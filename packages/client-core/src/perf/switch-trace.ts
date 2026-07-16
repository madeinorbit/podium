/**
 * Client switch-latency collector [POD-701]: one correlated ClientSwitchTrace
 * per user gesture that switches the focused session, showing where the time
 * went until the view quiesced (chat first paint / terminal ready).
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

import type { ClientSwitchTrace, SwitchMark } from '@podium/protocol'

type MarkMeta = Record<string, number | string | boolean>

interface ActiveTrace {
  switchId: string
  startedAt: number
  sessionId: string
  issueId: string | null
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

/** Marks that must be recorded at most once — quiesce sentinels. */
const ONCE_MARKS = new Set(['chat:first-paint', 'term:ready'])

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

let active: ActiveTrace | null = null
const recent: ClientSwitchTrace[] = []
let reporter: ((trace: ClientSwitchTrace) => void) | null = null
let termTapInstalled = false

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

function consoleEnabled(): boolean {
  try {
    if (typeof location !== 'undefined') {
      const value = new URLSearchParams(location.search).get('switchTrace')
      if (value === '1' || value === 'true') return true
    }
    return globalThis.localStorage?.getItem('podium.switchTrace') === '1'
  } catch {
    return false
  }
}

/** Minimal structural view of the terminal-diagnostics global — the collector
 *  reads it through globalThis so client-core never runtime-imports the
 *  terminal stack (xterm) just to correlate lifecycle events. */
interface TerminalDiagnosticsTap {
  onTrace(listener: (entry: { sessionId: string; event: string }) => void): () => void
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
    // A warm reveal never re-fires the mount's one-shot `ready`; treat the
    // reveal's measured/refit point (xterm has re-laid-out and repainted) as
    // the terminal-usable moment so warm native switches quiesce too.
    if (entry.event === 'reveal:measured') markSwitch(entry.sessionId, 'term:ready')
  })
}

function quiesced(marks: readonly SwitchMark[]): boolean {
  let chatSeen = false
  let termSeen = false
  let chatPainted = false
  let termReady = false
  for (const m of marks) {
    if (m.name.startsWith('chat:') || m.name.startsWith('transcript:')) chatSeen = true
    if (m.name.startsWith('term:')) termSeen = true
    if (m.name === 'chat:first-paint') chatPainted = true
    if (m.name === 'term:ready') termReady = true
  }
  // Every subsystem that showed activity must have reached its paint/ready
  // sentinel, and at least one sentinel must exist at all.
  return (chatPainted || termReady) && (!chatSeen || chatPainted) && (!termSeen || termReady)
}

function finalize(t: ActiveTrace, timedOut: boolean): void {
  if (active === t) active = null
  clearTimeout(t.timer)
  const chatPainted = t.marks.some((m) => m.name === 'chat:first-paint')
  const termReady = t.marks.some((m) => m.name === 'term:ready')
  const trace: ClientSwitchTrace = {
    switchId: t.switchId,
    startedAt: t.startedAt,
    sessionId: t.sessionId,
    issueId: t.issueId,
    mode: chatPainted ? 'chat' : termReady ? 'native' : 'unknown',
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
  if (consoleEnabled()) {
    console.debug(
      `[podium switch] ${trace.mode}${trace.cold ? ' cold' : ''}${trace.timedOut ? ' TIMEOUT' : ''} ` +
        `${Math.round(trace.totalMs)}ms session=${trace.sessionId} marks=${trace.marks.length}`,
      trace.meta ?? {},
    )
    console.table(trace.marks.map((m) => ({ name: m.name, atMs: Math.round(m.atMs * 10) / 10 })))
  }
}

/**
 * Start a switch trace at the user gesture (t0 = performance.now()). Replaces
 * any in-flight trace: the old one is finalized first, flagged `timedOut` if
 * it hadn't quiesced. Callers should skip no-op switches (already-active pane).
 */
export function beginSwitch(input: { sessionId: string; issueId?: string | null }): void {
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
}

/**
 * Record a named point in the active trace — a no-op (one null check) unless a
 * trace is in flight AND targets `sessionId`. `meta` merges into the trace's
 * free-form counters. Finalizes the trace when it quiesces (chat first paint
 * and/or terminal ready — see quiesced()).
 */
export function markSwitch(sessionId: string, name: string, meta?: MarkMeta): void {
  const t = active
  if (!t || t.sessionId !== sessionId) return
  if (ONCE_MARKS.has(name) && t.marks.some((m) => m.name === name)) return
  if (t.marks.length < MARKS_MAX) t.marks.push({ name, atMs: now() - t.t0 })
  if (meta) Object.assign(t.meta, meta)
  if (quiesced(t.marks)) finalize(t, false)
}

/** True when a switch trace is in flight for `sessionId` — lets hot paths skip
 *  scheduling work (e.g. paint rAFs) when nothing is being traced. */
export function isSwitchTraced(sessionId: string): boolean {
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

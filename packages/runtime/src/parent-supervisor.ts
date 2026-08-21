/**
 * Thin parent process policy: supervise server + daemon children, classify
 * exits, gate self-handover health, and decide post-update rollback.
 *
 * Spec: docs/internal/superpowers/specs/2026-08-20-updater-convergence-spec.md
 * §3, §8 dispositions 4/6/7–11/15/24, §8c decisions 4/12. [POD-2505]
 *
 * Pure decision helpers live here so unit tests exercise the state machine
 * without real processes. The process-driving loop is {@link ParentProcess}.
 */

/** Children the parent owns as OS processes. Janitor is a server worker, not a child. */
export type SupervisedChild = 'server' | 'daemon'

/** Exit class for a supervised child (spec §8 component-failure policy). */
export type ChildExitClass = 'crash' | 'refusal'

/** systemd / janitor-compatible refusal exit (EX_CONFIG). */
export const CHILD_REFUSAL_EXIT_CODE = 78

/** Default backoff ladder for crash restarts (ms). */
export const CRASH_BACKOFF_MS = [1_000, 2_000, 5_000, 10_000, 30_000] as const

/** How many post-update crashes within the window trigger rollback consideration. */
export const POST_UPDATE_CRASH_LOOP_THRESHOLD = 3
export const POST_UPDATE_CRASH_WINDOW_MS = 60_000

export type ChildRuntimeState =
  | { status: 'stopped' }
  | { status: 'starting' }
  | { status: 'running'; pid: number }
  | { status: 'restarting'; attempts: number; nextAtMs: number }
  | { status: 'refused'; reason: string; exitCode: number }
  | { status: 'stopping' }

export type ParentPhase =
  | 'booting'
  | 'running'
  | 'degraded'
  | 'handover_outgoing'
  | 'handover_incoming'
  | 'rolling_back'
  | 'stopping'

export interface ParentSnapshot {
  phase: ParentPhase
  children: Record<SupervisedChild, ChildRuntimeState>
  /** Expected install version the handover health gate must observe. */
  expectedVersion?: string
  /** Wall-clock ms of the most recent successful bundle swap (undefined = not post-update). */
  postUpdateSinceMs?: number
  /** Crash timestamps (ms) recorded while postUpdateSinceMs is set. */
  postUpdateCrashes: number[]
  /** Component refusals currently holding the stack degraded. */
  refusals: Partial<Record<SupervisedChild | 'janitor', string>>
}

export function emptyParentSnapshot(phase: ParentPhase = 'booting'): ParentSnapshot {
  return {
    phase,
    children: {
      server: { status: 'stopped' },
      daemon: { status: 'stopped' },
    },
    postUpdateCrashes: [],
    refusals: {},
  }
}

/** Priority order for first boot and restore: server before daemon. */
export const CHILD_START_ORDER: readonly SupervisedChild[] = ['server', 'daemon']

/**
 * Classify a child exit. Refusal exits stay stopped + DEGRADED; everything else
 * is a crash and restarts with backoff. Signal deaths are always crashes.
 */
export function classifyChildExit(input: {
  exitCode: number | null
  signal?: string | null
}): ChildExitClass {
  if (input.signal) return 'crash'
  if (input.exitCode === CHILD_REFUSAL_EXIT_CODE) return 'refusal'
  return 'crash'
}

/** Next backoff delay for the Nth crash restart attempt (0-based). */
export function crashBackoffMs(attempts: number): number {
  const idx = Math.max(0, Math.min(attempts, CRASH_BACKOFF_MS.length - 1))
  return CRASH_BACKOFF_MS[idx] as number
}

/**
 * Apply a child exit to the snapshot. Refusal parks the child stopped and marks
 * the parent degraded; crash schedules a restart and may trip the post-update
 * crash-loop counter.
 */
export function applyChildExit(
  snap: ParentSnapshot,
  child: SupervisedChild,
  input: { exitCode: number | null; signal?: string | null; nowMs: number; reason?: string },
): ParentSnapshot {
  const kind = classifyChildExit(input)
  const children = { ...snap.children }
  const refusals = { ...snap.refusals }
  let postUpdateCrashes = snap.postUpdateCrashes
  let phase = snap.phase

  if (kind === 'refusal') {
    const reason = input.reason ?? `exit ${input.exitCode}`
    children[child] = { status: 'refused', reason, exitCode: input.exitCode ?? CHILD_REFUSAL_EXIT_CODE }
    refusals[child] = reason
    if (phase === 'running' || phase === 'booting' || phase === 'degraded') phase = 'degraded'
    return { ...snap, phase, children, refusals, postUpdateCrashes }
  }

  delete refusals[child]
  // Fresh crash from running → attempts=0 delay; failures while already restarting climb the ladder.
  const restartAttempts =
    snap.children[child].status === 'restarting' ? snap.children[child].attempts + 1 : 0
  children[child] = {
    status: 'restarting',
    attempts: restartAttempts,
    nextAtMs: input.nowMs + crashBackoffMs(restartAttempts),
  }

  if (snap.postUpdateSinceMs !== undefined) {
    const windowStart = input.nowMs - POST_UPDATE_CRASH_WINDOW_MS
    postUpdateCrashes = [...snap.postUpdateCrashes.filter((t) => t >= windowStart), input.nowMs]
  }

  // A crash does not clear an unrelated refusal — stay degraded if any remain.
  if (Object.keys(refusals).length > 0) phase = 'degraded'
  else if (phase === 'booting' || phase === 'degraded' || phase === 'running') phase = 'running'

  return { ...snap, phase, children, refusals, postUpdateCrashes }
}

/** Mark a child as running (successful spawn / still alive). */
export function applyChildRunning(
  snap: ParentSnapshot,
  child: SupervisedChild,
  pid: number,
): ParentSnapshot {
  const children = { ...snap.children, [child]: { status: 'running' as const, pid } }
  const refusals = { ...snap.refusals }
  delete refusals[child]
  if (Object.keys(refusals).length > 0) {
    return { ...snap, children, refusals, phase: 'degraded' }
  }
  // Leave handover/boot phases alone until the health gate promotes them.
  if (snap.phase === 'handover_incoming' || snap.phase === 'booting') {
    return { ...snap, children, refusals }
  }
  return { ...snap, children, refusals, phase: 'running' }
}

/** Record a janitor refusal reported by the server worker (not an OS child). */
export function applyJanitorRefusal(snap: ParentSnapshot, reason: string): ParentSnapshot {
  return {
    ...snap,
    phase: snap.phase === 'stopping' ? snap.phase : 'degraded',
    refusals: { ...snap.refusals, janitor: reason },
  }
}

export function clearJanitorRefusal(snap: ParentSnapshot): ParentSnapshot {
  const refusals = { ...snap.refusals }
  delete refusals.janitor
  const phase =
    Object.keys(refusals).length > 0
      ? 'degraded'
      : snap.children.server.status === 'running' && snap.children.daemon.status === 'running'
        ? 'running'
        : snap.phase
  return { ...snap, refusals, phase }
}

/** Health probe result the handover gate consumes (spec disposition 24). */
export interface HandoverHealthProbe {
  serverRunning: boolean
  daemonRunning: boolean
  /** appVersion from GET /version — must equal the swapped release. */
  serverVersion: string | null
  /** True when the local daemon is connected to the server (not bare /health). */
  daemonConnected: boolean
}

export function isHandoverHealthy(
  probe: HandoverHealthProbe,
  expectedVersion: string,
): boolean {
  return (
    probe.serverRunning &&
    probe.daemonRunning &&
    probe.daemonConnected &&
    probe.serverVersion === expectedVersion
  )
}

/**
 * Rollback availability after a post-update crash loop (decision 4): only when
 * the release carried no new migrations AND `.old` still exists.
 */
export function rollbackDecision(input: {
  crashLoop: boolean
  oldBundlePresent: boolean
  releaseHadMigrations: boolean
}): { action: 'rollback' } | { action: 'unavailable'; why: string } | { action: 'continue' } {
  if (!input.crashLoop) return { action: 'continue' }
  if (input.releaseHadMigrations) {
    return {
      action: 'unavailable',
      why: 'rollback unavailable: release carried schema migrations — forward-fix required',
    }
  }
  if (!input.oldBundlePresent) {
    return {
      action: 'unavailable',
      why: 'rollback unavailable: no .old bundle retained to restore',
    }
  }
  return { action: 'rollback' }
}

export function isPostUpdateCrashLoop(snap: ParentSnapshot, nowMs: number): boolean {
  if (snap.postUpdateSinceMs === undefined) return false
  const windowStart = nowMs - POST_UPDATE_CRASH_WINDOW_MS
  const recent = snap.postUpdateCrashes.filter((t) => t >= windowStart)
  return recent.length >= POST_UPDATE_CRASH_LOOP_THRESHOLD
}

/** Begin outgoing handover: old parent has spawned the successor and waits for healthy. */
export function beginHandoverOutgoing(
  snap: ParentSnapshot,
  expectedVersion: string,
): ParentSnapshot {
  return {
    ...snap,
    phase: 'handover_outgoing',
    expectedVersion,
  }
}

/** New parent boots under handover_incoming until the health gate passes. */
export function beginHandoverIncoming(
  snap: ParentSnapshot,
  expectedVersion: string,
): ParentSnapshot {
  return {
    ...emptyParentSnapshot('handover_incoming'),
    expectedVersion,
    postUpdateSinceMs: snap.postUpdateSinceMs,
  }
}

/** Mark that a bundle swap just completed; arms the crash-loop rollback window. */
export function markPostUpdate(snap: ParentSnapshot, nowMs: number): ParentSnapshot {
  return { ...snap, postUpdateSinceMs: nowMs, postUpdateCrashes: [] }
}

/** Clear post-update arming after healthy soak or successful rollback. */
export function clearPostUpdate(snap: ParentSnapshot): ParentSnapshot {
  return { ...snap, postUpdateSinceMs: undefined, postUpdateCrashes: [] }
}

/**
 * Components projection for GET /version (and settings). Degraded never bubbles
 * to systemd — it is informational only.
 */
export function componentsProjection(snap: ParentSnapshot): {
  parent: 'running' | 'degraded' | 'handover'
  server: ChildRuntimeState['status'] | 'unknown'
  daemon: ChildRuntimeState['status'] | 'unknown'
  janitor: 'running' | 'degraded' | 'unknown'
  degraded: Array<SupervisedChild | 'janitor'>
  refusals: Partial<Record<SupervisedChild | 'janitor', string>>
} {
  const degraded = (Object.keys(snap.refusals) as Array<SupervisedChild | 'janitor'>).slice()
  const janitor = snap.refusals.janitor ? 'degraded' : 'running'
  const parent =
    snap.phase === 'handover_outgoing' || snap.phase === 'handover_incoming'
      ? 'handover'
      : degraded.length > 0 || snap.phase === 'degraded'
        ? 'degraded'
        : 'running'
  return {
    parent,
    server: snap.children.server.status,
    daemon: snap.children.daemon.status,
    janitor,
    degraded,
    refusals: { ...snap.refusals },
  }
}

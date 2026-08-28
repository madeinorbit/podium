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
  /**
   * Why this machine is stuck on a release it cannot undo (decision 4).
   *
   * NOT a per-child fact, which is why it is not a refusal: the children may be
   * perfectly healthy on the release nobody can roll back, and a child coming up
   * must not clear it. Set when a rollback was refused, cleared only when the
   * post-update window closes or the rollback actually happens.
   */
  rollbackUnavailable?: string
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
    children[child] = {
      status: 'refused',
      reason,
      exitCode: input.exitCode ?? CHILD_REFUSAL_EXIT_CODE,
    }
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

  // A crash does not clear an unrelated refusal — stay degraded if any remain,
  // and never while the machine is stuck on a release it cannot roll back.
  if (Object.keys(refusals).length > 0 || snap.rollbackUnavailable) phase = 'degraded'
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
  // A child coming back does not un-stick a release that cannot be rolled back.
  if (snap.rollbackUnavailable) return { ...snap, children, refusals, phase: 'degraded' }
  return { ...snap, children, refusals, phase: 'running' }
}

/** Record that rollback was refused, and why (decision 4). Holds the stack degraded. */
export function markRollbackUnavailable(snap: ParentSnapshot, why: string): ParentSnapshot {
  return {
    ...snap,
    phase: snap.phase === 'stopping' ? snap.phase : 'degraded',
    rollbackUnavailable: why,
  }
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

/**
 * Health probe result the handover gate consumes (spec disposition 24).
 *
 * There is deliberately no separate `daemonRunning` bit. The OLD parent can only
 * observe the successor's stack across a process boundary, over the successor
 * server's `GET /version` — it cannot see the successor's child table. A second
 * field derived from the same HTTP body would be the same bit twice wearing two
 * names, which is what the first cut of this file did and what made the unit
 * test for the gate prove nothing (review finding 7). `daemonConnected` is the
 * one authoritative "the LOCAL daemon reached the new server" signal, and the
 * server computes it against its own host machine id, not "any machine online".
 */
export interface HandoverHealthProbe {
  serverRunning: boolean
  /** appVersion from GET /version — must equal the swapped release. */
  serverVersion: string | null
  /** True when THIS HOST's daemon is connected to the server (not bare /health). */
  daemonConnected: boolean
  /**
   * Janitor co-host state as the server reports it, when it reports one.
   * Feeds the watchdog's component-advance rule; never gates handover health —
   * a degraded janitor must not block a release (§8 component-failure policy).
   */
  janitor?: { state: 'running' | 'degraded' | 'stopped'; progressVersion?: number }
}

/**
 * Handover health (disposition 24): every supervised child up, the server
 * serving the NEW version over /version, and the local daemon connected —
 * never bare /health.
 *
 * `shape.requiresDaemon` is the caller's child table, because disposition 11
 * includes daemonless machines: on a server-only parent no process will ever
 * set `daemonConnected`, and demanding it made the gate unsatisfiable — every
 * coordinator install swapped, timed out, and rolled back while the fleet
 * record claimed the new version (POD-2732). The boot gate already judges by
 * the supervised shape; this keeps the handover gate on the same rule.
 */
export function isHandoverHealthy(
  probe: HandoverHealthProbe,
  expectedVersion: string,
  shape: { requiresDaemon: boolean } = { requiresDaemon: true },
): boolean {
  return (
    probe.serverRunning &&
    (probe.daemonConnected || !shape.requiresDaemon) &&
    probe.serverVersion === expectedVersion
  )
}

/**
 * Daemon-only handover proof. Unlike a co-located stack there is no local HTTP
 * server to probe: the successor daemon itself must be the live registered
 * process, authenticated to its remote server, running the target build, and
 * have confirmed that target from its pending grant during boot reconciliation.
 */
export interface DaemonHandoverHealthProbe {
  connected: boolean
  appVersion: string | null
  convergedVersion: string | null
}

export function isDaemonHandoverHealthy(
  probe: DaemonHandoverHealthProbe,
  expectedVersion: string,
): boolean {
  return (
    probe.connected &&
    probe.appVersion === expectedVersion &&
    probe.convergedVersion === expectedVersion
  )
}

/**
 * How long a janitor that claims to be RUNNING may leave its progress token
 * unchanged before the parent stops petting the systemd watchdog. The janitor's
 * tick is 30s, so this is 20 ticks: comfortably past a slow tick or a long
 * maintenance pass, and unambiguous about a wedged worker.
 */
export const COMPONENT_WEDGED_MS = 600_000

export interface WatchdogAdvance {
  /** Last component progress token the parent saw. */
  progress?: number
  /** When that token was first observed at its current value. */
  observedAtMs?: number
}

/**
 * Should the parent pet the systemd watchdog this tick (§8, gap 9)?
 *
 * The watchdog's contract is "the parent is not wedged", and §8 is explicit that
 * DEGRADED must never bubble to systemd — a serving server beats a suicide over a
 * stopped janitor. So a janitor that is stopped, degraded, or simply not reported
 * always pets. What must become visible is the third state the event loop cannot
 * see on its own: a component that says it is RUNNING while its progress token
 * has not moved for {@link COMPONENT_WEDGED_MS}. That withholds the pet, and
 * systemd restarts the unit.
 *
 * Pure so the rule is testable without a notify socket or a real janitor.
 */
export function watchdogPetDecision(input: {
  janitor?: HandoverHealthProbe['janitor']
  advance: WatchdogAdvance
  nowMs: number
  wedgedAfterMs?: number
}): { pet: boolean; advance: WatchdogAdvance; wedged: boolean } {
  const wedgedAfterMs = input.wedgedAfterMs ?? COMPONENT_WEDGED_MS
  const progress = input.janitor?.state === 'running' ? input.janitor.progressVersion : undefined
  if (progress === undefined) {
    // No advance signal to judge — liveness of the parent's own loop is the contract.
    return { pet: true, advance: {}, wedged: false }
  }
  if (input.advance.progress !== progress || input.advance.observedAtMs === undefined) {
    return {
      pet: true,
      advance: { progress, observedAtMs: input.nowMs },
      wedged: false,
    }
  }
  const stalledMs = input.nowMs - input.advance.observedAtMs
  if (stalledMs >= wedgedAfterMs) {
    return { pet: false, advance: input.advance, wedged: true }
  }
  return { pet: true, advance: input.advance, wedged: false }
}

/**
 * Rollback availability after a post-update crash loop (decision 4): only when
 * the release carried no new migrations AND `.old` still exists.
 *
 * `releaseHadMigrations` is deliberately `boolean | undefined`, and UNDEFINED IS
 * NOT FALSE. Only the process that ran the swap can compare the release's
 * declared migrations against the live ledger; any other process — a successor
 * parent spawned by a predecessor too old to pass the fact on, a parent that
 * found a `.old` it did not create — is guessing. Restoring old code over a
 * migrated database corrupts data rather than merely inconveniencing the user,
 * so a parent that cannot answer the question refuses and says so. (Contrast
 * `releaseCarriesNewMigrations`, where an explicit empty declaration is
 * knowledge, not absence of it.)
 */
export function rollbackDecision(input: {
  crashLoop: boolean
  oldBundlePresent: boolean
  releaseHadMigrations: boolean | undefined
}): { action: 'rollback' } | { action: 'unavailable'; why: string } | { action: 'continue' } {
  if (!input.crashLoop) return { action: 'continue' }
  if (input.releaseHadMigrations === undefined) {
    return {
      action: 'unavailable',
      why: 'rollback unavailable: this parent cannot tell whether the release carried schema migrations — forward-fix required',
    }
  }
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
  const next = { ...snap, postUpdateSinceMs: undefined, postUpdateCrashes: [] }
  // The release is no longer the unproven one, so "cannot roll it back" is no
  // longer a live fact about this machine.
  delete next.rollbackUnavailable
  return next
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
  /** Present when the machine is stuck on a release rollback cannot undo. */
  rollbackUnavailable?: string
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
    ...(snap.rollbackUnavailable ? { rollbackUnavailable: snap.rollbackUnavailable } : {}),
  }
}

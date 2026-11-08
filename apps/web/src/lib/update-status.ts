/**
 * THE ONE UPDATE-STATUS READER (POD-6683).
 *
 * Every update view (the corner update panel, Settings → Updates, the machine
 * panel's convergence rows and server-move card, and the phone layout that draws
 * the same panel) reads this service's observable state. Nothing else polls
 * `updates.fleet`, `operations.active` or `updates.proposal`.
 *
 * WHY IT IS OFF SYNC. Updates are often how a broken server gets fixed, and an
 * update restarts the server. So this reader uses plain HTTP requests only. It
 * never waits for the socket or the replica, and it keeps working while sync is
 * down, reconnecting or broken (ADR 12 D8: a minimal, separate path).
 *
 * SYNC AS A HINT, NEVER A DEPENDENCY. The synced effect records for a software
 * update or a server move (POD-6358) are a trigger: when one appears or changes
 * status, the reader reads once (`followEffects`). With sync working, an update
 * started on another device shows within a second; with sync down, focus,
 * visibility and online events still cover it, and nothing waits for the pool.
 *
 * WHEN IT POLLS, and when it does not:
 *  - once a second while something is in flight: an active operation, a release
 *    proposal that is building, a machine converging, or an action waiting to see
 *    its operation;
 *  - every few seconds while an update screen is open (`watch()`), so a newly
 *    available update or proposal shows up there;
 *  - every 30 s while the operation is still unknown because the last read
 *    failed, so a failed first read is not permanent;
 *  - otherwise never. It reads once at start, when an update screen opens, when
 *    an update or server-move effect record changes, when the tab becomes
 *    visible, regains focus or comes back online (at most every 30 s), and when
 *    a caller asks (`refresh()`).
 * A hidden tab does not poll, and reads once when it becomes visible again.
 *
 * A SERVER RESTART. Each read is independent and keeps the last known value of
 * every part that did not answer. While an operation is active the ticks keep
 * coming, so the reader reconnects by itself when the server is back. A read
 * that hangs (the transport waits for readiness) stops blocking the next tick
 * after STALE_READ_MS.
 *
 * `operations.history` is NOT part of this reader, with one exception: while
 * nothing is running, the newest update row is read so a finished or failed
 * update stays visible (`active` filters terminal states out). Lists of history
 * stay request answers in the views that show them.
 */
import type { MobxPool } from '@podium/client-graph'
import { operationEffects } from '@podium/client-graph/write/operation-effects'
import { lazy } from '@podium/mobx-helpers'
import {
  isTerminalOperationState,
  type Operation,
  parseBuildStamp,
  parseOperation,
  parseServerVersion,
  type ReleaseProposal,
  ReleaseProposal as ReleaseProposalSchema,
  type ServerVersion,
} from '@podium/protocol'
import { action, observable, observableRef, reaction, runInAction } from 'mobx'
import { makeTrpc, serverConfig, type Trpc } from '@/app/trpc'
import { noteActiveUpdate } from '@/lib/active-update'
import { updatesLog } from '@/lib/logging/update-logs'
import { workspaceFetch } from '@/lib/workspace-request'

/** Something is moving: one second is worth a machine's time. */
export const ACTIVE_POLL_MS = 1_000
/** An update screen is open and nothing is moving. */
export const WATCHED_POLL_MS = 5_000
/** The operation is unknown because a read failed. */
export const RETRY_POLL_MS = 30_000
/** A read in flight this long no longer holds back the next tick. */
export const STALE_READ_MS = 15_000
/** Focus and visibility read at most this often when nothing else is polling. */
export const WAKE_MIN_AGE_MS = 30_000

const BUILD_STAMP_FILE = 'podium-build.json'

export type UpdateFleetSnapshot = Awaited<ReturnType<Trpc['updates']['fleet']['query']>>
type FleetMachine = NonNullable<UpdateFleetSnapshot['machines']>[number]

/** The machine states that mean "this machine is converging right now". */
export const CONVERGENCE_IN_FLIGHT: ReadonlySet<string> = new Set([
  'granted',
  'downloading',
  'restarting',
])

/** What this page's own build stamp says. */
export interface LocalBuild {
  appDigest?: string
  wireSchemaDigest?: string
}

/** An action that started an update and is waiting to see its operation. */
export interface AwaitedOperation {
  kind: 'start' | 'retry'
  /** The answer named no operation id, so a new history row may be the whole update. */
  recoveryWithoutId: boolean
  /** The newest history row before the action, and when the action started. */
  baseline: { latestId: string | null | undefined; startedAt: number }
}

function isActive(operation: Operation | null | undefined): boolean {
  return operation != null && !isTerminalOperationState(operation.state)
}

async function readJson(url: string): Promise<unknown> {
  try {
    const response = await workspaceFetch(url)
    if (!response.ok) return undefined
    return await response.json()
  } catch {
    return undefined
  }
}

/** One part's failure is not the read's failure; a synchronous throw counts too. */
async function safely<T>(read: () => Promise<T>): Promise<T | undefined> {
  try {
    return await read()
  } catch {
    return undefined
  }
}

/** A tRPC path this server does not have: an old server's honest "none". */
function isMissingProcedure(error: unknown): boolean {
  const data = (error as { data?: { code?: unknown } } | null)?.data
  return data?.code === 'NOT_FOUND'
}

/** Old servers have no operations endpoint ("none"); any other failure stays unknown. */
async function safelyReadOperation(
  read: () => Promise<Operation | null>,
): Promise<Operation | null | undefined> {
  try {
    return await read()
  } catch (error) {
    return isMissingProcedure(error) ? null : undefined
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function localBuildFrom(raw: unknown): LocalBuild {
  const stamp = parseBuildStamp(raw)
  return {
    ...(stamp.sourceSha ? { appDigest: stamp.sourceSha } : {}),
    ...(stamp.wireSchemaDigest ? { wireSchemaDigest: stamp.wireSchemaDigest } : {}),
  }
}

/** One line when a value changes, none while it holds. */
function changeReporter(): (signature: string, emit: () => void) => void {
  let last: string | undefined
  return (signature, emit) => {
    if (signature === last) return
    last = signature
    emit()
  }
}

interface Reading {
  seq: number
  operation: Operation | null | undefined
  latest: Operation | null | undefined
  fleet: UpdateFleetSnapshot | undefined
  fleetError: string | undefined
  serverRaw: unknown
  buildRaw: unknown
  proposal: ReleaseProposal | null | undefined
}

export interface UpdateStatusOptions {
  /** Injected for tests; production builds a plain-HTTP client for the origin. */
  trpc?: Trpc
}

export class UpdateStatus {
  // ── What the server said (last known; `undefined` = never answered) ──────────
  /** The active lifecycle operation. `null` means none is running. */
  @observableRef accessor operation: Operation | null | undefined = undefined
  /** The newest update operation, terminal included, read only while nothing runs. */
  @observableRef accessor latest: Operation | null | undefined = undefined
  @observableRef accessor fleet: UpdateFleetSnapshot | undefined = undefined
  /** Why the last fleet read failed; cleared by the next successful one. */
  @observable accessor fleetError: string | undefined = undefined
  @observableRef accessor proposal: ReleaseProposal | null | undefined = undefined
  /** `/version`: what the server is and what it serves. `{}` until read. */
  @observableRef accessor server: ServerVersion = {}
  /** This page's build stamp. `{}` until read. */
  @observableRef accessor build: LocalBuild = {}
  /** When the last reading landed, or `undefined` before the first. */
  @observable accessor landedAt: number | undefined = undefined

  // ── This tab's own facts ─────────────────────────────────────────────────────
  /** Operations this tab saw run. A completion is news only to these. */
  readonly watched = observable.set<string>()
  /** The newest watched observation, replaced on each one (for the restart handoff). */
  @observableRef accessor lastWatched: { id: string; at: number } | null = null
  /** An action is waiting to see the operation it started. */
  @observableRef accessor awaiting: AwaitedOperation | null = null

  // ── Demand ───────────────────────────────────────────────────────────────────
  /** Open update screens. */
  @observable accessor watchers = 0
  @observable accessor visible = true
  @observable accessor started = false

  readonly trpc: Trpc
  private seq = 0
  /** Readings started before this sequence do not move the operation (an action came after). */
  private operationFloor = 0
  /** The newest reading that has landed. */
  private landedSeq = 0
  private inFlight: { seq: number; startedAt: number; promise: Promise<void> } | undefined
  private timer: ReturnType<typeof setInterval> | undefined
  private stopCadence: (() => void) | undefined
  private stopWake: (() => void) | undefined
  private readonly reportServer = changeReporter()

  constructor(
    readonly httpOrigin: string,
    options: UpdateStatusOptions = {},
  ) {
    this.trpc = options.trpc ?? makeTrpc(httpOrigin)
  }

  /** Is anything moving that the views should follow second by second? */
  @lazy get moving(): boolean {
    if (isActive(this.operation)) return true
    if (this.awaiting !== null) return true
    if (this.proposal?.state === 'building') return true
    return this.convergingMachines > 0
  }

  @lazy get convergingMachines(): number {
    const machines: readonly FleetMachine[] = this.fleet?.allMachines ?? this.fleet?.machines ?? []
    return machines.filter((machine) => CONVERGENCE_IN_FLIGHT.has(machine.state)).length
  }

  /** How often to read right now, or `null` for not at all. */
  @lazy get cadence(): number | null {
    if (!this.started || !this.visible) return null
    if (this.moving) return ACTIVE_POLL_MS
    if (this.watchers > 0) return WATCHED_POLL_MS
    if (this.operation === undefined && this.landedAt !== undefined) return RETRY_POLL_MS
    return null
  }

  /** Start reading. Idempotent; every reader calls it. */
  start(): void {
    if (this.started) return
    runInAction(() => {
      this.started = true
      this.visible = typeof document === 'undefined' || document.visibilityState !== 'hidden'
    })
    this.stopWake = this.listenForWake()
    this.stopCadence = reaction(
      () => this.cadence,
      (cadence) => this.schedule(cadence),
      { fireImmediately: true },
    )
    this.refresh()
  }

  /**
   * An update screen is open: read now, so its first frame is fresh, and poll
   * while it stays open. Returns the release, for a React effect's cleanup.
   */
  watch(): () => void {
    const running = this.started
    this.start()
    runInAction(() => {
      this.watchers += 1
    })
    // `start()` has just read; a reader that was already running reads now
    // unless a read is on its way.
    if (running && this.inFlight === undefined) void this.read('refresh')
    let released = false
    return () => {
      if (released) return
      released = true
      runInAction(() => {
        this.watchers -= 1
      })
    }
  }

  /** Read now. A read already in flight is superseded; its answer is dropped. */
  refresh(): Promise<void> {
    if (!this.started) {
      this.start()
      return this.inFlight?.promise ?? Promise.resolve()
    }
    return this.read('refresh')
  }

  /**
   * Read once whenever an update or server-move effect record in `pool`
   * appears, goes away or changes status. A hint only: while something is
   * already moving the one-second poll covers it, and without a pool every
   * other trigger still works. Returns the stop, for a React effect's cleanup.
   */
  followEffects(pool: MobxPool): () => void {
    this.start()
    return reaction(
      () =>
        operationEffects(pool)
          .map((effect) => `${effect.id}:${effect.status}`)
          .join('|'),
      () => {
        if (!this.moving) void this.read('refresh')
      },
    )
  }

  // ── Facts other requests returned ────────────────────────────────────────────
  /** An answer that carried the operation (start, retry): fold it like a reading. */
  @action noteOperation(operation: Operation | null, at = Date.now()): void {
    this.operationFloor = this.seq + 1
    this.foldOperation(operation, at)
  }

  @action noteFleet(fleet: UpdateFleetSnapshot): void {
    this.fleet = fleet
    this.fleetError = undefined
  }

  @action noteProposal(proposal: ReleaseProposal | null): void {
    this.proposal = proposal
  }

  /**
   * An action asked for an update and did not get the operation back (the
   * answer was cut by the restart, or it carried only an id). Readings started
   * before now no longer move the operation, and polling runs until a reading
   * answers authoritatively.
   */
  @action expectOperation(awaited: AwaitedOperation & { operationId?: string }): void {
    this.operationFloor = this.seq + 1
    if (awaited.operationId) this.markWatched(awaited.operationId)
    this.awaiting = {
      kind: awaited.kind,
      recoveryWithoutId: awaited.recoveryWithoutId,
      baseline: awaited.baseline,
    }
    void this.refresh()
  }

  /** The wait for an operation is over without one (the caller reports it). */
  @action stopAwaiting(): void {
    this.awaiting = null
  }

  /** Stop all timers and listeners. Tests and origin changes only. */
  dispose(): void {
    this.stopCadence?.()
    this.stopCadence = undefined
    this.stopWake?.()
    this.stopWake = undefined
    this.schedule(null)
    this.inFlight = undefined
    runInAction(() => {
      this.started = false
    })
  }

  // ── The read ─────────────────────────────────────────────────────────────────
  private schedule(cadence: number | null): void {
    if (this.timer !== undefined) clearInterval(this.timer)
    this.timer = undefined
    if (cadence === null) return
    this.timer = setInterval(() => void this.read('tick'), cadence)
  }

  private listenForWake(): () => void {
    if (typeof window === 'undefined' || typeof document === 'undefined') return () => {}
    const onVisibility = (): void => {
      const visible = document.visibilityState !== 'hidden'
      runInAction(() => {
        this.visible = visible
      })
      // A tab coming back reads at once, so its first visible frame is fresh.
      if (visible) void this.read('refresh')
    }
    const onWake = (): void => {
      const age = this.landedAt === undefined ? Infinity : Date.now() - this.landedAt
      if (age >= WAKE_MIN_AGE_MS && this.inFlight === undefined) void this.read('refresh')
    }
    document.addEventListener('visibilitychange', onVisibility)
    window.addEventListener('focus', onWake)
    window.addEventListener('online', onWake)
    return () => {
      document.removeEventListener('visibilitychange', onVisibility)
      window.removeEventListener('focus', onWake)
      window.removeEventListener('online', onWake)
    }
  }

  private read(reason: 'tick' | 'refresh'): Promise<void> {
    const current = this.inFlight
    if (reason === 'tick' && current && Date.now() - current.startedAt < STALE_READ_MS) {
      updatesLog.debug('an update status tick was skipped; a read was already running')
      return current.promise
    }
    const seq = ++this.seq
    const promise = this.fetchReading(seq).then((reading) => {
      if (this.inFlight?.seq === seq) this.inFlight = undefined
      if (!this.started) return
      // A newer reading already landed: this one has nothing fresher to say.
      if (seq < this.landedSeq) return
      this.landedSeq = seq
      if (seq !== this.seq) {
        // A newer read started after this one and carries the fresher operation.
        updatesLog.debug('an update status reading arrived after a newer read started', {
          reason,
        })
        this.foldUnordered(reading)
        return
      }
      this.fold(reading)
    })
    this.inFlight = { seq, startedAt: Date.now(), promise }
    return promise
  }

  private async fetchReading(seq: number): Promise<Reading> {
    const trpc = this.trpc
    const operation = await safelyReadOperation(async () =>
      parseOperation(await trpc.operations.active.query({ group: 'lifecycle' })),
    )
    let fleetError: string | undefined
    const [latest, fleet, serverRaw, buildRaw, proposal] = await Promise.all([
      // The outcome, which `active` cannot carry. Only asked when nothing runs.
      operation === null
        ? safelyReadOperation(async () => {
            const rows = await trpc.operations.history.query({ kind: 'update', limit: 1 })
            return parseOperation(rows[0])
          })
        : Promise.resolve(undefined),
      // While an operation runs its own steps say where it is; the fleet is
      // read then only for an open screen that shows machine rows.
      operation === null || this.watchers > 0
        ? (async () => {
            try {
              return await trpc.updates.fleet.query()
            } catch (error) {
              fleetError = errorText(error)
              return undefined
            }
          })()
        : Promise.resolve(undefined),
      readJson(`${this.httpOrigin}/version`),
      readJson(`${this.httpOrigin}/${BUILD_STAMP_FILE}`),
      safely(async () => {
        const raw = await trpc.updates.proposal.query()
        return raw === null ? null : ReleaseProposalSchema.parse(raw)
      }),
    ])
    return { seq, operation, latest, fleet, fleetError, serverRaw, buildRaw, proposal }
  }

  /** A superseded reading still carries facts that do not race an action. */
  @action private foldUnordered(reading: Reading): void {
    this.foldFacts(reading)
  }

  @action private fold(reading: Reading): void {
    const at = Date.now()
    updatesLog.debug('update status reading landed', {
      live:
        reading.operation === undefined
          ? 'unread'
          : reading.operation === null
            ? 'none'
            : reading.operation.state,
      latest:
        reading.latest === undefined
          ? 'unread'
          : reading.latest === null
            ? 'none'
            : reading.latest.state,
      fleet: reading.fleet === undefined ? 'unread' : 'read',
      server: reading.serverRaw === undefined ? 'unread' : 'read',
      build: reading.buildRaw === undefined ? 'unread' : 'read',
      proposal: reading.proposal === undefined ? 'unread' : (reading.proposal?.state ?? 'none'),
    })
    if (reading.seq >= this.operationFloor) {
      const { operation, latest } = reading
      if (operation !== undefined) this.foldOperation(operation, at)
      if (latest !== undefined) this.latest = latest
      const awaited = this.awaiting
      if (awaited?.recoveryWithoutId && operation === null && latest) {
        // A new history row can be the entire update after a cut answer. Do not
        // turn an already-known completion into fresh news.
        const { baseline } = awaited
        const newHistory =
          latest.id !== baseline.latestId &&
          (baseline.latestId !== undefined ||
            (latest.createdAt ?? latest.startedAt ?? -Infinity) >= baseline.startedAt)
        if (newHistory && isTerminalOperationState(latest.state)) this.markWatched(latest.id, at)
      }
      // A successful active read, or a complete active+history "none", is
      // authoritative. A failed history read cannot lose a fast terminal outcome.
      if (awaited && (operation || (operation === null && latest !== undefined))) {
        this.awaiting = null
      }
    }
    this.foldFacts(reading)
    this.landedAt = at
  }

  private foldFacts(reading: Reading): void {
    if (reading.serverRaw !== undefined) {
      const next = parseServerVersion(reading.serverRaw)
      this.noteServerChange(next)
      this.server = next
    }
    if (reading.buildRaw !== undefined) this.build = localBuildFrom(reading.buildRaw)
    if (reading.fleet !== undefined) {
      this.fleet = reading.fleet
      this.fleetError = undefined
    } else if (reading.fleetError !== undefined) {
      this.fleetError = reading.fleetError
    }
    if (reading.proposal !== undefined) this.proposal = reading.proposal
  }

  private foldOperation(operation: Operation | null, at: number): void {
    if (operation) this.markWatched(operation.id, at)
    noteActiveUpdate(isActive(operation), at)
    this.operation = operation
  }

  /** This tab saw operation `id` (it started it, or a reading showed it running). */
  @action markWatched(id: string, at = Date.now()): void {
    this.watched.add(id)
    this.lastWatched = { id, at }
  }

  /** What the server is serving, logged when it moves (once per release). */
  private noteServerChange(next: ServerVersion): void {
    this.reportServer(
      [
        next.appVersion ?? '',
        next.sourceDigest ?? '',
        next.web?.bundle ?? '',
        next.web?.digest ?? '',
        next.installKind ?? '',
        next.target?.version ?? '',
      ].join('|'),
      () =>
        updatesLog.info('the server this page reads from changed identity', {
          appVersion: next.appVersion,
          ...(next.sourceDigest ? { sourceDigest: next.sourceDigest } : {}),
          ...(next.installKind ? { installKind: next.installKind } : {}),
          ...(next.web?.bundle ? { servedBundle: next.web.bundle } : {}),
          ...(next.web?.digest ? { servedDigest: next.web.digest } : {}),
          ...(next.target?.version ? { targetVersion: next.target.version } : {}),
        }),
    )
  }
}

/** One reader per server origin; the app talks to one. */
let instance: UpdateStatus | undefined

/** The page's configured server: the origin AppShell's store and the update panel use. */
function configuredOrigin(): string {
  if (typeof window === 'undefined') return ''
  try {
    return serverConfig(window.location).httpOrigin
  } catch {
    // A location the workspace router cannot read (a shell's custom scheme
    // without an injected server) still has a page origin to ask.
    return window.location.origin
  }
}

/**
 * The update-status reader for this app's server. The update panel passes the
 * origin it was given; every other reader takes the one already running, or the
 * page's configured server.
 */
export function updateStatus(httpOrigin?: string): UpdateStatus {
  if (httpOrigin === undefined && instance) return instance
  const origin = httpOrigin ?? configuredOrigin()
  if (instance?.httpOrigin !== origin) {
    instance?.dispose()
    instance = new UpdateStatus(origin)
  }
  return instance
}

/** Test-only: drop the reader so the next test builds its own transport. */
export function resetUpdateStatus(): void {
  instance?.dispose()
  instance = undefined
}

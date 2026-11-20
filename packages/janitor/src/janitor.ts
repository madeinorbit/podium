// workspace-scoped (POD-6959)
import { randomUUID } from 'node:crypto'
import { createLogger } from '@podium/logger'
// A ROW OUT OF THE STORE IS A TRUE SERIALIZATION EDGE: the column is text and the
// value was minted by this system and written by it, so the brand is asserted
// here rather than re-validated. This is the one place these casts belong.
import { asAutomationId, asIssueId, asMachineId, asSessionId, asUserId } from '@podium/model'
import {
  APPLIED_MUTATION_PRUNE_BATCH_ROWS,
  type AppliedMutationsPruneObservation,
  AUTO_ARCHIVE_READ_WINDOW_MS,
  type AutomationFireObservation,
  appliedMutationsPruneRunKey,
  automationFireRunKey,
  CHANGE_KEEP_ROWS,
  CHANGE_MAX_AGE_MS,
  CHANGE_PRUNE_BATCH_ROWS,
  type ChangeLogPruneObservation,
  type ConnectScanObservation,
  changeLogPruneRunKey,
  connectScanRunKey,
  EVENT_PRUNE_BATCH_ROWS,
  EVENT_RETENTION_MAX_AGE_DAYS,
  EVENT_RETENTION_MAX_ROWS,
  type EventLogPruneObservation,
  type MessageExpiryObservation as ExpiryObservation,
  eventLogPruneRunKey,
  type IssueAutoArchiveObservation,
  issueAutoArchiveRunKey,
  MAINTENANCE_COMMAND_MAX_AGE_MS,
  MAINTENANCE_COMMAND_PRUNE_BATCH_ROWS,
  MAINTENANCE_PROTOCOL_VERSION,
  MAINTENANCE_SCHEMA_VERSION,
  type MaintenanceCommand,
  MaintenanceCommandReply,
  type MaintenanceCommandsPruneObservation,
  type MaintenanceHandshake,
  MaintenanceHandshakeReply,
  MessageExpiryObservation,
  maintenanceCommandsPruneRunKey,
  messageExpiryRunKey,
  type QueuedMessagesExpiryObservation,
  queuedMessagesExpiryRunKey,
  type SessionAutoArchiveObservation,
  type StewardPollObservation,
  sessionAutoArchiveRunKey,
  stewardPollRunKey,
  type WorktreeGcObservation,
  worktreeGcRunKey,
} from '@podium/protocol'
import { RetentionBacklog } from '@podium/runtime/retention-backlog'
import { runTimeBudgetedJob } from '@podium/runtime/time-budget'

const log = createLogger('janitor')

const CANDIDATE_LIMIT = 100
const DAY_MS = 24 * 60 * 60 * 1000
const HOUR_MS = 60 * 60 * 1000
const CANDIDATE_PAGE_SIZE = 25
const LEASE_RENEW_AHEAD_MS = 30_000
const DEFAULT_TICK_MS = 30_000
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000
/** How often housekeeping cadence jobs fire relative to message-expiry ticks. */
const HOUSEKEEPING_EVERY_TICKS = 1

type ReadyLease = Extract<MaintenanceHandshakeReply, { status: 'ready' }>

/**
 * THE JANITOR'S READS, AS A PORT [POD-6993, POD-6958 design 2.9].
 *
 * The janitor observes durable facts; it holds no SQL. The server implements this port
 * as query definitions on the store's binding (`apps/server/src/store/janitor-reads.ts`),
 * so the same reads run on SQLite and on Postgres, and opens them over a read session of
 * the store's own engine (`apps/server/src/janitor-database.ts`). Each implementation
 * reads ONE workspace's rows (POD-7021, POD-6959 design 2.4): every table it reads is
 * held to that workspace, joins included.
 *
 * The rows are the facts only; what an observation means (its paging, its run key, the
 * reader it names) is decided here.
 */
export interface JanitorReads {
  /** The workspace's earliest active admin, the janitor's boot check. */
  earliestAdminId(): Promise<string | undefined>
  /** `stored` `wait` messages with no deadline, created at or before `cutoff`, by (created_at, id). */
  implicitExpiryPage(input: {
    cutoff: string
    limit: number
    after?: { createdAt: string; id: string }
  }): Promise<ExpiryRow[]>
  /** `stored` messages whose own deadline is at or before `now`, by (expires_at, id). */
  explicitExpiryPage(input: {
    now: string
    limit: number
    after?: { expiresAt: string; id: string }
  }): Promise<ExpiryRow[]>
  /** The event id `maxRows` rows below the newest, or undefined when there are no more rows. */
  eventCapThroughId(maxRows: number): Promise<number | undefined>
  /** The lowest prunable event id (older than `cutoff`, or at or below the cap), null with none. */
  eventPruneHead(input: { cutoff: string; capThroughId: number }): Promise<number | null>
  /** How many events are prunable, by the same terms. */
  eventPruneCount(input: { cutoff: string; capThroughId: number }): Promise<number>
  /** The feed's bounds and its highest sequence with an event time before `agedBeforeMs`. */
  changeFeed(agedBeforeMs: number): Promise<FeedBounds | undefined>
  /** The plan position of the receipts applied before `cutoffAppliedAt`, null with none. */
  commandPruneHead(cutoffAppliedAt: string): Promise<number | null>
  /** How many receipts were applied before `cutoffAppliedAt`. */
  commandPruneCount(cutoffAppliedAt: string): Promise<number>
  /** Stopped sessions their owner has read since, both at or before the cutoff, by (read_at, id). */
  sessionArchivePage(input: { cutoffReadAt: string; limit: number }): Promise<SessionArchiveRow[]>
  /** Finished top-level issues their assignee has read at or before the cutoff, by (read_at, id). */
  issueArchivePage(input: {
    cutoffReadAt: string
    limit: number
    after?: { readAt: string; id: string }
  }): Promise<IssueArchiveRow[]>
  /** Finished issues still holding a checkout no live session stands in, by (closed_at, id). */
  worktreeGcPage(input: {
    cutoffClosedAt: string
    limit: number
    after?: { closedAt: string; id: string }
  }): Promise<WorktreeGcRow[]>
  /** Enabled automations due at or before `now`, by (next_run_at, id). */
  dueAutomations(input: { now: string; limit: number }): Promise<DueAutomationRow[]>
  /** The steward's stored cursor, as stored. */
  stewardCursor(): Promise<string | undefined>
  /** The oldest receipt applied before `cutoffAppliedAt` (epoch ms), null with none (POD-7035). */
  receiptPruneHead(cutoffAppliedAt: number): Promise<number | null>
  /** How many receipts were applied before `cutoffAppliedAt` (epoch ms). */
  receiptPruneCount(cutoffAppliedAt: number): Promise<number>
  /**
   * The sessions holding input queued at or before `through` (epoch ms), one row each:
   * the newest such row's time and how many there are, oldest session first (POD-7035).
   */
  queuedExpiryPage(input: { through: number; limit: number }): Promise<QueuedExpiryRow[]>
  /** How many rows of every session were queued at or before `through` (epoch ms). */
  queuedExpiryCount(through: number): Promise<number>
  /** The newest event id, 0 with none. */
  maxEventId(): Promise<number>
  /** Every machine but `localMachineId`, newest handshake first. */
  remoteMachines(input: { localMachineId: string | null; limit: number }): Promise<MachineRow[]>
}

export interface ExpiryRow {
  id: string
  lifecycle: string
  createdAt: string
  expiresAt: string | null
}

export interface FeedBounds {
  headSeq: number
  floorSeq: number
  agedSeq: number | null
}

export interface SessionArchiveRow {
  id: string
  issueId: string | null
  stoppedAt: string
  ownerUserId: string
}

export interface IssueArchiveRow {
  id: string
  stage: string
  closedReason: string | null
  ownerUserId: string
  readAt: string
}

export interface WorktreeGcRow {
  id: string
  worktreePath: string
  stage: string
  closedReason: string | null
  closedAt: string
}

export interface QueuedExpiryRow {
  sessionId: string
  /** The newest queued time at or before the horizon. */
  through: number
  rows: number
}

export interface DueAutomationRow {
  id: string
  scheduleKind: 'cron' | 'once'
  cron: string | null
  nextRunAt: string
}

export interface MachineRow {
  id: string
  lastSeenAt: string
}

/**
 * Where the reads run: one scan at a time. Every read a scan makes inside `fn` sees one
 * snapshot of the workspace's rows; the session ends when `fn` settles, so no snapshot is
 * held across the commands the scan's observations become.
 */
export interface JanitorReadSource {
  scan<T>(fn: (reads: JanitorReads) => Promise<T>): Promise<T>
}

/** One workspace of the database the janitor serves. */
export interface JanitorWorkspace extends JanitorReadSource {
  readonly id: string
}

/**
 * The database the janitor serves, opened by its host on the store's engine. Its one
 * cross-workspace read lists the workspaces with a feed (`listWorkspacesWithFeed` on the
 * cross-workspace allowlist); everything else is a scan of one of them.
 */
export interface JanitorDatabase {
  workspacesWithFeed(): Promise<JanitorWorkspace[]>
  close(): Promise<void>
}

export interface ExpiryReadInput {
  now: string
  waitImplicitCutoff: string
  limit: number
}

export interface EventLogPrunePlanInput {
  maxAgeDays: number
  maxRows: number
  batchSize: number
  nowMs: number
}

export interface ChangeLogPrunePlanInput {
  keepRows: number
  maxAgeMs: number
  batchSize: number
  nowMs: number
}

export interface MaintenanceCommandsPrunePlanInput {
  maxAgeMs: number
  batchSize: number
  nowMs: number
}

export interface AppliedMutationsPrunePlanInput {
  maxAgeMs: number
  batchSize: number
  nowMs: number
}

export interface QueuedMessagesExpiryReadInput {
  maxAgeMs: number
  nowMs: number
  limit: number
}

/**
 * The retention jobs, whose rows past their cutoff the janitor reads after each
 * run (POD-7035 guard 4). The other jobs act on candidates, not on a horizon.
 */
export const RETENTION_JOBS = [
  'event-log-prune',
  'change-log-prune',
  'maintenance-commands-prune',
  'applied-mutations-prune',
  'queued-messages-expiry',
] as const
export type RetentionJob = (typeof RETENTION_JOBS)[number]

/** The lease's horizons a backlog read needs, and the time it reads at. */
export type RetentionBacklogInput = Pick<
  ReadyLease,
  | 'eventRetentionMaxAgeDays'
  | 'eventRetentionMaxRows'
  | 'changeKeepRows'
  | 'changeMaxAgeMs'
  | 'maintenanceCommandMaxAgeMs'
  | 'appliedMutationMaxAgeMs'
  | 'queuedMessageMaxAgeMs'
> & { nowMs: number }

export interface AutoArchiveReadInput {
  cutoffReadAt: string
  limit: number
}

/** Reclaimable-checkout scan window (POD-564). `mode`/`afterDays` come off the
 *  lease, not off this build, and ride back out on every observation so the
 *  server can refuse a policy it does not share. */
export interface WorktreeGcReadInput {
  cutoffClosedAt: string
  mode: 'propose' | 'auto'
  afterDays: number
  limit: number
}

/** POD-851-facing counters exposed by the janitor process. */
export interface JanitorCounters {
  ticks: number
  applies: number
  applied: number
  alreadyApplied: number
  stale: number
  failures: number
  lastTickAt: string | null
  lastProgressAt: string | null
  maxBatchDeleted: number
  jobAgeMs: Record<string, number>
  /** Rows past each retention job's cutoff after its last run (POD-7035). */
  retentionBacklog: Record<string, number>
  /** The retention jobs whose backlog has not shrunk across three runs. */
  retentionStalled: string[]
  queueDepth: number
  coalescedJobs: number
  supersededJobs: number
  completedJobs: number
  maxJobAgeMs: number
  maxUninterruptedSliceMs: number
}

export interface JanitorDeps {
  generationId?: string
  now?: () => number
  handshake(request: MaintenanceHandshake): Promise<MaintenanceHandshakeReply>
  readExpiryCandidates(input: ExpiryReadInput): ExpiryObservation[] | Promise<ExpiryObservation[]>
  planEventLogPrune?(
    input: EventLogPrunePlanInput,
  ): EventLogPruneObservation[] | Promise<EventLogPruneObservation[]>
  planChangeLogPrune?(
    input: ChangeLogPrunePlanInput,
  ): ChangeLogPruneObservation[] | Promise<ChangeLogPruneObservation[]>
  planMaintenanceCommandsPrune?(
    input: MaintenanceCommandsPrunePlanInput,
  ): MaintenanceCommandsPruneObservation[] | Promise<MaintenanceCommandsPruneObservation[]>
  planAppliedMutationsPrune?(
    input: AppliedMutationsPrunePlanInput,
  ): AppliedMutationsPruneObservation[] | Promise<AppliedMutationsPruneObservation[]>
  readQueuedMessagesExpiry?(
    input: QueuedMessagesExpiryReadInput,
  ): QueuedMessagesExpiryObservation[] | Promise<QueuedMessagesExpiryObservation[]>
  /**
   * The rows still past `job`'s cutoff, read after the job ran (POD-7035 guard
   * 4). Absent, no backlog is reported.
   */
  retentionBacklog?(job: RetentionJob, input: RetentionBacklogInput): number | Promise<number>
  readAutoArchiveCandidates?(
    input: AutoArchiveReadInput,
  ): IssueAutoArchiveObservation[] | Promise<IssueAutoArchiveObservation[]>
  readSessionAutoArchiveCandidates?(
    input: AutoArchiveReadInput,
  ): SessionAutoArchiveObservation[] | Promise<SessionAutoArchiveObservation[]>
  readWorktreeGcCandidates?(
    input: WorktreeGcReadInput,
  ): WorktreeGcObservation[] | Promise<WorktreeGcObservation[]>
  readDueAutomations?(
    nowIso: string,
  ): AutomationFireObservation[] | Promise<AutomationFireObservation[]>
  readStewardPollWindow?(): StewardPollObservation | null | Promise<StewardPollObservation | null>
  readConnectScanCandidates?(
    nowIso: string,
  ): ConnectScanObservation[] | Promise<ConnectScanObservation[]>
  apply(request: MaintenanceCommand): Promise<MaintenanceCommandReply>
}

/** A protocol/schema mismatch is terminal until this binary is upgraded. */
export class MaintenanceCompatibilityError extends Error {
  constructor(
    readonly expectedProtocolVersion: number,
    readonly expectedSchemaVersion: string,
  ) {
    super(
      `janitor compatibility mismatch (server protocol=${expectedProtocolVersion}, schema=${expectedSchemaVersion})`,
    )
    this.name = 'MaintenanceCompatibilityError'
  }
}

export interface JanitorMetrics {
  queueDepth: number
  coalescedJobs: number
  supersededJobs: number
  completedJobs: number
  failures: number
  maxJobAgeMs: number
  maxUninterruptedSliceMs: number
}

/** One fenced janitor generation. Durable facts are read locally; all writes are commands. */
export class JanitorService {
  private readonly generationId: string
  private readonly now: () => number
  private lease: ReadyLease | undefined
  private tickFlight: Promise<void> | undefined
  private tickCount = 0
  private progress = 0
  private readonly counters: JanitorCounters = {
    ticks: 0,
    applies: 0,
    applied: 0,
    alreadyApplied: 0,
    stale: 0,
    failures: 0,
    lastTickAt: null,
    lastProgressAt: null,
    maxBatchDeleted: 0,
    jobAgeMs: {},
    retentionBacklog: {},
    retentionStalled: [],
    queueDepth: 0,
    coalescedJobs: 0,
    supersededJobs: 0,
    completedJobs: 0,
    maxJobAgeMs: 0,
    maxUninterruptedSliceMs: 0,
  }
  private readonly jobStartedAt = new Map<string, number>()
  private readonly backlog: RetentionBacklog

  constructor(private readonly deps: JanitorDeps) {
    this.generationId = deps.generationId ?? `janitor_${randomUUID()}`
    this.now = deps.now ?? Date.now
    this.backlog = new RetentionBacklog(log, this.now)
  }

  /** POD-851 surface: queue-ish counters for acceptance probes. */
  snapshotCounters(): JanitorCounters {
    return {
      ...this.counters,
      jobAgeMs: { ...this.counters.jobAgeMs },
      retentionBacklog: this.backlog.snapshot(),
      retentionStalled: RETENTION_JOBS.filter((job) => this.backlog.stalled(job)),
    }
  }

  /** Monotonic state-machine progress token used to gate systemd watchdog pets. */
  progressVersion(): number {
    return this.progress
  }

  metrics(): JanitorMetrics {
    return this.snapshotCounters()
  }

  tick(): Promise<void> {
    if (this.tickFlight) {
      this.counters.coalescedJobs += 1
      return this.tickFlight
    }
    const enqueuedAt = performance.now()
    this.counters.queueDepth = 1
    this.advanceProgress()
    let flight!: Promise<void>
    const settle = (error?: unknown): void => {
      if (this.tickFlight === flight) this.tickFlight = undefined
      this.counters.queueDepth = 0
      this.counters.maxJobAgeMs = Math.max(
        this.counters.maxJobAgeMs,
        performance.now() - enqueuedAt,
      )
      if (error === undefined) {
        this.counters.completedJobs += 1
        this.advanceProgress()
      } else {
        this.counters.failures += 1
      }
    }
    flight = this.runTick().then(
      () => settle(),
      (error) => {
        settle(error)
        throw error
      },
    )
    this.tickFlight = flight
    return flight
  }

  private advanceProgress(): void {
    this.progress += 1
  }

  /** Measure only the synchronous call segment, never time spent awaiting I/O. */
  private invokeMeasured<T>(operation: () => T): T {
    const started = performance.now()
    try {
      return operation()
    } finally {
      this.counters.maxUninterruptedSliceMs = Math.max(
        this.counters.maxUninterruptedSliceMs,
        performance.now() - started,
      )
    }
  }

  private async runTick(): Promise<void> {
    const tickStarted = this.now()
    this.counters.ticks += 1
    this.counters.lastTickAt = new Date(tickStarted).toISOString()
    this.tickCount += 1

    if (!this.lease || Date.parse(this.lease.expiresAt) <= this.now() + LEASE_RENEW_AHEAD_MS) {
      const reply = await this.invokeMeasured(() =>
        this.deps.handshake({
          protocolVersion: MAINTENANCE_PROTOCOL_VERSION,
          schemaVersion: MAINTENANCE_SCHEMA_VERSION,
          generationId: this.generationId,
        }),
      )
      this.advanceProgress()
      if (reply.status === 'incompatible') {
        this.lease = undefined
        throw new MaintenanceCompatibilityError(
          reply.expectedProtocolVersion,
          reply.expectedSchemaVersion,
        )
      }
      if (reply.status === 'busy') {
        this.lease = undefined
        return
      }
      this.lease = reply
    }

    const lease = this.lease
    const nowMs = this.now()
    // Message expiry — every tick (high cadence durable work).
    await this.runMessageExpiry(lease, nowMs)

    // Housekeeping jobs — same tick for now; cadence knobs live here.
    if (this.tickCount % HOUSEKEEPING_EVERY_TICKS === 0) {
      await this.runEventLogPrune(lease, nowMs)
      await this.runChangeLogPrune(lease, nowMs)
      await this.runMaintenanceCommandsPrune(lease, nowMs)
      await this.runAppliedMutationsPrune(lease, nowMs)
      await this.runQueuedMessagesExpiry(lease, nowMs)
      await this.runAutoArchive(lease, nowMs)
      await this.runSessionAutoArchive(lease, nowMs)
      await this.runWorktreeGc(lease, nowMs)
      await this.runAutomationFires(lease, nowMs)
      await this.runStewardPoll(lease)
      await this.runConnectScans(lease, nowMs)
    }

    this.counters.jobAgeMs.tick = this.now() - tickStarted
  }

  private async runMessageExpiry(lease: ReadyLease, nowMs: number): Promise<void> {
    this.markJobStart('message-expiry', nowMs)
    const candidates = await this.invokeMeasured(() =>
      this.deps.readExpiryCandidates({
        now: new Date(nowMs).toISOString(),
        waitImplicitCutoff: new Date(nowMs - lease.messageWaitTtlMs).toISOString(),
        limit: CANDIDATE_LIMIT,
      }),
    )
    this.advanceProgress()
    this.counters.queueDepth = Math.max(1, candidates.length)
    for (const observed of candidates) {
      const cont = await this.applyOne({
        protocolVersion: MAINTENANCE_PROTOCOL_VERSION,
        schemaVersion: MAINTENANCE_SCHEMA_VERSION,
        jobKind: 'message-expiry',
        runKey: messageExpiryRunKey(observed),
        fencingToken: lease.fencingToken,
        observed,
      })
      this.advanceProgress()
      this.counters.queueDepth = Math.max(1, this.counters.queueDepth - 1)
      if (!cont) break
    }
    this.markJobEnd('message-expiry')
  }

  private async runEventLogPrune(lease: ReadyLease, nowMs: number): Promise<void> {
    if (!this.deps.planEventLogPrune) return
    this.markJobStart('event-log-prune', nowMs)
    const batches = await this.deps.planEventLogPrune({
      maxAgeDays: lease.eventRetentionMaxAgeDays,
      maxRows: lease.eventRetentionMaxRows,
      batchSize: EVENT_PRUNE_BATCH_ROWS,
      nowMs,
    })
    for (const observed of batches) {
      const cont = await this.applyOne({
        protocolVersion: MAINTENANCE_PROTOCOL_VERSION,
        schemaVersion: MAINTENANCE_SCHEMA_VERSION,
        jobKind: 'event-log-prune',
        runKey: eventLogPruneRunKey(observed),
        fencingToken: lease.fencingToken,
        observed,
      })
      if (!cont) break
    }
    this.markJobEnd('event-log-prune')
    await this.reportBacklog('event-log-prune', lease, nowMs)
  }

  private async runChangeLogPrune(lease: ReadyLease, nowMs: number): Promise<void> {
    if (!this.deps.planChangeLogPrune) return
    this.markJobStart('change-log-prune', nowMs)
    const batches = await this.deps.planChangeLogPrune({
      keepRows: lease.changeKeepRows,
      maxAgeMs: lease.changeMaxAgeMs,
      batchSize: CHANGE_PRUNE_BATCH_ROWS,
      nowMs,
    })
    for (const observed of batches) {
      const cont = await this.applyOne({
        protocolVersion: MAINTENANCE_PROTOCOL_VERSION,
        schemaVersion: MAINTENANCE_SCHEMA_VERSION,
        jobKind: 'change-log-prune',
        runKey: changeLogPruneRunKey(observed),
        fencingToken: lease.fencingToken,
        observed,
      })
      if (!cont) break
    }
    this.markJobEnd('change-log-prune')
    await this.reportBacklog('change-log-prune', lease, nowMs)
  }

  private async runMaintenanceCommandsPrune(lease: ReadyLease, nowMs: number): Promise<void> {
    if (!this.deps.planMaintenanceCommandsPrune) return
    this.markJobStart('maintenance-commands-prune', nowMs)
    const batches = await this.deps.planMaintenanceCommandsPrune({
      maxAgeMs: lease.maintenanceCommandMaxAgeMs,
      batchSize: MAINTENANCE_COMMAND_PRUNE_BATCH_ROWS,
      nowMs,
    })
    for (const observed of batches) {
      const cont = await this.applyOne({
        protocolVersion: MAINTENANCE_PROTOCOL_VERSION,
        schemaVersion: MAINTENANCE_SCHEMA_VERSION,
        jobKind: 'maintenance-commands-prune',
        runKey: maintenanceCommandsPruneRunKey(observed),
        fencingToken: lease.fencingToken,
        observed,
      })
      if (!cont) break
    }
    this.markJobEnd('maintenance-commands-prune')
    await this.reportBacklog('maintenance-commands-prune', lease, nowMs)
  }

  /** The mutation receipts past their horizon, in batches (POD-7035). */
  private async runAppliedMutationsPrune(lease: ReadyLease, nowMs: number): Promise<void> {
    if (!this.deps.planAppliedMutationsPrune) return
    this.markJobStart('applied-mutations-prune', nowMs)
    const batches = await this.deps.planAppliedMutationsPrune({
      maxAgeMs: lease.appliedMutationMaxAgeMs,
      batchSize: APPLIED_MUTATION_PRUNE_BATCH_ROWS,
      nowMs,
    })
    for (const observed of batches) {
      const cont = await this.applyOne({
        protocolVersion: MAINTENANCE_PROTOCOL_VERSION,
        schemaVersion: MAINTENANCE_SCHEMA_VERSION,
        jobKind: 'applied-mutations-prune',
        runKey: appliedMutationsPruneRunKey(observed),
        fencingToken: lease.fencingToken,
        observed,
      })
      if (!cont) break
    }
    this.markJobEnd('applied-mutations-prune')
    await this.reportBacklog('applied-mutations-prune', lease, nowMs)
  }

  /** Parked sessions' input queued past its horizon, one session per command (POD-7035). */
  private async runQueuedMessagesExpiry(lease: ReadyLease, nowMs: number): Promise<void> {
    if (!this.deps.readQueuedMessagesExpiry) return
    this.markJobStart('queued-messages-expiry', nowMs)
    const candidates = await this.deps.readQueuedMessagesExpiry({
      maxAgeMs: lease.queuedMessageMaxAgeMs,
      nowMs,
      limit: CANDIDATE_LIMIT,
    })
    for (const observed of candidates) {
      const cont = await this.applyOne({
        protocolVersion: MAINTENANCE_PROTOCOL_VERSION,
        schemaVersion: MAINTENANCE_SCHEMA_VERSION,
        jobKind: 'queued-messages-expiry',
        runKey: queuedMessagesExpiryRunKey(observed),
        fencingToken: lease.fencingToken,
        observed,
      })
      if (!cont) break
    }
    this.markJobEnd('queued-messages-expiry')
    await this.reportBacklog('queued-messages-expiry', lease, nowMs)
  }

  /**
   * Read and report the rows still past `job`'s cutoff (POD-7035 guard 4). A
   * failed read is logged and skipped: the gauge must never stop a tick.
   */
  private async reportBacklog(job: RetentionJob, lease: ReadyLease, nowMs: number): Promise<void> {
    if (!this.deps.retentionBacklog) return
    let pastCutoff: number
    try {
      pastCutoff = await this.deps.retentionBacklog(job, {
        eventRetentionMaxAgeDays: lease.eventRetentionMaxAgeDays,
        eventRetentionMaxRows: lease.eventRetentionMaxRows,
        changeKeepRows: lease.changeKeepRows,
        changeMaxAgeMs: lease.changeMaxAgeMs,
        maintenanceCommandMaxAgeMs: lease.maintenanceCommandMaxAgeMs,
        appliedMutationMaxAgeMs: lease.appliedMutationMaxAgeMs,
        queuedMessageMaxAgeMs: lease.queuedMessageMaxAgeMs,
        nowMs,
      })
    } catch (error) {
      log.warn('retention backlog read failed', { job, err: error })
      return
    }
    this.backlog.report(job, pastCutoff)
  }

  private async runAutoArchive(lease: ReadyLease, nowMs: number): Promise<void> {
    if (!this.deps.readAutoArchiveCandidates) return
    this.markJobStart('issue-auto-archive', nowMs)
    const candidates = await this.deps.readAutoArchiveCandidates({
      cutoffReadAt: new Date(nowMs - lease.autoArchiveReadWindowMs).toISOString(),
      limit: CANDIDATE_LIMIT,
    })
    for (const observed of candidates) {
      const cont = await this.applyOne({
        protocolVersion: MAINTENANCE_PROTOCOL_VERSION,
        schemaVersion: MAINTENANCE_SCHEMA_VERSION,
        jobKind: 'issue-auto-archive',
        runKey: issueAutoArchiveRunKey(observed),
        fencingToken: lease.fencingToken,
        observed,
      })
      if (!cont) break
    }
    this.markJobEnd('issue-auto-archive')
  }

  private async runSessionAutoArchive(lease: ReadyLease, nowMs: number): Promise<void> {
    if (!this.deps.readSessionAutoArchiveCandidates) return
    this.markJobStart('session-auto-archive', nowMs)
    const candidates = await this.deps.readSessionAutoArchiveCandidates({
      cutoffReadAt: new Date(nowMs - lease.autoArchiveReadWindowMs).toISOString(),
      limit: CANDIDATE_LIMIT,
    })
    for (const observed of candidates) {
      const cont = await this.applyOne({
        protocolVersion: MAINTENANCE_PROTOCOL_VERSION,
        schemaVersion: MAINTENANCE_SCHEMA_VERSION,
        jobKind: 'session-auto-archive',
        runKey: sessionAutoArchiveRunKey(observed),
        fencingToken: lease.fencingToken,
        observed,
      })
      if (!cont) break
    }
    this.markJobEnd('session-auto-archive')
  }

  /**
   * Propose reclaimable checkouts on finished issues (POD-564).
   *
   * `off` returns before the read, so the sweep costs nothing at all when the
   * operator has turned it off — and the mode is the LEASE's, so flipping the
   * setting takes effect on the next handshake without restarting the janitor.
   *
   * Everything this reads is a durable SQLite fact. Whether the directory is
   * clean, and whether a live agent is standing in it right now, are not facts
   * this process can know; the server re-reads both inside the mutation.
   */
  private async runWorktreeGc(lease: ReadyLease, nowMs: number): Promise<void> {
    if (!this.deps.readWorktreeGcCandidates) return
    const mode = lease.worktreeGcMode
    if (mode === 'off') return
    this.markJobStart('worktree-gc', nowMs)
    const candidates = await this.deps.readWorktreeGcCandidates({
      cutoffClosedAt: new Date(nowMs - lease.worktreeGcAfterDays * DAY_MS).toISOString(),
      mode,
      afterDays: lease.worktreeGcAfterDays,
      limit: CANDIDATE_LIMIT,
    })
    for (const observed of candidates) {
      const cont = await this.applyOne({
        protocolVersion: MAINTENANCE_PROTOCOL_VERSION,
        schemaVersion: MAINTENANCE_SCHEMA_VERSION,
        jobKind: 'worktree-gc',
        runKey: worktreeGcRunKey(observed),
        fencingToken: lease.fencingToken,
        observed,
      })
      if (!cont) break
    }
    this.markJobEnd('worktree-gc')
  }

  private async runAutomationFires(lease: ReadyLease, nowMs: number): Promise<void> {
    if (!this.deps.readDueAutomations) return
    this.markJobStart('automation-fire', nowMs)
    const due = await this.deps.readDueAutomations(new Date(nowMs).toISOString())
    for (const observed of due) {
      const cont = await this.applyOne({
        protocolVersion: MAINTENANCE_PROTOCOL_VERSION,
        schemaVersion: MAINTENANCE_SCHEMA_VERSION,
        jobKind: 'automation-fire',
        runKey: automationFireRunKey(observed),
        fencingToken: lease.fencingToken,
        observed,
      })
      if (!cont) break
    }
    this.markJobEnd('automation-fire')
  }

  private async runStewardPoll(lease: ReadyLease): Promise<void> {
    if (!this.deps.readStewardPollWindow) return
    this.markJobStart('steward-poll', this.now())
    const observed = await this.deps.readStewardPollWindow()
    if (observed) {
      await this.applyOne({
        protocolVersion: MAINTENANCE_PROTOCOL_VERSION,
        schemaVersion: MAINTENANCE_SCHEMA_VERSION,
        jobKind: 'steward-poll',
        runKey: stewardPollRunKey(observed),
        fencingToken: lease.fencingToken,
        observed,
      })
    }
    this.markJobEnd('steward-poll')
  }

  private async runConnectScans(lease: ReadyLease, nowMs: number): Promise<void> {
    if (!this.deps.readConnectScanCandidates) return
    this.markJobStart('connect-scan', nowMs)
    const candidates = await this.deps.readConnectScanCandidates(new Date(nowMs).toISOString())
    for (const observed of candidates) {
      const cont = await this.applyOne({
        protocolVersion: MAINTENANCE_PROTOCOL_VERSION,
        schemaVersion: MAINTENANCE_SCHEMA_VERSION,
        jobKind: 'connect-scan',
        runKey: connectScanRunKey(observed),
        fencingToken: lease.fencingToken,
        observed,
      })
      if (!cont) break
    }
    this.markJobEnd('connect-scan')
  }

  /** @returns false when the tick must stop (fence/lease/incompatible). */
  private async applyOne(command: MaintenanceCommand): Promise<boolean> {
    this.counters.applies += 1
    const reply = await this.deps.apply(command)
    if (reply.status === 'applied') {
      this.counters.applied += 1
      this.counters.lastProgressAt = new Date(this.now()).toISOString()
      if (reply.deleted !== undefined && reply.deleted > this.counters.maxBatchDeleted) {
        this.counters.maxBatchDeleted = reply.deleted
      }
      return true
    }
    if (reply.status === 'already-applied') {
      this.counters.alreadyApplied += 1
      return true
    }
    this.counters.stale += 1
    if (reply.reason === 'incompatible') {
      this.lease = undefined
      throw new MaintenanceCompatibilityError(
        MAINTENANCE_PROTOCOL_VERSION,
        MAINTENANCE_SCHEMA_VERSION,
      )
    }
    if (reply.reason === 'fenced' || reply.reason === 'lease-expired') {
      this.lease = undefined
      return false
    }
    return true
  }

  private markJobStart(job: string, nowMs: number): void {
    this.jobStartedAt.set(job, nowMs)
  }

  private markJobEnd(job: string): void {
    const started = this.jobStartedAt.get(job)
    if (started === undefined) return
    this.counters.jobAgeMs[job] = this.now() - started
  }
}

/** Message-expiry candidates from durable rows; never infers live session/runtime truth. */
export class MessageExpiryReader {
  constructor(private readonly source: JanitorReadSource) {}

  async read(input: ExpiryReadInput): Promise<ExpiryObservation[]> {
    return await this.source.scan(async (reads) => {
      const candidates: ExpiryObservation[] = []
      let implicitCursor: { createdAt: string; id: string } | undefined
      let explicitCursor: { expiresAt: string; id: string } | undefined
      let implicitDone = false
      let explicitDone = false
      let nextSource: 'implicit' | 'explicit' = 'implicit'
      await runTimeBudgetedJob(async () => {
        const remaining = input.limit - candidates.length
        if (remaining <= 0 || (implicitDone && explicitDone)) return 'done'
        const pageSize = Math.min(CANDIDATE_PAGE_SIZE, remaining)
        const source =
          nextSource === 'implicit' && !implicitDone
            ? 'implicit'
            : nextSource === 'explicit' && !explicitDone
              ? 'explicit'
              : implicitDone
                ? 'explicit'
                : 'implicit'
        nextSource = source === 'implicit' ? 'explicit' : 'implicit'
        const rows =
          source === 'implicit'
            ? await reads.implicitExpiryPage({
                cutoff: input.waitImplicitCutoff,
                limit: pageSize,
                ...(implicitCursor ? { after: implicitCursor } : {}),
              })
            : await reads.explicitExpiryPage({
                now: input.now,
                limit: pageSize,
                ...(explicitCursor ? { after: explicitCursor } : {}),
              })
        for (const row of rows) {
          candidates.push(
            MessageExpiryObservation.parse({
              messageId: row.id,
              // The page read only `stored` rows: the one status that expires.
              deliveryStatus: 'stored',
              lifecycle: row.lifecycle,
              createdAt: row.createdAt,
              expiresAt: row.expiresAt,
            }),
          )
        }
        const last = rows.at(-1)
        if (source === 'implicit') {
          implicitDone = rows.length < pageSize
          if (last) implicitCursor = { createdAt: last.createdAt, id: last.id }
        } else {
          explicitDone = rows.length < pageSize
          if (last) explicitCursor = { expiresAt: last.expiresAt as string, id: last.id }
        }
        if (candidates.length >= input.limit || (implicitDone && explicitDone)) return 'done'
        return 'continue'
      })
      return candidates
    })
  }
}

/** Plan event-log prune batches from durable facts under the time-budget helper. */
export class EventLogPrunePlanner {
  constructor(private readonly source: JanitorReadSource) {}

  /** Events past either limit now: older than the age cutoff or beyond the row cap. */
  async backlog(input: { maxAgeDays: number; maxRows: number; nowMs: number }): Promise<number> {
    const cutoff = new Date(input.nowMs - input.maxAgeDays * DAY_MS).toISOString()
    return await this.source.scan(async (reads) => {
      const capThroughId = (await reads.eventCapThroughId(input.maxRows)) ?? 0
      return await reads.eventPruneCount({ cutoff, capThroughId })
    })
  }

  async plan(input: EventLogPrunePlanInput): Promise<EventLogPruneObservation[]> {
    const cutoff = new Date(input.nowMs - input.maxAgeDays * 24 * 60 * 60 * 1000).toISOString()
    // One snapshot, the same three reads as ever: the cap, the head, and the
    // count only when there is a head.
    const facts = await this.source.scan(async (reads) => {
      const capThroughId = (await reads.eventCapThroughId(input.maxRows)) ?? 0
      const head = await reads.eventPruneHead({ cutoff, capThroughId })
      if (head == null) return undefined
      return { capThroughId, head, eligible: await reads.eventPruneCount({ cutoff, capThroughId }) }
    })
    if (facts === undefined || facts.eligible <= 0) return []
    const { head, eligible, capThroughId } = facts
    const batchCount = Math.ceil(eligible / input.batchSize)
    const batches: EventLogPruneObservation[] = []
    // Bound planning work: at most CANDIDATE_LIMIT batches per tick.
    // fromId advances with the retained head so a later tick never reuses a
    // completed batch's runKey after recovery (starvation fix).
    const limit = Math.min(batchCount, CANDIDATE_LIMIT)
    await runTimeBudgetedJob(() => {
      if (batches.length >= limit) return 'done'
      batches.push({
        maxAgeDays: input.maxAgeDays,
        maxRows: input.maxRows,
        cutoff,
        capThroughId,
        batchSize: input.batchSize,
        fromId: head + batches.length * input.batchSize,
      })
      return batches.length >= limit ? 'done' : 'continue'
    })
    return batches
  }
}

/** Plan the workspace's change-log prune batches from durable facts. */
export class ChangeLogPrunePlanner {
  constructor(
    private readonly source: JanitorReadSource,
    /** The workspace whose feed this plans; it rides on every batch as its tenant. */
    private readonly workspaceId: string,
  ) {}

  /** Change rows of the workspace's feed past the keep count or the age cutoff. */
  async backlog(input: { keepRows: number; maxAgeMs: number; nowMs: number }): Promise<number> {
    const feed = await this.source.scan(
      async (reads) => await reads.changeFeed(input.nowMs - input.maxAgeMs),
    )
    if (feed === undefined) return 0
    const thresholdSeq = Math.max(feed.headSeq - input.keepRows, feed.agedSeq ?? 0)
    return Math.max(0, thresholdSeq - feed.floorSeq + 1)
  }

  async plan(input: ChangeLogPrunePlanInput): Promise<ChangeLogPruneObservation[]> {
    // The feed's bounds and age threshold come from one snapshot.
    const feed = await this.source.scan(
      async (reads) => await reads.changeFeed(input.nowMs - input.maxAgeMs),
    )
    if (feed === undefined) return []
    // Appends commit contiguous seqs with the head; retention removes only a
    // prefix and advances the floor, so the eligible count is arithmetic.
    const thresholdSeq = Math.max(feed.headSeq - input.keepRows, feed.agedSeq ?? 0)
    const eligible = thresholdSeq - feed.floorSeq + 1
    if (eligible <= 0) return []
    const limit = Math.min(Math.ceil(eligible / input.batchSize), CANDIDATE_LIMIT)
    const batches: ChangeLogPruneObservation[] = []
    // Bound the plan to 100 batches. The durable floor gives recovery new
    // runKeys after a capped tick instead of starving the tail.
    await runTimeBudgetedJob(() => {
      batches.push({
        tenantId: this.workspaceId,
        keepRows: input.keepRows,
        maxAgeMs: input.maxAgeMs,
        thresholdSeq,
        batchSize: input.batchSize,
        fromSeq: feed.floorSeq + batches.length * input.batchSize,
      })
      return batches.length >= limit ? 'done' : 'continue'
    })
    return batches
  }
}

/** Plan maintenance_commands retention batches. */
export class MaintenanceCommandsPrunePlanner {
  constructor(private readonly source: JanitorReadSource) {}

  /** Receipts applied before the cutoff, counted through
   *  `idx_maintenance_commands_applied_at` (POD-7035). */
  async backlog(input: { maxAgeMs: number; nowMs: number }): Promise<number> {
    const cutoffAppliedAt = new Date(input.nowMs - input.maxAgeMs).toISOString()
    return await this.source.scan(async (reads) => await reads.commandPruneCount(cutoffAppliedAt))
  }

  async plan(
    input: MaintenanceCommandsPrunePlanInput,
  ): Promise<MaintenanceCommandsPruneObservation[]> {
    const cutoffAppliedAt = new Date(input.nowMs - input.maxAgeMs).toISOString()
    const facts = await this.source.scan(async (reads) => {
      const head = await reads.commandPruneHead(cutoffAppliedAt)
      if (head == null) return undefined
      return { head, eligible: await reads.commandPruneCount(cutoffAppliedAt) }
    })
    if (facts === undefined || facts.eligible <= 0) return []
    const { head, eligible } = facts
    const batchCount = Math.ceil(eligible / input.batchSize)
    const limit = Math.min(batchCount, CANDIDATE_LIMIT)
    const batches: MaintenanceCommandsPruneObservation[] = []
    await runTimeBudgetedJob(() => {
      if (batches.length >= limit) return 'done'
      batches.push({
        maxAgeMs: input.maxAgeMs,
        cutoffAppliedAt,
        batchSize: input.batchSize,
        fromRowId: head + batches.length * input.batchSize,
      })
      return batches.length >= limit ? 'done' : 'continue'
    })
    return batches
  }
}

/**
 * THE MUTATION RECEIPTS PAST THEIR HORIZON (POD-7035), in batches.
 *
 * The cutoff is rounded down to the hour. The run key carries it, so a cutoff
 * that moved with every 30-second tick would mint a new key, and a receipt in
 * `maintenance_commands`, for each tick that found a row or two newly aged; at
 * the hour a tick finds a whole hour's rows, in as few batches as they fill. The
 * server refuses a cutoff later than its own horizon, never an earlier one.
 *
 * Every read here seeks `idx_applied_mutations_applied_at`: the receipts' result
 * payloads are never touched.
 */
export class AppliedMutationsPrunePlanner {
  constructor(private readonly source: JanitorReadSource) {}

  private cutoff(input: { maxAgeMs: number; nowMs: number }): number {
    return Math.max(0, Math.floor((input.nowMs - input.maxAgeMs) / HOUR_MS) * HOUR_MS)
  }

  /** Receipts applied before the cutoff the prune runs at. */
  async backlog(input: { maxAgeMs: number; nowMs: number }): Promise<number> {
    const cutoff = this.cutoff(input)
    return await this.source.scan(async (reads) => await reads.receiptPruneCount(cutoff))
  }

  async plan(input: AppliedMutationsPrunePlanInput): Promise<AppliedMutationsPruneObservation[]> {
    const cutoffAppliedAt = this.cutoff(input)
    // One snapshot: the head, and the count only when there is a head.
    const facts = await this.source.scan(async (reads) => {
      const head = await reads.receiptPruneHead(cutoffAppliedAt)
      if (head == null) return undefined
      return { head, eligible: await reads.receiptPruneCount(cutoffAppliedAt) }
    })
    if (facts === undefined || facts.eligible <= 0) return []
    const { head, eligible } = facts
    const limit = Math.min(Math.ceil(eligible / input.batchSize), CANDIDATE_LIMIT)
    const batches: AppliedMutationsPruneObservation[] = []
    await runTimeBudgetedJob(() => {
      if (batches.length >= limit) return 'done'
      batches.push({
        maxAgeMs: input.maxAgeMs,
        cutoffAppliedAt,
        batchSize: input.batchSize,
        fromAppliedAt: head,
        batch: batches.length,
      })
      return batches.length >= limit ? 'done' : 'continue'
    })
    return batches
  }
}

/**
 * Sessions holding input queued past its horizon (POD-7035): one candidate per
 * session, oldest first, naming the newest such row it holds. Whether the
 * session is running, and so drains its own queue, is the server's to decide.
 */
export class QueuedMessagesExpiryReader {
  constructor(private readonly source: JanitorReadSource) {}

  /** Queued rows past the horizon, of every session, running ones included. */
  async backlog(input: { maxAgeMs: number; nowMs: number }): Promise<number> {
    const through = input.nowMs - input.maxAgeMs
    return await this.source.scan(async (reads) => await reads.queuedExpiryCount(through))
  }

  async read(input: QueuedMessagesExpiryReadInput): Promise<QueuedMessagesExpiryObservation[]> {
    const rows = await this.source.scan(
      async (reads) =>
        await reads.queuedExpiryPage({ through: input.nowMs - input.maxAgeMs, limit: input.limit }),
    )
    return rows.map((row) => ({
      sessionId: asSessionId(row.sessionId),
      maxAgeMs: input.maxAgeMs,
      throughQueuedAt: row.through,
      rows: row.rows,
    }))
  }
}

/**
 * WHOSE "read" the archival sweep means (POD-1210, after POD-1076/POD-1077).
 *
 * `sessions.read_at` and `issues.read_at` were SINGLETON columns when auto-archive
 * was written, so the question never came up. They are now `(user_id, entity_id)`
 * rows and the sweep has to name a reader. Three readings were on the table:
 *
 *   - read by ANY user — cheapest to write (an EXISTS, or MIN(read_at)), and
 *     WRONG. `issues.archived` / `sessions.archived` are still SHARED columns:
 *     archiving is a fact about the instance, not about a viewer. Under ANY, one
 *     person opening a done issue and letting it age out hides it from everyone
 *     else, including people who have never seen it. A sweep that removes work
 *     from a colleague's board because someone else read it is the failure mode
 *     auto-archive's read-gate exists to prevent.
 *   - read by ALL users — never fires. An absent row means "never read", there is
 *     no per-issue membership roster to bound "all" against, and one dormant
 *     account freezes archival instance-wide. It also cannot be asked of a
 *     durable snapshot: the janitor would have to enumerate the user table and
 *     assert a negative.
 *   - read by THE VIEWER the shared flag speaks for — what we do.
 *
 * That reader is not a free choice here, it is the one the AUTHORITY already
 * picked: `IssueAttention.tryAutoArchiveObserved` and
 * `SessionService.tryAutoArchiveStoppedObserved` revalidate the proposal
 * against the task's assignee and the session's owner. A janitor that observed
 * any other reader would emit proposals the server rejects as `precondition` —
 * auto-archive would be dead a SECOND time, silently, with a green integration
 * test. The janitor observes; the server decides; both must ask the same person.
 *
 * POD-1229 closes the half of this POD-1210 left open. The agreement between
 * THIS constant and the server's `broadcastViewer()` used to be a coincidence of
 * two independent spellings of `firstAdminMemberId()`, invisible on the wire and
 * therefore untestable: change one and the sweep goes silently empty. The reader
 * now RIDES on the observation as `readerUserId`, and the server refuses any
 * observation that names someone other than the viewer it archives for. The
 * policy is unchanged; what changed is that a disagreement is now a refusal with
 * a reason instead of a sweep that finds nothing.
 */
/*
 * POD-6291 names THE VIEWER per task: the task's ASSIGNEE (`issues.owner_user_id`),
 * the person accountable for it. On a one-member instance that is the first
 * admin, exactly as before; with two members, Bob's read never archives Alice's
 * finished task. The server revalidates against the same column
 * (`IssueAttention.tryAutoArchiveObserved`), so both still ask the same person.
 */

/**
 * Durable auto-archive candidates only — closed + read past cutoff + not archived.
 * Live unread revalidation happens on the server at apply time.
 */
/** Durable read + stopped session candidates. */
export class SessionAutoArchiveReader {
  constructor(private readonly source: JanitorReadSource) {}

  /** The reader is each session's OWNER (POD-6285): sessions are private, so
   *  only the owner's read can say they are done with it. */
  async read(input: AutoArchiveReadInput): Promise<SessionAutoArchiveObservation[]> {
    const rows = await this.source.scan(
      async (reads) =>
        await reads.sessionArchivePage({ cutoffReadAt: input.cutoffReadAt, limit: input.limit }),
    )
    return rows.map((row) => ({
      sessionId: asSessionId(row.id),
      issueId: row.issueId === null ? null : asIssueId(row.issueId),
      stoppedAt: row.stoppedAt,
      // The reader, not the timestamp (POD-1229): the server re-derives the
      // owner's read state authoritatively and refuses an observation that
      // names anyone else. The read time still drives the candidate query and
      // its ordering; it just no longer rides the wire.
      readerUserId: asUserId(row.ownerUserId),
      archived: false as const,
    }))
  }
}

export class IssueAutoArchiveReader {
  constructor(private readonly source: JanitorReadSource) {}

  /** The reader is each task's ASSIGNEE (POD-6291). */
  async read(input: AutoArchiveReadInput): Promise<IssueAutoArchiveObservation[]> {
    return await this.source.scan(async (reads) => {
      const candidates: IssueAutoArchiveObservation[] = []
      let cursor: { readAt: string; id: string } | undefined
      let done = false
      await runTimeBudgetedJob(async () => {
        if (done || candidates.length >= input.limit) return 'done'
        const pageSize = Math.min(CANDIDATE_PAGE_SIZE, input.limit - candidates.length)
        // The keyset key moves WITH the assignee's read timestamp. It stays a
        // TOTAL order because the reader is pinned to ONE user per issue, so at
        // most one row per issue survives the join and the issue id breaks every
        // tie in `read_at` uniquely.
        const rows = await reads.issueArchivePage({
          cutoffReadAt: input.cutoffReadAt,
          limit: pageSize,
          ...(cursor ? { after: cursor } : {}),
        })
        for (const row of rows) {
          candidates.push({
            issueId: asIssueId(row.id),
            stage: row.stage,
            closedReason: row.closedReason,
            // See the session reader: the wire carries WHOSE read gated this,
            // not the timestamp, which is what the query filters and the keyset
            // cursor orders by.
            readerUserId: asUserId(row.ownerUserId),
            archived: false,
            deletedAt: null,
          })
        }
        const last = rows.at(-1)
        done = rows.length < pageSize
        if (last) cursor = { readAt: last.readAt, id: last.id }
        return done || candidates.length >= input.limit ? 'done' : 'continue'
      })
      return candidates
    })
  }
}

/**
 * Reclaimable checkouts on finished issues (POD-564).
 *
 * NO `parent_id IS NULL` GATE — and that absence is the point, not an oversight
 * copied wrong from the two archive readers above. `sweepAutoArchive` is scoped
 * to top-level issues, so every sub-issue's worktree is permanently outside the
 * archive door's reach; they are a large share of what is actually on the disk.
 * Archived rows are in scope for the same reason: POD-567 frees on archive, so
 * one that still has a path is one whose free was refused.
 *
 * The live-session clause is a durable APPROXIMATION here — `sessions.status`
 * is the last state the server wrote, and the cwd match is `isMemberCwd`'s
 * prefix rule spelled in SQL. It exists to keep the janitor from proposing work
 * that will obviously be refused, and it is not the guard: the server re-reads
 * the live registry at apply time, and that read is the one that decides.
 */
export class WorktreeGcReader {
  constructor(private readonly source: JanitorReadSource) {}

  async read(input: WorktreeGcReadInput): Promise<WorktreeGcObservation[]> {
    return await this.source.scan(async (reads) => {
      const candidates: WorktreeGcObservation[] = []
      let cursor: { closedAt: string; id: string } | undefined
      let done = false
      await runTimeBudgetedJob(async () => {
        if (done || candidates.length >= input.limit) return 'done'
        const pageSize = Math.min(CANDIDATE_PAGE_SIZE, input.limit - candidates.length)
        const rows = await reads.worktreeGcPage({
          cutoffClosedAt: input.cutoffClosedAt,
          limit: pageSize,
          ...(cursor ? { after: cursor } : {}),
        })
        for (const row of rows) {
          candidates.push({
            issueId: asIssueId(row.id),
            worktreePath: row.worktreePath,
            stage: row.stage,
            closedReason: row.closedReason,
            closedAt: row.closedAt,
            deletedAt: null,
            mode: input.mode,
            afterDays: input.afterDays,
          })
        }
        const last = rows.at(-1)
        done = rows.length < pageSize
        if (last) cursor = { closedAt: last.closedAt, id: last.id }
        return done || candidates.length >= input.limit ? 'done' : 'continue'
      })
      return candidates
    })
  }
}

/** Due automations from durable schedule state (overlap revalidated at apply). */
export class AutomationDueReader {
  constructor(private readonly source: JanitorReadSource) {}

  async read(nowIso: string): Promise<AutomationFireObservation[]> {
    const rows = await this.source.scan(
      async (reads) => await reads.dueAutomations({ now: nowIso, limit: CANDIDATE_LIMIT }),
    )
    return rows.map((row) => ({
      automationId: asAutomationId(row.id),
      enabled: true as const,
      nextRunAt: row.nextRunAt,
      scheduleKind: row.scheduleKind,
      cron: row.cron,
      lastSessionId: null,
    }))
  }
}

/** Steward poll window from durable cursor + event log head. */
export class StewardPollReader {
  constructor(private readonly source: JanitorReadSource) {}

  async read(): Promise<StewardPollObservation | null> {
    const { raw, max } = await this.source.scan(async (reads) => ({
      raw: await reads.stewardCursor(),
      max: await reads.maxEventId(),
    }))
    if (max <= 0) return null
    const fromCursor = raw !== undefined && Number.isFinite(Number(raw)) ? Number(raw) : 0
    if (max <= fromCursor) return null
    return { fromCursor, toEventId: max }
  }
}

/**
 * Automatic shallow connect-scan candidates [POD-925].
 *
 * Delay-not-lose: do NOT filter by wall-clock freshness of last_seen_at.
 * lastSeenAt only updates on daemon handshake, so a still-connected machine
 * may be hours old. Candidacy is "any non-local machine"; the runKey is
 * connect-scan/{machineId}/{lastSeenAt}, so each handshake fact is applied
 * once and a late janitor recovery still sees the durable connection fact.
 * Server revalidates that lastSeenAt still matches at apply.
 */
export class ConnectScanReader {
  constructor(private readonly source: JanitorReadSource) {}

  async read(
    _nowIso: string,
    localMachineId: string | null = 'local',
  ): Promise<ConnectScanObservation[]> {
    const rows = await this.source.scan(
      async (reads) => await reads.remoteMachines({ localMachineId, limit: CANDIDATE_LIMIT }),
    )
    return rows.map((row) => ({
      machineId: asMachineId(row.id),
      lastSeenAt: row.lastSeenAt,
      deep: false as const,
    }))
  }
}

export interface MaintenanceHttpClient {
  handshake(request: MaintenanceHandshake): Promise<MaintenanceHandshakeReply>
  apply(request: MaintenanceCommand): Promise<MaintenanceCommandReply>
}

export function createMaintenanceHttpClient(
  serverUrl: string,
  token: string,
  fetchFn: typeof fetch = fetch,
  requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  shutdownSignal?: AbortSignal,
): MaintenanceHttpClient {
  const base = serverUrl.replace(/^ws:/, 'http:').replace(/^wss:/, 'https:').replace(/\/$/, '')
  const post = async (path: string, body: unknown): Promise<unknown> => {
    const timeoutSignal = AbortSignal.timeout(requestTimeoutMs)
    const signal = shutdownSignal ? AbortSignal.any([shutdownSignal, timeoutSignal]) : timeoutSignal
    const response = await fetchFn(`${base}${path}`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
      signal,
    })
    const payload = await response.json()
    if (!response.ok) {
      throw new Error(`maintenance request failed (${response.status}): ${JSON.stringify(payload)}`)
    }
    return payload
  }
  return {
    handshake: async (request) =>
      MaintenanceHandshakeReply.parse(await post('/maintenance/handshake', request)),
    apply: async (request) =>
      MaintenanceCommandReply.parse(await post('/maintenance/command', request)),
  }
}

export interface JanitorHandle {
  service: JanitorService
  close(): Promise<void>
}

/**
 * What a failed tick means. Exported so the ONE branch that can end a process is
 * testable without a database, an HTTP server and a schema-advanced fixture.
 *
 * A mid-run `MaintenanceCompatibilityError` is the §8 REFUSAL class. As its own
 * OS process the janitor exits 78 and its supervisor parks it stopped. CO-HOSTED
 * INSIDE THE SERVER (POD-2505) that same exit would take the server down, and
 * the parent — reading 78 — would park the SERVER refused, permanently. So a
 * host that can own the refusal passes `onCompatibilityRefusal` and this never
 * reaches `exit`. Every other error is a delay, not a verdict.
 */
export function handleTickError(
  error: unknown,
  deps: {
    stopTicking: () => void
    onCompatibilityRefusal?: (error: Error) => void
    exit?: (code: number) => void
  },
): void {
  if (!(error instanceof MaintenanceCompatibilityError)) {
    log.warn('tick delayed', { err: error })
    return
  }
  if (deps.onCompatibilityRefusal) {
    // Stop ticking: a refusal is not retried until the next successful update.
    deps.stopTicking()
    log.error('maintenance compatibility check failed — janitor stopping (degraded)', {
      err: error,
    })
    deps.onCompatibilityRefusal(error)
    return
  }
  log.error('maintenance compatibility check failed — exiting', { err: error })
  const exit = deps.exit ?? ((code: number) => process.exit(code))
  exit(78)
}

export async function startJanitor(options: {
  serverUrl: string
  token: string
  /**
   * The database the janitor serves, opened by its host on the store's engine
   * (`apps/server/src/janitor-database.ts`). The janitor owns it from here: it
   * closes it when it refuses to start and when it is closed.
   */
  database: JanitorDatabase
  tickMs?: number
  localMachineId?: string | null
  /**
   * What a MID-RUN compatibility refusal means for this host process.
   *
   * As its own OS process the janitor exits 78 (EX_CONFIG) and its supervisor
   * parks it stopped — that is the §8 REFUSAL class. But the janitor is now
   * normally CO-HOSTED INSIDE THE SERVER (POD-2505), where `process.exit(78)`
   * would take the server down with it and the parent would park the SERVER
   * refused: a schema check on a background housekeeping loop would end all
   * serving, permanently, which is the exact inverse of the policy. A host that
   * passes this callback owns the refusal instead; the default is the standalone
   * exit that existing supervision expects.
   */
  onCompatibilityRefusal?: (error: Error) => void
}): Promise<JanitorHandle> {
  const { database } = options
  const shutdown = new AbortController()
  const client = createMaintenanceHttpClient(
    options.serverUrl,
    options.token,
    fetch,
    undefined,
    shutdown.signal,
  )
  let workspace: JanitorWorkspace
  try {
    workspace = await servedWorkspace(database)
  } catch (error) {
    await database.close()
    throw error
  }
  const expiryReader = new MessageExpiryReader(workspace)
  const eventPlanner = new EventLogPrunePlanner(workspace)
  const changePlanner = new ChangeLogPrunePlanner(workspace, workspace.id)
  const commandPlanner = new MaintenanceCommandsPrunePlanner(workspace)
  const receiptPlanner = new AppliedMutationsPrunePlanner(workspace)
  const queuedReader = new QueuedMessagesExpiryReader(workspace)
  const archiveReader = new IssueAutoArchiveReader(workspace)
  const sessionArchiveReader = new SessionAutoArchiveReader(workspace)
  const worktreeGcReader = new WorktreeGcReader(workspace)
  const automationReader = new AutomationDueReader(workspace)
  const stewardReader = new StewardPollReader(workspace)
  const connectScanReader = new ConnectScanReader(workspace)
  const service = new JanitorService({
    handshake: client.handshake,
    apply: client.apply,
    readExpiryCandidates: (input) => expiryReader.read(input),
    planEventLogPrune: (input) => eventPlanner.plan(input),
    planChangeLogPrune: (input) => changePlanner.plan(input),
    planMaintenanceCommandsPrune: (input) => commandPlanner.plan(input),
    planAppliedMutationsPrune: (input) => receiptPlanner.plan(input),
    readQueuedMessagesExpiry: (input) => queuedReader.read(input),
    retentionBacklog: (job, input) => {
      switch (job) {
        case 'event-log-prune':
          return eventPlanner.backlog({
            maxAgeDays: input.eventRetentionMaxAgeDays,
            maxRows: input.eventRetentionMaxRows,
            nowMs: input.nowMs,
          })
        case 'change-log-prune':
          return changePlanner.backlog({
            keepRows: input.changeKeepRows,
            maxAgeMs: input.changeMaxAgeMs,
            nowMs: input.nowMs,
          })
        case 'maintenance-commands-prune':
          return commandPlanner.backlog({
            maxAgeMs: input.maintenanceCommandMaxAgeMs,
            nowMs: input.nowMs,
          })
        case 'applied-mutations-prune':
          return receiptPlanner.backlog({
            maxAgeMs: input.appliedMutationMaxAgeMs,
            nowMs: input.nowMs,
          })
        case 'queued-messages-expiry':
          return queuedReader.backlog({
            maxAgeMs: input.queuedMessageMaxAgeMs,
            nowMs: input.nowMs,
          })
      }
    },
    readAutoArchiveCandidates: (input) => archiveReader.read(input),
    readSessionAutoArchiveCandidates: (input) => sessionArchiveReader.read(input),
    readWorktreeGcCandidates: (input) => worktreeGcReader.read(input),
    readDueAutomations: (nowIso) => automationReader.read(nowIso),
    readStewardPollWindow: () => stewardReader.read(),
    readConnectScanCandidates: (nowIso) => connectScanReader.read(nowIso, options.localMachineId),
  })
  try {
    await service.tick()
  } catch (error) {
    if (error instanceof MaintenanceCompatibilityError) {
      await database.close()
      throw error
    }
    log.warn('initial tick delayed', { err: error })
  }
  const timer = setInterval(() => {
    void service.tick().catch((error) =>
      handleTickError(error, {
        stopTicking: () => clearInterval(timer),
        ...(options.onCompatibilityRefusal
          ? { onCompatibilityRefusal: options.onCompatibilityRefusal }
          : {}),
      }),
    )
  }, options.tickMs ?? DEFAULT_TICK_MS)
  return {
    service,
    close: async () => {
      clearInterval(timer)
      shutdown.abort(new Error('janitor shutting down'))
      await database.close()
    },
  }
}

/**
 * THE WORKSPACE THE JANITOR SERVES (POD-7021), validated at boot.
 *
 * The one cross-workspace read lists the workspaces with a feed; every reader
 * reads that workspace's rows only. A command does not name its workspace yet,
 * and the server applies it in its own store, so the janitor serves a database
 * of one workspace (every self-hosted install) and refuses to start on one of
 * several: observing a second workspace would hand its rows to the first's
 * store. Commands that name their workspace (POD-6962) lift this and run each
 * workspace's jobs in turn. The workspace must also have an active admin, the
 * member the server acts as.
 */
async function servedWorkspace(database: JanitorDatabase): Promise<JanitorWorkspace> {
  const workspaces = await database.workspacesWithFeed()
  if (workspaces.length !== 1) {
    throw new Error(
      `janitor serves a database of one workspace; this one has ${workspaces.length} with a feed`,
    )
  }
  const [workspace] = workspaces as [JanitorWorkspace]
  const admin = await workspace.scan(async (reads) => await reads.earliestAdminId())
  if (admin === undefined) throw new Error('janitor requires an active admin member')
  return workspace
}

// Re-export constants used by tests and planners for local defaults.
export {
  AUTO_ARCHIVE_READ_WINDOW_MS,
  CHANGE_KEEP_ROWS,
  CHANGE_MAX_AGE_MS,
  CHANGE_PRUNE_BATCH_ROWS,
  EVENT_PRUNE_BATCH_ROWS,
  EVENT_RETENTION_MAX_AGE_DAYS,
  EVENT_RETENTION_MAX_ROWS,
  MAINTENANCE_COMMAND_MAX_AGE_MS,
  MAINTENANCE_COMMAND_PRUNE_BATCH_ROWS,
}

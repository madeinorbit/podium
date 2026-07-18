import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import {
  AUTO_ARCHIVE_READ_WINDOW_MS,
  CHANGE_KEEP_ROWS,
  CHANGE_MAX_AGE_MS,
  CHANGE_PRUNE_BATCH_ROWS,
  changeLogPruneRunKey,
  type ChangeLogPruneObservation,
  EVENT_PRUNE_BATCH_ROWS,
  EVENT_RETENTION_MAX_AGE_DAYS,
  EVENT_RETENTION_MAX_ROWS,
  eventLogPruneRunKey,
  type EventLogPruneObservation,
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
  maintenanceCommandsPruneRunKey,
  type MessageExpiryObservation as ExpiryObservation,
  MessageExpiryObservation,
  messageExpiryRunKey,
} from '@podium/protocol'
import { stateDir } from '@podium/runtime/config'
import { openDatabase, type SqlDatabase } from '@podium/runtime/sqlite'
import { runTimeBudgetedJob } from '@podium/runtime/time-budget'

const CANDIDATE_LIMIT = 100
const CANDIDATE_PAGE_SIZE = 25
const LEASE_RENEW_AHEAD_MS = 30_000
const DEFAULT_TICK_MS = 30_000
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000
/** How often housekeeping cadence jobs fire relative to message-expiry ticks. */
const HOUSEKEEPING_EVERY_TICKS = 1

type ReadyLease = Extract<MaintenanceHandshakeReply, { status: 'ready' }>

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

export interface AutoArchiveReadInput {
  cutoffReadAt: string
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
  readAutoArchiveCandidates?(
    input: AutoArchiveReadInput,
  ): IssueAutoArchiveObservation[] | Promise<IssueAutoArchiveObservation[]>
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

/** One fenced janitor generation. Durable facts are read locally; all writes are commands. */
export class JanitorService {
  private readonly generationId: string
  private readonly now: () => number
  private lease: ReadyLease | undefined
  private tickFlight: Promise<void> | undefined
  private tickCount = 0
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
  }
  private readonly jobStartedAt = new Map<string, number>()

  constructor(private readonly deps: JanitorDeps) {
    this.generationId = deps.generationId ?? `janitor_${randomUUID()}`
    this.now = deps.now ?? Date.now
  }

  /** POD-851 surface: queue-ish counters for acceptance probes. */
  snapshotCounters(): JanitorCounters {
    return {
      ...this.counters,
      jobAgeMs: { ...this.counters.jobAgeMs },
    }
  }

  tick(): Promise<void> {
    if (this.tickFlight) return this.tickFlight
    const flight = this.runTick()
    this.tickFlight = flight
    const clear = () => {
      if (this.tickFlight === flight) this.tickFlight = undefined
    }
    void flight.then(clear, clear)
    return flight
  }

  private async runTick(): Promise<void> {
    const tickStarted = this.now()
    this.counters.ticks += 1
    this.counters.lastTickAt = new Date(tickStarted).toISOString()
    this.tickCount += 1

    if (!this.lease || Date.parse(this.lease.expiresAt) <= this.now() + LEASE_RENEW_AHEAD_MS) {
      const reply = await this.deps.handshake({
        protocolVersion: MAINTENANCE_PROTOCOL_VERSION,
        schemaVersion: MAINTENANCE_SCHEMA_VERSION,
        generationId: this.generationId,
      })
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
      await this.runAutoArchive(lease, nowMs)
    }

    this.counters.jobAgeMs.tick = this.now() - tickStarted
  }

  private async runMessageExpiry(lease: ReadyLease, nowMs: number): Promise<void> {
    this.markJobStart('message-expiry', nowMs)
    const candidates = await this.deps.readExpiryCandidates({
      now: new Date(nowMs).toISOString(),
      waitImplicitCutoff: new Date(nowMs - lease.messageWaitTtlMs).toISOString(),
      limit: CANDIDATE_LIMIT,
    })
    for (const observed of candidates) {
      const cont = await this.applyOne({
        protocolVersion: MAINTENANCE_PROTOCOL_VERSION,
        schemaVersion: MAINTENANCE_SCHEMA_VERSION,
        jobKind: 'message-expiry',
        runKey: messageExpiryRunKey(observed),
        fencingToken: lease.fencingToken,
        observed,
      })
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

/** Read-only WAL candidate reader; never infers live session/runtime truth. */
export class MessageExpiryReader {
  constructor(private readonly db: SqlDatabase) {}

  async read(input: ExpiryReadInput): Promise<ExpiryObservation[]> {
    const candidates: ExpiryObservation[] = []
    let implicitCursor: { createdAt: string; id: string } | undefined
    let explicitCursor: { expiresAt: string; id: string } | undefined
    let implicitDone = false
    let explicitDone = false
    let nextSource: 'implicit' | 'explicit' = 'implicit'
    await runTimeBudgetedJob(() => {
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
          ? this.readImplicitPage(input.waitImplicitCutoff, pageSize, implicitCursor)
          : this.readExplicitPage(input.now, pageSize, explicitCursor)
      for (const row of rows) {
        candidates.push(
          MessageExpiryObservation.parse({
            messageId: row.id,
            status: row.status,
            lifecycle: row.lifecycle,
            createdAt: row.created_at,
            expiresAt: row.expires_at,
          }),
        )
      }
      const last = rows.at(-1)
      if (source === 'implicit') {
        implicitDone = rows.length < pageSize
        if (last) {
          implicitCursor = { createdAt: last.created_at as string, id: last.id as string }
        }
      } else {
        explicitDone = rows.length < pageSize
        if (last) {
          explicitCursor = { expiresAt: last.expires_at as string, id: last.id as string }
        }
      }
      if (candidates.length >= input.limit || (implicitDone && explicitDone)) return 'done'
      return 'continue'
    })
    return candidates
  }

  private readImplicitPage(
    cutoff: string,
    limit: number,
    cursor?: { createdAt: string; id: string },
  ): Record<string, unknown>[] {
    const params: Array<string | number> = [cutoff]
    const after = cursor ? 'AND (created_at, id) > (?, ?)' : ''
    if (cursor) params.push(cursor.createdAt, cursor.id)
    params.push(limit)
    return this.db
      .prepare(
        `SELECT id, status, lifecycle, created_at, expires_at
         FROM messages INDEXED BY idx_messages_expiry_implicit
         WHERE status = 'queued' AND lifecycle = 'wait' AND expires_at IS NULL
           AND created_at <= ? ${after}
         ORDER BY created_at ASC, id ASC
         LIMIT ?`,
      )
      .all(...params) as Record<string, unknown>[]
  }

  private readExplicitPage(
    now: string,
    limit: number,
    cursor?: { expiresAt: string; id: string },
  ): Record<string, unknown>[] {
    const params: Array<string | number> = [now]
    const after = cursor ? 'AND (expires_at, id) > (?, ?)' : ''
    if (cursor) params.push(cursor.expiresAt, cursor.id)
    params.push(limit)
    return this.db
      .prepare(
        `SELECT id, status, lifecycle, created_at, expires_at
         FROM messages INDEXED BY idx_messages_expiry_explicit
         WHERE status = 'queued' AND expires_at IS NOT NULL AND expires_at <= ? ${after}
         ORDER BY expires_at ASC, id ASC
         LIMIT ?`,
      )
      .all(...params) as Record<string, unknown>[]
  }
}

/** Plan event-log prune batches from durable WAL facts under the time-budget helper. */
export class EventLogPrunePlanner {
  constructor(private readonly db: SqlDatabase) {}

  async plan(input: EventLogPrunePlanInput): Promise<EventLogPruneObservation[]> {
    const cutoff = new Date(
      input.nowMs - input.maxAgeDays * 24 * 60 * 60 * 1000,
    ).toISOString()
    const cap = this.db
      .prepare('SELECT id FROM podium_events ORDER BY id DESC LIMIT 1 OFFSET ?')
      .get(input.maxRows) as { id: number } | undefined
    const capThroughId = cap?.id ?? 0
    const eligible = this.db
      .prepare(
        `SELECT COUNT(*) AS n FROM podium_events WHERE ts < ? OR id <= ?`,
      )
      .get(cutoff, capThroughId) as { n: number }
    if (eligible.n <= 0) return []
    const batchCount = Math.ceil(eligible.n / input.batchSize)
    const batches: EventLogPruneObservation[] = []
    // Bound planning work: at most CANDIDATE_LIMIT batches per tick.
    const limit = Math.min(batchCount, CANDIDATE_LIMIT)
    await runTimeBudgetedJob(() => {
      if (batches.length >= limit) return 'done'
      batches.push({
        maxAgeDays: input.maxAgeDays,
        maxRows: input.maxRows,
        cutoff,
        capThroughId,
        batchSize: input.batchSize,
        batchIndex: batches.length,
      })
      return batches.length >= limit ? 'done' : 'continue'
    })
    return batches
  }
}

/** Plan change-log prune batches from durable WAL facts. */
export class ChangeLogPrunePlanner {
  constructor(private readonly db: SqlDatabase) {}

  async plan(input: ChangeLogPrunePlanInput): Promise<ChangeLogPruneObservation[]> {
    const maxSeq = (
      this.db.prepare('SELECT COALESCE(MAX(seq), 0) AS m FROM changes').get() as { m: number }
    ).m
    const rowCapSeq = maxSeq - input.keepRows
    const aged = this.db
      .prepare(
        'SELECT MAX(seq) AS seq FROM changes WHERE event_time < ?',
      )
      .get(input.nowMs - input.maxAgeMs) as { seq: number | null }
    const thresholdSeq = Math.max(rowCapSeq, aged.seq ?? 0)
    if (thresholdSeq <= 0) return []
    const eligible = (
      this.db
        .prepare('SELECT COUNT(*) AS n FROM changes WHERE seq <= ?')
        .get(thresholdSeq) as { n: number }
    ).n
    if (eligible <= 0) return []
    const batchCount = Math.ceil(eligible / input.batchSize)
    const limit = Math.min(batchCount, CANDIDATE_LIMIT)
    const batches: ChangeLogPruneObservation[] = []
    await runTimeBudgetedJob(() => {
      if (batches.length >= limit) return 'done'
      batches.push({
        keepRows: input.keepRows,
        maxAgeMs: input.maxAgeMs,
        thresholdSeq,
        batchSize: input.batchSize,
        batchIndex: batches.length,
      })
      return batches.length >= limit ? 'done' : 'continue'
    })
    return batches
  }
}

/** Plan maintenance_commands retention batches. */
export class MaintenanceCommandsPrunePlanner {
  constructor(private readonly db: SqlDatabase) {}

  async plan(
    input: MaintenanceCommandsPrunePlanInput,
  ): Promise<MaintenanceCommandsPruneObservation[]> {
    const cutoffAppliedAt = new Date(input.nowMs - input.maxAgeMs).toISOString()
    const eligible = (
      this.db
        .prepare('SELECT COUNT(*) AS n FROM maintenance_commands WHERE applied_at < ?')
        .get(cutoffAppliedAt) as { n: number }
    ).n
    if (eligible <= 0) return []
    const batchCount = Math.ceil(eligible / input.batchSize)
    const limit = Math.min(batchCount, CANDIDATE_LIMIT)
    const batches: MaintenanceCommandsPruneObservation[] = []
    await runTimeBudgetedJob(() => {
      if (batches.length >= limit) return 'done'
      batches.push({
        maxAgeMs: input.maxAgeMs,
        cutoffAppliedAt,
        batchSize: input.batchSize,
        batchIndex: batches.length,
      })
      return batches.length >= limit ? 'done' : 'continue'
    })
    return batches
  }
}

/**
 * Durable auto-archive candidates only — closed + read past cutoff + not archived.
 * Live unread revalidation happens on the server at apply time.
 */
export class IssueAutoArchiveReader {
  constructor(private readonly db: SqlDatabase) {}

  async read(input: AutoArchiveReadInput): Promise<IssueAutoArchiveObservation[]> {
    const candidates: IssueAutoArchiveObservation[] = []
    let cursor: { readAt: string; id: string } | undefined
    let done = false
    await runTimeBudgetedJob(() => {
      if (done || candidates.length >= input.limit) return 'done'
      const pageSize = Math.min(CANDIDATE_PAGE_SIZE, input.limit - candidates.length)
      const params: Array<string | number> = [input.cutoffReadAt]
      const after = cursor ? 'AND (read_at, id) > (?, ?)' : ''
      if (cursor) params.push(cursor.readAt, cursor.id)
      params.push(pageSize)
      const rows = this.db
        .prepare(
          `SELECT id, stage, closed_reason, read_at, archived, deleted_at
           FROM issues
           WHERE archived = 0
             AND deleted_at IS NULL
             AND read_at IS NOT NULL
             AND read_at <= ?
             AND (stage = 'done' OR closed_reason IS NOT NULL)
             ${after}
           ORDER BY read_at ASC, id ASC
           LIMIT ?`,
        )
        .all(...params) as Array<{
        id: string
        stage: string
        closed_reason: string | null
        read_at: string
        archived: number
        deleted_at: string | null
      }>
      for (const row of rows) {
        candidates.push({
          issueId: row.id,
          stage: row.stage,
          closedReason: row.closed_reason,
          readAt: row.read_at,
          archived: false,
          deletedAt: null,
        })
      }
      const last = rows.at(-1)
      done = rows.length < pageSize
      if (last) cursor = { readAt: last.read_at, id: last.id }
      return done || candidates.length >= input.limit ? 'done' : 'continue'
    })
    return candidates
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
): MaintenanceHttpClient {
  const base = serverUrl.replace(/^ws:/, 'http:').replace(/^wss:/, 'https:').replace(/\/$/, '')
  const post = async (path: string, body: unknown): Promise<unknown> => {
    const response = await fetchFn(`${base}${path}`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(requestTimeoutMs),
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
  close(): void
}

export async function startJanitor(options: {
  serverUrl: string
  token: string
  dbPath?: string
  tickMs?: number
}): Promise<JanitorHandle> {
  const client = createMaintenanceHttpClient(options.serverUrl, options.token)
  const db = openDatabase(options.dbPath ?? join(stateDir(), 'podium.db'), { readOnly: true })
  db.exec('PRAGMA query_only = ON')
  db.exec('PRAGMA busy_timeout = 1000')
  const expiryReader = new MessageExpiryReader(db)
  const eventPlanner = new EventLogPrunePlanner(db)
  const changePlanner = new ChangeLogPrunePlanner(db)
  const commandPlanner = new MaintenanceCommandsPrunePlanner(db)
  const archiveReader = new IssueAutoArchiveReader(db)
  const service = new JanitorService({
    handshake: client.handshake,
    apply: client.apply,
    readExpiryCandidates: (input) => expiryReader.read(input),
    planEventLogPrune: (input) => eventPlanner.plan(input),
    planChangeLogPrune: (input) => changePlanner.plan(input),
    planMaintenanceCommandsPrune: (input) => commandPlanner.plan(input),
    readAutoArchiveCandidates: (input) => archiveReader.read(input),
  })
  try {
    await service.tick()
  } catch (error) {
    if (error instanceof MaintenanceCompatibilityError) {
      db.close()
      throw error
    }
    console.warn('[podium:janitor] initial tick delayed:', error)
  }
  const timer = setInterval(() => {
    void service.tick().catch((error) => {
      if (error instanceof MaintenanceCompatibilityError) {
        console.error(`[podium:janitor] ${error.message}`)
        process.exit(78)
        return
      }
      console.warn('[podium:janitor] tick delayed:', error)
    })
  }, options.tickMs ?? DEFAULT_TICK_MS)
  timer.unref?.()
  return {
    service,
    close: () => {
      clearInterval(timer)
      db.close()
    },
  }
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

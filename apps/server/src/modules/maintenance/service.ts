import {
  AUTO_ARCHIVE_READ_WINDOW_MS,
  automationFireRunKey,
  CHANGE_KEEP_ROWS,
  CHANGE_MAX_AGE_MS,
  CHANGE_PRUNE_BATCH_ROWS,
  changeLogPruneRunKey,
  connectScanRunKey,
  EVENT_PRUNE_BATCH_ROWS,
  EVENT_RETENTION_MAX_AGE_DAYS,
  EVENT_RETENTION_MAX_ROWS,
  eventLogPruneRunKey,
  issueAutoArchiveRunKey,
  MAINTENANCE_COMMAND_MAX_AGE_MS,
  MAINTENANCE_COMMAND_PRUNE_BATCH_ROWS,
  MAINTENANCE_PROTOCOL_VERSION,
  MAINTENANCE_SCHEMA_VERSION,
  type MaintenanceCommand,
  type MaintenanceCommandReply,
  type MaintenanceHandshake,
  type MaintenanceHandshakeReply,
  type MaintenanceStaleReason,
  maintenanceCommandsPruneRunKey,
  MESSAGE_WAIT_TTL_MS,
  messageExpiryRunKey,
  stewardPollRunKey,
} from '@podium/protocol'
import type { SessionStore } from '../../store'
import type { MessageRow } from '../../store/types'
import type { AutomationsService } from '../automations/service'
import type { WriteFunnel } from '../funnel'
import type { IssueService } from '../issues/service'

const LEASE_NAME = 'janitor'
const DEFAULT_LEASE_TTL_MS = 90_000
export interface MaintenanceServiceOptions {
  now?: () => number
  leaseTtlMs?: number
  /** Optional until issue auto-archive migrates; tests may omit. */
  issues?: Pick<IssueService, 'tryAutoArchiveObserved'>
  automations?: Pick<AutomationsService, 'applyObservedOccurrence'>
  liveSessionIds?: () => Set<string>
  /** Steward poll: deliveries durable before cursor advance. */
  stewardTick?: () => void | Promise<void>
  /** Automatic shallow connect-scan; server rechecks connectivity. */
  connectScan?: (machineId: string) => void | Promise<void>
  localMachineId?: string
}

/**
 * The server-owned janitor command authority [spec:SP-c29e]. SQLite observations
 * are only proposals: compatibility, fence, idempotency, row facts, and server
 * time are re-read inside the mutation transaction.
 */
export class MaintenanceService {
  private readonly now: () => number
  private readonly leaseTtlMs: number
  private readonly issues: MaintenanceServiceOptions['issues']
  private readonly automations: MaintenanceServiceOptions['automations']
  private readonly liveSessionIds: () => Set<string>
  private readonly stewardTick: MaintenanceServiceOptions['stewardTick']
  private readonly connectScan: MaintenanceServiceOptions['connectScan']
  private readonly localMachineId: string | undefined

  constructor(
    private readonly store: SessionStore,
    private readonly funnel: Pick<WriteFunnel, 'run'>,
    options: MaintenanceServiceOptions = {},
  ) {
    this.now = options.now ?? Date.now
    this.leaseTtlMs = options.leaseTtlMs ?? DEFAULT_LEASE_TTL_MS
    this.issues = options.issues
    this.automations = options.automations
    this.liveSessionIds = options.liveSessionIds ?? (() => new Set())
    this.stewardTick = options.stewardTick
    this.connectScan = options.connectScan
    this.localMachineId = options.localMachineId
  }

  handshake(request: MaintenanceHandshake): MaintenanceHandshakeReply {
    if (
      request.protocolVersion !== MAINTENANCE_PROTOCOL_VERSION ||
      request.schemaVersion !== MAINTENANCE_SCHEMA_VERSION
    ) {
      return {
        status: 'incompatible',
        expectedProtocolVersion: MAINTENANCE_PROTOCOL_VERSION,
        expectedSchemaVersion: MAINTENANCE_SCHEMA_VERSION,
      }
    }

    return this.write(() => {
      const nowMs = this.now()
      const now = new Date(nowMs).toISOString()
      const existing = this.store.maintenance.getLease(LEASE_NAME)
      const active = existing !== undefined && Date.parse(existing.expiresAt) > nowMs
      if (active && existing.generationId !== request.generationId) {
        return { status: 'busy' as const, retryAt: existing.expiresAt }
      }
      const fencingToken =
        active && existing.generationId === request.generationId
          ? existing.fencingToken
          : (existing?.fencingToken ?? 0) + 1
      const expiresAt = new Date(nowMs + this.leaseTtlMs).toISOString()
      this.store.maintenance.putLease({
        name: LEASE_NAME,
        generationId: request.generationId,
        fencingToken,
        expiresAt,
        protocolVersion: request.protocolVersion,
        schemaVersion: request.schemaVersion,
        updatedAt: now,
      })
      return {
        status: 'ready' as const,
        fencingToken,
        expiresAt,
        messageWaitTtlMs: MESSAGE_WAIT_TTL_MS,
        autoArchiveReadWindowMs: AUTO_ARCHIVE_READ_WINDOW_MS,
        eventRetentionMaxAgeDays: EVENT_RETENTION_MAX_AGE_DAYS,
        eventRetentionMaxRows: EVENT_RETENTION_MAX_ROWS,
        changeKeepRows: CHANGE_KEEP_ROWS,
        changeMaxAgeMs: CHANGE_MAX_AGE_MS,
        maintenanceCommandMaxAgeMs: MAINTENANCE_COMMAND_MAX_AGE_MS,
      }
    })
  }

  async apply(command: MaintenanceCommand): Promise<MaintenanceCommandReply> {
    if (
      command.protocolVersion !== MAINTENANCE_PROTOCOL_VERSION ||
      command.schemaVersion !== MAINTENANCE_SCHEMA_VERSION
    ) {
      return this.stale(command, 'incompatible')
    }

    // Side-effecting jobs: fence/idempotency check inside the write funnel, then
    // run spawn/scan/steward work OUTSIDE the SQLite transaction, then record.
    if (
      command.jobKind === 'automation-fire' ||
      command.jobKind === 'steward-poll' ||
      command.jobKind === 'connect-scan'
    ) {
      const gate = this.write(() => this.gateCommand(command))
      if (gate) return gate
      const nowMs = this.now()
      if (command.jobKind === 'automation-fire') {
        return this.applyAutomationFire(command, nowMs)
      }
      if (command.jobKind === 'steward-poll') {
        return await this.applyStewardPoll(command)
      }
      return this.applyConnectScan(command, nowMs)
    }

    return this.write(() => {
      const nowMs = this.now()
      const gate = this.gateCommand(command)
      if (gate) return gate
      switch (command.jobKind) {
        case 'message-expiry':
          return this.applyMessageExpiry(command, nowMs)
        case 'event-log-prune':
          return this.applyEventLogPrune(command)
        case 'change-log-prune':
          return this.applyChangeLogPrune(command, nowMs)
        case 'maintenance-commands-prune':
          return this.applyMaintenanceCommandsPrune(command)
        case 'issue-auto-archive':
          return this.applyIssueAutoArchive(command, nowMs)
      }
    })
  }

  /** Shared fence + already-applied check. Caller must be inside write() for pure jobs. */
  private gateCommand(command: MaintenanceCommand): MaintenanceCommandReply | undefined {
    const nowMs = this.now()
    const lease = this.store.maintenance.getLease(LEASE_NAME)
    if (!lease || lease.fencingToken !== command.fencingToken) {
      return this.stale(command, 'fenced')
    }
    if (Date.parse(lease.expiresAt) <= nowMs) {
      return this.stale(command, 'lease-expired')
    }
    if (
      lease.protocolVersion !== command.protocolVersion ||
      lease.schemaVersion !== command.schemaVersion
    ) {
      return this.stale(command, 'incompatible')
    }
    const prior = this.store.maintenance.getCommand(command.jobKind, command.runKey)
    if (prior) {
      return {
        status: 'already-applied',
        jobKind: command.jobKind,
        runKey: command.runKey,
        ...(prior.status !== 'stale' && 'deleted' in prior && prior.deleted !== undefined
          ? { deleted: prior.deleted }
          : {}),
      }
    }
    return undefined
  }

  private applyMessageExpiry(
    command: Extract<MaintenanceCommand, { jobKind: 'message-expiry' }>,
    nowMs: number,
  ): MaintenanceCommandReply {
    if (messageExpiryRunKey(command.observed) !== command.runKey) {
      return this.stale(command, 'invalid-run-key')
    }
    const current = this.store.messages.getMessage(command.observed.messageId)
    if (!current || !this.matchesObservation(current, command.observed)) {
      return this.stale(command, 'precondition')
    }
    if (!this.expiryDue(current, nowMs)) {
      return this.stale(command, 'not-due')
    }
    if (
      !this.store.messages.expireObserved({
        id: current.id,
        createdAt: current.createdAt,
        lifecycle: current.lifecycle,
        expiresAt: current.expiresAt,
      })
    ) {
      return this.stale(command, 'precondition')
    }
    const applied: MaintenanceCommandReply = {
      status: 'applied',
      jobKind: command.jobKind,
      runKey: command.runKey,
    }
    const appliedAt = new Date(nowMs).toISOString()
    this.appendExpiredEvent(current, appliedAt)
    this.store.maintenance.recordCommand(applied, command.fencingToken, appliedAt)
    return applied
  }

  private applyEventLogPrune(
    command: Extract<MaintenanceCommand, { jobKind: 'event-log-prune' }>,
  ): MaintenanceCommandReply {
    const observed = command.observed
    if (eventLogPruneRunKey(observed) !== command.runKey) {
      return this.stale(command, 'invalid-run-key')
    }
    if (
      observed.maxAgeDays !== EVENT_RETENTION_MAX_AGE_DAYS ||
      observed.maxRows !== EVENT_RETENTION_MAX_ROWS ||
      observed.batchSize !== EVENT_PRUNE_BATCH_ROWS
    ) {
      return this.stale(command, 'precondition')
    }
    const plan = this.store.events.planEventPrune({
      maxAgeDays: observed.maxAgeDays,
      maxRows: observed.maxRows,
    })
    // Accept plans that are at least as aggressive as observed (cutoff not later,
    // capThroughId not lower) so concurrent writers cannot stale a valid batch.
    if (plan.cutoff < observed.cutoff || plan.capThroughId < observed.capThroughId) {
      return this.stale(command, 'precondition')
    }
    const deleted = this.store.events.pruneEventBatch(
      { cutoff: observed.cutoff, capThroughId: observed.capThroughId },
      observed.batchSize,
    )
    return this.recordPrune(command, deleted)
  }

  private applyChangeLogPrune(
    command: Extract<MaintenanceCommand, { jobKind: 'change-log-prune' }>,
    nowMs: number,
  ): MaintenanceCommandReply {
    const observed = command.observed
    if (changeLogPruneRunKey(observed) !== command.runKey) {
      return this.stale(command, 'invalid-run-key')
    }
    if (
      observed.keepRows !== CHANGE_KEEP_ROWS ||
      observed.maxAgeMs !== CHANGE_MAX_AGE_MS ||
      observed.batchSize !== CHANGE_PRUNE_BATCH_ROWS
    ) {
      return this.stale(command, 'precondition')
    }
    const plan = this.store.sync.planChangePrune({
      keepRows: observed.keepRows,
      maxAgeMs: observed.maxAgeMs,
      now: nowMs,
    })
    if (plan.thresholdSeq < observed.thresholdSeq) {
      return this.stale(command, 'precondition')
    }
    const deleted = this.store.sync.pruneChangeBatch(
      { thresholdSeq: observed.thresholdSeq },
      observed.batchSize,
    )
    return this.recordPrune(command, deleted)
  }

  private applyMaintenanceCommandsPrune(
    command: Extract<MaintenanceCommand, { jobKind: 'maintenance-commands-prune' }>,
  ): MaintenanceCommandReply {
    const observed = command.observed
    if (maintenanceCommandsPruneRunKey(observed) !== command.runKey) {
      return this.stale(command, 'invalid-run-key')
    }
    if (
      observed.maxAgeMs !== MAINTENANCE_COMMAND_MAX_AGE_MS ||
      observed.batchSize !== MAINTENANCE_COMMAND_PRUNE_BATCH_ROWS
    ) {
      return this.stale(command, 'precondition')
    }
    // Re-derive the policy cutoff at apply time. Reject observations that are
    // more aggressive (cutoff later = would delete younger rows than policy allows).
    const serverCutoff = new Date(this.now() - MAINTENANCE_COMMAND_MAX_AGE_MS).toISOString()
    if (observed.cutoffAppliedAt > serverCutoff) {
      return this.stale(command, 'precondition')
    }
    // Authoritative delete uses the server-derived cutoff (never the client's future).
    const deleted = this.store.maintenance.pruneCommandsBatch(serverCutoff, observed.batchSize)
    return this.recordPrune(command, deleted)
  }

  private applyIssueAutoArchive(
    command: Extract<MaintenanceCommand, { jobKind: 'issue-auto-archive' }>,
    nowMs: number,
  ): MaintenanceCommandReply {
    const observed = command.observed
    if (issueAutoArchiveRunKey(observed) !== command.runKey) {
      return this.stale(command, 'invalid-run-key')
    }
    if (!this.issues) {
      return this.stale(command, 'precondition')
    }
    const result = this.issues.tryAutoArchiveObserved(observed, nowMs)
    if (result === 'not-due') return this.stale(command, 'not-due')
    if (result === 'precondition') return this.stale(command, 'precondition')
    const applied: MaintenanceCommandReply = {
      status: 'applied',
      jobKind: command.jobKind,
      runKey: command.runKey,
    }
    this.store.maintenance.recordCommand(applied, command.fencingToken, new Date(nowMs).toISOString())
    return applied
  }

  /**
   * After side effects complete, re-check the fence before recording applied.
   * A generation that lost the lease mid-flight must not stamp already-applied
   * for a successor generation [POD-925 Batch 2 review].
   */
  private recordIfStillFenced(
    command: MaintenanceCommand,
    result: Extract<MaintenanceCommandReply, { status: 'applied' | 'already-applied' }>,
  ): MaintenanceCommandReply {
    return this.write(() => {
      const nowMs = this.now()
      const lease = this.store.maintenance.getLease(LEASE_NAME)
      if (!lease || lease.fencingToken !== command.fencingToken) {
        return this.stale(command, 'fenced')
      }
      if (Date.parse(lease.expiresAt) <= nowMs) {
        return this.stale(command, 'lease-expired')
      }
      const prior = this.store.maintenance.getCommand(command.jobKind, command.runKey)
      if (prior) {
        return {
          status: 'already-applied',
          jobKind: command.jobKind,
          runKey: command.runKey,
        }
      }
      this.store.maintenance.recordCommand(
        { status: 'applied', jobKind: command.jobKind, runKey: command.runKey },
        command.fencingToken,
        new Date(nowMs).toISOString(),
      )
      return result.status === 'already-applied'
        ? { status: 'already-applied', jobKind: command.jobKind, runKey: command.runKey }
        : { status: 'applied', jobKind: command.jobKind, runKey: command.runKey }
    })
  }

  private applyAutomationFire(
    command: Extract<MaintenanceCommand, { jobKind: 'automation-fire' }>,
    nowMs: number,
  ): MaintenanceCommandReply {
    const observed = command.observed
    if (automationFireRunKey(observed) !== command.runKey) {
      return this.stale(command, 'invalid-run-key')
    }
    if (!this.automations) return this.stale(command, 'precondition')
    const result = this.automations.applyObservedOccurrence({
      automationId: observed.automationId,
      nextRunAt: observed.nextRunAt,
      enabled: true,
      liveSessionIds: this.liveSessionIds(),
      now: new Date(nowMs),
    })
    if (result === 'not-due') return this.stale(command, 'not-due')
    if (result === 'precondition') return this.stale(command, 'precondition')
    return this.recordIfStillFenced(command, {
      status: result === 'already' ? 'already-applied' : 'applied',
      jobKind: command.jobKind,
      runKey: command.runKey,
    })
  }

  private async applyStewardPoll(
    command: Extract<MaintenanceCommand, { jobKind: 'steward-poll' }>,
  ): Promise<MaintenanceCommandReply> {
    const observed = command.observed
    if (stewardPollRunKey(observed) !== command.runKey) {
      return this.stale(command, 'invalid-run-key')
    }
    if (observed.toEventId <= observed.fromCursor) {
      return this.stale(command, 'precondition')
    }
    if (!this.stewardTick) return this.stale(command, 'precondition')
    // StewardService.tick advances the cursor only after durable deliveries.
    await this.stewardTick()
    // Re-check fence AFTER side effects — expired/superseded generations must
    // not record applied for work they no longer own.
    return this.recordIfStillFenced(command, {
      status: 'applied',
      jobKind: command.jobKind,
      runKey: command.runKey,
    })
  }

  private applyConnectScan(
    command: Extract<MaintenanceCommand, { jobKind: 'connect-scan' }>,
    _nowMs: number,
  ): MaintenanceCommandReply {
    const observed = command.observed
    if (connectScanRunKey(observed) !== command.runKey) {
      return this.stale(command, 'invalid-run-key')
    }
    if (observed.deep !== false) return this.stale(command, 'precondition')
    if (this.localMachineId && observed.machineId === this.localMachineId) {
      return this.stale(command, 'precondition')
    }
    const machine = this.store.machines.getMachine(observed.machineId)
    if (!machine) return this.stale(command, 'precondition')
    // Revalidate durable observation: lastSeenAt must still match (daemon
    // re-handshake would change it → new occurrence). Do NOT require wall-clock
    // freshness — lastSeenAt only updates on handshake, so a still-connected
    // machine may be older than 5 minutes [POD-925 Batch 2 review].
    if (machine.lastSeenAt !== observed.lastSeenAt) {
      return this.stale(command, 'precondition')
    }
    if (!this.connectScan) return this.stale(command, 'precondition')
    // Kick the shallow scan; do not await deep work — orchestration only.
    void Promise.resolve(this.connectScan(observed.machineId)).catch((err) => {
      console.warn('[podium:maintenance] connect-scan failed:', err)
    })
    return this.recordIfStillFenced(command, {
      status: 'applied',
      jobKind: command.jobKind,
      runKey: command.runKey,
    })
  }

  private recordPrune(
    command: MaintenanceCommand,
    deleted: number,
  ): MaintenanceCommandReply {
    const applied: MaintenanceCommandReply = {
      status: 'applied',
      jobKind: command.jobKind,
      runKey: command.runKey,
      deleted,
    }
    this.store.maintenance.recordCommand(
      applied,
      command.fencingToken,
      new Date(this.now()).toISOString(),
    )
    return applied
  }

  private stale(
    command: Pick<MaintenanceCommand, 'jobKind' | 'runKey'>,
    reason: MaintenanceStaleReason,
  ): MaintenanceCommandReply {
    return { status: 'stale', jobKind: command.jobKind, runKey: command.runKey, reason }
  }

  private write<T>(operation: () => T): T {
    return this.funnel.run({
      write: () => this.store.transact(operation),
    })
  }

  private matchesObservation(
    current: MessageRow,
    observed: Extract<MaintenanceCommand, { jobKind: 'message-expiry' }>['observed'],
  ): boolean {
    return (
      current.status === observed.status &&
      current.createdAt === observed.createdAt &&
      current.lifecycle === observed.lifecycle &&
      current.expiresAt === observed.expiresAt
    )
  }

  private expiryDue(message: MessageRow, nowMs: number): boolean {
    if (message.expiresAt !== null) return Date.parse(message.expiresAt) <= nowMs
    return (
      message.lifecycle === 'wait' && Date.parse(message.createdAt) <= nowMs - MESSAGE_WAIT_TTL_MS
    )
  }

  /** Message transition ledger append, committed with the row + run outcome. */
  private appendExpiredEvent(message: MessageRow, appliedAt: string): void {
    this.store.events.appendEvent({
      ts: appliedAt,
      kind: 'message.expired',
      subject: message.id,
      payload: {
        messageId: message.id,
        threadId: message.threadId,
        fromKind: message.fromKind,
        ...(message.fromName ? { fromName: message.fromName } : {}),
        ...(message.fromIssue ? { fromIssue: message.fromIssue } : {}),
        ...(message.fromSession ? { fromSession: message.fromSession } : {}),
        toKind: message.toKind,
        ...(message.toId ? { toId: message.toId } : {}),
        kind: message.kind,
        urgency: message.urgency,
        lifecycle: message.lifecycle,
        status: 'expired',
        ...(message.hop ? { hop: message.hop } : {}),
        ...(message.clampedFrom ? { clampedFrom: message.clampedFrom } : {}),
        ...(message.deliveredTo ? { deliveredTo: message.deliveredTo } : {}),
      },
    })
  }
}

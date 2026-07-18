import {
  MAINTENANCE_PROTOCOL_VERSION,
  MAINTENANCE_SCHEMA_VERSION,
  type MaintenanceCommand,
  type MaintenanceCommandReply,
  type MaintenanceHandshake,
  type MaintenanceHandshakeReply,
  type MaintenanceStaleReason,
  MESSAGE_WAIT_TTL_MS,
  messageExpiryRunKey,
} from '@podium/protocol'
import type { SessionStore } from '../../store'
import type { MessageRow } from '../../store/types'
import type { WriteFunnel } from '../funnel'

const LEASE_NAME = 'janitor'
const DEFAULT_LEASE_TTL_MS = 90_000

export interface MaintenanceServiceOptions {
  now?: () => number
  leaseTtlMs?: number
}

/**
 * The server-owned janitor command authority [spec:SP-c29e]. SQLite observations
 * are only proposals: compatibility, fence, idempotency, row facts, and server
 * time are re-read inside the mutation transaction.
 */
export class MaintenanceService {
  private readonly now: () => number
  private readonly leaseTtlMs: number

  constructor(
    private readonly store: SessionStore,
    private readonly funnel: Pick<WriteFunnel, 'run'>,
    options: MaintenanceServiceOptions = {},
  ) {
    this.now = options.now ?? Date.now
    this.leaseTtlMs = options.leaseTtlMs ?? DEFAULT_LEASE_TTL_MS
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
      }
    })
  }

  apply(command: MaintenanceCommand): MaintenanceCommandReply {
    if (
      command.protocolVersion !== MAINTENANCE_PROTOCOL_VERSION ||
      command.schemaVersion !== MAINTENANCE_SCHEMA_VERSION
    ) {
      return this.stale(command, 'incompatible')
    }

    return this.write(() => {
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
        }
      }
      if (messageExpiryRunKey(command.observed) !== command.runKey) {
        return this.stale(command, 'invalid-run-key')
      }

      const current = this.store.messages.getMessage(command.observed.messageId)
      if (!current || !this.matchesObservation(current, command)) {
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
    })
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

  private matchesObservation(current: MessageRow, command: MaintenanceCommand): boolean {
    const observed = command.observed
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

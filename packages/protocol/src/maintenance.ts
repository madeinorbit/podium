import { z } from 'zod'

/**
 * Janitor compatibility is intentionally stricter than the public client wire.
 * Any incompatible janitor-read schema or command contract change bumps one of
 * these values so an old sibling stops before acquiring/renewing a lease.
 * Additive job kinds are backward-compatible for older janitors that only send
 * previously defined kinds. [spec:SP-c29e]
 */
export const MAINTENANCE_PROTOCOL_VERSION = 1
export const MAINTENANCE_SCHEMA_VERSION = 'maintenance-v1'
export const MESSAGE_WAIT_TTL_MS = 7 * 24 * 60 * 60_000

/** Shared retention constants the janitor and server both honor. */
export const EVENT_RETENTION_MAX_AGE_DAYS = 14
export const EVENT_RETENTION_MAX_ROWS = 50_000
export const EVENT_PRUNE_BATCH_ROWS = 500
export const CHANGE_KEEP_ROWS = 20_000
export const CHANGE_MAX_AGE_MS = 3 * 24 * 60 * 60 * 1000
export const CHANGE_PRUNE_BATCH_ROWS = 100
/** Keep applied maintenance command rows long enough for overlap/replay proof. */
export const MAINTENANCE_COMMAND_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000
export const MAINTENANCE_COMMAND_PRUNE_BATCH_ROWS = 500
/** Read-gated auto-archive window (issue #127). */
export const AUTO_ARCHIVE_READ_WINDOW_MS = 24 * 60 * 60 * 1000

const VersionClaim = {
  protocolVersion: z.number().int().positive(),
  schemaVersion: z.string().min(1).max(128),
}

export const MaintenanceHandshake = z.object({
  ...VersionClaim,
  generationId: z.string().min(1).max(128),
})
export type MaintenanceHandshake = z.infer<typeof MaintenanceHandshake>

export const MaintenanceHandshakeReply = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('ready'),
    fencingToken: z.number().int().positive(),
    expiresAt: z.string().datetime(),
    messageWaitTtlMs: z.number().int().positive(),
    autoArchiveReadWindowMs: z.number().int().positive(),
    eventRetentionMaxAgeDays: z.number().int().positive(),
    eventRetentionMaxRows: z.number().int().nonnegative(),
    changeKeepRows: z.number().int().nonnegative(),
    changeMaxAgeMs: z.number().int().nonnegative(),
    maintenanceCommandMaxAgeMs: z.number().int().positive(),
  }),
  z.object({
    status: z.literal('busy'),
    retryAt: z.string().datetime(),
  }),
  z.object({
    status: z.literal('incompatible'),
    expectedProtocolVersion: z.number().int().positive(),
    expectedSchemaVersion: z.string().min(1),
  }),
])
export type MaintenanceHandshakeReply = z.infer<typeof MaintenanceHandshakeReply>

export const MessageExpiryObservation = z.object({
  messageId: z.string().min(1).max(256),
  status: z.literal('queued'),
  lifecycle: z.enum(['wait', 'wake']),
  createdAt: z.string().datetime(),
  expiresAt: z.string().datetime().nullable(),
})
export type MessageExpiryObservation = z.infer<typeof MessageExpiryObservation>

export const EventLogPruneObservation = z.object({
  maxAgeDays: z.number().int().positive(),
  maxRows: z.number().int().nonnegative(),
  cutoff: z.string().datetime(),
  capThroughId: z.number().int().nonnegative(),
  batchSize: z.number().int().positive(),
  /** Lowest eligible event id at plan time — advances after each successful batch. */
  fromId: z.number().int().nonnegative(),
})
export type EventLogPruneObservation = z.infer<typeof EventLogPruneObservation>

export const ChangeLogPruneObservation = z.object({
  keepRows: z.number().int().nonnegative(),
  maxAgeMs: z.number().int().nonnegative(),
  thresholdSeq: z.number().int(),
  batchSize: z.number().int().positive(),
  /** Lowest retained seq at plan time — advances after each successful batch. */
  fromSeq: z.number().int().nonnegative(),
})
export type ChangeLogPruneObservation = z.infer<typeof ChangeLogPruneObservation>

export const MaintenanceCommandsPruneObservation = z.object({
  maxAgeMs: z.number().int().positive(),
  cutoffAppliedAt: z.string().datetime(),
  batchSize: z.number().int().positive(),
  /** Lowest eligible rowid at plan time — advances after each successful batch. */
  fromRowId: z.number().int().nonnegative(),
})
export type MaintenanceCommandsPruneObservation = z.infer<
  typeof MaintenanceCommandsPruneObservation
>

export const IssueAutoArchiveObservation = z.object({
  issueId: z.string().min(1).max(256),
  stage: z.string().min(1).max(64),
  closedReason: z.string().nullable(),
  readAt: z.string().datetime(),
  archived: z.literal(false),
  deletedAt: z.null(),
})
export type IssueAutoArchiveObservation = z.infer<typeof IssueAutoArchiveObservation>

/** One due automation occurrence. firedAt is the scheduled nextRunAt, not wall clock. */
export const AutomationFireObservation = z.object({
  automationId: z.string().min(1).max(256),
  enabled: z.literal(true),
  nextRunAt: z.string().datetime(),
  scheduleKind: z.enum(['cron', 'once']),
  cron: z.string().nullable(),
  lastSessionId: z.string().nullable(),
})
export type AutomationFireObservation = z.infer<typeof AutomationFireObservation>

/**
 * Steward poll window: process durable events (cursor, maxEventId].
 * Cursor advances only after deliveries for the window are durable.
 */
export const StewardPollObservation = z.object({
  fromCursor: z.number().int().nonnegative(),
  toEventId: z.number().int().positive(),
})
export type StewardPollObservation = z.infer<typeof StewardPollObservation>

/** Automatic connect-scan orchestration only (deep scans stay interactive). */
export const ConnectScanObservation = z.object({
  machineId: z.string().min(1).max(256),
  lastSeenAt: z.string().datetime(),
  deep: z.literal(false),
})
export type ConnectScanObservation = z.infer<typeof ConnectScanObservation>

const MessageExpiryCommand = z.object({
  ...VersionClaim,
  jobKind: z.literal('message-expiry'),
  runKey: z.string().min(1).max(1024),
  fencingToken: z.number().int().positive(),
  observed: MessageExpiryObservation,
})

const EventLogPruneCommand = z.object({
  ...VersionClaim,
  jobKind: z.literal('event-log-prune'),
  runKey: z.string().min(1).max(1024),
  fencingToken: z.number().int().positive(),
  observed: EventLogPruneObservation,
})

const ChangeLogPruneCommand = z.object({
  ...VersionClaim,
  jobKind: z.literal('change-log-prune'),
  runKey: z.string().min(1).max(1024),
  fencingToken: z.number().int().positive(),
  observed: ChangeLogPruneObservation,
})

const MaintenanceCommandsPruneCommand = z.object({
  ...VersionClaim,
  jobKind: z.literal('maintenance-commands-prune'),
  runKey: z.string().min(1).max(1024),
  fencingToken: z.number().int().positive(),
  observed: MaintenanceCommandsPruneObservation,
})

const IssueAutoArchiveCommand = z.object({
  ...VersionClaim,
  jobKind: z.literal('issue-auto-archive'),
  runKey: z.string().min(1).max(1024),
  fencingToken: z.number().int().positive(),
  observed: IssueAutoArchiveObservation,
})

const AutomationFireCommand = z.object({
  ...VersionClaim,
  jobKind: z.literal('automation-fire'),
  runKey: z.string().min(1).max(1024),
  fencingToken: z.number().int().positive(),
  observed: AutomationFireObservation,
})

const StewardPollCommand = z.object({
  ...VersionClaim,
  jobKind: z.literal('steward-poll'),
  runKey: z.string().min(1).max(1024),
  fencingToken: z.number().int().positive(),
  observed: StewardPollObservation,
})

const ConnectScanCommand = z.object({
  ...VersionClaim,
  jobKind: z.literal('connect-scan'),
  runKey: z.string().min(1).max(1024),
  fencingToken: z.number().int().positive(),
  observed: ConnectScanObservation,
})

export const MaintenanceCommand = z.discriminatedUnion('jobKind', [
  MessageExpiryCommand,
  EventLogPruneCommand,
  ChangeLogPruneCommand,
  MaintenanceCommandsPruneCommand,
  IssueAutoArchiveCommand,
  AutomationFireCommand,
  StewardPollCommand,
  ConnectScanCommand,
])
export type MaintenanceCommand = z.infer<typeof MaintenanceCommand>

export const MaintenanceJobKind = z.enum([
  'message-expiry',
  'event-log-prune',
  'change-log-prune',
  'maintenance-commands-prune',
  'issue-auto-archive',
  'automation-fire',
  'steward-poll',
  'connect-scan',
])
export type MaintenanceJobKind = z.infer<typeof MaintenanceJobKind>

export const MaintenanceStaleReason = z.enum([
  'fenced',
  'lease-expired',
  'incompatible',
  'invalid-run-key',
  'precondition',
  'not-due',
])
export type MaintenanceStaleReason = z.infer<typeof MaintenanceStaleReason>

const CommandResultIdentity = {
  jobKind: MaintenanceJobKind,
  runKey: z.string().min(1),
}

export const MaintenanceCommandReply = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('applied'),
    ...CommandResultIdentity,
    deleted: z.number().int().nonnegative().optional(),
  }),
  z.object({
    status: z.literal('already-applied'),
    ...CommandResultIdentity,
    deleted: z.number().int().nonnegative().optional(),
  }),
  z.object({
    status: z.literal('stale'),
    ...CommandResultIdentity,
    reason: MaintenanceStaleReason,
  }),
])
export type MaintenanceCommandReply = z.infer<typeof MaintenanceCommandReply>

const encode = (value: string): string => encodeURIComponent(value)

/** Stable occurrence identity: changing any observed row fact creates a new key. */
export function messageExpiryRunKey(observed: MessageExpiryObservation): string {
  return [
    'message-expiry',
    encode(observed.messageId),
    encode(observed.createdAt),
    encode(observed.lifecycle),
    encode(observed.expiresAt ?? 'implicit'),
  ].join('/')
}

export function eventLogPruneRunKey(observed: EventLogPruneObservation): string {
  return [
    'event-log-prune',
    encode(observed.cutoff),
    String(observed.capThroughId),
    String(observed.batchSize),
    String(observed.fromId),
  ].join('/')
}

export function changeLogPruneRunKey(observed: ChangeLogPruneObservation): string {
  return [
    'change-log-prune',
    String(observed.thresholdSeq),
    String(observed.batchSize),
    String(observed.fromSeq),
  ].join('/')
}

export function maintenanceCommandsPruneRunKey(
  observed: MaintenanceCommandsPruneObservation,
): string {
  return [
    'maintenance-commands-prune',
    encode(observed.cutoffAppliedAt),
    String(observed.batchSize),
    String(observed.fromRowId),
  ].join('/')
}

export function issueAutoArchiveRunKey(observed: IssueAutoArchiveObservation): string {
  return [
    'issue-auto-archive',
    encode(observed.issueId),
    encode(observed.readAt),
    encode(observed.stage),
    encode(observed.closedReason ?? 'none'),
  ].join('/')
}

/** Deterministic occurrence identity — also the spawn/outbox mutation id. */
export function automationOccurrenceRunId(automationId: string, firedAt: string): string {
  return `arun_${encode(automationId)}_${encode(firedAt)}`.slice(0, 128)
}

export function automationFireRunKey(observed: AutomationFireObservation): string {
  return ['automation-fire', encode(observed.automationId), encode(observed.nextRunAt)].join('/')
}

export function stewardPollRunKey(observed: StewardPollObservation): string {
  return ['steward-poll', String(observed.fromCursor), String(observed.toEventId)].join('/')
}

export function connectScanRunKey(observed: ConnectScanObservation): string {
  return ['connect-scan', encode(observed.machineId), encode(observed.lastSeenAt)].join('/')
}

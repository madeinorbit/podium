import {
  AutomationIdField,
  type AutomationRunId,
  asAutomationRunId,
  IssueIdField,
  SessionIdField,
  UserIdField,
} from '@podium/model'
import { z } from 'zod'

/**
 * Janitor compatibility is intentionally stricter than the public client wire.
 * Any incompatible janitor-read schema or command contract change bumps one of
 * these values so an old sibling stops before acquiring/renewing a lease.
 * Additive job kinds are backward-compatible for older janitors that only send
 * previously defined kinds. [spec:SP-c29e]
 */
// v2: the session-auto-archive job kind [spec:SP-6144] — a new janitor sending
// it to a v1 server must be version-gated out, not hard-fail command parsing.
// v3 (POD-1229): both auto-archive observations replace the unqualified
// `readAt` with `readerUserId`. This is the case the version gate exists for —
// a v2 janitor's observation still PARSES under a permissive reader but means
// something else, so the mismatch has to be refused at the handshake rather
// than discovered as a silently empty sweep.
export const MAINTENANCE_PROTOCOL_VERSION = 3
export const MAINTENANCE_SCHEMA_VERSION = 'maintenance-v3'
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
/** Read-gated completion decay window [spec:SP-6144]. */
export const AUTO_ARCHIVE_READ_WINDOW_MS = 7 * 24 * 60 * 60 * 1000

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

/**
 * DECLARED LEGITIMATE — do NOT compose this from the issue aggregate (POD-367,
 * inventory #16). It resembles a restatement of issue fields and is not one.
 *
 * Divergence class: **a validation gate over untrusted input.** Every difference
 * from the canonical issue vocabulary is load-bearing, and composing them away
 * converts a gate that REFUSES a bad payload into one that accepts it — fail-open,
 * while a diff reads as tidying and every instrument stays green:
 *  - `archived: z.literal(false)` and `deletedAt: z.null()` are PRECONDITIONS, not
 *    field types. They are the point of the schema: it refuses an observation
 *    claiming an already-archived or deleted issue. As the aggregate's `boolean`
 *    and optional string, the gate would accept exactly what it exists to reject.
 *  - `.min(1).max(256)` / `.max(64)` are INPUT BOUNDS on a steward-supplied
 *    payload, not properties of the issue's fields.
 *  - `.datetime()` is STRICTER than the entity's plain string; composing loosens
 *    the parse.
 *
 * The reason is recorded here, next to the exemption, deliberately: an unexplained
 * exemption is indistinguishable from someone silencing a detector. If a
 * representation audit counts this shape, it must count it as declared-legitimate
 * WITH this reason, not as debt to be cleared — "not yet composed" and "composing
 * would be wrong" have opposite correct actions.
 *
 * `SessionAutoArchiveObservation` below is the same class (POD-366's #23).
 */
/**
 * "READ BY WHOM?" — the answer, and why the timestamp is gone (POD-1229).
 *
 * POD-1210 settled the POLICY: the sweep asks the one viewer the shared
 * `archived` flag speaks for. ANY-user is wrong (one person opening a done issue
 * would archive it off everyone's board) and ALL-users never fires (an absent
 * row means "never read", and there is no membership roster to bound "all"
 * against). That decision stands and is not reopened here; see
 * `docs/agents/pod-1210-auto-archive-reader-evidence.md`.
 *
 * What POD-1210 left, and this fixes, is that the wire never SAID so. A bare
 * `readAt: z.string().datetime()` is a per-user fact with no user attached — a
 * singleton in the exact sense `per-user-singletons` counts. The janitor picked
 * a reader (`ARCHIVE_VIEWER`) and the server picked one (`broadcastViewer()`),
 * and the two agreed only because both spell `FIRST_ADMIN_USER_ID`. Nothing on
 * the wire could express a disagreement, so nothing could TEST for one — and the
 * next step of POD-1077, passing the request's real principal at one of those
 * two sites and not the other, would have killed auto-archive silently for the
 * third time, with every existing test green.
 *
 * So the observation now names its reader and drops the timestamp:
 *
 *  - `readerUserId` is the principal on whose behalf the read-gate was
 *    evaluated. The server REFUSES (`precondition`) any observation naming
 *    anyone other than the viewer it archives for. The policy stays on the
 *    authority; the wire fact makes the agreement checked instead of assumed.
 *  - `readAt` is REMOVED rather than re-keyed. Carrying the authority's own
 *    per-user state back to it as a string to compare bought a compare-and-swap
 *    that the freshness check already subsumes: a re-read moves `readAt`
 *    forward, which the server's own cutoff rejects as `not-due`, and marking it
 *    unread deletes the row, which the server rejects as `precondition`. Both
 *    are covered by tests that fail if either check is removed.
 *
 * The run keys below carry `readerUserId` in `readAt`'s place, so an occurrence
 * is still identified by (entity, reader, shared preconditions). The one thing
 * this loses is re-archival of an issue that was unarchived AND re-read inside
 * the 14-day `maintenance_commands` retention: its run key no longer changes, so
 * the replay answers `already-applied` until that row is pruned, after which the
 * next sweep archives it. Self-healing, and the neighbouring hole — unarchived
 * WITHOUT a re-read — was already there when `readAt` was in the key.
 */
export const IssueAutoArchiveObservation = z.object({
  issueId: z.string().min(1).max(256).pipe(IssueIdField),
  stage: z.string().min(1).max(64),
  closedReason: z.string().nullable(),
  readerUserId: z.string().min(1).max(256).pipe(UserIdField),
  archived: z.literal(false),
  deletedAt: z.null(),
})
export type IssueAutoArchiveObservation = z.infer<typeof IssueAutoArchiveObservation>

export const SessionAutoArchiveObservation = z.object({
  sessionId: z.string().min(1).max(256).pipe(SessionIdField),
  issueId: z.string().min(1).max(256).pipe(IssueIdField).nullable(),
  stoppedAt: z.string().datetime(),
  readerUserId: z.string().min(1).max(256).pipe(UserIdField),
  archived: z.literal(false),
})
export type SessionAutoArchiveObservation = z.infer<typeof SessionAutoArchiveObservation>

/** One due automation occurrence. firedAt is the scheduled nextRunAt, not wall clock. */
export const AutomationFireObservation = z.object({
  automationId: z.string().min(1).max(256).pipe(AutomationIdField),
  enabled: z.literal(true),
  nextRunAt: z.string().datetime(),
  scheduleKind: z.enum(['cron', 'once']),
  cron: z.string().nullable(),
  lastSessionId: SessionIdField.nullable(),
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

const SessionAutoArchiveCommand = z.object({
  ...VersionClaim,
  jobKind: z.literal('session-auto-archive'),
  runKey: z.string().min(1).max(1024),
  fencingToken: z.number().int().positive(),
  observed: SessionAutoArchiveObservation,
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
  SessionAutoArchiveCommand,
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
  'session-auto-archive',
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

export function sessionAutoArchiveRunKey(observed: SessionAutoArchiveObservation): string {
  return [
    'session-auto-archive',
    encode(observed.sessionId),
    encode(observed.stoppedAt),
    encode(observed.readerUserId),
  ].join('/')
}

export function issueAutoArchiveRunKey(observed: IssueAutoArchiveObservation): string {
  return [
    'issue-auto-archive',
    encode(observed.issueId),
    encode(observed.readerUserId),
    encode(observed.stage),
    encode(observed.closedReason ?? 'none'),
  ].join('/')
}

/** Deterministic occurrence identity — also the spawn/outbox mutation id.
 *
 *  Returns the BRAND (POD-361): this is a MINT site, and an id constructor that
 *  returns a bare string forces every caller to cast, which is how a brand ends
 *  up adopted nowhere. The `automationId` parameter stays a plain string so
 *  callers holding either form still compile — POD-362 narrows it. */
export function automationOccurrenceRunId(automationId: string, firedAt: string): AutomationRunId {
  return asAutomationRunId(`arun_${encode(automationId)}_${encode(firedAt)}`.slice(0, 128))
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

import { createHash, randomUUID } from 'node:crypto'
import type { Dirent } from 'node:fs'
import { chmod, mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { manifestFor } from '@podium/harness'
import {
  AgentDelegation,
  type AgentIdentityId,
  type AgentKind,
  asAgentIdentityId,
  asMachineId,
  asSessionId,
  asUserId,
  type ConversationId,
  type DelegationScope,
  type MachineId,
  type SessionId,
  type UserId,
} from '@podium/model'
import type { DaemonMessage } from '@podium/protocol'

/**
 * This is the DAEMON binding-store version. It is deliberately unrelated to the
 * server database's drizzle journal: the two stores have different owners,
 * lifecycles and migration lineages (ADR 6 D5.2 / POD-414 S1).
 */
export const BINDING_STORE_SCHEMA_VERSION = 3
export const SESSION_BINDING_SCHEMA_VERSION = 1

const MANIFEST_NAME = 'manifest.json'
const BINDINGS_DIR = 'bindings'
const RECEIPT_NAME = /^([\w.-]+)\.json$/
const CLAIM_NAME = /^([\w.-]+?)\.json\.\d+\.[0-9a-f-]+\.ack$/

/**
 * `exporting` and `adopting` are deliberately NON-LIVE ownership states.
 * During a handoff there may be a durable row on both machines, but never two
 * rows entitled to launch the agent. `exported` is terminal on that host until
 * a later round-trip explicitly adopts the same SessionId back onto it.
 */
export type BindingState =
  | 'unbound'
  | 'bound'
  | 'conflicted'
  | 'exporting'
  | 'adopting'
  | 'exported'
  | 'retired'
export type ObservationConfidence = 'exact' | 'heuristic'
export type ObservationSource =
  | 'native-hook'
  | 'launch-marker'
  | 'process'
  | 'discovery'
  | 'handoff-import'
  | 'control'
  | 'adapter-observer'
  | 'legacy-control'
  | 'headless-driver'
  | 'legacy-observer'
  | 'legacy-adapter'

/** Native values and local aliases are observations, never pane identity. */
export type BindingObservationChannel =
  | 'resume-ref'
  | 'provider-session'
  | 'transcript-path'
  | 'rollout-path'
  | 'process-ownership'
  | 'cwd'
  | 'worktree-pin'

export interface BindingObservation {
  observationId: string
  channel: BindingObservationChannel
  value: string | null
  /** Resume/provider kind when `value` is a harness-native id. */
  nativeKind?: string
  confidence: ObservationConfidence
  source: ObservationSource
  observedAt: string
  recordedAt: string
  supersedes: string | null
  /**
   * A host receipt is retained until the server acknowledges this exact value.
   * POD-737 moves delivery onto this field; POD-415 imports it without deleting
   * the load-bearing legacy receipt file.
   */
  pendingServerAck?: { nativeKind: string; value: string }
  /** Unknown future fields are retained by read-modify-write. */
  [key: string]: unknown
}

/**
 * Delegation history stores the REFERENCE used for live resolution, never the
 * resolved result. `grantedScope` is the declared left-hand operand; no rights,
 * capability, permission, role, grant list or cached allow-bit belongs here.
 */
export interface BindingDelegationObservation {
  observationId: string
  actor: AgentIdentityId
  onBehalfOf: UserId
  grantedScope: DelegationScope
  parentBindingId: SessionId | null
  observedAt: string
  recordedAt: string
  supersedes: string | null
  retired: boolean
  [key: string]: unknown
}

export interface BindingTransfer {
  transferId: string
  side: 'source' | 'target'
  phase: 'claimed' | 'committed' | 'aborted'
  fromMachineId: MachineId
  toMachineId: MachineId
  claimedAt: string
  settledAt: string | null
  /** State restored when a claim aborts. `null` means no row predated import. */
  priorState: BindingState | null
}
export interface BindingTransitionReceipt {
  transitionId: string
  event: SessionBindingEvent
  recordedAt: string
  /**
   * The identity reference that won one reattach generation. It contains no
   * rights or capability result; policy is re-run before every transition.
   * Keeping the accepted reference makes a same-generation retry deterministic
   * across daemon restart and leaves POD-644 a durable CAS hook to extend.
   */
  reattachClaim?: {
    principal: BindingSpawnPrincipal
    requestedGeneration: number
    attemptId: string | null
  }
}

export interface SessionBindingRecord {
  schemaVersion: 1
  sessionId: SessionId
  conversationId: ConversationId | null
  agentKind: AgentKind
  claimantMachineId: MachineId
  attemptId: string | null
  observationGeneration: number
  observations: BindingObservation[]
  delegationHistory: BindingDelegationObservation[]
  transitionHistory: BindingTransitionReceipt[]
  transfer: BindingTransfer | null
  state: BindingState
  createdAt: string
  retiredAt: string | null
  /** Unknown future fields are retained by read-modify-write. */
  [key: string]: unknown
}

export interface LegacyBindingSnapshot {
  sessionId: SessionId
  agentKind: AgentKind
  attemptId?: string | null
  conversationId?: ConversationId | null
  observationGeneration?: number
  /** `control/session.ts`: the exact durable host alias and server-supplied pins. */
  control?: {
    durableLabel?: string
    cwd?: string
    resume?: { kind: string; value: string }
  }
  /** `session-observers.ts`: the current lease/provider identity. */
  observer?: {
    providerSessionId?: string | null
    resumeKind?: string
    pathHint?: string
  }
  /** Adapter-owned native-store and worktree pins. */
  adapter?: {
    nativeId?: string
    resumeKind?: string
    transcriptPath?: string
    rolloutPath?: string
    cwd?: string
    worktreePin?: string
  }
}

export interface LegacyMigrationInventory {
  sessionObservers: number
  controlSessions: number
  adapterPins: number
  daemonIdentityFiles: number
  codexReceipts: number
  codexReceiptClaims: number
}

interface LegacyMigrationResult {
  completedAt: string
  sourceStateDir: string
  inventory: LegacyMigrationInventory
}

interface StoreManifestV1 {
  schemaVersion: 1
  createdAt: string
  [key: string]: unknown
}

interface StoreManifestV2 {
  schemaVersion: 2
  createdAt: string
  legacyMigration: LegacyMigrationResult | null
  [key: string]: unknown
}

export interface CodexReceiptFoldResult {
  completedAt: string
  sourceReceiptDir: string
  inventory: { receipts: number; claims: number }
}

interface StoreManifestV3 {
  schemaVersion: 3
  createdAt: string
  legacyMigration: LegacyMigrationResult | null
  codexReceiptFold: CodexReceiptFoldResult | null
  [key: string]: unknown
}

export interface OpenBindingStoreOptions {
  /** The store itself, normally `<instance-state>/runtime/session-bindings`. */
  dir: string
  /** Real daemon state root containing daemon.json and runtime receipt spools. */
  legacyStateDir?: string
  /** Live in-memory facts harvested at cutover; absent on later boots. */
  legacyBindings?: readonly LegacyBindingSnapshot[]
  /**
   * POD-1075's first-admin UserId. Required when legacy binding facts exist;
   * there is intentionally no synthetic/placeholder fallback.
   */
  singleOperatorUserId?: UserId
  /** Runtime/fixture override for the SP-15aa receipt directory. */
  codexReceiptDir?: string
  now?: () => string
}

export interface EnsureBindingInput {
  sessionId: SessionId
  agentKind: AgentKind
  claimantMachineId: MachineId
  attemptId?: string | null
  conversationId?: ConversationId | null
  observationGeneration?: number
  delegation?: {
    actor: AgentIdentityId
    onBehalfOf: UserId
    grantedScope: DelegationScope
    parentBindingId: SessionId | null
  }
  createdAt?: string
}

export interface ObserveBindingInput {
  sessionId: SessionId
  channel: BindingObservationChannel
  value: string | null
  nativeKind?: string
  confidence: ObservationConfidence
  source: ObservationSource
  observedAt: string
  pendingServerAck?: { nativeKind: string; value: string }
}

/** The delegation operand that crosses hosts. This is identity, not authority:
 * importing it must never replace the human with the importing principal, and
 * no resolved permission/capability is representable here. */
export interface BindingAdoptDelegation {
  actor: AgentIdentityId
  onBehalfOf: UserId
  grantedScope: DelegationScope
  parentBindingId: SessionId | null
}

/** Native ids and paths are re-observed on the target at import time. */
export interface BindingAdoptObservation {
  channel: BindingObservationChannel
  value: string
  nativeKind?: string
}

export interface BindingAdoption {
  agentKind: AgentKind
  observationGeneration: number
  delegation: BindingAdoptDelegation
  observations: readonly BindingAdoptObservation[]
}
/**
 * The complete binding event vocabulary. `adopt` is intentionally present even
 * though POD-644 owns the control-plane import choreography: callers can depend
 * on one closed event set without retrofitting a sixth arm later.
 */
export const SESSION_BINDING_EVENTS = [
  'spawn',
  'reattach',
  'hook-repin',
  'headless-allocation',
  'adopt',
] as const
export type SessionBindingEvent = (typeof SESSION_BINDING_EVENTS)[number]

/** Hook and process ownership are sibling evidence sources for ONE repin event. */
export type RepinEvidenceSource = 'hook-receipt' | 'process-ownership-receipt'

/**
 * The result of POD-1079's live machine-use check. The binding state machine
 * consumes this answer; it never owns or reconstructs the fleet ACL.
 */
export type BindingMachineAccess = 'allowed' | 'denied' | 'unreachable'
/** Authorization above arbitration collapses invisible and nonexistent rows. */
export type BindingSessionAccess = 'allowed' | 'not-found'

export type BindingSpawnPrincipal =
  | { kind: 'user'; userId: UserId }
  | { kind: 'agent'; parentBindingId: SessionId }
  | { kind: 'system' }

interface BindingTransitionBase {
  sessionId: SessionId
  /** Stable retry key. A repeat returns the already-materialized result. */
  transitionId: string
}

export type SessionBindingTransition =
  | (BindingTransitionBase & {
      event: 'spawn'
      agentKind: AgentKind
      claimantMachineId: MachineId
      machineAccess: BindingMachineAccess
      principal: BindingSpawnPrincipal
      /** The narrow task default: the issue subtree, or `none` for an issueless session. */
      issueId?: import('@podium/model').IssueId
      /** An override is authority input only after the existing confirmation path accepted it. */
      requestedScope?: DelegationScope
      scopeOverrideConfirmed?: boolean
      attemptId?: string | null
      observationGeneration?: number
      createdAt?: string
    })
  | (BindingTransitionBase & {
      event: 'reattach'
      claimantMachineId: MachineId
      machineAccess: BindingMachineAccess
      sessionAccess: BindingSessionAccess
      /** Server-authored from the authenticated transport principal. */
      principal: BindingSpawnPrincipal
      requestedGeneration: number
      attemptId?: string | null
    })
  | (BindingTransitionBase & {
      event: 'hook-repin'
      evidenceSource: RepinEvidenceSource
      value: string
      nativeKind: string
      observedAt: string
      /** A known predecessor makes succession ordered; absence makes two exact heads conflict. */
      supersedesObservationId?: string
      pendingServerAck?: { nativeKind: string; value: string }
    })
  | (BindingTransitionBase & {
      event: 'headless-allocation'
      attemptId: string
      nativeKind: string
      observedAt: string
      /** Missing means the attempt exited before allocating a native conversation. */
      value?: string
    })
  | (BindingTransitionBase & {
      event: 'adopt'
      machineAccess: BindingMachineAccess
      transferId: string
      role: 'source' | 'target'
      phase: 'claim' | 'commit' | 'abort' | 'launch'
      fromMachineId: MachineId
      toMachineId: MachineId
      at: string
      /** Required only for the target claim, after native artifacts are placed. */
      adoption?: BindingAdoption
      /** A launch creates a new host-local attempt, never a new delegation. */
      attemptId?: string
    })

export type BindingTransitionRejection =
  | 'binding-exists'
  | 'binding-missing'
  | 'binding-retired'
  | 'scope-widening-denied'
  | 'parent-binding-missing'
  | 'parent-delegation-missing'
  | 'delegating-human-mismatch'
  | 'stale-generation'
  | 'claimant-mismatch'
  | 'transfer-conflict'
  | 'adoption-missing'
  | 'adoption-identity-mismatch'
  | 'unsupported-agent-transition'

/**
 * Terminal placement refusals are separate union arms. A caller cannot mistake
 * "you do not have access" for an offline host or an empty machine list.
 */
export type SessionBindingTransitionOutcome =
  | {
      status: 'applied' | 'unchanged'
      event: SessionBindingEvent
      binding: SessionBindingRecord
    }
  | {
      status: 'denied'
      event: 'spawn' | 'reattach' | 'adopt'
      reason: 'machine-use-denied'
      terminal: true
    }
  | {
      status: 'denied'
      event: 'reattach'
      reason: 'not-found' | 'not-claimant'
      terminal: true
    }
  | {
      status: 'unreachable'
      event: 'spawn' | 'reattach' | 'adopt'
      reason: 'machine-unreachable'
      terminal: true
    }
  | {
      status: 'rejected'
      event: SessionBindingEvent
      reason: BindingTransitionRejection
      terminal: true
    }
  | {
      status: 'redundant'
      event: 'reattach'
      binding: SessionBindingRecord
    }

export class BindingStoreVersionError extends Error {
  constructor(
    readonly found: number,
    readonly supported: number,
  ) {
    super(`binding store schema version ${found} is newer than supported version ${supported}`)
    this.name = 'BindingStoreVersionError'
  }
}

export class LegacyBindingMigrationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'LegacyBindingMigrationError'
  }
}

export class BindingStoreAuthoritySnapshotError extends Error {
  constructor(readonly paths: readonly string[]) {
    super(`binding store contains forbidden authorization snapshot fields: ${paths.join(', ')}`)
    this.name = 'BindingStoreAuthoritySnapshotError'
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

const AUTHORITY_SNAPSHOT_KEY =
  /capabilit|effectiveright|rights?|permission|privileg|entitlement|grant|role|acl/i

function assertNoAuthoritySnapshot(value: unknown): void {
  const paths: string[] = []
  const walk = (candidate: unknown, path = ''): void => {
    if (Array.isArray(candidate)) {
      candidate.forEach((entry) => {
        walk(entry, `${path}[]`)
      })
      return
    }
    if (!isRecord(candidate)) return
    for (const [key, child] of Object.entries(candidate)) {
      const childPath = path ? `${path}.${key}` : key
      // The declared scope is the left operand of live authorization, not its
      // resolved result. It is the one authority-shaped key the schema permits.
      if (key !== 'grantedScope' && AUTHORITY_SNAPSHOT_KEY.test(key)) paths.push(childPath)
      walk(child, childPath)
    }
  }
  walk(value)
  if (paths.length > 0) throw new BindingStoreAuthoritySnapshotError(paths)
}

function requiredString(value: unknown, path: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${path} must be non-empty`)
  return value
}

function optionalNullableString(value: unknown, path: string): string | null {
  if (value === null) return null
  return requiredString(value, path)
}

function parseObservation(value: unknown, index: number): BindingObservation {
  if (!isRecord(value)) throw new Error(`observations[${index}] must be an object`)
  const channel = requiredString(value.channel, `observations[${index}].channel`)
  const confidence = value.confidence
  if (confidence !== 'exact' && confidence !== 'heuristic') {
    throw new Error(`observations[${index}].confidence is invalid`)
  }
  const source = requiredString(value.source, `observations[${index}].source`)
  return {
    ...value,
    observationId: requiredString(value.observationId, `observations[${index}].observationId`),
    channel: channel as BindingObservationChannel,
    value: optionalNullableString(value.value, `observations[${index}].value`),
    confidence,
    source: source as ObservationSource,
    observedAt: requiredString(value.observedAt, `observations[${index}].observedAt`),
    recordedAt: requiredString(value.recordedAt, `observations[${index}].recordedAt`),
    supersedes:
      value.supersedes === null
        ? null
        : requiredString(value.supersedes, `observations[${index}].supersedes`),
  }
}

function parseDelegation(value: unknown, index: number): BindingDelegationObservation {
  if (!isRecord(value)) throw new Error(`delegationHistory[${index}] must be an object`)
  const parsed = AgentDelegation.parse({
    agentIdentity: value.actor,
    onBehalfOf: value.onBehalfOf,
    scope: value.grantedScope,
    parentAgentIdentity: null,
    createdAt: value.observedAt,
  })
  if (typeof value.retired !== 'boolean') {
    throw new Error(`delegationHistory[${index}].retired must be boolean`)
  }
  return {
    ...value,
    observationId: requiredString(value.observationId, `delegationHistory[${index}].observationId`),
    actor: parsed.agentIdentity,
    onBehalfOf: parsed.onBehalfOf,
    grantedScope: parsed.scope,
    parentBindingId:
      value.parentBindingId === null
        ? null
        : asSessionId(
            requiredString(value.parentBindingId, `delegationHistory[${index}].parentBindingId`),
          ),
    observedAt: parsed.createdAt,
    recordedAt: requiredString(value.recordedAt, `delegationHistory[${index}].recordedAt`),
    supersedes:
      value.supersedes === null
        ? null
        : requiredString(value.supersedes, `delegationHistory[${index}].supersedes`),
    retired: value.retired,
  }
}

function parseBindingPrincipal(value: unknown, path: string): BindingSpawnPrincipal {
  if (!isRecord(value)) throw new Error(`${path} must be an object`)
  switch (value.kind) {
    case 'user':
      return { kind: 'user', userId: asUserId(requiredString(value.userId, `${path}.userId`)) }
    case 'agent':
      return {
        kind: 'agent',
        parentBindingId: asSessionId(
          requiredString(value.parentBindingId, `${path}.parentBindingId`),
        ),
      }
    case 'system':
      return { kind: 'system' }
    default:
      throw new Error(`${path}.kind is invalid`)
  }
}

function parseBinding(value: unknown): SessionBindingRecord {
  if (!isRecord(value)) throw new Error('binding must be an object')
  const version = value.schemaVersion
  if (typeof version !== 'number') throw new Error('binding schemaVersion must be a number')
  if (version > SESSION_BINDING_SCHEMA_VERSION) {
    throw new BindingStoreVersionError(version, SESSION_BINDING_SCHEMA_VERSION)
  }
  if (version !== SESSION_BINDING_SCHEMA_VERSION) {
    throw new Error(`unsupported binding schema version ${version}`)
  }
  assertNoAuthoritySnapshot(value)
  const state = value.state
  if (
    !['unbound', 'bound', 'conflicted', 'exporting', 'adopting', 'exported', 'retired'].includes(
      String(state),
    )
  ) {
    throw new Error('binding state is invalid')
  }
  if (!Array.isArray(value.observations)) throw new Error('binding observations must be an array')
  if (!Array.isArray(value.delegationHistory)) {
    throw new Error('binding delegationHistory must be an array')
  }
  if (value.transitionHistory !== undefined && !Array.isArray(value.transitionHistory)) {
    throw new Error('binding transitionHistory must be an array')
  }
  const observationGeneration = value.observationGeneration
  if (!Number.isSafeInteger(observationGeneration) || Number(observationGeneration) < 0) {
    throw new Error('binding observationGeneration must be a non-negative integer')
  }
  return {
    ...value,
    schemaVersion: 1,
    sessionId: asSessionId(requiredString(value.sessionId, 'binding.sessionId')),
    conversationId:
      value.conversationId === null
        ? null
        : (requiredString(value.conversationId, 'binding.conversationId') as ConversationId),
    agentKind: requiredString(value.agentKind, 'binding.agentKind') as AgentKind,
    claimantMachineId: asMachineId(
      requiredString(value.claimantMachineId, 'binding.claimantMachineId'),
    ),
    attemptId: optionalNullableString(value.attemptId, 'binding.attemptId'),
    observationGeneration: Number(observationGeneration),
    observations: value.observations.map(parseObservation),
    delegationHistory: value.delegationHistory.map(parseDelegation),
    transitionHistory: ((value.transitionHistory ?? []) as unknown[]).map((entry, index) => {
      if (!isRecord(entry)) throw new Error(`transitionHistory[${index}] must be an object`)
      const event = requiredString(entry.event, `transitionHistory[${index}].event`)
      if (!(SESSION_BINDING_EVENTS as readonly string[]).includes(event)) {
        throw new Error(`transitionHistory[${index}].event is invalid`)
      }
      const reattachClaim = entry.reattachClaim
      if (reattachClaim !== undefined && !isRecord(reattachClaim)) {
        throw new Error(`transitionHistory[${index}].reattachClaim must be an object`)
      }
      const requestedGeneration = reattachClaim?.requestedGeneration
      if (
        requestedGeneration !== undefined &&
        (!Number.isSafeInteger(requestedGeneration) || Number(requestedGeneration) < 0)
      ) {
        throw new Error(
          `transitionHistory[${index}].reattachClaim.requestedGeneration must be a non-negative integer`,
        )
      }
      return {
        ...entry,
        transitionId: requiredString(
          entry.transitionId,
          `transitionHistory[${index}].transitionId`,
        ),
        event: event as SessionBindingEvent,
        recordedAt: requiredString(entry.recordedAt, `transitionHistory[${index}].recordedAt`),
        ...(reattachClaim
          ? {
              reattachClaim: {
                principal: parseBindingPrincipal(
                  reattachClaim.principal,
                  `transitionHistory[${index}].reattachClaim.principal`,
                ),
                requestedGeneration: Number(requestedGeneration),
                attemptId: optionalNullableString(
                  reattachClaim.attemptId,
                  `transitionHistory[${index}].reattachClaim.attemptId`,
                ),
              },
            }
          : {}),
      }
    }),
    transfer: (value.transfer ?? null) as BindingTransfer | null,
    state: state as BindingState,
    createdAt: requiredString(value.createdAt, 'binding.createdAt'),
    retiredAt: optionalNullableString(value.retiredAt, 'binding.retiredAt'),
  }
}

function stableEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

function bindsNativeArtifact(channel: BindingObservationChannel): boolean {
  return (
    channel === 'resume-ref' ||
    channel === 'provider-session' ||
    channel === 'transcript-path' ||
    channel === 'rollout-path' ||
    channel === 'process-ownership'
  )
}
function scopeWithin(child: DelegationScope, parent: DelegationScope): boolean {
  if (child.kind === 'none') return true
  if (parent.kind === 'all') return true
  if (child.kind !== parent.kind) return false
  switch (child.kind) {
    case 'subtree':
      return parent.kind === 'subtree' && child.rootId === parent.rootId
    case 'owned':
    case 'self':
      return parent.kind === child.kind && child.userId === parent.userId
    default:
      return false
  }
}

function machineAccessOutcome(
  event: 'spawn' | 'reattach' | 'adopt',
  access: BindingMachineAccess,
): Extract<SessionBindingTransitionOutcome, { status: 'denied' | 'unreachable' }> | null {
  if (access === 'denied') {
    return { status: 'denied', event, reason: 'machine-use-denied', terminal: true }
  }
  if (access === 'unreachable') {
    return { status: 'unreachable', event, reason: 'machine-unreachable', terminal: true }
  }
  return null
}

function withTransitionReceipt(
  binding: SessionBindingRecord,
  transition: SessionBindingTransition,
  recordedAt: string,
): SessionBindingRecord {
  const receipt: BindingTransitionReceipt = {
    transitionId: transition.transitionId,
    event: transition.event,
    recordedAt,
    ...(transition.event === 'reattach'
      ? {
          reattachClaim: {
            principal: transition.principal,
            requestedGeneration: transition.requestedGeneration,
            attemptId: transition.attemptId ?? null,
          },
        }
      : {}),
  }
  return {
    ...binding,
    transitionHistory: [...binding.transitionHistory, receipt],
  }
}

function transitionRejected(
  event: SessionBindingEvent,
  reason: BindingTransitionRejection,
): SessionBindingTransitionOutcome {
  return { status: 'rejected', event, reason, terminal: true }
}

export interface BindingOwnershipClaim {
  sessionId: SessionId
  machineId: MachineId
  transferId: string
  role: 'source' | 'target'
  phase: BindingTransfer['phase']
}

/**
 * Authority-free ordering of two durable cross-host claims. For one transfer,
 * an imported target outranks its exporting source: target claim is written
 * only after files and native artifacts landed, while the source claim is
 * already non-live. Unrelated crashed transfers use the server-minted transfer
 * id as a stable tie-breaker; machine clocks are deliberately absent.
 *
 * This answers only WHO owns the binding. The returned claimant must still
 * pass a live machine-use check at its first apply.
 */
export function arbitrateBindingOwnership(
  left: BindingOwnershipClaim,
  right: BindingOwnershipClaim,
): BindingOwnershipClaim {
  if (left.sessionId !== right.sessionId) {
    throw new Error('cannot arbitrate bindings for different sessions')
  }
  const rank = (claim: BindingOwnershipClaim): number => {
    if (claim.phase === 'aborted') return 0
    if (claim.role === 'target') return claim.phase === 'committed' ? 4 : 3
    return claim.phase === 'committed' ? 2 : 1
  }
  // An aborted claim is a dead right under every transfer id. Lexical ordering
  // exists only to choose among still-live competing transfers.
  if (left.phase === 'aborted' && right.phase !== 'aborted') return right
  if (right.phase === 'aborted' && left.phase !== 'aborted') return left
  if (left.transferId === right.transferId) {
    const delta = rank(left) - rank(right)
    if (delta !== 0) return delta > 0 ? left : right
  }
  const leftKey = `${left.transferId}\u0000${left.machineId}\u0000${left.role}`
  const rightKey = `${right.transferId}\u0000${right.machineId}\u0000${right.role}`
  return leftKey >= rightKey ? left : right
}

function fileStem(sessionId: SessionId): string {
  return Buffer.from(sessionId, 'utf8').toString('base64url')
}

async function atomicJsonWrite(path: string, value: unknown): Promise<void> {
  const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`
  await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
  await rename(tmp, path)
  await chmod(path, 0o600)
}

async function atomicBindingWrite(path: string, value: SessionBindingRecord): Promise<void> {
  assertNoAuthoritySnapshot(value)
  await atomicJsonWrite(path, value)
}

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, 'utf8')) as unknown
}

function parseManifest(value: unknown): StoreManifestV1 | StoreManifestV2 | StoreManifestV3 {
  if (!isRecord(value)) throw new Error('binding store manifest must be an object')
  if (!Number.isSafeInteger(value.schemaVersion)) {
    throw new Error('binding store manifest schemaVersion must be an integer')
  }
  const version = Number(value.schemaVersion)
  if (version > BINDING_STORE_SCHEMA_VERSION) {
    throw new BindingStoreVersionError(version, BINDING_STORE_SCHEMA_VERSION)
  }
  if (version !== 1 && version !== 2 && version !== 3)
    throw new Error(`unsupported binding store version ${version}`)
  return {
    ...value,
    schemaVersion: version,
    createdAt: requiredString(value.createdAt, 'manifest.createdAt'),
    ...(version >= 2
      ? { legacyMigration: (value.legacyMigration ?? null) as LegacyMigrationResult | null }
      : {}),
    ...(version === 3
      ? { codexReceiptFold: (value.codexReceiptFold ?? null) as CodexReceiptFoldResult | null }
      : {}),
  } as StoreManifestV1 | StoreManifestV2 | StoreManifestV3
}

async function readDirectory(dir: string): Promise<Dirent<string>[]> {
  try {
    return await readdir(dir, { withFileTypes: true })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
}

interface LegacyReceipt {
  sessionId: SessionId
  nativeId: string
  processOwned: boolean
  claimed: boolean
  pendingServerAck: boolean
  observedAt: string
}

async function legacyReceipts(dir: string): Promise<LegacyReceipt[]> {
  const receipts: Omit<LegacyReceipt, 'pendingServerAck'>[] = []
  for (const entry of await readDirectory(dir)) {
    if (!entry.isFile()) continue
    const regular = RECEIPT_NAME.exec(entry.name)
    const claim = CLAIM_NAME.exec(entry.name)
    const session = regular?.[1] ?? claim?.[1]
    if (!session) continue
    const path = join(dir, entry.name)
    try {
      const payload = await readJson(path)
      if (!isRecord(payload)) continue
      const nativeId = requiredString(payload.session_id, `${path}.session_id`)
      const info = await stat(path)
      receipts.push({
        sessionId: asSessionId(session),
        nativeId,
        processOwned: payload.hook_event_name === 'PodiumProcessBinding',
        claimed: Boolean(claim),
        observedAt: info.mtime.toISOString(),
      })
    } catch {
      // The shipped spool reader ignored malformed files. Migration mirrors that
      // tolerance; the retired directory is removed after valid facts are durable.
    }
  }
  const sessionsWithRegularReceipt = new Set(
    receipts.filter((receipt) => !receipt.claimed).map((receipt) => receipt.sessionId),
  )
  return receipts
    .map((receipt) => ({
      ...receipt,
      // The retired spool recovered a lone crash-claim, but discarded it when
      // a newer regular receipt already existed for the same session. Keep the
      // claim as history without replaying it over the newer observation.
      pendingServerAck: !receipt.claimed || !sessionsWithRegularReceipt.has(receipt.sessionId),
    }))
    .sort(
      (a, b) =>
        a.observedAt.localeCompare(b.observedAt) ||
        a.sessionId.localeCompare(b.sessionId) ||
        a.nativeId.localeCompare(b.nativeId),
    )
}

async function daemonMachineId(stateDir: string): Promise<MachineId | null> {
  try {
    const payload = await readJson(join(stateDir, 'daemon.json'))
    return isRecord(payload) && typeof payload.machineId === 'string' && payload.machineId
      ? asMachineId(payload.machineId)
      : null
  } catch {
    return null
  }
}

function migrationObservationId(parts: readonly string[]): string {
  return `legacy:${createHash('sha256').update(parts.join('\u0000')).digest('hex').slice(0, 24)}`
}

export class BindingStore {
  private readonly now: () => string
  private manifest: StoreManifestV3
  private readonly writes = new Map<SessionId, Promise<unknown>>()

  private constructor(
    readonly dir: string,
    manifest: StoreManifestV3,
    now: () => string,
  ) {
    this.manifest = manifest
    this.now = now
  }

  static async open(options: OpenBindingStoreOptions): Promise<BindingStore> {
    const now = options.now ?? (() => new Date().toISOString())
    await mkdir(join(options.dir, BINDINGS_DIR), { recursive: true, mode: 0o700 })
    const manifestPath = join(options.dir, MANIFEST_NAME)
    let manifest: StoreManifestV1 | StoreManifestV2 | StoreManifestV3
    try {
      manifest = parseManifest(await readJson(manifestPath))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      manifest = {
        schemaVersion: 3,
        createdAt: now(),
        legacyMigration: null,
        codexReceiptFold: null,
      }
      await atomicJsonWrite(manifestPath, manifest)
    }

    // Forward-only, daemon-owned migrations. This lineage is intentionally not
    // represented in, or derived from, the server drizzle journal.
    if (manifest.schemaVersion === 1) {
      manifest = { ...manifest, schemaVersion: 2, legacyMigration: null }
      await atomicJsonWrite(manifestPath, manifest)
    }
    if (manifest.schemaVersion === 2) {
      manifest = { ...manifest, schemaVersion: 3, codexReceiptFold: null }
      await atomicJsonWrite(manifestPath, manifest)
    }
    const store = new BindingStore(options.dir, manifest, now)
    if (options.legacyStateDir && manifest.legacyMigration === null) {
      await store.migrateLegacyState({
        stateDir: options.legacyStateDir,
        bindings: options.legacyBindings ?? [],
        singleOperatorUserId: options.singleOperatorUserId,
        codexReceiptDir:
          options.codexReceiptDir ??
          join(options.legacyStateDir, 'runtime', 'codex-identity-receipts'),
      })
    }
    if (options.legacyStateDir) {
      await store.foldLegacyCodexReceipts({
        stateDir: options.legacyStateDir,
        codexReceiptDir:
          options.codexReceiptDir ??
          join(options.legacyStateDir, 'runtime', 'codex-identity-receipts'),
        singleOperatorUserId: options.singleOperatorUserId,
      })
    }
    return store
  }

  get schemaVersion(): number {
    return this.manifest.schemaVersion
  }

  get legacyMigration(): LegacyMigrationResult | null {
    return this.manifest.legacyMigration
  }

  get codexReceiptFold(): CodexReceiptFoldResult | null {
    return this.manifest.codexReceiptFold
  }

  pathFor(sessionId: SessionId): string {
    return join(this.dir, BINDINGS_DIR, `${fileStem(sessionId)}.json`)
  }

  async read(sessionId: SessionId): Promise<SessionBindingRecord | null> {
    try {
      return parseBinding(await readJson(this.pathFor(sessionId)))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw error
    }
  }

  /** Owner-scoped by construction; callers never receive other humans' rows. */
  async bindingsForOwner(owner: UserId): Promise<SessionBindingRecord[]> {
    const rows: SessionBindingRecord[] = []
    for (const entry of await readDirectory(join(this.dir, BINDINGS_DIR))) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue
      const row = parseBinding(await readJson(join(this.dir, BINDINGS_DIR, entry.name)))
      if (this.currentDelegation(row)?.onBehalfOf === owner) rows.push(row)
    }
    return rows.sort((a, b) => a.sessionId.localeCompare(b.sessionId))
  }

  private bindingOwner(binding: SessionBindingRecord): UserId | null {
    return binding.delegationHistory.at(-1)?.onBehalfOf ?? null
  }

  private bindingAcceptsNativeKind(binding: SessionBindingRecord, nativeKind: string): boolean {
    return manifestFor(binding.agentKind)?.resumeKind === nativeKind
  }

  /** Uniform host-local applicability check; no session or owner detail escapes. */
  async acceptsNativeKind(sessionId: SessionId, nativeKind: string): Promise<boolean> {
    const binding = await this.read(sessionId)
    return binding ? this.bindingAcceptsNativeKind(binding, nativeKind) : false
  }

  private async allBindings(): Promise<SessionBindingRecord[]> {
    const rows: SessionBindingRecord[] = []
    for (const entry of await readDirectory(join(this.dir, BINDINGS_DIR))) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue
      rows.push(parseBinding(await readJson(join(this.dir, BINDINGS_DIR, entry.name))))
    }
    return rows.sort((a, b) => a.sessionId.localeCompare(b.sessionId))
  }

  /** Owner ids only; policy decides whether a machine principal may enumerate them. */
  async ownersWithPendingReceipts(): Promise<UserId[]> {
    const owners = new Set<UserId>()
    for (const binding of await this.allBindings()) {
      if (!binding.observations.some((entry) => entry.pendingServerAck)) continue
      const owner = this.bindingOwner(binding)
      if (owner) owners.add(owner)
    }
    return [...owners].sort()
  }

  /** Receipt reads are owner-scoped before any session/native value leaves the store. */
  async pendingReceiptsForOwner(
    owner: UserId,
  ): Promise<Array<{ sessionId: SessionId; nativeKind: string; value: string }>> {
    const receipts = new Map<string, { sessionId: SessionId; nativeKind: string; value: string }>()
    for (const binding of await this.allBindings()) {
      if (this.bindingOwner(binding) !== owner) continue
      for (const observation of binding.observations) {
        const pending = observation.pendingServerAck
        if (!pending) continue
        const receipt = { sessionId: binding.sessionId, ...pending }
        receipts.set(
          `${receipt.sessionId}\u0000${receipt.nativeKind}\u0000${receipt.value}`,
          receipt,
        )
      }
    }
    return [...receipts.values()]
  }

  /** Persist exact Codex evidence and its delivery state in the binding record itself. */
  async recordPendingCodexReceipt(
    sessionId: SessionId,
    nativeId: string,
    source: 'native-hook' | 'process',
    observedAt = this.now(),
  ): Promise<boolean> {
    const binding = await this.read(sessionId)
    if (
      !nativeId ||
      !binding ||
      !this.bindingAcceptsNativeKind(binding, 'codex-thread') ||
      this.bindingOwner(binding) === null
    ) {
      return false
    }
    await this.observe({
      sessionId,
      channel: source === 'process' ? 'process-ownership' : 'resume-ref',
      value: nativeId,
      nativeKind: 'codex-thread',
      confidence: 'exact',
      source,
      observedAt,
      pendingServerAck: { nativeKind: 'codex-thread', value: nativeId },
    })
    return true
  }

  async replayPendingReceiptsForOwner(
    owner: UserId,
    send: (msg: DaemonMessage) => void,
  ): Promise<number> {
    const receipts = await this.pendingReceiptsForOwner(owner)
    for (const receipt of receipts) {
      send({
        type: 'sessionResumeRef',
        sessionId: receipt.sessionId,
        resume: { kind: receipt.nativeKind, value: receipt.value },
        confidence: 'exact',
        ackRequested: true,
      })
    }
    return receipts.length
  }

  /** Clear only the exact receipt on the binding owned by the acknowledged human. */
  async acknowledgePendingReceipt(
    owner: UserId | undefined,
    sessionId: SessionId,
    resume: { kind: string; value: string },
  ): Promise<boolean> {
    if (!owner || resume.kind !== 'codex-thread') return false
    const binding = await this.read(sessionId)
    if (!binding || this.bindingOwner(binding) !== owner) return false
    let acknowledged = false
    await this.update(sessionId, (current) => {
      if (!current || this.bindingOwner(current) !== owner) return current ?? binding
      const observations = current.observations.map((entry) => {
        if (
          entry.pendingServerAck?.nativeKind !== resume.kind ||
          entry.pendingServerAck.value !== resume.value
        ) {
          return entry
        }
        acknowledged = true
        const { pendingServerAck: _pendingServerAck, ...rest } = entry
        return rest as BindingObservation
      })
      return acknowledged ? { ...current, observations } : current
    })
    return acknowledged
  }

  currentDelegation(binding: SessionBindingRecord): BindingDelegationObservation | null {
    const latest = binding.delegationHistory.at(-1)
    return latest && !latest.retired ? latest : null
  }

  private async update(
    sessionId: SessionId,
    change: (
      current: SessionBindingRecord | null,
    ) => Promise<SessionBindingRecord> | SessionBindingRecord,
  ): Promise<SessionBindingRecord> {
    const prior = this.writes.get(sessionId) ?? Promise.resolve()
    const next = prior.then(async () => {
      const changed = await change(await this.read(sessionId))
      await atomicBindingWrite(this.pathFor(sessionId), changed)
      return changed
    })
    this.writes.set(sessionId, next)
    try {
      return await next
    } finally {
      if (this.writes.get(sessionId) === next) this.writes.delete(sessionId)
    }
  }
  /**
   * Apply one explicit binding event atomically. Authorization decisions arrive
   * as inputs from their owning live resolvers; this method stores only the
   * delegation reference and identity evidence.
   */
  async transition(input: SessionBindingTransition): Promise<SessionBindingTransitionOutcome> {
    // Authorization runs before arbitration. The lower layer therefore never
    // reads the binding for a caller policy has reduced to `not-found`, and its
    // answer is byte-identical to the genuinely missing-row case below.
    if (input.event === 'reattach' && input.sessionAccess === 'not-found') {
      return { status: 'denied', event: 'reattach', reason: 'not-found', terminal: true }
    }
    if (input.event === 'spawn' || input.event === 'reattach' || input.event === 'adopt') {
      const placement = machineAccessOutcome(input.event, input.machineAccess)
      if (placement) return placement
    }

    const prior = this.writes.get(input.sessionId) ?? Promise.resolve()
    const next = prior.then(async (): Promise<SessionBindingTransitionOutcome> => {
      const current = await this.read(input.sessionId)
      if (current?.transitionHistory.some((entry) => entry.transitionId === input.transitionId)) {
        return { status: 'unchanged', event: input.event, binding: current }
      }

      let changed: SessionBindingRecord | null = null
      switch (input.event) {
        case 'spawn': {
          if (current) return transitionRejected(input.event, 'binding-exists')
          const createdAt = input.createdAt ?? this.now()
          const narrowDefault: DelegationScope = input.issueId
            ? { kind: 'subtree', rootId: input.issueId }
            : { kind: 'none' }
          let delegation: {
            actor: AgentIdentityId
            onBehalfOf: UserId
            grantedScope: DelegationScope
            parentBindingId: SessionId | null
          } | null = null

          if (input.principal.kind === 'user') {
            const grantedScope = input.requestedScope ?? narrowDefault
            if (
              input.requestedScope &&
              !input.scopeOverrideConfirmed &&
              !scopeWithin(grantedScope, narrowDefault)
            ) {
              return transitionRejected(input.event, 'scope-widening-denied')
            }
            delegation = {
              actor: asAgentIdentityId(input.sessionId),
              onBehalfOf: input.principal.userId,
              grantedScope,
              parentBindingId: null,
            }
          } else if (input.principal.kind === 'agent') {
            const parent = await this.read(input.principal.parentBindingId)
            if (!parent) return transitionRejected(input.event, 'parent-binding-missing')
            const parentDelegation = this.currentDelegation(parent)
            if (!parentDelegation) {
              return transitionRejected(input.event, 'parent-delegation-missing')
            }
            const grantedScope = input.requestedScope ?? narrowDefault
            if (!scopeWithin(grantedScope, parentDelegation.grantedScope)) {
              return transitionRejected(input.event, 'scope-widening-denied')
            }
            delegation = {
              actor: asAgentIdentityId(input.sessionId),
              onBehalfOf: parentDelegation.onBehalfOf,
              grantedScope,
              parentBindingId: input.principal.parentBindingId,
            }
          }

          const base: SessionBindingRecord = {
            schemaVersion: 1,
            sessionId: input.sessionId,
            conversationId: null,
            agentKind: input.agentKind,
            claimantMachineId: input.claimantMachineId,
            attemptId: input.attemptId ?? null,
            observationGeneration: input.observationGeneration ?? 1,
            observations: [],
            delegationHistory: delegation
              ? [
                  {
                    observationId: randomUUID(),
                    ...delegation,
                    observedAt: createdAt,
                    recordedAt: this.now(),
                    supersedes: null,
                    retired: false,
                  },
                ]
              : [],
            transitionHistory: [],
            transfer: null,
            state: 'unbound',
            createdAt,
            retiredAt: null,
          }
          changed = withTransitionReceipt(base, input, this.now())
          break
        }

        case 'reattach': {
          if (!current) {
            return { status: 'denied', event: 'reattach', reason: 'not-found', terminal: true }
          }
          if (current.state === 'retired' || current.state === 'exported') {
            return transitionRejected(input.event, 'binding-retired')
          }
          if (current.state === 'exporting' || current.state === 'adopting') {
            return transitionRejected(input.event, 'transfer-conflict')
          }
          if (current.claimantMachineId !== input.claimantMachineId) {
            return transitionRejected(input.event, 'claimant-mismatch')
          }
          const acceptedClaim = current.transitionHistory.findLast(
            (entry) =>
              entry.event === 'reattach' &&
              entry.reattachClaim?.requestedGeneration === input.requestedGeneration,
          )?.reattachClaim
          if (acceptedClaim) {
            if (stableEqual(acceptedClaim.principal, input.principal)) {
              return { status: 'redundant', event: 'reattach', binding: current }
            }
            return {
              status: 'denied',
              event: 'reattach',
              reason: 'not-claimant',
              terminal: true,
            }
          }
          if (input.requestedGeneration < current.observationGeneration) {
            return transitionRejected(input.event, 'stale-generation')
          }
          changed = withTransitionReceipt(
            {
              ...current,
              observationGeneration: input.requestedGeneration,
              attemptId: input.attemptId === undefined ? current.attemptId : input.attemptId,
            },
            input,
            this.now(),
          )
          break
        }

        case 'hook-repin': {
          if (!current) return transitionRejected(input.event, 'binding-missing')
          if (current.state === 'retired' || current.state === 'exported') {
            return transitionRejected(input.event, 'binding-retired')
          }
          if (current.state === 'exporting' || current.state === 'adopting') {
            return transitionRejected(input.event, 'transfer-conflict')
          }
          if (current.agentKind === 'shell') {
            return transitionRejected(input.event, 'unsupported-agent-transition')
          }
          const head = current.observations.findLast(
            (entry) => entry.channel === 'resume-ref' && entry.confidence === 'exact',
          )
          const ordered =
            !head ||
            head.value === input.value ||
            input.supersedesObservationId === head.observationId
          const observation: BindingObservation = {
            observationId: randomUUID(),
            channel: 'resume-ref',
            value: input.value,
            nativeKind: input.nativeKind,
            confidence: 'exact',
            source: input.evidenceSource === 'hook-receipt' ? 'native-hook' : 'process',
            observedAt: input.observedAt,
            recordedAt: this.now(),
            supersedes: ordered ? (head?.observationId ?? null) : null,
            ...(ordered && input.pendingServerAck
              ? { pendingServerAck: input.pendingServerAck }
              : {}),
          }
          changed = withTransitionReceipt(
            {
              ...current,
              observations: [...current.observations, observation],
              state: ordered ? 'bound' : 'conflicted',
            },
            input,
            this.now(),
          )
          break
        }

        case 'headless-allocation': {
          if (!current) return transitionRejected(input.event, 'binding-missing')
          if (current.state === 'retired' || current.state === 'exported') {
            return transitionRejected(input.event, 'binding-retired')
          }
          if (current.state === 'exporting' || current.state === 'adopting') {
            return transitionRejected(input.event, 'transfer-conflict')
          }
          if (current.agentKind === 'shell') {
            return transitionRejected(input.event, 'unsupported-agent-transition')
          }
          const observations = [...current.observations]
          if (input.value) {
            const head = observations.findLast(
              (entry) => entry.channel === 'resume-ref' && entry.confidence === 'exact',
            )
            observations.push({
              observationId: randomUUID(),
              channel: 'resume-ref',
              value: input.value,
              nativeKind: input.nativeKind,
              confidence: 'exact',
              source: 'headless-driver',
              observedAt: input.observedAt,
              recordedAt: this.now(),
              supersedes: head?.observationId ?? null,
            })
          }
          changed = withTransitionReceipt(
            {
              ...current,
              attemptId: input.attemptId,
              observations,
              state: input.value ? 'bound' : current.state,
            },
            input,
            this.now(),
          )
          break
        }

        case 'adopt': {
          if (input.role === 'source') {
            if (!current) return transitionRejected(input.event, 'binding-missing')
            if (current.state === 'retired' || current.state === 'exported') {
              return transitionRejected(input.event, 'binding-retired')
            }
            if (current.claimantMachineId !== input.fromMachineId) {
              return transitionRejected(input.event, 'claimant-mismatch')
            }
            if (input.phase === 'claim') {
              if (current.transfer?.phase === 'claimed') {
                return transitionRejected(input.event, 'transfer-conflict')
              }
              changed = {
                ...current,
                state: 'exporting',
                attemptId: null,
                transfer: {
                  transferId: input.transferId,
                  side: 'source',
                  phase: 'claimed',
                  fromMachineId: input.fromMachineId,
                  toMachineId: input.toMachineId,
                  claimedAt: input.at,
                  settledAt: null,
                  priorState: current.state,
                },
              }
            } else {
              if (
                !current.transfer ||
                current.transfer.transferId !== input.transferId ||
                current.transfer.side !== 'source'
              ) {
                return transitionRejected(input.event, 'transfer-conflict')
              }
              if (input.phase === 'commit') {
                if (current.transfer.phase !== 'claimed') {
                  return transitionRejected(input.event, 'transfer-conflict')
                }
                changed = {
                  ...current,
                  state: 'exported',
                  attemptId: null,
                  transfer: {
                    ...current.transfer,
                    phase: 'committed',
                    settledAt: input.at,
                  },
                }
              } else if (input.phase === 'abort') {
                if (current.transfer.phase !== 'claimed') {
                  return transitionRejected(input.event, 'transfer-conflict')
                }
                changed = {
                  ...current,
                  state: current.transfer.priorState ?? 'unbound',
                  transfer: {
                    ...current.transfer,
                    phase: 'aborted',
                    settledAt: input.at,
                  },
                }
              } else {
                if (current.transfer.phase !== 'aborted' || !input.attemptId) {
                  return transitionRejected(input.event, 'transfer-conflict')
                }
                changed = { ...current, attemptId: input.attemptId }
              }
            }
          } else if (input.phase === 'claim') {
            const adoption = input.adoption
            if (!adoption) return transitionRejected(input.event, 'adoption-missing')
            if (
              current &&
              current.state !== 'exported' &&
              !(
                current.state === 'retired' &&
                current.transfer?.side === 'target' &&
                current.transfer.phase === 'aborted'
              )
            ) {
              return transitionRejected(input.event, 'transfer-conflict')
            }
            const priorDelegation = current?.delegationHistory.at(-1)
            if (
              priorDelegation &&
              !stableEqual(
                {
                  actor: priorDelegation.actor,
                  onBehalfOf: priorDelegation.onBehalfOf,
                  grantedScope: priorDelegation.grantedScope,
                  parentBindingId: priorDelegation.parentBindingId,
                },
                adoption.delegation,
              )
            ) {
              return transitionRejected(input.event, 'adoption-identity-mismatch')
            }
            const recordedAt = this.now()
            const observations = [...(current?.observations ?? [])]
            for (const imported of adoption.observations) {
              const predecessor = observations.findLast(
                (entry) => entry.channel === imported.channel,
              )
              observations.push({
                observationId: randomUUID(),
                ...imported,
                confidence: 'exact',
                source: 'handoff-import',
                observedAt: input.at,
                recordedAt,
                supersedes: predecessor?.observationId ?? null,
              })
            }
            const delegationHistory = current?.delegationHistory.length
              ? current.delegationHistory
              : [
                  {
                    observationId: randomUUID(),
                    ...adoption.delegation,
                    observedAt: input.at,
                    recordedAt,
                    supersedes: null,
                    retired: false,
                  },
                ]
            changed = {
              schemaVersion: 1,
              ...(current ?? {}),
              sessionId: input.sessionId,
              conversationId: current?.conversationId ?? null,
              agentKind: adoption.agentKind,
              claimantMachineId: input.toMachineId,
              attemptId: null,
              observationGeneration: adoption.observationGeneration,
              observations,
              delegationHistory,
              transitionHistory: current?.transitionHistory ?? [],
              transfer: {
                transferId: input.transferId,
                side: 'target',
                phase: 'claimed',
                fromMachineId: input.fromMachineId,
                toMachineId: input.toMachineId,
                claimedAt: input.at,
                settledAt: null,
                priorState: current?.state ?? null,
              },
              state: 'adopting',
              createdAt: current?.createdAt ?? input.at,
              retiredAt: null,
            }
          } else {
            if (
              !current?.transfer ||
              current.transfer.transferId !== input.transferId ||
              current.transfer.side !== 'target'
            ) {
              return transitionRejected(input.event, 'transfer-conflict')
            }
            if (input.phase === 'commit') {
              if (current.transfer.phase !== 'claimed') {
                return transitionRejected(input.event, 'transfer-conflict')
              }
              changed = {
                ...current,
                state: 'bound',
                transfer: {
                  ...current.transfer,
                  phase: 'committed',
                  settledAt: input.at,
                },
              }
            } else if (input.phase === 'abort') {
              if (current.transfer.phase !== 'claimed') {
                return transitionRejected(input.event, 'transfer-conflict')
              }
              changed = {
                ...current,
                state: current.transfer.priorState ?? 'retired',
                retiredAt: current.transfer.priorState === null ? input.at : current.retiredAt,
                transfer: {
                  ...current.transfer,
                  phase: 'aborted',
                  settledAt: input.at,
                },
              }
            } else {
              if (
                current.transfer.phase !== 'committed' ||
                current.state !== 'bound' ||
                !input.attemptId
              ) {
                return transitionRejected(input.event, 'transfer-conflict')
              }
              changed = { ...current, attemptId: input.attemptId }
            }
          }
          changed = withTransitionReceipt(changed, input, this.now())
          break
        }
      }

      if (!changed) throw new Error(`binding transition ${input.event} produced no outcome`)
      await atomicBindingWrite(this.pathFor(input.sessionId), changed)
      return { status: 'applied', event: input.event, binding: changed }
    })

    this.writes.set(input.sessionId, next)
    try {
      return await next
    } finally {
      if (this.writes.get(input.sessionId) === next) this.writes.delete(input.sessionId)
    }
  }

  async ensureBinding(input: EnsureBindingInput): Promise<SessionBindingRecord> {
    return this.update(input.sessionId, (current) => {
      const createdAt = input.createdAt ?? this.now()
      const next: SessionBindingRecord = current
        ? {
            ...current,
            agentKind: input.agentKind,
            claimantMachineId: input.claimantMachineId,
            attemptId: input.attemptId === undefined ? current.attemptId : input.attemptId,
            conversationId:
              input.conversationId === undefined ? current.conversationId : input.conversationId,
            observationGeneration: Math.max(
              current.observationGeneration,
              input.observationGeneration ?? 0,
            ),
          }
        : {
            schemaVersion: 1,
            sessionId: input.sessionId,
            conversationId: input.conversationId ?? null,
            agentKind: input.agentKind,
            claimantMachineId: input.claimantMachineId,
            attemptId: input.attemptId ?? null,
            observationGeneration: input.observationGeneration ?? 0,
            observations: [],
            delegationHistory: [],
            transitionHistory: [],
            transfer: null,
            state: 'unbound',
            createdAt,
            retiredAt: null,
          }
      if (input.delegation) {
        const head = this.currentDelegation(next)
        const identity = {
          actor: input.delegation.actor,
          onBehalfOf: input.delegation.onBehalfOf,
          grantedScope: input.delegation.grantedScope,
          parentBindingId: input.delegation.parentBindingId,
        }
        if (
          !head ||
          !stableEqual(identity, {
            actor: head.actor,
            onBehalfOf: head.onBehalfOf,
            grantedScope: head.grantedScope,
            parentBindingId: head.parentBindingId,
          })
        ) {
          const observedAt = createdAt
          next.delegationHistory = [
            ...next.delegationHistory,
            {
              observationId: randomUUID(),
              ...identity,
              observedAt,
              recordedAt: this.now(),
              supersedes: head?.observationId ?? null,
              retired: false,
            },
          ]
        }
      }
      return next
    })
  }

  async observe(input: ObserveBindingInput): Promise<SessionBindingRecord> {
    return this.update(input.sessionId, (current) => {
      if (!current) throw new Error(`binding ${input.sessionId} does not exist`)
      const duplicate = current.observations.find(
        (entry) =>
          entry.channel === input.channel &&
          entry.value === input.value &&
          entry.nativeKind === input.nativeKind &&
          entry.confidence === input.confidence &&
          entry.source === input.source,
      )
      if (duplicate) {
        if (
          input.pendingServerAck &&
          !stableEqual(duplicate.pendingServerAck, input.pendingServerAck)
        ) {
          return {
            ...current,
            observations: current.observations.map((entry) =>
              entry.observationId === duplicate.observationId
                ? { ...entry, pendingServerAck: input.pendingServerAck }
                : entry,
            ),
          }
        }
        return current
      }
      const head = current.observations.findLast(
        (entry) => entry.channel === input.channel && entry.confidence === 'exact',
      )
      const observation: BindingObservation = {
        observationId: randomUUID(),
        channel: input.channel,
        value: input.value,
        ...(input.nativeKind ? { nativeKind: input.nativeKind } : {}),
        confidence: input.confidence,
        source: input.source,
        observedAt: input.observedAt,
        recordedAt: this.now(),
        supersedes: head?.observationId ?? null,
        ...(input.pendingServerAck ? { pendingServerAck: input.pendingServerAck } : {}),
      }
      return {
        ...current,
        observations: [...current.observations, observation],
        state:
          bindsNativeArtifact(input.channel) && input.confidence === 'exact' && input.value !== null
            ? 'bound'
            : current.state,
      }
    })
  }

  async retire(sessionId: SessionId, retiredAt = this.now()): Promise<SessionBindingRecord> {
    return this.update(sessionId, (current) => {
      if (!current) throw new Error(`binding ${sessionId} does not exist`)
      if (current.state === 'retired') return current
      const head = this.currentDelegation(current)
      return {
        ...current,
        state: 'retired',
        retiredAt,
        delegationHistory: head
          ? [
              ...current.delegationHistory,
              {
                ...head,
                observationId: randomUUID(),
                observedAt: retiredAt,
                recordedAt: this.now(),
                supersedes: head.observationId,
                retired: true,
              },
            ]
          : current.delegationHistory,
      }
    })
  }

  /**
   * Move the shipped receipt directory into binding observations, then remove
   * the directory only after every valid receipt and the fold marker are
   * durable. Re-running is intentional: an old, still-live Codex process can
   * write one last legacy receipt during a rolling daemon upgrade.
   */
  private async foldLegacyCodexReceipts(input: {
    stateDir: string
    codexReceiptDir: string
    singleOperatorUserId?: UserId
  }): Promise<void> {
    const receipts = await legacyReceipts(input.codexReceiptDir)
    if (receipts.length > 0) {
      const machineId = await daemonMachineId(input.stateDir)
      for (const receipt of receipts) {
        let binding = await this.read(receipt.sessionId)
        if (!binding) {
          if (!input.singleOperatorUserId) {
            throw new LegacyBindingMigrationError(
              'legacy Codex receipts exist but POD-1075 first-admin UserId was not supplied',
            )
          }
          if (!machineId) {
            throw new LegacyBindingMigrationError(
              `legacy Codex receipts exist but ${join(input.stateDir, 'daemon.json')} has no machineId`,
            )
          }
          binding = await this.ensureBinding({
            sessionId: receipt.sessionId,
            agentKind: 'codex',
            claimantMachineId: machineId,
            createdAt: receipt.observedAt,
            delegation: {
              actor: asAgentIdentityId(receipt.sessionId),
              onBehalfOf: input.singleOperatorUserId,
              grantedScope: { kind: 'all' },
              parentBindingId: null,
            },
          })
        }
        if (
          !this.bindingAcceptsNativeKind(binding, 'codex-thread') ||
          this.bindingOwner(binding) === null
        ) {
          throw new LegacyBindingMigrationError(
            `legacy Codex receipt ${receipt.sessionId} does not point at an owned Codex binding`,
          )
        }
        const source = receipt.processOwned ? 'process' : 'native-hook'
        if (receipt.pendingServerAck) {
          await this.recordPendingCodexReceipt(
            receipt.sessionId,
            receipt.nativeId,
            source,
            receipt.observedAt,
          )
        } else {
          await this.observe({
            sessionId: receipt.sessionId,
            channel: receipt.processOwned ? 'process-ownership' : 'resume-ref',
            value: receipt.nativeId,
            nativeKind: 'codex-thread',
            confidence: 'exact',
            source,
            observedAt: receipt.observedAt,
          })
        }
      }

      // POD-415 may already have lifted these files into schema v2 before the
      // fold. Reconcile superseded claims that v2 marked pending, without
      // clearing a same-value regular receipt that remains genuinely pending.
      const activeKeys = new Set(
        receipts
          .filter((receipt) => receipt.pendingServerAck)
          .map((receipt) => `${receipt.sessionId}\u0000${receipt.nativeId}`),
      )
      for (const receipt of receipts) {
        const key = `${receipt.sessionId}\u0000${receipt.nativeId}`
        if (receipt.pendingServerAck || activeKeys.has(key)) continue
        const binding = await this.read(receipt.sessionId)
        const owner = binding && this.bindingOwner(binding)
        if (owner) {
          await this.acknowledgePendingReceipt(owner, receipt.sessionId, {
            kind: 'codex-thread',
            value: receipt.nativeId,
          })
        }
      }
    }

    if (!this.manifest.codexReceiptFold) {
      this.manifest = {
        ...this.manifest,
        codexReceiptFold: {
          completedAt: this.now(),
          sourceReceiptDir: input.codexReceiptDir,
          inventory: {
            receipts: receipts.filter((receipt) => !receipt.claimed).length,
            claims: receipts.filter((receipt) => receipt.claimed).length,
          },
        },
      }
      await atomicJsonWrite(join(this.dir, MANIFEST_NAME), this.manifest)
    }

    // The marker and binding rows are durable before the old store disappears.
    await rm(input.codexReceiptDir, { recursive: true, force: true })
  }

  async migrateLegacyState(input: {
    stateDir: string
    bindings: readonly LegacyBindingSnapshot[]
    singleOperatorUserId?: UserId
    codexReceiptDir: string
  }): Promise<LegacyMigrationResult> {
    if (this.manifest.legacyMigration) return this.manifest.legacyMigration
    const receipts = await legacyReceipts(input.codexReceiptDir)
    const hasBindingFacts = input.bindings.length > 0 || receipts.length > 0
    if (hasBindingFacts && !input.singleOperatorUserId) {
      throw new LegacyBindingMigrationError(
        'legacy bindings exist but POD-1075 first-admin UserId was not supplied',
      )
    }
    const machineId = await daemonMachineId(input.stateDir)
    if (hasBindingFacts && !machineId) {
      throw new LegacyBindingMigrationError(
        `legacy bindings exist but ${join(input.stateDir, 'daemon.json')} has no machineId`,
      )
    }
    const migratedAt = this.now()
    const owner = input.singleOperatorUserId
    const snapshots = new Map(input.bindings.map((binding) => [binding.sessionId, binding]))
    for (const receipt of receipts) {
      if (!snapshots.has(receipt.sessionId)) {
        snapshots.set(receipt.sessionId, { sessionId: receipt.sessionId, agentKind: 'codex' })
      }
    }

    const observeLegacy = async (
      sessionId: SessionId,
      channel: BindingObservationChannel,
      value: string | null,
      source: ObservationSource,
      options: {
        nativeKind?: string
        observedAt?: string
        pendingServerAck?: { nativeKind: string; value: string }
      } = {},
    ): Promise<void> => {
      const id = migrationObservationId([
        sessionId,
        channel,
        value ?? '<null>',
        source,
        options.nativeKind ?? '',
      ])
      await this.update(sessionId, (current) => {
        if (!current) throw new Error(`binding ${sessionId} does not exist`)
        if (current.observations.some((entry) => entry.observationId === id)) return current
        const head = current.observations.findLast(
          (entry) => entry.channel === channel && entry.confidence === 'exact',
        )
        return {
          ...current,
          observations: [
            ...current.observations,
            {
              observationId: id,
              channel,
              value,
              ...(options.nativeKind ? { nativeKind: options.nativeKind } : {}),
              confidence: 'exact',
              source,
              observedAt: options.observedAt ?? migratedAt,
              recordedAt: migratedAt,
              supersedes: head?.observationId ?? null,
              ...(options.pendingServerAck ? { pendingServerAck: options.pendingServerAck } : {}),
            },
          ],
          state: value !== null && bindsNativeArtifact(channel) ? 'bound' : current.state,
        }
      })
    }

    for (const snapshot of snapshots.values()) {
      if (!machineId || !owner) {
        throw new LegacyBindingMigrationError(
          'legacy binding migration lost its validated machine or first-admin identity',
        )
      }
      await this.ensureBinding({
        sessionId: snapshot.sessionId,
        agentKind: snapshot.agentKind,
        claimantMachineId: machineId,
        // Today's durable host label is the only surviving identity of the
        // process attempt. It seeds the new attempt field; it is not a native
        // artifact observation (POD-414 W3 / §3.4.3).
        attemptId: snapshot.attemptId ?? snapshot.control?.durableLabel ?? null,
        conversationId: snapshot.conversationId,
        observationGeneration: snapshot.observationGeneration,
        createdAt: migratedAt,
        delegation: {
          actor: asAgentIdentityId(snapshot.sessionId),
          onBehalfOf: owner,
          // Legacy agents had the one operator's full reach. Preserve that
          // declared scope, still intersected with this human's CURRENT rights.
          grantedScope: { kind: 'all' },
          parentBindingId: null,
        },
      })
      if (snapshot.control?.cwd) {
        await observeLegacy(snapshot.sessionId, 'cwd', snapshot.control.cwd, 'legacy-control')
      }
      if (snapshot.control?.resume) {
        await observeLegacy(
          snapshot.sessionId,
          'resume-ref',
          snapshot.control.resume.value,
          'legacy-control',
          { nativeKind: snapshot.control.resume.kind },
        )
      }
      if (snapshot.observer?.providerSessionId) {
        await observeLegacy(
          snapshot.sessionId,
          'provider-session',
          snapshot.observer.providerSessionId,
          'legacy-observer',
          { nativeKind: snapshot.observer.resumeKind },
        )
      }
      if (snapshot.observer?.pathHint) {
        await observeLegacy(
          snapshot.sessionId,
          'transcript-path',
          snapshot.observer.pathHint,
          'legacy-observer',
        )
      }
      if (snapshot.adapter?.nativeId) {
        await observeLegacy(
          snapshot.sessionId,
          'provider-session',
          snapshot.adapter.nativeId,
          'legacy-adapter',
          { nativeKind: snapshot.adapter.resumeKind },
        )
      }
      if (snapshot.adapter?.transcriptPath) {
        await observeLegacy(
          snapshot.sessionId,
          'transcript-path',
          snapshot.adapter.transcriptPath,
          'legacy-adapter',
        )
      }
      if (snapshot.adapter?.rolloutPath) {
        await observeLegacy(
          snapshot.sessionId,
          'rollout-path',
          snapshot.adapter.rolloutPath,
          'legacy-adapter',
        )
      }
      if (snapshot.adapter?.cwd) {
        await observeLegacy(snapshot.sessionId, 'cwd', snapshot.adapter.cwd, 'legacy-adapter')
      }
      if (snapshot.adapter?.worktreePin) {
        await observeLegacy(
          snapshot.sessionId,
          'worktree-pin',
          snapshot.adapter.worktreePin,
          'legacy-adapter',
        )
      }
    }

    for (const receipt of receipts) {
      await observeLegacy(
        receipt.sessionId,
        receipt.processOwned ? 'process-ownership' : 'resume-ref',
        receipt.nativeId,
        receipt.processOwned ? 'process' : 'native-hook',
        {
          nativeKind: 'codex-thread',
          observedAt: receipt.observedAt,
          ...(receipt.pendingServerAck
            ? {
                pendingServerAck: {
                  nativeKind: 'codex-thread',
                  value: receipt.nativeId,
                },
              }
            : {}),
        },
      )
    }

    const result: LegacyMigrationResult = {
      completedAt: migratedAt,
      sourceStateDir: input.stateDir,
      inventory: {
        sessionObservers: input.bindings.filter((binding) => binding.observer).length,
        controlSessions: input.bindings.filter((binding) => binding.control).length,
        adapterPins: input.bindings.filter((binding) => binding.adapter).length,
        daemonIdentityFiles: machineId ? 1 : 0,
        codexReceipts: receipts.filter((receipt) => !receipt.claimed).length,
        codexReceiptClaims: receipts.filter((receipt) => receipt.claimed).length,
      },
    }
    this.manifest = { ...this.manifest, legacyMigration: result }
    await atomicJsonWrite(join(this.dir, MANIFEST_NAME), this.manifest)
    return result
  }
}

/** Human-readable diagnostic only; paths remain instance-scoped, never user-scoped. */
export function bindingStoreDescription(dir: string): string {
  return `binding store ${basename(dir)} schema v${BINDING_STORE_SCHEMA_VERSION} (daemon-local, independent of server drizzle)`
}

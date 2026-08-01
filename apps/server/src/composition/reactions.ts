import type { EventName } from '../modules/bus'

/**
 * Operational contract for one semantically asynchronous application reaction.
 *
 * This is deliberately data, not prose hidden beside a subscriber. New reactions
 * must choose every reliability and identity property before they can be added to
 * the registry. `assertReactionRegistryTotal` repeats the check at runtime so
 * generated/JSON definitions cannot bypass TypeScript's totality.
 */
export type ReactionPrincipal =
  | {
      class: 'system'
      actor: 'system'
      /** System work inherits the visibility of the entity it maintains. */
      writeScope: 'acted-on-entity'
    }
  | {
      class: 'delegated'
      /** Persist and resolve this reference; never persist an effective capability. */
      delegation: 'live-reference'
      reauthorizeAtApply: true
    }

export type ReactionReplay =
  | { mode: 'none'; reason: string }
  | {
      mode: 'startup-reconcile'
      sourceOfTruth: string
      /** Durable replay must resolve the principal/delegation again at apply time. */
      reauthorizeAtApply: true
    }

export interface ReactionDefinition {
  id: string
  description: string
  trigger: EventName | 'startup' | 'janitor.tick' | 'daemon.discovery' | 'mirror.bytes'
  durability: 'in-memory' | 'durable'
  replay: ReactionReplay
  idempotency: {
    key: string
    duplicatePolicy: 'coalesce' | 'deduplicate' | 'safe-repeat' | 'best-effort-repeat'
  }
  ordering: string
  retry: string
  failureOwner: string
  observability: {
    registry: true
    events: readonly string[]
    metrics: readonly string[]
  }
  principal: ReactionPrincipal
  /** Extra privacy/routing invariant where the generic principal declaration is insufficient. */
  scopeInvariant: string
}

const system = (): ReactionPrincipal => ({
  class: 'system',
  actor: 'system',
  writeScope: 'acted-on-entity',
})

const delegated = (): ReactionPrincipal => ({
  class: 'delegated',
  delegation: 'live-reference',
  reauthorizeAtApply: true,
})

/**
 * The ledger-visible registry. Entries describe independently observable
 * reactions, even when several share one EventBus subscription in the runtime.
 */
export const REACTIONS = [
  {
    id: 'settings.feature-cache',
    description: 'Refresh the process-local feature snapshot after settings change.',
    trigger: 'settings.changed',
    durability: 'in-memory',
    replay: { mode: 'none', reason: 'Startup reads the current durable settings row.' },
    idempotency: { key: 'settings revision', duplicatePolicy: 'safe-repeat' },
    ordering: 'EventBus listener order within one process.',
    retry: 'No retry; the next settings event or process restart refreshes the snapshot.',
    failureOwner: 'settings module',
    observability: { registry: true, events: ['settings.changed'], metrics: [] },
    principal: system(),
    scopeInvariant: 'Read-only derived cache; it performs no attributed write.',
  },
  {
    id: 'sessions.machine-derived-fields',
    description: 'Recapture session machine-name projections after fleet metadata changes.',
    trigger: 'machine.metadataChanged',
    durability: 'in-memory',
    replay: {
      mode: 'none',
      reason: 'Session load derives machine names from current durable rows.',
    },
    idempotency: { key: 'machineId + machine row revision', duplicatePolicy: 'coalesce' },
    ordering: 'Per-machine EventBus order; session publication remains ledger ordered.',
    retry: 'The next metadata change or client bootstrap rebuilds the projection.',
    failureOwner: 'sessions derived-field maintainer',
    observability: { registry: true, events: ['machine.metadataChanged'], metrics: [] },
    principal: system(),
    scopeInvariant: 'Projection refresh retains every session owner and visibility.',
  },
  {
    id: 'sessions.machine-row-adoption',
    description:
      'Retarget live placeholder sessions after fleet commits durable local-row adoption.',
    trigger: 'machine.rowsAdopted',
    durability: 'in-memory',
    replay: { mode: 'none', reason: 'Startup loads already-adopted durable session rows.' },
    idempotency: { key: 'machineId + sessionId', duplicatePolicy: 'safe-repeat' },
    ordering: 'Emitted after the fleet transaction; handled in EventBus order per machine.',
    retry: 'A restart reloads the durable adopted rows; a repeated event is safe.',
    failureOwner: 'sessions derived-field maintainer',
    observability: { registry: true, events: ['machine.rowsAdopted'], metrics: [] },
    principal: system(),
    scopeInvariant: 'Adoption changes instance-local machine identity only, never user ownership.',
  },
  {
    id: 'sessions.auto-continue-settings',
    description: 'Re-arm retryable sessions when their owner enables auto-continue.',
    trigger: 'settings.changed',
    durability: 'in-memory',
    replay: {
      mode: 'none',
      reason: 'Live session state is re-seeded and settings are read at boot.',
    },
    idempotency: { key: 'owner + sessionId + settings revision', duplicatePolicy: 'coalesce' },
    ordering: 'Settings events are processed synchronously in emission order.',
    retry: 'No independent retry; the auto-continue controller owns later turn retries.',
    failureOwner: 'sessions auto-continue controller',
    observability: { registry: true, events: ['settings.changed'], metrics: [] },
    principal: delegated(),
    scopeInvariant: 'The session delegation is resolved live and remains bounded by its owner.',
  },
  {
    id: 'attention.issue-mail-nudge',
    description: 'Nudge a live issue session after mail arrives.',
    trigger: 'issue.mailSent',
    durability: 'durable',
    replay: {
      mode: 'startup-reconcile',
      sourceOfTruth: 'unread issue mail and durable session inbox rows',
      reauthorizeAtApply: true,
    },
    idempotency: { key: 'mail message id + recipient session id', duplicatePolicy: 'deduplicate' },
    ordering: 'Per target session FIFO through the durable inbox.',
    retry: 'Session inbox sweep owns retry and dead-lettering.',
    failureOwner: 'message delivery service',
    observability: {
      registry: true,
      events: ['issue.mailSent'],
      metrics: ['message delivery attempts'],
    },
    principal: delegated(),
    scopeInvariant: 'Routes to the owner of the issue/mail target, never an ambient operator.',
  },
  {
    id: 'messages.eligibility',
    description: 'Re-evaluate durable queued deliveries after session or issue metadata commits.',
    trigger: 'oplog.appended',
    durability: 'durable',
    replay: {
      mode: 'startup-reconcile',
      sourceOfTruth: 'messages outbox plus current session/issue rows',
      reauthorizeAtApply: true,
    },
    idempotency: { key: 'message id + delivery attempt state', duplicatePolicy: 'deduplicate' },
    ordering: 'Ledger sequence, then per-target message FIFO.',
    retry: 'Delivery sweep retries; permanent refusal dead-letters to the sender.',
    failureOwner: 'message delivery service',
    observability: {
      registry: true,
      events: ['oplog.appended'],
      metrics: ['message delivery attempts'],
    },
    principal: delegated(),
    scopeInvariant: 'Apply-time authorization resolves the stored delegation reference live.',
  },
  {
    id: 'messages.turn-boundary-drain',
    description: 'Drain queued messages when a target session becomes idle.',
    trigger: 'session.stateChanged',
    durability: 'durable',
    replay: {
      mode: 'startup-reconcile',
      sourceOfTruth: 'messages outbox plus restored session state',
      reauthorizeAtApply: true,
    },
    idempotency: { key: 'message id', duplicatePolicy: 'deduplicate' },
    ordering: 'Per-session FIFO after the observed state transition.',
    retry: 'Delivery sweep is the retry backstop; dead letters belong to messaging.',
    failureOwner: 'message delivery service',
    observability: {
      registry: true,
      events: ['session.stateChanged'],
      metrics: ['message delivery attempts'],
    },
    principal: delegated(),
    scopeInvariant: 'Every queued sender is re-authorized before injection.',
  },
  {
    id: 'messages.transcript-confirmation',
    description: 'Confirm delivery when the durable message frame appears in the transcript.',
    trigger: 'transcript.delta',
    durability: 'durable',
    replay: {
      mode: 'startup-reconcile',
      sourceOfTruth: 'message ledger and durable transcript tail',
      reauthorizeAtApply: true,
    },
    idempotency: { key: 'message id + transcript frame', duplicatePolicy: 'deduplicate' },
    ordering: 'Transcript item order for one session.',
    retry: 'The next transcript delta or delivery sweep retries reconciliation.',
    failureOwner: 'message delivery service',
    observability: {
      registry: true,
      events: ['transcript.delta'],
      metrics: ['message confirmations'],
    },
    principal: delegated(),
    scopeInvariant: 'Confirmation changes status only; it does not widen message visibility.',
  },
  {
    id: 'locks.session-exit-release',
    description: 'Release session-held advisory locks after the session exits.',
    trigger: 'session.exited',
    durability: 'durable',
    replay: {
      mode: 'startup-reconcile',
      sourceOfTruth: 'lock leases and restored live-session set',
      reauthorizeAtApply: true,
    },
    idempotency: {
      key: 'lock name + holder session id + lease generation',
      duplicatePolicy: 'safe-repeat',
    },
    ordering: 'Per-lock repository transaction order.',
    retry: 'Lease expiry/janitor sweep is the backstop.',
    failureOwner: 'lock service',
    observability: { registry: true, events: ['session.exited'], metrics: ['lock expiry/release'] },
    principal: system(),
    scopeInvariant: 'System cleanup changes only the lease it acted on and stamps no human.',
  },
  {
    id: 'conversations.discovery-index',
    description: 'Persist discovered conversations and their derived searchable transcript index.',
    trigger: 'daemon.discovery',
    durability: 'durable',
    replay: {
      mode: 'startup-reconcile',
      sourceOfTruth: 'conversation registry, transcript lake, and mirror checkpoints',
      reauthorizeAtApply: true,
    },
    idempotency: {
      key: 'machineId + native conversation id + source revision',
      duplicatePolicy: 'deduplicate',
    },
    ordering: 'Per-machine discovery order; ledger assigns global publication order.',
    retry: 'Mirror/index checkpoints retry on the next sweep; diagnostics remain visible.',
    failureOwner: 'conversation memory service',
    observability: {
      registry: true,
      events: ['conversations.changed'],
      metrics: ['mirror/index diagnostics'],
    },
    principal: system(),
    scopeInvariant: 'The derived row inherits the indexed conversation scope and never widens it.',
  },
  {
    id: 'publisher.ordered-fanout',
    description: 'Fan committed entity changes to scoped feed subscribers.',
    trigger: 'oplog.appended',
    durability: 'durable',
    replay: {
      mode: 'startup-reconcile',
      sourceOfTruth: 'durable change ledger and subscriber cursor',
      reauthorizeAtApply: true,
    },
    idempotency: { key: 'feed epoch + sequence + subscriber id', duplicatePolicy: 'deduplicate' },
    ordering: 'Strict global ledger sequence with per-subscriber watermarks.',
    retry: 'Reconnect/bootstrap heals gaps; serving edge owns slow-consumer failure.',
    failureOwner: 'feed serving edge',
    observability: { registry: true, events: ['oplog.appended'], metrics: ['feed cursor and lag'] },
    principal: system(),
    scopeInvariant: 'Visibility is evaluated for each authenticated subscriber before delivery.',
  },
  {
    id: 'messaging.telegram-outbound',
    description: 'Relay completed superagent turns to the owning user’s bound Telegram route.',
    trigger: 'superagent.turnEnded',
    durability: 'in-memory',
    replay: {
      mode: 'none',
      reason: 'Completed turns are not replayed to external chat after restart.',
    },
    idempotency: {
      key: 'owner user + thread id + completed turn id',
      duplicatePolicy: 'deduplicate',
    },
    ordering: 'Per-user, per-conversation completion order.',
    retry: 'Adapter-local bounded retry; final failure is owned by the messaging bridge.',
    failureOwner: 'Telegram messaging bridge',
    observability: {
      registry: true,
      events: ['superagent.turnEnded'],
      metrics: ['Telegram send failures'],
    },
    principal: delegated(),
    scopeInvariant:
      'Outbound route is resolved from the thread owner; inbound identity depends on POD-1080 and unknown chats fail closed.',
  },
  {
    id: 'messaging.telegram-configure',
    description: 'Reconfigure per-user Telegram adapters after settings or binding changes.',
    trigger: 'settings.changed',
    durability: 'in-memory',
    replay: {
      mode: 'none',
      reason: 'Startup configures adapters from current settings and binding rows.',
    },
    idempotency: {
      key: 'user + bot-token fingerprint + route revision',
      duplicatePolicy: 'safe-repeat',
    },
    ordering: 'Settings event order; the latest configuration replaces the prior adapter.',
    retry: 'The next settings/binding change or restart retries configuration.',
    failureOwner: 'Telegram messaging bridge',
    observability: {
      registry: true,
      events: ['settings.changed'],
      metrics: ['Telegram configuration failures'],
    },
    principal: system(),
    scopeInvariant:
      'Configuration may read server secrets but never exposes them or invents a user binding.',
  },
  {
    id: 'messaging.ambient-typing',
    description: 'Maintain a transient refcounted typing lease while an owned session is working.',
    trigger: 'session.stateChanged',
    durability: 'in-memory',
    replay: {
      mode: 'none',
      reason: 'Typing presence is transient and is cleared on process restart.',
    },
    idempotency: { key: 'owner user + conversation + lease owner', duplicatePolicy: 'coalesce' },
    ordering: 'Latest session phase wins per owner/conversation lease.',
    retry: 'Best-effort drop; the next state transition refreshes or clears presence.',
    failureOwner: 'Telegram messaging bridge',
    observability: {
      registry: true,
      events: ['session.stateChanged', 'session.exited'],
      metrics: ['typing send failures'],
    },
    principal: delegated(),
    scopeInvariant: 'Lease key is per-conversation-per-user; no cross-user refcounting.',
  },
  {
    id: 'messaging.topic-entry-recap',
    description: 'Post a bounded recap when a user re-enters their bound issue topic.',
    trigger: 'superagent.turnEnded',
    durability: 'in-memory',
    replay: { mode: 'none', reason: 'Topic-entry recaps are never replayed after restart.' },
    idempotency: { key: 'owner user + chat binding + topic entry', duplicatePolicy: 'deduplicate' },
    ordering: 'At-least-once in per-user topic-entry order.',
    retry: 'Best-effort send; the bridge owns failures and suppresses duplicate re-entry spam.',
    failureOwner: 'Telegram messaging bridge',
    observability: {
      registry: true,
      events: ['superagent.turnEnded'],
      metrics: ['Telegram recap failures'],
    },
    principal: delegated(),
    scopeInvariant: 'Transcript source and destination must have the same owner user.',
  },
  {
    id: 'automations.scheduled-runs',
    description:
      'Materialize due durable automation occurrences as delegated sessions and run rows.',
    trigger: 'janitor.tick',
    durability: 'durable',
    replay: {
      mode: 'startup-reconcile',
      sourceOfTruth: 'automation definitions, occurrence ids, and durable run rows',
      reauthorizeAtApply: true,
    },
    idempotency: { key: 'automation id + scheduled occurrence', duplicatePolicy: 'deduplicate' },
    ordering:
      'Chronological occurrence order per automation; ledger orders resulting rows globally.',
    retry:
      'Janitor retries unmaterialized occurrences; terminal failures are recorded as run outcomes.',
    failureOwner: 'automation scheduler/service',
    observability: {
      registry: true,
      events: ['automation run rows'],
      metrics: ['automation outcomes'],
    },
    principal: delegated(),
    scopeInvariant:
      'Creator delegation is resolved live on every fire/replay; revoked creators cannot run.',
  },
  {
    id: 'maintenance.steward',
    description: 'Reconcile durable attention facts and queue steward nudges.',
    trigger: 'janitor.tick',
    durability: 'durable',
    replay: {
      mode: 'startup-reconcile',
      sourceOfTruth: 'event log, notification facts, messages, issues, and sessions',
      reauthorizeAtApply: true,
    },
    idempotency: { key: 'notification fact + target session', duplicatePolicy: 'deduplicate' },
    ordering: 'Event-log cursor order; deliveries commit before cursor advance.',
    retry: 'Janitor owns retry and leaves the cursor before a failed fact.',
    failureOwner: 'steward janitor job',
    observability: {
      registry: true,
      events: ['steward event cursor'],
      metrics: ['steward delivery failures'],
    },
    principal: system(),
    scopeInvariant: 'Writes are system-attributed and remain in the target fact/session scope.',
  },
  {
    id: 'maintenance.expiry',
    description: 'Expire retained events, advisory leases, and auto-archive candidates.',
    trigger: 'janitor.tick',
    durability: 'durable',
    replay: {
      mode: 'startup-reconcile',
      sourceOfTruth: 'durable expiry timestamps and current entity state',
      reauthorizeAtApply: true,
    },
    idempotency: { key: 'entity id + expiry boundary', duplicatePolicy: 'safe-repeat' },
    ordering: 'Per repository transaction; ledger orders visible entity changes.',
    retry: 'The next fenced janitor tick retries.',
    failureOwner: 'maintenance janitor',
    observability: {
      registry: true,
      events: ['maintenance run records'],
      metrics: ['prune/expiry duration'],
    },
    principal: system(),
    scopeInvariant: 'System expiry never changes ownership or attributes a human actor.',
  },
  {
    id: 'startup.boot-reconcile',
    description:
      'Reconcile durable issues, sessions, messages, conversations, and derived fields at boot.',
    trigger: 'startup',
    durability: 'durable',
    replay: {
      mode: 'startup-reconcile',
      sourceOfTruth: 'authoritative repositories and durable outboxes',
      reauthorizeAtApply: true,
    },
    idempotency: {
      key: 'entity kind + entity id + durable revision',
      duplicatePolicy: 'safe-repeat',
    },
    ordering: 'Dependency order declared by the composition graph, then ledger sequence.',
    retry: 'Component-specific sweep/janitor backstops; boot logs retain failures.',
    failureOwner: 'server composition root',
    observability: {
      registry: true,
      events: ['boot diagnostics'],
      metrics: ['reconcile duration/failures'],
    },
    principal: system(),
    scopeInvariant:
      'Boot writes are system-attributed, preserve entity scope, and never stamp a human.',
  },
] as const satisfies readonly ReactionDefinition[]

const REQUIRED_KEYS = [
  'id',
  'description',
  'trigger',
  'durability',
  'replay',
  'idempotency',
  'ordering',
  'retry',
  'failureOwner',
  'observability',
  'principal',
  'scopeInvariant',
] as const

/** Runtime totality check used by tests and documentation generation. */
export function assertReactionRegistryTotal(
  definitions: readonly unknown[],
): asserts definitions is readonly ReactionDefinition[] {
  const ids = new Set<string>()
  for (const [index, candidate] of definitions.entries()) {
    if (candidate === null || typeof candidate !== 'object') {
      throw new Error(`reaction[${index}] must be an object`)
    }
    const row = candidate as Record<string, unknown>
    for (const key of REQUIRED_KEYS) {
      if (!(key in row) || row[key] === undefined || row[key] === '') {
        throw new Error(`reaction[${index}] is missing ${key}`)
      }
    }
    const id = row.id
    if (typeof id !== 'string' || !id.trim()) throw new Error(`reaction[${index}] has invalid id`)
    if (ids.has(id)) throw new Error(`duplicate reaction id: ${id}`)
    ids.add(id)

    const replay = row.replay as Record<string, unknown>
    if (replay.mode !== 'none' && replay.mode !== 'startup-reconcile') {
      throw new Error(`${id}: replay.mode must be declared`)
    }
    if (replay.mode === 'startup-reconcile' && replay.reauthorizeAtApply !== true) {
      throw new Error(`${id}: durable replay must reauthorize at apply time`)
    }
    if ((row.idempotency as Record<string, unknown>).key === undefined) {
      throw new Error(`${id}: idempotency key must be declared`)
    }
    const principal = row.principal as Record<string, unknown>
    if (principal.class === 'system') {
      if (principal.actor !== 'system' || principal.writeScope !== 'acted-on-entity') {
        throw new Error(`${id}: system reactions must preserve system attribution and entity scope`)
      }
    } else if (principal.class === 'delegated') {
      if (principal.delegation !== 'live-reference' || principal.reauthorizeAtApply !== true) {
        throw new Error(`${id}: delegated reactions must resolve a live delegation at apply time`)
      }
    } else {
      throw new Error(`${id}: principal class must be system or delegated`)
    }
    const observability = row.observability as Record<string, unknown>
    if (observability.registry !== true || !Array.isArray(observability.events)) {
      throw new Error(`${id}: observability must name registry events`)
    }
  }
}

assertReactionRegistryTotal(REACTIONS)

import {
  HostMetricsWire,
  IssueId,
  joinKeyParts,
  MachineId,
  splitKeyParts,
  UserId,
} from '@podium/model'
import { z } from 'zod'
import { SessionOpenUrlMessage, SessionOpenUrlResultMessage } from '../messages/browser-open'
import { AttentionEventMessage, MemoryBreakdownResultMessage } from '../messages/host'
import { SetLogLevelMessage } from '../messages/logs'
import { ServerRelocationMessage } from '../messages/server-transfer'
import type { RoutingKey } from './routing'

/**
 * TOPICS ON THE STREAM PLANE — ADR 7 Amendment 2 (D17–D26).
 *
 * A topic is a routing key `(kind, id)` on the gateway's ONE
 * `SubscriptionRegistry`, with a declared kind. Kinds come from the closed
 * table below: a new kind is added only by editing {@link TOPIC_KINDS}, and
 * `topics.test.ts` checks that every kind carries every declaration field and
 * has a conformance run (D25).
 *
 * What a declaration deliberately does NOT say (D18): whether a client stores
 * the topic, whether it is held for the whole app session, or whether the
 * server keeps anything loaded. Those follow from who subscribes, and from the
 * producer's start and stop.
 */

/** How updates combine (D19). Presence rooms keep Amendment 1's `room`. */
export const TOPIC_STYLES = ['value', 'log', 'event'] as const
export type TopicStyle = (typeof TOPIC_STYLES)[number]

/** Who produces a kind. Both get start on 0→1 subscribers and stop on 1→0 (D21). */
export const TOPIC_PRODUCERS = ['server', 'daemon'] as const
export type TopicProducerSide = (typeof TOPIC_PRODUCERS)[number]

/**
 * The visibility resolvers a kind may name (ADR 9 classes, D14 gate, default
 * closed). Each one is implemented once by the server's topic routing.
 *
 * - `machine`: the principal may SEE the machine (fleet health is a `see`
 *   fact, not an execution one — `machine-access.ts`).
 * - `account.self`: the topic id is the principal's own user.
 */
export const TOPIC_VISIBILITY = ['machine', 'machine.use', 'account.self'] as const
export type TopicVisibility = (typeof TOPIC_VISIBILITY)[number]

/** `machine.condition` — the server's view of the daemon connection. */
export const MachineConditionPayload = z.object({
  online: z.boolean(),
  /**
   * When `online` last changed, as this server saw it. `null` when the server
   * has not seen the machine connect since it started: honest "offline, since
   * at least the server's start", never an invented time.
   */
  since: z.string().nullable(),
})
export type MachineConditionPayload = z.infer<typeof MachineConditionPayload>

/**
 * `account.events` — one-off notices for whoever is connected now. The
 * payload is the frame that carried the notice before topics, unchanged, so a
 * client re-dispatches it through the handler it already has and a peer
 * without `topics.v1` keeps getting the bare frame (D26, POD-6680 removes it).
 */
export const AccountEventPayload = z.discriminatedUnion('type', [
  AttentionEventMessage,
  SessionOpenUrlMessage,
  SessionOpenUrlResultMessage,
  ServerRelocationMessage,
  SetLogLevelMessage,
])
export type AccountEventPayload = z.infer<typeof AccountEventPayload>

/** A checkout address has two escaped parts; a path never aliases another machine. */
export const checkoutTopicId = (machineId: MachineId, path: string): string =>
  joinKeyParts(':', [machineId, path])

export const parseCheckoutTopicId = (
  id: string,
): { machineId: MachineId; path: string } | undefined => {
  try {
    const [machine, path] = splitKeyParts(':', id, 2) as [string, string]
    if (!MachineId.safeParse(machine).success || !path || !/^(\/|[a-zA-Z]:[\\/])/.test(path))
      return undefined
    return { machineId: machine as MachineId, path }
  } catch {
    return undefined
  }
}

export const HostProcessBreakdown = MemoryBreakdownResultMessage.omit({
  type: true,
  requestId: true,
})
export const ReclaimInventoryPayload = z.object({
  candidates: z.array(
    z.object({
      issueId: IssueId,
      title: z.string(),
      worktreePath: z.string(),
      closedAt: z.string(),
      machineId: MachineId,
      present: z.boolean(),
      protectedReason: z.string().nullable(),
    }),
  ),
  orphans: z.array(
    z.object({
      path: z.string(),
      branch: z.string().nullable(),
      headSha: z.string().nullable(),
      machineId: MachineId,
      repoPath: z.string(),
    }),
  ),
  diagnostics: z.array(
    z.object({ repoPath: z.string(), machineId: MachineId, reason: z.string() }),
  ),
  estimate: z.discriminatedUnion('status', [
    z.object({
      status: z.literal('unknown'),
      recoverableBytes: z.null(),
      measuredAt: z.null(),
      error: z.string().optional(),
    }),
    z.object({ status: z.literal('measuring'), recoverableBytes: z.null(), measuredAt: z.null() }),
    z.object({ status: z.literal('ready'), recoverableBytes: z.number(), measuredAt: z.string() }),
  ]),
})
export const MachineProcessesWatchInput = z.object({ roots: z.array(z.string()) })

export const MachineProcessesPayload = z.object({
  breakdown: HostProcessBreakdown,
  reclaim: ReclaimInventoryPayload.optional(),
  reclaimError: z.string().optional(),
})

export interface TopicKindDeclaration {
  readonly style: TopicStyle
  readonly producer: TopicProducerSide
  readonly visibility: TopicVisibility
  /**
   * The rate rule (D18): at most one send per key per this many milliseconds.
   * Updates in between are coalesced to the newest, which goes out when the
   * interval ends. `0` means no limit (events).
   */
  readonly minIntervalMs: number
  /** The id half of the key. */
  readonly id: z.ZodType<string>
  /** What a subscriber receives, checked by the consumer. */
  readonly payload: z.ZodType<unknown>
  /** Daemon kinds: what the daemon's `topicPublish` carries, checked by the server. */
  readonly publish?: z.ZodType<unknown>
}

/**
 * THE CLOSED SET (D17, D26). `satisfies` keeps every entry total over the
 * declaration; the literal keys are the `TopicKind` union.
 */
export const TOPIC_KINDS = {
  'machine.condition': {
    style: 'value',
    producer: 'server',
    visibility: 'machine',
    minIntervalMs: 1_000,
    id: MachineId,
    payload: MachineConditionPayload,
  },
  'machine.metrics': {
    style: 'value',
    producer: 'daemon',
    visibility: 'machine',
    minIntervalMs: 5_000,
    id: MachineId,
    payload: HostMetricsWire,
    publish: HostMetricsWire,
  },
  'checkout.changed': {
    // A signal is a value carrying only the envelope's epoch/seq (ADR 7 D19).
    style: 'value',
    producer: 'daemon',
    visibility: 'machine.use',
    minIntervalMs: 1_000,
    id: z.string().refine((id) => parseCheckoutTopicId(id) !== undefined),
    payload: z.null(),
    publish: z.null(),
  },
  'machine.processes': {
    style: 'value',
    producer: 'daemon',
    visibility: 'machine.use',
    minIntervalMs: 5_000,
    id: MachineId,
    payload: MachineProcessesPayload,
    publish: HostProcessBreakdown,
  },
  'account.events': {
    style: 'event',
    producer: 'server',
    visibility: 'account.self',
    minIntervalMs: 0,
    id: UserId,
    payload: AccountEventPayload,
  },
} as const satisfies Record<string, TopicKindDeclaration>

export type TopicKind = keyof typeof TOPIC_KINDS
export const TOPIC_KIND_NAMES = Object.keys(TOPIC_KINDS) as readonly TopicKind[]

export type TopicPayload<K extends TopicKind> = z.infer<(typeof TOPIC_KINDS)[K]['payload']>

export const isTopicKind = (kind: string): kind is TopicKind => Object.hasOwn(TOPIC_KINDS, kind)

export const topicDeclaration = (kind: TopicKind): TopicKindDeclaration => TOPIC_KINDS[kind]

/** Client capability and daemon capability: this peer speaks the topic frames (D23). */
export const CAP_TOPICS_V1 = 'topics.v1'
/** Additive daemon producers; topics.v1 alone does not imply these exist. */
export const CAP_CHECKOUT_CHANGED_V1 = 'topics.checkout-changed.v1'
export const CAP_MACHINE_PROCESSES_V1 = 'topics.machine-processes.v1'

/** One connection may hold at most this many keys (D21). */
export const TOPIC_KEYS_PER_CONNECTION_MAX = 1_000

// ---------------------------------------------------------------------------
// Keys
// ---------------------------------------------------------------------------

const KEY_SEP = ':'

/** A topic reference: kind plus id. The kind is a STRING here, checked by {@link isTopicKind}. */
export interface TopicRef {
  readonly kind: string
  readonly id: string
}

/** The wire form of a topic key, `kind:id` with escaped parts (POD-1134). */
export type TopicKey = string & { readonly __brand: 'TopicKey' }

export const topicKey = <K extends TopicKind>(kind: K, id: string): TopicKey => {
  if (id === '') throw new Error('topic id must not be empty')
  return joinKeyParts(KEY_SEP, [kind, id]) as TopicKey
}

/** Inverse of {@link topicKey}. Undefined for a malformed key; the kind is NOT checked. */
export const parseTopicKey = (key: string): TopicRef | undefined => {
  try {
    const [kind, id] = splitKeyParts(KEY_SEP, key, 2) as [string, string]
    if (kind === '' || id === '') return undefined
    return { kind, id }
  } catch {
    return undefined
  }
}

const TOPIC_ROUTING_NS = 'topic'

/** The registry key for a topic: its own namespace beside `entity`, `room` and `principal`. */
export const topicRoutingKey = (ref: TopicRef): RoutingKey =>
  joinKeyParts(KEY_SEP, [TOPIC_ROUTING_NS, ref.kind, ref.id]) as RoutingKey

/** Inverse of {@link topicRoutingKey}; undefined for any key outside the topic namespace. */
export const topicRefFromRoutingKey = (key: string): TopicRef | undefined => {
  try {
    const [ns, kind, id] = splitKeyParts(KEY_SEP, key, 3) as [string, string, string]
    if (ns !== TOPIC_ROUTING_NS || kind === '' || id === '') return undefined
    return { kind, id }
  } catch {
    return undefined
  }
}

/** Parse and check a subscriber-facing payload against its kind. */
export const parseTopicPayload = <K extends TopicKind>(
  kind: K,
  payload: unknown,
): TopicPayload<K> | undefined => {
  const parsed = TOPIC_KINDS[kind].payload.safeParse(payload)
  return parsed.success ? (parsed.data as TopicPayload<K>) : undefined
}

// ---------------------------------------------------------------------------
// Positions (D19)
// ---------------------------------------------------------------------------

/**
 * A server-assigned position. `seq` increases by one per update the server
 * sends for the key; `epoch` changes when the producer starts over, and a new
 * epoch always arrives as a snapshot, so positions are only compared within one
 * epoch.
 */
export const TopicPosition = z.object({
  epoch: z.string().min(1).max(128),
  seq: z.number().int().nonnegative(),
})
export type TopicPosition = z.infer<typeof TopicPosition>

/** True when `next` supersedes `held`: same epoch and a larger seq. */
export const isNewerTopicPosition = (
  held: TopicPosition | undefined,
  next: TopicPosition,
): boolean => held === undefined || (held.epoch === next.epoch && next.seq > held.seq)

// ---------------------------------------------------------------------------
// Frames (D23)
// ---------------------------------------------------------------------------

/** Wire key: a well-formed `kind:id`. An unknown KIND is answered `unsupported`, not dropped. */
const TopicKeyField = z
  .string()
  .min(3)
  .max(512)
  .refine((key) => parseTopicKey(key) !== undefined, 'malformed topic key')
  .transform((key) => key as TopicKey)

// ---- client → server (stream · live) ----

export const TopicSubscribeMessage = z.object({
  type: z.literal('topicSubscribe'),
  key: TopicKeyField,
  /** Log kinds: resume after this position. Value and event kinds ignore it. */
  from: TopicPosition.optional(),
})

export const TopicUnsubscribeMessage = z.object({
  type: z.literal('topicUnsubscribe'),
  key: TopicKeyField,
})

// ---- server → client (stream · live) ----

/**
 * The first frame for every subscription. For a value kind an ABSENT payload
 * is the valid snapshot `unknown` (D20); an empty notice is a present payload.
 */
export const TopicSnapshotMessage = z.object({
  type: z.literal('topicSnapshot'),
  key: TopicKeyField,
  position: TopicPosition,
  payload: z.unknown().optional(),
  /** Log kinds: this window does not continue the subscriber's position. */
  reset: z.boolean().optional(),
  /** Log kinds: entries older than this window exist (bulk read). */
  hasOlder: z.boolean().optional(),
})

/** A newer value, or the next log entry. An absent payload is `unknown` again. */
export const TopicUpdateMessage = z.object({
  type: z.literal('topicUpdate'),
  key: TopicKeyField,
  position: TopicPosition,
  payload: z.unknown().optional(),
})

/** A one-off notice to whoever holds the key now. */
export const TopicEventMessage = z.object({
  type: z.literal('topicEvent'),
  key: TopicKeyField,
  payload: z.unknown(),
})

export const TOPIC_CLOSED_REASONS = [
  'refused',
  'gone',
  'revoked',
  'overflow',
  'unsupported',
  'shutdown',
] as const
export type TopicClosedReason = (typeof TOPIC_CLOSED_REASONS)[number]

/**
 * The subscription ended. `refused` covers both "not visible" and "does not
 * exist" (D14: a refusal looks exactly like a missing key).
 */
export const TopicClosedMessage = z.object({
  type: z.literal('topicClosed'),
  key: TopicKeyField,
  reason: z.enum(TOPIC_CLOSED_REASONS),
})

export const TopicClientMessage = z.discriminatedUnion('type', [
  TopicSubscribeMessage,
  TopicUnsubscribeMessage,
])
export type TopicClientMessage = z.infer<typeof TopicClientMessage>

export const TopicServerMessage = z.discriminatedUnion('type', [
  TopicSnapshotMessage,
  TopicUpdateMessage,
  TopicEventMessage,
  TopicClosedMessage,
])
export type TopicServerMessage = z.infer<typeof TopicServerMessage>

// ---- server → daemon (control · command) ----

/**
 * Daemon demand as a DESIRED STATE (the `runtimeWatch` rule): duplicates are
 * harmless and the next change corrects a lost one. Sent on the key's
 * subscriber zero-crossings, and again for every key still held after the
 * daemon reattaches (D21).
 */
export const TopicWatchMessage = z.object({
  type: z.literal('topicWatch'),
  key: TopicKeyField,
  on: z.boolean(),
  /** Producer input is derived by the server, never supplied by a subscriber. */
  input: z.unknown().optional(),
})
export type TopicWatchMessage = z.infer<typeof TopicWatchMessage>

// ---- daemon → server (stream · live) ----

/** A daemon-produced value or entry. The server assigns the position. */
export const TopicPublishMessage = z.object({
  type: z.literal('topicPublish'),
  key: TopicKeyField,
  payload: z.unknown(),
})
export type TopicPublishMessage = z.infer<typeof TopicPublishMessage>

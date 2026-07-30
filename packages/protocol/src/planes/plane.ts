/**
 * Plane vocabulary — ADR 7 D1 (`docs/adr/0007-plane-inventory.md`).
 *
 * THREE planes, settled: control (durable), stream (live), bulk (paged).
 * `command` is NOT a fourth plane — it is a directed request/reply message
 * CLASS carried inside the control plane's port contract (correlated
 * requestId, requires-live-peer unless the command is offline-class under
 * ADR 3). A deviation requires an ADR amendment, not local judgement.
 *
 * A plane·class pair is the unit of classification: every wire message maps to
 * exactly ONE pair. The pairs are written as dotted literals so a table entry
 * is a single compile-checked token (`satisfies Record<Union['type'],
 * PlaneClass>` stays total, exactly as the pre-rewrite `MessageSyncClass`
 * tables were).
 */

export const PLANES = ['control', 'stream', 'bulk'] as const
export type Plane = (typeof PLANES)[number]

/** Classes carried by the control port (ADR 7 D1). */
export const CONTROL_CLASSES = ['entity', 'command', 'handshake'] as const
/** The stream port carries exactly one class. */
export const STREAM_CLASSES = ['live'] as const
/** The bulk port carries exactly one class. */
export const BULK_CLASSES = ['bulk'] as const

/**
 * The closed set of plane·class pairs. Growing this set is an ADR 7 amendment.
 */
export const PLANE_CLASSES = [
  'control.entity',
  'control.command',
  'control.handshake',
  'stream.live',
  'bulk.bulk',
] as const
export type PlaneClass = (typeof PLANE_CLASSES)[number]

export type ControlPlaneClass = Extract<PlaneClass, `control.${string}`>
export type StreamPlaneClass = Extract<PlaneClass, `stream.${string}`>
export type BulkPlaneClass = Extract<PlaneClass, `bulk.${string}`>

/** `'control.entity'` → `'control'`. */
export const planeOf = <P extends PlaneClass>(
  pc: P,
): P extends `${infer L}.${string}` ? L : never => pc.split('.')[0] as never

/** `'control.entity'` → `'entity'`. */
export const classOf = <P extends PlaneClass>(
  pc: P,
): P extends `${string}.${infer R}` ? R : never => pc.split('.')[1] as never

/**
 * Delivery semantics per plane·class — ADR 7 D1's port-semantics table, as
 * amended by ADR 7 Amendment 1 D15 (control·entity fan-out is per-principal
 * ROUTING, not broadcast; stream·live fans out to a NAMED ROUTING SET, and
 * "raw fan-out to every client" is no longer a port affordance).
 *
 * This table is data, not prose, so a port implementation can assert against
 * it and POD-317 cannot quietly reclassify at a send site.
 */
export interface PlaneClassSemantics {
  /** Must the frame pass the durable write funnel (oplog append) first? */
  readonly funnelled: boolean
  /** Does the frame append an oplog row / move the feed `seq`? */
  readonly oplogged: boolean
  /** Is a live peer required for the frame to mean anything? */
  readonly requiresLivePeer: boolean
  /** Is loss on disconnect acceptable (never healed)? */
  readonly lossy: boolean
  /** How the port picks recipients. */
  readonly routing: 'per-principal' | 'named-set' | 'point-to-point' | 'single-peer'
  /** What a replica/client does with a gap. */
  readonly recovery: 'heal-ladder' | 'none' | 'rejoin' | 'lazy-refetch'
  /** Terminal escalation when the subscriber cannot keep up. */
  readonly backpressure: 'demote-to-resync' | 'coalesce-drop-evict' | 'fail-request'
}

export const PLANE_CLASS_SEMANTICS = {
  // Entity truth. Funnel-only (oplog append before fan-out) so
  // `sync.changesSince` never has a hole; routed per principal under the
  // scoped feed (ADR 2 Amendment 1 D12), with contiguity carried by the
  // covered range on every frame (D13).
  'control.entity': {
    funnelled: true,
    oplogged: true,
    requiresLivePeer: false,
    lossy: false,
    routing: 'per-principal',
    recovery: 'heal-ladder',
    backpressure: 'demote-to-resync',
  },
  // Directed request/reply. Correlated requestId; nothing to catch up as
  // entity truth; offline-class commands may be queued in an outbox (ADR 3).
  'control.command': {
    funnelled: false,
    oplogged: false,
    requiresLivePeer: true,
    lossy: false,
    routing: 'point-to-point',
    recovery: 'none',
    backpressure: 'fail-request',
  },
  // Once per connection: version + role auth (ADR 5).
  'control.handshake': {
    funnelled: false,
    oplogged: false,
    requiresLivePeer: true,
    lossy: false,
    routing: 'single-peer',
    recovery: 'none',
    backpressure: 'fail-request',
  },
  // Ephemeral / hot frames. Best-effort to a named routing set: one
  // connection, a session-attach set, or a room (Amendment 1 D10). Never
  // healed, blank offline, no durable rows and no tombstones (D12).
  'stream.live': {
    funnelled: false,
    oplogged: false,
    requiresLivePeer: true,
    lossy: true,
    routing: 'named-set',
    recovery: 'rejoin',
    backpressure: 'coalesce-drop-evict',
  },
  // Large, paged, lazy transfers on their own channel; never fanned out or
  // oplog-replayed as entity rows.
  'bulk.bulk': {
    funnelled: false,
    oplogged: false,
    requiresLivePeer: true,
    lossy: false,
    routing: 'point-to-point',
    recovery: 'lazy-refetch',
    backpressure: 'fail-request',
  },
} as const satisfies Record<PlaneClass, PlaneClassSemantics>

/**
 * ADR 7 D1's migration bridge from today's four `MessageSyncClass` labels.
 * The plane·class tables are the source of truth; the legacy labels are
 * DERIVED from them through this map for the one migration window ADR 7's
 * "Costs" section allows.
 */
export const SYNC_CLASS_OF_PLANE_CLASS = {
  'control.entity': 'durable',
  'control.command': 'command',
  // Handshake frames were never in the four `*_MESSAGE_CLASS` tables (they are
  // pre-auth, in `daemon-handshake.ts`), so they have no legacy label. `null`
  // is the honest answer, not `'command'`.
  'control.handshake': null,
  'stream.live': 'live',
  'bulk.bulk': 'bulk',
} as const satisfies Record<PlaneClass, 'durable' | 'command' | 'live' | 'bulk' | null>

/** Type-level twin of {@link SYNC_CLASS_OF_PLANE_CLASS}. */
export type SyncClassOf<P extends PlaneClass> = (typeof SYNC_CLASS_OF_PLANE_CLASS)[P]

/** The inverse of the bridge, over the four labels that have one. */
export const PLANE_CLASS_OF_SYNC_CLASS = {
  durable: 'control.entity',
  command: 'control.command',
  live: 'stream.live',
  bulk: 'bulk.bulk',
} as const satisfies Record<'durable' | 'command' | 'live' | 'bulk', PlaneClass>

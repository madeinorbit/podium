/**
 * ONE optimistic mechanism (#263 [spec:SP-3fe2]): the outbox IS the overlay.
 *
 * Until #263 the engine ran three separate optimism mechanisms — an
 * optimistic-spawn row overlay, an optimistic-issues row overlay, and direct
 * replica patching (patchSession/patchIssue) for the curation mutations. This
 * module collapses them into one: a PENDING MUTATION is the overlay. When the
 * engine computes its snapshot lists it folds
 *
 *     replica rows (server truth, never optimistically patched)
 *   + pending overlays (queued outbox entries' patches, resolved-but-uncovered
 *     patches, and spawn placeholder inserts)
 *
 * so the replica stays server-truth only and optimism lives exactly as long as
 * the mutation that caused it is unaccounted for.
 *
 * RETIREMENT RULE (#263) — an overlay retires EXACTLY ONCE, on the first of:
 *
 *  (a) success + covering truth: its mutation resolved (the entry left the
 *      outbox queue via a successful drain / the spawn create acked) AND
 *      server truth covering it landed in the replica. "Covering" is:
 *        - for a patch: the row now reflects the mutation (`coveredBy`), OR
 *          the row moved past the baseline fingerprint taken at ENQUEUE time —
 *          a competing write won, and server truth wins (exactly the semantics
 *          the old direct-replica patching had). The escape is limited to the
 *          oldest awaiting entry per row, and a TTL backstop bounds the rest
 *          (see pruneAwaiting);
 *        - for a spawn insert: a base row with the client-minted id exists
 *          (resolution plays no part — the broadcast may beat the tRPC ack).
 *      Until BOTH hold, the overlay keeps painting on top of every replica
 *      write — a reconnect heal snapshot that predates the mutation's effect
 *      can never flash the stale value (the no-flicker guarantee all three
 *      old mechanisms approximated).
 *
 *  (b) definitive failure: the mutation was rejected (outbox poison drop /
 *      the spawn create rejected) — the overlay drops immediately and the
 *      existing failure surfacing (toast) fires.
 *
 * Lifecycle of an outboxed mutation's overlay, concretely:
 *   enqueue            → overlay active (derived from the queue itself; being
 *                        replica-persisted, it survives an offline reload)
 *   drain success      → overlay handed to the awaiting-truth stage
 *                        (Outbox.onApplied fires before subscribers see the
 *                        shrunken queue, so there is no uncovered gap). The
 *                        stage is DURABLE (#263 review finding 1): the entry
 *                        transitions in outbox storage (state 'awaiting-truth')
 *                        rather than being deleted, so a reload inside the
 *                        resolution→truth window restores the overlay instead
 *                        of exposing stale replica truth
 *   truth lands        → overlay retired (rule (a)) + storage entry deleted
 *   poison drop        → overlay dropped + toast (rule (b))
 */

import type { IssueWire, SessionMeta, WorkState } from '@podium/protocol'
import type { OutboxEntry } from '../outbox'
import type { OutboxKinds } from './wiring'

/** The two overlaid entity kinds. Conversations carry no optimistic writes. */
export type OverlayEntity = 'sessions' | 'issues'

/** Fields folded over a base row. Loose on purpose — the projection functions
 *  below are the typed constructors; folding is structural. */
type OverlayPatch = Record<string, unknown>

export type PendingOverlay =
  | {
      op: 'patch'
      /** Stable identity: the outbox entry's mutationId. */
      key: string
      entity: OverlayEntity
      /** Target row id (sessionId / issue id). */
      id: string
      patch: OverlayPatch
      /** True when `row` (current server truth) already reflects this
       *  mutation — applying the patch would be observationally a no-op. */
      coveredBy: (row: SessionMeta | IssueWire) => boolean
    }
  | {
      op: 'insert'
      /** Stable identity: `spawn:<row id>`. */
      key: string
      entity: OverlayEntity
      id: string
      /** The whole placeholder row, shown until a base row (same id) lands. */
      insert: SessionMeta | IssueWire
    }

/** A resolved patch overlay still awaiting covering server truth (rule (a)).
 *  `baseline` is the `rowFingerprint` of the target row's REPLICA truth at
 *  ENQUEUE time (unpainted) — divergence that doesn't satisfy `coveredBy` means a
 *  competing write won. Captured at enqueue, NOT at resolution: truth can land
 *  BEFORE the mutation response, and a resolution-time fingerprint of that
 *  already-final row would never "move past" — wedging the overlay forever
 *  (#263 review finding 2). `undefined` when the row wasn't in the replica at
 *  enqueue time (or the entry predates baselines): the moved-past escape is
 *  unavailable then and retirement rests on coveredBy / row-gone / the TTL. */
export interface AwaitingTruth {
  overlay: Extract<PendingOverlay, { op: 'patch' }>
  baseline: string | undefined
  /** Epoch ms when the mutation resolved — drives the TTL backstop. */
  resolvedAt: number
}

/**
 * TTL backstop for the awaiting-truth stage (#263 review finding 3): an
 * awaiting entry whose covering truth never arrives (echo lost, competing
 * writes racing, a younger same-row entry blocked from the moved-past escape)
 * retires after this long. Tradeoff, deliberately: retiring a stuck overlay
 * can briefly show pre-mutation server truth (mild, self-healing — the next
 * sync converges), while keeping it forever can mask another client's write
 * indefinitely (visible wrongness with no recovery). Bounding beats wedging.
 */
export const AWAITING_TRUTH_TTL_MS = 60_000

/** Stable empty set so snapshot slices keep identity when nothing is pending. */
export const EMPTY_ID_SET: ReadonlySet<string> = new Set()

/**
 * Stable row fingerprint for baselines: DATA fields only, keys sorted. Replica
 * rows are TanStack DB objects carrying volatile $-metadata ($synced flips
 * false→true after persistence, $origin local→remote across a reload,
 * $collectionId embeds a per-instance nonce) — raw JSON.stringify would read
 * every one of those flips as "the row moved", spuriously firing the
 * moved-past-baseline escape. Key sorting guards against storage round-trips
 * reordering properties. JSON.stringify drops undefined-valued fields, so a
 * field assigned undefined equals one that is absent.
 */
export function rowFingerprint(row: object): string {
  const data: Record<string, unknown> = {}
  for (const k of Object.keys(row).sort()) {
    if (!k.startsWith('$')) data[k] = (row as Record<string, unknown>)[k]
  }
  return JSON.stringify(data)
}

function patchOverlay(
  entity: OverlayEntity,
  id: string,
  key: string,
  patch: OverlayPatch,
  coveredBy: (row: SessionMeta | IssueWire) => boolean,
): PendingOverlay {
  return { op: 'patch', key, entity, id, patch, coveredBy }
}

/** A spawn placeholder (#119) as a unified overlay entry: same bookkeeping as
 *  an outboxed patch, but the transport stays direct tRPC (see engine). */
export function insertOverlay(
  entity: OverlayEntity,
  id: string,
  insert: SessionMeta | IssueWire,
): PendingOverlay {
  return { op: 'insert', key: `spawn:${id}`, entity, id, insert }
}

/**
 * Project one queued outbox entry into its overlay. Mirrors — field for field —
 * the optimistic patches the engine used to write straight into the replica,
 * so the painted result is byte-identical to the old mechanism's. Kinds with
 * no visible optimism (resumeAndSend) project to null. Each kind's `coveredBy`
 * encodes what SERVER truth reflecting the mutation looks like (the server
 * trims names, stamps its own readAt clock, derives `unread`).
 */
export function overlayForOutboxEntry(entry: OutboxEntry): PendingOverlay | null {
  switch (entry.kind as keyof OutboxKinds) {
    case 'rename': {
      const i = entry.input as OutboxKinds['rename']
      const name = i.name.trim() // the server stores the trimmed name too
      return patchOverlay('sessions', i.sessionId, entry.mutationId, { name }, (r) => {
        return ((r as SessionMeta).name ?? '') === name
      })
    }
    case 'setArchived': {
      const i = entry.input as OutboxKinds['setArchived']
      return patchOverlay(
        'sessions',
        i.sessionId,
        entry.mutationId,
        { archived: i.archived },
        (r) => (r as SessionMeta).archived === i.archived,
      )
    }
    case 'setWorkState': {
      const i = entry.input as OutboxKinds['setWorkState']
      const workState: WorkState | undefined = i.workState ?? undefined
      return patchOverlay(
        'sessions',
        i.sessionId,
        entry.mutationId,
        { workState },
        (r) => ((r as SessionMeta).workState ?? null) === (workState ?? null),
      )
    }
    case 'snoozeSet': {
      const i = entry.input as OutboxKinds['snoozeSet']
      return patchOverlay(
        'sessions',
        i.sessionId,
        entry.mutationId,
        { snoozedUntil: i.until },
        (r) => ((r as SessionMeta).snoozedUntil ?? null) === (i.until ?? null),
      )
    }
    case 'snoozeClear': {
      const i = entry.input as OutboxKinds['snoozeClear']
      return patchOverlay(
        'sessions',
        i.sessionId,
        entry.mutationId,
        { snoozedUntil: undefined },
        (r) => (r as SessionMeta).snoozedUntil == null,
      )
    }
    case 'sessionMarkRead': {
      const i = entry.input as OutboxKinds['sessionMarkRead']
      // The server stamps its OWN readAt clock, so covering truth is judged on
      // the derived unread flag (+ readAt presence), not readAt equality.
      return patchOverlay(
        'sessions',
        i.sessionId,
        entry.mutationId,
        { readAt: new Date(entry.queuedAt).toISOString(), unread: false },
        (r) => (r as SessionMeta).unread === false && (r as SessionMeta).readAt != null,
      )
    }
    case 'sessionMarkUnread': {
      const i = entry.input as OutboxKinds['sessionMarkUnread']
      return patchOverlay(
        'sessions',
        i.sessionId,
        entry.mutationId,
        { readAt: null, unread: true },
        (r) => (r as SessionMeta).unread === true,
      )
    }
    case 'issueMarkRead': {
      const i = entry.input as OutboxKinds['issueMarkRead']
      return patchOverlay(
        'issues',
        i.id,
        entry.mutationId,
        { readAt: new Date(entry.queuedAt).toISOString(), unread: false },
        (r) => (r as IssueWire).unread === false && (r as IssueWire).readAt != null,
      )
    }
    case 'issueMarkUnread': {
      const i = entry.input as OutboxKinds['issueMarkUnread']
      return patchOverlay(
        'issues',
        i.id,
        entry.mutationId,
        { readAt: null, unread: true },
        (r) => (r as IssueWire).unread === true,
      )
    }
    case 'resumeAndSend':
      return null // no row-visible optimism (delivery, not curation)
    default:
      return null
  }
}

export interface FoldResult<T> {
  rows: T[]
  /** Ids of insert overlays NOT yet confirmed by a base row — pendingSpawnIds. */
  pendingInsertIds: ReadonlySet<string>
}

/**
 * Fold pending overlays over server truth: base rows win by id against
 * inserts (so the real row replaces its placeholder with no duplicate), then
 * patches apply IN QUEUE ORDER — two pending mutations on the same entity
 * compose oldest-first, later fields winning. Returns the SAME `base`
 * reference when nothing applies, so an empty/covered overlay set doesn't
 * churn snapshot identity (the useSyncExternalStore contract).
 */
export function foldOverlays<T extends object>(
  base: T[],
  overlays: readonly PendingOverlay[],
  keyOf: (row: T) => string,
): FoldResult<T> {
  if (overlays.length === 0) return { rows: base, pendingInsertIds: EMPTY_ID_SET }
  const known = new Set(base.map(keyOf))
  const inserts = overlays.filter((o) => o.op === 'insert' && !known.has(o.id))
  const patchesById = new Map<string, OverlayPatch[]>()
  for (const o of overlays) {
    if (o.op !== 'patch') continue
    const list = patchesById.get(o.id)
    if (list) list.push(o.patch)
    else patchesById.set(o.id, [o.patch])
  }
  let rows: T[] = base
  if (inserts.length > 0) {
    rows = [
      ...base,
      ...inserts.map((o) => (o as Extract<PendingOverlay, { op: 'insert' }>).insert as T),
    ]
  }
  if (patchesById.size > 0) {
    let touched = false
    const next = rows.map((row) => {
      const patches = patchesById.get(keyOf(row))
      if (!patches) return row
      touched = true
      return Object.assign({}, row, ...patches) as T
    })
    // A patch that matched no row is a no-op (its target isn't visible yet) —
    // keep the previous array identity in that case.
    if (touched) rows = next
  }
  return {
    rows,
    pendingInsertIds: inserts.length === 0 ? EMPTY_ID_SET : new Set(inserts.map((o) => o.id)),
  }
}

/**
 * Apply retirement rule (a) to the awaiting-truth stage for one entity: drop
 * every entry whose target row is gone, is covered, moved past its enqueue
 * baseline (oldest entry per row only — see below), or outlived the TTL.
 * Returns the SAME array when nothing retired.
 *
 * The moved-past-baseline escape is restricted to the OLDEST awaiting entry
 * per row, judged against the PRE-prune set (#263 review finding 3): entries
 * enqueued back-to-back share a baseline (the replica stays unpainted while
 * they queue), so truth covering the FIRST mutation moves the row past every
 * sibling's baseline at once — an unrestricted escape would retire the younger
 * entries too, flashing their un-echoed values away (rapid same-field edits;
 * archive's paired setArchived/setWorkState). A younger entry becomes escape-
 * eligible on a LATER prune pass, once it is the oldest survivor; until then
 * the TTL bounds it.
 */
export function pruneAwaiting<T extends object>(
  awaiting: AwaitingTruth[],
  entity: OverlayEntity,
  base: readonly T[],
  keyOf: (row: T) => string,
  now: number = Date.now(),
): AwaitingTruth[] {
  if (!awaiting.some((a) => a.overlay.entity === entity)) return awaiting
  const byId = new Map(base.map((r) => [keyOf(r), r]))
  // Oldest awaiting entry per row, from the PRE-prune set: only it may use the
  // moved-past-baseline escape in this pass (array order = resolution order).
  const oldestByRow = new Map<string, AwaitingTruth>()
  for (const a of awaiting) {
    if (a.overlay.entity === entity && !oldestByRow.has(a.overlay.id)) {
      oldestByRow.set(a.overlay.id, a)
    }
  }
  const keep = awaiting.filter((a) => {
    if (a.overlay.entity !== entity) return true
    const row = byId.get(a.overlay.id)
    if (row === undefined) return false // row gone — nothing left to overlay
    if (a.overlay.coveredBy(row as unknown as SessionMeta | IssueWire)) return false
    if (now - a.resolvedAt > AWAITING_TRUTH_TTL_MS) {
      // Covering truth never arrived — bound the mask instead of wedging (see
      // the AWAITING_TRUTH_TTL_MS tradeoff note).
      console.debug(
        '[podium] awaiting-truth overlay outlived its TTL without covering truth — retiring',
        a.overlay.key,
      )
      return false
    }
    // Row moved past the ENQUEUE baseline WITHOUT covering the mutation: a
    // competing write won — server truth wins, retire rather than mask it.
    // Oldest-per-row only; no baseline (row absent at enqueue) → no escape.
    if (
      oldestByRow.get(a.overlay.id) === a &&
      a.baseline !== undefined &&
      rowFingerprint(row) !== a.baseline
    ) {
      return false
    }
    return true
  })
  return keep.length === awaiting.length ? awaiting : keep
}

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
 *          the row moved past the fingerprint taken at resolution time — a
 *          competing write won, and server truth wins (exactly the semantics
 *          the old direct-replica patching had);
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
 *                        shrunken queue, so there is no uncovered gap)
 *   truth lands        → overlay retired (rule (a))
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
 *  `fingerprint` is the JSON of the target row at resolution time — any later
 *  divergence that doesn't satisfy `coveredBy` means a competing write won. */
export interface AwaitingTruth {
  overlay: Extract<PendingOverlay, { op: 'patch' }>
  fingerprint: string
}

/** Stable empty set so snapshot slices keep identity when nothing is pending. */
export const EMPTY_ID_SET: ReadonlySet<string> = new Set()

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
 * every entry whose target row is gone, is covered, or moved past its
 * resolution fingerprint. Returns the SAME array when nothing retired.
 */
export function pruneAwaiting<T extends object>(
  awaiting: AwaitingTruth[],
  entity: OverlayEntity,
  base: readonly T[],
  keyOf: (row: T) => string,
): AwaitingTruth[] {
  if (!awaiting.some((a) => a.overlay.entity === entity)) return awaiting
  const byId = new Map(base.map((r) => [keyOf(r), r]))
  const keep = awaiting.filter((a) => {
    if (a.overlay.entity !== entity) return true
    const row = byId.get(a.overlay.id)
    if (row === undefined) return false // row gone — nothing left to overlay
    if (a.overlay.coveredBy(row as unknown as SessionMeta | IssueWire)) return false
    // Row changed since resolution WITHOUT covering the mutation: a competing
    // write won — server truth wins, retire rather than mask it forever.
    return JSON.stringify(row) === a.fingerprint
  })
  return keep.length === awaiting.length ? awaiting : keep
}

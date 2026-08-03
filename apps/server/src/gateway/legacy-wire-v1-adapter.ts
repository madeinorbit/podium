/**
 * THE CONCRETE N-1 ADAPTER — TEMPORARY, AND ITS EXPIRY IS MECHANICAL (POD-308).
 *
 * ---------------------------------------------------------------------------
 * READ THIS BEFORE TREATING ANY OF IT AS ARCHITECTURE
 * ---------------------------------------------------------------------------
 *
 * The version-negotiation MECHANISM (`@podium/protocol`'s `edge/`) is permanent.
 * THIS FILE IS NOT. It translates the pre-rewrite wire (v1: `metadataDelta` plus
 * full-list snapshots) for peers that were built before the cutover — a cached
 * PWA build, a phone that has not opened the app since the deploy, a daemon on a
 * machine nobody has updated. It exists for one rollout window and is deleted by
 * POD-279 Phase 7 at the latest.
 *
 * Its expiry is not this paragraph. It is {@link LEGACY_WIRE_V1_EXPIRY}, checked
 * by `scripts/audit-wire-adapters.ts` and counted by the deletion ratchet's
 * `legacy-wire-v1-adapter` item: the day `MIN_SUPPORTED_VERSION` reaches 2, the
 * gate fails while this file still exists, so every site that touches it is
 * forced to name a real answer at that moment. That is POD-1077's
 * `DeviceGradeUnscopedPolicy` pattern, and the difference between a scheduled
 * deletion and a comment nobody reads.
 *
 * ---------------------------------------------------------------------------
 * WHY THE LEGACY SNAPSHOT IS BUILT HERE AND NOWHERE ELSE
 * ---------------------------------------------------------------------------
 *
 * This is the whole point of the cutover, and it is easy to misread as a
 * relocation. Before POD-308 the server ran TWO serving paths: an ordered delta
 * pipe, and `funnel.publishComputed` — a snapshot fan-out fed by each feature
 * rebuilding its full list. The second is deleted. Legacy clients still receive
 * `sessionsChanged` / `issuesChanged` / … , but those messages are now a
 * TRANSLATION of the one feed, synthesised at the connection boundary from the
 * projection below, and they cease to exist when this file does.
 *
 * The distinction that matters: a snapshot built here can never disagree with
 * the feed, because it IS the feed folded up. A snapshot built by a feature
 * could, and did — that is what a dual read path is.
 *
 * ---------------------------------------------------------------------------
 * ONE SHARED PROJECTION, AND WHY THAT IS SAFE HERE AND NOWHERE ELSE
 * ---------------------------------------------------------------------------
 *
 * The projection is per-ADAPTER, not per-connection. That is sound only because
 * every v1 peer is device-grade and unscoped — the pre-cutover wire cannot
 * express a per-principal view, which is exactly why POD-1077's composition
 * roots refuse an `evict` on it rather than degrading it to a `remove`.
 *
 * THAT REFUSAL IS PRESERVED HERE, DELIBERATELY. {@link translate} throws when an
 * `evict` row reaches it. It would have been easy to make this adapter's life
 * simpler by folding an evict into the shared projection as a removal — and that
 * would render a revoked share as a deletion on every legacy client and a later
 * re-grant as a resurrection (ADR 2 Amendment 1 D14.5). The cutover makes evict
 * expressible on the WIRE (v2), not expressible in a v1 translation; a scoped
 * principal must be served v2 or not served. If this throw ever fires, it is
 * working.
 */

import type {
  AutomationRunWire,
  AutomationWire,
  ConversationDiagnosticWire,
  ConversationSummaryWire,
  IssueWire,
  SessionMeta,
} from '@podium/model'
import type {
  MetadataChange,
  ServerMessage,
  UnknownFeedChange,
  WireAdapterExpiry,
} from '@podium/protocol'
import type {
  FeedFrame,
  FeedWireAdapter,
  LegacyAdvisoryKind,
  LegacyAdvisorySource,
  LegacyPeer,
} from './wire-feed-edge'

/**
 * THE EXPIRY, as data.
 *
 * `expiresWhenMinSupportedReaches: 2` is the condition the gate reads. It is a
 * fact about the support floor, not a date: raising `MIN_SUPPORTED_VERSION` to 2
 * is the ACT of retiring the v1 wire, and it must not be possible to perform
 * that act while this translation is still registered and reachable.
 */
export const LEGACY_WIRE_V1_EXPIRY: WireAdapterExpiry = {
  expiresWhenMinSupportedReaches: 2,
  deleteByPhase: 'POD-279 Phase 7',
  rationale:
    'translates wire v2 feed frames into the pre-rewrite v1 wire (metadataDelta + full-list ' +
    'snapshots) so PWA builds cached before the cutover keep working through the rollout window',
}

/** One v2 change row, DERIVED from the protocol's arm shape. Restating the
 *  field list here would be a second definition of a change row, and one that no
 *  golden fixture could see disagree — the `change-row-typings` target. */
type FeedChangeRow = UnknownFeedChange

/** The entity kinds the v1 wire had a full-list message for. */
type LegacyKind = 'session' | 'issue' | 'conversation' | 'automation' | 'automationRun'

/**
 * ORDER IS THE PRE-CUTOVER ATTACH ORDER, and it is load-bearing rather than
 * tidy: `onClientAttached` sent sessions → issues → automations → runs →
 * conversations, and a v1 client that applies lists in arrival order would see a
 * different intermediate render if this list were sorted alphabetically. The
 * translation must be invisible to the peer.
 */
const LEGACY_KINDS: readonly LegacyKind[] = [
  'session',
  'issue',
  'automation',
  'automationRun',
  'conversation',
]

export interface LegacyWireV1Deps {
  /**
   * Conversation scan diagnostics — an ADVISORY, connection-scoped fact that was
   * never an entity and never had a change row, but which the v1
   * `conversationsChanged` message carries as a required field.
   *
   * Injected rather than projected, because it is genuinely not feed content:
   * folding it into the entity log to keep this message shape would put a
   * scan-level diagnostic into every replica's durable cache. The v2 wire does
   * not carry it at all; it rides the stream plane, where advisory
   * re-served-on-attach state belongs (ADR 7 D6).
   */
  diagnostics(): ConversationDiagnosticWire[]
}

export class LegacyWireV1Adapter
  implements FeedWireAdapter, LegacyAdvisorySource
{
  readonly version = 1
  readonly name = 'legacy-wire-v1'
  readonly expiry = LEGACY_WIRE_V1_EXPIRY
  /**
   * FALSE, and this field is the declaration that makes `translate`'s throw
   * (below) unreachable rather than merely rare (POD-376).
   *
   * v1 has `remove` and nothing else, and folding an `evict` into it would make a
   * revoked share render as a deletion and a later re-grant as a resurrection —
   * which is why this adapter throws on one. Throwing is the right last line, but
   * it fires AFTER the peer has been served rows; declaring the incapacity here
   * lets `WireFeedEdge.attach` refuse the peer before it is served anything at
   * all, on a server whose authority can actually revoke.
   */
  readonly expressesEvict = false

  /** entity kind → (entityId → wire value), in feed arrival order. */
  private readonly projection = new Map<LegacyKind, Map<string, unknown>>(
    LEGACY_KINDS.map((kind) => [kind, new Map<string, unknown>()]),
  )
  /** The highest frame stamp already folded in. Makes {@link translate}
   *  idempotent across the N connections one frame fans out to. */
  private appliedThrough = -1

  constructor(private readonly deps: LegacyWireV1Deps) {}

  translate(frame: FeedFrame, peer: LegacyPeer): readonly ServerMessage[] {
    if (frame.type === 'feedRescope' || frame.type === 'feedResyncRequired') {
      // NEITHER IS EXPRESSIBLE ON v1, and neither may be silently dropped as a
      // no-op: both mean "your cache is wrong, re-bootstrap". v1's only way to
      // say that is to re-send the world, which is what the snapshots below are.
      // A v1 peer therefore heals by full replacement — the correct rung, taken
      // with less information, which is the honest cost of an old client.
      return this.snapshotsFor(peer, LEGACY_KINDS)
    }

    const touched = this.apply(frame)
    if (frame.type === 'feedBootstrap') {
      // A bootstrap installs a whole world. v1 has no partial bootstrap, so a
      // non-final chunk produces nothing and the last one produces everything —
      // the client sees exactly the message set it saw before the cutover.
      return frame.last ? this.snapshotsFor(peer, LEGACY_KINDS) : []
    }

    if (peer.acceptsDelta) {
      const changes = frame.changes.map(toV1Change)
      if (changes.length === 0) {
        // A WATERMARK. v1 cannot express one: its cursor advances only past rows
        // it can see, and `fromExclusive` was optional precisely because nobody
        // had to certify a range. Dropping it is safe for a v1 peer and ONLY for
        // a v1 peer: v1 peers are unscoped, so a range with nothing visible has
        // nothing hidden in it either. This is the concession that makes the old
        // wire serviceable, and it is another reason it must not outlive the
        // window — a scoped v1 peer would silently accumulate invisible gaps.
        return []
      }
      return [
        {
          type: 'metadataDelta',
          seq: frame.seq,
          fromExclusive: frame.fromSeq,
          changes,
        },
      ]
    }
    return this.snapshotsFor(peer, touched)
  }

  /** Fold a frame into the shared projection. Returns the kinds it touched, so a
   *  snapshot peer is not re-sent five lists because one issue changed. */
  private apply(frame: FeedFrame & { changes: FeedChangeRow[]; seq: number }): LegacyKind[] {
    const touched = new Set<LegacyKind>()
    if (frame.seq <= this.appliedThrough) {
      // Already folded in for a sibling connection. Recompute the touched set
      // (cheap, and the caller still needs it) but do not re-apply.
      for (const change of frame.changes) {
        if (isLegacyKind(change.entity)) touched.add(change.entity)
      }
      return [...touched]
    }
    this.appliedThrough = frame.seq
    for (const change of frame.changes) {
      if (change.op === 'evict') {
        throw new Error(
          `LegacyWireV1Adapter: an 'evict' row (${change.entity}/${change.entityId}) reached the ` +
            "v1 wire, which cannot express it. 'remove' is NOT a substitute (ADR 2 Am1 D14.5) — a " +
            'revoked share would render as a deletion and a re-grant as a resurrection. A scoped ' +
            'principal must be served wire v2.',
        )
      }
      if (!isLegacyKind(change.entity)) continue
      const bucket = this.projection.get(change.entity)
      if (bucket === undefined) continue
      if (change.op === 'remove') bucket.delete(change.entityId)
      // Translated ON THE WAY IN, so the snapshot path and the delta path cannot
      // disagree: `snapshot()` serves straight out of this projection, and a
      // rename applied only at `snapshot()` would leave `advisory()` and every
      // future reader of the bucket to remember it independently (POD-1530).
      else bucket.set(change.entityId, toV1Value(change.entity, change.value))
      touched.add(change.entity)
    }
    return [...touched]
  }

  /**
   * Re-serve an advisory this wire carries INSIDE an entity message (POD-1203).
   *
   * The conversation scan diagnostics are the only one, and this method is the
   * whole reason they still reach a v1 peer promptly: they are not feed content,
   * so no frame carries them, and before the cutover the server forced a full
   * conversation snapshot at delta clients whenever they changed. Same bytes,
   * same trigger, built from THIS projection instead of from a feature's list —
   * and it goes out to a delta peer too, because a v1 delta peer has no other
   * vocabulary for "the diagnostics moved".
   */
  advisory(kind: LegacyAdvisoryKind, peer: LegacyPeer): readonly ServerMessage[] {
    void peer
    if (kind !== 'conversation-diagnostics') return []
    const message = this.snapshot('conversation')
    return message === null ? [] : [message]
  }

  private snapshotsFor(peer: LegacyPeer, kinds: readonly LegacyKind[]): ServerMessage[] {
    const out: ServerMessage[] = []
    for (const kind of LEGACY_KINDS) {
      if (!kinds.includes(kind)) continue
      const message = this.snapshot(kind)
      if (message !== null) out.push(message)
    }
    // A delta-capable peer that reached here took a heal path (rescope / resync /
    // bootstrap), where v1's only vocabulary is full replacement.
    void peer
    return out
  }

  private snapshot(kind: LegacyKind): ServerMessage | null {
    const values = [...(this.projection.get(kind)?.values() ?? [])]
    switch (kind) {
      case 'session':
        return { type: 'sessionsChanged', sessions: values as SessionMeta[] }
      case 'issue':
        return { type: 'issuesChanged', issues: values as IssueWire[] }
      case 'conversation':
        return {
          type: 'conversationsChanged',
          conversations: values as ConversationSummaryWire[],
          diagnostics: this.deps.diagnostics(),
        }
      case 'automation':
        return { type: 'automationsChanged', automations: values as AutomationWire[] }
      case 'automationRun':
        return { type: 'automationRunsChanged', automationRuns: values as AutomationRunWire[] }
      default:
        return null
    }
  }
}


const isLegacyKind = (entity: string): entity is LegacyKind =>
  (LEGACY_KINDS as readonly string[]).includes(entity)

/**
 * THE KEY RENAME, in its one and only place.
 *
 * v2 spells the target `entityId` (the kernel's spelling); v1 spelled it `id`.
 * `packages/model/src/fields/change.ts` warned that shipping this rename from a
 * field-schema refactor would be invisible until an un-rebuilt client dropped
 * every row — so it lives here, inside the translation that expires, and it is
 * deleted when this file is.
 */
function toV1Change(change: FeedChangeRow): MetadataChange {
  const base = { seq: change.seq, id: change.entityId, op: change.op }
  return (
    change.op === 'upsert'
      ? { ...base, entity: change.entity, value: toV1Value(change.entity, change.value) }
      : { ...base, entity: change.entity }
  ) as MetadataChange
}

/**
 * THE KEY-RENAME ARM (POD-1530). Deleted with the rest of this file.
 *
 * v2 renamed the issue wire key `blockedBy` to `blockedByNotes`, because the old
 * name read like the dependency list and is not: it holds an assistant's free
 * text, often a branch name. A v1 peer's code reads `blockedBy` and knows
 * nothing about the new spelling, so the rename is undone HERE, on the way out,
 * for exactly as long as v1 is served.
 *
 * WHY THIS ARM IS NOT OPTIONAL, AND WHY NOTHING WOULD HAVE TOLD YOU. Without it
 * a v1 client receives an object with no `blockedBy` key at all. That is not a
 * parse error and not a 426 — v1's issue payload is read leniently, so the
 * client simply renders an absent field: the "Agent notes" block in
 * `IssueRelations.tsx` goes BLANK, or throws on `.length` of undefined in the
 * builds that index it directly. Either way the server logs nothing, no fixture
 * changes, and no test reddens on its own. The failure is invisible from the
 * only side that can see the wire.
 *
 * BOTH EGRESS PATHS GO THROUGH HERE. A v1 peer receives issues two ways —
 * `metadataDelta` rows (via {@link toV1Change}) and full `issuesChanged` lists
 * (via the shared projection) — and translating only one produces a client whose
 * notes appear on a delta and vanish on the next reconnect, which is worse than
 * either failure alone because it looks intermittent.
 *
 * The guard is `legacy-wire-v1-adapter.blocked-by.test.ts`.
 */
function toV1Value(entity: string, value: unknown): unknown {
  if (entity !== 'issue' || value === null || typeof value !== 'object') return value
  if (!('blockedByNotes' in value)) return value
  const { blockedByNotes, ...rest } = value as Record<string, unknown>
  return { ...rest, blockedBy: blockedByNotes }
}

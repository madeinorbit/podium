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

import { createLogger } from '@podium/logger'
import type { IssueWire, SessionMeta, WorkState } from '@podium/model'
import { IssueProjection, isIssueDeferred, UNSNOOZE_BACKDATE_MS } from '@podium/model'
import type { OutboxEntry } from '../outbox'
import type { OutboxKinds } from './wiring'

const log = createLogger('client-core:overlay')

/** The two overlaid entity kinds. Conversations carry no optimistic writes. */
export type OverlayEntity = 'sessions' | 'issues' | 'issueProjections'

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
      coveredBy: (row: SessionMeta | IssueWire | IssueProjection) => boolean
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

/**
 * Cell equality for a partial-patch overlay's `coveredBy`.
 *
 * `null` and `undefined` are ONE value here, and that is not laziness about
 * types: the wire spells "unset" both ways for the same field. `issues.update`
 * clears a colour with `color: null` while `IssueWire.color` is `optional()` —
 * absent once cleared — so a strict `===` would leave every clear painted until
 * its TTL. `rowFingerprint` above already makes the same collapse for the same
 * reason (JSON.stringify drops undefined-valued keys).
 */
function sameCell(a: unknown, b: unknown): boolean {
  return (a ?? null) === (b ?? null)
}

/** Read one cell from the enqueue-time server-truth fingerprint. Missing or
 * malformed baselines are ordinary for restored/legacy entries. */
function baselineCell(entry: OutboxEntry, key: string): unknown {
  if (entry.baseline === undefined) return undefined
  try {
    const row = JSON.parse(entry.baseline) as unknown
    return row && typeof row === 'object' ? (row as Record<string, unknown>)[key] : undefined
  } catch {
    return undefined
  }
}

function patchOverlay(
  entity: OverlayEntity,
  id: string,
  key: string,
  patch: OverlayPatch,
  coveredBy: (row: SessionMeta | IssueWire | IssueProjection) => boolean,
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
      const previousReadAt = baselineCell(entry, 'readAt')
      // `readAt` has the same client home as `tuckedAt`: the retained issue row
      // that persistence writes. The projection is durable issue content and
      // deliberately carries no per-user cursor. Unlike tuck, mark-read can
      // start from an OLDER non-null cursor, so mere presence is not covering
      // truth: the persisted cursor must move past the enqueue-time cell.
      return patchOverlay(
        'issues',
        i.id,
        entry.mutationId,
        { readAt: new Date(entry.queuedAt).toISOString() },
        (r) => {
          const readAt = (r as IssueWire).readAt
          return readAt != null && readAt !== previousReadAt
        },
      )
    }
    case 'issueMarkUnread': {
      const i = entry.input as OutboxKinds['issueMarkUnread']
      return patchOverlay(
        'issues',
        i.id,
        entry.mutationId,
        { readAt: null },
        (r) => (r as IssueWire).readAt == null,
      )
    }
    case 'issueSetTucked': {
      const i = entry.input as OutboxKinds['issueSetTucked']
      // The server stamps its own clock, so covering truth is judged on the
      // PRESENCE of tuckedAt, not on the timestamp value (same reasoning as
      // sessionMarkRead's readAt). Until it lands, the pending entry keeps the
      // row folded across every replica write — including a reconnect heal
      // snapshot taken before the mutation reached the server, which is exactly
      // the un-fold flicker the old ui-state path could not avoid.
      return patchOverlay(
        'issues',
        i.id,
        entry.mutationId,
        { tuckedAt: i.tucked ? new Date(entry.queuedAt).toISOString() : null },
        (r) => ((r as IssueWire).tuckedAt != null) === i.tucked,
      )
    }
    case 'issueUpdate': {
      // THE PATCH IS THE OVERLAY (POD-781). Every key `issues.update` accepts is
      // a plain field on `IssueWire` — checked against `packages/model`'s
      // `entities/issue.ts`, key for key — so the patch folds over the row as it
      // stands, with no per-field translation table to fall out of date. The
      // per-user fields such as `readAt` are ordinary issue-row overlays with
      // their own command kinds above.
      //
      // COVERED = every key the caller set now reads back equal. Not "the row
      // changed": a competing writer moving some OTHER field must not retire
      // this overlay, and the moved-past-baseline escape in `pruneAwaiting`
      // already handles the case where one genuinely won.
      //
      // The server is trusted to land these verbatim, which is a claim about
      // THIS command and was verified: `IssueCrud.update` normalizes only by
      // ADDING keys (`normalizeClosedPatch` stamps `stage: 'done'` beside a
      // `closedReason`, a `defaultAgent` change resets model/effort) and never
      // rewrites a key the caller sent — no trimming, no coercion. Were that to
      // change, the mismatch costs one prune pass, not a wedge: the row moves
      // past the enqueue baseline without covering, and server truth wins.
      const i = entry.input as OutboxKinds['issueUpdate']
      const patch = i.patch as OverlayPatch
      const keys = Object.keys(patch)
      // An empty patch is a write with nothing to paint. Returning null keeps it
      // out of the overlay set entirely rather than parking a no-op that has to
      // wait for coverage it would get for free.
      if (keys.length === 0) return null
      return patchOverlay('issues', i.id, entry.mutationId, patch, (r) => {
        const row = r as unknown as Record<string, unknown>
        return keys.every((k) => sameCell(row[k], patch[k]))
      })
    }
    case 'issueArchive': {
      // `issues.archive` is one-way — there is no `archived: false` arm on this
      // command (unarchiving goes through `issueUpdate`). The sidebar drops a
      // row on `issue.archived || issue.deletedAt`, so this is an ordinary patch
      // and the row leaves the list on the press.
      const i = entry.input as OutboxKinds['issueArchive']
      return patchOverlay(
        'issues',
        i.id,
        entry.mutationId,
        { archived: true },
        (r) => (r as IssueWire).archived === true,
      )
    }
    case 'issueDelete': {
      // THE DELETE CASCADE (POD-781 design constraint (b)), and why ONE overlay
      // on the issue is the honest answer rather than a second overlay per
      // member session.
      //
      // `IssueSessionLifecycle.deleteIssue` tombstones every member session too,
      // so an overlay that hid only the issue row while its sessions kept
      // rendering would be lying. It does not, and the reason is where session
      // rows come from: the work sidebar is ISSUE-ONLY (`worklist/rows.ts` — "a
      // repository branch is never promoted into a pseudo-issue row"), and a
      // session reaches the screen ONLY nested under the issue that owns it.
      // Ownership itself is already delete-aware: `issueIdOwningSession` refuses
      // to own a session whose issue carries `deletedAt`. So painting `deletedAt`
      // on the issue takes the row and every member session with it, in one move.
      //
      // The alternative — a second overlay per `memberSessionIds` entry — was
      // rejected because that field is DERIVED client-side (`replica/issue-views.ts`
      // joins sessions by `issueId`) and is not in the delete input. An overlay
      // is a pure function of its outbox entry, so per-session overlays would
      // have to smuggle a session list into the tRPC input, or read the replica
      // from inside the projection: a second source of truth for membership,
      // which is precisely what POD-791 recorded as the thing not to build.
      //
      // What this paints is also not a state the app invents. It is exactly the
      // state that already occurs against server truth whenever the issue
      // tombstone lands a beat before the session tombstones.
      const i = entry.input as OutboxKinds['issueDelete']
      return patchOverlay(
        'issues',
        i.id,
        entry.mutationId,
        // The server stamps its own clock; covering truth is judged on PRESENCE,
        // like `sessionMarkRead`'s readAt and `issueSetTucked`'s tuckedAt.
        { deletedAt: new Date(entry.queuedAt).toISOString() },
        (r) => (r as IssueWire).deletedAt != null,
      )
    }
    case 'issueClose': {
      // COVERAGE IS DERIVED HERE, and this is the one case in the POD-781 family
      // where exact-match would have been wrong.
      //
      // `reason` is OPTIONAL on the contract and the server supplies its own
      // default (`IssueCrud.close`'s `reason = 'done'`) when the caller omits it.
      // A client that compared `closedReason` to the string it sent would be
      // comparing against a value it never sent — so what is judged is the
      // DERIVED fact the close produces: the stage settled to 'done' AND a reason
      // is on the row, whatever it says. That is the same shape of judgement
      // `sessionMarkRead` makes about a server-stamped `readAt`.
      //
      // What is PAINTED is only what the caller actually said. `stage: 'done'` is
      // not a guess — `normalizeClosedPatch` makes it structural: setting a
      // non-null closedReason moves the stage there, and the two menu entries
      // (Done / Won't fix) both send a reason.
      const i = entry.input as OutboxKinds['issueClose']
      return patchOverlay(
        'issues',
        i.id,
        entry.mutationId,
        { stage: 'done', ...(i.reason == null ? {} : { closedReason: i.reason }) },
        (r) => (r as IssueWire).stage === 'done' && (r as IssueWire).closedReason != null,
      )
    }
    case 'issueDefer': {
      // The plainest cell in the family: `issues.defer` is `update{deferUntil}`
      // and the server stores the string as given — a full ISO instant, the
      // board's bare `YYYY-MM-DD` preset, or the `next-message` sentinel. So this
      // is an exact match, through `sameCell` because clearing a defer sends
      // `null` while a never-deferred row may simply not carry the field.
      const i = entry.input as OutboxKinds['issueDefer']
      return patchOverlay('issues', i.id, entry.mutationId, { deferUntil: i.until }, (r) =>
        sameCell((r as IssueWire).deferUntil, i.until),
      )
    }
    case 'issueUndefer': {
      // UNSNOOZE IS NOT "CLEAR" (issue #133). The server backdates `deferUntil`
      // past the sidebar's coarse minute-granularity clock rather than nulling it,
      // which lands the row in the returned-from-defer state: top of WORK, wearing
      // the "Unsnoozed" tag, until the operator next opens it. Painting `null`
      // here would paint a DIFFERENT act — the quiet clear that `defer(null)` is —
      // and the tag would appear only once the round trip finished, which is the
      // exact lag this issue exists to delete. `UNSNOOZE_BACKDATE_MS` is shared
      // with the server for that reason (it moved into `@podium/model`).
      //
      // COVERAGE IS DERIVED, on the predicate rather than the instant: the server
      // backdates from ITS clock at apply time, and a queued undefer that drains
      // an hour later lands a different timestamp than the one painted here. What
      // both agree on is that the issue is no longer deferred. A no-op undefer
      // (the row was not deferred at all) is covered from the start, which is
      // right — there is nothing for truth to catch up to.
      const i = entry.input as OutboxKinds['issueUndefer']
      return patchOverlay(
        'issues',
        i.id,
        entry.mutationId,
        { deferUntil: new Date(entry.queuedAt - UNSNOOZE_BACKDATE_MS).toISOString() },
        (r) => !isIssueDeferred(r as IssueWire, Date.now()),
      )
    }
    case 'issueSetLabels': {
      // THE SERVER NORMALIZES THIS ONE, so the overlay normalizes it the same way
      // — the precedent is `rename` above, which trims because the server trims.
      // `setIssueLabels` drops blanks and duplicates, and the read side returns
      // the set `ORDER BY label ASC`. Painting the raw array would repaint the
      // chip row the moment truth landed, which is a flicker the overlay exists
      // to prevent.
      //
      // COVERAGE IS DERIVED — as a SET, not as an array. The sorted order is the
      // one thing here the client cannot honestly claim to reproduce: SQLite
      // orders TEXT by byte and JavaScript by UTF-16 code unit, and those part
      // company outside ASCII. Judging membership keeps a label with an accent or
      // an emoji in it from hanging its overlay to the TTL for a difference
      // nobody can see.
      const i = entry.input as OutboxKinds['issueSetLabels']
      const labels = [...new Set(i.labels.map((l) => l.trim()).filter(Boolean))].sort()
      return patchOverlay('issues', i.id, entry.mutationId, { labels }, (r) => {
        const current = (r as IssueWire).labels ?? []
        return current.length === labels.length && labels.every((l) => current.includes(l))
      })
    }
    case 'issueSetPlacement': {
      // WHAT MOVES ON SCREEN IS THE PARENT LINK, so that is what this paints.
      // `'mission'` hangs the issue under the origin (it nests into that mission
      // in the sidebar and on the deck's spine); `'own'` cuts it loose to
      // top-level. Both are `parentId`, and `sameCell` is why `null` is honest
      // for the second: the wire spells "no parent" as an absent field.
      //
      // THE PROVENANCE EDGE IS NOT PAINTED, deliberately, and this is the one
      // POD-781 kind that paints less than its command writes. `deps` is on the
      // wire, but it is DERIVED from `issue_deps` and the input names one edge,
      // not the resulting set — so an overlay could only guess at the array by
      // reading the current row, and an overlay is a pure function of its entry
      // (the same rule that kept `issueDelete` off `memberSessionIds`). The
      // consequence is bounded and visible in one place: `discoveredPlacement`
      // reads a spin-off's edge BEFORE it reads `parentId`, so the placement
      // CHIP on an issue moving back into a mission keeps saying "own" until the
      // round trip lands, while the row itself has already moved. A chip that
      // lags by a round trip is what the whole app did before this issue; the
      // row that lags was the complaint.
      const i = entry.input as OutboxKinds['issueSetPlacement']
      const parentId = i.placement === 'mission' ? i.originId : null
      return patchOverlay('issues', i.id, entry.mutationId, { parentId }, (r) =>
        sameCell((r as IssueWire).parentId, parentId),
      )
    }
    case 'issueRestore': {
      // THE INVERSE OF `issueDelete`, and honest about being a PARTIAL inverse.
      //
      // Clearing `deletedAt` brings the issue row back — and, because ownership
      // is delete-aware (`issueIdOwningSession`), it brings back every member
      // session the replica still knows about. What it cannot bring back is a
      // session row the SERVER tombstoned when the delete landed for real: those
      // carry their own `deletedAt` in the replica, the restore input names no
      // sessions, and the same rule that stopped the delete overlay from
      // touching `memberSessionIds` stops this one. So a restore of a delete that
      // already reached the server paints the row instantly and refills it as the
      // sessions echo back — which is the same order the server itself applies
      // them in, not a state the app invents.
      //
      // The commoner case pays nothing at all: a delete still QUEUED collapses
      // against this restore (they share `issue-deleted:<id>`), no cascade ever
      // ran, and the row returns with its sessions intact.
      const i = entry.input as OutboxKinds['issueRestore']
      return patchOverlay('issues', i.id, entry.mutationId, { deletedAt: null }, (r) =>
        sameCell((r as IssueWire).deletedAt, null),
      )
    }
    case 'resumeAndSend': {
      // A WAKE *IS* ROW-VISIBLE (POD-762). This used to project null on the
      // grounds that it is delivery rather than curation, and the row said
      // nothing at all between the operator pressing Enter and the resumed CLI
      // typing their text — a wait that runs from a round trip to a minute,
      // because the agent has to be spawned before anything can be typed into
      // it. Every surface therefore went on saying "Hibernated — resume", which
      // reads as "your message did nothing" and invites a second send.
      //
      // The optimism is the queue DEPTH, because that is the fact: their message
      // is waiting on this session. One field lights the wake up everywhere at
      // once — the parked bar, the composer placeholder, the activity row, the
      // sidebar's queue count — with no surface needing to hear about the send.
      const i = entry.input as OutboxKinds['resumeAndSend']
      return patchOverlay(
        'sessions',
        i.sessionId,
        entry.mutationId,
        { queuedMessageCount: 1 },
        // Covered as soon as the server has an opinion of its own: it reports a
        // queue, or the session is no longer parked (it woke, and a fast drain
        // may have emptied the queue before any snapshot showed it non-zero).
        (r) => {
          const s = r as SessionMeta
          const parked = s.status === 'hibernated' || s.status === 'exited'
          return (s.queuedMessageCount ?? 0) > 0 || !parked
        },
      )
    }
    default:
      return null
  }
}

/**
 * THE CONTRACT ↔ REDUCER MAP (POD-380).
 *
 * POD-311 puts an "optional command-specific optimistic reducer" on the contract.
 * The reducers themselves are these `overlayForOutboxEntry` cases and they must
 * stay here — they read `SessionMeta` / `IssueWire`, which a leaf contract package
 * cannot import. What this map adds is the JOIN: which presence CONTRACT each
 * outbox kind reduces for, so a migrated command is provably reduced rather than
 * reduced-by-coincidence-of-having-an-outbox-kind.
 *
 * The pairing runs contract-name → outbox kind because the outbox is keyed by kind
 * and the contract table is keyed by dotted name; without one explicit map the two
 * vocabularies drift silently and nothing notices. `overlay.test.ts` asserts every
 * OFFLINE-ELIGIBLE presence contract appears here — pins and tab order reduce in actions.ts because they are non-entity per-user rows.
 *
 * THE ISSUE KINDS ARE DELIBERATELY ABSENT, and always have been: `issueMarkRead`,
 * `issueMarkUnread` and `issueSetTucked` have reducer cases above without an entry
 * here, and POD-781's nine curation kinds (`issueUpdate`, `issueArchive`,
 * `issueDelete`, `issueClose`, `issueDefer`, `issueUndefer`, `issueSetLabels`,
 * `issueSetPlacement`, `issueRestore`) follow them.
 * This map's totality test is stated against `sessionStateCommandNames()` — the
 * PRESENCE family — so it asserts equality, not containment, and an `issues.*`
 * name in it would red the suite by being a key with no eligible contract to
 * match. The join it exists to make is presence-contract → reducer; issue
 * contracts are joined by `outbox-contract-table.test.ts` instead, which compares
 * `OUTBOX_COMMANDS` against `ISSUE_CONTRACTS` directly and so covers the same
 * drift for them.
 */
export const PRESENCE_REDUCER_KINDS: Record<string, keyof OutboxKinds & string> = {
  'sessions.rename': 'rename',
  'sessions.setArchived': 'setArchived',
  'sessions.setWorkState': 'setWorkState',
  'sessions.markRead': 'sessionMarkRead',
  'sessions.markUnread': 'sessionMarkUnread',
  'snoozes.set': 'snoozeSet',
  'snoozes.clear': 'snoozeClear',
}

/**
 * THE CURATION MIRROR (POD-781 group 2) — why the issue BOARD paints on the
 * press and not only the sidebar.
 *
 * THE PROBLEM IT SOLVES, measured rather than assumed. The two surfaces read
 * two different rows. The sidebar's worklist slice derives from the LEGACY issue
 * wire (`IssueNavigationModel` is `IssueWire`), which is the entity every
 * curation kind overlays — so a rename or a colour paints there immediately. The
 * board and the issue page read `useIssueViewModels`, which merges
 * `{...legacyWire, ...projection, ...derived}` — and `IssueProjection` is the
 * issue's whole DURABLE row (`wireShape(IssueAggregate.shape)`), so it carries
 * `title`, `stage`, `priority`, `labels`, `color`, `deferUntil`, `closedReason`,
 * `archived`, `deletedAt` and `sortKey` and OVERRIDES the overlaid wire for every
 * one of them. Un-mirrored, the board would keep painting server truth until the
 * round trip landed while the sidebar had already moved — the same lag this issue
 * exists to delete, hidden on the surface nobody thought to check.
 *
 * WHY A FOLD-TIME MIRROR rather than a second overlay per kind. An overlay is a
 * pure function of ONE outbox entry, and the entry names one command against one
 * issue — not two entities. Emitting two overlays per kind would double every
 * kind's bookkeeping (awaiting-truth, retirement, baselines) to express one fact
 * twice. Mirroring at the fold keeps ONE overlay of record, retired by its own
 * `coveredBy` against the wire row, and derives the projection's copy from it —
 * without creating a second overlay of record.
 *
 * WHAT IS NOT MIRRORED, and why the key set is DERIVED. The mirrorable keys are
 * `IssueProjection`'s own, read off the schema, so a field added to the durable
 * row is mirrored the day it arrives instead of the day someone remembers a list.
 * Two are excluded by name: `description` and `notes` are op-stream DOCUMENTS on
 * the projection (`{ value }`) and plain strings in the patch, so copying one
 * across would put a string where a document lives and the board would render
 * nothing. They are the two `projectionOnLegacySpelling` already re-spells, and a
 * patch of only those mirrors nothing at all rather than half-landing. `readAt`,
 * `pinned`, and `tuckedAt` are not excluded — they simply are not projection
 * fields (they are per-user state), so the filter drops them and the board keeps
 * reading them off the overlaid wire, where they already paint.
 */
const PROJECTION_MIRROR_KEYS: ReadonlySet<string> = new Set(
  Object.keys(IssueProjection.shape).filter((key) => key !== 'description' && key !== 'notes'),
)

export function projectionCurationOverlay(overlay: PendingOverlay): PendingOverlay | null {
  if (overlay.op !== 'patch' || overlay.entity !== 'issues') return null
  const mirrored: OverlayPatch = {}
  for (const [key, value] of Object.entries(overlay.patch)) {
    if (PROJECTION_MIRROR_KEYS.has(key)) mirrored[key] = value
  }
  if (Object.keys(mirrored).length === 0) return null
  // The SOURCE overlay stays the one of record: it is what `mutationApplied`
  // holds and what `pruneAwaiting` retires, judged against the wire row. This
  // copy is derived fresh on every fold, so it appears and disappears with it.
  return patchOverlay('issueProjections', overlay.id, overlay.key, mirrored, overlay.coveredBy)
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
  /**
   * Ids the AUTHORITY said were REMOVED — deleted, not merely absent (POD-380).
   *
   * Absence and deletion are different facts and this parameter is what keeps them
   * apart. A replica no longer holds the world, only its principal's slice
   * (docs/multi-user-readiness.md §3.1), so a row can leave `base` because it was
   * deleted OR because it left YOUR VIEW — an un-share, a rescope, POD-1077's
   * `evict` op. ADR 2 §3.1's warning is explicit: `remove` cannot be reused for
   * the second case, because the replica would render it as "deleted", and D5
   * already warns that soft-delete and tombstone "look identical from a distance
   * and are not". This is a third member of that family.
   *
   * Any slice exit retires the overlay. An evicted or rescoped row must not remain
   * paintable by client optimism, because doing so would fabricate visibility.
   */
  removedIds?: ReadonlySet<string>,
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
    if (row === undefined) {
      void removedIds
      return false
    }
    if (a.overlay.coveredBy(row as unknown as SessionMeta | IssueWire | IssueProjection))
      return false
    if (now - a.resolvedAt > AWAITING_TRUTH_TTL_MS) {
      // Covering truth never arrived — bound the mask instead of wedging (see
      // the AWAITING_TRUTH_TTL_MS tradeoff note).
      log.debug('awaiting-truth overlay outlived its TTL without covering truth — retiring', {
        key: a.overlay.key,
        ageMs: now - a.resolvedAt,
      })
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

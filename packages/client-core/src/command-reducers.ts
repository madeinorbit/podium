/**
 * THE PURE COMMAND REDUCERS (POD-5431, plan step 3 of
 * `docs/plans/pod-4286-optimism-and-refusals.md`): what a queued command paints,
 * and the fold and settlement rules over those paints. Pure functions of an
 * entry and a row, imported by the pool's transaction layer. Nothing here reads
 * a runtime or a full list. Server truth stays in the replica; pending patches
 * and spawn inserts are folded over one addressed row.
 *
 * RETIREMENT RULE (ADR 12): an overlay lives exactly as long as its outbox
 * entry. A queued entry paints; an applied entry keeps painting while it
 * awaits confirmation; the replica's commit of covering truth (a cursor at or
 * past the entry's receipt, or a row carrying its mutation id) retires the
 * entry and the overlay with it, in one step. A refused entry drops at once.
 * Nothing here compares a painted value with a server row, and no timer
 * retires anything.
 *
 * A spawn placeholder is not an outbox entry. It retires when a base row with
 * its client-minted id exists, which is exact.
 *
 * GENERIC RECORD WRITES (ADR 12 D3, POD-6392) take ONE case for every declared
 * kind: the entry's patch is the paint, spelled as the kind's wire row spells
 * it; a create inserts its row; a remove hides the row. Nothing in that case
 * names a kind (`recordOverlays`).
 */

import type {
  PinWire,
  ReadPositionWire,
  SessionMeta,
  SessionUserStateWire,
  SuperagentThreadWire,
  TabOrderWire,
  UserPreferencesWire,
  WorkState,
} from '@podium/model'
import { IssueProjection, type IssueUserStateWire } from '@podium/model'
import type { OutboxKinds } from './engine/wiring'
import type { OutboxEntry } from './outbox'
import {
  isRecordOutboxKind,
  loadedRecordDeclarations,
  RECORD_HOMES,
  recordDeclaration,
  recordOpOf,
} from './records'

/** The entities a per-row reader may paint from transactions (the pool's row
 *  source reads exactly these). Conversations carry no optimistic writes. */
export type OverlayEntity = 'sessions' | 'issueProjections'

/**
 * Every entity an overlay can paint (POD-4969). The per-user issue state —
 * `readAt`, `tuckedAt`, one row per (user, issue) — is a target of its
 * own: the normalized issue row deliberately carries no per-user cell. So is
 * the per-user session state (POD-4974 S3): `readAt` and `snoozedUntil`, one
 * row per (user, session), joined into the session view by the reader.
 */
export type OverlayTarget =
  | OverlayEntity
  | 'issueUserStates'
  | 'sessionUserStates'
  // POD-6673's standalone per-user rows, each keyed by its feed id.
  | PerUserRecordTarget
  // A human gate's decision on an effect record (POD-6674).
  | 'effects'
  // A trigger subscription's toggle or removal (POD-6676).
  | 'subscriptions'

/** The record kinds that are pool rows of their own, keyed by their feed id:
 *  the per-user records (POD-6673) and the one instance settings record
 *  (POD-6677). */
export type PerUserRecordTarget =
  | 'pins'
  | 'tabOrders'
  | 'userPreferences'
  | 'userReadPositions'
  | 'superagentThreads'
  | 'instancePreferences'
export const PER_USER_RECORD_TARGETS: readonly PerUserRecordTarget[] = [
  'pins',
  'tabOrders',
  'userPreferences',
  'userReadPositions',
  'superagentThreads',
  'instancePreferences',
]

/** Fields folded over a base row. Loose on purpose — the projection functions
 *  below are the typed constructors; folding is structural. */
type OverlayPatch = Record<string, unknown>

export type PendingOverlay =
  | {
      op: 'patch'
      /** Stable identity: the outbox entry's mutationId. */
      key: string
      entity: OverlayTarget
      /** Target row id (sessionId / issue id; the entity's id for per-user state). */
      id: string
      patch: OverlayPatch
      /**
       * The row this patch folds over when the target row is ABSENT. Only
       * per-user state has one: an absent `(user, issue)` row means "nothing
       * set" (the server deletes the row rather than store three nulls), so a
       * mark-read on a never-touched issue must still paint. An absent
       * `(user, session)` row means "not loaded": the session row's own legacy
       * cells still speak for it (POD-4974 S2's fallback), and the patch folds
       * over those. The transaction log sets it using the
       * principal and whether the entity is in the slice; an overlay built from
       * an entry alone never carries it.
       */
      absent?: object
    }
  | {
      op: 'insert'
      /** Stable identity: `spawn:<row id>`. */
      key: string
      entity: OverlayTarget
      id: string
      /** The whole placeholder row, shown until a base row (same id) lands. */
      insert:
        | SessionMeta
        | IssueProjection
        | IssueUserStateWire
        | SessionUserStateWire
        | PinWire
        | TabOrderWire
        | UserPreferencesWire
        | ReadPositionWire
        | SuperagentThreadWire
    }
  | {
      /**
       * A queued or awaiting removal (POD-6392): the row is absent from here on
       * in queue order, as it will be once the removal lands. A later patch
       * folds over the target's absent row, if it has one.
       */
      op: 'remove'
      /** Stable identity: the outbox entry's mutationId. */
      key: string
      entity: OverlayTarget
      id: string
    }

/**
 * Cell equality for the fold's "did a patch move this cell" check.
 *
 * `null` and `undefined` are ONE value here, and that is not laziness about
 * types: the wire spells "unset" both ways for the same field. `issues.update`
 * clears acceptance with `acceptance: null` while `IssueProjection.acceptance`
 * is `optional()`, absent once cleared.
 */
function sameCell(a: unknown, b: unknown): boolean {
  return cellValue(a) === cellValue(b)
}

/**
 * Cells where `null` and ABSENT are two different facts, so the collapse above
 * would erase a real edit. `snoozedUntil: null` is a snooze "until the next
 * message"; an absent `snoozedUntil` is no snooze at all (`predicates/snooze.ts`,
 * `SessionSnoozeState`). Read as one value, a "snooze until next message" on an
 * unsnoozed session moved no cell: the press painted nothing, and the snooze
 * showed only when the server answered.
 */
const NULL_IS_A_VALUE: ReadonlySet<string> = new Set(['snoozedUntil'])

/** {@link sameCell} for one named cell. */
function sameKeyedCell(key: string, a: unknown, b: unknown): boolean {
  if (NULL_IS_A_VALUE.has(key) && (a === null) !== (b === null)) return false
  return sameCell(a, b)
}

/**
 * What a cell IS, for comparison.
 *
 * An op-stream document (`description` on the normalized issue row) is
 * its materialized `value`. Its `revision` and `opsTail` are the authority's
 * bookkeeping: a painted `{ value }` and the echoed `{ value, revision }` show
 * the same text.
 *
 * Any other structured cell (`labels`, `asked`) is its JSON, so two equal
 * arrays are one value.
 *
 * Unset is one value here too.
 */
function cellValue(v: unknown): unknown {
  if (v !== null && typeof v === 'object') {
    const doc = v as Record<string, unknown>
    if (
      !Array.isArray(v) &&
      typeof doc.value === 'string' &&
      Object.keys(doc).every((k) => DOC_KEYS.has(k))
    ) {
      return doc.value
    }
    return JSON.stringify(v)
  }
  return v ?? null
}

const DOC_KEYS: ReadonlySet<string> = new Set(['value', 'revision', 'opsTail'])

function patchOverlay(
  entity: OverlayTarget,
  id: string,
  key: string,
  patch: OverlayPatch,
): Extract<PendingOverlay, { op: 'patch' }> {
  return { op: 'patch', key, entity, id, patch }
}

/** A spawn placeholder (#119) as a unified overlay entry: same bookkeeping as
 *  an outboxed patch, but the transport stays direct tRPC (see engine). */
export function insertOverlay(
  entity: OverlayTarget,
  id: string,
  insert: Extract<PendingOverlay, { op: 'insert' }>['insert'],
): PendingOverlay {
  return { op: 'insert', key: `spawn:${id}`, entity, id, insert }
}

/** The normalized issue row's own fields. */
const ISSUE_PROJECTION_KEYS: ReadonlySet<string> = new Set(Object.keys(IssueProjection.shape))

/** Op-stream documents on the normalized row (`{ value, revision?, opsTail? }`)
 *  that a write spells as plain text. */
const ISSUE_DOCUMENT_KEYS: ReadonlySet<string> = new Set(['description'])

/**
 * `issues.update` keys the SERVER resolves into a different cell, so their raw
 * value would paint something no row ever holds; they are not painted.
 * `agentProfile` is a name or id the server turns into `agentProfileId`
 * (POD-6107). `overlay.test.ts` holds this set exact, so it cannot grow quietly.
 */
export const ISSUE_SERVER_RESOLVED_UPDATE_KEYS: ReadonlySet<string> = new Set(['agentProfile'])

/**
 * An `issues.update` patch as the normalized issue row paints it (POD-4969), in
 * ITS spelling — `description` is a document there, so the text is painted as
 * `{ value }`. A key the row does not carry is not painted at all: no row shows
 * it. Every key lands on the issue row: the last per-user one, `pinned`, is a
 * `pin` record since POD-6692. `overlay.test.ts` holds every key the contract
 * accepts to the row, so a new contract key cannot fall through silently.
 */
export function issueUpdateRoute(patch: OverlayPatch): OverlayPatch {
  const issue: OverlayPatch = {}
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue
    if (ISSUE_DOCUMENT_KEYS.has(key)) issue[key] = { value }
    else if (ISSUE_PROJECTION_KEYS.has(key)) issue[key] = value
  }
  return issue
}

/**
 * Project one queued outbox entry into its overlays. Mirrors — field for field —
 * the optimistic patches the engine used to write straight into the replica,
 * so the painted result is byte-identical to the old mechanism's. Kinds with
 * no visible optimism project to nothing. Where the server normalizes a value
 * (it trims names, sorts labels), the paint normalizes it the same way, so the
 * row does not move when truth replaces the paint.
 *
 * ONE ENTRY, ONE OVERLAY PER ROW IT LANDS ON (POD-4969). Issue writes target
 * the NORMALIZED rows: the durable fields on `issueProjections`, the per-user
 * markers on `issueUserStates`. Every kind lands on exactly one of them except
 * All parts share the mutationId and retire with its entry.
 */
export function overlaysForOutboxEntry(
  entry: OutboxEntry,
  viewer: ReducerViewer = {},
): PendingOverlay[] {
  const projected = overlayOf(entry, viewer)
  return projected === null ? [] : Array.isArray(projected) ? projected : [projected]
}

/** What the reducing device knows. Only a record create reads it: a fresh
 *  record's owner is painted as this person, and its placement (an issue's
 *  repo) guessed from the rows the device holds (POD-6400). */
export interface ReducerViewer {
  readonly userId?: string
  readonly known?: (entity: string, field: string, value: unknown) => readonly string[]
}

function overlayOf(
  entry: OutboxEntry,
  viewer: ReducerViewer,
): PendingOverlay | PendingOverlay[] | null {
  if (isRecordOutboxKind(entry.kind)) return recordOverlays(entry, viewer)
  switch (entry.kind as keyof OutboxKinds) {
    case 'dismissOffer': {
      const i = entry.input as OutboxKinds['dismissOffer']
      // `undefined`, not null, for the same reason `snoozeClear` patches
      // `snoozedUntil: undefined`: the server's cleared row carries no offer
      // key at all, so the paint is byte-identical to the truth it predicts.
      return patchOverlay('sessions', i.sessionId, entry.mutationId, { offer: undefined })
    }
    case 'issueUpdate': {
      // THE PATCH IS THE OVERLAY (POD-781), on the normalized issue row
      // (POD-4969), read off its schema (`issueUpdateRoute`), not listed.
      //
      // The server lands these verbatim: `IssueCrud.update` normalizes only by
      // ADDING keys (`normalizeClosedPatch` stamps `stage: 'done'` beside a
      // `closedReason`, a `defaultAgent` change resets model/effort) and never
      // rewrites a key the caller sent, so the paint is what truth will show.
      const i = entry.input as OutboxKinds['issueUpdate']
      const issue = issueUpdateRoute(i.patch as OverlayPatch)
      // An empty patch projects to no overlay at all.
      return Object.keys(issue).length === 0
        ? []
        : [patchOverlay('issueProjections', i.id, entry.mutationId, issue)]
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
        'issueProjections',
        i.id,
        entry.mutationId,
        // The server stamps its own clock, like `issueSetTucked`'s tuckedAt.
        { deletedAt: new Date(entry.queuedAt).toISOString() },
      )
    }
    case 'issueClose': {
      // `reason` is OPTIONAL on the contract and the server supplies its own
      // default (`IssueCrud.close`'s `reason = 'done'`) when the caller omits it.
      // What is PAINTED is only what the caller actually said. `stage: 'done'` is
      // not a guess — `normalizeClosedPatch` makes it structural: setting a
      // non-null closedReason moves the stage there, and the two menu entries
      // (Done / Won't fix) both send a reason.
      const i = entry.input as OutboxKinds['issueClose']
      return patchOverlay('issueProjections', i.id, entry.mutationId, {
        stage: 'done',
        ...(i.reason == null ? {} : { closedReason: i.reason }),
      })
    }
    case 'issueSetPlacement': {
      // WHAT MOVES ON SCREEN IS THE PARENT LINK, so that is what this paints.
      // `'mission'` hangs the issue under the origin (it nests into that mission
      // in the sidebar and on the deck's spine); `'own'` cuts it loose to
      // top-level. Both are `parentId`; the wire spells "no parent" as an
      // absent field, which the fold reads as `null`.
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
      return patchOverlay('issueProjections', i.id, entry.mutationId, { parentId })
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
      return patchOverlay('issueProjections', i.id, entry.mutationId, { deletedAt: null })
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
      return patchOverlay('sessions', i.sessionId, entry.mutationId, { queuedMessageCount: 1 })
    }
    default:
      return null
  }
}

/**
 * THE ONE GENERIC CASE (ADR 12 D3, POD-6392): what a record write paints, for
 * every declared kind, read off the declaration and nothing else.
 *
 *  - edit: the patch, on the kind's row in the pool; a cleared cell
 *    (`unset`, POD-6403) paints absent;
 *  - create: the record's WHOLE row, as the kind declares a new one looks
 *    (POD-6400, `freshRow`): the create's fields with their defaults, the
 *    constant cells, and a placeholder for each cell the server assigns (an
 *    issue's `seq` is 0, read as pending; its timestamps are the queue time).
 *    The server's row replaces it when the entry retires;
 *  - remove: the row is hidden.
 *
 * The values are the entry's own, which the API already parsed with the
 * command's schema (`records.ts`), so they are what the server stores. The
 * pool row a record lands on is its kind's home (`RECORD_HOMES`).
 */
function recordOverlays(entry: OutboxEntry, viewer: ReducerViewer): PendingOverlay[] {
  if (!isRecordOutboxKind(entry.kind)) return []
  const input = entry.input as {
    kind: keyof typeof RECORD_HOMES
    id: string
    patch?: OverlayPatch
    unset?: readonly string[]
    fields?: OverlayPatch
    expectedRevision?: number
  }
  const d = recordDeclaration(input.kind)
  const home = RECORD_HOMES[input.kind]
  if (d === undefined || home === undefined || home === null) return []
  const row = home.row(input.id)
  const { freshRow, wireCells } = loadedRecordDeclarations()
  switch (recordOpOf(entry.kind)) {
    case 'edit': {
      // A kind with a spec revision paints the revision this edit will make
      // (POD-6399), so "not answered yet" reads the same before the receipt as
      // after it: revision ahead of the observed one.
      const patch: OverlayPatch = {
        ...wireCells(d, input.patch ?? {}),
        ...(d.revisionField !== undefined && typeof input.expectedRevision === 'number'
          ? { [d.revisionField]: input.expectedRevision + 1 }
          : {}),
      }
      // A cleared cell paints absent (POD-6403): the fold spreads `undefined`.
      for (const name of input.unset ?? []) if (name in d.fields) patch[name] = undefined
      return Object.keys(patch).length === 0
        ? []
        : [patchOverlay(home.target, row, entry.mutationId, patch)]
    }
    case 'create': {
      const whole = freshRow(d, input.id, input.fields ?? {}, {
        at: new Date(entry.queuedAt).toISOString(),
        by: viewer.userId ?? null,
        ...(viewer.known === undefined ? {} : { known: viewer.known }),
      })
      // A declaration check holds every create kind to a whole row; a row that
      // still does not parse (an entry from an older build) paints nothing.
      if (whole === undefined || !d.wire.safeParse(whole).success) return []
      return [
        {
          op: 'insert',
          key: entry.mutationId,
          entity: home.target,
          id: row,
          insert: whole as Extract<PendingOverlay, { op: 'insert' }>['insert'],
        },
      ]
    }
    case 'remove':
      return [{ op: 'remove', key: entry.mutationId, entity: home.target, id: row }]
  }
}

/**
 * THE CONTRACT ↔ REDUCER MAP (POD-380).
 *
 * POD-311 puts an "optional command-specific optimistic reducer" on the contract.
 * The reducers themselves are these `overlaysForOutboxEntry` cases and they must
 * stay here — they read `SessionMeta` / `IssueProjection`, which a leaf contract package
 * cannot import. What this map adds is the JOIN: which presence CONTRACT each
 * outbox kind reduces for, so a migrated command is provably reduced rather than
 * reduced-by-coincidence-of-having-an-outbox-kind.
 *
 * The pairing runs contract-name → outbox kind because the outbox is keyed by kind
 * and the contract table is keyed by dotted name; without one explicit map the two
 * vocabularies drift silently and nothing notices. `overlay.test.ts` asserts every
 * OFFLINE-ELIGIBLE presence contract appears here — pins and tab order reduce in actions.ts because they are non-entity per-user rows.
 *
 * THE ISSUE KINDS ARE DELIBERATELY ABSENT, and always have been (the per-user
 * issue marks are record edits since POD-6404), and POD-781's nine curation kinds (`issueUpdate`, `issueArchive`,
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
  'sessions.dismissOffer': 'dismissOffer',
}

/**
 * The presence contracts whose writes became generic record edits (POD-6404):
 * the apps paint them with the one record case, and the old routes stay only
 * for older apps until POD-6359. The contract ↔ reducer totality test reads
 * this beside the map above.
 */
export const PRESENCE_CONTRACTS_AS_RECORD_EDITS: ReadonlySet<string> = new Set([
  'sessions.markRead',
  'sessions.markUnread',
  'snoozes.set',
  'snoozes.clear',
  // The session labels (POD-6406).
  'sessions.rename',
  'sessions.setArchived',
  'sessions.setWorkState',
])

/** True when the fold actually moved one of the cells it wrote. Only the patched
 *  keys are looked at — every other cell came straight off `row`. */
function movedAnyCell(row: object, merged: object, patches: readonly OverlayPatch[]): boolean {
  const before = row as Record<string, unknown>
  const after = merged as Record<string, unknown>
  for (const patch of patches) {
    for (const key of Object.keys(patch)) {
      if (!sameKeyedCell(key, before[key], after[key])) return true
    }
  }
  return false
}

/** Rebase one pool row in queue order. Missing personal rows use their declared
 * empty marker value; a covering base row wins over a spawn placeholder. */
export function foldRowOverlays<T extends object>(
  base: T | undefined,
  overlays: readonly PendingOverlay[],
): T | undefined {
  if (overlays.length === 0) return base
  // A removal hides the row and everything folded before it; what comes after
  // it folds over the absent row, as it will once the removal lands.
  let last = -1
  for (let i = overlays.length - 1; i >= 0; i--) {
    if (overlays[i]!.op === 'remove') {
      last = i
      break
    }
  }
  if (last >= 0) {
    base = undefined
    overlays = overlays.slice(last + 1)
    if (overlays.length === 0) return undefined
  }
  let row = base
  let absent = false
  if (row === undefined) {
    const insert = overlays.find((o) => o.op === 'insert')
    const fallback = overlays.find((o) => o.op === 'patch' && o.absent !== undefined)
    if (insert !== undefined) row = insert.insert as T
    else if (fallback?.op === 'patch') {
      row = fallback.absent as T
      absent = true
    } else return undefined
  }
  const patches: OverlayPatch[] = []
  for (const o of overlays) if (o.op === 'patch') patches.push(o.patch)
  if (patches.length === 0) return row
  const merged = Object.assign({}, row, ...patches) as T
  if (movedAnyCell(row, merged, patches)) return merged
  // An absent row that the patches leave saying "nothing set" stays absent.
  return absent ? undefined : row
}

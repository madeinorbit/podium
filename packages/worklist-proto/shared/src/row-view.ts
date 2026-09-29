/**
 * POD-4547 (L1b) — the row view contract: exactly what one rendered worklist
 * row is, where each field comes from, and the pure functions that order and
 * place rows.
 *
 * WHY THIS FILE EXISTS. Round two's K exercises planted an O(N) scan inside a
 * row component (`for (const issue of store.issues.rows.values())` in
 * `HandRow`) and it was SILENT in two arms: typecheck, unit tests, exact commit
 * counts, parity and scans all stayed green, because commits count renders,
 * not work per render (`docs/decisions/4441-k-hand-exercise.md` Table 2 F,
 * `4441-k-tanstack-exercise.md` Table 2 F). It was possible at all because the
 * row received a store handle. Round three makes it impossible by construction:
 * a row component receives its own `RowView` and nothing else
 * (`RowComponent` / `RowShell` in `row-shell.tsx`), and a `RowView` holds only
 * scalars and one flat record — no arrays, no entity objects, no store.
 *
 * WHAT A FIELD MAY DEPEND ON. Each field's doc names its rule (slice spec
 * `docs/plans/pod-4441-round-two-slice.md` §3) and its inputs, drawn from this
 * closed vocabulary:
 *
 *   own row          — this issue's own fields (wire + projection, joined by id).
 *   one hop          — a single `belongsTo`/edge target's own fields, through a
 *                      relation declared in `schema.ts` (`issue.repo`,
 *                      `issue.discoveredFrom`). Never a collection.
 *   own sessions     — this issue's members as the graph holds them —
 *                      `issue.sessions` (R2) first, then `session.worktree`
 *                      containment (R3) for sessions with no `issueId` —
 *                      passed through `isRowSeat` (no archived, no shell).
 *                      Archived sessions ARE graph members; see `isRowSeat`.
 *   children's roll-ups — each formal child's (R1, `issue.children`) already
 *                      derived subtree roll-up. A parent composes from its
 *                      children's results; it never walks its own subtree, so a
 *                      change costs the ancestor chain, not the subtree.
 *   coarseNow        — the local clock (`SliceLocals.coarseNow`, 60 s cadence).
 *                      Never `Date.now()`.
 *   selection        — the local `SliceLocals.selectedIssueId` (+ fold latch).
 *                      Never stored data.
 *
 * WHAT IS OUT. Arrays of sessions or children, entity objects, and the store.
 * Those are the store's, not the row's. A field that needs a new input kind
 * is a contract change for the coordinator, not a local widening.
 *
 * MAPPING TO ROUND TWO. `SliceRow` (`slice-types.ts`) stays the parity oracle's
 * projection type and is not modified. `RowView` extends `Readonly<SliceRow>`
 * (so the compiler holds the two in step) and adds: `selected` (brief), the
 * placement inputs `rankOf`/`groupKeyOf` need, and the three render inputs the
 * slice spec §4 Row contract names but `SliceRow` omits. `sliceRowOf` is the
 * projection back.
 *
 * OWNERSHIP. Additive, owned by round three (POD-4545), like `schema.ts`.
 * This file does not implement a roll-up: each substrate derives these fields
 * over its own pool-and-graph in the worklist phase (Ma-b / Ha-b). What is
 * frozen here is the shape, the per-field rule, and the local-only functions.
 */

import type { SliceLocals, SlicePhase, SliceRow, SliceSession } from './slice-types'

/**
 * The spin-off origin a row shows as one quiet ⤷ tick (spec §3 R-ORIGIN,
 * `legacyOriginTick`, `UnifiedIssueRow.tsx:450-460`). A flat copy of the
 * origin's own fields, not a handle: the row cannot navigate from it.
 */
export interface RowOriginTick {
  readonly id: string
  readonly seq: number
  /** The origin's display title (same rule as `RowView.title`). */
  readonly title: string
  /** The origin's `displayRef` (same rule as `RowView.displayRef`). */
  readonly ref: string
}

/**
 * One rendered worklist row. Built by the substrate, handed to exactly one row
 * component, never mutated by it. Every field is a scalar or `RowOriginTick`.
 */
export interface RowView extends Readonly<SliceRow> {
  // ---------------------------------------------------------------------------
  // Rendered fields named by the brief (the oracle's SliceRow + selected)
  // ---------------------------------------------------------------------------

  /** The issue id; the row's identity and React key. Inputs: own row. */
  readonly id: string

  /**
   * `${prefix}-${seq}`, or `#${seq}` when the repo has no prefix
   * (spec R-SUM, `issueDisplayRef`, `replica/issue-views.ts:233-236`).
   * Inputs: own row (`seq`); one hop (`issue.repo.prefix` — round three reads
   * the repo, not a denormalised `issue.prefix`, schema doc §2).
   */
  readonly displayRef: string

  /**
   * The display title, never the raw title of a draft (spec R-SUM,
   * `issueDisplayTitle`, `slices/issues.ts:236`). Inputs: own row.
   */
  readonly title: string

  /**
   * Motion phase over the formal subtree: `waiting` if anything in it waits on
   * the human, else `working` if any session in it computes, else `done` if its
   * sessions are all finished runs, else `queued` — waiting dominates (spec
   * R-SUM, `rowMotionPhase`, `row-attention.ts:45-78`; see the §3.9 erratum).
   * Inputs: own sessions; children's roll-ups.
   */
  readonly phase: SlicePhase

  /**
   * Done units of the formal child-task rollup: units are the accepted formal
   * members (proposed, abandoned and vacated origins excluded); a root with
   * accepted members is not its own unit, a lone root is; classification is
   * exclusive done → blocked → review → run/stall → wait (spec R-SUM / R-ROLL,
   * `missionRollup`, `mission.ts:1329-1404`). Inputs: children's roll-ups; own
   * row (the lone-root case classifies itself).
   */
  readonly progressDone: number

  /** Total units of the same rollup as `progressDone`. Inputs: as `progressDone`. */
  readonly progressTotal: number

  /**
   * Any session in the formal subtree is computing right now — asked apart from
   * `phase` because an ask outranks working there (spec R-SUM,
   * `rowHasWorkingSession`, `row-attention.ts:95-97`). Inputs: own sessions;
   * children's roll-ups.
   */
  readonly working: boolean

  /**
   * The row asks the operator for something: waiting sessions in the subtree
   * (an offer-only session on an already counted review decision counts once)
   * or a pending decision in the subtree, with a `review` decision withdrawn
   * while a session works (spec R-SUM, `row-attention.ts:116-152`).
   * Inputs: own sessions; own row (stage, for its own decision); children's
   * roll-ups.
   */
  readonly asking: boolean

  /**
   * Order band: 0 pinned or returned from defer, 2 snoozed, 1 otherwise
   * (spec R-ORDER step 1, `unifiedRowBand`, `row-order.ts:16-22`;
   * `issueReturnedFromDefer` / `isIssueDeferred`,
   * `model/src/predicates/issue-stage.ts:42-77`). Inputs: own row (`pinned`,
   * `deferUntil`, stage); coarseNow (a defer lapsing is a tick crossing).
   */
  readonly band: 0 | 1 | 2

  /**
   * Project group key, `repoId ?? repoPath`, so one repo on two paths merges
   * (spec R-GROUP step 2, `folds.ts:194-197`). Inputs: own row.
   */
  readonly repoKey: string

  /**
   * In its group's closed fold, computed with NO selection (the oracle's
   * unselected baseline, spec §7). A settled top-level closure — closed
   * top-level, no `needsHuman`, not awaiting merge, zero waiting — folds at
   * once if abandoned, at once if tucked, otherwise after the 24 h finished
   * grace (spec R-GROUP step 3, `rowInClosedFold`, `folds.ts:93-141`).
   * The selection latch is applied by `groupKeyOf`, not here.
   * Inputs: own row (closedAt, closedReason, tuckedAt, needsHuman, parent,
   * stage); own sessions and children's roll-ups (zero waiting); coarseNow
   * (the grace crossing).
   */
  readonly closed: boolean

  /**
   * This row is the selected one: `selection.selectedIssueId === id`.
   * DERIVED FROM THE LOCAL, never stored on any entity (spec R-SEL). A
   * selection change rebuilds exactly two views (the old and new selection)
   * and re-derives nothing else. Inputs: selection.
   */
  readonly selected: boolean

  // ---------------------------------------------------------------------------
  // Rendered fields the slice spec §4 Row contract names but SliceRow omits.
  // Without them the first faithful row would need a store handle.
  // ---------------------------------------------------------------------------

  /**
   * The spin-off origin, or null. From the one outgoing `discovered-from` edge
   * (spec R-ORIGIN; schema relation `issue.discoveredFrom`). When the origin's
   * title, seq or prefix changes, the substrate reaches this row through the
   * declared inverse `spinOffs`, never a scan. Inputs: one hop.
   */
  readonly originTick: RowOriginTick | null

  /**
   * Recency anchor, epoch ms: max `lastActiveAt` of own sessions, else own
   * `updatedAt`, else 0 (spec R-BAND, `rows.ts:108-117`). The stamp is a pure
   * function of (`activityAt`, coarseNow) in buckets just now / Nm / Nh / Nd
   * (`relativeTime`, `focus.ts:194-204`). Display only: never sorts.
   * Inputs: own sessions; own row.
   */
  readonly activityAt: number

  /**
   * Epoch ms of the earliest working-phase change among own working sessions
   * (`agentState.since`, falling back to `lastActiveAt`), or null when none
   * works (spec R-BAND, `workingSinceMs`, `time-indicators.tsx:34-43`). The
   * ticking elapsed display is the row's own component-local timer over this
   * fact. Inputs: own sessions.
   */
  readonly workingSince: number | null

  // ---------------------------------------------------------------------------
  // Placement inputs: read by rankOf / groupKeyOf, not rendered. R-ORDER's
  // tie-breaks and R-GROUP's pinned move are not functions of the fields above
  // (band 0 conflates pinned with returned-from-defer), and locals do not
  // carry them, so a pure placement function needs them on the view.
  // ---------------------------------------------------------------------------

  /** Pinned rows move (not copy) into the PINNED section (spec R-GROUP step 1). Inputs: own row. */
  readonly pinned: boolean

  /**
   * Persisted manual key, meaningful only against siblings; null when unkeyed
   * (spec R-ORDER step 2, `compareManualOrder`, `row-order.ts:49-58`).
   * Inputs: own row.
   */
  readonly sortKey: string | null

  /** Immutable creation stamp, ISO; creation order is newest first (spec R-ORDER step 3). Inputs: own row. */
  readonly createdAt: string

  /** Immutable creation sequence; second creation tie-break, newest first (spec R-ORDER step 3). Inputs: own row. */
  readonly seq: number

  /**
   * Closed-fold sort stamp, ISO: `tuckedAt ?? closedAt ?? updatedAt`, newest
   * first (spec R-GROUP step 3, `issueClosedFoldAt`, `folds.ts:82-86`).
   * Inputs: own row.
   */
  readonly foldAt: string

  /**
   * `closed` is the operator's own act — an abandoned outcome or an explicit
   * tuck — so the selection latch never holds the row open (`rowInClosedFold`,
   * `folds.ts:118-141`: both return before the latch is consulted). False when
   * the row is open or folded only by the grace window. Inputs: own row.
   */
  readonly dismissed: boolean

  // ---------------------------------------------------------------------------
  // Residency (POD-4567, schema doc §5)
  // ---------------------------------------------------------------------------

  /**
   * Present (and `true`) only while an input this row reads through a LAZY
   * relation (Rule L: an origin, a member session, and from Mb3 a child) is
   * known to the pool but not resident yet: its load is under way, and the
   * fields derived from it (`originTick`, `activityAt`, a draft's `title`,
   * the roll-ups) are provisional. A row renders that as loading, never as
   * data. Absent in every pool that holds everything (the oracle, the
   * reference arm, round two). Not an oracle field: `sliceRowOf` drops it.
   * Inputs: residency of the lazy relations' targets.
   */
   readonly loading?: true
}

/**
 * POD-4714 — every field of `RowView`, in declaration order. Gates derive
 * their oracle-compared set from this (minus their explicit exemption list),
 * so a new contract field is compared by default: adding it to `RowView`
 * without listing it here fails typecheck below, and listing it here without
 * a gate comparing it (or exempting it with a reason) fails that gate's
 * exhaustiveness test.
 */
export const ROW_VIEW_FIELDS = [
  'id',
  'displayRef',
  'title',
  'phase',
  'progressDone',
  'progressTotal',
  'working',
  'asking',
  'band',
  'repoKey',
  'closed',
  'selected',
  'originTick',
  'activityAt',
  'workingSince',
  'pinned',
  'sortKey',
  'createdAt',
  'seq',
  'foldAt',
  'dismissed',
  'loading',
] as const satisfies readonly (keyof RowView)[]

export type RowViewField = (typeof ROW_VIEW_FIELDS)[number]

// Adding a field to RowView without listing it above fails typecheck here.
type _RowViewFieldsExhaustive = Exclude<keyof RowView, RowViewField> extends never ? true : never
const _rowViewFieldsExhaustive: _RowViewFieldsExhaustive = true
type _RowViewFieldsNoExtras = Exclude<RowViewField, keyof RowView> extends never ? true : never
const _rowViewFieldsNoExtras: _RowViewFieldsNoExtras = true

// -----------------------------------------------------------------------------
// Seats: which graph members count toward a row (read side)
// -----------------------------------------------------------------------------

/**
 * Whether a member session counts toward its row's "own sessions".
 *
 * ARCHIVED SESSIONS ARE IN THE GRAPH; ROWS FILTER THEM HERE. Coordinator
 * ruling (2026-09-22) on L1a's open question 1. The slice spec lists
 * `session.archived` as "R2/R3 (excluded)" (`pod-4441-round-two-slice.md`
 * §1), while the hand arm keeps archived sessions in both relations and
 * filters at read (`arms/hand/indexes.ts:52-55`, filter at `:348`). Both are
 * right about different things: the spec states the visible outcome, the arm
 * has the right shape. Membership depending on a mutable flag would turn
 * every archive toggle into a detach/re-attach — a second maintenance path for
 * one edge — and the unread rollup (`issue.unread`) must still see archived
 * seats (explicit members minus shells, archived included). So `schema.ts`
 * filters only `headless`, and each view applies its own seat rule.
 *
 * Not here: the time decay of finished runs (`sessionRetainsWorklistRow`'s
 * grace and unread windows, `visibility.ts:44-70`) — an R-VIS rule over
 * coarseNow applied on top of this — and headless, which the graph already
 * drops.
 */
export function isRowSeat(session: Pick<SliceSession, 'archived' | 'agentKind'>): boolean {
  return session.archived !== true && session.agentKind !== 'shell'
}

/**
 * Whether a member session can name a draft: the legacy's `draftIssueLabel`
 * takes `sessionsForIssueNav(...)[0]`, which leaves out shells, archived and
 * headless sessions (client-core `session-ownership.ts:282-310`). POD-4572:
 * taking the first member of any kind named three 4x drafts after a shell
 * (`i10142` "New Shell session" against the oracle's "New Codex session");
 * at 1x no draft's first member is a shell, so parity there could not see
 * it. Both pools filter their sorted member list through this; the rule
 * lives here once (round-three trap: one arm-local copy each).
 */
export function isDraftNameSession(
  session: Pick<SliceSession, 'archived' | 'agentKind' | 'headless'> | undefined,
): boolean {
  return (
    session !== undefined &&
    session.archived !== true &&
    session.agentKind !== 'shell' &&
    session.headless !== true
  )
}

/**
 * POD-4756 — a row as ONE plain `RowView`: every field of `row`, read once,
 * copied (`loading` only when set, as a view spells it). A pool whose row is
 * a live object (the MobX arm's issue, which implements `RowView` and is read
 * field by field by its row component) projects through this where a plain
 * view is compared (the gate against its rebuild, tests); a plain view comes
 * back equal to itself.
 */
export function plainRowView(row: RowView): RowView {
  const view: Record<string, unknown> = {}
  for (const field of ROW_VIEW_FIELDS) {
    const value = row[field]
    if (field === 'loading' && value !== true) continue
    view[field] = value
  }
  return view as unknown as RowView
}

/** The oracle projection of a view: exactly the `SliceRow` fields (spec §7). */
export function sliceRowOf(view: RowView): SliceRow {
  return {
    id: view.id,
    displayRef: view.displayRef,
    title: view.title,
    phase: view.phase,
    progressDone: view.progressDone,
    progressTotal: view.progressTotal,
    working: view.working,
    asking: view.asking,
    band: view.band,
    repoKey: view.repoKey,
    closed: view.closed,
  }
}

// -----------------------------------------------------------------------------
// Ordering (spec R-ORDER, and R-GROUP step 3 for the closed fold)
// -----------------------------------------------------------------------------

/**
 * The ordering key of one row, in comparison order. `compareRank` gives the
 * open-lane and pinned-section order; `compareClosedFold` the fold's order.
 */
export interface RowRank {
  readonly band: 0 | 1 | 2
  /** 0 keyed, 1 unkeyed: a keyed row sorts before any unkeyed row. */
  readonly unkeyed: 0 | 1
  /** '' when unkeyed. Compared ascending. */
  readonly sortKey: string
  /** Epoch ms (unparseable → 0, as legacy). Compared descending. */
  readonly createdMs: number
  /** Compared descending. */
  readonly seq: number
  /** Compared ascending. */
  readonly id: string
}

/**
 * The ordering key: a pure function of the view. It reads no locals — order is
 * stable while agents work and never moves with activity, urgency or
 * `updatedAt` (`row-order.ts:60-64`, issue #64). Time enters only through
 * `band`, which the substrate already re-derived on the tick.
 */
export function rankOf(row: RowView): RowRank {
  return {
    band: row.band,
    unkeyed: row.sortKey ? 0 : 1,
    sortKey: row.sortKey ?? '',
    createdMs: Date.parse(row.createdAt) || 0,
    seq: row.seq,
    id: row.id,
  }
}

/**
 * Total order: band ascending; then manual key ascending with keyed before
 * unkeyed; then creation newest first — `createdAt` desc, `seq` desc, `id` asc
 * (spec R-ORDER, `sortUnifiedWorkRows` / `compareManualOrder` /
 * `compareCreationDesc`, `row-order.ts:29-71`). Keys compare by code unit, as
 * legacy's `<` does.
 */
export function compareRank(a: RowRank, b: RowRank): number {
  if (a.band !== b.band) return a.band - b.band
  if (a.unkeyed !== b.unkeyed) return a.unkeyed - b.unkeyed
  if (a.sortKey !== b.sortKey) return a.sortKey < b.sortKey ? -1 : 1
  if (a.createdMs !== b.createdMs) return b.createdMs - a.createdMs
  if (a.seq !== b.seq) return b.seq - a.seq
  return a.id.localeCompare(b.id)
}

/** `compareRank` over views; for `Array.prototype.sort`. */
export function compareRows(a: RowView, b: RowView): number {
  return compareRank(rankOf(a), rankOf(b))
}

/**
 * Closed-fold order: newest `foldAt` first; ties keep the open order (legacy
 * sorts the fold stably over already R-ORDERed rows, `folds.ts:214-220`).
 */
export function compareClosedFold(a: RowView, b: RowView): number {
  const d = (Date.parse(b.foldAt) || 0) - (Date.parse(a.foldAt) || 0)
  return d !== 0 ? d : compareRows(a, b)
}

// -----------------------------------------------------------------------------
// Grouping (spec R-GROUP)
// -----------------------------------------------------------------------------

/**
 * Where a row is placed. The PINNED section is flat — `SliceOrder.pinnedIds`
 * has no fold — so a pinned row is pinned whatever its `closed` verdict,
 * matching legacy, which splits pinned rows out before grouping
 * (`splitPinnedWork`, `folds.ts:35-43`). Snoozed rows (band 2) sit in their
 * group's open lane (spec R-GROUP step 4). Groups appear in the rank order of
 * their first member, open or closed (legacy creates a group on first
 * encounter, `groupUnifiedWorkRows`, `folds.ts:185-222`).
 */
export type RowPlacement =
  | { readonly section: 'pinned' }
  | { readonly section: 'group'; readonly repoKey: string; readonly lane: 'open' | 'closed' }

/**
 * The grouping key: a pure function of the view plus locals. The only local it
 * reads is the fold latch (spec R-GROUP step 5, `closedFoldEligible`,
 * `folds.ts:106-116`): the selected row keeps the lane it was clicked in, so a
 * row the grace window folded while selected stays open until focus moves —
 * unless the fold is the operator's own dismissal. Selection itself arrives as
 * `row.selected`; the rest of `locals` is ignored by design.
 */
export function groupKeyOf(
  row: RowView,
  locals: Pick<SliceLocals, 'selectedIssueWasFolded'>,
): RowPlacement {
  if (row.pinned) return { section: 'pinned' }
  const latchedOpen = row.selected && locals.selectedIssueWasFolded !== true && !row.dismissed
  const lane = row.closed && !latchedOpen ? 'closed' : 'open'
  return { section: 'group', repoKey: row.repoKey, lane }
}

/**
 * CROSS-BOUNDARY ISSUE EDGES ON THE DETAIL PAGE (POD-646).
 *
 * Every place the issue page points at ANOTHER issue — parent, superseded-by,
 * duplicate-of, and each dependency relation — is an edge into a world this
 * principal may only partially see (docs/multi-user-readiness.md §3.1.2). Before
 * this module those were all `issues.find(i => i.id === id)` or a `Map.get`, and
 * a lookup that misses cannot say WHY: invisible, deleted and not-yet-arrived
 * come back as one `undefined`, and the page rendered all three as a dead label.
 * That is the "not-visible rendered as removed" defect the whole `ReferentState`
 * type exists to prevent.
 *
 * -------------------------------------------------------------------------
 * THE POLICY IS DECLARED HERE, ONCE, AND IT IS A PRODUCT DECISION.
 * -------------------------------------------------------------------------
 *
 * §3.1.2 deliberately leaves open whether an edge to an invisible issue is
 * HIDDEN or shown as an OPAQUE reference, and the issues slice's
 * `resolveIssueEdge` takes the policy as a REQUIRED argument so no caller can
 * acquire one by omission. {@link CROSS_BOUNDARY_POLICY} is this surface's
 * single call site for that argument — changing product policy is an edit to one
 * constant, and the shipped choice is recorded in
 * `docs/agents/pod-330-slice-ownership-map.md` §7 rather than buried here.
 *
 * -------------------------------------------------------------------------
 * `exitOf` COMES FROM THE REPLICA NOW (POD-1510), AND IS STILL OVERRIDABLE.
 * -------------------------------------------------------------------------
 *
 * Distinguishing `not-visible` from `removed` needs the replica's exit record.
 * POD-646 shipped this module with the lookup injectable and NOTHING supplying
 * it, because the client-core `Replica` contract did not expose one — so the
 * policy above was a decision that could not take effect: every absent referent
 * resolved `pending` and `not-visible` was unreachable outside a test.
 *
 * The contract now declares `exitKind?(entity, entityId)` and the kernel-backed
 * facade answers it off the kernel Replica's own exit record, so the DEFAULT
 * lookup here is the live one — see {@link useIssueEdgeResolver}. The context
 * survives as an OVERRIDE rather than as the only source, which is what keeps
 * the four states drivable from a test without a sync kernel.
 *
 * The default is the fallback, not a mount, on purpose: `useIssueEdgeResolver`
 * has four call sites on this page and more will follow, and a provider that
 * each new surface has to remember to sit under fails SILENTLY back to
 * `pending` — the same invisible defect, reintroduced one component at a time.
 *
 * WHAT THAT MEANS FOR `pending`, and why it is not a spinner. `pending` now
 * means what it says — no exit record YET — but it is still reachable
 * permanently: the legacy TanStack replica implements no `exitKind` at all (see
 * its note), and a referent may simply never have been held. `pending` is the
 * one state a spinner is CORRECT for in the general case — but a reference that
 * will never resolve because nothing can tell us it left would spin forever,
 * which §3.1's rule 2 forbids outright. So `pending` renders as the bare id in
 * muted, non-interactive text: exactly what this page rendered before the port,
 * which is also the single-user parity guard.
 */
import type { CrossBoundaryPolicy, IssueEdge } from '@podium/client-core/viewmodels'
import { type ReferentExit, resolveIssueEdge } from '@podium/client-core/viewmodels'
import type { IssueId, IssueWire } from '@podium/model'
import { createContext, type JSX, type ReactNode, useContext, useMemo } from 'react'
import { type IssueViewModel, useReplicaIssues, useStoreSelector } from '@/app/store'
import { issueRefLong } from '../issue-card'

/**
 * THE SHIPPED CHOICE: an invisible issue is shown as an OPAQUE reference.
 *
 * §3.1.2's own framing is that hiding the edge makes the tracker LIE about why
 * something is blocked, and that an opaque reference is honest about the
 * existence of work you cannot see, at the cost of leaking that it exists. On a
 * DETAIL page the first cost is the higher one: "blocked by" with nothing under
 * it reads as a bug in the tracker, and a user who cannot see why their issue is
 * blocked cannot ask the right person for access.
 *
 * Agreed with POD-406 (IssuesView), which owns the same choice for the board, so
 * the two surfaces cannot disagree — see the ledger entry.
 */
export const CROSS_BOUNDARY_POLICY: CrossBoundaryPolicy = 'opaque'

/** How this surface learns that an absent referent EXITED, and how. `undefined`
 *  means "no exit record" — never "still here" and never "deleted". */
export type IssueExitLookup = (id: string) => ReferentExit | undefined

/** No provider mounted. Distinct from a provider that supplies a lookup which
 *  happens to answer `undefined`: the first falls back to the replica, the
 *  second is a test deliberately saying "this world records no exits". */
const IssueExitContext = createContext<IssueExitLookup | undefined>(undefined)

/** OVERRIDE the exit lookup for a subtree. Without one the resolver reads the
 *  replica (POD-1510); this is how a test drives all four states without a sync
 *  kernel, and how a surface could opt into a narrower world. */
export function IssueExitProvider({
  exitOf,
  children,
}: {
  exitOf: IssueExitLookup
  children: ReactNode
}): JSX.Element {
  return <IssueExitContext.Provider value={exitOf}>{children}</IssueExitContext.Provider>
}

/**
 * The replica's exit record, as this page's id-only lookup.
 *
 * `'issue'` is the AUTHORITY's singular entity name, which is what `exitKind`
 * keys on — not the `'issues'` collection kind. The two vocabularies are mapped
 * in `client-core`'s `replica/kernel/kinds.ts`, and passing the plural here
 * would answer `undefined` forever: a wiring that looks done and restores
 * nothing, which is the failure mode this whole module is about.
 *
 * `exitKind` is OPTIONAL on the contract, so the call is optional too — a
 * replica that keeps no exit record (the legacy TanStack one) answers
 * `undefined` and every edge stays `pending`, exactly as before this wiring.
 */
function useReplicaExitLookup(): IssueExitLookup {
  const replica = useStoreSelector((s) => s.replica)
  return useMemo(() => (id: string) => replica?.exitKind?.('issue', id), [replica])
}

/** Resolve any issue-to-issue reference against the partial world this replica
 *  holds. One resolver per render, closed over the issue rows and the exit
 *  lookup, so a section resolving five edges does one index build. */
export function useIssueEdgeResolver(): (id: string | undefined | null) => IssueEdge {
  const issues = useReplicaIssues()
  const override = useContext(IssueExitContext)
  const fromReplica = useReplicaExitLookup()
  const exitOf = override ?? fromReplica
  return useMemo(() => {
    const byId = new Map(issues.map((i) => [i.id as string, i]))
    // The slice is typed over `IssueWire`; `IssueViewModel` is a superset of it
    // (plus projection-only and rollup fields), so the lookup widens rather than
    // rebuilding a second index in the wire's shape.
    const lookup = (id: string): IssueWire | undefined => byId.get(id) as IssueWire | undefined
    return (id) => resolveIssueEdge(id, lookup, CROSS_BOUNDARY_POLICY, exitOf)
  }, [issues, exitOf])
}

/** The resolved issue behind a `render: 'issue'` edge, in the page's own model
 *  type. `undefined` for every other render shape — an opaque edge is
 *  ANONYMOUS by construction (the slice never sets `value` on one). */
export function edgeIssue(edge: IssueEdge): IssueViewModel | undefined {
  return edge.render === 'issue' ? (edge.resolution.value as IssueViewModel | undefined) : undefined
}

/** The copy an opaque edge renders. Deliberately identity-free: no ref, no
 *  title, no stage — publishing an id the principal cannot resolve is the leak
 *  the policy question is about. */
export const OPAQUE_EDGE_LABEL = 'an issue you do not have access to'

/**
 * One issue reference, rendered honestly for whichever of the four states it is
 * in.
 *
 *  - `issue`   — the long ref, clickable, exactly as before the port.
 *  - `opaque`  — anonymous prose, NOT interactive. There is nothing to navigate
 *                to, and a dead-looking button is worse than a sentence.
 *  - `pending` — the bare id, muted and inert (see the module note: never a
 *                spinner). This is the shape single-user parity lands on.
 *  - `hidden`  — nothing at all. A genuinely deleted target has no edge to draw,
 *                and so does an invisible one under a `hidden` policy.
 */
export function IssueEdgeLink({
  edge,
  onNavigate,
  fallbackId,
}: {
  edge: IssueEdge
  onNavigate: (id: IssueId) => void
  /** Shown while `pending` — the id we were pointed at. */
  fallbackId?: string
}): JSX.Element | null {
  const target = edgeIssue(edge)
  if (edge.render === 'hidden') return null
  if (edge.render === 'opaque') {
    return (
      <span className="text-muted-foreground italic" data-testid="issue-edge-opaque">
        {OPAQUE_EDGE_LABEL}
      </span>
    )
  }
  if (!target) {
    // STILL THE BARE ID (see the module note) — but it TRUNCATES now (POD-591).
    // An `iss_…` id is 40 characters and this renders inside a 272px rail, so
    // rendered whole it ran off the edge with no ellipsis: the row said nothing
    // AND hid its own boundary. `min-w-0` + `truncate` keeps the leading
    // segment, which is what an operator matches by eye, and `title` keeps the
    // whole value for a copy. Single-user parity is unchanged — the id is still
    // what is shown, still muted, still inert.
    return (
      <span
        className="block min-w-0 truncate text-muted-foreground"
        data-testid="issue-edge-pending"
        title={fallbackId}
      >
        {fallbackId ?? '—'}
      </span>
    )
  }
  // NEUTRAL, NOT YELLOW (POD-635). Every edge on this page — relations,
  // spin-offs, the parent row, the superseded banner — rendered in Superade
  // Yellow, so a task with six spin-offs put six of the brightest pixels the
  // theme owns in one column, none of them asking the operator for anything.
  // The Signal Rule spends yellow on the primary action or the thing waiting on
  // you; a cross-reference is neither. The row's hover wash and this underline
  // carry the affordance, and the stage glyph beside it carries the state.
  return (
    <button
      data-pressable
      type="button"
      className="block min-w-0 truncate text-left font-medium text-foreground/90 hover:text-foreground hover:underline"
      onClick={() => onNavigate(target.id)}
      title={target.id}
    >
      {issueRefLong(target)}
    </button>
  )
}

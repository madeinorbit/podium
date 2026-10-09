import type { IssueViewModel } from '@podium/client-core/replica'
/**
 * Pure resolution + state for the floating ref miniview (#474, area 7).
 *
 * A ref link (from markdown linkify or the terminal link provider) carries a
 * `data-ref` token like `POD-13`, `POD-13-A`, or `POD-DRAFT-3`. This module
 * names the resolved target's shape and owns the tiny open/close reducer for
 * the single-instance miniview. The card reads everything else about the
 * target from the shared issue and session models.
 *
 * Kept dependency-free (besides the shared ref grammar) so it is unit-testable
 * without React or the store.
 */

import type {
  IssuePanelArtifact,
  IssuePanelTodo,
  SessionId,
  IssueId,
} from '@podium/model/browser'
import type { AnyRef } from '@podium/protocol'

/**
 * The issue shape the resolver needs and the miniview card renders — COMPOSED
 * from `IssueViewModel` rather than restated (POD-367; POD-364's inventory #12 called
 * this the largest client-side restatement in the repo, 22 keys).
 *
 * Identity is required; the at-a-glance fields stay optional, which is the one
 * thing this projection legitimately changes about them — a lean fixture or a
 * legacy row must still fit. That is `Partial<Pick<…>>`, so the optionality is
 * declared once here instead of field by field, and every field's TYPE now comes
 * from the aggregate: when `IssueViewModel.stage` gains a stage or `id` gains a brand,
 * this shape follows instead of drifting.
 */
export type RefIssueLike = Pick<IssueViewModel, 'id' | 'seq' | 'title'> &
  Partial<
    Pick<
      IssueViewModel,
      | 'prefix'
      | 'displayRef'
      | 'stage'
      | 'priority'
      | 'assignee'
      | 'ready'
      | 'blocked'
      | 'blockedByNotes'
      | 'childCount'
      | 'childDoneCount'
      | 'parentId'
      | 'description'
      | 'activityNotes'
      | 'notesUpdatedAt'
      | 'updatedAt'
      // Membership, for the card's "Go to session" action: the designated
      // coordinator wins over the merely-most-recent member.
      | 'coordinatorSessionId'
      // Startability fields for the card's "Run now" action (POD-110) — the same
      // structural subset `isIssueStartable` reads off IssueViewModel.
      | 'worktreePath'
      | 'defaultAgent'
      | 'defaultModel'
      | 'defaultEffort'
      | 'machineId'
      | 'repoPath'
      | 'closedReason'
      | 'archived'
      | 'deletedAt'
    >
  > & {
    /**
     * The card renders a genuinely NARROWER panel than the wire carries — two of
     * the three groups, and only two members of an artifact. That narrowing is
     * legitimate (ADR 4: a projection reads what it renders), so it stays; what
     * does not stay is restating `{ text, done }` and `{ path, title }` by hand.
     * The member types come from the panel group itself.
     */
    panel?: {
      todos?: readonly IssuePanelTodo[]
      artifacts?: readonly Pick<IssuePanelArtifact, 'path' | 'title'>[]
    }
  }

/** The minimal session shape the resolver needs (a structural subset of SessionMeta). */
export interface RefSessionLike {
  sessionId: SessionId
  displayRef?: string
  cwd: string
  issueId?: IssueId
  title?: string
  name?: string
  /** Liveness + recency. All optional: a lean fixture or a legacy row still
   *  resolves. */
  archived?: boolean
  status?: string
  lastActiveAt?: string
  agentKind?: string
}

export type ResolvedRef =
  | { kind: 'issue'; ref: AnyRef; issue: RefIssueLike }
  | { kind: 'session'; ref: AnyRef; session: RefSessionLike }

// ---------------------------------------------------------------------------
// Open/close reducer — single miniview at a time (opening one replaces it).
// ---------------------------------------------------------------------------

/** Viewport point (clientX/clientY) of the click that opened the miniview. */
export interface MiniviewAnchor {
  x: number
  y: number
}

/**
 * The miniview state: the ref currently shown, or null when closed. `anchor` is
 * where the activating click landed (absent for non-pointer activations — the
 * card then falls back to a fixed seed). `seq` increments on every open so the
 * card re-seeds its position per activation, even for the same ref.
 */
export type MiniviewState = { ref: string; anchor?: MiniviewAnchor; seq: number } | null

export type MiniviewAction =
  | { type: 'open'; ref: string; anchor?: MiniviewAnchor }
  | { type: 'close' }

export function miniviewReducer(state: MiniviewState, action: MiniviewAction): MiniviewState {
  switch (action.type) {
    case 'open':
      // Only one at a time — opening always replaces whatever was open.
      return { ref: action.ref, anchor: action.anchor, seq: (state?.seq ?? 0) + 1 }
    case 'close':
      return null
  }
}

// ---------------------------------------------------------------------------
// Known-prefix derivation (drives markdown + terminal linkify activation).
// ---------------------------------------------------------------------------

/**
 * The set of registered repo prefixes across any prefix-bearing rows (#474).
 * The canonical source is `repos.listDetailed` (a repo with zero issues must
 * still linkify); issue rows are unioned in as a cheap freshness fallback —
 * pass both lists concatenated.
 */
export function collectRefPrefixes(
  ...rowLists: readonly (readonly { prefix?: string | null }[])[]
): Set<string> {
  const out = new Set<string>()
  for (const rows of rowLists) for (const r of rows) if (r.prefix) out.add(r.prefix)
  return out
}

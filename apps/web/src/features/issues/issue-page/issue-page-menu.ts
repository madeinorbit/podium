/**
 * THE ISSUE PAGE'S OVERFLOW MENU, AS DATA (POD-646).
 *
 * Before this module the header's `…` menu was a JSX tree with its gating
 * inlined as nine ad-hoc conditions (`!issue.deletedAt && …`), which is the
 * shape that makes a menu and a command palette drift: two renderers, two copies
 * of the rules, and the palette quietly offering what the menu hides. The entries
 * are now DATA — label, icon, danger, and one `enabled` predicate each — so any
 * renderer that can walk this list offers exactly the same set.
 *
 * -------------------------------------------------------------------------
 * THE RIGHTS PREDICATE IS SHARED, NOT RE-STATED.
 * -------------------------------------------------------------------------
 *
 * §1 of POD-331's contract requires the menu and the palette to evaluate the
 * SAME predicate over the SAME config, so the palette cannot become the bypass.
 * The predicate here is `issueMenuEligibility` from `../issue-context-menu.ts` —
 * the one the board and sidebar context menus already evaluate — rather than a
 * second copy written for this surface. Where this page offers something those
 * menus do not (copy branch, open in Linear, supersede/duplicate targets), the
 * gate is DATA PRESENCE, which is not a right and is stated as such below.
 *
 * This is UX gating only. ADR 3 D8 has the Authority re-authorize at apply, so a
 * denied write rolls the optimistic overlay back and surfaces — the page's toast
 * runner is what renders that. An entry being enabled here is a claim about what
 * is worth OFFERING, never a claim that the write will succeed.
 *
 * OWNERSHIP NOTE. POD-406 owns the declarative menu/dialog config pattern that
 * this surface, POD-409 and POD-647 share, and it had not started when this
 * landed. So this module deliberately holds only the ISSUE-PAGE entry list and
 * takes its gating from the ALREADY-SHARED predicate; whichever of the two lands
 * second folds this list into POD-406's config rather than either of us keeping
 * a private copy of the rules. Nothing here re-implements eligibility, which is
 * the part that would actually diverge.
 */
import type { LucideIcon } from 'lucide-react'
import {
  Archive,
  ArchiveRestore,
  ExternalLink,
  Flag,
  GitBranch,
  Pin,
  PinOff,
  Trash2,
} from 'lucide-react'
import type { IssueViewModel } from '@/app/store'
import { issueMenuEligibility } from '../issue-context-menu'

/** Every action the issue page's overflow menu can offer. */
export type IssuePageMenuAction =
  | 'copy-branch'
  | 'open-linear'
  | 'toggle-pin'
  | 'toggle-archive'
  | 'flag-human'
  | 'supersede'
  | 'duplicate'
  | 'delete'
  | 'restore'

/** What an entry's predicate may read: the issue, and whether this page has any
 *  sibling issue to point a supersede/duplicate at. */
export interface IssueMenuContext {
  readonly issue: IssueViewModel
  /** Repo-mates, from the page model. A relation needs a target to point at;
   *  with none, the submenu would open onto an empty list. */
  readonly targetCount: number
}

export interface IssuePageMenuEntry {
  readonly id: IssuePageMenuAction
  /** Label for the current issue — pin/unpin and archive/unarchive are one
   *  entry whose verb flips, exactly as they are in the context menu. */
  readonly label: (issue: IssueViewModel) => string
  readonly icon: (issue: IssueViewModel) => LucideIcon
  /** Destructive styling AND the confirm that goes with it. */
  readonly danger?: boolean
  /** Opens a submenu of sibling issues rather than firing directly. */
  readonly submenu?: 'issue-targets'
  /** A separator is drawn BEFORE this entry when it is the first visible entry
   *  of its group. Group boundaries are data too, so a renderer does not have to
   *  know which entries are lifecycle and which are relations. */
  readonly group: 'links' | 'state' | 'relations' | 'lifecycle'
  readonly enabled: (ctx: IssueMenuContext) => boolean
}

/**
 * The entry list, in menu order.
 *
 * Read the `enabled` predicates as a pair of kinds:
 *  - RIGHTS/APPLICABILITY, delegated to `issueMenuEligibility` over a
 *    single-issue selection. Pin, archive, unarchive, delete, restore and
 *    duplicate all resolve there, so this page and the board agree by
 *    construction rather than by review.
 *  - DATA PRESENCE, stated inline: an issue with no branch has no branch name to
 *    copy, and one with no Linear url has nothing to open. Those are not rights
 *    and are not pretending to be.
 */
export const ISSUE_PAGE_MENU: readonly IssuePageMenuEntry[] = [
  {
    id: 'copy-branch',
    group: 'links',
    label: () => 'Copy branch name',
    icon: () => GitBranch,
    // Data presence, not a right.
    enabled: ({ issue }) => Boolean(issue.branch),
  },
  {
    id: 'open-linear',
    group: 'links',
    label: (issue) =>
      issue.linearIdentifier ? `Open in Linear (${issue.linearIdentifier})` : 'Open in Linear',
    icon: () => ExternalLink,
    // Data presence, not a right.
    enabled: ({ issue }) => Boolean(issue.linearUrl),
  },
  {
    id: 'toggle-pin',
    group: 'state',
    label: (issue) => (issue.pinned ? 'Unpin' : 'Pin'),
    icon: (issue) => (issue.pinned ? PinOff : Pin),
    enabled: ({ issue }) => issueMenuEligibility([issue]).canPin,
  },
  {
    id: 'toggle-archive',
    group: 'state',
    label: (issue) => (issue.archived ? 'Unarchive issue' : 'Archive issue'),
    icon: (issue) => (issue.archived ? ArchiveRestore : Archive),
    enabled: ({ issue }) => {
      const rights = issueMenuEligibility([issue])
      return issue.archived ? rights.canUnarchive : rights.canArchive
    },
  },
  {
    id: 'flag-human',
    group: 'state',
    label: () => 'Flag for human…',
    icon: () => Flag,
    // No eligibility member covers flagging; it applies to any live issue, which
    // is what a deleted row is not.
    enabled: ({ issue }) => !issue.deletedAt,
  },
  {
    id: 'supersede',
    group: 'relations',
    label: () => 'Supersede with…',
    icon: () => ArchiveRestore,
    submenu: 'issue-targets',
    // Superseding is the same class of act as marking a duplicate — the shared
    // predicate's `canDuplicate` is the closest thing to a right for it — but it
    // additionally needs somewhere to point.
    enabled: ({ issue, targetCount }) => !issue.deletedAt && targetCount > 0,
  },
  {
    id: 'duplicate',
    group: 'relations',
    label: () => 'Duplicate of…',
    icon: () => ArchiveRestore,
    submenu: 'issue-targets',
    enabled: ({ issue, targetCount }) => !issue.deletedAt && targetCount > 0,
  },
  {
    id: 'restore',
    group: 'lifecycle',
    label: () => 'Restore task',
    icon: () => ArchiveRestore,
    enabled: ({ issue }) => issueMenuEligibility([issue]).canRestore,
  },
  {
    id: 'delete',
    group: 'lifecycle',
    danger: true,
    label: () => 'Delete',
    icon: () => Trash2,
    enabled: ({ issue }) => issueMenuEligibility([issue]).canDelete,
  },
]

/** The entries this issue actually offers, in order. A renderer walks THIS —
 *  and so would a command palette, which is the point of the split. */
export function issuePageMenuEntries(ctx: IssueMenuContext): IssuePageMenuEntry[] {
  return ISSUE_PAGE_MENU.filter((entry) => entry.enabled(ctx))
}

/** Whether a separator precedes `entry` in `visible` — true when it opens a
 *  group that is not the first one shown. Keeps the renderer free of the
 *  grouping rules. */
export function startsGroup(visible: readonly IssuePageMenuEntry[], index: number): boolean {
  if (index === 0) return false
  return visible[index]?.group !== visible[index - 1]?.group
}

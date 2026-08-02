/**
 * THE PARENT ROW — REPARENT IS A PERMISSION-AFFECTING OPERATION (POD-646).
 *
 * docs/multi-user-readiness.md §3.1.5 case 2: an agent's scope is a SUBTREE, and
 * a subtree is a moving set. Reparenting this issue under a different epic
 * therefore widens or narrows what a working agent can see, with nobody having
 * decided it. The doc's judgement is that this is probably acceptable — a
 * subtree is by definition a moving set — but that it is NOT how the affordance
 * reads to its users, and that at minimum it must be SURFACED.
 *
 * -------------------------------------------------------------------------
 * WHAT SHIPPED, AND WHY BOTH HALVES.
 * -------------------------------------------------------------------------
 *
 * 1. SURFACED, ALWAYS. The parent menu carries a standing note that changing the
 *    parent changes which agents can see this issue. It is not a warning and not
 *    a confirm — the operation is legitimate, and a modal on every reparent
 *    would be noise that teaches people to dismiss it.
 *
 * 2. CONFIRMED WHEN THE MOVE CROSSES AN OWNER BOUNDARY. Moving within one
 *    person's tree changes an agent's scope inside work that person already
 *    owns. Moving UNDER A DIFFERENT OWNER's epic hands visibility of this issue
 *    to someone else's agents, which is a different act and one nobody decided.
 *    That gets the confirm.
 *
 * 3. AND IT DOES NOT CONFIRM ON UNKNOWN OWNERS. `owner` is a projection field
 *    that older rows do not carry, and on today's single-user tree it is absent
 *    or identical everywhere. A confirm that fired whenever an owner was unknown
 *    would fire on EVERY reparent right now — which trains the user to click
 *    through it, so that by the time the field is real the dialog has already
 *    stopped being read. Missing data is not a boundary crossing; it is missing
 *    data. {@link crossesOwnerBoundary} is the whole rule, and it is a pure
 *    function precisely so that claim is testable rather than asserted.
 */
import type { IssueEdge } from '@podium/client-core/viewmodels'
import type { IssueId } from '@podium/model'
import { issueDisplayRef } from '@podium/protocol'
import type { JSX } from 'react'
import type { IssueViewModel } from '@/app/store'
import { Button } from '@/components/ui/button'
import { PropertyMenu, type PropertyOption } from '@/lib/PropertyMenu'
import { cn } from '@/lib/utils'
import { edgeIssue, IssueEdgeLink } from './issue-edges'
import { PropertyRow } from './property-chrome'

/** The standing note in the parent menu. Exported so the test asserts the copy
 *  the user actually sees rather than a paraphrase of it. */
export const REPARENT_SCOPE_NOTE =
  'Agents are scoped to a subtree — changing the parent changes which agents can see this issue.'

/**
 * Does moving `issue` under `target` cross an OWNER boundary?
 *
 * True only when both owners are KNOWN and they differ. An unknown owner on
 * either side is not a crossing (see the module note, point 3): the answer is
 * "we cannot tell", and the honest rendering of that is no confirm rather than a
 * confirm that cries wolf on every row of the current tree.
 *
 * Clearing the parent ("No parent") is never a crossing — there is no new owner
 * to hand scope to.
 */
export function crossesOwnerBoundary(
  issue: Pick<IssueViewModel, 'owner'>,
  target: Pick<IssueViewModel, 'owner'> | undefined,
): boolean {
  const mine = issue.owner
  const theirs = target?.owner
  if (!mine || !theirs) return false
  return mine !== theirs
}

/** The confirm copy for a cross-owner move. Exported for the same reason as the
 *  note: the test reads what ships. */
export function crossOwnerConfirmMessage(target: IssueViewModel): string {
  return `Move this issue under ${issueDisplayRef(target)}, which belongs to a different owner? Agents scoped to that subtree will be able to see this issue.`
}

export function IssueParentRow({
  issue,
  parentEdge,
  busy,
  mateOptions,
  matesById,
  onSetParent,
  onNavigate,
}: {
  issue: IssueViewModel
  /** The parent reference, resolved against the partial world — an issue the
   *  principal cannot see renders per the surface's cross-boundary policy
   *  rather than as a missing parent. */
  parentEdge: IssueEdge
  busy: boolean
  mateOptions: PropertyOption[]
  /** Repo-mates by id — the pool the menu offers, used to resolve the chosen
   *  target's owner for the boundary check. */
  matesById: Map<string, IssueViewModel>
  onSetParent: (id: IssueId | null) => void
  onNavigate: (id: IssueId) => void
}): JSX.Element {
  const parent = edgeIssue(parentEdge)
  const hasParentRef = Boolean(issue.parentId) && parentEdge.render !== 'hidden'

  const select = (value: string): void => {
    if (value === '__none__') {
      onSetParent(null)
      return
    }
    const target = matesById.get(value)
    if (target && crossesOwnerBoundary(issue, target)) {
      if (!window.confirm(crossOwnerConfirmMessage(target))) return
    }
    onSetParent(value as IssueId)
  }

  return (
    <PropertyRow label="Parent">
      <div className="flex items-center gap-1">
        {hasParentRef && (
          <span className="min-w-0 flex-1 truncate text-[13px]">
            <IssueEdgeLink
              edge={parentEdge}
              onNavigate={onNavigate}
              fallbackId={issue.parentId ?? undefined}
            />
          </span>
        )}
        <PropertyMenu
          selectedValue={issue.parentId ?? '__none__'}
          options={[{ value: '__none__', label: 'No parent' }, ...mateOptions]}
          placeholder="Set parent…"
          onSelect={select}
          trigger={
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={busy}
              title={REPARENT_SCOPE_NOTE}
              className={cn('h-7 gap-1 px-2 text-[13px]', parent ? '' : 'w-full justify-start')}
            >
              {parent ? 'Change' : <span className="text-muted-foreground">No parent</span>}
            </Button>
          }
        />
      </div>
      <p className="pt-0.5 text-[11px] text-muted-foreground/80" data-testid="reparent-scope-note">
        {REPARENT_SCOPE_NOTE}
      </p>
    </PropertyRow>
  )
}

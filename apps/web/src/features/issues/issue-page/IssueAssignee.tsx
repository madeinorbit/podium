/**
 * THE ASSIGNEE ROW (POD-6295; design §2.2, §4.3).
 *
 * Each task has exactly one accountable human, its Assignee, and any member
 * may reassign it to any active member (D2). The row names the member by
 * display name; the picker lists the instance's active members and is drawn
 * only where the server says the reader may reassign. A task from before
 * members whose old free-text assignee named nobody (`agent:codex`, `me`)
 * keeps that label only as a note under the row: it makes nobody accountable.
 *
 * Reassigning goes through `issues.update`'s `assignee`, which the server
 * turns into a recorded, attributed reassignment. It moves no sessions.
 */
import type { MemberRoster } from '@podium/client-graph/member-roster'
import type { JSX } from 'react'
import type { IssueViewModel } from '@/app/store'
import { memberDisplayName } from '@/lib/member-roster'
import { PropertyMenu } from '@/lib/PropertyMenu'
import { AssigneeAvatar } from '../issue-glyphs'
import { issueObserver as observer } from './issue-observer'
import { PropertyRow, TriggerButton } from './property-chrome'

export const IssueAssignee = observer(function IssueAssignee({
  issue,
  roster,
  mayReassign,
  busy,
  onReassign,
}: {
  issue: IssueViewModel
  roster: Pick<MemberRoster, 'members' | 'nameOf'> | undefined
  /** The server's answer for this reader (`allowed.reassign`). */
  mayReassign: boolean
  busy: boolean
  onReassign: (memberId: string) => void
}): JSX.Element | null {
  const assignee = issue.assignee ?? issue.owner
  const legacy = issue.legacyAssignee
  if (!assignee && !legacy) return null
  const name = memberDisplayName(roster, assignee)
  const members = roster?.members ?? []
  // Reassigning needs someone else to reassign to.
  const picker = mayReassign && members.some((member) => member.id !== assignee)
  const face = (
    <>
      <AssigneeAvatar assignee={assignee} name={name} />
      <span className="min-w-0 truncate">{name}</span>
    </>
  )
  return (
    <PropertyRow label="Assignee">
      {picker ? (
        <PropertyMenu
          selectedValue={assignee}
          placeholder="Reassign to…"
          options={members.map((member) => ({
            value: member.id,
            label: memberDisplayName(roster, member.id),
          }))}
          onSelect={(memberId) => {
            if (memberId !== assignee) onReassign(memberId)
          }}
          trigger={
            <TriggerButton disabled={busy} testId="assignee-trigger" title="Reassign">
              {face}
            </TriggerButton>
          }
        />
      ) : (
        <span
          className="flex h-7 items-center gap-1.5 text-[13px] text-foreground"
          data-testid="assignee-name"
        >
          {face}
        </span>
      )}
      {legacy && (
        <span
          className="block truncate text-[11px] text-text-faint"
          data-testid="assignee-legacy"
          title="The task's assignee before members: a label only, not an accountable person"
        >
          Earlier label: {legacy}
        </span>
      )}
    </PropertyRow>
  )
})

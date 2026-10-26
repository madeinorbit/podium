/**
 * THE TASK'S PARENT BRANCH [POD-2065] — the branch it was cut from and lands on.
 *
 * The rail shows the stored value and edits it in place through
 * `issues.update { parentBranch }`. Only this task changes; nothing retargets
 * its children or siblings, and the repository's base branch stays as it is.
 * The menu is the same body the sidebar and settings use for a repository's
 * base, without the "Podium default" row: a task always has a parent.
 */
import { here } from '@podium/client-graph/lookup'
import { baseBranchChoices, repositoryScanOf } from '@podium/client-graph/repo-base-branch'
import { GitBranch } from 'lucide-react'
import type { JSX } from 'react'
import { useState } from 'react'
import type { IssueViewModel } from '@/app/store'
import { useWorklistPool } from '@/app/store-worklist-pool'
import { DropdownMenu, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { BaseBranchMenuContent } from '@/lib/BaseBranchMenu'
import type { IssuePageCommands } from '../issue-page-commands'
import { issueObserver as observer } from './issue-observer'
import { PropertyRow, TriggerButton } from './property-chrome'

export const IssueParentBranch = observer(function IssueParentBranch({
  issue,
  busy,
  commands,
}: {
  issue: IssueViewModel
  busy: boolean
  commands: IssuePageCommands
}): JSX.Element {
  const [open, setOpen] = useState(false)
  return (
    <PropertyRow label="Base branch">
      <DropdownMenu modal={false} open={open} onOpenChange={setOpen}>
        <DropdownMenuTrigger
          render={
            <TriggerButton
              disabled={busy}
              testId="parent-branch-trigger"
              title="The branch this task was cut from and lands on"
            >
              <GitBranch size={12} aria-hidden="true" className="flex-none text-text-faint" />
              <span className="truncate font-mono text-[12px]">{issue.parentBranch}</span>
            </TriggerButton>
          }
        />
        {open && (
          <ParentBranchChoices issue={issue} commands={commands} onDone={() => setOpen(false)} />
        )}
      </DropdownMenu>
    </PropertyRow>
  )
})

const ParentBranchChoices = observer(function ParentBranchChoices({
  issue,
  commands,
  onDone,
}: {
  issue: IssueViewModel
  commands: IssuePageCommands
  onDone: () => void
}): JSX.Element {
  const pool = useWorklistPool()
  const scan = pool ? repositoryScanOf(pool, issue.repoId, issue.repoPath) : undefined
  const repo = pool && issue.repoId ? here(pool.model('repo', issue.repoId)) : undefined
  const choices = baseBranchChoices(scan, issue.parentBranch)
  const repoBase = repo?.defaultParentBranch
  if (repoBase && !choices.includes(repoBase)) choices.push(repoBase)
  choices.sort((a, b) => a.localeCompare(b))
  return (
    <BaseBranchMenuContent
      heading="Base branch"
      current={issue.parentBranch}
      choices={choices}
      note="Only this task changes. Other tasks keep their base branch."
      onSave={async (branch) => {
        if (branch) commands.update({ parentBranch: branch })
      }}
      onDone={onDone}
    />
  )
})

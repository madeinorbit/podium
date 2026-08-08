/**
 * The Git block of the properties aside: merge / PR / rebase, ordered by the
 * configured merge style, plus the PR link once one exists. Split out of
 * issue-page-properties.tsx (POD-646); behaviour unchanged.
 *
 * The merge style decides which action is PRIMARY, not which are offered — both
 * are always present, because a repo configured for PRs still has to be able to
 * ff-merge and vice versa. 'ff-only' is the safe default primary while the
 * config is loading or unreadable.
 */
import { ExternalLink } from 'lucide-react'
import type { JSX } from 'react'
import type { IssueViewModel } from '@/app/store'
import { GitStamp } from '@/components/GitStamp'
import { Button } from '@/components/ui/button'
import { aheadCount } from '../issue-card'
import type { IssuePageCommands, MergeStyle } from '../issue-page-commands'
import { SectionHeading } from './chrome'

const MERGE_LABEL = 'FF-only merge'

export function IssueGitBlock({
  issue,
  busy,
  commands,
  mergeStyle,
}: {
  issue: IssueViewModel
  busy: boolean
  commands: IssuePageCommands
  mergeStyle: MergeStyle
}): JSX.Element | null {
  if (!issue.worktreePath) return null
  const primaryIsPr = mergeStyle === 'pr'
  // THE SIGNAL RULE, APPLIED (POD-591). The primary action used to be a
  // permanent Superade-Yellow slab in the aside of EVERY task, merged or not,
  // started or not — the loudest pixel on the page, asking for nothing. Yellow
  // is spent only when there is something to land; otherwise both actions are
  // outline and the button still works exactly as before.
  const landable = aheadCount(issue) > 0
  const primaryVariant = landable ? undefined : ('outline' as const)
  return (
    <section className="group/section flex flex-col gap-2">
      <SectionHeading>Branch</SectionHeading>
      {/* The state the page never showed: branch, merge axis, dirty count. It
          was in the sidebar row for this same task and nowhere on its page. */}
      <GitStamp
        issueBranch={issue.branch}
        git={issue.gitState}
        density="panel"
        className="min-w-0"
      />
      <div className="flex flex-wrap gap-1.5">
        {primaryIsPr ? (
          <Button
            type="button"
            variant={primaryVariant}
            size="sm"
            disabled={busy}
            onClick={() => void commands.gitAction('pr')}
          >
            Open PR
          </Button>
        ) : (
          <Button
            type="button"
            variant={primaryVariant}
            size="sm"
            disabled={busy}
            onClick={() => void commands.gitAction('merge')}
          >
            {MERGE_LABEL}
          </Button>
        )}
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={busy}
          onClick={() => void commands.gitAction('rebase')}
        >
          Rebase on {issue.parentBranch}
        </Button>
        {primaryIsPr ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={busy}
            onClick={() => void commands.gitAction('merge')}
          >
            {MERGE_LABEL}
          </Button>
        ) : (
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={busy}
            onClick={() => void commands.gitAction('pr')}
          >
            Open PR
          </Button>
        )}
      </div>
      {issue.prUrl && (
        <a
          href={issue.prUrl}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-1 text-[13px] text-primary hover:underline"
        >
          View PR <ExternalLink size={13} aria-hidden="true" />
        </a>
      )}
    </section>
  )
}

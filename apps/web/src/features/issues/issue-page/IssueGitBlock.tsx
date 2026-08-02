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
import { Button } from '@/components/ui/button'
import type { IssuePageCommands, MergeStyle } from '../issue-page-commands'

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
  return (
    <section className="flex flex-col gap-2">
      <h3 className="font-medium text-[12px] text-muted-foreground">Git</h3>
      <div className="flex flex-wrap gap-2">
        {primaryIsPr ? (
          <Button
            type="button"
            size="sm"
            disabled={busy}
            onClick={() => void commands.gitAction('pr')}
          >
            Open PR
          </Button>
        ) : (
          <Button
            type="button"
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

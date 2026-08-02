/**
 * The stack of banners above the issue title: deleted, superseded/duplicate,
 * a suggested stage move, and needs-human. Split out of IssuePage.tsx (POD-646).
 *
 * CROSS-BOUNDARY EDGES. The superseded-by / duplicate-of banner points at ANOTHER
 * issue, which under the scoped feed (docs/multi-user-readiness.md §3.1.2) may be
 * one this principal cannot see. It resolves that reference through the issues
 * slice's `resolveIssueEdge` rather than a `.find()` over the rows we happen to
 * hold — a `.find()` returns undefined for invisible and deleted alike, and
 * rendering the raw id as a dead label is exactly the "not-visible rendered as
 * removed" defect. See ./issue-edges.ts for the policy.
 */
import type { IssueId } from '@podium/model'
import type { JSX } from 'react'
import { Button } from '@/components/ui/button'
import { ArchiveRestore } from 'lucide-react'
import type { IssueViewModel } from '@/app/store'
import { STAGE_LABELS } from '../issue-card'
import type { IssuePageCommands } from '../issue-page-commands'
import { IssueEdgeLink, useIssueEdgeResolver } from './issue-edges'
import { NeedsHumanBanner } from './NeedsHumanBanner'

export function IssueBanners({
  issue,
  busy,
  commands,
  onBack,
  onNavigate,
}: {
  issue: IssueViewModel
  busy: boolean
  commands: IssuePageCommands
  onBack: () => void
  onNavigate: (id: IssueId) => void
}): JSX.Element {
  return (
    <>
      {issue.deletedAt && (
        <div className="mb-4 flex items-center justify-between gap-3 rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-[13px]">
          <p>
            This issue and its sessions were deleted. Restoring it returns the sessions as exited
            records; their running processes were stopped.
          </p>
          <Button type="button" size="sm" disabled={busy} onClick={() => commands.restoreIssue(onBack)}>
            <ArchiveRestore size={14} aria-hidden="true" /> Restore task
          </Button>
        </div>
      )}
      <LifecycleBanner issue={issue} onNavigate={onNavigate} />
      {issue.suggestedStage && (
        <div className="mb-4 flex flex-col gap-2 rounded-lg border border-primary/40 bg-primary/5 p-3 text-[13px]">
          <p className="text-foreground">
            Move to <b>{STAGE_LABELS[issue.suggestedStage]}</b>?
            {issue.suggestedReason ? ` ${issue.suggestedReason}` : ''}
          </p>
          <div className="flex gap-2">
            <Button type="button" size="sm" disabled={busy} onClick={commands.applySuggestion}>
              Approve
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={busy}
              onClick={commands.dismissSuggestion}
            >
              Dismiss
            </Button>
          </div>
        </div>
      )}
      <NeedsHumanBanner issue={issue} busy={busy} commands={commands} />
    </>
  )
}

/** Superseded-by / duplicate-of banner — the stored relation values were only
 *  settable before; now the current state reads back, with click-through. */
export function LifecycleBanner({
  issue,
  onNavigate,
}: {
  issue: IssueViewModel
  onNavigate: (id: IssueId) => void
}): JSX.Element | null {
  const resolve = useIssueEdgeResolver()
  if (!issue.supersededBy && !issue.duplicateOf) return null
  return (
    <div className="mb-4 flex flex-col gap-1 rounded-lg border border-border bg-muted/30 p-3">
      {issue.supersededBy && (
        <p className="text-[13px] text-foreground">
          Superseded by{' '}
          <IssueEdgeLink
            edge={resolve(issue.supersededBy)}
            onNavigate={onNavigate}
            fallbackId={issue.supersededBy}
          />
        </p>
      )}
      {issue.duplicateOf && (
        <p className="text-[13px] text-foreground">
          Duplicate of{' '}
          <IssueEdgeLink
            edge={resolve(issue.duplicateOf)}
            onNavigate={onNavigate}
            fallbackId={issue.duplicateOf}
          />
        </p>
      )}
    </div>
  )
}

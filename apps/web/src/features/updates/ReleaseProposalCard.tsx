import type { ReleaseProposal } from '@podium/protocol'
import type { JSX } from 'react'
import { Button } from '@/components/ui/button'
import { UpdateCardHeader, UpdateCommitList, UpdateScrollArea } from './UpdateCardParts'

export function ReleaseProposalCard({
  proposal,
  pending,
  error,
  onApprove,
  onHide,
}: {
  proposal: ReleaseProposal
  pending: boolean
  error?: string
  onApprove: () => void
  onHide: () => void
}): JSX.Element {
  const building = proposal.state === 'building' || pending
  const targetVersion = proposal.version.split('+')[0] ?? proposal.version
  const commitCount = proposal.commitCount ?? proposal.commits.length
  return (
    <aside
      data-testid="release-proposal-card"
      data-state={proposal.state}
      role="dialog"
      aria-modal="false"
      aria-label="Development release proposal"
      className="update-card overflow-hidden"
    >
      <UpdateCardHeader
        title={`Podium ${targetVersion}`}
        dev
        badge={
          <>
            dev <code>{proposal.headSha.slice(0, 7)}</code>
          </>
        }
        subtitle={
          <span data-testid="release-proposal-server-transition">
            {proposal.runningVersion && <>You're on {proposal.runningVersion.split('+')[0]} · </>}
            {commitCount} new {commitCount === 1 ? 'commit' : 'commits'} on {proposal.branch}
          </span>
        }
      />
      <div className="update-card-bar">
        <span className="update-card-section-label">Build for the fleet</span>
        <span className="update-card-count">{commitCount} commits</span>
      </div>
      <UpdateScrollArea
        testId="release-proposal-commits"
        className="min-h-0 flex-1 overflow-y-auto"
      >
        <UpdateCommitList commits={proposal.commits} total={proposal.commitCount} />
      </UpdateScrollArea>
      <div className="update-card-status">
        {proposal.addedMigrations.length > 0 && (
          <div
            data-testid="release-proposal-migration-warning"
            className="rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-[11px] leading-[1.5] text-warning"
          >
            This branch adds {proposal.addedMigrations.length}{' '}
            {proposal.addedMigrations.length === 1 ? 'migration' : 'migrations'}. Releasing it
            commits fleet databases to this branch until it merges. Use a disposable isolated
            instance first when appropriate.
          </div>
        )}
        {proposal.approval && (
          <p className="text-[11px] text-muted-foreground">
            Approved by <code>{proposal.approval.approvedBy}</code>.
          </p>
        )}
        {building && (
          <p className="text-[11px] text-muted-foreground" role="status">
            Building and publishing the release. Rollout has not been approved.
          </p>
        )}
        {proposal.failure && (
          <div className="flex flex-col gap-2">
            <p className="text-[11px] leading-[1.5] text-destructive">{proposal.failure.message}</p>
            <details className="rounded-md border border-border/70 bg-muted/25 px-3 py-2 text-[11px]">
              <summary className="cursor-pointer font-medium text-muted-foreground">
                Build logs
              </summary>
              <pre className="mt-2 font-mono text-[10px] leading-[1.5] whitespace-pre-wrap text-muted-foreground">
                {proposal.failure.logs}
              </pre>
            </details>
          </div>
        )}
        {error && (
          <p className="rounded-md border border-destructive/35 bg-destructive/10 px-3 py-2 text-[11px] leading-[1.5] text-destructive">
            {error}
          </p>
        )}
        <p className="text-[11px] leading-[1.5] text-muted-foreground">
          Approval builds and publishes only. The published release will appear as the normal update
          offer, and will not install until someone accepts that second prompt.
        </p>
      </div>
      <div className="update-card-foot">
        <Button type="button" variant="ghost" size="sm" onClick={onHide}>
          Later
        </Button>
        <span className="update-card-spacer" />
        <Button
          type="button"
          size="sm"
          data-testid="approve-release-proposal"
          disabled={building}
          pending={building}
          pendingLabel="Building…"
          onClick={onApprove}
        >
          {proposal.state === 'failed' ? 'Try build again' : 'Build and publish'}
        </Button>
      </div>
    </aside>
  )
}

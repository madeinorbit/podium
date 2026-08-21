import type { ReleaseProposal } from '@podium/protocol'
import type { JSX } from 'react'
import { Button } from '@/components/ui/button'
import { formatDisplayedVersion } from '@/lib/machine-version-skew'

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
  return (
    <aside
      data-testid="release-proposal-card"
      data-state={proposal.state}
      role="dialog"
      aria-modal="false"
      aria-label="Development release proposal"
      className="fixed right-4 bottom-9 z-50 w-[min(28rem,calc(100vw-2rem))] max-h-[min(42rem,calc(100vh-4rem))] overflow-y-auto rounded-xl border border-border bg-popover text-popover-foreground shadow-[0_14px_34px_rgb(0_0_0_/_0.65),0_2px_8px_rgb(0_0_0_/_0.5)]"
    >
      <div className="border-b border-border px-4 pt-4 pb-3">
        <h2 className="text-[14px] font-semibold tracking-[-0.01em]">
          Release {formatDisplayedVersion(proposal.version)} to development?
        </h2>
        <p className="text-[11px] leading-[1.5] text-muted-foreground">
          {proposal.branch} · {proposal.headSha}
        </p>
      </div>
      <div className="flex flex-col gap-3 px-4 py-4">
        {proposal.commits.length > 0 && (
          <ul className="flex flex-col gap-1.5" aria-label="Commits in this release">
            {proposal.commits.map((commit) => (
              <li key={commit.sha} className="text-[11px] leading-[1.5] text-muted-foreground">
                <code className="mr-2 text-foreground">{commit.sha}</code>
                {commit.summary}
              </li>
            ))}
          </ul>
        )}
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
            <p className="text-[11px] leading-[1.5] text-destructive">
              {proposal.failure.message}
            </p>
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
          Approval builds and publishes only. The published release will appear as the normal
          update offer, and will not install until someone accepts that second prompt.
        </p>
      </div>
      <div className="flex items-center justify-between gap-3 border-t border-border bg-muted/30 px-4 py-3">
        <Button type="button" variant="ghost" size="sm" onClick={onHide}>
          Hide
        </Button>
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

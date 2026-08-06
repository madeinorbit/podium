import { type MergeLockState, useMergeLockState } from '@podium/client-core/react'
import { GitMerge, RefreshCw, Timer } from 'lucide-react'
import type { JSX, ReactNode } from 'react'
import { useEffect, useState } from 'react'
import type { IssueViewModel } from '@/app/store'
import { Button } from '@/components/ui/button'
import { issueIdTitle, issueRefLabel } from '@/features/issues/issue-card'
import {
  formatLeaseRemaining,
  type MergeQueuePanelState,
  type MergeQueuePrincipal,
  type MergeQueueRepoScope,
  readyMergeCandidates,
} from './merge-queue-model'

interface MergeQueuePanelViewProps {
  state: MergeQueuePanelState
  issues: readonly IssueViewModel[]
  scope: MergeQueueRepoScope
  onRefresh: () => void
  onSelectIssue: (issue: IssueViewModel) => void
}

interface MergeQueuePanelProps {
  issues: readonly IssueViewModel[]
  scope: MergeQueueRepoScope | null
  onSelectIssue: (issue: IssueViewModel) => void
}

/** Project the authoritative lock query into the panel's display-state seam. */
export function mergeQueuePanelState(state: MergeLockState): MergeQueuePanelState {
  if (state.loading) return { status: 'loading' }
  if (state.error && state.refreshedAt === null) {
    return { status: 'error', message: state.error }
  }

  return {
    status: 'ready',
    lock: state.lock
      ? {
          holder: {
            ...state.lock.holder,
            acquiredAt: state.lock.acquiredAt,
            expiresAt: state.lock.expiresAt,
            secondsLeft: state.lock.secondsLeft,
            note: state.lock.note,
          },
          // The authority has already assigned FIFO order and positions.
          queue: state.lock.queue,
        }
      : null,
    refreshing: state.refreshing,
    ...(state.error ? { warning: state.error } : {}),
  }
}

/** Live adapter mounted only by the feature-gated merge-queue dock path. */
export function MergeQueuePanel({
  issues,
  scope,
  onSelectIssue,
}: MergeQueuePanelProps): JSX.Element {
  const state = useMergeLockState(scope?.repoPath ?? null)

  if (!scope) {
    return <div className="p-3 text-xs text-muted-foreground/70">No active repository.</div>
  }

  return (
    <MergeQueuePanelView
      state={mergeQueuePanelState(state)}
      issues={issues}
      scope={scope}
      onRefresh={state.refresh}
      onSelectIssue={onSelectIssue}
    />
  )
}

function Section({
  id,
  label,
  count,
  children,
}: {
  id: string
  label: string
  count?: number
  children: ReactNode
}): JSX.Element {
  return (
    <section className="border-b border-hairline-soft last:border-b-0" aria-labelledby={id}>
      <div className="flex h-8 items-center gap-2 px-3.5">
        <h2 id={id} className="font-mono text-[8.5px] font-medium tracking-[0.12em] text-label">
          {label}
        </h2>
        {count !== undefined && (
          <span className="font-mono text-[9px] tabular-nums text-text-dim">{count}</span>
        )}
      </div>
      <div className="px-2.5 pb-2.5">{children}</div>
    </section>
  )
}

function EmptyLine({ children }: { children: ReactNode }): JSX.Element {
  return (
    <p className="rounded-md border border-dashed border-border/65 px-2.5 py-2 text-[11px] leading-4 text-muted-foreground/70">
      {children}
    </p>
  )
}

function IssueIdentity({ issue }: { issue: IssueViewModel }): JSX.Element {
  return (
    <>
      <span className="flex-none font-mono text-[9.5px] font-semibold text-info">
        {issueRefLabel(issue)}
      </span>
      <span className="min-w-0 truncate text-[11.5px] font-medium text-foreground/90">
        {issue.title}
      </span>
    </>
  )
}

function CandidateRow({
  issue,
  onSelect,
}: {
  issue: IssueViewModel
  onSelect: () => void
}): JSX.Element {
  return (
    <button
      data-pressable
      type="button"
      className="flex min-h-8 w-full cursor-pointer items-center gap-2 rounded-md border border-transparent px-2 text-left hover:border-border/70 hover:bg-secondary/55 focus-visible:border-ring focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/35"
      title={issueIdTitle(issue)}
      onClick={onSelect}
    >
      <IssueIdentity issue={issue} />
    </button>
  )
}

function ResolvedPrincipal({
  principal,
  issuesById,
}: {
  principal: MergeQueuePrincipal
  issuesById: ReadonlyMap<string, IssueViewModel>
}): JSX.Element {
  const issue = principal.issueId ? issuesById.get(principal.issueId) : undefined
  if (issue) return <IssueIdentity issue={issue} />
  return (
    <>
      <span className="min-w-0 truncate text-[11.5px] font-medium text-foreground/90">
        {principal.label}
      </span>
      <span className="ml-auto flex-none text-[9.5px] text-text-dim">
        {principal.issueId ? 'Issue unavailable' : 'No task attached'}
      </span>
    </>
  )
}

function LeaseCountdown({ expiresAt, secondsLeft }: { expiresAt: string; secondsLeft: number }) {
  const [remaining, setRemaining] = useState(secondsLeft)
  useEffect(() => {
    const tick = (): void => {
      const expiry = Date.parse(expiresAt)
      setRemaining(
        Number.isFinite(expiry)
          ? Math.max(0, Math.ceil((expiry - Date.now()) / 1_000))
          : Math.max(0, secondsLeft),
      )
    }
    tick()
    const timer = window.setInterval(tick, 1_000)
    return () => window.clearInterval(timer)
  }, [expiresAt, secondsLeft])
  return <time dateTime={expiresAt}>{formatLeaseRemaining(remaining)} left</time>
}

function LoadingShape(): JSX.Element {
  return (
    <div aria-busy="true">
      <span className="sr-only">Loading merge queue…</span>
      {(['READY', 'MERGING NOW', 'NEXT'] as const).map((label, index) => (
        <Section key={label} id={`merge-queue-loading-${index}`} label={label}>
          <div className="flex h-9 items-center gap-2 rounded-md border border-border/50 px-2.5">
            <span className="h-2 w-12 rounded-sm bg-secondary" />
            <span className="h-2 w-28 max-w-[55%] rounded-sm bg-secondary/70" />
          </div>
        </Section>
      ))}
    </div>
  )
}

/**
 * Pure queue instrument. Data delivery is kept outside this component so the
 * lock projection can change transport without changing interaction or state
 * semantics here.
 */
export function MergeQueuePanelView({
  state,
  issues,
  scope,
  onRefresh,
  onSelectIssue,
}: MergeQueuePanelViewProps): JSX.Element {
  if (state.status === 'loading') return <LoadingShape />

  if (state.status === 'error') {
    return (
      <div className="flex min-h-0 flex-1 flex-col items-start gap-3 p-3.5" role="alert">
        <div>
          <p className="text-xs font-medium text-foreground">Merge queue unavailable</p>
          <p className="mt-1 text-[11px] leading-4 text-muted-foreground">{state.message}</p>
        </div>
        <Button variant="outline" size="sm" onClick={onRefresh}>
          <RefreshCw size={12} aria-hidden="true" />
          Try again
        </Button>
      </div>
    )
  }

  const lock = state.lock
  const candidates = readyMergeCandidates(issues, scope, lock)
  // Lock principals are transport strings; replica issues carry branded ids.
  // Widen at this lookup boundary rather than laundering either source type.
  const issuesById = new Map<string, IssueViewModel>(
    issues.map((issue) => [issue.id, issue] as const),
  )
  const holderIssue = lock?.holder.issueId ? issuesById.get(lock.holder.issueId) : undefined

  return (
    <section className="min-h-0 flex-1 overflow-y-auto" aria-label="Main branch merge queue">
      <div className="flex h-9 items-center gap-2 border-b border-hairline-soft px-3.5">
        <GitMerge size={13} className="text-info" aria-hidden="true" />
        <span className="font-mono text-[9px] font-semibold tracking-[0.1em] text-label">
          MERGE:MAIN
        </span>
        <Button
          variant="ghost"
          size="icon-xs"
          className="ml-auto size-6 text-muted-foreground"
          aria-label="Refresh merge queue"
          title="Refresh merge queue"
          disabled={state.refreshing}
          onClick={onRefresh}
        >
          <RefreshCw size={12} aria-hidden="true" />
        </Button>
        {state.refreshing && (
          <span className="sr-only" role="status">
            Refreshing merge queue…
          </span>
        )}
      </div>
      {state.warning && (
        <div
          className="border-b border-destructive/20 bg-destructive/5 px-3.5 py-2 text-[10.5px] leading-4 text-muted-foreground"
          role="status"
        >
          Showing the last queue reading. {state.warning}
        </div>
      )}

      <Section id="merge-queue-ready" label="READY" count={candidates.length}>
        {candidates.length === 0 ? (
          <EmptyLine>No branches ready to merge.</EmptyLine>
        ) : (
          <div className="flex flex-col gap-0.5">
            {candidates.map((issue) => (
              <CandidateRow key={issue.id} issue={issue} onSelect={() => onSelectIssue(issue)} />
            ))}
          </div>
        )}
      </Section>

      <Section id="merge-queue-active" label="MERGING NOW" count={lock ? 1 : 0}>
        {!lock ? (
          <EmptyLine>No active merge lease.</EmptyLine>
        ) : holderIssue ? (
          <button
            data-pressable
            type="button"
            className="w-full cursor-pointer rounded-md border border-info/25 bg-info/5 px-2.5 py-2 text-left hover:border-info/45 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/35"
            title={issueIdTitle(holderIssue)}
            onClick={() => onSelectIssue(holderIssue)}
          >
            <span className="flex min-w-0 items-center gap-2">
              <ResolvedPrincipal principal={lock.holder} issuesById={issuesById} />
            </span>
            <span className="mt-1.5 flex items-center gap-1.5 font-mono text-[9px] tabular-nums text-info">
              <Timer size={11} aria-hidden="true" />
              LEASE
              <LeaseCountdown
                expiresAt={lock.holder.expiresAt}
                secondsLeft={lock.holder.secondsLeft}
              />
            </span>
          </button>
        ) : (
          <div className="w-full rounded-md border border-info/25 bg-info/5 px-2.5 py-2 text-left">
            <span className="flex min-w-0 items-center gap-2">
              <ResolvedPrincipal principal={lock.holder} issuesById={issuesById} />
            </span>
            <span className="mt-1.5 flex items-center gap-1.5 font-mono text-[9px] tabular-nums text-info">
              <Timer size={11} aria-hidden="true" />
              LEASE
              <LeaseCountdown
                expiresAt={lock.holder.expiresAt}
                secondsLeft={lock.holder.secondsLeft}
              />
            </span>
          </div>
        )}
      </Section>

      <Section id="merge-queue-next" label="NEXT" count={lock?.queue.length ?? 0}>
        {!lock || lock.queue.length === 0 ? (
          <EmptyLine>No sessions waiting.</EmptyLine>
        ) : (
          <ol className="flex flex-col gap-1">
            {lock.queue.map((waiter) => {
              const issue = waiter.issueId ? issuesById.get(waiter.issueId) : undefined
              return (
                <li key={`${waiter.position}:${waiter.sessionId ?? waiter.label}`}>
                  {issue ? (
                    <button
                      data-pressable
                      type="button"
                      className="flex min-h-9 w-full cursor-pointer items-center gap-2 rounded-md border border-border/55 bg-background/25 px-2 text-left hover:border-border focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/35"
                      title={issueIdTitle(issue)}
                      onClick={() => onSelectIssue(issue)}
                    >
                      <span className="sr-only">Queue position {waiter.position}: </span>
                      <span
                        className="flex size-5 flex-none items-center justify-center rounded border border-border bg-secondary font-mono text-[9px] font-semibold tabular-nums text-label"
                        aria-hidden="true"
                      >
                        {waiter.position}
                      </span>
                      <span className="flex min-w-0 flex-1 items-center gap-2">
                        <ResolvedPrincipal principal={waiter} issuesById={issuesById} />
                      </span>
                    </button>
                  ) : (
                    <div className="flex min-h-9 w-full items-center gap-2 rounded-md border border-border/55 bg-background/25 px-2 text-left">
                      <span className="sr-only">Queue position {waiter.position}: </span>
                      <span
                        className="flex size-5 flex-none items-center justify-center rounded border border-border bg-secondary font-mono text-[9px] font-semibold tabular-nums text-label"
                        aria-hidden="true"
                      >
                        {waiter.position}
                      </span>
                      <span className="flex min-w-0 flex-1 items-center gap-2">
                        <ResolvedPrincipal principal={waiter} issuesById={issuesById} />
                      </span>
                    </div>
                  )}
                </li>
              )
            })}
          </ol>
        )}
      </Section>
    </section>
  )
}

export type { MergeQueuePanelProps, MergeQueuePanelViewProps }

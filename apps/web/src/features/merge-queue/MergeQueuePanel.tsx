import {
  HEAVY_TEST_LOCK_NAME,
  type LockState,
  MERGE_LOCK_NAME,
  useLockState,
} from '@podium/client-core/react'
import { FlaskConical, GitMerge, LoaderCircle, RefreshCw, Timer } from 'lucide-react'
import type { JSX, ReactNode } from 'react'
import { useEffect, useMemo, useState } from 'react'
import type { IssueViewModel } from '@/app/store'
import { Button } from '@/components/ui/button'
import { issueIdTitle, issueRefLabel } from '@/lib/issue-labels'
import {
  formatLeaseRemaining,
  type MergeQueueRepoScope,
  type QueuePanelState,
  type QueuePrincipal,
  readyMergeCandidates,
} from './merge-queue-model'

interface MergeQueuePanelViewProps {
  mergeState: QueuePanelState
  heavyState: QueuePanelState
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

/** Project one authoritative named-lock query into the panel's display seam. */
export function queuePanelState(state: LockState): QueuePanelState {
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
          queue: state.lock.queue,
        }
      : null,
    refreshing: state.refreshing,
    ...(state.error ? { warning: state.error } : {}),
  }
}

/** Live adapter mounted only by the feature-gated queue dock path. */
export function MergeQueuePanel({
  issues,
  scope,
  onSelectIssue,
}: MergeQueuePanelProps): JSX.Element {
  const repoPath = scope?.repoPath ?? null
  const merge = useLockState(repoPath, MERGE_LOCK_NAME)
  const heavy = useLockState(repoPath, HEAVY_TEST_LOCK_NAME)

  if (!scope) {
    return <div className="p-3 text-xs text-muted-foreground/70">No active repository.</div>
  }

  return (
    <MergeQueuePanelView
      mergeState={queuePanelState(merge)}
      heavyState={queuePanelState(heavy)}
      issues={issues}
      scope={scope}
      onRefresh={() => {
        merge.refresh()
        heavy.refresh()
      }}
      onSelectIssue={onSelectIssue}
    />
  )
}

function QueueSection({
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
    <section className="border-t border-hairline-soft" aria-labelledby={id}>
      <div className="flex h-8 items-center gap-2 px-3.5">
        <h3 id={id} className="font-mono text-[8.5px] font-medium tracking-[0.12em] text-label">
          {label}
        </h3>
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
  principal: QueuePrincipal
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

function QueueWait({ enqueuedAt }: { enqueuedAt: string }): JSX.Element {
  const [seconds, setSeconds] = useState(0)
  useEffect(() => {
    const tick = (): void => {
      const queued = Date.parse(enqueuedAt)
      setSeconds(
        Number.isFinite(queued) ? Math.max(0, Math.floor((Date.now() - queued) / 1_000)) : 0,
      )
    }
    tick()
    const timer = window.setInterval(tick, 1_000)
    return () => window.clearInterval(timer)
  }, [enqueuedAt])
  return (
    <time dateTime={enqueuedAt} title={`Queued ${new Date(enqueuedAt).toLocaleString()}`}>
      Waiting {formatLeaseRemaining(seconds)}
    </time>
  )
}

function QueueLoading({ id, activeLabel }: { id: string; activeLabel: string }): JSX.Element {
  return (
    <div aria-busy="true">
      <span className="sr-only">Loading queue…</span>
      {([activeLabel, 'NEXT UP', 'READY'] as const).map((label, index) => (
        <QueueSection key={label} id={`${id}-loading-${index}`} label={label}>
          <div className="flex h-9 items-center gap-2 rounded-md border border-border/50 px-2.5">
            <span className="h-2 w-12 rounded-sm bg-secondary" />
            <span className="h-2 w-28 max-w-[55%] rounded-sm bg-secondary/70" />
          </div>
        </QueueSection>
      ))}
    </div>
  )
}

function ActiveLease({
  state,
  issuesById,
  onSelectIssue,
}: {
  state: Extract<QueuePanelState, { status: 'ready' }>
  issuesById: ReadonlyMap<string, IssueViewModel>
  onSelectIssue: (issue: IssueViewModel) => void
}): JSX.Element {
  const lock = state.lock
  if (!lock) return <EmptyLine>Nothing running now.</EmptyLine>
  const issue = lock.holder.issueId ? issuesById.get(lock.holder.issueId) : undefined
  const content = (
    <>
      <span className="flex min-w-0 items-center gap-2">
        <LoaderCircle
          size={12}
          className="flex-none text-info motion-safe:animate-spin"
          aria-label="Work in progress"
        />
        <ResolvedPrincipal principal={lock.holder} issuesById={issuesById} />
      </span>
      <span className="mt-1.5 flex items-center gap-1.5 font-mono text-[9px] tabular-nums text-info">
        <Timer size={11} aria-hidden="true" />
        LEASE{' '}
        <LeaseCountdown expiresAt={lock.holder.expiresAt} secondsLeft={lock.holder.secondsLeft} />
      </span>
    </>
  )
  const className =
    'w-full rounded-md border border-info/25 bg-info/5 px-2.5 py-2 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/35'
  return issue ? (
    <button
      data-pressable
      type="button"
      className={`${className} cursor-pointer hover:border-info/45`}
      title={issueIdTitle(issue)}
      onClick={() => onSelectIssue(issue)}
    >
      {content}
    </button>
  ) : (
    <div className={className}>{content}</div>
  )
}

function Waiters({
  state,
  issuesById,
  onSelectIssue,
}: {
  state: Extract<QueuePanelState, { status: 'ready' }>
  issuesById: ReadonlyMap<string, IssueViewModel>
  onSelectIssue: (issue: IssueViewModel) => void
}): JSX.Element {
  const waiters = state.lock?.queue ?? []
  if (waiters.length === 0) return <EmptyLine>No sessions waiting.</EmptyLine>

  return (
    <ol className="flex flex-col gap-1">
      {waiters.map((waiter) => {
        const issue = waiter.issueId ? issuesById.get(waiter.issueId) : undefined
        const row = (
          <>
            <span className="sr-only">Queue position {waiter.position}: </span>
            <span
              className="flex size-5 flex-none items-center justify-center rounded border border-border bg-secondary font-mono text-[9px] font-semibold tabular-nums text-label"
              aria-hidden="true"
            >
              {waiter.position}
            </span>
            <span className="flex min-w-0 flex-1 flex-col py-1.5">
              <span className="flex min-w-0 items-center gap-2">
                <ResolvedPrincipal principal={waiter} issuesById={issuesById} />
              </span>
              <span className="mt-0.5 font-mono text-[9px] tabular-nums text-text-dim">
                <QueueWait enqueuedAt={waiter.enqueuedAt} />
              </span>
            </span>
          </>
        )
        const className =
          'flex min-h-11 w-full items-center gap-2 rounded-md border border-border/55 bg-background/25 px-2 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/35'
        return (
          <li key={`${waiter.position}:${waiter.sessionId ?? waiter.label}`}>
            {issue ? (
              <button
                data-pressable
                type="button"
                className={`${className} cursor-pointer hover:border-border`}
                title={issueIdTitle(issue)}
                onClick={() => onSelectIssue(issue)}
              >
                {row}
              </button>
            ) : (
              <div className={className}>{row}</div>
            )}
          </li>
        )
      })}
    </ol>
  )
}

function QueueGroup({
  id,
  title,
  lockName,
  icon,
  activeLabel,
  state,
  issuesById,
  ready,
  readyCount,
  onRefresh,
  onSelectIssue,
}: {
  id: string
  title: string
  lockName: string
  icon: ReactNode
  activeLabel: string
  state: QueuePanelState
  issuesById: ReadonlyMap<string, IssueViewModel>
  ready: ReactNode | ((lockFree: boolean) => ReactNode)
  readyCount?: number
  onRefresh: () => void
  onSelectIssue: (issue: IssueViewModel) => void
}): JSX.Element {
  return (
    <section
      className="border-b border-hairline-soft last:border-b-0"
      aria-labelledby={`${id}-title`}
    >
      <div className="flex h-10 items-center gap-2 px-3.5">
        {icon}
        <h2 id={`${id}-title`} className="text-[12px] font-semibold text-foreground/90">
          {title}
        </h2>
        <span className="ml-auto font-mono text-[8.5px] text-text-dim">{lockName}</span>
      </div>
      {state.status === 'loading' ? (
        <QueueLoading id={id} activeLabel={activeLabel} />
      ) : state.status === 'error' ? (
        <div
          className="mx-2.5 mb-2.5 rounded-md border border-destructive/25 bg-destructive/5 p-2.5"
          role="alert"
        >
          <p className="text-[11px] font-medium text-foreground">Queue unavailable</p>
          <p className="mt-1 text-[10.5px] leading-4 text-muted-foreground">{state.message}</p>
          <Button className="mt-2" variant="outline" size="sm" onClick={onRefresh}>
            <RefreshCw size={12} aria-hidden="true" /> Try again
          </Button>
        </div>
      ) : (
        <>
          {state.warning && (
            <div
              className="border-t border-destructive/20 bg-destructive/5 px-3.5 py-2 text-[10.5px] leading-4 text-muted-foreground"
              role="status"
            >
              Showing the last queue reading. {state.warning}
            </div>
          )}
          <QueueSection id={`${id}-active`} label={activeLabel} count={state.lock ? 1 : 0}>
            <ActiveLease state={state} issuesById={issuesById} onSelectIssue={onSelectIssue} />
          </QueueSection>
          <QueueSection id={`${id}-next`} label="NEXT UP" count={state.lock?.queue.length ?? 0}>
            <Waiters state={state} issuesById={issuesById} onSelectIssue={onSelectIssue} />
          </QueueSection>
          <QueueSection id={`${id}-ready`} label="READY" count={readyCount}>
            {typeof ready === 'function' ? ready(!state.lock) : ready}
          </QueueSection>
        </>
      )}
    </section>
  )
}

/** Two independent queues, each preserving holder → FIFO waiters → ready order. */
export function MergeQueuePanelView({
  mergeState,
  heavyState,
  issues,
  scope,
  onRefresh,
  onSelectIssue,
}: MergeQueuePanelViewProps): JSX.Element {
  const issuesById = useMemo(
    () => new Map<string, IssueViewModel>(issues.map((issue) => [issue.id, issue] as const)),
    [issues],
  )
  const candidates =
    mergeState.status === 'ready' ? readyMergeCandidates(issues, scope, mergeState.lock) : []
  const refreshing =
    (mergeState.status === 'ready' && mergeState.refreshing) ||
    (heavyState.status === 'ready' && heavyState.refreshing)

  return (
    <section className="min-h-0 flex-1 overflow-y-auto" aria-label="Repository queues">
      <div className="flex h-9 items-center gap-2 border-b border-hairline-soft px-3.5">
        <span className="font-mono text-[9px] font-semibold tracking-[0.1em] text-label">
          LIVE QUEUES
        </span>
        <Button
          variant="ghost"
          size="icon-xs"
          className="ml-auto size-6 text-muted-foreground"
          aria-label="Refresh queues"
          title="Refresh queues"
          disabled={refreshing}
          onClick={onRefresh}
        >
          <RefreshCw size={12} aria-hidden="true" />
        </Button>
        {refreshing && (
          <span className="sr-only" role="status">
            Refreshing queues…
          </span>
        )}
      </div>

      <QueueGroup
        id="merge-queue"
        title="Merge queue"
        lockName={MERGE_LOCK_NAME}
        icon={<GitMerge size={13} className="text-info" aria-hidden="true" />}
        activeLabel="MERGING NOW"
        state={mergeState}
        issuesById={issuesById}
        onRefresh={onRefresh}
        onSelectIssue={onSelectIssue}
        ready={
          candidates.length === 0 ? (
            <EmptyLine>No branches ready to merge.</EmptyLine>
          ) : (
            <div className="flex flex-col gap-0.5">
              {candidates.map((issue) => (
                <CandidateRow key={issue.id} issue={issue} onSelect={() => onSelectIssue(issue)} />
              ))}
            </div>
          )
        }
        readyCount={candidates.length}
      />

      <QueueGroup
        id="heavy-test-queue"
        title="Heavy test queue"
        lockName={HEAVY_TEST_LOCK_NAME}
        icon={<FlaskConical size={13} className="text-info" aria-hidden="true" />}
        activeLabel="TESTING NOW"
        state={heavyState}
        issuesById={issuesById}
        onRefresh={onRefresh}
        onSelectIssue={onSelectIssue}
        ready={(lockFree) => (
          <EmptyLine>
            {lockFree
              ? 'Ready for the next heavy test run.'
              : 'New runs join this queue when they request the heavy-test lease.'}
          </EmptyLine>
        )}
      />
    </section>
  )
}

export type { MergeQueuePanelProps, MergeQueuePanelViewProps }

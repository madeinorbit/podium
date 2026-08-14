import { type RepoLocksState, useRepoLocks } from '@podium/client-core/react'
import {
  FlaskConical,
  GitMerge,
  LoaderCircle,
  Lock,
  LockOpen,
  RefreshCw,
  Timer,
} from 'lucide-react'
import type { JSX, ReactNode } from 'react'
import { useEffect, useMemo, useState } from 'react'
import type { IssueViewModel } from '@/app/store'
import { Button } from '@/components/ui/button'
import { issueIdTitle, issueRefLabel } from '@/lib/issue-labels'
import {
  formatLeaseRemaining,
  KNOWN_LANE_EXAMPLES,
  type MergeQueueRepoScope,
  type QueueGroupModel,
  type QueueLock,
  type QueuePanelState,
  type QueuePrincipal,
  queueGroups,
  readyMergeCandidates,
} from './merge-queue-model'
import { formatReleasedAgo, type ReleasedLane, useReleasedLanes } from './released-lanes'

interface MergeQueuePanelViewProps {
  state: QueuePanelState
  issues: readonly IssueViewModel[]
  scope: MergeQueueRepoScope
  /** Lanes this client watched leave; the live adapter owns the memory. */
  released?: readonly ReleasedLane[]
  onRefresh: () => void
  onSelectIssue: (issue: IssueViewModel) => void
}

interface MergeQueuePanelProps {
  issues: readonly IssueViewModel[]
  scope: MergeQueueRepoScope | null
  onSelectIssue: (issue: IssueViewModel) => void
}

/** Project one authoritative whole-repo lock query into the panel's display seam. */
export function queuePanelState(state: RepoLocksState): QueuePanelState {
  if (state.loading) return { status: 'loading' }
  if (state.error && state.refreshedAt === null) {
    return { status: 'error', message: state.error }
  }

  return {
    status: 'ready',
    locks: state.locks.map(
      (lock): QueueLock => ({
        name: lock.name,
        holder: {
          ...lock.holder,
          acquiredAt: lock.acquiredAt,
          expiresAt: lock.expiresAt,
          secondsLeft: lock.secondsLeft,
          note: lock.note,
        },
        queue: lock.queue,
      }),
    ),
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
  const locks = useRepoLocks(scope?.repoPath ?? null)
  const state = queuePanelState(locks)
  const released = useReleasedLanes(state)

  if (!scope) {
    return <div className="p-3 text-xs text-muted-foreground/70">No active repository.</div>
  }

  return (
    <MergeQueuePanelView
      state={state}
      issues={issues}
      scope={scope}
      released={released}
      onRefresh={locks.refresh}
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
        <h3 id={id} className="font-mono shell-type-micro font-medium tracking-[0.12em] text-label">
          {label}
        </h3>
        {count !== undefined && (
          <span className="font-mono shell-type-micro tabular-nums text-text-dim">{count}</span>
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
      <span className="flex-none font-mono shell-type-micro font-semibold text-info">
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
      <span className="ml-auto flex-none shell-type-micro text-text-dim">
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

/** Skeleton for the two pinned lanes; leases beyond them are not yet known. */
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
  lock,
  issuesById,
  onSelectIssue,
}: {
  lock: QueueLock | null
  issuesById: ReadonlyMap<string, IssueViewModel>
  onSelectIssue: (issue: IssueViewModel) => void
}): JSX.Element {
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
      <span className="mt-1.5 flex items-center gap-1.5 font-mono shell-type-micro tabular-nums text-info">
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
  lock,
  issuesById,
  onSelectIssue,
}: {
  lock: QueueLock | null
  issuesById: ReadonlyMap<string, IssueViewModel>
  onSelectIssue: (issue: IssueViewModel) => void
}): JSX.Element {
  const waiters = lock?.queue ?? []
  if (waiters.length === 0) return <EmptyLine>No sessions waiting.</EmptyLine>

  return (
    <ol className="flex flex-col gap-1">
      {waiters.map((waiter) => {
        const issue = waiter.issueId ? issuesById.get(waiter.issueId) : undefined
        const row = (
          <>
            <span className="sr-only">Queue position {waiter.position}: </span>
            <span
              className="flex size-5 flex-none items-center justify-center rounded border border-border bg-secondary font-mono shell-type-micro font-semibold tabular-nums text-label"
              aria-hidden="true"
            >
              {waiter.position}
            </span>
            <span className="flex min-w-0 flex-1 flex-col py-1.5">
              <span className="flex min-w-0 items-center gap-2">
                <ResolvedPrincipal principal={waiter} issuesById={issuesById} />
              </span>
              <span className="mt-0.5 font-mono shell-type-micro tabular-nums text-text-dim">
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

const GROUP_ICON = {
  merge: GitMerge,
  heavy: FlaskConical,
  other: Lock,
} as const

/**
 * The pinned merge lane. It keeps a title row and all three sections because
 * it is the one lane that is meaningful while free — READY answers "what would
 * go next" even with nobody holding the lock.
 */
function MergeGroup({
  group,
  issuesById,
  ready,
  readyCount,
  loading,
  onSelectIssue,
}: {
  group: QueueGroupModel
  issuesById: ReadonlyMap<string, IssueViewModel>
  ready: ReactNode
  readyCount: number
  loading?: boolean
  onSelectIssue: (issue: IssueViewModel) => void
}): JSX.Element {
  const id = 'merge-queue'
  const Icon = GROUP_ICON[group.kind]
  return (
    <section className="border-b border-hairline-soft" aria-labelledby={`${id}-title`}>
      <div className="flex h-10 items-center gap-2 px-3.5">
        <Icon size={13} className="flex-none text-info" aria-hidden="true" />
        <h2
          id={`${id}-title`}
          className="min-w-0 truncate text-[12px] font-semibold text-foreground/90"
        >
          {group.title}
        </h2>
        {/* The raw name is what the operator types into `podium lock`. */}
        <span
          className="ml-auto min-w-0 max-w-[55%] truncate font-mono shell-type-micro text-text-dim"
          title={group.name}
        >
          {group.name}
        </span>
      </div>
      {loading ? (
        <QueueLoading id={id} activeLabel={group.activeLabel} />
      ) : (
        <>
          <QueueSection id={`${id}-active`} label={group.activeLabel} count={group.lock ? 1 : 0}>
            <ActiveLease lock={group.lock} issuesById={issuesById} onSelectIssue={onSelectIssue} />
          </QueueSection>
          <QueueSection id={`${id}-next`} label="NEXT UP" count={group.lock?.queue.length ?? 0}>
            <Waiters lock={group.lock} issuesById={issuesById} onSelectIssue={onSelectIssue} />
          </QueueSection>
          <QueueSection id={`${id}-ready`} label="READY" count={readyCount}>
            {ready}
          </QueueSection>
        </>
      )}
    </section>
  )
}

/**
 * One held lease. A lane exists only while somebody holds it, so it spends no
 * row saying so: the kind's vocabulary and the raw name share a single 32px
 * head, and NEXT UP appears only when somebody is actually queued behind it.
 */
function LaneGroup({
  group,
  issuesById,
  onSelectIssue,
}: {
  group: QueueGroupModel
  issuesById: ReadonlyMap<string, IssueViewModel>
  onSelectIssue: (issue: IssueViewModel) => void
}): JSX.Element {
  const id = groupId(group.name)
  const Icon = GROUP_ICON[group.kind]
  const waiters = group.lock?.queue ?? []
  return (
    <section className="border-t border-hairline-soft" aria-labelledby={`${id}-title`}>
      <div className="flex h-8 items-center gap-2 px-3.5">
        <Icon size={12} className="flex-none text-info" aria-hidden="true" />
        {/* Label and name are one heading: two lanes of a kind must not share
            an accessible name. */}
        <h3 id={`${id}-title`} className="flex min-w-0 flex-1 items-center gap-2">
          <span className="flex-none font-mono shell-type-micro font-medium tracking-[0.12em] text-label">
            {group.activeLabel}
          </span>
          <span
            className="ml-auto min-w-0 truncate font-mono shell-type-micro text-text-dim"
            title={group.name}
          >
            {group.name}
          </span>
        </h3>
      </div>
      <div className="px-2.5 pb-2.5">
        <ActiveLease lock={group.lock} issuesById={issuesById} onSelectIssue={onSelectIssue} />
      </div>
      {waiters.length > 0 && (
        <QueueSection id={`${id}-next`} label="NEXT UP" count={waiters.length}>
          <Waiters lock={group.lock} issuesById={issuesById} onSelectIssue={onSelectIssue} />
        </QueueSection>
      )}
    </section>
  )
}

/** Coarse, and its own clock: history that never updates reads as frozen. */
function ReleasedAgo({ releasedAt }: { releasedAt: number }): JSX.Element {
  const [label, setLabel] = useState(() => formatReleasedAgo(Date.now() - releasedAt))
  useEffect(() => {
    const tick = (): void => setLabel(formatReleasedAgo(Date.now() - releasedAt))
    tick()
    const timer = window.setInterval(tick, 30_000)
    return () => window.clearInterval(timer)
  }, [releasedAt])
  return (
    <time
      className="ml-auto flex-none font-mono shell-type-micro tabular-nums text-text-dim"
      dateTime={new Date(releasedAt).toISOString()}
    >
      {label}
    </time>
  )
}

/**
 * Lanes this client watched leave. Dim, past tense and completely still — the
 * point is that the operator sees the mechanic happen rather than inferring it
 * from a panel that was already empty when they looked.
 */
function ReleasedTail({ released }: { released: readonly ReleasedLane[] }): JSX.Element {
  return (
    <QueueSection id="live-lanes-released" label="RECENTLY RELEASED" count={released.length}>
      <ul className="flex flex-col gap-0.5">
        {released.map((lane) => (
          <li key={lane.name} className="flex min-h-7 items-center gap-2 px-2 opacity-80">
            <LockOpen size={11} className="flex-none text-muted-foreground/60" aria-hidden="true" />
            <span
              className="min-w-0 truncate font-mono text-[10.5px] text-text-dim"
              title={lane.name}
            >
              {lane.name}
            </span>
            <ReleasedAgo releasedAt={lane.releasedAt} />
          </li>
        ))}
      </ul>
    </QueueSection>
  )
}

/**
 * What the band will show, named concretely. A free lock has no row to report,
 * so the names appear in a sentence rather than as rows nobody holds — the
 * band's whole rule is that a row means a real lease.
 */
function LanesEmpty(): JSX.Element {
  return (
    <div className="px-3.5 pb-3">
      <p className="text-[11.5px] font-medium leading-4 text-foreground/85">
        No lane is held right now.
      </p>
      <p className="mt-2 text-[11.5px] leading-[1.5] text-muted-foreground">
        Lanes are created on demand. When a session runs{' '}
        <span className="font-mono text-[10.5px] text-foreground/85">podium lock acquire</span>, its
        lane appears here with the holder, the lease clock and everyone waiting behind it.
      </p>
      <p className="mt-2.5 font-mono shell-type-micro tracking-[0.12em] text-text-dim">
        LANES THIS REPO&apos;S AGENTS TAKE
      </p>
      <ul className="mt-1.5 flex flex-wrap gap-1">
        {KNOWN_LANE_EXAMPLES.map((name) => (
          <li
            key={name}
            className="rounded border border-border/70 bg-background/30 px-1.5 py-0.5 font-mono text-[10.5px] text-muted-foreground"
          >
            {name}
          </li>
        ))}
      </ul>
    </div>
  )
}

/**
 * Every held lease except the pinned merge lane, and nothing pinned inside it.
 *
 * The band carries its own explanation because it is the region that is
 * legitimately empty most of the time (POD-1076): a standing one-line rule
 * while lanes are running, the fuller teaching copy while none are, and the
 * released tail either way.
 */
function LiveLanes({
  lanes,
  released,
  loading,
  issuesById,
  onSelectIssue,
}: {
  lanes: readonly QueueGroupModel[]
  released: readonly ReleasedLane[]
  loading: boolean
  issuesById: ReadonlyMap<string, IssueViewModel>
  onSelectIssue: (issue: IssueViewModel) => void
}): JSX.Element {
  return (
    <section
      className="border-b border-hairline-soft last:border-b-0"
      aria-labelledby="live-lanes-title"
    >
      <div className="flex h-10 items-center gap-2 px-3.5">
        <Lock size={13} className="flex-none text-info" aria-hidden="true" />
        <h2
          id="live-lanes-title"
          className="min-w-0 truncate text-[12px] font-semibold text-foreground/90"
        >
          Live lanes
        </h2>
        {!loading && (
          <span className="ml-auto flex-none font-mono shell-type-micro tabular-nums text-text-dim">
            {lanes.length === 0 ? 'none held' : `${lanes.length} held`}
          </span>
        )}
      </div>

      {loading ? (
        <div aria-busy="true">
          <span className="sr-only">Loading queue…</span>
          <p className="px-3.5 pb-2.5 text-[11px] leading-4 text-muted-foreground">
            Reading every lease this repository holds…
          </p>
          <div className="px-2.5 pb-2.5">
            <div className="flex h-9 items-center gap-2 rounded-md border border-border/50 px-2.5">
              <span className="h-2 w-12 rounded-sm bg-secondary" />
              <span className="h-2 w-28 max-w-[55%] rounded-sm bg-secondary/70" />
            </div>
          </div>
        </div>
      ) : lanes.length === 0 ? (
        <LanesEmpty />
      ) : (
        <>
          <p className="px-3.5 pb-2.5 text-[11px] leading-4 text-muted-foreground">
            A lane appears while a session holds its lock and leaves when the lease is released.
          </p>
          {lanes.map((lane) => (
            <LaneGroup
              key={lane.name}
              group={lane}
              issuesById={issuesById}
              onSelectIssue={onSelectIssue}
            />
          ))}
        </>
      )}

      {!loading && released.length > 0 && <ReleasedTail released={released} />}
    </section>
  )
}

/** A stable DOM id for a free-form lock name. */
function groupId(name: string): string {
  return `queue-${name.replace(/[^a-zA-Z0-9]+/g, '-')}`
}

/**
 * Every lease the repository holds, each preserving holder → FIFO waiters.
 *
 * One lane is pinned — merge, because it has a queue to show while free. The
 * rest live in a band that carries its own explanation, so the region that is
 * legitimately empty most of the time never reads as a broken panel.
 */
export function MergeQueuePanelView({
  state,
  issues,
  scope,
  released = [],
  onRefresh,
  onSelectIssue,
}: MergeQueuePanelViewProps): JSX.Element {
  const issuesById = useMemo(
    () => new Map<string, IssueViewModel>(issues.map((issue) => [issue.id, issue] as const)),
    [issues],
  )
  const locks = state.status === 'ready' ? state.locks : []
  const { merge, lanes } = queueGroups(locks)
  const candidates = state.status === 'ready' ? readyMergeCandidates(issues, scope, merge.lock) : []
  const refreshing = state.status === 'ready' && state.refreshing === true

  return (
    <section className="min-h-0 flex-1 overflow-y-auto" aria-label="Repository queues">
      <div className="flex h-9 items-center gap-2 border-b border-hairline-soft px-3.5">
        <span className="font-mono shell-type-micro font-semibold tracking-[0.1em] text-label">
          QUEUES
        </span>
        {state.status === 'ready' && (
          <span className="font-mono shell-type-micro tabular-nums text-text-dim">
            {locks.length} live
          </span>
        )}
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

      {state.status === 'error' ? (
        <div
          className="mx-2.5 my-2.5 rounded-md border border-destructive/25 bg-destructive/5 p-2.5"
          role="alert"
        >
          <p className="text-[11px] font-medium text-foreground">Queues unavailable</p>
          <p className="mt-1 text-[10.5px] leading-4 text-muted-foreground">{state.message}</p>
          <Button className="mt-2" variant="outline" size="sm" onClick={onRefresh}>
            <RefreshCw size={12} aria-hidden="true" /> Try again
          </Button>
        </div>
      ) : (
        <>
          {state.status === 'ready' && state.warning && (
            <div
              className="border-b border-destructive/20 bg-destructive/5 px-3.5 py-2 text-[10.5px] leading-4 text-muted-foreground"
              role="status"
            >
              Showing the last queue reading. {state.warning}
            </div>
          )}

          <MergeGroup
            group={merge}
            issuesById={issuesById}
            loading={state.status === 'loading'}
            onSelectIssue={onSelectIssue}
            ready={
              candidates.length === 0 ? (
                <EmptyLine>No branches ready to merge.</EmptyLine>
              ) : (
                <div className="flex flex-col gap-0.5">
                  {candidates.map((issue) => (
                    <CandidateRow
                      key={issue.id}
                      issue={issue}
                      onSelect={() => onSelectIssue(issue)}
                    />
                  ))}
                </div>
              )
            }
            readyCount={candidates.length}
          />

          <LiveLanes
            lanes={lanes}
            released={released}
            loading={state.status === 'loading'}
            issuesById={issuesById}
            onSelectIssue={onSelectIssue}
          />
        </>
      )}
    </section>
  )
}

export type { MergeQueuePanelProps, MergeQueuePanelViewProps }

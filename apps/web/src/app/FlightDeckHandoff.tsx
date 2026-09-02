import {
  deriveHandoffNext,
  deriveHandoffNow,
  missionSessions,
  reviewReturnCount,
  summarizeHandoffSessions,
  type HandoffNowEntry,
  type HandoffTranscriptPair,
  type IssueNavigationModel,
} from '@podium/client-core/viewmodels'
import type { IssueId, SessionId, SessionMeta } from '@podium/model/browser'
import { issueDisplayRef } from '@podium/protocol'
import { ChevronDown } from 'lucide-react'
import type { JSX, ReactNode } from 'react'
import { useEffect, useMemo, useState } from 'react'
import { renderReadoutMarkdown } from '@/lib/markdown'
import { cn } from '@/lib/utils'
import { useHandoffTranscript } from './use-handoff-transcript'
import { useStoreSelector } from './store'

const INITIAL_ROWS = 8
const reviewReturnCache = new Map<string, number>()

function formatStamp(value: string | null | undefined): string | null {
  if (!value) return null
  const stamp = new Date(value)
  if (Number.isNaN(stamp.getTime())) return null
  return stamp.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

function sessionRef(session: SessionMeta): string {
  return session.displayRef?.trim() || session.sessionId
}

function ReadoutMarkdown({ text, clamp = false }: { text: string; clamp?: boolean }): JSX.Element {
  const html = useMemo(() => renderReadoutMarkdown(text), [text])
  return (
    <div
      className={cn(
        'handoff-markdown text-[12px] leading-[1.55] text-foreground',
        clamp && 'line-clamp-6',
      )}
      // biome-ignore lint/security/noDangerouslySetInnerHtml: renderReadoutMarkdown sanitizes and removes links.
      dangerouslySetInnerHTML={{ __html: html }}
    />
  )
}

function HandoffSection({ title, children }: { title: string; children: ReactNode }): JSX.Element {
  return (
    <section className="handoff-section">
      <h3 className="shell-type-micro font-mono font-medium tracking-[0.14em] text-label uppercase">
        {title}
      </h3>
      <div className="mt-2">{children}</div>
    </section>
  )
}

function TranscriptCard({
  label,
  session,
  item,
  legacy = false,
  fresh = false,
  onOpen,
}: {
  label: string
  session: SessionMeta
  item: HandoffTranscriptPair['prompt']['item']
  legacy?: boolean
  fresh?: boolean
  onOpen: () => void
}): JSX.Element {
  const reference = sessionRef(session)
  return (
    <button
      type="button"
      data-pressable
      className="handoff-transcript-card w-full rounded-row border border-border bg-card/35 px-3 py-2.5 text-left hover:border-foreground/25 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      onClick={onOpen}
      aria-label={`${legacy ? 'Latest reply' : label} in session ${reference}`}
    >
      <span className="flex items-center gap-2 font-mono shell-type-micro text-text-faint">
        <span>{legacy ? 'Latest reply' : label}</span>
        <span aria-hidden>·</span>
        <span>{reference}</span>
        {formatStamp(item.ts) && (
          <span className="ml-auto tabular-nums">{formatStamp(item.ts)}</span>
        )}
      </span>
      <div className="mt-1.5">
        <ReadoutMarkdown text={item.text} clamp={label !== 'Last prompt'} />
      </div>
      {fresh && (
        <span className="mt-2 inline-flex font-mono shell-type-micro text-info">
          New since your last visit
        </span>
      )}
    </button>
  )
}

function useReviewReturns(
  entries: readonly HandoffNowEntry[],
  issues: readonly IssueNavigationModel[],
): ReadonlyMap<string, number> {
  const trpc = useStoreSelector((store) => store.trpc)
  const ids = useMemo(() => entries.map((entry) => entry.issueId), [entries])
  const [counts, setCounts] = useState<ReadonlyMap<string, number>>(() => new Map())

  useEffect(() => {
    let cancelled = false
    if (ids.length === 0) {
      setCounts(new Map())
      return
    }
    const queue = [...ids]
    const next = new Map<string, number>()
    const worker = async (): Promise<void> => {
      while (queue.length > 0) {
        const id = queue.shift()
        if (!id) return
        const issue = issues.find((candidate) => candidate.id === id)
        if (!issue) continue
        const cacheKey = `${issue.id}\n${issue.updatedAt}`
        const cached = reviewReturnCache.get(cacheKey)
        if (cached !== undefined) {
          next.set(id, cached)
          continue
        }
        try {
          const events = await trpc.issues.events.query({
            since: 0,
            repoPath: issue.repoPath ?? null,
            subject: issue.id,
            limit: 200,
          })
          const count = reviewReturnCount(events)
          reviewReturnCache.set(cacheKey, count)
          next.set(id, count)
        } catch {
          next.set(id, 0)
        }
      }
    }
    void Promise.all(Array.from({ length: Math.min(4, queue.length) }, () => worker())).then(() => {
      if (!cancelled) setCounts(next)
    })
    return () => {
      cancelled = true
    }
  }, [ids, issues, trpc])
  return counts
}

function HandoffEntry({
  issue,
  session,
  state,
  attention,
  text,
  onOpen,
}: {
  issue: IssueNavigationModel
  session?: SessionMeta
  state: string
  attention?: boolean
  text: string
  onOpen: () => void
}): JSX.Element {
  return (
    <button
      type="button"
      data-pressable
      onClick={onOpen}
      className="handoff-entry grid w-full grid-cols-[minmax(0,1fr)_auto] gap-x-3 gap-y-1 rounded-row px-2.5 py-2 text-left hover:bg-muted/55 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      aria-label={`${issueDisplayRef(issue)} ${issue.title}${session ? `, session ${sessionRef(session)}` : ''}, ${state}. ${text}`}
    >
      <span className="min-w-0 truncate text-[12px] font-medium text-foreground">
        <span className="mr-1.5 font-mono shell-type-micro text-text-dim">
          {issueDisplayRef(issue)}
        </span>
        {issue.title}
      </span>
      <span
        className={cn(
          'font-mono shell-type-micro whitespace-nowrap',
          attention ? 'text-attention' : 'text-text-dim',
        )}
      >
        {state}
      </span>
      <span className="shell-type-secondary min-w-0 text-muted-foreground">{text}</span>
      {session ? (
        <span className="font-mono shell-type-micro text-right text-text-faint">
          {sessionRef(session)}
        </span>
      ) : (
        <span />
      )}
    </button>
  )
}

function ExpandRows({ count, onClick }: { count: number; onClick: () => void }): JSX.Element {
  return (
    <button
      type="button"
      data-pressable
      onClick={onClick}
      className="mt-1 inline-flex min-h-7 items-center gap-1.5 rounded-md px-2 font-mono shell-type-micro text-text-dim hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <ChevronDown size={11} aria-hidden /> Show {count} more
    </button>
  )
}

export function FlightDeckHandoff({
  rootIssue,
  issues,
  sessions,
  visitReadAt,
  proposed,
  onOpenTranscript,
  onOpenSession,
  onOpenIssue,
}: {
  rootIssue: IssueNavigationModel
  issues: readonly IssueNavigationModel[]
  sessions: readonly SessionMeta[]
  visitReadAt: string | null
  proposed: ReactNode
  onOpenTranscript: (sessionId: SessionId, itemKey: string) => void
  onOpenSession: (issueId: IssueId, sessionId: SessionId) => void
  onOpenIssue: (issueId: IssueId) => void
}): JSX.Element {
  const crew = useMemo(
    () => missionSessions(issues, sessions, rootIssue.id, true),
    [issues, sessions, rootIssue.id],
  )
  const transcript = useHandoffTranscript(true, crew)
  const current = useMemo(
    () => deriveHandoffNow(issues, sessions, rootIssue.id),
    [issues, sessions, rootIssue.id],
  )
  const next = useMemo(
    () => deriveHandoffNext(issues, sessions, rootIssue.id),
    [issues, sessions, rootIssue.id],
  )
  const summary = useMemo(() => summarizeHandoffSessions(crew), [crew])
  const [currentLimit, setCurrentLimit] = useState(INITIAL_ROWS)
  const [nextLimit, setNextLimit] = useState(INITIAL_ROWS)
  const displayedCurrent = useMemo(() => current.slice(0, currentLimit), [current, currentLimit])
  const returns = useReviewReturns(displayedCurrent, issues)
  useEffect(() => {
    setCurrentLimit(INITIAL_ROWS)
    setNextLimit(INITIAL_ROWS)
  }, [rootIssue.id])
  const issueById = useMemo(() => new Map(issues.map((issue) => [issue.id, issue])), [issues])
  const sessionById = useMemo(
    () => new Map(sessions.map((session) => [session.sessionId, session])),
    [sessions],
  )
  const pair = transcript.pair
  const answer = pair?.answer
  const answerAt = answer?.item.ts ? Date.parse(answer.item.ts) : Number.NaN
  const baselineAt = visitReadAt ? Date.parse(visitReadAt) : Number.NaN
  const answerIsFresh =
    visitReadAt !== null &&
    Number.isFinite(answerAt) &&
    Number.isFinite(baselineAt) &&
    answerAt > baselineAt

  const summaryParts = [
    `${summary.computing} computing now`,
    `${summary.idle} live but idle`,
    `${summary.hibernated} hibernated`,
    ...(summary.exited > 0 ? [`${summary.exited} exited or archived`] : []),
  ]

  return (
    <div className="handoff-view pb-3" data-testid="flight-deck-handoff">
      <HandoffSection title="Last update">
        {rootIssue.activityNotes?.trim() ? (
          <div className="px-2.5">
            <ReadoutMarkdown text={rootIssue.activityNotes.trim()} />
            {formatStamp(rootIssue.notesUpdatedAt) && (
              <p className="mt-1.5 font-mono shell-type-micro tabular-nums text-text-faint">
                {formatStamp(rootIssue.notesUpdatedAt)}
              </p>
            )}
          </div>
        ) : (
          <p className="px-2.5 shell-type-secondary text-text-dim">
            No issue update has been recorded.
          </p>
        )}
      </HandoffSection>

      <HandoffSection title="Last prompt">
        <div aria-live="polite">
          {transcript.status === 'loading' && !transcript.pair ? (
            <p className="px-2.5 shell-type-secondary text-text-dim">Loading latest prompt…</p>
          ) : pair && transcript.session ? (
            <TranscriptCard
              label="Last prompt"
              session={transcript.session}
              item={pair.prompt.item}
              onOpen={() => onOpenTranscript(pair.sessionId, pair.prompt.anchor.itemKey)}
            />
          ) : transcript.status === 'error' ? (
            <div className="flex items-center justify-between gap-3 px-2.5">
              <p className="shell-type-secondary text-destructive">
                Couldn't load the latest transcript.
              </p>
              <button
                type="button"
                data-pressable
                className="min-h-7 rounded-md px-2 font-mono shell-type-micro text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                onClick={transcript.retry}
              >
                Retry
              </button>
            </div>
          ) : (
            <p className="px-2.5 shell-type-secondary text-text-dim">
              No operator prompt is recorded for this mission.
            </p>
          )}
        </div>
      </HandoffSection>

      <HandoffSection title={answer?.legacy ? 'Latest reply' : 'Last answer'}>
        <div aria-live="polite">
          {transcript.status === 'loading' && !transcript.pair ? (
            <p className="px-2.5 shell-type-secondary text-text-dim">Loading latest answer…</p>
          ) : pair && transcript.session && answer ? (
            <TranscriptCard
              label="Last answer"
              session={transcript.session}
              legacy={answer.legacy}
              fresh={answerIsFresh}
              item={answer.item}
              onOpen={() => onOpenTranscript(pair.sessionId, answer.anchor.itemKey)}
            />
          ) : transcript.status === 'error' ? null : pair ? (
            <p className="px-2.5 shell-type-secondary text-text-dim">No final answer yet.</p>
          ) : (
            <p className="px-2.5 shell-type-secondary text-text-dim">No final answer yet.</p>
          )}
        </div>
      </HandoffSection>

      <div className="handoff-now-divider flex items-center gap-2 px-3 py-3 font-mono shell-type-micro text-label">
        <span>Now · issue and session state</span>
        <span aria-hidden className="h-px flex-1 bg-hairline-soft" />
      </div>

      <HandoffSection title="What is happening">
        <p className="px-2.5 font-mono shell-type-micro text-text-dim">
          {summaryParts.join(' · ')}
        </p>
        {current.length === 0 ? (
          <p className="mt-2 px-2.5 shell-type-secondary text-text-dim">
            No work needs explanation right now.
          </p>
        ) : (
          <div className="mt-2 flex flex-col gap-0.5">
            {displayedCurrent.map((entry) => {
              const issue = issueById.get(entry.issueId)
              if (!issue) return null
              const session =
                'sessionId' in entry && entry.sessionId
                  ? sessionById.get(entry.sessionId)
                  : undefined
              const returnCount = returns.get(entry.issueId) ?? 0
              const text =
                returnCount > 1
                  ? `${entry.text} Returned from review ${returnCount} times.`
                  : entry.text
              const state =
                entry.kind === 'working'
                  ? 'Computing'
                  : entry.kind === 'needs-you'
                    ? 'Needs you'
                    : entry.kind === 'stalled'
                      ? 'Stalled'
                      : entry.kind === 'review'
                        ? 'Review'
                        : 'Blocked'
              return (
                <HandoffEntry
                  key={entry.issueId}
                  issue={issue}
                  session={session}
                  state={state}
                  attention={entry.kind === 'needs-you'}
                  text={text}
                  onOpen={() =>
                    session
                      ? onOpenSession(entry.issueId, session.sessionId)
                      : onOpenIssue(entry.issueId)
                  }
                />
              )
            })}
            {current.length > currentLimit && (
              <ExpandRows
                count={current.length - currentLimit}
                onClick={() => setCurrentLimit(current.length)}
              />
            )}
          </div>
        )}
      </HandoffSection>

      <HandoffSection title="What happens next">
        {next.length === 0 ? (
          <p className="px-2.5 shell-type-secondary text-text-dim">No recorded next condition.</p>
        ) : (
          <div className="flex flex-col gap-0.5">
            {next.slice(0, nextLimit).map((entry) => {
              const issue = issueById.get(entry.issueId)
              if (!issue) return null
              const session = entry.sessionId ? sessionById.get(entry.sessionId) : undefined
              return (
                <HandoffEntry
                  key={`${entry.issueId}:${entry.afterIssueId ?? 'ready'}`}
                  issue={issue}
                  session={session}
                  state="Next"
                  text={entry.text}
                  onOpen={() => onOpenIssue(entry.issueId)}
                />
              )
            })}
            {next.length > nextLimit && (
              <ExpandRows
                count={next.length - nextLimit}
                onClick={() => setNextLimit(next.length)}
              />
            )}
          </div>
        )}
      </HandoffSection>

      {proposed}
    </div>
  )
}

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

function HandoffSection({
  title,
  meta,
  future = false,
  children,
}: {
  title: string
  meta?: ReactNode
  future?: boolean
  children: ReactNode
}): JSX.Element {
  return (
    <section className={cn('handoff-section', future && 'handoff-section--future')}>
      <div className="handoff-section-head">
        <h3>{title}</h3>
        {meta && <span>{meta}</span>}
      </div>
      {children}
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
  const answer = legacy || label === 'Last answer'
  const stamp = formatStamp(item.ts)
  return (
    <button
      type="button"
      data-pressable
      className={cn('handoff-transcript-card', answer && 'handoff-transcript-card--answer')}
      onClick={onOpen}
      aria-label={`${legacy ? 'Latest reply' : label} in session ${reference}`}
    >
      <ReadoutMarkdown text={item.text} clamp={label !== 'Last prompt'} />
      <span className="handoff-transcript-meta">
        <span>{reference}</span>
        {stamp && <span className="tabular-nums">{stamp}</span>}
        <span>{answer ? 'open answer' : 'open prompt'}</span>
        {fresh && <span className="handoff-transcript-fresh">New since your last visit</span>}
      </span>
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
  tone,
  future = false,
  text,
  onOpen,
}: {
  issue: IssueNavigationModel
  session?: SessionMeta
  state: string
  attention?: boolean
  tone?: 'working' | 'review' | 'attention' | 'done'
  future?: boolean
  text: string
  onOpen: () => void
}): JSX.Element {
  const reference = issueDisplayRef(issue)
  return (
    <button
      type="button"
      data-pressable
      onClick={onOpen}
      className="handoff-entry"
      aria-label={`${reference} ${issue.title}${session ? `, session ${sessionRef(session)}` : ''}, ${state}. ${text}`}
    >
      <span className="handoff-entry-time">{state}</span>
      <span
        aria-hidden
        className={cn(
          'handoff-entry-node',
          tone && `handoff-entry-node--${tone}`,
          future && 'handoff-entry-node--future',
        )}
      />
      <span className="handoff-entry-copy">
        <span className="handoff-entry-title">
          <span>{reference}</span> {issue.title}
        </span>
        <span className="handoff-entry-body">{text}</span>
        {session && <span className="handoff-entry-meta">{sessionRef(session)} · open session</span>}
      </span>
      <span
        className={cn(
          'handoff-entry-badge',
          tone && `handoff-entry-badge--${tone}`,
          attention && 'handoff-entry-badge--attention',
          future && 'handoff-entry-badge--future',
        )}
      >
        {future ? 'condition' : state}
      </span>
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
  const promptStamp = formatStamp(pair?.prompt.item.ts)
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
    <div className="handoff-view" data-testid="flight-deck-handoff">
      <section className="handoff-return-brief">
        <div className="handoff-return-brief-head">
          <h3>Last update</h3>
          {formatStamp(rootIssue.notesUpdatedAt) && (
            <span className="tabular-nums">{formatStamp(rootIssue.notesUpdatedAt)}</span>
          )}
        </div>
        {rootIssue.activityNotes?.trim() ? (
          <div className="handoff-return-copy">
            <ReadoutMarkdown text={rootIssue.activityNotes.trim()} />
          </div>
        ) : (
          <p className="handoff-empty">No issue update has been recorded.</p>
        )}
      </section>

      <HandoffSection
        title="Last prompt"
        meta={
          transcript.session
            ? `${sessionRef(transcript.session)}${promptStamp ? ` · ${promptStamp}` : ''}`
            : undefined
        }
      >
        <div aria-live="polite">
          {transcript.status === 'loading' && !transcript.pair ? (
            <p className="handoff-empty">Loading latest prompt…</p>
          ) : pair && transcript.session ? (
            <TranscriptCard
              label="Last prompt"
              session={transcript.session}
              item={pair.prompt.item}
              onOpen={() => onOpenTranscript(pair.sessionId, pair.prompt.anchor.itemKey)}
            />
          ) : transcript.status === 'error' ? (
            <div className="handoff-error">
              <p>Couldn't load the latest transcript.</p>
              <button
                type="button"
                data-pressable
                onClick={transcript.retry}
              >
                Retry
              </button>
            </div>
          ) : (
            <p className="handoff-empty">No operator prompt is recorded for this mission.</p>
          )}
        </div>
      </HandoffSection>

      <HandoffSection
        title={answer?.legacy ? 'Latest reply' : 'Last answer'}
        meta={pair ? 'reply to that prompt' : undefined}
      >
        <div aria-live="polite">
          {transcript.status === 'loading' && !transcript.pair ? (
            <p className="handoff-empty">Loading latest answer…</p>
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
            <p className="handoff-empty">No final answer yet.</p>
          ) : (
            <p className="handoff-empty">No final answer yet.</p>
          )}
        </div>
      </HandoffSection>

      <div className="handoff-now-divider">
        <span>Now · issue and session state</span>
      </div>

      <HandoffSection
        title="What is happening"
        meta={`${summary.computing} ${summary.computing === 1 ? 'session' : 'sessions'} computing`}
      >
        <p className="handoff-status-summary">{summaryParts.slice(1).join(' · ')}</p>
        {current.length === 0 ? (
          <p className="handoff-empty">
            No work needs explanation right now.
          </p>
        ) : (
          <div className="handoff-events">
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
                  state={state.toLowerCase()}
                  attention={entry.kind === 'needs-you'}
                  tone={
                    entry.kind === 'working'
                      ? 'working'
                      : entry.kind === 'review'
                        ? 'review'
                        : entry.kind === 'needs-you'
                          ? 'attention'
                          : undefined
                  }
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

      <HandoffSection title="What happens next" meta="recorded conditions, no dates" future>
        {next.length === 0 ? (
          <p className="handoff-empty">No recorded next condition.</p>
        ) : (
          <div className="handoff-events">
            {next.slice(0, nextLimit).map((entry, index) => {
              const issue = issueById.get(entry.issueId)
              if (!issue) return null
              const session = entry.sessionId ? sessionById.get(entry.sessionId) : undefined
              return (
                <HandoffEntry
                  key={`${entry.issueId}:${entry.afterIssueId ?? 'ready'}`}
                  issue={issue}
                  session={session}
                  state={index === 0 ? 'next' : index === 1 ? 'then' : 'after gates'}
                  future
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

      {proposed && <div className="handoff-proposals">{proposed}</div>}
    </div>
  )
}

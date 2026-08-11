import { relativeTime } from '@podium/client-core/focus'
import { operationalState } from '@podium/client-core/viewmodels'
import type { SessionMeta } from '@podium/model'
import { issueDisplayRef } from '@podium/protocol'
import { Search, X } from 'lucide-react'
import type { JSX } from 'react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { type IssueViewModel, useReplicaIssues, useStoreSelector } from '@/app/store'
import { cn } from '@/lib/utils'
import { DOCK_ROW, DOCK_STAMP } from '../IssueCompactControls'
import { issueIdTitle } from '../issue-card'
import { StageGlyph } from '../issue-glyphs'
import { ISSUE_RENDER_CHUNK, nextProgressiveRenderLimit } from '../progressive-render'
import { useIssueExplorer } from './explorer-context'
import { defaultTab, EXPLORER_TABS, explorerCounts, explorerRows } from './explorer-list'

/**
 * Level 0 — every task in the repo, searchable, bucketed by stage.
 *
 * The tab strip scrolls horizontally and snaps, because seven buckets do not
 * fit a 316px dock and a strip that wraps to two rows would cost the list a
 * row of its own. It fades where it runs on rather than clipping flat, so a
 * half-visible tab reads as more to scroll instead of as a layout that ran out.
 */
export function IssueExplorerList(): JSX.Element {
  const { tab: pickedTab, setTab, query, setQuery, push } = useIssueExplorer()
  const sessions = useStoreSelector((s) => s.sessions)
  const issues = useReplicaIssues()
  const inputRef = useRef<HTMLInputElement>(null)

  const counts = useMemo(() => explorerCounts(issues, sessions), [issues, sessions])
  // Until the operator picks a bucket, open on the first one with anything in
  // it: landing on an empty In progress teaches nothing about a repo with
  // hundreds of tasks in it.
  const tab = pickedTab ?? defaultTab(counts)
  // The stage buckets partition the listable set, so their sum is the honest
  // total — `issues.length` would have counted archived work the list refuses
  // to show and promised a search wider than the one it runs.
  const total = EXPLORER_TABS.reduce((n, t) => (t.id === 'needs' ? n : n + counts[t.id]), 0)
  const rows = useMemo(
    () => explorerRows(issues, sessions, { tab, query }),
    [issues, sessions, tab, query],
  )
  const searching = query.trim().length > 0

  // ONE pass for the whole list, not one per row. `operationalState` needs the
  // task's sessions and an id map, and resolving those inside the row made a
  // 450-row stage O(n²) — the Done tab alone would have built 450 maps over
  // every issue in the repo.
  const byId = useMemo(() => new Map(issues.map((i) => [i.id, i])), [issues])
  const rowSessions = useMemo(() => {
    const map = new Map<string, SessionMeta[]>()
    const memberOf = new Map<string, string>()
    for (const issue of issues) {
      for (const id of issue.memberSessionIds ?? []) memberOf.set(id, issue.id)
    }
    for (const session of sessions) {
      const owner = session.issueId ?? memberOf.get(session.sessionId)
      if (!owner) continue
      const list = map.get(owner)
      if (list) list.push(session)
      else map.set(owner, [session])
    }
    return map
  }, [issues, sessions])

  // A stage in this repo can hold several hundred tasks, so the list mounts a
  // bounded prefix and says what it is holding back — the same progressive
  // boundary the board uses [spec:SP-d562], not a silent truncation.
  const [revealed, setRevealed] = useState(ISSUE_RENDER_CHUNK * 3)
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new list starts at the top
  useEffect(() => setRevealed(ISSUE_RENDER_CHUNK * 3), [tab, query])
  const shown = rows.slice(0, revealed)

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="explorer-list">
      <div className="flex-none px-2.5 pt-2 pb-1.5">
        <div className="flex h-7 items-center gap-1.5 rounded-md border border-input bg-background px-2 focus-within:ring-2 focus-within:ring-ring/40">
          <Search size={12} className="flex-none text-text-faint" aria-hidden="true" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape' && query) {
                e.stopPropagation()
                setQuery('')
              }
            }}
            spellCheck={false}
            aria-label="Search tasks"
            placeholder={`Search all ${total} tasks`}
            className="min-w-0 flex-1 bg-transparent text-[12px] text-foreground outline-none placeholder:text-text-faint"
          />
          {searching && (
            <button
              data-pressable
              type="button"
              aria-label="Clear search"
              title="Clear search"
              className="flex size-4 flex-none items-center justify-center rounded-sm text-text-faint hover:bg-accent hover:text-foreground"
              onClick={() => {
                setQuery('')
                inputRef.current?.focus()
              }}
            >
              <X size={10} aria-hidden="true" />
            </button>
          )}
        </div>
      </div>

      {/* A scrolling strip of filter buttons over ONE list region, not a
          tabpanel switcher — there is no panel per tab to point at. */}
      <div className="explorer-tabs flex-none" role="tablist" aria-label="Task stage">
        {EXPLORER_TABS.map((entry) => {
          const selected = !searching && tab === entry.id
          return (
            <button
              data-pressable
              key={entry.id}
              type="button"
              role="tab"
              aria-selected={selected}
              className="explorer-tab"
              onClick={() => {
                setTab(entry.id)
                setQuery('')
              }}
            >
              {entry.label}
              <span
                className={cn(
                  'font-mono text-[9px] tabular-nums',
                  // The attention count is the one number here that is asking
                  // something; every other tab count is inventory.
                  entry.id === 'needs' && counts.needs > 0
                    ? 'font-bold text-attention'
                    : 'text-text-dim',
                )}
              >
                {counts[entry.id]}
              </span>
            </button>
          )
        })}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto pb-3" data-dock-scroll="">
        {searching && (
          <div className="border-b border-hairline-soft px-2.5 py-1.5 font-mono text-[9.5px] text-text-dim">
            {rows.length === 0
              ? `No task matches “${query.trim()}”`
              : `${rows.length} ${rows.length === 1 ? 'match' : 'matches'} across every stage`}
          </div>
        )}
        {rows.length === 0 ? (
          <EmptyList searching={searching} onClear={() => setQuery('')} tab={tab} />
        ) : (
          shown.map((issue) => (
            <ExplorerRow
              key={issue.id}
              issue={issue}
              state={operationalState(issue, rowSessions.get(issue.id) ?? [], byId)}
              onOpen={() => push(issue.id)}
            />
          ))
        )}
        {rows.length > shown.length && (
          <button
            data-pressable
            type="button"
            data-testid="explorer-more"
            onClick={() => setRevealed((n) => nextProgressiveRenderLimit(n, rows.length))}
            className="w-full px-2.5 py-2 text-left font-mono text-[11px] leading-none text-text-dim hover:text-foreground"
          >
            <span className="mr-1">›</span>
            {rows.length - shown.length} more
          </button>
        )}
      </div>
    </div>
  )
}

function EmptyList({
  searching,
  tab,
  onClear,
}: {
  searching: boolean
  tab: string
  onClear: () => void
}): JSX.Element {
  return (
    <div className="px-3 py-4">
      <p className="text-[11.5px] text-muted-foreground">
        {searching
          ? 'Nothing here by that name or ref.'
          : tab === 'needs'
            ? 'Nothing is waiting on you.'
            : 'No task is in this stage.'}
      </p>
      {searching && (
        <button
          data-pressable
          type="button"
          onClick={onClear}
          className="mt-1.5 text-[11px] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
        >
          Clear search
        </button>
      )}
    </div>
  )
}

/** One task line — the unified row the rest of the shell uses: stage glyph,
 *  ref, title, and the one state word on the right. The state is resolved by
 *  the list, in one pass over every row. */
function ExplorerRow({
  issue,
  state,
  onOpen,
}: {
  issue: IssueViewModel
  state: { state: string; label: string }
  onOpen: () => void
}): JSX.Element {
  const closed = issue.stage === 'done' || Boolean(issue.closedReason)
  const needs = state.state === 'needs-you'
  return (
    <button
      data-pressable
      type="button"
      onClick={onOpen}
      data-needs-you={needs || undefined}
      data-testid="explorer-row"
      title={`${issueDisplayRef(issue)} ${issue.title}`}
      className={cn(
        DOCK_ROW,
        'grid min-h-[30px] w-full grid-cols-[14px_minmax(0,1fr)_auto] items-center gap-2 border-b border-hairline-soft px-2.5 py-1 text-left hover:bg-accent/40',
      )}
    >
      <StageGlyph stage={issue.stage} size={13} />
      <span className="min-w-0 truncate">
        <span
          className="mr-1.5 font-mono text-[9.5px] text-muted-foreground"
          title={issueIdTitle(issue)}
        >
          {issueDisplayRef(issue)}
        </span>
        <span
          className={cn(
            closed && 'text-muted-foreground line-through decoration-muted-foreground/40',
          )}
        >
          {issue.title}
        </span>
      </span>
      <span
        className={cn(
          DOCK_STAMP,
          'flex-none',
          needs ? 'font-semibold text-attention' : 'text-text-dim',
        )}
      >
        {needs ? state.label : relativeTime(issue.updatedAt, Date.now())}
      </span>
    </button>
  )
}

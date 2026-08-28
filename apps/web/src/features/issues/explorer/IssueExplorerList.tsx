import { relativeTime } from '@podium/client-core/focus'
import { operationalState } from '@podium/client-core/viewmodels'
import type { SessionMeta } from '@podium/model/browser'
import { issueDisplayRef } from '@podium/protocol'
import { Search, X } from 'lucide-react'
import type { JSX } from 'react'
import { useLayoutEffect, useMemo, useRef } from 'react'
import { type IssueViewModel, useReplicaIssues, useStoreSelector } from '@/app/store'
import { GhostBar, GhostPreview, GhostSquare } from '@/components/GhostPreview'
import { cn } from '@/lib/utils'
import { DOCK_ROW, DOCK_STAMP } from '../IssueCompactControls'
import { IssueStatusPicker } from '../IssueStatusPicker'
import { issueIdTitle } from '../issue-card'
import { useBoundedVirtualList } from '../use-bounded-virtual-list'
import { useIssueStatusApply } from '../use-issue-status-apply'
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
  const {
    tab: pickedTab,
    setTab,
    query,
    setQuery,
    push,
    listScrollTop,
    rememberListScrollTop,
  } = useIssueExplorer()
  const sessions = useStoreSelector((s) => s.sessions)
  const issues = useReplicaIssues()
  // One apply and one close guard for every row's status glyph (POD-1271) —
  // held here rather than per row, which the virtualizer would unmount.
  const rowStatus = useIssueStatusApply()
  const inputRef = useRef<HTMLInputElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const listRef = useRef<HTMLUListElement>(null)

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

  const rowIds = useMemo(() => rows.map((issue) => issue.id), [rows])
  const virtual = useBoundedVirtualList({
    keys: rowIds,
    scrollRef,
    containerRef: listRef,
    estimateSize: 31,
  })
  const scrollScope = searching ? `search:${query.trim()}` : `tab:${tab}`
  useLayoutEffect(() => {
    const node = scrollRef.current
    if (!node) return
    node.scrollTop = listScrollTop(scrollScope)
    node.dispatchEvent(new Event('scroll'))
  }, [scrollScope, listScrollTop])

  // NOTHING LISTABLE IN THE REPO — not "this stage is empty" and not "that
  // search found nothing" (POD-1058). The three need different words, and only
  // this one gets an explanation of what the pane is for: the dock is closed on
  // a fresh install, so this is the state behind the first click and it has to
  // earn the click.
  const barren = total === 0

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="explorer-list">
      {barren && (
        <div className="flex-none px-2.5 pt-4 pb-1" data-testid="explorer-empty-copy">
          <p className="text-[15px] leading-[1.3] font-semibold tracking-[-.02em] text-text-strong">
            No tasks yet
          </p>
          {/* Says what the PANE is, not what the selected task is. Level 0 here
              is every task in the repo — an empty state that talked about "the
              task you picked" would be describing the level below it. */}
          <p className="mt-1.5 text-[12px] leading-[1.55] text-muted-foreground text-pretty">
            Every task in the project lives here — yours and everyone else’s. Search it, browse it
            by stage, open one for the detail.
          </p>
        </div>
      )}
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
            // The field stays ENABLED at zero — typing a ref is how people
            // arrive here, and a disabled input would make this look like a
            // different pane from the one that appears once tasks exist. Only
            // the promise of a count goes, because "all 0 tasks" is a joke.
            placeholder={barren ? 'Search tasks' : `Search all ${total} tasks`}
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
                  'font-mono shell-type-micro tabular-nums',
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

      <div
        ref={scrollRef}
        className="min-h-0 flex-1 overflow-y-auto pb-3"
        data-dock-scroll=""
        onScroll={(event) => rememberListScrollTop(scrollScope, event.currentTarget.scrollTop)}
      >
        {searching && (
          <div className="border-b border-hairline-soft px-2.5 py-1.5 font-mono shell-type-micro text-text-dim">
            {rows.length === 0
              ? `No task matches “${query.trim()}”`
              : `${rows.length} ${rows.length === 1 ? 'match' : 'matches'} across every stage`}
          </div>
        )}
        {rows.length === 0 ? (
          barren && !searching ? (
            <GhostRows />
          ) : (
            <EmptyList searching={searching} onClear={() => setQuery('')} tab={tab} />
          )
        ) : (
          <ul
            ref={listRef}
            className="relative m-0 list-none p-0"
            style={{ height: virtual.totalSize }}
            aria-label="Tasks"
          >
            {virtual.items.map((item) => {
              const issue = rows[item.index] as IssueViewModel
              return (
                <li
                  key={issue.id}
                  ref={virtual.measureRef(issue.id)}
                  className="absolute inset-x-0 top-0"
                  style={{ transform: `translateY(${item.start}px)` }}
                  aria-posinset={item.index + 1}
                  aria-setsize={rows.length}
                >
                  <ExplorerRow
                    issue={issue}
                    state={operationalState(issue, rowSessions.get(issue.id) ?? [], byId)}
                    onOpen={() => push(issue.id)}
                    onStatusPick={(value) => rowStatus.pick(issue, value)}
                  />
                </li>
              )
            })}
          </ul>
        )}
      </div>
      {rowStatus.dialog}
    </div>
  )
}

/**
 * The ghost list under the stage strip (POD-1058).
 *
 * Mirrors `ExplorerRow` exactly — 30px band, hairline rule, stage glyph, ref
 * chip, title, right-hand stamp — so the first real task lands on the slot its
 * ghost was holding. Top-aligned, filling downward, because that is the
 * direction rows arrive from.
 *
 * The honest `0` on every stage tab directly above it is what stops these five
 * bands from being read as five tasks.
 */
function GhostRows(): JSX.Element {
  const rows: Array<{ tier: 1 | 2 | 3 | 4; width: string; meta?: number }> = [
    { tier: 1, width: '72%', meta: 20 },
    { tier: 2, width: '84%', meta: 14 },
    { tier: 3, width: '58%' },
    { tier: 4, width: '77%' },
    { tier: 4, width: '46%' },
  ]
  return (
    <GhostPreview className="flex flex-col" hold="40%" fadeTo="94%" testId="explorer-ghost-rows">
      {rows.map(({ tier, width, meta }) => (
        <div
          key={`${tier}-${width}`}
          className="flex h-[30px] min-w-0 items-center gap-2 border-b border-hairline-soft px-2.5"
        >
          <GhostSquare tier={tier} size={11} />
          <GhostBar tier={tier} width="38px" height={9} className="flex-none" />
          <GhostBar tier={Math.min(tier + 1, 4) as 1 | 2 | 3 | 4} width={width} height={9} />
          <span className="flex-1" />
          {meta !== undefined && (
            <GhostBar tier={4} width={`${meta}px`} height={9} className="flex-none" />
          )}
        </div>
      ))}
    </GhostPreview>
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
  onStatusPick,
}: {
  issue: IssueViewModel
  state: { state: string; label: string }
  onOpen: () => void
  /** The row's status glyph is its picker (POD-1271); the list applies the pick. */
  onStatusPick: (value: string) => void
}): JSX.Element {
  const closed = issue.stage === 'done' || Boolean(issue.closedReason)
  // An errored task is a needs-you with a cause (POD-1601): the row's own
  // `data-needs-you` tint is what makes it findable in a long list, and an
  // agent that died is exactly the row you would rather not scroll past.
  const errored = state.state === 'error'
  const needs = state.state === 'needs-you' || errored
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
      <IssueStatusPicker issue={issue} size={13} onPick={onStatusPick} />
      <span className="min-w-0 truncate">
        <span
          className="mr-1.5 font-mono shell-type-micro text-muted-foreground"
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
        {issue.archived && (
          <span className="ml-1.5 font-mono shell-type-micro text-text-faint uppercase tracking-[0.04em]">
            archived
          </span>
        )}
      </span>
      <span
        className={cn(
          DOCK_STAMP,
          'flex-none',
          // Amber asks, red broke. `Agent overloaded` in the same ochre as
          // `Needs you` reads as one more thing in the queue; in red it reads as
          // the thing that stopped (POD-1601).
          errored ? 'font-semibold text-destructive' : undefined,
          needs && !errored ? 'font-semibold text-attention' : undefined,
          !needs && 'text-text-dim',
        )}
      >
        {needs ? state.label : relativeTime(issue.updatedAt, Date.now())}
      </span>
    </button>
  )
}

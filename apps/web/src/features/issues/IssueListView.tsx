import { type IssueId, type IssueStage, issueStatusOf } from '@podium/model/browser'
import { ChevronDown, ChevronRight, Plus } from 'lucide-react'
import {
  type CSSProperties,
  type JSX,
  type MouseEvent as ReactMouseEvent,
  type RefObject,
  useCallback,
  useMemo,
  useRef,
} from 'react'
import { Badge } from '@/components/ui/badge'
import { issueColorHex } from '@/lib/issueColors'
import { useNow } from '@/lib/useNow'
import { cn } from '@/lib/utils'
import { cardAge, issueCardModel, issueIdTitle, STAGE_LABELS } from './issue-card'
import { AssigneeAvatar, PriorityGlyph, StageGlyph, StatusGlyph } from './issue-glyphs'
import { type IssueRow, isEpic } from './issue-hierarchy'
import type { IssuesDisplay } from './issues-display'
import { useBoundedVirtualList } from './use-bounded-virtual-list'

/**
 * Linear-style list: rows grouped by stage under sticky group headers. Rows come
 * pre-computed (`issueRowsByStage` in the parent) so the render, the keyboard
 * nav, and the flatten toggle all agree on the visible order. Parent rows with
 * children get a chevron that expands nested (indented) child rows.
 */
export function IssueListView({
  groups,
  display,
  onOpen,
  onCreateIn,
  focusId,
  selected,
  onToggleSelect,
  onToggleExpand,
  onContextMenu,
  initialScrollTop = 0,
  onScrollTop,
}: {
  groups: { stage: IssueStage; rows: IssueRow[] }[]
  display: IssuesDisplay
  onOpen: (id: IssueId) => void
  onCreateIn: (stage: IssueStage) => void
  focusId: string | null
  selected: string[]
  onToggleSelect: (id: IssueId) => void
  onToggleExpand: (id: IssueId) => void
  onContextMenu: (id: IssueId, e: ReactMouseEvent) => void
  initialScrollTop?: number
  onScrollTop?: (top: number) => void
}): JSX.Element {
  // Row ages tick at minute granularity, as they do on the board — a list of
  // 140 rows must not repaint every second to move one digit.
  const now = useNow(60_000)
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const restoredRef = useRef(false)
  const setScrollRef = useCallback(
    (node: HTMLDivElement | null): void => {
      scrollRef.current = node
      if (node && !restoredRef.current) {
        restoredRef.current = true
        node.scrollTop = initialScrollTop
      }
    },
    [initialScrollTop],
  )
  return (
    <div
      ref={setScrollRef}
      className="min-h-0 flex-1 overflow-y-auto"
      data-testid="issues-list"
      onScroll={(event) => onScrollTop?.(event.currentTarget.scrollTop)}
    >
      {groups.map(({ stage, rows }) => {
        if (rows.length === 0) return null
        return (
          <section key={stage} aria-label={STAGE_LABELS[stage]}>
            {/* The group header IS the board's column header — same datum
                height, same glyph size, same 12/600 label over a 10px mono
                count, same `+`. The two layouts are one index, and an operator
                who switches between them should not have to re-learn where the
                stage name lives. It also drops a translucent blurred bar that
                floated over the rows, which The Carved Rule does not license
                for a resting surface. */}
            <div className="group sticky top-0 z-10 flex h-(--section-bar-h) select-none items-center gap-2 border-hairline-bar border-b bg-bar px-4">
              <StageGlyph stage={stage} size={13} />
              <h3 className="font-semibold text-[12px] text-foreground">{STAGE_LABELS[stage]}</h3>
              {/* Count only issues that actually LIVE in this stage — an expanded
                  parent's foreign-stage children ride under it visually but must
                  not inflate the header ("Backlog · 5" with 2 in-progress kids). */}
              <span className="font-mono text-[10px] text-text-dim tabular-nums">
                {rows.filter((r) => r.issue.stage === stage).length}
              </span>
              <button
                data-pressable
                type="button"
                className="ml-auto grid size-[24px] place-items-center rounded-[6px] text-text-faint opacity-55 transition-[opacity,background-color,color] hover:bg-accent hover:text-foreground hover:opacity-100 focus-visible:opacity-100 group-hover:opacity-100"
                title={`New task in ${STAGE_LABELS[stage]}`}
                aria-label={`New task in ${STAGE_LABELS[stage]}`}
                onClick={() => onCreateIn(stage)}
              >
                <Plus size={13} aria-hidden="true" />
              </button>
            </div>
            <VirtualStageRows
              stage={stage}
              rows={rows}
              scrollRef={scrollRef}
              display={display}
              focusId={focusId}
              selected={selected}
              onOpen={onOpen}
              onToggleSelect={onToggleSelect}
              onToggleExpand={onToggleExpand}
              onContextMenu={onContextMenu}
              now={now}
            />
          </section>
        )
      })}
    </div>
  )
}

function VirtualStageRows({
  stage,
  rows,
  scrollRef,
  display,
  focusId,
  selected,
  onOpen,
  onToggleSelect,
  onToggleExpand,
  onContextMenu,
  now,
}: {
  stage: IssueStage
  rows: IssueRow[]
  scrollRef: RefObject<HTMLElement | null>
  display: IssuesDisplay
  focusId: string | null
  selected: string[]
  onOpen: (id: IssueId) => void
  onToggleSelect: (id: IssueId) => void
  onToggleExpand: (id: IssueId) => void
  onContextMenu: (id: IssueId, e: ReactMouseEvent) => void
  now: number
}): JSX.Element {
  const containerRef = useRef<HTMLUListElement | null>(null)
  const ids = useMemo(() => rows.map((row) => row.issue.id), [rows])
  const virtual = useBoundedVirtualList({
    keys: ids,
    scrollRef,
    containerRef,
    estimateSize: 37,
    pinnedKeys: [focusId],
  })
  return (
    <ul
      ref={containerRef}
      className="relative m-0 list-none p-0"
      style={{ height: virtual.totalSize }}
      aria-label={`${STAGE_LABELS[stage]} tasks`}
    >
      {virtual.items.map((item) => {
        const { issue, depth, childCount, expanded } = rows[item.index] as IssueRow
        const m = issueCardModel(issue)
        const epic = isEpic(issue)
        const hex = issueColorHex(issue.color)
        const isSelected = selected.includes(issue.id)
        return (
          <li
            key={issue.id}
            ref={virtual.measureRef(issue.id)}
            className="absolute inset-x-0 top-0"
            style={{ transform: `translateY(${item.start}px)` }}
            aria-posinset={item.index + 1}
            aria-setsize={rows.length}
          >
            <button
              data-pressable
              type="button"
              data-issue-id={issue.id}
              className={cn(
                'issue-scope flex w-full items-center gap-2.5 border-hairline-soft border-b px-4 py-2 text-left',
                'transition-colors duration-150',
                focusId === issue.id && 'ring-1 ring-[var(--issue)]/60 ring-inset',
                !isSelected && 'hover:issue-mix-6',
                isSelected && 'issue-mix-20 hover:issue-mix-26',
              )}
              style={{
                ...(depth > 0 ? { paddingLeft: `${16 + depth * 22}px` } : {}),
                ...(hex ? ({ '--issue': hex } as CSSProperties) : {}),
              }}
              data-issue-colored={hex ? 'true' : 'false'}
              title={issueIdTitle(issue)}
              onClick={(e) => (e.shiftKey ? onToggleSelect(issue.id) : onOpen(issue.id))}
              onContextMenu={(e) => onContextMenu(issue.id, e)}
            >
              {/* The disclosure slot is drawn whether or not the row has
                      one. It used to be omitted on childless rows, so a parent
                      pushed its own priority glyph, ref and title ~20px right of
                      every leaf around it and the list had no left edge at all
                      — the raggedness read as accidental indentation. */}
              <span className="flex size-4 flex-none items-center justify-center">
                {childCount > 0 ? (
                  // biome-ignore lint/a11y/useSemanticElements: a real <button data-pressable> here would nest inside the row's <button data-pressable> (invalid markup) — same pattern as the card's AssigneeMenu trigger
                  <span
                    data-pressable
                    role="button"
                    tabIndex={0}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter' || event.key === ' ') {
                        event.preventDefault()
                        event.currentTarget.click()
                      }
                    }}
                    className="grid size-4 flex-none place-items-center rounded-[3px] text-muted-foreground/70 hover:bg-muted hover:text-foreground"
                    aria-expanded={expanded}
                    aria-label={expanded ? `Collapse ${issue.title}` : `Expand ${issue.title}`}
                    onClick={(e) => {
                      e.stopPropagation()
                      onToggleExpand(issue.id)
                    }}
                  >
                    {expanded ? (
                      <ChevronDown size={13} aria-hidden="true" />
                    ) : (
                      <ChevronRight size={13} aria-hidden="true" />
                    )}
                  </span>
                ) : (
                  depth > 0 && (
                    // Child rows show their own stage glyph — a nested child may
                    // live in a different stage than the parent's group.
                    <StatusGlyph status={issueStatusOf(issue)} size={12} />
                  )
                )}
              </span>
              <PriorityGlyph priority={issue.priority} size={12} />
              {/* An ID is the machine talking about itself, so it is set in
                      the mono voice at the board's size and ink rather than in
                      13px sans. */}
              <span className="w-[54px] shrink-0 whitespace-nowrap font-mono text-[10px] text-[var(--issue-dim)] tabular-nums">
                {m.seqLabel}
              </span>
              <span className="min-w-0 flex-1 truncate text-[13px]">{m.title}</span>
              {/* `deleted` and `epic` are the board's own tokens: mono,
                      lowercase-set-uppercase, no pill. A violet outline badge
                      was a hue the palette does not contain, and two word-pills
                      per row out-weighed the title they annotate. */}
              {issue.deletedAt && (
                <span className="flex-none font-mono text-[9.5px] text-destructive uppercase tracking-[0.08em]">
                  deleted
                </span>
              )}
              {epic && (
                <span
                  className="flex-none font-mono text-[9.5px] text-[var(--issue-muted)] uppercase tracking-[0.08em]"
                  title="Epic"
                >
                  epic
                </span>
              )}
              {m.subProgress && (
                <span className="flex-none font-mono text-[10px] text-muted-foreground tabular-nums">
                  {m.subProgress.done}/{m.subProgress.total}
                </span>
              )}
              {display.badges.labels &&
                m.labels.slice(0, 2).map((l) => (
                  <Badge key={l} variant="secondary" className="hidden font-normal md:inline-flex">
                    {l}
                  </Badge>
                ))}
              {display.badges.due && m.dueLabel && (
                <span className="hidden font-mono text-[10px] text-muted-foreground md:inline">
                  {m.dueLabel}
                </span>
              )}
              {/* Recency in the board's words. The same task said "1d" on a
                      card and "Aug 5" one keystroke away in the list, which is
                      two vocabularies for one fact on one index — and a US
                      month/day format for an operator the app never asked. */}
              <span className="hidden w-8 shrink-0 text-right font-mono text-[10px] text-text-faint tabular-nums md:inline">
                {cardAge(issue.updatedAt, now)}
              </span>
              <AssigneeAvatar assignee={m.assignee} />
            </button>
          </li>
        )
      })}
    </ul>
  )
}

/**
 * THE BOARD (rebuilt, POD-591).
 *
 * Three things changed, and the first two are the ones you see:
 *
 * 1. THE COLUMNS ARE CARVED, NOT BOXED. Each column used to be a `bg-muted/40`
 *    rounded rectangle floating on the app background — the default Trello
 *    composition, and against DESIGN.md's Carved Rule, which says a resting
 *    surface separates from its neighbour by tone or engraving and never by
 *    lifting. They are now hairline-separated panes whose headers sit on the
 *    shell's `--section-bar-h` datum, so one seam runs across the board at the
 *    same height as every other column header in the app.
 *
 * 2. DRAGGING SHOWS WHERE THE CARD LANDS. Native HTML5 DnD gave no proxy, no
 *    insertion line and no reflow: the card simply teleported, and a 2px yellow
 *    ring — The Signal Rule's one voice — marked the column under the cursor.
 *    The gesture is now pointer-based: the card lifts into a portalled proxy
 *    with the popover shadow (the one elevation tier DESIGN.md licenses, because
 *    it will disappear), the target column takes an issue-tint wash, and a line
 *    opens at the index the drop will ACTUALLY produce — see `plannedDropIndex`,
 *    which simulates the sort rather than following the cursor.
 *
 * 3. THE COLUMN FILLS ITSELF. "Show 25 more tasks (115 remaining)" was a button
 *    between the operator and their own backlog. A sentinel at the foot of the
 *    column advances the same `progressiveRenderLimit` as it scrolls into view,
 *    so the bound still exists and focus/selection are still force-mounted — the
 *    click is what went.
 */
import type { IssueId, IssueStage, SessionMeta } from '@podium/model'
import { Plus } from 'lucide-react'
import type {
  CSSProperties,
  JSX,
  MouseEvent as ReactMouseEvent,
  PointerEvent as ReactPointerEvent,
} from 'react'
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { CardBoundary } from '@/app/CardBoundary'
import type { IssueViewModel } from '@/app/store'
import { useStoreSelector } from '@/app/store'
import { issueColorHex } from '@/lib/issueColors'
import { useNow } from '@/lib/useNow'
import { cn } from '@/lib/utils'
import { IssueCard } from './IssueCard'
import { STAGE_LABELS } from './issue-card'
import { StageGlyph } from './issue-glyphs'
import type { EpicProgress, IssuesDisplay, IssuesOrdering } from './issues-display'
import { dropTargetStage, passedDragThreshold, plannedDropIndex } from './kanban-dnd'
import {
  ISSUE_RENDER_CHUNK,
  nextProgressiveRenderLimit,
  progressiveRenderLimit,
} from './progressive-render'

export interface IssuesKanbanProps {
  columns: { stage: IssueStage; issues: IssueViewModel[] }[]
  allIssues: IssueViewModel[]
  badges: IssuesDisplay['badges']
  ordering: IssuesOrdering
  stageCounts: Map<string, { stage: IssueStage; count: number }[]>
  epicProgress: Map<string, EpicProgress | null>
  onOpen: (id: IssueId) => void
  onMoveIssue: (id: string, stage: IssueStage) => void
  onApprove: (id: IssueId) => void
  onCreateIn: (stage: IssueStage) => void
  focusId: string | null
  selected: string[]
  onToggleSelect: (id: IssueId) => void
  onContextMenu: (id: IssueId, event: ReactMouseEvent) => void
}

/** Live drag, or null. Held by the board so the proxy, the tinted column and the
 *  drop line all read one truth. */
interface DragState {
  issue: IssueViewModel
  /** Pointer offset inside the card when the press started, so the proxy sits
   *  under the finger rather than jumping its corner to it. */
  grab: { x: number; y: number }
  width: number
  at: { x: number; y: number }
  over: { stage: IssueStage; index: number } | null
}

export function IssuesKanban(props: IssuesKanbanProps): JSX.Element {
  const sessions = useStoreSelector((store) => store.sessions)
  // One index for the whole board; a card resolves its own members from it
  // rather than every card scanning the session list.
  const sessionById = useMemo(
    () => new Map((sessions ?? []).map((s) => [s.sessionId as string, s])),
    [sessions],
  )
  const sessionsFor = useCallback(
    (issue: IssueViewModel): SessionMeta[] =>
      (issue.memberSessionIds ?? [])
        .map((id) => sessionById.get(id))
        .filter((s): s is SessionMeta => s !== undefined),
    [sessionById],
  )
  // Card ages tick at minute granularity — the board is a scan surface, and a
  // per-second clock would repaint every card in every column.
  const now = useNow(60_000)

  const [drag, setDrag] = useState<DragState | null>(null)
  const dragRef = useRef<DragState | null>(null)
  dragRef.current = drag
  const columnsRef = useRef(props.columns)
  columnsRef.current = props.columns
  const orderingRef = useRef(props.ordering)
  orderingRef.current = props.ordering

  /** Begin a press. It only becomes a drag once the pointer passes the
   *  threshold, so a plain click still opens the issue. */
  const onDragStart = useCallback(
    (event: ReactPointerEvent, issue: IssueViewModel): void => {
      // Primary button only, and never from a nested control (those stop
      // propagation themselves).
      if (event.button !== 0) return
      const card = (event.currentTarget as HTMLElement).getBoundingClientRect()
      const origin = { x: event.clientX, y: event.clientY }
      const grab = { x: event.clientX - card.left, y: event.clientY - card.top }
      let armed = false

      const resolveOver = (x: number, y: number): DragState['over'] => {
        const under = document.elementFromPoint(x, y)
        const column = under?.closest('[data-kanban-column]')
        const stage = dropTargetStage(column?.getAttribute('data-kanban-column') ?? '')
        if (!stage) return null
        const target = columnsRef.current.find((c) => c.stage === stage)
        return {
          stage,
          index: plannedDropIndex(target?.issues ?? [], issue, stage, orderingRef.current),
        }
      }

      const onMove = (move: PointerEvent): void => {
        if (!armed) {
          if (!passedDragThreshold(move.clientX - origin.x, move.clientY - origin.y)) return
          armed = true
          document.body.style.cursor = 'grabbing'
        }
        setDrag({
          issue,
          grab,
          width: card.width,
          at: { x: move.clientX, y: move.clientY },
          over: resolveOver(move.clientX, move.clientY),
        })
      }

      const onUp = (): void => {
        window.removeEventListener('pointermove', onMove)
        window.removeEventListener('pointerup', onUp)
        window.removeEventListener('pointercancel', onUp)
        document.body.style.cursor = ''
        const state = dragRef.current
        setDrag(null)
        if (!armed || !state?.over) return
        if (state.over.stage !== issue.stage) props.onMoveIssue(issue.id, state.over.stage)
      }

      window.addEventListener('pointermove', onMove)
      window.addEventListener('pointerup', onUp)
      window.addEventListener('pointercancel', onUp)
    },
    [props.onMoveIssue],
  )

  // A drag must not also select text across the board.
  useEffect(() => {
    if (!drag) return
    const stop = (e: Event): void => e.preventDefault()
    window.addEventListener('selectstart', stop)
    return () => window.removeEventListener('selectstart', stop)
  }, [drag])

  return (
    <div className="flex min-h-0 flex-1 overflow-x-auto" data-testid="issues-board">
      {props.columns.map(({ stage, issues }) => (
        <IssueColumn
          key={stage}
          stage={stage}
          issues={issues}
          badges={props.badges}
          stageCounts={props.stageCounts}
          epicProgress={props.epicProgress}
          sessionsFor={sessionsFor}
          now={now}
          drag={drag}
          onOpen={props.onOpen}
          onApprove={props.onApprove}
          onCreateIn={props.onCreateIn}
          focusId={props.focusId}
          selected={props.selected}
          onToggleSelect={props.onToggleSelect}
          onContextMenu={props.onContextMenu}
          onDragStart={onDragStart}
        />
      ))}
      {drag && (
        <DragProxy drag={drag} sessions={sessionsFor(drag.issue)} badges={props.badges} now={now} />
      )}
    </div>
  )
}

/**
 * The lifted card under the cursor.
 *
 * Portalled to `document.body` so no scrolling or transformed ancestor can clip
 * it, and it is the one thing on the board allowed a drop shadow — The Carved
 * Rule reserves those for surfaces that will disappear, which is exactly what
 * this is. The 1.2° tilt is the only decorative degree in the gesture and it
 * earns its place: it says "held", which a flat copy of the card does not.
 */
function DragProxy({
  drag,
  sessions,
  badges,
  now,
}: {
  drag: DragState
  sessions: SessionMeta[]
  badges: IssuesDisplay['badges']
  now: number
}): JSX.Element {
  return createPortal(
    <div
      className="pointer-events-none fixed z-[90] rotate-[-1.2deg] scale-[1.02] opacity-95"
      style={{
        left: drag.at.x - drag.grab.x,
        top: drag.at.y - drag.grab.y,
        width: drag.width,
        boxShadow: 'var(--shadow-popover)',
      }}
      aria-hidden="true"
    >
      <IssueCard
        issue={drag.issue}
        sessions={sessions}
        badges={badges}
        focused={false}
        selected={false}
        dragging={false}
        now={now}
        onOpen={() => {}}
        onToggleSelect={() => {}}
        onContextMenu={() => {}}
        onDragStart={() => {}}
      />
    </div>,
    document.body,
  )
}

/** The line that opens where the card will land. */
function DropLine(): JSX.Element {
  return (
    <div
      className="my-px h-0.5 flex-none rounded-full bg-[var(--issue)]"
      style={{ boxShadow: '0 0 0 3px color-mix(in srgb, var(--issue) 18%, transparent)' }}
      data-testid="kanban-drop-line"
      aria-hidden="true"
    />
  )
}

function IssueColumn({
  stage,
  issues,
  badges,
  stageCounts,
  epicProgress,
  sessionsFor,
  now,
  drag,
  onOpen,
  onApprove,
  onCreateIn,
  focusId,
  selected,
  onToggleSelect,
  onContextMenu,
  onDragStart,
}: {
  stage: IssueStage
  issues: IssueViewModel[]
  badges: IssuesDisplay['badges']
  stageCounts: Map<string, { stage: IssueStage; count: number }[]>
  epicProgress: Map<string, EpicProgress | null>
  sessionsFor: (issue: IssueViewModel) => SessionMeta[]
  now: number
  drag: DragState | null
  onOpen: (id: IssueId) => void
  onApprove: (id: IssueId) => void
  onCreateIn: (stage: IssueStage) => void
  focusId: string | null
  selected: string[]
  onToggleSelect: (id: IssueId) => void
  onContextMenu: (id: IssueId, event: ReactMouseEvent) => void
  onDragStart: (event: ReactPointerEvent, issue: IssueViewModel) => void
}): JSX.Element {
  const scopeKey = issues.map((issue) => issue.id).join('\0')
  const scopeRef = useRef({ key: scopeKey, version: 0 })
  if (scopeRef.current.key !== scopeKey) {
    scopeRef.current = { key: scopeKey, version: scopeRef.current.version + 1 }
  }
  const scopeVersion = scopeRef.current.version
  const [reveal, setReveal] = useState({ scopeVersion, count: ISSUE_RENDER_CHUNK })
  const revealed = reveal.scopeVersion === scopeVersion ? reveal.count : ISSUE_RENDER_CHUNK
  const requiredIds = new Set(selected)
  if (focusId) requiredIds.add(focusId)
  const limit = progressiveRenderLimit(
    issues.map((issue) => issue.id),
    revealed,
    requiredIds,
  )
  const visibleIssues = issues.slice(0, limit)
  const remaining = issues.length - limit

  // Scroll-driven reveal: the sentinel sits under the last mounted card, so
  // reaching the foot of the column extends it by one chunk. No button, and the
  // bound is unchanged — a 140-card column still mounts 16 at a time.
  const sentinel = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    const node = sentinel.current
    if (!node || remaining <= 0) return
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) {
        setReveal((cur) => ({
          scopeVersion,
          count: nextProgressiveRenderLimit(
            cur.scopeVersion === scopeVersion ? cur.count : ISSUE_RENDER_CHUNK,
            issues.length,
          ),
        }))
      }
    })
    io.observe(node)
    return () => io.disconnect()
  }, [remaining, scopeVersion, issues.length])

  const label = STAGE_LABELS[stage]
  const over = drag?.over?.stage === stage ? drag.over : null
  const dragHex = drag ? issueColorHex(drag.issue.color) : undefined

  return (
    <div
      data-kanban-column={stage}
      data-testid="issue-column"
      className={cn(
        'issue-scope group/col flex w-[288px] min-w-[288px] flex-col border-border/60 border-r transition-colors duration-150',
        over && 'issue-mix-5',
      )}
      style={dragHex ? ({ '--issue': dragHex } as CSSProperties) : undefined}
      data-issue-colored={dragHex ? 'true' : 'false'}
    >
      <div
        className={cn(
          // `select-none`: the header is chrome, and chrome does not select —
          // a double-click near a column title must not leave "In Progress"
          // highlighted in a native window.
          'flex h-(--section-bar-h) flex-none select-none items-center gap-2 border-hairline-bar border-b bg-bar px-3 transition-colors duration-150',
          over && 'issue-mix-9',
        )}
      >
        <StageGlyph stage={stage} size={12} />
        <h3 className="font-semibold text-[11.5px] text-foreground">{label}</h3>
        <span className="font-mono text-[9.5px] text-text-dim tabular-nums">{issues.length}</span>
        <button
          data-pressable
          type="button"
          className="ml-auto grid size-[22px] place-items-center rounded-[5px] text-text-faint opacity-0 transition-[opacity,background-color,color] hover:bg-accent hover:text-foreground focus-visible:opacity-100 group-hover/col:opacity-100"
          title={`New task in ${label}`}
          aria-label={`New task in ${label}`}
          onClick={() => onCreateIn(stage)}
        >
          <Plus size={13} aria-hidden="true" />
        </button>
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-[5px] overflow-y-auto px-2.5 py-2">
        {issues.length === 0 && !over ? (
          <EmptyColumn label={label} onCreate={() => onCreateIn(stage)} />
        ) : (
          visibleIssues.map((issue, index) => (
            <Fragment key={issue.id}>
              {over?.index === index && <DropLine />}
              <CardBoundary resetKey={issue.id} label="issue card">
                <IssueCard
                  issue={issue}
                  sessions={sessionsFor(issue)}
                  badges={badges}
                  stageCounts={stageCounts.get(issue.id)}
                  progress={epicProgress.get(issue.id) ?? null}
                  focused={focusId === issue.id}
                  selected={selected.includes(issue.id)}
                  dragging={drag?.issue.id === issue.id}
                  now={now}
                  onOpen={onOpen}
                  {...(stage === 'proposed' ? { onApprove } : {})}
                  onToggleSelect={onToggleSelect}
                  onContextMenu={onContextMenu}
                  onDragStart={onDragStart}
                />
              </CardBoundary>
            </Fragment>
          ))
        )}
        {over && over.index >= visibleIssues.length && <DropLine />}
        {remaining > 0 && (
          <div
            ref={sentinel}
            className="flex-none py-2 text-center font-mono text-[9px] text-text-faint"
            data-testid="column-more"
          >
            {remaining} more
          </div>
        )}
      </div>
    </div>
  )
}

/** An empty column teaches instead of reporting. */
function EmptyColumn({ label, onCreate }: { label: string; onCreate: () => void }): JSX.Element {
  return (
    <div className="flex flex-col items-start gap-2 px-1 py-3">
      <p className="text-[11.5px] text-text-faint">Nothing in {label}.</p>
      <button
        data-pressable
        type="button"
        className="rounded-[4.8px] border border-border border-dashed px-2 py-1 text-[11px] text-text-dim transition-colors hover:border-border-strong hover:text-foreground"
        onClick={onCreate}
      >
        <Plus size={11} aria-hidden="true" className="mr-1 inline" />
        New task
      </button>
    </div>
  )
}

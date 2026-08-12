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
import type { IssueId, IssueStage, SessionMeta } from '@podium/model/browser'
import { Plus } from 'lucide-react'
import type {
  CSSProperties,
  JSX,
  MouseEvent as ReactMouseEvent,
  PointerEvent as ReactPointerEvent,
  RefObject,
} from 'react'
import { Fragment, memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
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
  onMoveIssue: (id: IssueId, stage: IssueStage) => void
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
  over: { stage: IssueStage; index: number } | null
}

type DragPoint = { x: number; y: number }

function sameDropTarget(a: DragState['over'], b: DragState['over']): boolean {
  return a === b || (a?.stage === b?.stage && a?.index === b?.index)
}

const NOOP = (): void => {}

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
  // A card's session array must be referentially stable while the board handles
  // sparse drag-state updates. Rebuilding it inside each column would defeat
  // the memoized card leaf even when no session membership changed.
  const sessionsByIssueId = useMemo(
    () => new Map(props.allIssues.map((issue) => [issue.id, sessionsFor(issue)])),
    [props.allIssues, sessionsFor],
  )
  // Card ages tick at minute granularity — the board is a scan surface, and a
  // per-second clock would repaint every card in every column.
  const now = useNow(60_000)

  const [drag, setDrag] = useState<DragState | null>(null)
  const proxyRef = useRef<HTMLDivElement | null>(null)
  const proxyPointRef = useRef<DragPoint>({ x: 0, y: 0 })
  const mountedRef = useRef(true)
  const activeCleanupRef = useRef<(() => void) | null>(null)
  const suppressClickRef = useRef(false)
  const suppressClickTimerRef = useRef<number | null>(null)
  const columnsRef = useRef(props.columns)
  columnsRef.current = props.columns
  const orderingRef = useRef(props.ordering)
  orderingRef.current = props.ordering
  const onMoveIssueRef = useRef(props.onMoveIssue)
  onMoveIssueRef.current = props.onMoveIssue

  useEffect(() => {
    // StrictMode rehearses setup → cleanup → setup. Restore the live marker on
    // every setup so the rehearsed cleanup cannot make a real drag's finish()
    // skip its lifecycle state update and strand the portalled proxy.
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      activeCleanupRef.current?.()
      if (suppressClickTimerRef.current !== null) {
        window.clearTimeout(suppressClickTimerRef.current)
      }
    }
  }, [])

  /** Begin a press. It only becomes a drag once the pointer passes the
   *  threshold, so a plain click still opens the issue. */
  const onDragStart = useCallback((event: ReactPointerEvent, issue: IssueViewModel): void => {
    // Primary button only, and never from a nested control (those stop
    // propagation themselves).
    if (event.button !== 0) return
    activeCleanupRef.current?.()
    const handle = event.currentTarget as HTMLElement
    const pointerId = event.pointerId
    const card = handle.getBoundingClientRect()
    const origin = { x: event.clientX, y: event.clientY }
    const grab = { x: event.clientX - card.left, y: event.clientY - card.top }
    let armed = false
    let finished = false
    let frame: number | null = null
    let latest = origin
    let currentOver: DragState['over'] = null

    try {
      handle.setPointerCapture(pointerId)
    } catch {
      // A disappearing handle can race pointer capture. Window listeners are
      // still the lifecycle backstop, including in DOM test environments.
    }

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

    const moveProxy = (point: DragPoint): void => {
      proxyPointRef.current = point
      if (proxyRef.current) {
        proxyRef.current.style.transform = `translate3d(${point.x - grab.x}px, ${point.y - grab.y}px, 0) rotate(-1.2deg) scale(1.02)`
      }
    }

    const publishOver = (over: DragState['over']): void => {
      if (sameDropTarget(currentOver, over)) return
      currentOver = over
      setDrag((value) => {
        if (!value || value.issue.id !== issue.id) return value
        return { ...value, over }
      })
    }

    const hitTest = (): void => {
      frame = null
      publishOver(resolveOver(latest.x, latest.y))
    }

    const requestHitTest = (): void => {
      if (frame === null) frame = window.requestAnimationFrame(hitTest)
    }

    const stopSelection = (selectionEvent: Event): void => selectionEvent.preventDefault()

    function cleanup(): void {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onCancel)
      handle.removeEventListener('lostpointercapture', onLostCapture)
      window.removeEventListener('selectstart', stopSelection)
      if (frame !== null) window.cancelAnimationFrame(frame)
      frame = null
      document.body.style.cursor = ''
      try {
        if (handle.hasPointerCapture(pointerId)) handle.releasePointerCapture(pointerId)
      } catch {
        // Capture may already have been released by the browser on pointerup.
      }
      if (activeCleanupRef.current === cancelActive) activeCleanupRef.current = null
    }

    function finish(cancelled: boolean, point?: DragPoint): void {
      if (finished) return
      finished = true
      if (armed && point && !cancelled) {
        latest = point
        currentOver = resolveOver(point.x, point.y)
      }
      cleanup()
      if (mountedRef.current) setDrag(null)
      if (!armed || cancelled) return

      // The pointerup-generated click follows this handler. Consume only
      // that click so a successful drag does not also open its card.
      suppressClickRef.current = true
      if (suppressClickTimerRef.current !== null) {
        window.clearTimeout(suppressClickTimerRef.current)
      }
      suppressClickTimerRef.current = window.setTimeout(() => {
        suppressClickRef.current = false
        suppressClickTimerRef.current = null
      }, 0)

      if (currentOver && currentOver.stage !== issue.stage) {
        onMoveIssueRef.current(issue.id, currentOver.stage)
      }
    }

    function onMove(move: PointerEvent): void {
      if (move.pointerId !== pointerId) return
      if (!armed) {
        if (!passedDragThreshold(move.clientX - origin.x, move.clientY - origin.y)) return
        armed = true
        document.body.style.cursor = 'grabbing'
        window.addEventListener('selectstart', stopSelection)
        setDrag({ issue, grab, width: card.width, over: null })
      }
      move.preventDefault()
      latest = { x: move.clientX, y: move.clientY }
      moveProxy(latest)
      requestHitTest()
    }

    function onUp(up: PointerEvent): void {
      if (up.pointerId !== pointerId) return
      finish(false, { x: up.clientX, y: up.clientY })
    }

    function onCancel(cancel: PointerEvent): void {
      if (cancel.pointerId === pointerId) finish(true)
    }

    function onLostCapture(lost: PointerEvent): void {
      if (lost.pointerId === pointerId) finish(true)
    }

    function cancelActive(): void {
      finish(true)
    }

    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onCancel)
    handle.addEventListener('lostpointercapture', onLostCapture)
    activeCleanupRef.current = cancelActive
  }, [])

  const selectedIds = useMemo(() => new Set(props.selected), [props.selected])
  const dragHex = drag ? issueColorHex(drag.issue.color) : undefined

  return (
    <div
      className="flex min-h-0 flex-1 overflow-x-auto"
      data-testid="issues-board"
      onClickCapture={(event) => {
        if (!suppressClickRef.current) return
        event.preventDefault()
        event.stopPropagation()
      }}
    >
      {props.columns.map(({ stage, issues }) => (
        <IssueColumn
          key={stage}
          stage={stage}
          issues={issues}
          badges={props.badges}
          stageCounts={props.stageCounts}
          epicProgress={props.epicProgress}
          sessionsByIssueId={sessionsByIssueId}
          now={now}
          drop={drag?.over?.stage === stage ? drag.over : null}
          draggedIssueId={drag?.issue.id ?? null}
          dragHex={dragHex}
          onOpen={props.onOpen}
          onApprove={props.onApprove}
          onCreateIn={props.onCreateIn}
          focusId={props.focusId}
          selectedIds={selectedIds}
          onToggleSelect={props.onToggleSelect}
          onContextMenu={props.onContextMenu}
          onDragStart={onDragStart}
        />
      ))}
      {drag && (
        <DragProxy
          drag={drag}
          point={proxyPointRef.current}
          proxyRef={proxyRef}
          sessions={sessionsByIssueId.get(drag.issue.id) ?? []}
          badges={props.badges}
          now={now}
        />
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
  point,
  proxyRef,
  sessions,
  badges,
  now,
}: {
  drag: DragState
  point: DragPoint
  proxyRef: RefObject<HTMLDivElement | null>
  sessions: SessionMeta[]
  badges: IssuesDisplay['badges']
  now: number
}): JSX.Element {
  return createPortal(
    <div
      ref={proxyRef}
      className="pointer-events-none fixed top-0 left-0 z-[90] opacity-95 will-change-transform"
      style={{
        width: drag.width,
        boxShadow: 'var(--shadow-popover)',
        transform: `translate3d(${point.x - drag.grab.x}px, ${point.y - drag.grab.y}px, 0) rotate(-1.2deg) scale(1.02)`,
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
        onOpen={NOOP}
        onToggleSelect={NOOP}
        onContextMenu={NOOP}
        onDragStart={NOOP}
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

const IssueColumn = memo(function IssueColumn({
  stage,
  issues,
  badges,
  stageCounts,
  epicProgress,
  sessionsByIssueId,
  now,
  drop,
  draggedIssueId,
  dragHex,
  onOpen,
  onApprove,
  onCreateIn,
  focusId,
  selectedIds,
  onToggleSelect,
  onContextMenu,
  onDragStart,
}: {
  stage: IssueStage
  issues: IssueViewModel[]
  badges: IssuesDisplay['badges']
  stageCounts: Map<string, { stage: IssueStage; count: number }[]>
  epicProgress: Map<string, EpicProgress | null>
  sessionsByIssueId: Map<IssueId, SessionMeta[]>
  now: number
  drop: DragState['over']
  draggedIssueId: IssueId | null
  dragHex: string | undefined
  onOpen: (id: IssueId) => void
  onApprove: (id: IssueId) => void
  onCreateIn: (stage: IssueStage) => void
  focusId: string | null
  selectedIds: Set<string>
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
  const requiredIds = new Set(selectedIds)
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
  const over = drop
  const createInStage = useCallback(() => onCreateIn(stage), [onCreateIn, stage])

  return (
    <div
      data-kanban-column={stage}
      data-testid="issue-column"
      className={cn(
        'issue-scope group/col flex w-[304px] min-w-[304px] flex-col border-border/55 border-r transition-colors duration-150',
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
          // px-3 is not a spacing preference: it is the card gutter below. The
          // stage glyph and the `+` sit on the exact edges the cards do, so one
          // left edge and one right edge run the whole height of the column.
          'flex h-(--section-bar-h) flex-none select-none items-center gap-2 border-hairline-bar border-b bg-bar px-3 transition-colors duration-150',
          over && 'issue-mix-9',
        )}
      >
        <StageGlyph stage={stage} size={13} />
        <h3 className="font-semibold text-[12px] text-foreground">{label}</h3>
        <span className="font-mono text-[10px] text-text-dim tabular-nums">{issues.length}</span>
        <button
          data-pressable
          type="button"
          className="ml-auto grid size-[24px] place-items-center rounded-[6px] text-text-faint opacity-55 transition-[opacity,background-color,color] hover:bg-accent hover:text-foreground hover:opacity-100 focus-visible:opacity-100 group-hover/col:opacity-100"
          title={`New task in ${label}`}
          aria-label={`New task in ${label}`}
          onClick={createInStage}
        >
          <Plus size={13} aria-hidden="true" />
        </button>
      </div>

      {/* `scroll-none`, not a stable scrollbar gutter: the gutter is reserved
          INSIDE the padding box, so every card sat 12px from the left edge of
          its column and 28px from the right — a 16px lean that no amount of
          card polish can correct. The sidebar's work list, the app's other tall
          column of rows, already scrolls without a bar; the column keeps its
          own "N more" foot as the depth cue. The 15px it gives back goes to the
          cards, which is why titles now fit on one line more often. */}
      <div className="scroll-none flex min-h-0 flex-1 flex-col gap-2.5 overflow-y-auto px-3 pt-3 pb-6">
        {issues.length === 0 && !over ? (
          <EmptyColumn label={label} onCreate={createInStage} />
        ) : (
          visibleIssues.map((issue, index) => (
            <Fragment key={issue.id}>
              {over?.index === index && <DropLine />}
              <CardBoundary resetKey={issue.id} label="issue card">
                <IssueCard
                  issue={issue}
                  sessions={sessionsByIssueId.get(issue.id) ?? []}
                  badges={badges}
                  stageCounts={stageCounts.get(issue.id)}
                  progress={epicProgress.get(issue.id) ?? null}
                  focused={focusId === issue.id}
                  selected={selectedIds.has(issue.id)}
                  dragging={draggedIssueId === issue.id}
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
            className="flex-none py-3 text-center font-mono shell-type-micro text-text-faint"
            data-testid="column-more"
          >
            {remaining} more
          </div>
        )}
      </div>
    </div>
  )
})

/** An empty column teaches instead of reporting. */
function EmptyColumn({ label, onCreate }: { label: string; onCreate: () => void }): JSX.Element {
  return (
    // No inset of its own: the sentence and the button start on the same left
    // edge the cards would have used, so an empty column reads as the same
    // column with nothing in it rather than as a different layout.
    <div className="flex flex-col items-start gap-2.5 pt-1 pb-4">
      <p className="text-[12px] text-text-faint">Nothing in {label}.</p>
      <button
        data-pressable
        type="button"
        className="rounded-[6px] border border-border border-dashed px-2.5 py-1.5 text-[11.5px] text-text-dim transition-colors hover:border-border-strong hover:text-foreground"
        onClick={onCreate}
      >
        <Plus size={11} aria-hidden="true" className="mr-1 inline" />
        New task
      </button>
    </div>
  )
}

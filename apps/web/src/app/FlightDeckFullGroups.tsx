import { LOADING } from '@podium/client-graph/loading'
import type { FullDeck, FullDeckTask } from '@podium/client-graph/mission-full-deck'
import { settled } from '@podium/client-graph/mission-view'
import { observer } from '@podium/client-graph/react'
import { CheckCircle2, ChevronDown, ChevronRight, Ellipsis } from 'lucide-react'
import { type CSSProperties, type ReactNode, type RefObject, useId } from 'react'
import { GhostBar } from '@/components/GhostPreview'
import { SessionNameEditor } from '@/lib/WorkerLabel'
import {
  FlightDeckFullDependencies,
  useFullDependencyInteraction,
} from './FlightDeckFullDependencies'
import { FlightDeckFullPhaseCrew } from './FlightDeckFullSeats'
import {
  type FlightDeckV6Actions,
  FlightDeckV6Rows,
  FlightDeckV6Task,
  V6_DEPTH_STEP,
} from './FlightDeckV6Rows'
import { DeckRowPlaceholder, type DeckWindow, deckTaskKey } from './flight-deck-window'

export type PhaseLeadSlot = (task: FullDeckTask, window: DeckWindow) => ReactNode

/** Full's projection owns order, membership, folds and counts. This component
 * only gives the projected rows section/rail geometry, preserving every level
 * of the tree. Waterfall and Timeline keep their existing renderers. */
export const FlightDeckFullGroups = observer(function FlightDeckFullGroups({
  full,
  scrollRef,
  renderPhaseLead,
  ...props
}: FlightDeckV6Actions & {
  full: FullDeck
  scrollRef: RefObject<HTMLElement | null>
  revealSessionId?: string | null
  renderPhaseLead?: PhaseLeadSlot
}) {
  return (
    <FlightDeckFullDependencies full={full} scrollRef={scrollRef}>
      <DoneLine full={full} />
      <FlightDeckV6Rows
        full={full}
        scrollRef={scrollRef}
        {...props}
        renderRows={(tasks, guides, window) => {
          // Pixel nesting over the already-filtered, already-ordered projection.
          // A phase's rail supplies one indentation step; descendants start at
          // that rail, while ordinary task ancestry retains its tree elbows.
          const branch = (start: number, end: number, baseDepth: number): ReactNode => {
            const rows: ReactNode[] = []
            for (let index = start; index < end; ) {
              const task = tasks[index]!
              let next = index + 1
              while (next < end && tasks[next]!.depth > task.depth) next++
              const carries = (guides[index] ?? []).slice(baseDepth)
              if (task.kind === 'phase') {
                rows.push(
                  <PhaseGroup
                    key={task.id}
                    task={task}
                    carries={carries}
                    visualDepth={task.depth - baseDepth}
                    window={window}
                    renderPhaseLead={renderPhaseLead}
                    {...props}
                  >
                    {branch(index + 1, next, task.depth + 1)}
                  </PhaseGroup>,
                )
              } else {
                rows.push(
                  <TaskBranch
                    key={task.id}
                    task={task}
                    carries={carries}
                    visualDepth={task.depth - baseDepth}
                    window={window}
                    {...props}
                  >
                    {branch(index + 1, next, baseDepth)}
                  </TaskBranch>,
                )
              }
              index = next
            }
            return rows
          }
          return branch(0, tasks.length, 0)
        }}
      />
    </FlightDeckFullDependencies>
  )
})

/** A task disclosure controls its inset crew and its descendant task path.
 * The branch target survives a fold even though the projection drops its rows. */
const TaskBranch = observer(function TaskBranch({
  children,
  ...props
}: FlightDeckV6Actions & {
  task: FullDeckTask
  carries: readonly boolean[]
  visualDepth: number
  window: DeckWindow
  children: ReactNode
}) {
  const childContentId = useId()
  return (
    <>
      <FlightDeckV6Task {...props} childContentId={childContentId} />
      <div id={childContentId} hidden={!props.task.open}>
        {children}
      </div>
    </>
  )
})

const DoneLine = observer(function DoneLine({ full }: { full: FullDeck }) {
  const counts = settled(() => (full.ready ? full.doneLine : null))
  if (!counts || counts === LOADING) return null
  return (
    <button
      type="button"
      className="flight-full-done-line"
      data-pressable
      onClick={() => full.toggleShowDone()}
    >
      <CheckCircle2 size={12} aria-hidden />
      <span>
        {counts.phases > 0 && `${counts.phases} phase${counts.phases === 1 ? '' : 's'} complete · `}
        {counts.tasks} task{counts.tasks === 1 ? '' : 's'} done
      </span>
      <span className="flight-full-show">Show</span>
    </button>
  )
})

const PhaseGroup = observer(function PhaseGroup({
  task,
  visualDepth,
  carries,
  window,
  renderPhaseLead,
  children,
  ...actions
}: FlightDeckV6Actions & {
  task: FullDeckTask
  visualDepth: number
  carries: readonly boolean[]
  window: DeckWindow
  renderPhaseLead?: PhaseLeadSlot
  children: ReactNode
}) {
  const contentId = useId()
  const dependencies = useFullDependencyInteraction()
  const ready = settled(
    () =>
      task.row.drawable &&
      (void task.counter,
      void task.workComplete,
      void task.matches,
      void task.leadSessionId,
      void task.deck.phaseIds,
      true),
  )
  if (ready !== true)
    return (
      <div role="status" aria-label="Loading phase">
        <GhostBar />
      </div>
    )
  const key = deckTaskKey(task.id)
  const shown = !window.enabled || window.contains(key)
  return (
    <section
      className="flight-full-phase"
      data-flight-phase={task.id}
      data-depth={task.depth}
      data-complete={task.workComplete}
      data-context={!task.matches}
    >
      <div className="flight-v6-guides" aria-hidden>
        {carries.map((carry, level) => (
          <span
            // biome-ignore lint/suspicious/noArrayIndexKey: one guide per depth level; the level IS the identity
            key={level}
            className="flight-v6-guide"
            data-guide={
              level === carries.length - 1 ? (carry ? 'middle' : 'last') : carry ? 'carry' : 'empty'
            }
            style={
              {
                '--v6-guide-left': `${(task.depth - carries.length + level) * V6_DEPTH_STEP}px`,
              } as CSSProperties
            }
          />
        ))}
      </div>
      <div
        className="flight-full-phase-section"
        data-visual-depth={visualDepth}
        style={{ '--v6-indent': `${task.depth * V6_DEPTH_STEP}px` } as CSSProperties}
      >
        {shown ? (
          <PhaseHeader task={task} contentId={contentId} window={window} {...actions} />
        ) : (
          <DeckRowPlaceholder
            row={{
              key,
              size: 32,
              get text() {
                return task.row.title
              },
            }}
            window={window}
          />
        )}
        <div
          id={contentId}
          hidden={!task.open}
          className="flight-full-phase-content"
          data-has-lead={task.leadSessionId !== null}
        >
          {task.open && (
            <>
              <div
                className="flight-full-phase-lead"
                data-phase-lead-slot={task.id}
                data-dependency-dim={dependencies?.dimLead(task) || undefined}
              >
                {renderPhaseLead ? (
                  renderPhaseLead(task, window)
                ) : (
                  <FlightDeckFullPhaseCrew task={task} window={window} {...actions} />
                )}
              </div>
              {children}
            </>
          )}
        </div>
      </div>
    </section>
  )
})

const PhaseHeader = observer(function PhaseHeader({
  task,
  contentId,
  window,
  ...actions
}: FlightDeckV6Actions & { task: FullDeckTask; contentId: string; window: DeckWindow }) {
  const counter = task.counter
  const dependencies = useFullDependencyInteraction()
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: context menu covers the header; its buttons provide keyboard actions.
    <div
      className="flight-full-phase-header"
      data-flight-task-row={task.id}
      data-edge-gutter="28"
      data-dependency-highlight={dependencies?.highlighted(task) || undefined}
      ref={window.enabled ? window.measure(deckTaskKey(task.id)) : undefined}
      onContextMenu={(event) => actions.onMenu(task, event)}
    >
      {actions.renameTarget?.id === task.id ? (
        <SessionNameEditor
          value={actions.renameTarget.seed}
          onCommit={(title) => {
            actions.onRename(task, title)
            actions.onRenameDone()
          }}
          onCancel={actions.onRenameDone}
        />
      ) : (
        <button
          type="button"
          className="flight-full-phase-toggle"
          data-pressable
          aria-label={`${task.open ? 'Collapse' : 'Expand'} phase ${task.row.title}`}
          aria-expanded={task.open}
          aria-controls={contentId}
          onClick={() => task.deck.toggleFold(task.id)}
        >
          {task.open ? (
            <ChevronDown size={12} aria-hidden />
          ) : (
            <ChevronRight size={12} aria-hidden />
          )}
          <span className="flight-full-phase-index">
            {String(task.deck.phaseIds.indexOf(task.id) + 1).padStart(2, '0')}
          </span>
          <span className="flight-full-phase-name">{task.row.title}</span>
          <span className="flight-full-phase-hairline" aria-hidden />
          {/* biome-ignore lint/a11y/useSemanticElements: a styled bar; a native <meter> cannot take the deck's band styling */}
          <span
            className="flight-full-phase-meter"
            role="meter"
            aria-label="Direct sub-issues done"
            aria-valuemin={0}
            aria-valuemax={Math.max(1, counter.total)}
            aria-valuenow={counter.done}
            aria-valuetext={`${counter.done} of ${counter.total} direct sub-issues done`}
          >
            <span
              style={{ width: `${counter.total ? (counter.done / counter.total) * 100 : 0}%` }}
            />
          </span>
          <span className="flight-full-phase-counter">
            {counter.done}/{counter.total}
          </span>
        </button>
      )}
      <button
        type="button"
        className="flight-v6-actions"
        aria-label={`Phase actions for ${task.row.title}`}
        title="Phase actions"
        onClick={(event) => actions.onMenu(task, event)}
      >
        <Ellipsis size={12} />
      </button>
    </div>
  )
})

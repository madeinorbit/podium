import type { SessionView } from '@podium/client-core/session-values'
import { nativeSubagentRows, treeGuides } from '@podium/client-core/values'
import { LOADING } from '@podium/client-graph/loading'
import type { FullDeck, FullDeckTask } from '@podium/client-graph/mission-full-deck'
import { settled } from '@podium/client-graph/mission-view'
import type { SessionModel } from '@podium/client-graph/models'
import { observer } from '@podium/client-graph/react'
import { SESSION_WORD_LABEL, TASK_WORD_LABEL, type TaskWord } from '@podium/model/browser'
import {
  ArrowUpRight,
  Check,
  ChevronDown,
  ChevronRight,
  Ellipsis,
  ListTree,
  Lock,
} from 'lucide-react'
import {
  type CSSProperties,
  type MouseEvent,
  type ReactNode,
  type RefObject,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from 'react'
import { GhostBar } from '@/components/GhostPreview'
import { IssueStatusPicker } from '@/features/issues/IssueStatusPicker'
import { PhaseTimer } from '@/lib/motion'
import { PoolSessionContextMenu } from '@/lib/PoolSessionContextMenu'
import type { ContextMenuAnchor } from '@/lib/session-context-menu'
import { useHarnessDescriptors } from '@/lib/use-harness-descriptors'
import { KindIcon, SessionNameEditor, sessionDisplayName } from '@/lib/WorkerLabel'
import { useFullDependencyInteraction } from './FlightDeckFullDependencies'
import {
  DeckRowPlaceholder,
  type DeckWindow,
  type DeckWindowRow,
  deckSessionKey,
  deckTaskKey,
  useFlightDeckWindow,
} from './flight-deck-window'
import { useSessionHovered } from './session-hover'
import { useRuntimeSelector } from './store'

const STRIP_HEIGHT = 32
const SESSION_HEIGHT = 28
export const V6_DEPTH_STEP = 22

export type FlightDeckV6Actions = {
  activeSessionId: string | null
  /** Open details for a task with no subtasks or crew. */
  onOpenTask: (task: FullDeckTask) => void
  onSelectSession: (task: FullDeckTask, session: SessionView, permanent: boolean) => void
  onMenu: (task: FullDeckTask, event: MouseEvent) => void
  onStatusPick: (task: FullDeckTask, value: string) => void
  renameTarget: { id: string; seed: string } | null
  onRename: (task: FullDeckTask, title: string) => void
  onRenameDone: () => void
}

/** Full-only geometry and rendering. The companions own membership, words,
 * counters, seats, search and folds; these arrays describe pixels, not records. */
export const FlightDeckV6Rows = observer(function FlightDeckV6Rows({
  full,
  scrollRef,
  revealSessionId,
  renderRows,
  ...actions
}: FlightDeckV6Actions & {
  full: FullDeck
  revealSessionId?: string | null
  scrollRef: RefObject<HTMLElement | null>
  renderRows?: (
    tasks: readonly FullDeckTask[],
    guides: readonly boolean[][],
    window: DeckWindow,
  ) => ReactNode
}) {
  const container = useRef<HTMLDivElement>(null)
  const pending = settled(() => {
    if (!full.ready) throw LOADING
    // Layout needs the fold and crew as well as membership. Keep this cold
    // boundary around all of those reads, before creating pixel estimates.
    for (const id of full.rowIds) {
      const task = full.task(id)
      void task.open
      void task.sessionIds
    }
    return full.rowIds
  })
  const ids = pending === LOADING ? [] : pending
  const tasks = ids.map((id) => full.task(id))
  const guides = treeGuides(tasks)
  const leaves: DeckWindowRow[] = []
  for (const task of tasks) {
    leaves.push({
      key: deckTaskKey(task.id),
      size: STRIP_HEIGHT,
      get text() {
        return `${task.row.displayRef} ${task.row.title} ${TASK_WORD_LABEL[task.word]}`
      },
    })
    if (task.open && task.sessionIds.length > 0) {
      leaves.push({ key: `v6:inset-top:${task.id}`, size: 3 })
      for (const id of task.sessionIds)
        leaves.push({
          key: deckSessionKey(task.id, id),
          size: task.seat(id) === 'phase-lead' ? 32 : SESSION_HEIGHT,
          get text() {
            const session = task.deck.screen.reader.rawSession(id)
            return session && session !== LOADING
              ? `${session.displayRef ?? ''} ${sessionDisplayName(session)} ${SESSION_WORD_LABEL[session.word]}`
              : ''
          },
        })
      leaves.push({ key: `v6:inset-bottom:${task.id}`, size: 7 })
    }
    leaves.push({ key: `v6:gap:${task.id}`, size: 3 })
  }
  const window = useFlightDeckWindow(leaves, scrollRef, container, full.rootId, 'v6')
  useLayoutEffect(() => {
    if (!revealSessionId || !window.enabled) return
    const leaf = leaves.find((row) => row.key.endsWith(`:${revealSessionId}`))
    if (leaf && !window.contains(leaf.key)) window.reveal(leaf.key)
    // biome-ignore lint/correctness/useExhaustiveDependencies: leaves is rebuilt from observables each render, so the reveal re-checks every render until its leaf exists
  }, [revealSessionId, leaves, window])
  return (
    <div ref={container} className="flight-v6-rows" data-testid="flight-deck-v6-rows">
      {pending === LOADING ? (
        <div role="status" aria-label="Loading tasks">
          <GhostBar />
        </div>
      ) : renderRows ? (
        renderRows(tasks, guides, window)
      ) : (
        tasks.map((task, index) => (
          <FlightDeckV6Task
            key={task.id}
            task={task}
            carries={guides[index] ?? []}
            window={window}
            {...actions}
          />
        ))
      )}
    </div>
  )
})

/** One roster primitive for task workers, phase leads and root helpers. */
export const FlightDeckV6Crew = observer(function FlightDeckV6Crew({
  task,
  window,
  ...actions
}: FlightDeckV6Actions & { task: FullDeckTask; window?: DeckWindow }) {
  return task.sessionIds.length > 0 ? (
    <div className="flight-v6-sessions">
      {task.sessionIds.map((id) => (
        <FlightDeckV6SessionSlot key={id} task={task} id={id} window={window} {...actions} />
      ))}
    </div>
  ) : null
})

const Ring = ({ word }: { word: TaskWord }) => (
  <span aria-hidden className="flight-v6-ring" data-word={word}>
    {word === 'done' && <Check size={9} />}
  </span>
)

/** No task selection state: only the session's pane ID owns a selected fill. */
export const FlightDeckV6Task = observer(function FlightDeckV6Task({
  task,
  carries,
  visualDepth = task.depth,
  childContentId,
  window,
  ...actions
}: FlightDeckV6Actions & {
  task: FullDeckTask
  carries: readonly boolean[]
  /** Phase rails already supply one level of the structural indentation. */
  visualDepth?: number
  childContentId?: string
  window?: DeckWindow
}) {
  const contentId = useId()
  const dependencies = useFullDependencyInteraction()
  const ready = settled(() => task.row.drawable && (void task.word, true))
  if (ready !== true)
    return (
      <div role="status" aria-label="Loading task">
        <GhostBar />
      </div>
    )
  const open = task.open
  const controlledIds = [contentId, childContentId].filter(Boolean).join(' ')
  const stripKey = deckTaskKey(task.id)
  const shown = !window?.enabled || window.contains(stripKey)
  return (
    <div className="flight-v6-task" data-flight-issue={task.id} data-depth={task.depth}>
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
        className="flight-v6-card"
        data-word={task.word}
        data-open={open}
        data-context={!task.matches}
        data-dependency-highlight={dependencies?.highlighted(task) || undefined}
        data-dependency-dim={dependencies?.dimmed(task) || undefined}
        style={{ '--v6-indent': `${task.depth * V6_DEPTH_STEP}px` } as CSSProperties}
      >
        {shown ? (
          // biome-ignore lint/a11y/useKeyWithClickEvents lint/a11y/noStaticElementInteractions: TaskBody provides the same activation for keyboard users; the context menu covers the strip and its buttons provide keyboard actions
          <div
            className="flight-v6-strip deck-strip"
            data-flight-task-row={task.id}
            data-visual-depth={visualDepth}
            data-edge-gutter="28"
            onClick={(event) => {
              if (event.target !== event.currentTarget) return
              if (task.foldable) task.deck.toggleFold(task.id)
              else actions.onOpenTask(task)
            }}
            onContextMenu={(event) => actions.onMenu(task, event)}
            ref={window?.enabled ? window.measure(stripKey) : undefined}
          >
            <TaskFold task={task} contentId={controlledIds} />
            <span className="flight-v6-ring-control">
              <IssueStatusPicker
                issue={task.row.status}
                size={14}
                onPick={(value) => actions.onStatusPick(task, value)}
              />
              <Ring word={task.word} />
            </span>
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
              <TaskBody task={task} contentId={controlledIds} onOpenTask={actions.onOpenTask}>
                <span className="flight-v6-ref">{task.row.displayRef}</span>
                <FlightDeckV6TaskTitle task={task} />
                <TaskCounter task={task} />
                <DependencySlot task={task} />
                {!open && (
                  <span className="flight-v6-engines" data-testid="v6-engines">
                    {task.sessionIds.slice(0, 2).map((id) => (
                      <Engine key={id} task={task} id={id} />
                    ))}
                  </span>
                )}
                <span className="flight-v6-state" data-word={task.word}>
                  {TASK_WORD_LABEL[task.word]}
                </span>
              </TaskBody>
            )}
            <TaskActions task={task} onMenu={actions.onMenu} />
          </div>
        ) : (
          <DeckRowPlaceholder
            row={{
              key: stripKey,
              size: STRIP_HEIGHT,
              get text() {
                return `${task.row.displayRef} ${task.row.title} ${TASK_WORD_LABEL[task.word]}`
              },
            }}
            window={window!}
          />
        )}
        <div id={contentId} hidden={!open}>
          {open && <FlightDeckV6Crew task={task} window={window} {...actions} />}
        </div>
      </div>
    </div>
  )
})

const FlightDeckV6TaskTitle = observer(function FlightDeckV6TaskTitle({
  task,
}: {
  task: FullDeckTask
}) {
  return (
    <span className="flight-v6-title" title={task.row.title}>
      {task.row.title}
    </span>
  )
})
const TaskFold = observer(function TaskFold({
  task,
  contentId,
}: {
  task: FullDeckTask
  contentId: string
}) {
  if (!task.foldable) return <span className="flight-v6-fold" aria-hidden="true" />
  return (
    <button
      type="button"
      className="flight-v6-fold"
      data-pressable
      aria-label={`${task.open ? 'Collapse' : 'Expand'} ${task.row.title}`}
      aria-expanded={task.open}
      aria-controls={contentId}
      onClick={() => task.deck.toggleFold(task.id)}
    >
      {task.open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
    </button>
  )
})
const TaskBody = observer(function TaskBody({
  task,
  contentId,
  onOpenTask,
  children,
}: {
  task: FullDeckTask
  contentId: string
  onOpenTask: FlightDeckV6Actions['onOpenTask']
  children: ReactNode
}) {
  return (
    <button
      type="button"
      className="flight-v6-task-body deck-task-content"
      data-pressable
      aria-label={`${task.foldable ? (task.open ? 'Collapse' : 'Expand') : 'Open'} ${task.row.displayRef} ${task.row.title}`}
      aria-expanded={task.foldable ? task.open : undefined}
      aria-controls={task.foldable ? contentId : undefined}
      onClick={() => {
        if (task.foldable) task.deck.toggleFold(task.id)
        else onOpenTask(task)
      }}
    >
      {children}
    </button>
  )
})
const TaskActions = observer(function TaskActions({
  task,
  onMenu,
}: {
  task: FullDeckTask
  onMenu: FlightDeckV6Actions['onMenu']
}) {
  return (
    <button
      type="button"
      className="flight-v6-actions"
      aria-label={`Task actions for ${task.row.title}`}
      title="Task actions"
      onClick={(event) => {
        event.stopPropagation()
        onMenu(task, event)
      }}
    >
      <Ellipsis size={12} />
    </button>
  )
})
const TaskCounter = observer(function TaskCounter({ task }: { task: FullDeckTask }) {
  const counter = settled(() => task.counter)
  if (counter === LOADING) return <span role="status" aria-label="Loading sub-issue count" />
  return counter.total > 0 ? (
    <span className="flight-v6-counter" title="Direct sub-issues done">
      <ListTree size={11} />
      {counter.done}/{counter.total}
    </span>
  ) : null
})

/** Full uses the shared task word and unmet scheduling facts, including
 * external references. The responsive CSS owns the pill's shedding rungs. */
const DependencySlot = observer(function DependencySlot({ task }: { task: FullDeckTask }) {
  const count = settled(() => task.unmetBlockedByIds.length)
  const refs = settled(() => task.dependencyReferences)
  if (!count || count === LOADING || refs === LOADING || task.word === 'done') return null
  const blocked = task.word === 'blocked'
  const short = count === 1 ? refs : `${count} tasks`
  return (
    <span
      className="flight-v6-dependency"
      data-kind={blocked ? 'blocked' : 'waiting'}
      data-dependency-slot={task.id}
      title={`${blocked ? 'Waits on' : 'After'} ${refs}`}
    >
      {blocked && <Lock size={11} aria-hidden />}
      <span className="flight-v6-dependency-label">{blocked ? 'blocked by' : 'after'}</span>
      <span className="flight-v6-dependency-ref">{short}</span>
    </span>
  )
})

const Engine = observer(function Engine({ task, id }: { task: FullDeckTask; id: string }) {
  const session = task.deck.screen.reader.rawSession(id)
  if (session === LOADING)
    return <span className="size-4" role="status" aria-label="Loading engine" />
  return session ? <SessionEngine session={session} compact /> : null
})
const SessionEngine = observer(function SessionEngine({
  session,
  compact = false,
}: {
  session: SessionModel & SessionView
  compact?: boolean
}) {
  const { served } = useHarnessDescriptors(session.machineId)
  return <KindIcon kind={session.agentKind} served={served} compact={compact} chip={!compact} />
})

export const FlightDeckV6SessionSlot = observer(function FlightDeckV6SessionSlot({
  task,
  id,
  window,
  ...actions
}: FlightDeckV6Actions & { task: FullDeckTask; id: string; window?: DeckWindow }) {
  const key = deckSessionKey(task.id, id)
  if (window?.enabled && !window.contains(key))
    return (
      <DeckRowPlaceholder
        window={window}
        row={{
          key,
          size: task.seat(id) === 'phase-lead' ? 32 : SESSION_HEIGHT,
          get text() {
            const session = task.deck.screen.reader.rawSession(id)
            return session && session !== LOADING ? sessionDisplayName(session) : ''
          },
        }}
      />
    )
  const session = task.deck.screen.reader.rawSession(id)
  if (session === LOADING)
    return (
      <div role="status" aria-label="Loading session">
        <GhostBar />
      </div>
    )
  return session ? (
    <FlightDeckV6Session
      task={task}
      session={session}
      active={actions.activeSessionId === id}
      measure={window?.enabled ? window.measure(key) : undefined}
      onOpen={(permanent) => actions.onSelectSession(task, session, permanent)}
    />
  ) : null
})

export const FlightDeckV6Session = observer(function FlightDeckV6Session({
  task,
  session,
  active,
  measure,
  onOpen,
}: {
  task: FullDeckTask
  session: SessionModel & SessionView
  active: boolean
  measure?: (node: HTMLElement | null) => void
  onOpen: (permanent: boolean) => void
}) {
  const renameSession = useRuntimeSelector((store) => store.renameSession)
  const [menu, setMenu] = useState<ContextMenuAnchor | null>(null)
  const [editing, setEditing] = useState(false)
  const [nativeOpen, setNativeOpen] = useState(false)
  const nativeId = useId()
  const pointed = useSessionHovered(session.sessionId)
  const natives = nativeSubagentRows(session)
  const name = sessionDisplayName(session)
  const seat = task.seat(session.sessionId)
  // The coordinator's card lists its native subagents openly; every other
  // session folds them behind a chip.
  const nativesInline = seat === 'coordinator'
  const nativesShown = nativesInline || nativeOpen
  return (
    <div
      ref={measure}
      data-flight-session={session.sessionId}
      className="flight-v6-session"
      data-selected={active}
      data-pointed={pointed}
      data-seat={seat}
      data-word={session.word}
    >
      <div className="flight-v6-session-line">
        {editing ? (
          <SessionNameEditor
            value={name}
            onCommit={(next) => {
              void renameSession(session.sessionId, next)
              setEditing(false)
            }}
            onCancel={() => setEditing(false)}
          />
        ) : (
          <button
            type="button"
            className="flight-v6-session-open deck-agent"
            data-pressable
            aria-pressed={active}
            title={[name, session.displayRef, seat, SESSION_WORD_LABEL[session.word]]
              .filter(Boolean)
              .join(' · ')}
            onClick={() => onOpen(false)}
            onDoubleClick={() => onOpen(true)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault()
                onOpen(true)
              }
            }}
            onContextMenu={(event) => {
              event.preventDefault()
              event.stopPropagation()
              setMenu({ x: event.clientX, y: event.clientY })
            }}
          >
            <SessionEngine session={session} />
            {seat === 'coordinator' ? (
              <span className="flight-full-coordinator-identity">
                <span className="flight-v6-title">{name}</span>
                <span className="flight-full-coordinator-caption">
                  <span>Coordinator</span>
                  <span className="flight-v6-ref">{session.displayRef}</span>
                </span>
              </span>
            ) : (
              <>
                <span className="flight-v6-title">{name}</span>
                <span className="flight-v6-ref">{session.displayRef}</span>
                {seat !== 'worker' && (
                  <span className="flight-v6-role">
                    {seat === 'phase-lead' ? 'phase lead' : 'helper'}
                  </span>
                )}
              </>
            )}
            {natives.length > 0 && !nativesInline && <span className="flight-v6-native-slot" />}
            <SessionState session={session} />
            {seat === 'coordinator' && (
              <ArrowUpRight size={14} className="flight-full-conversation-arrow" aria-hidden />
            )}
          </button>
        )}
        {natives.length > 0 && !nativesInline && (
          <button
            type="button"
            className="flight-v6-native-chip"
            aria-label={`${nativeOpen ? 'Collapse' : 'Expand'} ${natives.length} native subagents of ${name}`}
            aria-expanded={nativeOpen}
            aria-controls={nativeId}
            onClick={(event) => {
              event.stopPropagation()
              setNativeOpen((value) => !value)
            }}
            onKeyDown={(event) => {
              event.stopPropagation()
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault()
                setNativeOpen((value) => !value)
              }
            }}
          >
            {natives.length} native{' '}
            <ChevronDown
              size={9}
              style={{ transform: nativeOpen ? 'rotate(180deg)' : undefined }}
            />
          </button>
        )}
        <button
          type="button"
          className="flight-v6-actions"
          title="Session actions"
          aria-label={`Session actions for ${name}`}
          onClick={(event) => {
            event.stopPropagation()
            setMenu({ x: event.clientX, y: event.clientY })
          }}
        >
          <Ellipsis size={12} />
        </button>
      </div>
      {natives.length > 0 && (
        <ul
          id={nativeId}
          hidden={!nativesShown}
          className="flight-v6-natives"
          aria-label={`Native subagents of ${name}`}
        >
          {nativesShown &&
            natives.map((native) => (
              <li key={native.id}>
                <span>{native.type}</span>
                {!native.anonymous && <span>· {native.id}</span>}
                <span className="flight-v6-native-state">running</span>
              </li>
            ))}
        </ul>
      )}
      {menu && (
        <PoolSessionContextMenu
          sessionId={session.sessionId}
          anchor={menu}
          onClose={() => setMenu(null)}
          onRename={() => {
            setMenu(null)
            setEditing(true)
          }}
        />
      )}
    </div>
  )
})

/** Only this small timer subscribes to the shared clock. Working deliberately
 * omits the accumulated base: D5 shows this turn, Done shows the total. */
const SessionState = observer(function SessionState({
  session,
}: {
  session: SessionModel & SessionView
}) {
  const word = session.word
  const since = session.stateSinceMs
  return (
    <span className="flight-v6-state" data-word={word}>
      <span>{SESSION_WORD_LABEL[word]}</span>
      {word === 'working' && Number.isFinite(since) && since > 0 && (
        <PhaseTimer phase="working" sinceMs={since} size={10} showSpinner={false} mutedWorking />
      )}
      {word === 'done' && session.workingMsTotal !== undefined && (
        <PhaseTimer phase="done" sinceMs={since} totalMs={session.workingMsTotal} size={10} />
      )}
    </span>
  )
})

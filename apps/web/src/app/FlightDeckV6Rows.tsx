import type { FullDeck, FullDeckTask } from '@podium/client-graph/mission-full-deck'
import { settled } from '@podium/client-graph/mission-view'
import type { SessionModel } from '@podium/client-graph/models'
import { observer } from '@podium/client-graph/react'
import { LOADING } from '@podium/client-graph/loading'
import type { SessionView } from '@podium/client-core/session-values'
import { nativeSubagentRows, treeGuides } from '@podium/client-core/values'
import { SESSION_WORD_LABEL, TASK_WORD_LABEL, type TaskWord } from '@podium/model/browser'
import { Check, ChevronDown, ChevronRight, Ellipsis, ListTree } from 'lucide-react'
import { useId, useRef, useState, type MouseEvent, type RefObject } from 'react'
import { GhostBar } from '@/components/GhostPreview'
import { IssueStatusPicker } from '@/features/issues/IssueStatusPicker'
import { PhaseTimer } from '@/lib/motion'
import { PoolSessionContextMenu } from '@/lib/PoolSessionContextMenu'
import type { ContextMenuAnchor } from '@/lib/session-context-menu'
import { useHarnessDescriptors } from '@/lib/use-harness-descriptors'
import { cn } from '@/lib/utils'
import { KindIcon, SessionNameEditor, sessionDisplayName } from '@/lib/WorkerLabel'
import { useRuntimeSelector } from './store'
import { DeckRowPlaceholder, deckSessionKey, deckTaskKey, useFlightDeckWindow, type DeckWindow, type DeckWindowRow } from './flight-deck-window'

const STRIP_HEIGHT = 32
const SESSION_HEIGHT = 28
export const V6_DEPTH_STEP = 22

type Actions = {
  activeSessionId: string | null
  onSelectSession: (task: FullDeckTask, session: SessionView, permanent: boolean) => void
  onMenu: (task: FullDeckTask, event: MouseEvent) => void
  onStatusPick: (task: FullDeckTask, value: string) => void
  renameTarget: { id: string; seed: string } | null
  onRename: (task: FullDeckTask, title: string) => void
  onRenameDone: () => void
}

/** Full-only geometry and rendering. The companions own membership, words,
 * counters, seats, search and folds; these arrays describe pixels, not records. */
export const FlightDeckV6Rows = observer(function FlightDeckV6Rows({ full, scrollRef, ...actions }: Actions & {
  full: FullDeck
  scrollRef: RefObject<HTMLElement | null>
}) {
  const container = useRef<HTMLDivElement>(null)
  const pending = settled(() => full.rowIds)
  const ids = pending === LOADING ? [] : pending
  const tasks = ids.map(id => full.task(id))
  const guides = treeGuides(tasks)
  const leaves: DeckWindowRow[] = []
  for (const task of tasks) {
    leaves.push({ key: deckTaskKey(task.id), size: STRIP_HEIGHT,
      get text() { return `${task.row.displayRef} ${task.row.title} ${TASK_WORD_LABEL[task.word]}` } })
    if (task.open) for (const id of task.sessionIds) leaves.push({
      key: deckSessionKey(task.id, id), size: SESSION_HEIGHT,
      get text() {
        const session = task.deck.screen.reader.rawSession(id)
        return session && session !== LOADING ? `${session.displayRef ?? ''} ${sessionDisplayName(session)} ${SESSION_WORD_LABEL[session.word]}` : ''
      },
    })
    leaves.push({ key: `v6:gap:${task.id}`, size: 3 })
  }
  const window = useFlightDeckWindow(leaves, scrollRef, container, full.rootId, 'v6')
  return <div ref={container} className="flight-v6-rows" data-testid="flight-deck-v6-rows">
    {pending === LOADING ? <div role="status" aria-label="Loading tasks"><GhostBar /></div> :
      tasks.map((task, index) => <FlightDeckV6Task key={task.id} task={task} carries={guides[index] ?? []} window={window} {...actions} />)}
  </div>
})

const Ring = ({ word }: { word: TaskWord }) => <span aria-hidden className="flight-v6-ring" data-word={word}>
  {word === 'done' && <Check size={9} />}
</span>

/** No task selection state: only the session's pane ID owns a selected fill. */
export const FlightDeckV6Task = observer(function FlightDeckV6Task({ task, carries, window, ...actions }: Actions & {
  task: FullDeckTask
  carries: readonly boolean[]
  window?: DeckWindow
}) {
  const contentId = useId()
  const ready = settled(() => task.row.drawable)
  if (ready !== true) return <div role="status" aria-label="Loading task"><GhostBar /></div>
  const open = task.open
  const stripKey = deckTaskKey(task.id)
  const shown = !window?.enabled || window.contains(stripKey)
  return <div className="flight-v6-task" data-flight-issue={task.id} data-depth={task.depth}>
    <div className="flight-v6-guides" aria-hidden>
      {carries.map((carry, level) => <span key={level} className="flight-v6-guide"
        data-guide={level === carries.length - 1 ? carry ? 'middle' : 'last' : carry ? 'carry' : 'empty'}
        style={{ left: level * V6_DEPTH_STEP }} />)}
    </div>
    <div className="flight-v6-card" data-word={task.word} data-open={open} data-context={!task.matches}
      style={{ marginLeft: task.depth * V6_DEPTH_STEP }}>
      {shown ? <div className="flight-v6-strip deck-strip" onClick={event => { if (event.target === event.currentTarget) task.deck.toggleFold(task.id) }} onContextMenu={event => actions.onMenu(task, event)}
        ref={window?.enabled ? window.measure(stripKey) : undefined}>
        <button type="button" className="flight-v6-fold" data-pressable
          aria-label={`${open ? 'Collapse' : 'Expand'} ${task.row.title}`}
          aria-expanded={open} aria-controls={contentId}
          onClick={() => task.deck.toggleFold(task.id)}>
          {task.foldable ? open ? <ChevronDown size={12} /> : <ChevronRight size={12} /> : <span />}
        </button>
        <span className="flight-v6-ring-control">
          <IssueStatusPicker issue={task.row.status} size={14} onPick={value => actions.onStatusPick(task, value)} />
          <Ring word={task.word} />
        </span>
        {actions.renameTarget?.id === task.id ? <SessionNameEditor value={actions.renameTarget.seed}
          onCommit={title => { actions.onRename(task, title); actions.onRenameDone() }} onCancel={actions.onRenameDone} /> :
          <button type="button" className="flight-v6-task-body deck-task-content" data-pressable
            aria-label={`${open ? 'Collapse' : 'Expand'} ${task.row.displayRef} ${task.row.title}`}
            aria-expanded={open} aria-controls={contentId} onClick={() => task.deck.toggleFold(task.id)}>
            <span className="flight-v6-ref">{task.row.displayRef}</span>
            <span className="flight-v6-title" title={task.row.title}>{task.row.title}</span>
            {task.counter.total > 0 && <span className="flight-v6-counter" title="Direct sub-issues done"><ListTree size={11} />{task.counter.done}/{task.counter.total}</span>}
            <DependencySlot task={task} />
            {!open && <span className="flight-v6-engines" data-testid="v6-engines">
              {task.sessionIds.slice(0, 2).map(id => <Engine key={id} task={task} id={id} />)}
            </span>}
            <span className="flight-v6-state" data-word={task.word}>{TASK_WORD_LABEL[task.word]}</span>
          </button>}
        <button type="button" className="flight-v6-actions" aria-label={`Task actions for ${task.row.title}`} title="Task actions"
          onClick={event => { event.stopPropagation(); actions.onMenu(task, event) }}><Ellipsis size={12} /></button>
      </div> : <DeckRowPlaceholder row={{ key: stripKey, size: STRIP_HEIGHT,
        get text() { return `${task.row.displayRef} ${task.row.title} ${TASK_WORD_LABEL[task.word]}` } }} window={window!} />}
      <div id={contentId} hidden={!open}>
        {open && task.sessionIds.length > 0 && <div className="flight-v6-sessions">
          {task.sessionIds.map(id => <SessionSlot key={id} task={task} id={id} window={window} {...actions} />)}
        </div>}
      </div>
    </div>
  </div>
})

/** The dependency feature can extend this slot without changing the strip. */
const DependencySlot = observer(function DependencySlot({ task }: { task: FullDeckTask }) {
  const note = settled(() => task.row.presentation?.note)
  if (!note || note === LOADING || (note.kind !== 'blocked' && note.kind !== 'waiting')) return null
  return <span className="flight-v6-dependency" title={note.full}>{note.label} {note.short}</span>
})

const Engine = observer(function Engine({ task, id }: { task: FullDeckTask; id: string }) {
  const session = task.deck.screen.reader.rawSession(id)
  if (session === LOADING) return <span className="size-4" role="status" aria-label="Loading engine" />
  return session ? <SessionEngine session={session} compact /> : null
})
const SessionEngine = observer(function SessionEngine({ session, compact = false }: { session: SessionModel & SessionView; compact?: boolean }) {
  const { served } = useHarnessDescriptors(session.machineId)
  return <KindIcon kind={session.agentKind} served={served} compact={compact} chip={!compact} />
})

const SessionSlot = observer(function SessionSlot({ task, id, window, ...actions }: Actions & { task: FullDeckTask; id: string; window?: DeckWindow }) {
  const key = deckSessionKey(task.id, id)
  if (window?.enabled && !window.contains(key)) return <DeckRowPlaceholder window={window} row={{ key, size: SESSION_HEIGHT,
    get text() { const session = task.deck.screen.reader.rawSession(id); return session && session !== LOADING ? sessionDisplayName(session) : '' } }} />
  const session = task.deck.screen.reader.rawSession(id)
  if (session === LOADING) return <div role="status" aria-label="Loading session"><GhostBar /></div>
  return session ? <FlightDeckV6Session task={task} session={session} active={actions.activeSessionId === id}
    measure={window?.enabled ? window.measure(key) : undefined}
    onOpen={permanent => actions.onSelectSession(task, session, permanent)} /> : null
})

export const FlightDeckV6Session = observer(function FlightDeckV6Session({ task, session, active, measure, onOpen }: {
  task: FullDeckTask
  session: SessionModel & SessionView
  active: boolean
  measure?: (node: HTMLElement | null) => void
  onOpen: (permanent: boolean) => void
}) {
  const renameSession = useRuntimeSelector(store => store.renameSession)
  const [menu, setMenu] = useState<ContextMenuAnchor | null>(null)
  const [editing, setEditing] = useState(false)
  const [nativeOpen, setNativeOpen] = useState(false)
  const nativeId = useId()
  const natives = nativeSubagentRows(session)
  const name = sessionDisplayName(session)
  return <div ref={measure} data-flight-session={session.sessionId} className="flight-v6-session" data-selected={active}>
    <div className="flight-v6-session-line">
      {editing ? <SessionNameEditor value={name} onCommit={next => { void renameSession(session.sessionId, next); setEditing(false) }} onCancel={() => setEditing(false)} /> :
        <button type="button" className="flight-v6-session-open deck-agent" data-pressable aria-pressed={active}
          title={[name, session.displayRef, task.seat(session.sessionId)].filter(Boolean).join(' · ')}
          onClick={() => onOpen(false)} onDoubleClick={() => onOpen(true)}
          onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onOpen(true) } }}
          onContextMenu={event => { event.preventDefault(); event.stopPropagation(); setMenu({ x: event.clientX, y: event.clientY }) }}>
          <SessionEngine session={session} />
          <span className="flight-v6-title">{name}</span>
          <span className="flight-v6-ref">{session.displayRef}</span>
          {task.seat(session.sessionId) === 'helper' && <span className="flight-v6-role">helper</span>}
          {natives.length > 0 && <span className="flight-v6-native-slot" />}
          <SessionState session={session} />
        </button>}
      {natives.length > 0 && <button type="button" className="flight-v6-native-chip" aria-expanded={nativeOpen} aria-controls={nativeId}
        onClick={event => { event.stopPropagation(); setNativeOpen(value => !value) }}
        onKeyDown={event => { event.stopPropagation(); if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); setNativeOpen(value => !value) } }}>
        {natives.length} native <ChevronDown size={9} style={{ transform: nativeOpen ? 'rotate(180deg)' : undefined }} />
      </button>}
      <button type="button" className="flight-v6-actions" title="Session actions" aria-label={`Session actions for ${name}`}
        onClick={event => { event.stopPropagation(); setMenu({ x: event.clientX, y: event.clientY }) }}><Ellipsis size={12} /></button>
    </div>
    {nativeOpen && natives.length > 0 && <ul id={nativeId} className="flight-v6-natives" aria-label={`Native subagents of ${name}`}>
      {natives.map(native => <li key={native.id}><span>{native.type}</span>{!native.anonymous && <span>· {native.id}</span>}<span className="flight-v6-native-state">running</span></li>)}
    </ul>}
    {menu && <PoolSessionContextMenu sessionId={session.sessionId} anchor={menu} onClose={() => setMenu(null)}
      onRename={() => { setMenu(null); setEditing(true) }} />}
  </div>
})

/** Only this small timer subscribes to the shared clock. Working deliberately
 * omits the accumulated base: D5 shows this turn, Done shows the total. */
const SessionState = observer(function SessionState({ session }: { session: SessionModel & SessionView }) {
  const word = session.word
  const since = session.stateSinceMs
  return <span className="flight-v6-state" data-word={word}>
    <span>{SESSION_WORD_LABEL[word]}</span>
    {word === 'working' && Number.isFinite(since) && since > 0 && <PhaseTimer phase="working" sinceMs={since} size={10} showSpinner={false} mutedWorking />}
    {word === 'done' && session.workingMsTotal !== undefined && <PhaseTimer phase="done" sinceMs={since} totalMs={session.workingMsTotal} size={10} />}
  </span>
})

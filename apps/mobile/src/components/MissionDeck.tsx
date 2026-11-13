import { issueAgentKind, modelLabel } from '@podium/client-core/agent-models'
import type { SessionView } from '@podium/client-core/session-values'
import {
  type IssueNavigationModel,
  readoutModel,
  sessionDisplayName,
} from '@podium/client-core/values'
import { here } from '@podium/client-graph/lookup'
import {
  FULL_DECK_FILTERS,
  type FullDeck,
  type FullDeckFilter,
  type FullDeckTask,
} from '@podium/client-graph/mission-full-deck'
import { ProposalSubmissions } from '@podium/client-graph/mission-proposals'
import type { MissionScreen } from '@podium/client-graph/mission-screen'
import { settled } from '@podium/client-graph/mission-view'
import type { SessionModel } from '@podium/client-graph/models'
import { ROW_WINDOW_SIZE } from '@podium/client-graph/row-window'
import { LOADING } from '@podium/client-graph/worklist/rollup'
import { issueStatusOf } from '@podium/model'
import {
  SESSION_WORD_LABEL,
  type SessionWord,
  TASK_WORD_LABEL,
  type TaskWord,
} from '@podium/model/browser'
import { observer } from 'mobx-react-lite'
import { Fragment, type ReactNode, useEffect, useMemo, useState } from 'react'
import { AppState, StyleSheet, Text, View } from 'react-native'
import { useTrpc } from '../client/hooks'
import { color, font, leading, mono, sans, space } from '../theme/theme'
import { deckColor, deckWordColor } from './deck-colors'
import { Icon } from './Icon'
import { Check, ChevronDown, ChevronRight } from './icons'
import { DeckContent, DeckGroup, DeckProposals, DeckRow, MissionDeckList } from './MissionDeckList'
import { DeckGauge, DeckVitalsLine, deckVitals } from './MissionGauge'
import { MissionProposalRow } from './MissionProposalRow'
import { MissionProposalSlot } from './MissionProposalSlot'
import type { MissionProposalRowProps } from './mission-proposal-row.types'
import { PressableScale } from './PressableScale'
import { StageGlyph } from './StageGlyph'
import { EmptyState } from './ui'
import { WorkingMark } from './WorkingMark'

/** The shared FullDeck projection in a full-screen native list beneath chat. */

const FILTER_LABEL: Readonly<Record<FullDeckFilter, string>> = {
  all: 'All',
  'needs-you': 'Needs you',
  active: 'Active',
  'up-next': 'Up next',
}

export const MissionDeck = observer(function MissionDeck({
  screen,
  currentSessionId,
  onOpenSession,
  onOpenTask,
  onOpenTaskMenu,
  onScreenProposals,
  showTitle = true,
}: {
  screen: MissionScreen
  currentSessionId: string | undefined
  onOpenSession: (session: SessionView) => void
  onOpenTask: (issue: IssueNavigationModel) => void
  onOpenTaskMenu: (issue: IssueNavigationModel) => void
  onScreenProposals: () => void
  showTitle?: boolean
}) {
  const full = screen.full
  const trpc = useTrpc()
  const submissions = useMemo(() => new ProposalSubmissions(full, 'brief'), [full])
  const receiptDeadline = submissions.receiptDeadline
  useEffect(() => {
    if (receiptDeadline === null) return
    const timer = setTimeout(
      () => submissions.expireReceipts(),
      Math.max(0, receiptDeadline - Date.now()),
    )
    const listener = AppState.addEventListener('change', (state) => {
      if (state === 'active') submissions.expireReceipts()
    })
    return () => {
      clearTimeout(timer)
      listener.remove()
    }
  }, [submissions, receiptDeadline])
  const vitals = deckVitals(full)
  const [proposalsOpen, setProposalsOpen] = useState(true)
  const acceptedTree = full.ready ? submissions.acceptedTree : null
  const rowIds = acceptedTree?.rowIds ?? []
  const proposalIds = full.ready ? submissions.ids : []
  const seatIds = full.ready ? settled(() => full.root.sessionIds) : []
  const rootSeats = seatIds === LOADING ? [] : seatIds
  const title = settled(() => screen.rootTitle)
  const issueOf = (id: string): IssueNavigationModel | null => {
    const value = screen.reader.issue(id)
    return value && value !== LOADING ? value : null
  }
  const openSession = (id: string) =>
    onOpenSession(screen.pool.sessionObject(id) as unknown as SessionView)

  return (
    <MissionDeckList>
      <DeckContent>
        <View style={styles.head}>
          {showTitle ? (
            <Text style={styles.title} numberOfLines={2} accessibilityRole="header">
              {title === LOADING ? '' : title}
            </Text>
          ) : null}
          {vitals ? (
            <>
              <DeckGauge vitals={vitals} />
              <DeckVitalsLine vitals={vitals} />
            </>
          ) : (
            <Text style={styles.sub}>Loading tasks…</Text>
          )}
        </View>
      </DeckContent>
      {rootSeats.length > 0 ? (
        <DeckGroup testID="deck-crew">
          {rootSeats.map((id, index) => (
            <DeckRow key={id}>
              <SeatRow
                task={full.root}
                sessionId={id}
                first={index === 0}
                current={id === currentSessionId}
                onPress={() => openSession(id)}
              />
            </DeckRow>
          ))}
        </DeckGroup>
      ) : null}

      {acceptedTree?.filterable ? (
        <DeckContent>
          <Filters full={full} />
        </DeckContent>
      ) : null}

      <DeckRows
        full={full}
        rowIds={rowIds}
        currentSessionId={currentSessionId}
        onOpenSession={openSession}
        onOpenTask={(id) => {
          const issue = issueOf(id)
          if (issue) onOpenTask(issue)
        }}
        onOpenTaskMenu={(id) => {
          const issue = issueOf(id)
          if (issue) onOpenTaskMenu(issue)
        }}
      />

      {full.ready && rowIds.length === 0 && acceptedTree?.filterable && full.filter !== 'all' ? (
        <DeckContent>
          <Text style={styles.empty}>
            Nothing {FILTER_LABEL[full.filter].toLowerCase()} right now.
          </Text>
        </DeckContent>
      ) : null}
      {full.ready &&
      !acceptedTree?.filterable &&
      rootSeats.length === 0 &&
      proposalIds.length === 0 ? (
        <DeckContent>
          <EmptyState title="No tasks or agents on this mission yet." />
        </DeckContent>
      ) : null}
      <DeckProposals
        ids={proposalsOpen ? proposalIds : []}
        header={
          proposalIds.length > 0 ? (
            <View style={styles.section}>
              <PressableScale
                accessibilityRole="button"
                accessibilityLabel={`Proposals, ${proposalIds.length}`}
                accessibilityState={{ expanded: proposalsOpen }}
                haptic={false}
                onPress={() => setProposalsOpen((open) => !open)}
                style={styles.sectionToggle}
              >
                <Icon
                  as={proposalsOpen ? ChevronDown : ChevronRight}
                  size={12}
                  color={deckColor.proposalText}
                />
                <Text style={[styles.sectionTitle, styles.proposalText]}>Proposed</Text>
                <Text style={styles.sectionCount}>{proposalIds.length}</Text>
              </PressableScale>
              <PressableScale
                accessibilityRole="button"
                accessibilityLabel="Screen proposals"
                haptic={false}
                onPress={onScreenProposals}
                style={styles.sectionAction}
              >
                <Text style={styles.sectionActionLabel}>Screen</Text>
              </PressableScale>
            </View>
          ) : undefined
        }
      >
        {proposalsOpen
          ? proposalIds.map((id, index) => (
              <MissionProposalSlot
                key={id}
                id={id}
                window={submissions.window}
                prime={index < ROW_WINDOW_SIZE}
              >
                <ProposalContent
                  full={full}
                  id={id}
                  first={index === 0}
                  submissions={submissions}
                  onSubmit={(action) => void submissions.submit(id, action, trpc)}
                  onPress={() => {
                    const issue = issueOf(id)
                    if (issue) onOpenTask(issue)
                  }}
                />
              </MissionProposalSlot>
            ))
          : null}
      </DeckProposals>
    </MissionDeckList>
  )
})

/** Resolve each task only inside the native slot's active window. */
const ProposalContent = observer(function ProposalContent({
  full,
  id,
  ...props
}: Omit<MissionProposalRowProps, 'task'> & { full: FullDeck; id: string }) {
  return <MissionProposalRow {...props} task={full.task(id)} />
})

const Filters = observer(function Filters({ full }: { full: FullDeck }) {
  const counts = full.counts
  return (
    <View style={styles.filters} accessibilityRole="tablist">
      {FULL_DECK_FILTERS.map((filter) => {
        const on = full.filter === filter
        const count = counts[filter]
        return (
          <PressableScale
            key={filter}
            accessibilityRole="tab"
            accessibilityState={{ selected: on }}
            accessibilityLabel={`${FILTER_LABEL[filter]}, ${count}`}
            testID={`deck-filter-${filter}`}
            haptic={false}
            hitSlop={CHIP_SLOP}
            onPress={() => full.setFilter(filter)}
            style={[styles.filter, on && styles.filterOn]}
          >
            <Text
              numberOfLines={1}
              style={[
                styles.filterLabel,
                filter === 'needs-you' && count > 0 && styles.needsText,
                on && styles.filterLabelOn,
              ]}
            >
              {FILTER_LABEL[filter]} <Text style={styles.filterCount}>{count}</Text>
            </Text>
          </PressableScale>
        )
      })}
      <PressableScale
        accessibilityRole="switch"
        accessibilityState={{ checked: full.showDone }}
        accessibilityLabel={`Show done, ${counts.done}`}
        testID="deck-filter-done"
        haptic={false}
        hitSlop={CHIP_SLOP}
        onPress={() => full.toggleShowDone()}
        style={[styles.filter, full.showDone && full.filter === 'all' && styles.doneOn]}
      >
        <Text numberOfLines={1} style={styles.filterLabel}>
          Done
        </Text>
      </PressableScale>
    </View>
  )
})

/**
 * Phases become section headings; the tasks under one heading share one
 * grouped card. Tasks outside any phase group the same way.
 */
const DeckRows = observer(function DeckRows({
  full,
  rowIds,
  currentSessionId,
  onOpenSession,
  onOpenTask,
  onOpenTaskMenu,
}: {
  full: FullDeck
  rowIds: readonly string[]
  currentSessionId: string | undefined
  onOpenSession: (id: string) => void
  onOpenTask: (id: string) => void
  onOpenTaskMenu: (id: string) => void
}) {
  const blocks: { phase: FullDeckTask | null; tasks: FullDeckTask[]; phaseStart: boolean }[] = []
  for (const id of rowIds) {
    const task = full.task(id)
    if (settled(() => task.kind) === 'phase')
      blocks.push({ phase: task, tasks: [], phaseStart: true })
    else {
      const last = blocks[blocks.length - 1]
      const phaseId = settled(() => task.phaseId)
      const phase = typeof phaseId === 'string' ? full.task(phaseId) : null
      if (last && last.phase?.id === phase?.id) last.tasks.push(task)
      else blocks.push({ phase, tasks: [task], phaseStart: false })
    }
  }
  return (
    <>
      {blocks.map(({ phase, tasks, phaseStart }, index) => {
        // Key by group and its occurrence, not by its first task: a first task
        // that changes state must not remount the native rows beside it.
        const groupKey = phase?.id ?? 'loose'
        const occurrence = blocks
          .slice(0, index)
          .filter((block) => (block.phase?.id ?? 'loose') === groupKey).length
        const phaseSeats =
          phase && phaseStart ? settled(() => (phase.open ? phase.sessionIds : [])) : []
        const leadingSeats = phaseSeats === LOADING ? [] : phaseSeats
        return (
          <Fragment key={`${groupKey}-${occurrence}`}>
            <DeckGroup
              testID={`deck-group-${phase?.id ?? 'loose'}`}
              header={phase ? <PhaseHeading phase={phase} /> : undefined}
            >
              {phase &&
                leadingSeats.map((id) => (
                  <DeckRow key={id}>
                    <AgentLine
                      task={phase}
                      sessionId={id}
                      indent={0}
                      current={id === currentSessionId}
                      onPress={() => onOpenSession(id)}
                    />
                  </DeckRow>
                ))}
              {tasks.map((task, row) => {
                const shape = settled(() => ({
                  depth: task.depth,
                  base: phase ? phase.depth + 1 : 0,
                  seats: task.open ? task.sessionIds : [],
                }))
                const indent = shape === LOADING ? 0 : Math.max(0, shape.depth - shape.base)
                const seats = shape === LOADING ? [] : shape.seats
                return (
                  <Fragment key={task.id}>
                    <DeckRow>
                      <TaskLine
                        task={task}
                        indent={indent}
                        first={row === 0 && leadingSeats.length === 0}
                        onPress={() => onOpenTask(task.id)}
                        onLongPress={() => onOpenTaskMenu(task.id)}
                      />
                    </DeckRow>
                    {seats.map((id) => (
                      <DeckRow key={id}>
                        <AgentLine
                          task={task}
                          sessionId={id}
                          indent={indent}
                          current={id === currentSessionId}
                          onPress={() => onOpenSession(id)}
                        />
                      </DeckRow>
                    ))}
                  </Fragment>
                )
              })}
            </DeckGroup>
          </Fragment>
        )
      })}
    </>
  )
})

const PhaseHeading = observer(function PhaseHeading({ phase }: { phase: FullDeckTask }) {
  const facts = settled(() => ({
    counter: phase.counter,
    title: phase.row.title,
    open: phase.open,
    status: phase.row.status,
    word: phase.word,
    complete: phase.workComplete,
  }))
  if (facts === LOADING) return <View style={styles.section} accessibilityLabel="Loading phase" />
  const {
    counter: { done, total },
    title,
    open,
  } = facts
  return (
    <PressableScale
      accessibilityRole="button"
      accessibilityLabel={`${title}, ${TASK_WORD_LABEL[facts.word]}, ${done} of ${total} done`}
      accessibilityState={{ expanded: open }}
      haptic={false}
      onPress={() => phase.deck.toggleFold(phase.id)}
      style={styles.section}
      testID="deck-phase"
    >
      <StageGlyph
        stage={facts.complete ? 'done' : issueStatusOf(facts.status)}
        ground={color.groupedBg}
      />
      <Text style={[styles.sectionTitle, { color: deckWordColor(facts.word) }]} numberOfLines={2}>
        {title}
      </Text>
      <Text
        style={[styles.sectionCount, { color: deckWordColor(facts.word) }]}
      >{`${done}/${total}`}</Text>
      <Icon as={open ? ChevronDown : ChevronRight} size={12} color={color.textFaint} />
    </PressableScale>
  )
})

/** The task's word, with the unmet-dependency count on a blocked one. */
export function taskWordText(word: TaskWord, blockers: number): string {
  return word === 'blocked' && blockers > 0
    ? `${TASK_WORD_LABEL.blocked} · ${blockers}`
    : TASK_WORD_LABEL[word]
}

const TaskLine = observer(function TaskLine({
  task,
  indent,
  first,
  onPress,
  onLongPress,
}: {
  task: FullDeckTask
  indent: number
  first: boolean
  onPress: () => void
  onLongPress: () => void
}) {
  // A cold row's facts are still loading: draw its place, not a throw.
  const facts = settled(() => ({
    word: task.word,
    status: task.row.status,
    title: task.row.title,
    ref: task.row.displayRef,
    foldable: task.foldable,
    open: task.open,
  }))
  if (facts === LOADING) {
    return (
      <View style={styles.line} accessibilityLabel="Loading task" testID="deck-task-loading">
        <View style={styles.gutter}>
          <View style={styles.ring} />
        </View>
        <View style={[styles.lineBody, !first && styles.separated]} />
      </View>
    )
  }
  const { word, title, ref, foldable, open } = facts
  const blockers = word === 'blocked' ? settled(() => task.unmetBlockedByIds.length) : 0
  const label = taskWordText(word, blockers === LOADING ? 0 : blockers)
  return (
    <View style={styles.line}>
      <View style={[styles.taskMarks, { marginLeft: Math.min(indent, 3) * space.sm }]}>
        {foldable ? (
          <View style={styles.disclosure}>
            <PressableScale
              accessibilityRole="button"
              accessibilityLabel={`${open ? 'Collapse' : 'Expand'} ${title}`}
              accessibilityState={{ expanded: open }}
              hitSlop={8}
              style={styles.foldToggle}
              onPress={() => task.deck.toggleFold(task.id)}
            >
              <Icon as={open ? ChevronDown : ChevronRight} size={12} color={color.textDim} />
            </PressableScale>
          </View>
        ) : null}
        <StageGlyph stage={issueStatusOf(facts.status)} ground={color.groupedCard} />
      </View>
      <PressableScale
        accessibilityRole="button"
        accessibilityLabel={`${ref} ${title}, ${label}`}
        haptic={false}
        scaleTo={1}
        onPress={onPress}
        onLongPress={onLongPress}
        style={({ pressed }) => [
          styles.lineBody,
          !first && styles.separated,
          pressed && styles.pressed,
        ]}
        testID="deck-task"
      >
        <View style={styles.taskText}>
          <Text style={[styles.lineTitle, word === 'done' && styles.doneTitle]} numberOfLines={2}>
            {title}
          </Text>
          <View style={styles.taskMeta}>
            <Text style={styles.taskRef}>{ref}</Text>
            <Text style={[styles.word, wordTone(word)]} numberOfLines={1}>
              {label}
            </Text>
          </View>
        </View>
      </PressableScale>
    </View>
  )
})

/** An agent seated on a task, inset under it (board DeckLarge). */
const AgentLine = observer(function AgentLine({
  task,
  sessionId,
  indent,
  current,
  onPress,
}: {
  task: FullDeckTask
  sessionId: string
  indent: number
  current: boolean
  onPress: () => void
}) {
  const session = task.deck.screen.pool.sessionObject(sessionId) as SessionModel
  const name = seatName(task, sessionId, session)
  const model = sessionModelLabel(session)
  return (
    <PressableScale
      accessibilityRole="button"
      accessibilityLabel={`${name}, ${SESSION_WORD_LABEL[session.word]}${current ? ', open' : ''}`}
      accessibilityState={{ selected: current }}
      haptic={false}
      scaleTo={1}
      onPress={onPress}
      style={({ pressed }) => [
        styles.agent,
        styles.selectionFrame,
        pressed && styles.pressed,
        current && styles.selected,
      ]}
      testID="deck-agent"
    >
      <View style={[styles.gutter, { marginLeft: space.lg + Math.min(indent, 3) * space.sm }]}>
        <SessionGlyph word={session.word} />
      </View>
      <View style={styles.seatText}>
        <Text style={styles.agentName} numberOfLines={2}>
          {name}
        </Text>
        <Text style={styles.agentModel} numberOfLines={2}>
          <Text style={wordTone(session.word)}>{SESSION_WORD_LABEL[session.word]}</Text>
          {model ? ` · ${model}` : ''}
        </Text>
      </View>
    </PressableScale>
  )
})

/** One of the root's seats: the coordinator first (board DeckSheet). */
const SeatRow = observer(function SeatRow({
  task,
  sessionId,
  first,
  current,
  onPress,
}: {
  task: FullDeckTask
  sessionId: string
  first: boolean
  current: boolean
  onPress: () => void
}) {
  const session = task.deck.screen.pool.sessionObject(sessionId) as SessionModel
  const name = seatName(task, sessionId, session)
  const word = SESSION_WORD_LABEL[session.word]
  const model = sessionModelLabel(session)
  return (
    <PressableScale
      accessibilityRole="button"
      accessibilityLabel={`${name}, ${word}${current ? ', open' : ''}`}
      accessibilityState={{ selected: current }}
      haptic={false}
      scaleTo={1}
      onPress={onPress}
      style={({ pressed }) => [
        styles.seat,
        styles.selectionFrame,
        pressed && styles.pressed,
        current && styles.selected,
      ]}
      testID="deck-seat"
    >
      <View style={styles.gutter}>
        <SessionGlyph word={session.word} />
      </View>
      <View style={[styles.seatBody, !first && styles.separated]}>
        <View style={styles.seatText}>
          <Text style={styles.seatName} numberOfLines={2}>
            {name}
          </Text>
          <Text style={styles.seatSub} numberOfLines={2}>
            <Text style={wordTone(session.word)}>{word}</Text>
            {model ? ` · ${model}` : ''}
          </Text>
        </View>
      </View>
    </PressableScale>
  )
})

/** The coordinator seat reads "Coordinator"; everyone else by their name. */
function seatName(task: FullDeckTask, sessionId: string, session: SessionModel): string {
  if (task.seat(sessionId) === 'coordinator') return 'Coordinator'
  return sessionDisplayName(session as unknown as SessionView)
}

function sessionModelLabel(session: SessionModel): string | null {
  const view = here(session.row) as unknown as SessionView | undefined
  if (!view) return null
  const kind = issueAgentKind(view.agentKind)
  const model = readoutModel(view)
  return kind && model ? modelLabel(kind, model) : null
}

function wordTone(word: TaskWord | SessionWord) {
  return { color: deckWordColor(word) }
}

function SessionGlyph({ word }: { word: SessionWord }): ReactNode {
  if (word === 'working') return <WorkingMark size={10} />
  if (word === 'needs-you') return <View style={styles.dot} />
  if (word === 'error') return <View style={[styles.dot, styles.errorDot]} />
  if (word === 'done') return <Icon as={Check} size={13} color={deckColor.done} />
  return <View style={styles.ring} />
}

/** Keep the disclosure separate from the stage glyph, including on collapsed tasks. */
const GUTTER = 16
const INSET = space.lg
const ROW_H = 44

const CHIP_SLOP = { top: 6, bottom: 6 }

const styles = StyleSheet.create({
  head: { gap: space.sm },
  title: {
    ...sans(600),
    color: color.text,
    fontSize: font.body,
    lineHeight: 24,
  },
  sub: { ...sans(400), color: color.textDim, fontSize: font.tiny, lineHeight: leading(font.tiny) },
  seat: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    minHeight: 56,
    paddingLeft: INSET,
  },
  selectionFrame: {
    borderWidth: 1,
    borderColor: 'transparent',
    borderRadius: 6,
    marginHorizontal: 4,
  },
  selected: { borderColor: deckColor.liveRing, backgroundColor: deckColor.liveFill },
  seatBody: {
    flex: 1,
    minWidth: 0,
    alignSelf: 'stretch',
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    paddingRight: INSET,
    paddingVertical: space.sm,
  },
  seatText: { flex: 1, minWidth: 0 },
  seatName: { ...sans(600), color: color.text, fontSize: font.small, lineHeight: 20 },
  seatSub: { ...sans(400), color: color.textDim, fontSize: font.tiny, lineHeight: 17 },
  filters: { flexWrap: 'wrap', flexDirection: 'row', gap: space.xs },
  filter: {
    flexGrow: 1,
    flexShrink: 1,
    // PressableScale's 44pt touch minimum would stretch the chip (board: 32);
    // CHIP_SLOP gives the touch target back.
    height: 32,
    minHeight: 32,
    paddingHorizontal: 6,
    borderRadius: 6,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: color.quaternaryFill,
  },
  filterOn: { backgroundColor: color.text },
  doneOn: { backgroundColor: color.secondaryFill },
  filterLabel: { ...sans(500), color: color.textDim, fontSize: 12 },
  filterLabelOn: { color: color.bg },
  filterCount: { ...mono(400), fontVariant: ['tabular-nums'] },
  section: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    minHeight: 44,
    paddingHorizontal: INSET,
    marginTop: space.sm,
  },
  sectionToggle: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    minHeight: 44,
  },
  sectionTitle: {
    ...sans(600),
    color: color.textDim,
    fontSize: font.small,
    lineHeight: leading(font.small),
    flex: 1,
  },
  sectionCount: {
    ...mono(400),
    color: color.textFaint,
    fontSize: 12,
    fontVariant: ['tabular-nums'],
  },
  sectionAction: { minHeight: 28, justifyContent: 'center' },
  sectionActionLabel: { ...sans(500), color: deckColor.proposalText, fontSize: font.tiny },
  proposalText: { color: deckColor.proposalText },
  line: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    minHeight: ROW_H,
    paddingLeft: INSET,
  },
  pressed: { backgroundColor: color.tertiaryFill },
  gutter: { width: GUTTER, alignItems: 'center', justifyContent: 'center' },
  taskMarks: { flexDirection: 'row', alignItems: 'center', gap: space.xs },
  disclosure: { width: 16, alignItems: 'center' },
  foldToggle: {
    width: 20,
    minWidth: 20,
    height: 44,
    alignItems: 'center',
    justifyContent: 'center',
  },
  taskText: { flex: 1, minWidth: 0, paddingVertical: space.sm, gap: space.xs },
  taskMeta: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm, alignItems: 'center' },
  taskRef: { ...mono(400), color: color.textFaint, fontSize: font.micro },
  lineBody: {
    flex: 1,
    minWidth: 0,
    alignSelf: 'stretch',
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    paddingRight: INSET,
  },
  separated: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: color.hairline,
  },
  lineTitle: {
    ...sans(400),
    minWidth: 0,
    color: color.text,
    fontSize: font.small,
    lineHeight: leading(font.small),
  },
  doneTitle: { color: color.textDim },
  word: { ...sans(400), color: color.textFaint, fontSize: 12, flexShrink: 0, textAlign: 'right' },
  agent: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    minHeight: 44,
    paddingVertical: space.sm,
    paddingLeft: INSET,
    paddingRight: INSET,
  },
  agentName: { ...sans(400), minWidth: 0, color: color.textDim, fontSize: font.tiny },
  agentModel: { ...mono(400), color: color.textFaint, fontSize: font.micro },
  dot: { width: 8, height: 8, borderRadius: 4, backgroundColor: color.needsYou },
  errorDot: { backgroundColor: color.danger },
  ring: { width: 8, height: 8, borderRadius: 4, borderWidth: 1.5, borderColor: color.textFaint },
  needsText: { color: deckColor.needsYou },
  empty: {
    ...sans(400),
    color: color.textDim,
    fontSize: font.tiny,
    paddingHorizontal: INSET,
    paddingVertical: space.md,
  },
})

import { issueAgentKind, modelLabel } from '@podium/client-core/agent-models'
import type { SessionView } from '@podium/client-core/session-values'
import { type IssueNavigationModel, sessionTitle } from '@podium/client-core/values'
import {
  FULL_DECK_FILTERS,
  type FullDeck,
  type FullDeckFilter,
  type FullDeckTask,
} from '@podium/client-graph/mission-full-deck'
import type { MissionScreen } from '@podium/client-graph/mission-screen'
import { settled } from '@podium/client-graph/mission-view'
import type { SessionModel } from '@podium/client-graph/models'
import { LOADING } from '@podium/client-graph/worklist/rollup'
import {
  SESSION_WORD_LABEL,
  type SessionWord,
  TASK_WORD_LABEL,
  type TaskWord,
} from '@podium/model/browser'
import { observer } from 'mobx-react-lite'
import { Fragment, type ReactNode, useState } from 'react'
import { Platform, ScrollView, StyleSheet, Text, View } from 'react-native'
import { color, font, leading, mono, sans, space } from '../theme/theme'
import { Icon } from './Icon'
import { Check, ChevronDown, ChevronRight } from './icons'
import { DeckGauge, DeckVitalsLine, deckVitals } from './MissionBar'
import { PressableScale } from './PressableScale'
import { EmptyState } from './ui'
import { WorkingMark } from './WorkingMark'

/**
 * THE FLIGHT DECK SHEET (boards DeckSheet, DeckLarge).
 *
 * The phone's projection of the shared Full deck (`FullDeck`): the mission's
 * title, gauge and counts, the root's seats, the filters (All / Needs you /
 * Active / Up next, Done as a toggle), phases with their "2/4" counter, tasks
 * with their state words and the agents seated on them, and the Proposals
 * tail. Every number and word comes from `FullDeck`; this file only places
 * them. The sheet itself (detents, grabber, dismissal) is the native form
 * sheet the route is presented in.
 */

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
  onDone,
}: {
  screen: MissionScreen
  currentSessionId: string | undefined
  onOpenSession: (session: SessionView) => void
  onOpenTask: (issue: IssueNavigationModel) => void
  onOpenTaskMenu: (issue: IssueNavigationModel) => void
  onScreenProposals: () => void
  /** A visible close control, for hosts without a native sheet grabber (web). */
  onDone?: () => void
}) {
  const full = screen.full
  const vitals = deckVitals(full)
  const [proposalsOpen, setProposalsOpen] = useState(true)
  const rowIds = full.ready ? full.rowIds : []
  const proposalIds = full.ready ? full.proposalIds : []
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
    <ScrollView
      style={styles.scroll}
      contentContainerStyle={styles.content}
      contentInsetAdjustmentBehavior="never"
      testID="mission-deck"
    >
      <View style={styles.head}>
        <View style={styles.titleRow}>
          <Text style={styles.title} numberOfLines={2} accessibilityRole="header">
            {title === LOADING ? '' : title}
          </Text>
          {onDone ? (
            <PressableScale
              accessibilityRole="button"
              accessibilityLabel="Done"
              haptic={false}
              onPress={onDone}
              style={styles.done}
            >
              <Text style={styles.doneLabel}>Done</Text>
            </PressableScale>
          ) : null}
        </View>
        {vitals ? (
          <>
            <DeckGauge vitals={vitals} height={4} />
            <DeckVitalsLine vitals={vitals} />
          </>
        ) : (
          <Text style={styles.sub}>Loading tasks…</Text>
        )}
      </View>

      {rootSeats.length > 0 ? (
        <View style={styles.group} testID="deck-crew">
          {rootSeats.map((id, index) => (
            <SeatRow
              key={id}
              task={full.root}
              sessionId={id}
              first={index === 0}
              current={id === currentSessionId}
              onPress={() => openSession(id)}
            />
          ))}
        </View>
      ) : null}

      {full.ready && full.filterable ? <Filters full={full} /> : null}

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

      {full.ready && rowIds.length === 0 && full.filterable && full.filter !== 'all' ? (
        <Text style={styles.empty}>
          Nothing {FILTER_LABEL[full.filter].toLowerCase()} right now.
        </Text>
      ) : null}
      {full.ready && !full.filterable && rootSeats.length === 0 && proposalIds.length === 0 ? (
        <EmptyState title="No tasks or agents on this mission yet." />
      ) : null}

      {proposalIds.length > 0 ? (
        <>
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
                color={color.textFaint}
              />
              <Text style={styles.sectionTitle}>Proposals</Text>
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
          {proposalsOpen ? (
            <View style={styles.group} testID="deck-proposals">
              {proposalIds.map((id, index) => (
                <ProposalLine
                  key={id}
                  task={full.task(id)}
                  first={index === 0}
                  onPress={() => {
                    const issue = issueOf(id)
                    if (issue) onOpenTask(issue)
                  }}
                />
              ))}
            </View>
          ) : null}
        </>
      ) : null}
    </ScrollView>
  )
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
  const blocks: { phase: FullDeckTask | null; tasks: FullDeckTask[] }[] = []
  for (const id of rowIds) {
    const task = full.task(id)
    if (settled(() => task.kind) === 'phase') blocks.push({ phase: task, tasks: [] })
    else {
      const last = blocks[blocks.length - 1]
      if (last) last.tasks.push(task)
      else blocks.push({ phase: null, tasks: [task] })
    }
  }
  return (
    <>
      {blocks.map(({ phase, tasks }, index) => (
        <Fragment key={phase?.id ?? `loose-${index}`}>
          {phase ? <PhaseHeading phase={phase} /> : null}
          {tasks.length > 0 ? (
            <View style={styles.group}>
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
                    <TaskLine
                      task={task}
                      indent={indent}
                      first={row === 0}
                      onPress={() => onOpenTask(task.id)}
                      onLongPress={() => onOpenTaskMenu(task.id)}
                    />
                    {seats.map((id) => (
                      <AgentLine
                        key={id}
                        task={task}
                        sessionId={id}
                        indent={indent}
                        current={id === currentSessionId}
                        onPress={() => onOpenSession(id)}
                      />
                    ))}
                  </Fragment>
                )
              })}
            </View>
          ) : null}
        </Fragment>
      ))}
    </>
  )
})

const PhaseHeading = observer(function PhaseHeading({ phase }: { phase: FullDeckTask }) {
  const facts = settled(() => ({
    counter: phase.counter,
    title: phase.row.title,
    open: phase.open,
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
      accessibilityLabel={`${title}, ${done} of ${total} done`}
      accessibilityState={{ expanded: open }}
      haptic={false}
      onPress={() => phase.deck.toggleFold(phase.id)}
      style={styles.section}
      testID="deck-phase"
    >
      <Icon as={open ? ChevronDown : ChevronRight} size={12} color={color.textFaint} />
      <Text style={styles.sectionTitle} numberOfLines={1}>
        {title}
      </Text>
      <Text style={styles.sectionCount}>{`${done}/${total}`}</Text>
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
    title: task.row.title,
    ref: task.row.displayRef,
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
  const { word, title, ref } = facts
  const blockers = word === 'blocked' ? settled(() => task.unmetBlockedByIds.length) : 0
  const label = taskWordText(word, blockers === LOADING ? 0 : blockers)
  return (
    <PressableScale
      accessibilityRole="button"
      accessibilityLabel={`${ref} ${title}, ${label}`}
      haptic={false}
      scaleTo={1}
      onPress={onPress}
      onLongPress={onLongPress}
      style={({ pressed }) => [styles.line, pressed && styles.pressed]}
      testID="deck-task"
    >
      <View style={[styles.gutter, { marginLeft: indent * space.md }]}>
        <WordGlyph word={word} />
      </View>
      <View style={[styles.lineBody, !first && styles.separated]}>
        <Text style={[styles.lineTitle, word === 'done' && styles.doneTitle]} numberOfLines={1}>
          {title}
        </Text>
        <Text style={[styles.word, wordTone(word)]} numberOfLines={1}>
          {label}
        </Text>
      </View>
    </PressableScale>
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
      style={({ pressed }) => [styles.agent, pressed && styles.pressed]}
      testID="deck-agent"
    >
      <View style={[styles.gutter, { marginLeft: space.lg + indent * space.md }]}>
        <SessionGlyph word={session.word} />
      </View>
      <Text style={styles.agentName} numberOfLines={1}>
        {name}
      </Text>
      {current ? (
        <Icon as={Check} size={14} color={color.accentTint} />
      ) : model ? (
        <Text style={styles.agentModel} numberOfLines={1}>
          {model}
        </Text>
      ) : null}
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
      style={({ pressed }) => [styles.seat, (pressed || current) && styles.seatOn]}
      testID="deck-seat"
    >
      <View style={styles.gutter}>
        <SessionGlyph word={session.word} />
      </View>
      <View style={[styles.seatBody, !first && styles.separated]}>
        <View style={styles.seatText}>
          <Text style={styles.seatName} numberOfLines={1}>
            {name}
          </Text>
          <Text style={styles.seatSub} numberOfLines={1}>
            <Text style={wordTone(session.word)}>{word}</Text>
            {model ? ` · ${model}` : ''}
          </Text>
        </View>
        {current ? <Icon as={Check} size={16} color={color.accentTint} /> : null}
      </View>
    </PressableScale>
  )
})

const ProposalLine = observer(function ProposalLine({
  task,
  first,
  onPress,
}: {
  task: FullDeckTask
  first: boolean
  onPress: () => void
}) {
  const facts = settled(() => ({
    author: task.proposalAuthor,
    title: task.row.title,
    ref: task.row.displayRef,
  }))
  if (facts === LOADING) {
    return <View style={styles.line} accessibilityLabel="Loading proposal" />
  }
  const { author, title, ref } = facts
  return (
    <PressableScale
      accessibilityRole="button"
      accessibilityLabel={`Proposal ${ref} ${title}`}
      haptic={false}
      scaleTo={1}
      onPress={onPress}
      style={({ pressed }) => [styles.line, pressed && styles.pressed]}
      testID="deck-proposal"
    >
      <View style={styles.gutter}>
        <View style={styles.ring} />
      </View>
      <View style={[styles.lineBody, !first && styles.separated]}>
        <Text style={styles.lineTitle} numberOfLines={1}>
          {title}
        </Text>
        {author ? (
          <Text style={styles.word} numberOfLines={1}>
            {`by ${author}`}
          </Text>
        ) : null}
      </View>
    </PressableScale>
  )
})

/** The coordinator seat reads "Coordinator"; everyone else by their name. */
function seatName(task: FullDeckTask, sessionId: string, session: SessionModel): string {
  if (task.seat(sessionId) === 'coordinator') return 'Coordinator'
  return sessionTitle(session as unknown as SessionView)
}

function sessionModelLabel(session: SessionModel): string | null {
  const view = session as unknown as SessionView
  const kind = issueAgentKind(view.agentKind)
  const model = view.observedModel ?? view.model
  return kind && model ? modelLabel(kind, model) : null
}

function wordTone(word: TaskWord | SessionWord) {
  if (word === 'error') return styles.errorText
  if (word === 'needs-you') return styles.needsText
  if (word === 'working') return styles.workingText
  return null
}

function WordGlyph({ word }: { word: TaskWord }): ReactNode {
  if (word === 'working') return <WorkingMark size={10} />
  if (word === 'needs-you') return <View style={styles.dot} />
  if (word === 'error') return <View style={[styles.dot, styles.errorDot]} />
  if (word === 'done') return <Icon as={Check} size={13} color={color.workingText} />
  return <View style={styles.ring} />
}

function SessionGlyph({ word }: { word: SessionWord }): ReactNode {
  if (word === 'working') return <WorkingMark size={10} />
  if (word === 'needs-you') return <View style={styles.dot} />
  if (word === 'error') return <View style={[styles.dot, styles.errorDot]} />
  if (word === 'done') return <Icon as={Check} size={13} color={color.textFaint} />
  return <View style={styles.ring} />
}

/** Rows: 12 inset, 14 status column, 8 gap — every title starts at x=34. */
const GUTTER = 14
const INSET = space.md
const ROW_H = 44

const styles = StyleSheet.create({
  scroll: { flex: 1 },
  content: {
    paddingHorizontal: space.lg,
    paddingTop: Platform.OS === 'ios' ? space.xl : space.lg,
    paddingBottom: space.xxl,
    gap: space.sm,
  },
  head: { gap: 6, paddingBottom: space.xs },
  titleRow: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  title: {
    ...sans(600),
    flex: 1,
    color: color.text,
    fontSize: font.body,
    lineHeight: 24,
  },
  done: { minHeight: 44, minWidth: 44, alignItems: 'flex-end', justifyContent: 'center' },
  doneLabel: { ...sans(600), color: color.accentTint, fontSize: font.body },
  sub: { ...sans(400), color: color.textDim, fontSize: font.tiny, lineHeight: leading(font.tiny) },
  group: {
    backgroundColor: color.quaternaryFill,
    borderRadius: 8,
    overflow: 'hidden',
  },
  seat: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    minHeight: 56,
    paddingLeft: INSET,
  },
  seatOn: { backgroundColor: color.tertiaryFill },
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
  filters: { flexDirection: 'row', gap: space.xs },
  filter: {
    flexGrow: 1,
    flexShrink: 1,
    height: 32,
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
    minHeight: 28,
    paddingHorizontal: INSET,
    marginTop: space.sm,
  },
  sectionToggle: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    minHeight: 28,
  },
  sectionTitle: { ...sans(600), color: color.textDim, fontSize: font.tiny, flexShrink: 1 },
  sectionCount: {
    ...mono(400),
    color: color.textFaint,
    fontSize: 12,
    fontVariant: ['tabular-nums'],
  },
  sectionAction: { minHeight: 28, justifyContent: 'center' },
  sectionActionLabel: { ...sans(500), color: color.needsYouText, fontSize: font.tiny },
  line: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    minHeight: ROW_H,
    paddingLeft: INSET,
  },
  pressed: { backgroundColor: color.tertiaryFill },
  gutter: { width: GUTTER, alignItems: 'center', justifyContent: 'center' },
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
  lineTitle: { ...sans(400), flex: 1, minWidth: 0, color: color.text, fontSize: font.small },
  doneTitle: { color: color.textDim },
  word: { ...sans(400), color: color.textFaint, fontSize: 12, flexShrink: 0, textAlign: 'right' },
  agent: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    minHeight: 36,
    paddingLeft: INSET,
    paddingRight: INSET,
  },
  agentName: { ...sans(400), flex: 1, minWidth: 0, color: color.textDim, fontSize: font.tiny },
  agentModel: { ...mono(400), color: color.textFaint, fontSize: font.micro },
  dot: { width: 8, height: 8, borderRadius: 4, backgroundColor: color.needsYou },
  errorDot: { backgroundColor: color.danger },
  ring: { width: 8, height: 8, borderRadius: 4, borderWidth: 1.5, borderColor: color.textFaint },
  needsText: { color: color.needsYouText },
  workingText: { color: color.workingText },
  errorText: { color: color.dangerText },
  empty: {
    ...sans(400),
    color: color.textDim,
    fontSize: font.tiny,
    paddingHorizontal: INSET,
    paddingVertical: space.md,
  },
})

import type { SessionView } from '@podium/client-core/session-values'
import type { IssueNavigationModel } from '@podium/client-core/values'
import {
  FULL_DECK_FILTERS,
  type FullDeck,
  type FullDeckFilter,
  type FullDeckTask,
} from '@podium/client-graph/mission-full-deck'
import { ProposalSubmissions } from '@podium/client-graph/mission-proposals'
import type { MissionScreen } from '@podium/client-graph/mission-screen'
import { settled } from '@podium/client-graph/mission-view'
import { ROW_WINDOW_SIZE } from '@podium/client-graph/row-window'
import { LOADING } from '@podium/client-graph/worklist/rollup'
import { observer } from 'mobx-react-lite'
import { Fragment, useEffect, useMemo, useState } from 'react'
import { AppState, Pressable, StyleSheet, Text, View } from 'react-native'
import { useTrpc } from '../client/hooks'
import { color, font, leading, radius, sans, space } from '../theme/theme'
import { deckColor } from './deck-colors'
import { Icon } from './Icon'
import { ChevronDown, ChevronRight } from './icons'
import { DeckContent, DeckGroup, DeckProposals, DeckRow, MissionDeckList } from './MissionDeckList'
import { DeckAgentRow, DeckPhaseHeading, DeckSeatRow, DeckTaskRow } from './MissionDeckRows'
import { DeckGauge, DeckVitalsLine, deckVitals } from './MissionGauge'
import { MissionProposalRow } from './MissionProposalRow'
import { MissionProposalSlot } from './MissionProposalSlot'
import type { MissionProposalRowProps } from './mission-proposal-row.types'
import { StageGlyph } from './StageGlyph'
import { EmptyState } from './ui'

/** The shared FullDeck projection in a full-screen native list: the page right of the chat. */

/**
 * Reveal the selected seat using the deck's existing fold actions. A user can
 * fold it again without the selection continually reopening it.
 */
export function useRevealSeat(screen: MissionScreen | null | undefined, sessionId?: string) {
  const ready = screen?.ready === true
  useEffect(() => {
    if (!ready || !screen || !sessionId) return
    let id: string | null =
      screen.crew.find((session) => session.sessionId === sessionId)?.issueId ?? null
    while (id && screen.members.has(id)) {
      const task = screen.full.task(id)
      if (task.foldable && !task.open) screen.full.toggleFold(id)
      id = task.parentId
    }
  }, [ready, screen, sessionId])
}

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

  // The gauge heads the coordinator card when there is one: a header-only
  // section of its own would add List's empty-section padding beneath it.
  const head = (
    <View style={styles.head}>
      {showTitle ? (
        <Text style={styles.title} numberOfLines={2} accessibilityRole="header">
          {title === LOADING ? '' : title}
        </Text>
      ) : null}
      {vitals ? (
        <>
          <DeckGauge vitals={vitals} />
          <View style={styles.vitalsRow}>
            <View style={styles.vitalsText}>
              <DeckVitalsLine vitals={vitals} />
            </View>
            {acceptedTree?.filterable ? <DoneToggle full={full} /> : null}
          </View>
        </>
      ) : (
        <Text style={styles.sub}>Loading tasks…</Text>
      )}
    </View>
  )

  return (
    <MissionDeckList>
      {rootSeats.length > 0 ? (
        <DeckGroup testID="deck-crew" header={<View style={styles.headAbove}>{head}</View>}>
          {rootSeats.map((id, index) => (
            <DeckRow key={id}>
              <DeckSeatRow
                task={full.root}
                sessionId={id}
                first={index === 0}
                current={id === currentSessionId}
                onPress={() => openSession(id)}
              />
            </DeckRow>
          ))}
        </DeckGroup>
      ) : (
        <DeckContent>{head}</DeckContent>
      )}

      {acceptedTree?.filterable ? (
        <DeckContent>
          <View style={styles.filterBar}>
            <Filters full={full} />
          </View>
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
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`Proposals, ${proposalIds.length}`}
                accessibilityState={{ expanded: proposalsOpen }}
                hitSlop={SECTION_SLOP}
                onPress={() => setProposalsOpen((open) => !open)}
                style={styles.sectionToggle}
              >
                <View style={styles.gutter}>
                  <StageGlyph stage="proposed" tint={deckColor.proposal} ground={color.groupedBg} />
                </View>
                <Text style={styles.sectionTitle} numberOfLines={2}>
                  Proposed
                </Text>
              </Pressable>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Screen proposals"
                hitSlop={SECTION_SLOP}
                onPress={onScreenProposals}
                style={styles.sectionAction}
              >
                <Text style={styles.sectionActionLabel}>Screen</Text>
              </Pressable>
              <Pressable
                accessible={false}
                hitSlop={SECTION_SLOP}
                onPress={() => setProposalsOpen((open) => !open)}
                style={styles.sectionTrail}
              >
                <Text style={styles.sectionCount}>{proposalIds.length}</Text>
                <Icon
                  as={proposalsOpen ? ChevronDown : ChevronRight}
                  size={13}
                  color={color.textFaint}
                />
              </Pressable>
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

/**
 * One segmented control over the shared filters: exactly one selected segment
 * (iOS UISegmentedControl, widths by content). Done is not a filter; it is the
 * separate Show/Hide toggle beside the counts.
 */
const Filters = observer(function Filters({ full }: { full: FullDeck }) {
  const counts = full.counts
  return (
    <View style={styles.segments} accessibilityRole="tablist">
      {FULL_DECK_FILTERS.map((filter) => {
        const on = full.filter === filter
        const count = counts[filter]
        return (
          <Pressable
            key={filter}
            accessibilityRole="tab"
            aria-selected={on}
            accessibilityLabel={`${FILTER_LABEL[filter]}, ${count}`}
            testID={`deck-filter-${filter}`}
            hitSlop={CHIP_SLOP}
            onPress={() => full.setFilter(filter)}
            style={[styles.segment, on && styles.segmentOn]}
          >
            <Text
              numberOfLines={1}
              // UISegmentedControl shrinks a label that does not fit its segment.
              adjustsFontSizeToFit
              minimumFontScale={0.7}
              maxFontSizeMultiplier={SEGMENT_MAX_SCALE}
              style={[styles.segmentLabel, on && styles.segmentLabelOn]}
            >
              {FILTER_LABEL[filter]}{' '}
              <Text
                style={[
                  styles.segmentCount,
                  filter === 'needs-you' && count > 0 && styles.needsText,
                ]}
              >
                {count}
              </Text>
            </Text>
          </Pressable>
        )
      })}
    </View>
  )
})

/** Show or hide done tasks: a toggle that says what a tap does, never a selected chip. */
const DoneToggle = observer(function DoneToggle({ full }: { full: FullDeck }) {
  const shown = full.showDone
  return (
    <Pressable
      accessibilityRole="switch"
      aria-checked={shown}
      accessibilityLabel={`Show done, ${full.counts.done}`}
      testID="deck-filter-done"
      hitSlop={TOGGLE_SLOP}
      onPress={() => full.toggleShowDone()}
      style={({ pressed }) => [styles.doneToggle, pressed && styles.dimmed]}
    >
      <Text style={styles.doneToggleLabel} numberOfLines={1}>
        {shown ? 'Hide Done' : 'Show Done'}
      </Text>
    </Pressable>
  )
})

/** The header of a card with no heading, so List keeps its gap above it. */
function GroupGap() {
  return <View style={styles.groupGap} />
}

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
              heading={phase ? <DeckPhaseHeading phase={phase} /> : undefined}
              header={phase ? undefined : <GroupGap />}
            >
              {phase &&
                leadingSeats.map((id) => (
                  <DeckRow key={id}>
                    <DeckAgentRow
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
                      <DeckTaskRow
                        task={task}
                        indent={indent}
                        first={row === 0 && leadingSeats.length === 0}
                        onPress={() => onOpenTask(task.id)}
                        onLongPress={() => onOpenTaskMenu(task.id)}
                      />
                    </DeckRow>
                    {seats.map((id) => (
                      <DeckRow key={id}>
                        <DeckAgentRow
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

/** Every row's glyph column, then its text column, on the 4pt grid. */
const GUTTER = 20
const INSET = space.lg
/** A child's glyph sits in its parent's title column, like its seats. */
const _INDENT = GUTTER + space.md
const _ROW_H = 44
/** UISegmentedControl stops growing its labels a little past the default size. */
const SEGMENT_MAX_SCALE = 1.35

const CHIP_SLOP = { top: 6, bottom: 6 }
const TOGGLE_SLOP = { top: 12, bottom: 12, left: 8, right: 8 }
const SECTION_SLOP = { top: 6, bottom: 6 }
const _DISCLOSURE_SLOP = { top: 4, bottom: 4, left: 8, right: 4 }
const styles = StyleSheet.create({
  head: { gap: space.sm, paddingHorizontal: INSET, paddingTop: space.sm },
  headAbove: { paddingBottom: space.lg },
  title: {
    ...sans(600),
    color: color.text,
    fontSize: font.body,
    lineHeight: 24,
  },
  sub: { ...sans(400), color: color.textDim, fontSize: font.tiny, lineHeight: leading(font.tiny) },
  vitalsRow: { flexDirection: 'row', alignItems: 'center', gap: space.md },
  vitalsText: { flex: 1, minWidth: 0 },
  doneToggle: { flexShrink: 0, minHeight: 20, justifyContent: 'center' },
  doneToggleLabel: { ...sans(400), color: deckColor.live, fontSize: font.tiny },
  dimmed: { opacity: 0.5 },
  // SwiftUI keeps ~20pt between any header and its first row: that is the gap.
  groupGap: { height: 0 },
  segments: {
    flexDirection: 'row',
    minHeight: 32,
    padding: 2,
    gap: 2,
    borderRadius: radius.card,
    backgroundColor: color.tertiaryFill,
  },
  filterBar: { paddingHorizontal: INSET, paddingTop: space.xl },
  segment: {
    flexGrow: 1,
    flexShrink: 1,
    flexBasis: 'auto',
    minHeight: 28,
    paddingHorizontal: space.sm,
    borderRadius: radius.control,
    alignItems: 'center',
    justifyContent: 'center',
  },
  segmentOn: {
    backgroundColor: deckColor.segmentThumb,
    shadowColor: '#000',
    shadowOpacity: 0.12,
    shadowRadius: 4,
    shadowOffset: { width: 0, height: 1 },
  },
  segmentLabel: { ...sans(500), color: color.text, fontSize: font.tiny },
  segmentLabelOn: { ...sans(600) },
  segmentCount: { ...sans(400), color: color.textDim, fontVariant: ['tabular-nums'] },
  section: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    paddingLeft: INSET,
    paddingRight: INSET,
    paddingTop: space.xl,
    paddingBottom: space.sm,
  },
  sectionToggle: {
    flex: 1,
    minWidth: 0,
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
  },
  sectionTitle: {
    ...sans(600),
    flex: 1,
    minWidth: 0,
    color: color.text,
    fontSize: font.body,
    lineHeight: leading(font.body),
  },
  /** Count and chevron share one trailing column on every heading. */
  sectionTrail: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  sectionCount: {
    ...sans(400),
    color: color.textDim,
    fontSize: font.small,
    fontVariant: ['tabular-nums'],
  },
  sectionAction: { justifyContent: 'center' },
  sectionActionLabel: { ...sans(400), color: deckColor.proposalText, fontSize: font.small },
  gutter: { width: GUTTER, alignItems: 'center', justifyContent: 'center' },
  // Row glyphs sit on the title's first line (Reminders, Mail), whatever the
  // row's height: a box one title line tall, below the text's top padding.
  needsText: { color: deckColor.needsYou },
  empty: {
    ...sans(400),
    color: color.textDim,
    fontSize: font.tiny,
    paddingHorizontal: INSET,
    paddingVertical: space.md,
  },
})

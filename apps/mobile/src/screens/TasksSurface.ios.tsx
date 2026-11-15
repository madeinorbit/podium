import { Host } from '@expo/ui'
import {
  Button,
  HStack,
  Image,
  List,
  Section,
  Spacer,
  SwipeActions,
  Text,
  VStack,
} from '@expo/ui/swift-ui'
import {
  Animation,
  accessibilityElement,
  accessibilityHidden,
  accessibilityHint,
  accessibilityIdentifier,
  accessibilityLabel,
  alignmentGuide,
  animation,
  background,
  buttonStyle,
  contentShape,
  font,
  foregroundStyle,
  frame,
  lineLimit,
  listRowBackground,
  listRowInsets,
  listRowSeparator,
  listRowSeparatorTint,
  listSectionMargins,
  listSectionSpacing,
  listStyle,
  monospacedDigit,
  onAppear,
  onDisappear,
  onGeometryChange,
  padding,
  refreshable,
  scrollContentBackground,
  shapes,
  tint,
} from '@expo/ui/swift-ui/modifiers'
import { relativeTime } from '@podium/client-core/focus'
import type { BoardFilter, IssueNavigationModel } from '@podium/client-core/values'
import type { BoardListRow } from '@podium/client-graph/issue-board-schema'
import { here } from '@podium/client-graph/lookup'
import {
  MOBILE_TASK_WINDOW_SIZE,
  type MobileTaskIssue,
  type MobileTasksBoard,
  type TaskRowMark,
} from '@podium/client-graph/mobile-tasks'
import { LOADING } from '@podium/client-graph/worklist/rollup'
import { isFinished } from '@podium/model/browser'
import { issueDisplayRef } from '@podium/protocol'
import { observer } from 'mobx-react-lite'
import { Fragment, type ReactNode, useState } from 'react'
import { StyleSheet, useWindowDimensions, View } from 'react-native'
import { issueObserver as taskObserver } from '../client/issue-observer'
import { useMobilePool } from '../client/mobile-pool'
import { ContextMenu } from '../components/ContextMenu.ios'
import { deckColor } from '../components/deck-colors'
import { IssueRowMenuItems } from '../components/IssueRowMenuItems.ios'
import { ChevronDown, Filter, MoreHorizontal, Plus } from '../components/icons'
import { ListNotices } from '../components/list-notices.ios'
import { listRowPress, listSearchStartsHidden } from '../components/list-row-press.ios'
import { ListSearchBar, useSearchLaunchTransition } from '../components/list-search-bar.ios'
import { NativeGroupHeader } from '../components/NativeGroupHeader.ios'
import { RefreshOffer } from '../components/RefreshOffer'
import { RevealSwipeActions } from '../components/RevealSwipeActions.ios'
import { Screen } from '../components/Screen'
import { StorageNoticeAlert } from '../components/StorageNoticeAlert'
import { ANY, useProjectFacet } from '../components/task-filter-facets'
import { WorkspaceContinuityNotice } from '../components/WorkspaceContinuityNotice'
import { useAgeNow } from '../lib/clock-hooks'
import { listOrderRevision } from '../lib/list-order-revision'
import { useRowPrime } from '../lib/use-row-prime'
import { sectionAnimationValue, useSettledOrder } from '../lib/use-settled-order'
import { color } from '../theme/theme'
import { type TasksSurfaceProps, taskRowFigure, tasksSubtitle } from './TasksSurface.types'
import { useStageFolds } from './tasks-folds'
import { workPaper as paper } from './work-paper'

/** Leading edge of a row's title: 12 inset + 14 mark + 8 gap, the board's axis. */
const ROW_AXIS = 34
/** Dynamic Type's accessibility sizes start here (Work uses the same line). */
const ACCESSIBILITY_SCALE = 1.6
const CARD_INSET = 12
/** Card rows on Work's grouped paper: the same ground, card and separator. */
/**
 * A card's first and last rows keep this much more room against its rounded
 * corners, at accessibility sizes only. At default sizes every row already sits
 * at the iOS 26 List minimum (52pt) with 44pt of content, so the edge added no
 * height and only pushed the first and last titles 4pt off-centre.
 */
const CARD_EDGE = 8
/** Task rows keep the system cell background (paper.card's exact values): a custom
 * listRowBackground suppresses the List's native touch-down highlight. */
const taskRowAt = (first: boolean, last: boolean, fontScale: number) => {
  const edge = fontScale >= ACCESSIBILITY_SCALE ? CARD_EDGE : 0
  return [
    listRowSeparatorTint(paper.separator),
    listRowInsets({
      leading: CARD_INSET,
      trailing: CARD_INSET,
      top: first ? edge : 0,
      bottom: last ? edge : 0,
    }),
  ]
}
const cardRowAt = (first: boolean, last: boolean, fontScale: number) => [
  listRowBackground(paper.card),
  ...taskRowAt(first, last, fontScale),
]
/** Rows that sit on the ground rather than in a card (headers, notes). */
const quietRow = [
  listRowBackground(paper.ground),
  listRowSeparator('hidden'),
  listRowInsets({ leading: 0, trailing: 0, top: 4, bottom: 4 }),
]
const noteRow = [
  listRowBackground(paper.ground),
  listRowSeparator('hidden'),
  listRowInsets({ leading: CARD_INSET, trailing: CARD_INSET, top: 8, bottom: 8 }),
]

const MARK_SYMBOL: Record<TaskRowMark, string> = {
  needs: 'circle.fill',
  working: 'circle',
  resting: 'circle',
  done: 'checkmark.circle',
}
const NO_FILTER: BoardFilter = {}

const MARK_COLOR: Record<TaskRowMark, string> = {
  needs: color.needsYouText,
  working: color.workingText,
  resting: color.textFaint,
  done: color.successText,
}

/**
 * THE TASKS TAB ON iOS — a real SwiftUI inset-grouped list. UIKit owns the
 * navigation bar, its large title, pull-down search and the tab bar; SwiftUI
 * owns the rows, their swipe actions and their context menus, so iOS draws the
 * Liquid Glass and the gestures itself.
 *
 * Stage groups open in the board's order. Backlog, Proposed and Done start
 * folded; Proposed is ONE row whose trailing "Screen" opens the screening deck,
 * because 700 proposals are a decision queue, not a list to scroll.
 */
export const TasksSurface = observer(function TasksSurface(props: TasksSurfaceProps) {
  const { board } = props
  const searchLaunch = useSearchLaunchTransition()
  const { fontScale } = useWindowDimensions()
  const folds = useStageFolds()
  // The shared board's groups: non-empty lanes plus the Proposed screening group.
  const groups = board?.groups ?? LOADING
  const pending = props.booting || groups === LOADING
  const ordered = groups === LOADING ? [] : groups
  const animate = useSettledOrder(
    listOrderRevision(
      ordered.map((section) => {
        const savedFold = folds[section.stage][0]
        return {
          key: section.stage,
          folded: board?.isFolded(savedFold) ?? savedFold,
          ids: section.rows,
        }
      }),
    ),
    !pending,
  )
  const proposals = board?.proposals ?? LOADING
  const screenable = proposals !== LOADING && proposals > 0
  const counts = board?.stageCounts ?? LOADING
  const subtitle = tasksSubtitle(board?.filter.projectPaths, counts === LOADING ? null : counts)
  const project = useProjectFacet({
    filter: board?.filter ?? NO_FILTER,
    onFilter: (filter) => board?.setFilter(filter),
  })
  const filtered = props.chips.length > 0
  const actions = [
    {
      label: filtered ? `Filter and display, ${props.chips.length} active` : 'Filter and display',
      icon: Filter,
      onPress: props.onFilters,
    },
    { label: 'New task', icon: Plus, onPress: props.onNewTask },
  ]

  return (
    // Mail's layout: the project scope is the leading bar picker, filter and
    // new task trail, and the stock large title carries the counts beneath.
    <Screen
      grouped
      large
      title="Tasks"
      subtitle={subtitle.counts || undefined}
      leadingActions={[
        {
          label: `Project: ${subtitle.project}`,
          title: subtitle.project,
          icon: ChevronDown,
          items: project.options.map((option) => ({
            label: option.value === ANY ? 'All projects' : option.label,
            selected: option.value === project.value,
            onPress: () => project.apply(option.value),
          })),
        },
      ]}
      // One native menu leaves room for the inline title at accessibility sizes.
      actions={
        fontScale >= 1.6
          ? [{ label: 'Task actions', icon: MoreHorizontal, items: actions }]
          : actions
      }
    >
      <ListSearchBar
        query={board?.searchFilter.text ?? ''}
        onQueryChange={(query) => {
          board?.search(query)
          if (!query) board?.clearFilter('text')
        }}
      />
      {/* Keep the Host first for native tab reselect scroll discovery. */}
      <View style={styles.listContainer}>
        <Host style={styles.host} seedColor={color.accentTint}>
          {/* Keep the scroll view that UIKit tracks for pull-down search. */}
          <List
            modifiers={[
              listStyle('insetGrouped'),
              listSectionSpacing(0),
              scrollContentBackground('hidden'),
              background(paper.ground),
              refreshable(props.refresh.onRefresh),
              accessibilityIdentifier('tasks-list'),
              listSearchStartsHidden(searchLaunch),
            ]}
          >
            <ListNotices>
              <StorageNoticeAlert />
              <RefreshOffer />
              <WorkspaceContinuityNotice />
            </ListNotices>
            {filtered ? (
              <Section>
                {props.chips.map((chip, index) => (
                  <Button
                    key={chip.key}
                    onPress={() => props.onRemoveFilter(chip.key)}
                    modifiers={[
                      ...cardRowAt(index === 0, index === props.chips.length - 1, fontScale),
                      accessibilityHint('Removes this filter.'),
                    ]}
                  >
                    <HStack spacing={8}>
                      <Text
                        modifiers={[foregroundStyle({ type: 'hierarchical', style: 'primary' })]}
                      >
                        {chip.label}
                      </Text>
                      <Spacer />
                      <Image
                        systemName="xmark.circle.fill"
                        modifiers={[
                          foregroundStyle({ type: 'hierarchical', style: 'tertiary' }),
                          accessibilityHidden(),
                        ]}
                      />
                    </HStack>
                  </Button>
                ))}
              </Section>
            ) : null}
            {ordered.map((section) => {
              const [savedFold, toggle] = folds[section.stage]
              const folded = board?.isFolded(savedFold) ?? savedFold
              const lane = board?.lanes.find((lane) => lane.stage === section.stage)
              const proposed = section.stage === 'proposed'
              return (
                <Fragment key={section.stage}>
                  {/* The header is its own quiet row (SwiftUI uppercases grouped
                    headers and pads them), with Work's compact 44pt hit target. */}
                  <Section modifiers={[listSectionMargins({ edges: 'vertical', length: 0 })]}>
                    <NativeGroupHeader
                      title={section.title}
                      count={section.total}
                      folded={folded}
                      onToggle={() => board?.toggleFold(toggle)}
                      trailing={
                        proposed && screenable ? (
                          <Button
                            onPress={props.onScreenProposals}
                            modifiers={[
                              buttonStyle('borderless'),
                              accessibilityLabel('Screen proposals'),
                              accessibilityHint(
                                `Decide on ${section.total} proposals one at a time.`,
                              ),
                            ]}
                          >
                            <Text
                              modifiers={[
                                font({ textStyle: 'body' }),
                                foregroundStyle(deckColor.proposalText),
                              ]}
                            >
                              Screen
                            </Text>
                          </Button>
                        ) : undefined
                      }
                    />
                  </Section>
                  {/* Rows animate per section, never the List itself: an animated
                    List frame drags the large-title header along (sim pass 2).
                    The section stays mounted when folded so the fold animates. */}
                  {!board || section.rows.length === 0 ? null : (
                    <Section
                      modifiers={[
                        listSectionMargins({ edges: 'vertical', length: 0 }),
                        animation(
                          Animation.default,
                          sectionAnimationValue(
                            animate,
                            listOrderRevision([{ key: section.stage, folded, ids: section.rows }]),
                          ),
                        ),
                      ]}
                    >
                      {folded
                        ? null
                        : section.rows.map((row, index) => (
                            <TaskSlot
                              key={row.id}
                              id={row.id}
                              depth={row.depth}
                              lane={lane}
                              first={index === 0}
                              last={index === section.rows.length - 1}
                              prime={index < MOBILE_TASK_WINDOW_SIZE}
                            >
                              <TaskRow row={row} board={board} props={props} />
                            </TaskSlot>
                          ))}
                    </Section>
                  )}
                </Fragment>
              )
            })}
            {!pending && ordered.length === 0 ? (
              <VStack alignment="leading" spacing={4} modifiers={noteRow}>
                <Text modifiers={[font({ textStyle: 'headline' })]}>
                  {board?.query.trim() || filtered ? 'No matching tasks' : 'No tasks'}
                </Text>
                <Text
                  modifiers={[
                    font({ textStyle: 'subheadline' }),
                    foregroundStyle({ type: 'hierarchical', style: 'secondary' }),
                  ]}
                >
                  {board?.query.trim() || filtered
                    ? 'Try another title or ID, or clear a filter.'
                    : 'Tasks filed in your repos show up here.'}
                </Text>
              </VStack>
            ) : null}
          </List>
        </Host>
      </View>
    </Screen>
  )
})

/** Placeholder height follows the last native measurement, including Dynamic Type. */
const TaskSlot = observer(function TaskSlot({
  id,
  depth,
  lane,
  first,
  last,
  prime,
  children,
}: {
  id: string
  depth: number
  lane: MobileTasksBoard['lanes'][number] | undefined
  first: boolean
  last: boolean
  /** A row in the first window draws itself on mount instead of a placeholder. */
  prime: boolean
  children: ReactNode
}) {
  const active = lane?.window.has(id) ?? false
  const [primed, unprime] = useRowPrime(prime)
  const shown = active || primed
  const [height, setHeight] = useState(44)
  const { fontScale } = useWindowDimensions()
  return (
    <VStack
      spacing={0}
      modifiers={[
        frame({ maxWidth: Infinity, alignment: 'leading' }),
        onAppear(() => lane?.window.appear(id)),
        onDisappear(() => {
          unprime()
          lane?.window.disappear(id)
        }),
        // Expo applies modifiers in order. Keep cell traits outside the frame
        // and measurement wrappers, on the Section's direct row view.
        // The guide is relative to content that already starts after the card inset.
        alignmentGuide('listRowSeparatorLeading', ROW_AXIS - CARD_INSET + depth * 16),
        ...taskRowAt(first, last, fontScale),
      ]}
    >
      {shown ? (
        <VStack
          spacing={0}
          modifiers={[
            frame({ maxWidth: Infinity, alignment: 'leading' }),
            // Cache the live content, before List adds row insets and its own
            // minimum. Measuring the cell feeds that extra height back into
            // placeholders when a long group recycles.
            onGeometryChange((content) => {
              if (content.height > 0) setHeight(content.height)
            }),
          ]}
        >
          {children}
        </VStack>
      ) : (
        <Spacer modifiers={[frame({ height })]} />
      )}
    </VStack>
  )
})

/**
 * A native task row: mark, title, ref, then child progress ("21/25") or age.
 * Swipe left for Status and Close; long press for Work's menu (Rename, Mark as
 * unread, Status, Move out of mission, Delete) plus the sub-task disclosure.
 */
const TaskRow = taskObserver(function TaskRow({
  row,
  board,
  props,
}: {
  row: BoardListRow
  board: MobileTasksBoard
  props: TasksSurfaceProps
}) {
  const pool = useMobilePool()
  const { fontScale } = useWindowDimensions()
  const issue = board.issue(row.id)
  if (!here(issue.row)) return null
  const finished = isFinished(issue)
  const task = board.task(issue.id)
  const mark = task.mark
  const childHit = task.childHit
  const child = childHit ? board.issue(childHit) : null
  const match = child && here(child.row) ? child : null
  const ref = issueDisplayRef(issue)
  const unread = Boolean((issue as unknown as { unread?: boolean }).unread)
  const notSaved = pool?.notSaved('issue', issue.id) ?? false
  const nav = issue as unknown as IssueNavigationModel
  const figure = issue.childCount > 0 ? taskRowFigure(task.progress, null) : ''
  const progress = figure ? `${figure} sub-tasks done` : ''
  const accessible = fontScale >= ACCESSIBILITY_SCALE
  const title = (lines: number) => (
    <Text
      modifiers={[
        font({ textStyle: 'body', weight: unread ? 'semibold' : 'regular' }),
        foregroundStyle({
          type: 'hierarchical',
          style: finished ? 'secondary' : 'primary',
        }),
        lineLimit(lines),
        frame({ maxWidth: Infinity, alignment: 'leading' }),
      ]}
    >
      {issue.title}
    </Text>
  )
  const refText = (
    <Text
      modifiers={[
        // Expo ignores size for a system textStyle font. RN's content-size
        // multiplier retains the 11pt base and system mono face.
        font({ size: 11 * fontScale, design: 'monospaced' }),
        foregroundStyle({ type: 'hierarchical', style: 'tertiary' }),
        lineLimit(1),
      ]}
    >
      {ref}
    </Text>
  )

  return (
    <SwipeActions>
      <ContextMenu>
        <ContextMenu.Trigger>
          <VStack
            alignment="leading"
            spacing={0}
            modifiers={[
              contentShape(shapes.rectangle()),
              accessibilityElement('ignore'),
              accessibilityLabel(
                `${issue.title}. ${ref}. ${progress}${match ? `. Matching sub-task ${match.displayRef}. ${match.title}` : ''}${unread ? '. Unread' : ''}${notSaved ? '. Not saved' : ''}`,
              ),
              accessibilityHint('Opens the task. Swipe or long press for actions.'),
              // Last: the native row Button (List highlight, label colours, taps only).
              // VoiceOver reads the Button from its label, so accessibility goes inside.
              listRowPress(() => props.onOpen(issue.id)),
            ]}
          >
            <HStack
              spacing={8}
              modifiers={[
                // Keep the native list minimum; this padding lets larger text
                // grow the content before it reaches the separators.
                padding({ vertical: 6 }),
                frame({ minHeight: 44, maxWidth: Infinity, alignment: 'leading' }),
                contentShape(shapes.rectangle()),
              ]}
            >
              {row.depth > 0 ? <Spacer modifiers={[frame({ width: row.depth * 16 - 8 })]} /> : null}
              <Image
                systemName={MARK_SYMBOL[mark]}
                size={mark === 'needs' ? 8 : 10}
                color={MARK_COLOR[mark]}
                modifiers={[frame({ width: 14 }), accessibilityHidden()]}
              />
              {accessible ? (
                // Accessibility sizes (as Mail): the title takes the row's width and
                // up to three lines; ID and figure wrap to their own line below it.
                <VStack
                  alignment="leading"
                  spacing={2}
                  modifiers={[frame({ maxWidth: Infinity, alignment: 'leading' })]}
                >
                  {title(3)}
                  <HStack spacing={8}>
                    {refText}
                    <TaskFigure issue={issue} board={board} fontScale={fontScale} />
                  </HStack>
                </VStack>
              ) : (
                title(1)
              )}
              {unread ? (
                <Image
                  systemName="circle.fill"
                  size={6}
                  color={color.workingText}
                  modifiers={[accessibilityHidden()]}
                />
              ) : null}
              {notSaved ? (
                <Image
                  systemName="exclamationmark.icloud"
                  size={12}
                  color={color.dangerText}
                  modifiers={[accessibilityHidden()]}
                />
              ) : null}
              {accessible ? null : refText}
              {accessible ? null : <TaskFigure issue={issue} board={board} fontScale={fontScale} />}
            </HStack>
            {match ? (
              <HStack modifiers={[padding({ leading: 22 + row.depth * 16, bottom: 6 })]}>
                <TaskSearchHit issue={match} fontScale={fontScale} />
              </HStack>
            ) : null}
          </VStack>
        </ContextMenu.Trigger>
        <ContextMenu.Items>
          {row.childCount > 0 ? (
            <Button
              label={row.expanded ? 'Hide Sub-tasks' : `Show Sub-tasks (${row.childCount})`}
              systemImage={row.expanded ? 'chevron.up' : 'chevron.down'}
              onPress={() => board.toggleExpanded(issue.id)}
            />
          ) : null}
          <IssueRowMenuItems
            issue={nav}
            lane="live"
            onAction={(action) => props.onAction(issue.id, action)}
            onStatus={(value) => props.onStatus(issue.id, value)}
          />
        </ContextMenu.Items>
      </ContextMenu>
      <RevealSwipeActions edge="trailing">
        {finished ? null : (
          <Button
            label="Close"
            systemImage="checkmark"
            onPress={() => props.onClose(issue.id)}
            modifiers={[tint(color.accentTint)]}
          />
        )}
        <Button
          label="Status"
          systemImage="circle.dashed"
          onPress={() => props.onAction(issue.id, 'status')}
          modifiers={[tint('#636366')]}
        />
      </RevealSwipeActions>
    </SwipeActions>
  )
})

/** The child that explains a collapsed parent's search result, as on Work. */
const TaskSearchHit = observer(function TaskSearchHit({
  issue,
  fontScale,
}: {
  issue: MobileTaskIssue
  fontScale: number
}) {
  return (
    <HStack spacing={4}>
      <Image
        systemName="arrow.turn.down.right"
        modifiers={[
          font({ textStyle: 'caption2' }),
          foregroundStyle(paper.tertiary),
          accessibilityHidden(),
        ]}
      />
      <Text
        modifiers={[
          font({ size: 11 * fontScale, design: 'monospaced' }),
          foregroundStyle(paper.tertiary),
          lineLimit(1),
        ]}
      >
        {issue.displayRef}
      </Text>
      <Text
        modifiers={[
          font({ textStyle: 'footnote' }),
          foregroundStyle(paper.secondary),
          lineLimit(fontScale >= ACCESSIBILITY_SCALE ? 2 : 1),
        ]}
      >
        {issue.title}
      </Text>
    </HStack>
  )
})

const figureModifiers = [
  foregroundStyle({ type: 'hierarchical', style: 'tertiary' }),
  monospacedDigit(),
  lineLimit(1),
]

const TaskFigure = observer(function TaskFigure({
  issue,
  board,
  fontScale,
}: {
  issue: MobileTaskIssue
  board: MobileTasksBoard
  fontScale: number
}) {
  return issue.childCount > 0 ? (
    <Text modifiers={[font({ size: 12 * fontScale, design: 'monospaced' }), ...figureModifiers]}>
      {taskRowFigure(board.task(issue.id).progress, null)}
    </Text>
  ) : (
    <TaskAge issue={issue} fontScale={fontScale} />
  )
})

const TaskAge = observer(function TaskAge({
  issue,
  fontScale,
}: {
  issue: MobileTaskIssue
  fontScale: number
}) {
  const now = useAgeNow(issue.updatedAt)
  return (
    <Text modifiers={[font({ size: 12 * fontScale, design: 'monospaced' }), ...figureModifiers]}>
      {taskRowFigure(null, relativeTime(issue.updatedAt, now))}
    </Text>
  )
})

const styles = StyleSheet.create({
  root: { flex: 1, minHeight: 0 },
  host: { flex: 1 },
  listContainer: { flex: 1, minHeight: 0 },
})

import { Host } from '@expo/ui'
import {
  Button,
  ContextMenu,
  HStack,
  Image,
  List,
  Picker,
  ProgressView,
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
  pickerStyle,
  refreshable,
  scrollContentBackground,
  shapes,
  tag,
  tint,
} from '@expo/ui/swift-ui/modifiers'
import { relativeTime } from '@podium/client-core/focus'
import {
  type BoardFilter,
  discoveredPlacement,
  type IssueNavigationModel,
} from '@podium/client-core/values'
import type { BoardListRow } from '@podium/client-graph/issue-board-schema'
import { here } from '@podium/client-graph/lookup'
import {
  MOBILE_TASK_WINDOW_SIZE,
  type MobileTaskIssue,
  type MobileTasksBoard,
  type TaskRowMark,
} from '@podium/client-graph/mobile-tasks'
import { LOADING } from '@podium/client-graph/worklist/rollup'
import { issueStatusMenuEntries, issueStatusValueOf } from '@podium/model'
import { isFinished } from '@podium/model/browser'
import { issueDisplayRef } from '@podium/protocol'
import { Stack } from 'expo-router'
import { observer } from 'mobx-react-lite'
import { Fragment, type ReactNode, useState } from 'react'
import { StyleSheet, useWindowDimensions, View } from 'react-native'
import { issueObserver as taskObserver } from '../client/issue-observer'
import { useMobilePool } from '../client/mobile-pool'
import { ChevronDown, Filter, MoreHorizontal, Plus } from '../components/icons'
import { NativeGroupHeader } from '../components/NativeGroupHeader.ios'
import { RefreshOffer } from '../components/RefreshOffer'
import { Screen } from '../components/Screen'
import { StorageNoticeAlert } from '../components/StorageNoticeAlert'
import { ANY, useProjectFacet } from '../components/task-filter-facets'
import { useAgeNow } from '../lib/clock-hooks'
import { listOrderRevision } from '../lib/list-order-revision'
import { useRowPrime } from '../lib/use-row-prime'
import { sectionAnimationValue, useSettledOrder } from '../lib/use-settled-order'
import { workMenuActionIds } from '../lib/work-menu'
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
/** A card's first and last rows keep this much more room against its rounded corners. */
const CARD_EDGE = 8
const cardRowAt = (first: boolean, last: boolean) => [
  listRowBackground(paper.card),
  listRowSeparatorTint(paper.separator),
  listRowInsets({
    leading: CARD_INSET,
    trailing: CARD_INSET,
    top: first ? CARD_EDGE : 0,
    bottom: last ? CARD_EDGE : 0,
  }),
]
/** Rows that sit on the ground rather than in a card (headers, notes). */
const quietRow = [
  listRowBackground(paper.ground),
  listRowSeparator('hidden'),
  listRowInsets({ leading: 0, trailing: 0, top: 4, bottom: 4 }),
]
const noteRow = [
  ...quietRow,
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
 * navigation bar, its large title, the search magnifier and the tab bar; SwiftUI
 * owns the rows, their swipe actions and their context menus, so iOS draws the
 * Liquid Glass and the gestures itself.
 *
 * Stage groups open in the board's order. Backlog, Proposed and Done start
 * folded; Proposed is ONE row whose trailing "Screen" opens the screening deck,
 * because 700 proposals are a decision queue, not a list to scroll.
 */
export const TasksSurface = observer(function TasksSurface(props: TasksSurfaceProps) {
  const { board } = props
  const { fontScale } = useWindowDimensions()
  const [listRevision, setListRevision] = useState(0)
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
      // One native menu leaves room for the search button at accessibility sizes.
      actions={
        fontScale >= 1.6
          ? [{ label: 'Task actions', icon: MoreHorizontal, items: actions }]
          : actions
      }
    >
      {/* Search the whole board (BoardFilter.text, backlog, done and proposals
          included) from the native magnifier. Not the stacked field: a SwiftUI
          List is not a scroll view UIKit's bar can track, so that field would
          sit open under the title instead of hiding until pulled down. */}
      <Stack.SearchBar
        placement="integratedButton"
        placeholder="Search tasks or ID"
        autoCapitalize="none"
        onChangeText={(event) => board?.search(event.nativeEvent.text)}
        onCancelButtonPress={() => {
          board?.search('')
          // SwiftUI otherwise anchors the restored groups to the last search
          // result. A fresh List returns to the top, including an empty search.
          setListRevision((revision) => revision + 1)
        }}
      />
      {/* Keep the Host first for native tab reselect scroll discovery. The
          reversed column still places React Native notices above the list. */}
      <View style={styles.listContainer}>
        <Host style={styles.host} seedColor={color.accentTint}>
          <List
            key={listRevision}
            modifiers={[
              listStyle('insetGrouped'),
              listSectionSpacing(0),
              scrollContentBackground('hidden'),
              background(paper.ground),
              refreshable(props.refresh.onRefresh),
              accessibilityIdentifier('tasks-list'),
            ]}
          >
            {filtered ? (
              <Section>
                {props.chips.map((chip, index) => (
                  <Button
                    key={chip.key}
                    onPress={() => props.onRemoveFilter(chip.key)}
                    modifiers={[
                      ...cardRowAt(index === 0, index === props.chips.length - 1),
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
            {pending ? <ProgressView modifiers={quietRow} /> : null}
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
                                foregroundStyle(color.accentTint),
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
        <View>
          <StorageNoticeAlert />
          <RefreshOffer />
        </View>
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
        onGeometryChange((frame) => {
          if (shown && frame.height > 0) setHeight(frame.height)
        }),
        // Expo applies modifiers in order. Keep cell traits outside the frame
        // and measurement wrappers, on the Section's direct row view.
        // The guide is relative to content that already starts after the card inset.
        alignmentGuide('listRowSeparatorLeading', ROW_AXIS - CARD_INSET + depth * 16),
        ...cardRowAt(first, last),
      ]}
    >
      {shown ? children : <Spacer modifiers={[frame({ height })]} />}
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
  const mark = board.task(issue.id).mark
  const ref = issueDisplayRef(issue)
  const unread = Boolean((issue as unknown as { unread?: boolean }).unread)
  const notSaved = pool?.notSaved('issue', issue.id) ?? false
  const nav = issue as unknown as IssueNavigationModel
  const placement = discoveredPlacement(nav)
  const actions = workMenuActionIds(nav, 'live', { placement: Boolean(placement?.originId) })
  const progress = issue.childCount > 0 ? `${taskRowFigure(issue, null)} sub-tasks done` : ''
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
          <Button
            onPress={() => props.onOpen(issue.id)}
            modifiers={[
              buttonStyle('plain'),
              accessibilityElement('ignore'),
              accessibilityLabel(
                `${issue.title}. ${ref}. ${progress}${unread ? '. Unread' : ''}${notSaved ? '. Not saved' : ''}`,
              ),
              accessibilityHint('Opens the task. Swipe or long press for actions.'),
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
                    <TaskFigure issue={issue} fontScale={fontScale} />
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
              {accessible ? null : <TaskFigure issue={issue} fontScale={fontScale} />}
            </HStack>
          </Button>
        </ContextMenu.Trigger>
        <ContextMenu.Items>
          {row.childCount > 0 ? (
            <Button
              label={row.expanded ? 'Hide Sub-tasks' : `Show Sub-tasks (${row.childCount})`}
              systemImage={row.expanded ? 'chevron.up' : 'chevron.down'}
              onPress={() => board.toggleExpanded(issue.id)}
            />
          ) : null}
          {actions.map((action) => {
            if (action === 'status')
              return (
                <Picker
                  key={action}
                  label="Status"
                  selection={issueStatusValueOf(issue)}
                  onSelectionChange={(value) => props.onStatus(issue.id, String(value))}
                  modifiers={[pickerStyle('menu')]}
                >
                  {issueStatusMenuEntries().map((entry) => (
                    <Text key={entry.value} modifiers={[tag(entry.value)]}>
                      {entry.label}
                    </Text>
                  ))}
                </Picker>
              )
            const label =
              action === 'rename'
                ? 'Rename'
                : action === 'read'
                  ? unread
                    ? 'Mark as Read'
                    : 'Mark as Unread'
                  : action === 'placement'
                    ? placement?.placement === 'mission'
                      ? 'Move out of Mission'
                      : 'Move into Parent Task'
                    : 'Delete…'
            const symbol =
              action === 'rename'
                ? 'pencil'
                : action === 'read'
                  ? unread
                    ? 'envelope.open'
                    : 'circle.fill'
                  : action === 'placement'
                    ? 'arrow.right'
                    : 'trash'
            return (
              <Button
                key={action}
                label={label}
                systemImage={symbol}
                role={action === 'delete' ? 'destructive' : 'default'}
                onPress={() => props.onAction(issue.id, action)}
              />
            )
          })}
        </ContextMenu.Items>
      </ContextMenu>
      <SwipeActions.Actions edge="trailing" allowsFullSwipe={false}>
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
      </SwipeActions.Actions>
    </SwipeActions>
  )
})

const figureModifiers = [
  foregroundStyle({ type: 'hierarchical', style: 'tertiary' }),
  monospacedDigit(),
  lineLimit(1),
]

const TaskFigure = observer(function TaskFigure({
  issue,
  fontScale,
}: {
  issue: MobileTaskIssue
  fontScale: number
}) {
  return issue.childCount > 0 ? (
    <Text modifiers={[font({ size: 12 * fontScale, design: 'monospaced' }), ...figureModifiers]}>
      {taskRowFigure(issue, null)}
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
      {taskRowFigure(issue, relativeTime(issue.updatedAt, now))}
    </Text>
  )
})

const styles = StyleSheet.create({
  root: { flex: 1, minHeight: 0 },
  host: { flex: 1 },
  listContainer: { flex: 1, minHeight: 0, flexDirection: 'column-reverse' },
})

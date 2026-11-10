import { relativeTime } from '@podium/client-core/focus'
import { type RankedTaskIssue, taskStateWord } from '@podium/client-core/values'
import type { BoardListRow } from '@podium/client-graph/issue-board-schema'
import { here } from '@podium/client-graph/lookup'
import type { MobileTaskIssue, MobileTasksBoard } from '@podium/client-graph/mobile-tasks'
import { LOADING } from '@podium/client-graph/worklist/rollup'
import type { IssueBoardStage } from '@podium/model'
import { isFinished } from '@podium/model/browser'
import { issueDisplayRef } from '@podium/protocol'
import { Stack } from 'expo-router'
import { observer } from 'mobx-react-lite'
import { useCallback, useState } from 'react'
import { SectionList, StyleSheet, Text, TextInput, View } from 'react-native'
import { Icon } from '../components/Icon'
import { ChevronDown, ChevronRight, Filter, Plus, Search, X } from '../components/icons'
import { BootstrapCrossfade, TasksSkeleton } from '../components/LaunchPlaceholders'
import { listWindow } from '../components/list-window'
import { NotSavedMark } from '../components/NotSavedMark'
import { PressableScale } from '../components/PressableScale'
import { PullToRefreshBoundary } from '../components/PullToRefreshBoundary'
import { RefreshOffer } from '../components/RefreshOffer'
import { HeaderButton, Screen } from '../components/Screen'
import { StorageNoticeAlert } from '../components/StorageNoticeAlert'
import { EmptyState } from '../components/ui'
import { useCollapsed } from '../hooks/useCollapsed'
import { useAgeNow } from '../lib/clock-hooks'
import { stageFoldKey } from '../lib/fold-keys'
import { taskRowAccessibilityProps } from '../lib/task-row-accessibility'
import { color, font, mono, radius, sans, space } from '../theme/theme'
import {
  FOLDED_BY_DEFAULT,
  type TaskRowMark,
  type TasksSurfaceProps,
  taskRowFigure,
  taskRowMark,
} from './TasksSurface.types'

const usesNativeHeader = process.env.EXPO_OS !== 'web'

interface Section {
  key: IssueBoardStage
  stage: IssueBoardStage
  title: string
  /** How many TASKS this group holds — its roots, not its rendered rows. */
  total: number
  folded: boolean
  data: readonly BoardListRow[]
}

/**
 * THE TASKS TAB, React Native — the web build and Android. iOS draws
 * `TasksSurface.ios.tsx`, a SwiftUI list; this one follows the same board:
 * stage groups as inset cards of 44pt rows, a chevron + name + count header
 * that folds the group, and Proposed as one folded group with "Screen".
 */
export const TasksSurface = observer(function TasksSurface(props: TasksSurfaceProps) {
  const { board, chips } = props
  const [searchOpen, setSearchOpen] = useState(false)
  return (
    <Screen
      large
      title="Tasks"
      right={
        <>
          {usesNativeHeader ? null : (
            <HeaderButton
              label={searchOpen ? 'Close task search' : 'Search tasks'}
              onPress={() => {
                setSearchOpen((open) => !open)
                if (searchOpen) board?.search('')
              }}
            >
              <Icon as={searchOpen ? X : Search} size={18} color={color.textDim} />
            </HeaderButton>
          )}
          <HeaderButton
            label={
              chips.length > 0 ? `Filter and display, ${chips.length} active` : 'Filter and display'
            }
            onPress={props.onFilters}
          >
            <Icon as={Filter} size={19} color={chips.length > 0 ? color.accentTint : color.text} />
          </HeaderButton>
          <HeaderButton label="New task" onPress={props.onNewTask}>
            <Icon as={Plus} size={19} color={color.text} />
          </HeaderButton>
        </>
      }
    >
      {usesNativeHeader ? (
        <Stack.SearchBar
          placeholder="Search tasks or ID"
          hideWhenScrolling
          onChangeText={(event) => board?.search(event.nativeEvent.text)}
          onCancelButtonPress={() => board?.search('')}
        />
      ) : null}
      {!usesNativeHeader && searchOpen ? (
        <View style={styles.searchBand}>
          <Icon as={Search} size={15} color={color.textFaint} />
          <TextInput
            autoFocus
            accessibilityLabel="Search tasks"
            value={board?.query ?? ''}
            onChangeText={(text) => board?.search(text)}
            placeholder="Search tasks or ID…"
            placeholderTextColor={color.textFaint}
            style={styles.searchInput}
            returnKeyType="search"
          />
        </View>
      ) : null}
      <PullToRefreshBoundary
        connected={props.refresh.connected}
        refreshing={props.refresh.refreshing}
        onRefresh={props.refresh.onRefresh}
      >
        <StageSections {...props} />
      </PullToRefreshBoundary>
    </Screen>
  )
})

/**
 * The list. Split out so the per-stage `useCollapsed` hooks live in one place:
 * hooks cannot run in a loop over a variable-length list, so the folds are read
 * for the six known stages up front and looked up by key.
 */
const StageSections = observer(function StageSections(props: TasksSurfaceProps) {
  const { board, chips } = props
  // Keys come from `../lib/fold-keys`: the ui-state classifier THROWS on an
  // unregistered key. See that module for why folds replicate per user.
  const folds: Record<IssueBoardStage, ReturnType<typeof useCollapsed>> = {
    proposed: useCollapsed(stageFoldKey('proposed'), FOLDED_BY_DEFAULT.proposed),
    backlog: useCollapsed(stageFoldKey('backlog'), FOLDED_BY_DEFAULT.backlog),
    planning: useCollapsed(stageFoldKey('planning'), FOLDED_BY_DEFAULT.planning),
    in_progress: useCollapsed(stageFoldKey('in_progress'), FOLDED_BY_DEFAULT.in_progress),
    review: useCollapsed(stageFoldKey('review'), FOLDED_BY_DEFAULT.review),
    done: useCollapsed(stageFoldKey('done'), FOLDED_BY_DEFAULT.done),
  }
  const onToggleExpanded = useCallback((id: string) => board?.toggleExpanded(id), [board])
  const membership = board?.sections ?? LOADING
  const pending = props.booting || membership === LOADING
  const proposals = board?.proposals ?? LOADING
  const proposalCount = proposals === LOADING ? 0 : proposals
  const lanes = membership === LOADING ? [] : membership
  const sections: Section[] = lanes.map((s) => ({
    key: s.stage,
    stage: s.stage,
    title: s.title,
    total: s.stage === 'proposed' ? proposalCount : s.total,
    folded: folds[s.stage][0],
    // A folded group keeps its header (and so its count) and drops its rows.
    data: folds[s.stage][0] ? [] : s.rows,
  }))
  // The screening queue does not change with the board's filter, so the
  // Proposed group shows whenever proposals wait.
  if (!pending && proposalCount > 0 && !lanes.some((s) => s.stage === 'proposed')) {
    const doneAt = sections.findIndex((s) => s.stage === 'done')
    const proposed: Section = {
      key: 'proposed',
      stage: 'proposed',
      title: 'Proposed',
      total: proposalCount,
      folded: true,
      data: [],
    }
    sections.splice(doneAt < 0 ? sections.length : doneAt, 0, proposed)
  }

  return (
    <BootstrapCrossfade resolved={!pending} placeholder={<TasksSkeleton />}>
      <SectionList
        {...listWindow}
        ref={props.refresh.listRef as never}
        sections={sections}
        keyExtractor={(row) => row.id}
        stickySectionHeadersEnabled={false}
        contentInsetAdjustmentBehavior="automatic"
        keyboardDismissMode="interactive"
        refreshControl={props.refresh.refreshControl}
        contentContainerStyle={[
          styles.listContent,
          { paddingBottom: props.bottomInset + space.lg },
        ]}
        {...props.refresh.refreshAccessibilityProps}
        {...props.minimizeOnScroll}
        scrollEventThrottle={listWindow.scrollEventThrottle}
        ListHeaderComponent={
          <>
            <StorageNoticeAlert />
            <RefreshOffer />
            {chips.length > 0 ? (
              <View style={styles.filterSummary} accessibilityRole="summary">
                {chips.map((chip) => (
                  <PressableScale
                    key={chip.key}
                    accessibilityRole="button"
                    accessibilityLabel={`Remove ${chip.label} filter`}
                    onPress={() => props.onRemoveFilter(chip.key)}
                    style={({ pressed }) => [styles.filterChip, pressed && styles.pressed]}
                  >
                    <Text style={styles.filterChipText}>{chip.label}</Text>
                    <Icon as={X} size={11} color={color.textDim} />
                  </PressableScale>
                ))}
              </View>
            ) : null}
          </>
        }
        renderSectionHeader={({ section }) => (
          <GroupHeader
            title={section.title}
            count={section.total}
            collapsed={section.folded}
            onToggle={folds[section.stage][1]}
            {...(section.stage === 'proposed' && proposalCount > 0
              ? { onScreen: props.onScreenProposals }
              : {})}
          />
        )}
        renderItem={({ item, index, section }) => (
          <TaskRow
            row={item}
            issue={board!.issue(item.id)}
            first={index === 0}
            last={index === section.data.length - 1}
            onOpen={props.onOpen}
            onToggleExpanded={onToggleExpanded}
            onOpenActions={props.onOpenActions}
          />
        )}
        ListEmptyComponent={
          // `ListEmptyComponent` renders whenever data is empty, with no notion
          // of loading; without the guard it sits under the placeholder.
          pending ? null : (
            <EmptyState title="No tasks" body="Tasks filed in your repos show up here." />
          )
        }
      />
    </BootstrapCrossfade>
  )
})

/** A group header on the card's own axis: chevron, name, count, and for
 *  Proposed a trailing "Screen". The whole bar folds the group. */
function GroupHeader({
  title,
  count,
  collapsed,
  onToggle,
  onScreen,
}: {
  title: string
  count: number
  collapsed: boolean
  onToggle: () => void
  onScreen?: () => void
}) {
  return (
    <View style={styles.header}>
      <PressableScale
        accessibilityRole="button"
        // `aria-expanded` beside `accessibilityState`: react-native-web reads
        // only the former. [POD-1664]
        accessibilityState={{ expanded: !collapsed }}
        aria-expanded={!collapsed}
        accessibilityLabel={`${title}, ${count} task${count === 1 ? '' : 's'}`}
        accessibilityHint={collapsed ? 'Show this group' : 'Fold this group away'}
        onPress={onToggle}
        hitSlop={8}
        scaleTo={1}
        style={styles.headerFold}
      >
        <Icon as={collapsed ? ChevronRight : ChevronDown} size={14} color={color.textFaint} />
        <Text style={styles.headerTitle}>{title}</Text>
        <Text style={styles.headerCount}>{count}</Text>
      </PressableScale>
      {onScreen ? (
        <PressableScale
          accessibilityRole="button"
          accessibilityLabel="Screen proposed"
          accessibilityHint={`Decide on ${count} proposal${count === 1 ? '' : 's'} one at a time`}
          onPress={onScreen}
          hitSlop={8}
          style={styles.screen}
        >
          <Text style={styles.screenText}>Screen</Text>
        </PressableScale>
      ) : null}
    </View>
  )
}

/**
 * One 44pt row: mark, ref, title, then child progress ("21/25") or age. On a
 * parent the progress figure is also the disclosure that reveals its children
 * in place; the row itself opens the task.
 */
const TaskRow = observer(function TaskRow({
  row,
  issue,
  first,
  last,
  onOpen,
  onToggleExpanded,
  onOpenActions,
}: {
  row: BoardListRow
  issue: MobileTaskIssue
  first: boolean
  last: boolean
  onOpen: (id: string) => void
  onToggleExpanded: (id: string) => void
  onOpenActions: (issue: MobileTaskIssue) => void
}) {
  const loaded = here(issue.row)
  const now = useAgeNow(loaded ? issue.updatedAt : new Date(0).toISOString())
  const edge = [styles.rowWrap, first && styles.rowFirst, last && styles.rowLast]
  // The shared load window resolves just this drawn row; membership stays live.
  if (!loaded) return <View style={[edge, styles.rowPlaceholder]} />
  let workingAgents: number, progress: MobileTaskIssue['taskProgress']
  try {
    workingAgents = issue.confirmedWorkingAgents
    progress = issue.taskProgress
  } catch (error) {
    if (error === LOADING) return <View style={[edge, styles.rowPlaceholder]} />
    throw error
  }
  const finished = isFinished(issue)
  const mark = taskRowMark(issue, finished)
  const state = taskStateWord(issue as unknown as RankedTaskIssue, workingAgents, progress)
  const parent = issue.treeParent
  const parentModel = parent === LOADING ? null : parent
  const figure = taskRowFigure(issue, relativeTime(issue.updatedAt, now))
  const childCount = row.childCount
  const accessibility = taskRowAccessibilityProps({
    seq: issue.seq,
    title: issue.title,
    ...(state ? { stateText: state.text } : {}),
    onOpen: () => onOpen(issue.id),
    onShowActions: () => onOpenActions(issue),
  })
  return (
    <View style={edge}>
      <PressableScale
        accessibilityRole="button"
        {...accessibility}
        // THE DISCLOSURE IS AN ACTION ON THE ROW, not a button inside it: a
        // nested pressable inside an `accessible` parent is unreachable on iOS.
        accessibilityState={childCount > 0 ? { expanded: row.expanded } : undefined}
        aria-expanded={childCount > 0 ? row.expanded : undefined}
        accessibilityActions={
          childCount > 0
            ? [
                ...(accessibility.accessibilityActions ?? []),
                { name: 'expand', label: row.expanded ? 'Hide sub-tasks' : 'Show sub-tasks' },
              ]
            : accessibility.accessibilityActions
        }
        onAccessibilityAction={(event) => {
          if (event.nativeEvent.actionName === 'expand') {
            onToggleExpanded(issue.id)
            return
          }
          accessibility.onAccessibilityAction?.(event)
        }}
        onPress={() => onOpen(issue.id)}
        onLongPress={() => onOpenActions(issue)}
        scaleTo={1}
        style={({ pressed }) => [
          styles.row,
          row.depth > 0 && { paddingLeft: space.md + row.depth * CHILD_INDENT },
          pressed && styles.pressed,
        ]}
      >
        {first ? null : <View style={[styles.separator, { left: SEPARATOR_INSET }]} />}
        <View style={styles.gutter}>
          <Mark mark={mark} />
        </View>
        <Text style={styles.ref} numberOfLines={1}>
          {issueDisplayRef(issue)}
        </Text>
        <Text style={[styles.title, finished && styles.titleFinished]} numberOfLines={1}>
          {parentModel && row.depth === 0
            ? `${issue.title} · from ${issueDisplayRef(parentModel)}`
            : issue.title}
        </Text>
        <NotSavedMark kind="issue" id={issue.id} />
        {childCount > 0 ? (
          <PressableScale
            // The row carries this control's accessibility (its `expand` action).
            accessibilityElementsHidden
            importantForAccessibility="no-hide-descendants"
            onPress={() => onToggleExpanded(issue.id)}
            hitSlop={10}
            scaleTo={0.94}
            style={styles.disclosure}
          >
            <Text style={styles.figure}>{figure}</Text>
            <Icon
              as={row.expanded ? ChevronDown : ChevronRight}
              size={12}
              color={color.textFaint}
            />
          </PressableScale>
        ) : (
          <Text style={styles.figure}>{figure}</Text>
        )}
      </PressableScale>
    </View>
  )
})

function Mark({ mark }: { mark: TaskRowMark }) {
  if (mark === 'needs')
    return <View style={[styles.dot, { backgroundColor: color.needsYouText }]} />
  if (mark === 'done') return <View style={[styles.dot, { backgroundColor: color.successText }]} />
  return (
    <View
      style={[
        styles.ring,
        { borderColor: mark === 'working' ? color.workingText : color.textFaint },
      ]}
    />
  )
}

/** How far a revealed child sits in from its parent. */
const CHILD_INDENT = space.md
/** Separators start where the title column does: 12 inset + 14 mark + 8 gap. */
const SEPARATOR_INSET = 34

const styles = StyleSheet.create({
  listContent: { flexGrow: 1 },
  searchBand: {
    minHeight: 44,
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    paddingHorizontal: space.lg,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: color.border,
    backgroundColor: color.bgSunken,
  },
  searchInput: { ...sans(400), flex: 1, minHeight: 44, color: color.text, fontSize: font.body },
  filterSummary: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: space.sm,
    paddingHorizontal: space.lg,
    paddingTop: space.sm,
  },
  filterChip: {
    minHeight: 32,
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.xs,
    paddingHorizontal: space.md,
    borderRadius: radius.sm,
    backgroundColor: color.surface,
  },
  filterChipText: { ...sans(500), color: color.textDim, fontSize: font.tiny },
  pressed: { backgroundColor: color.surfacePressed },
  // 28pt on the board's grid; the controls reach 44pt through hitSlop.
  header: {
    minHeight: 28,
    marginTop: space.lg,
    marginBottom: space.xs,
    marginHorizontal: space.lg,
    paddingHorizontal: space.md,
    flexDirection: 'row',
    alignItems: 'center',
  },
  headerFold: {
    flex: 1,
    minHeight: 28,
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
  },
  headerTitle: { ...sans(600), color: color.textDim, fontSize: font.tiny },
  headerCount: { ...mono(400), color: color.textFaint, fontSize: 12 },
  screen: { minHeight: 28, justifyContent: 'center' },
  screenText: { ...sans(500), color: color.accentTint, fontSize: font.tiny },
  rowWrap: {
    marginHorizontal: space.lg,
    backgroundColor: color.surface,
    overflow: 'hidden',
  },
  rowFirst: { borderTopLeftRadius: 8, borderTopRightRadius: 8 },
  rowLast: { borderBottomLeftRadius: 8, borderBottomRightRadius: 8 },
  rowPlaceholder: { height: 44 },
  row: {
    minHeight: 44,
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    paddingHorizontal: space.md,
  },
  separator: {
    position: 'absolute',
    top: 0,
    right: 0,
    height: StyleSheet.hairlineWidth,
    backgroundColor: color.hairline,
  },
  gutter: { width: 14, alignItems: 'center', justifyContent: 'center' },
  dot: { width: 8, height: 8, borderRadius: 4 },
  ring: { width: 8, height: 8, borderRadius: 4, borderWidth: 1.5 },
  ref: { ...mono(400), width: 60, color: color.textFaint, fontSize: font.micro },
  title: { ...sans(400), flex: 1, minWidth: 0, color: color.text, fontSize: font.small },
  titleFinished: { color: color.textDim },
  disclosure: { flexDirection: 'row', alignItems: 'center', gap: 2 },
  figure: {
    ...mono(400),
    minWidth: 32,
    textAlign: 'right',
    color: color.textFaint,
    fontSize: 12,
    fontVariant: ['tabular-nums'],
  },
})

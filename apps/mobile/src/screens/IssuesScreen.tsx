import {
  type BoardFilter,
  clearChip,
  confirmedWorkingAgentCountsByIssue,
  filterChips,
  type IssueRow,
  readSharedIssuesDisplay as readMobileTaskDisplay,
  taskStateWord,
  writeSharedIssuesDisplay as writeMobileTaskDisplay,
} from '@podium/client-core/viewmodels'
import { ISSUES_DISPLAY_KEY } from '@podium/client-core/ui-state'
import {
  type IssueBoardStage,
  type IssueCloseReason,
  type IssueWire,
  issueStatusLabel,
  issueStatusMenuEntries,
  issueStatusValueOf,
  parseIssueStatusValue,
} from '@podium/model'
import { issueDisplayRef } from '@podium/protocol'
import { Stack, useRouter } from 'expo-router'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Animated, SectionList, StyleSheet, Text, TextInput, View } from 'react-native'
import { useBooting, useIssues, useMobileStore, useSessions } from '../client/hooks'
import { ActionSheet } from '../components/ActionSheet'
import { ChevronDown, ChevronRight, Filter, Layers, Plus, Search, X } from '../components/icons'
import { Icon } from '../components/Icon'
import { IdSquare } from '../components/IdSquare'
import { IssueCloseSheet } from '../components/IssueCloseSheet'
import { BootstrapCrossfade, TasksSkeleton } from '../components/LaunchPlaceholders'
import { PressableScale } from '../components/PressableScale'
import { PullToRefreshBoundary } from '../components/PullToRefreshBoundary'
import { RefreshOffer } from '../components/RefreshOffer'
import { HeaderButton, Screen } from '../components/Screen'
import { StageGlyph } from '../components/StageGlyph'
import { StorageNoticeAlert } from '../components/StorageNoticeAlert'
import { TaskFiltersSheet } from '../components/TaskFiltersSheet'
import { EmptyState, Pill } from '../components/ui'
import { useCollapsed } from '../hooks/useCollapsed'
import { useContentBottomInset } from '../hooks/useContentBottomInset'
import { useMinimizeTabBarOnScroll } from '../hooks/useMinimizeTabBarOnScroll'
import { usePersistedUiState } from '../hooks/usePersistedUiState'
import { useReduceMotion } from '../hooks/useReduceMotion'
import { useRefreshableTab } from '../hooks/useRefreshableTab'
import { stageFoldKey } from '../lib/fold-keys'
import { issueCloseBlockers } from '../lib/issue-close'
import { buildScreeningQueue } from '../lib/screening'
import { taskBoardSections } from '../lib/task-board'
import { flow, issueColorHex } from '../theme/issueColors'
import { alpha } from '../theme/mix'
import { stageColor } from '../theme/stage'
import { color, font, leading, mono, monoLabel, radius, sans, space, spring } from '../theme/theme'

const usesNativeHeader = process.env.EXPO_OS !== 'web'
const CLOSED_STATUSES = new Set(['done', 'cancelled', 'duplicate', 'superseded'])

/**
 * THE TASKS TAB — high-level work, plus proposals that need a call [POD-947].
 *
 * The rows themselves come from `../lib/task-board.ts`, which reads the SHARED
 * derivation the desktop board reads and then applies the phone's one extra
 * rule: a screenable proposal is promoted even when it has a parent. See that
 * module for why the list is not a tree, and for the section-order decision.
 *
 * This file owns the two things that are genuinely the phone's: what a row looks
 * like at 390pt, and the sticky collapsible section header.
 */
export function IssuesScreen() {
  const router = useRouter()
  const store = useMobileStore()
  const issues = useIssues()
  const sessions = useSessions()
  const [showDone, setShowDone] = useState(false)
  /**
   * Which parents are showing their children — local, exactly as the desktop
   * board holds it (`IssuesView`'s own `expanded` state). Not replicated
   * ui-state: expanding an epic is a look, not a preference, and the desk and
   * the phone are looking at different things at the same moment.
   */
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set())
  const toggleExpanded = useCallback((id: string) => {
    setExpanded((current) => {
      const next = new Set(current)
      if (!next.delete(id)) next.add(id)
      return next
    })
  }, [])
  const [query, setQuery] = useState('')
  const [searchOpen, setSearchOpen] = useState(false)
  const [filter, setFilter] = useState<BoardFilter>({})
  const [filtersOpen, setFiltersOpen] = useState(false)
  const [rowMenu, setRowMenu] = useState<{
    issue: IssueWire
    kind: 'actions' | 'status'
  } | null>(null)
  const [closeIntent, setCloseIntent] = useState<{
    issue: IssueWire
    reason: IssueCloseReason
  } | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [display, setDisplay] = usePersistedUiState(
    ISSUES_DISPLAY_KEY,
    readMobileTaskDisplay,
    writeMobileTaskDisplay,
  )
  const booting = useBooting()
  const { listRef, refreshControl, refreshAccessibilityProps, refreshing, onRefresh, connected } =
    useRefreshableTab('issues')
  const bottomInset = useContentBottomInset()
  const minimizeOnScroll = useMinimizeTabBarOnScroll()

  const effectiveFilter = useMemo<BoardFilter>(
    () => ({ ...filter, ...(query.trim() ? { text: query } : {}) }),
    [filter, query],
  )
  const filterShowsDone =
    effectiveFilter.status === 'closed' ||
    (effectiveFilter.stage !== undefined && CLOSED_STATUSES.has(effectiveFilter.stage))
  const board = useMemo(
    () =>
      taskBoardSections(issues, {
        showDone: showDone || filterShowsDone,
        expanded,
        filter: effectiveFilter,
        ordering: display.ordering,
        showAgentTasks: display.showAgentTasks,
      }),
    [
      display.ordering,
      display.showAgentTasks,
      effectiveFilter,
      expanded,
      filterShowsDone,
      issues,
      showDone,
    ],
  )
  const chips = useMemo(() => filterChips(filter), [filter])
  const types = useMemo(() => [...new Set(issues.map((issue) => issue.type))].sort(), [issues])
  const assignees = useMemo(
    () => [...new Set(issues.map((issue) => issue.assignee).filter(Boolean))].sort() as string[],
    [issues],
  )
  const labels = useMemo(
    () => [...new Set(issues.flatMap((issue) => issue.labels))].sort(),
    [issues],
  )
  const workingByIssue = useMemo(
    () => confirmedWorkingAgentCountsByIssue(issues, sessions, store.coarseNow),
    [issues, sessions, store.coarseNow],
  )

  // Proposals are inert until the operator decides [spec:SP-6144] — the deck
  // flow is the fast way through them, so the board leads with it whenever any
  // are waiting (POD-277).
  const proposals = useMemo(() => buildScreeningQueue(issues), [issues])

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
                if (searchOpen) setQuery('')
              }}
            >
              <Icon as={searchOpen ? X : Search} size={18} color={color.textDim} />
            </HeaderButton>
          )}
          <HeaderButton
            label={chips.length > 0 ? `Task filters, ${chips.length} active` : 'Task filters'}
            onPress={() => setFiltersOpen(true)}
          >
            <Icon as={Filter} size={19} color={chips.length > 0 ? color.accentTint : color.text} />
          </HeaderButton>
          <PressableScale
            accessibilityRole="button"
            accessibilityLabel={showDone ? 'Hide done tasks' : 'Show done tasks'}
            onPress={() => setShowDone((v) => !v)}
            hitSlop={8}
          >
            <Text style={styles.toggle}>{showDone ? 'Hide done' : 'Show done'}</Text>
          </PressableScale>
          <HeaderButton label="New task" onPress={() => router.push('/new-issue')}>
            <Icon as={Plus} size={19} color={color.text} />
          </HeaderButton>
        </>
      }
    >
      {usesNativeHeader ? (
        <Stack.SearchBar
          placeholder="Search tasks or ID"
          hideWhenScrolling
          onChangeText={(event) => setQuery(event.nativeEvent.text)}
          onCancelButtonPress={() => setQuery('')}
        />
      ) : null}
      {!usesNativeHeader && searchOpen ? (
        <View style={styles.searchBand}>
          <Icon as={Search} size={15} color={color.textFaint} />
          <TextInput
            autoFocus
            accessibilityLabel="Search tasks"
            value={query}
            onChangeText={setQuery}
            placeholder="Search tasks or ID…"
            placeholderTextColor={color.textFaint}
            style={styles.searchInput}
            returnKeyType="search"
          />
        </View>
      ) : null}
      <BootstrapCrossfade resolved={!booting} placeholder={<TasksSkeleton />}>
        <PullToRefreshBoundary connected={connected} refreshing={refreshing} onRefresh={onRefresh}>
          <StageSections
            board={board}
            issues={issues}
            workingByIssue={workingByIssue}
            listRef={listRef}
            refreshControl={refreshControl}
            refreshAccessibilityProps={refreshAccessibilityProps}
            minimizeOnScroll={minimizeOnScroll}
            bottomInset={bottomInset}
            booting={booting}
            proposals={proposals.length}
            chips={chips}
            onScreenProposals={() => router.push('/screen-proposed')}
            onOpen={(id) => router.push(`/issue/${encodeURIComponent(id)}`)}
            onToggleExpanded={toggleExpanded}
            onRemoveFilter={(key) => setFilter((current) => clearChip(current, key))}
            onOpenActions={(issue) => setRowMenu({ issue, kind: 'actions' })}
          />
        </PullToRefreshBoundary>
      </BootstrapCrossfade>
      <TaskFiltersSheet
        visible={filtersOpen}
        filter={filter}
        ordering={display.ordering}
        showAgentTasks={display.showAgentTasks}
        types={types}
        assignees={assignees}
        labels={labels}
        onFilter={setFilter}
        onOrdering={(ordering) => setDisplay({ ...display, ordering })}
        onShowAgentTasks={(showAgentTasks) => setDisplay({ ...display, showAgentTasks })}
        onClose={() => setFiltersOpen(false)}
      />
      <ActionSheet
        visible={rowMenu?.kind === 'actions'}
        title={rowMenu ? `${issueDisplayRef(rowMenu.issue)} · ${rowMenu.issue.title}` : undefined}
        actions={
          rowMenu
            ? [
                {
                  label: 'Open task',
                  onPress: () => router.push(`/issue/${encodeURIComponent(rowMenu.issue.id)}`),
                },
                {
                  label: 'Status…',
                  meta: issueStatusLabel(rowMenu.issue),
                  onPress: () => setRowMenu({ issue: rowMenu.issue, kind: 'status' }),
                },
                {
                  label: rowMenu.issue.pinned ? 'Unpin' : 'Pin',
                  onPress: () =>
                    runAction(
                      store.updateIssue(rowMenu.issue.id, { pinned: !rowMenu.issue.pinned }),
                    ),
                },
                {
                  label: rowMenu.issue.archived ? 'Unarchive task' : 'Archive task',
                  onPress: () =>
                    runAction(
                      store.updateIssue(rowMenu.issue.id, { archived: !rowMenu.issue.archived }),
                    ),
                },
              ]
            : []
        }
        onClose={() => setRowMenu((current) => (current?.kind === 'actions' ? null : current))}
      />
      <ActionSheet
        visible={rowMenu?.kind === 'status'}
        title="Status"
        actions={
          rowMenu
            ? issueStatusMenuEntries().map((entry) => ({
                label: entry.label,
                ...(entry.hint ? { hint: entry.hint } : {}),
                selected: entry.value === issueStatusValueOf(rowMenu.issue),
                disabled: entry.value === issueStatusValueOf(rowMenu.issue),
                icon: <StageGlyph stage={entry.status} size={15} ground={color.surface} />,
                onPress: () => selectStatus(rowMenu.issue, entry.value),
              }))
            : []
        }
        onClose={() => setRowMenu((current) => (current?.kind === 'status' ? null : current))}
      />
      {closeIntent ? (
        <IssueCloseSheet
          issue={closeIntent.issue}
          sessions={sessions}
          reason={closeIntent.reason}
          busy={false}
          onConfirm={(reason) => {
            runAction(store.closeIssue(closeIntent.issue.id, reason))
            setCloseIntent(null)
          }}
          onClose={() => setCloseIntent(null)}
        />
      ) : null}
      {actionError ? (
        <View style={styles.errorBand} accessibilityLiveRegion="assertive">
          <Text selectable style={styles.errorText}>
            {actionError}
          </Text>
        </View>
      ) : null}
    </Screen>
  )

  function runAction(action: Promise<unknown>): void {
    setActionError(null)
    void action.catch((error) =>
      setActionError(error instanceof Error ? error.message : String(error)),
    )
  }

  function selectStatus(issue: IssueWire, value: string): void {
    const intent = parseIssueStatusValue(value)
    if (!intent) return
    if (intent.kind === 'stage') {
      runAction(store.updateIssue(issue.id, { stage: intent.stage }))
    } else if (issueCloseBlockers(issue, sessions).length > 0) {
      setCloseIntent({ issue, reason: intent.reason })
    } else {
      runAction(store.closeIssue(issue.id, intent.reason))
    }
    setRowMenu(null)
  }
}

/** The tab-wiring hook's own return shape — the list's ref, its pull-to-refresh
 *  control, and the accessibility props that go with it. */
type RefreshableTab = ReturnType<typeof useRefreshableTab>

interface Section {
  key: IssueBoardStage
  stage: IssueBoardStage
  title: string
  /** How many TASKS this stage holds — its roots, not its rendered rows. */
  total: number
  data: IssueRow<IssueWire>[]
}

/**
 * The list. Split from the screen only so the per-stage `useCollapsed` hooks can
 * live in one place: hooks cannot be called in a loop over a variable-length
 * list, so the folds are read for the SIX known stages up front and looked up by
 * key. There are exactly six lifecycle stages and there always will be — the
 * lane set is the product's vocabulary, not data.
 */
function StageSections({
  board,
  issues,
  workingByIssue,
  listRef,
  refreshControl,
  refreshAccessibilityProps,
  minimizeOnScroll,
  bottomInset,
  booting,
  proposals,
  chips,
  onScreenProposals,
  onOpen,
  onToggleExpanded,
  onRemoveFilter,
  onOpenActions,
}: {
  board: { stage: IssueBoardStage; title: string; rows: IssueRow<IssueWire>[] }[]
  issues: readonly IssueWire[]
  workingByIssue: ReadonlyMap<string, number>
  listRef: RefreshableTab['listRef']
  // Typed from the hook rather than restated: a hand-written `ReactElement` here
  // drops the RefreshControlProps generic the list actually requires.
  refreshControl: RefreshableTab['refreshControl']
  refreshAccessibilityProps: RefreshableTab['refreshAccessibilityProps']
  minimizeOnScroll: ReturnType<typeof useMinimizeTabBarOnScroll>
  bottomInset: number
  booting: boolean
  proposals: number
  chips: ReturnType<typeof filterChips>
  onScreenProposals: () => void
  onOpen: (id: string) => void
  onToggleExpanded: (id: string) => void
  onRemoveFilter: (key: keyof BoardFilter) => void
  onOpenActions: (issue: IssueWire) => void
}) {
  // Keys come from `../lib/fold-keys` — the ui-state classifier is default-closed
  // and THROWS on an unregistered key, so an invented `tasks.stage.<stage>` took
  // the whole tab down on first render. See that module for why these folds are
  // per-user replicated rather than device-local.
  //
  // `done` starts folded: a board with two hundred finished tasks would open on
  // a wall of them, and the Show-done toggle above already means "I want to look
  // at these", not "put them under my thumb".
  const folds: Record<IssueBoardStage, ReturnType<typeof useCollapsed>> = {
    proposed: useCollapsed(stageFoldKey('proposed'), false),
    backlog: useCollapsed(stageFoldKey('backlog'), false),
    planning: useCollapsed(stageFoldKey('planning'), false),
    in_progress: useCollapsed(stageFoldKey('in_progress'), false),
    review: useCollapsed(stageFoldKey('review'), false),
    done: useCollapsed(stageFoldKey('done'), true),
  }

  const sections: Section[] = board.map((s) => ({
    key: s.stage,
    stage: s.stage,
    title: s.title,
    // The lane's own work — roots and promoted proposals. Revealed children are
    // not counted here: they belong to the parent, and a count that grew when
    // an epic was opened would read as new work arriving.
    total: s.rows.filter((row) => row.depth === 0).length,
    // A folded section keeps its header (and therefore its count) and drops its
    // rows — the compression the operator asked for, with nothing hidden that
    // they did not choose to hide.
    data: folds[s.stage][0] ? [] : s.rows,
  }))

  return (
    <SectionList
      ref={listRef as never}
      sections={sections}
      keyExtractor={(row) => row.issue.id}
      stickySectionHeadersEnabled
      contentInsetAdjustmentBehavior="automatic"
      keyboardDismissMode="interactive"
      refreshControl={refreshControl}
      contentContainerStyle={[styles.listContent, { paddingBottom: bottomInset + space.lg }]}
      {...refreshAccessibilityProps}
      {...minimizeOnScroll}
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
                  onPress={() => onRemoveFilter(chip.key)}
                  style={({ pressed }) => [styles.filterChip, pressed && styles.filterChipPressed]}
                >
                  <Text style={styles.filterChipText}>{chip.label}</Text>
                  <Icon as={X} size={11} color={color.textDim} />
                </PressableScale>
              ))}
            </View>
          ) : null}
          {proposals === 0 ? null : (
            <PressableScale
              accessibilityRole="button"
              accessibilityLabel="Screen proposed"
              accessibilityHint={`Decide on ${proposals} proposal${proposals === 1 ? '' : 's'} one at a time`}
              onPress={onScreenProposals}
              style={({ pressed }) => [styles.screenRow, pressed && styles.screenRowPressed]}
            >
              <View style={styles.screenIcon}>
                <Icon as={Layers} size={16} color={color.accentTint} />
              </View>
              <View style={styles.screenText}>
                <Text style={styles.screenTitle}>Screen proposed</Text>
                <Text style={styles.screenSub}>
                  {`${proposals} proposal${proposals === 1 ? '' : 's'} waiting on your call`}
                </Text>
              </View>
              <Icon as={ChevronRight} size={16} color={color.textFaint} />
            </PressableScale>
          )}
        </>
      }
      renderSectionHeader={({ section }) => (
        <StageHeader
          stage={section.stage}
          title={section.title}
          count={section.total}
          collapsed={folds[section.stage][0]}
          onToggle={folds[section.stage][1]}
        />
      )}
      renderItem={({ item }) => (
        <TaskRow
          row={item}
          issues={issues}
          workingAgents={workingByIssue.get(item.issue.id) ?? 0}
          onOpen={onOpen}
          onToggleExpanded={onToggleExpanded}
          onOpenActions={onOpenActions}
        />
      )}
      // The inter-stage breath the header's marginTop used to (incorrectly)
      // provide — footer space scrolls away with its section instead of
      // travelling with the pinned bar.
      renderSectionFooter={() => <View style={styles.sectionGap} />}
      ListEmptyComponent={
        // Guarded on `booting` even though the crossfade covers this screen:
        // ListEmptyComponent is rendered whenever the data is empty, with no
        // notion of whether loading has finished, so without this the empty
        // state is CONSTRUCTED during bootstrap and sits in the tree — and in
        // the accessibility tree — underneath an opaque placeholder.
        booting ? null : (
          <EmptyState title="No tasks" body="Tasks filed in your repos show up here." />
        )
      }
    />
  )
}

/**
 * THE SECTION HEADER — a solid ledge, not a transparent label.
 *
 * The old one was a thin mono label, a count and a hairline on the page's own
 * background. Sticky, that is barely a header at all: rows slide UNDER it and,
 * because it shared their ground, they appeared to slide through it. A sticky
 * header has to read as a surface the content passes behind, so this one takes
 * the darkest canvas tier, a full-width bottom seam, and a stage-tinted left
 * edge — three cheap, opaque things instead of a blur that costs a frame.
 *
 * IDENTITY COMES FROM THE STAGE, not from a new colour: the glyph and the tint
 * are the same values the desktop's `issue-glyphs.tsx` and the terminal's
 * `REF_STAGE_ACCENT` table use, read from `../theme/stage`. Bisque never
 * appears here — it is reserved for "waiting on you", and a stage is never an
 * ask.
 *
 * The whole 44pt bar is the fold control, and the count sits OUTSIDE the fold so
 * a collapsed lane still says how much is in it. Compression, not concealment.
 */
function StageHeader({
  stage,
  title,
  count,
  collapsed,
  onToggle,
}: {
  stage: IssueBoardStage
  title: string
  count: number
  collapsed: boolean
  onToggle: () => void
}) {
  const reduceMotion = useReduceMotion()
  const spin = useRef(new Animated.Value(collapsed ? 0 : 1)).current
  useEffect(() => {
    if (reduceMotion) {
      spin.setValue(collapsed ? 0 : 1)
      return
    }
    Animated.spring(spin, {
      toValue: collapsed ? 0 : 1,
      useNativeDriver: true,
      ...spring.snappy,
    }).start()
  }, [collapsed, reduceMotion, spin])
  const rotate = spin.interpolate({ inputRange: [0, 1], outputRange: ['-90deg', '0deg'] })
  const tint = stageColor(stage)

  return (
    <PressableScale
      accessibilityRole="button"
      // `aria-expanded` beside `accessibilityState`: react-native-web 0.21 reads
      // only the former, so the web build announced no state at all. [POD-1664]
      accessibilityState={{ expanded: !collapsed }}
      aria-expanded={!collapsed}
      accessibilityLabel={`${title}, ${count} task${count === 1 ? '' : 's'}`}
      accessibilityHint={collapsed ? 'Show this stage' : 'Fold this stage away'}
      onPress={onToggle}
      scaleTo={1}
      style={({ pressed }) => [styles.header, pressed && styles.headerPressed]}
    >
      <View style={[styles.headerEdge, { backgroundColor: tint }]} />
      <StageGlyph stage={stage} size={15} ground={color.bar} />
      <Text style={[styles.headerTitle, { color: tint }]}>{title.toUpperCase()}</Text>
      <View style={[styles.headerCount, { borderColor: alpha(tint, 0.35) }]}>
        <Text style={styles.headerCountText}>{count}</Text>
      </View>
      <Animated.View style={[styles.headerChevron, { transform: [{ rotate }] }]}>
        <Icon as={ChevronDown} size={15} color={color.textFaint} />
      </Animated.View>
    </PressableScale>
  )
}

/**
 * One board row, indented by its depth under an expanded parent.
 *
 * THE SUB-TASK COUNT IS THE DISCLOSURE. It used to be an inert pill, which is
 * how children ended up reachable only from the task page — the desk could open
 * the same epic in place and the two lists then held different work. Tapping the
 * count now reveals them here, as it does on the board; the row itself still
 * opens the task, so the pill takes the press and the card keeps its own.
 *
 * The count is the row's, not `issue.childCount`: the wire number counts every
 * child, including the agent-internal decomposition the board scope drops, so a
 * row would have offered to reveal children that are not on this list.
 *
 * A promoted proposal (a row that still has a parent) keeps a "from POD-…" mark
 * so the epic that spawned it is still in view.
 */
function TaskRow({
  row,
  issues,
  workingAgents,
  onOpen,
  onToggleExpanded,
  onOpenActions,
}: {
  row: IssueRow<IssueWire>
  issues: readonly IssueWire[]
  workingAgents: number
  onOpen: (id: string) => void
  onToggleExpanded: (id: string) => void
  onOpenActions: (issue: IssueWire) => void
}) {
  const issue = row.issue
  const hex = issueColorHex(issue.color)
  const resting = issue.stage === 'backlog' || issue.stage === 'proposed'
  const repo = issue.repoPath.split('/').filter(Boolean).pop() ?? ''
  const parent = issue.parentId ? issues.find((item) => item.id === issue.parentId) : undefined
  const childCount = row.childCount
  const state = taskStateWord(issue, workingAgents)
  const stateColor =
    state?.tone === 'attention'
      ? color.needsYouText
      : state?.tone === 'alert'
        ? color.dangerText
        : state?.tone === 'live'
          ? color.workingText
          : color.textFaint
  return (
    <View style={[styles.rowWrap, row.depth > 0 && { marginLeft: row.depth * CHILD_INDENT }]}>
      <PressableScale
        accessibilityRole="button"
        accessibilityLabel={`Task ${issue.seq}: ${issue.title}${state ? `, ${state.text}` : ''}`}
        accessibilityHint="Open task. Long press for task actions."
        // THE DISCLOSURE IS AN ACTION ON THE ROW, not a button inside it. The
        // card is one accessibility element (a nested pressable inside an
        // `accessible` parent is never reachable on iOS), so the sub-task
        // chevron would have been a control only a finger could find. As a
        // rotor action it is available to both.
        {...(childCount > 0
          ? {
              accessibilityState: { expanded: row.expanded },
              accessibilityActions: [
                { name: 'expand', label: row.expanded ? 'Hide sub-tasks' : 'Show sub-tasks' },
              ],
              onAccessibilityAction: (event: { nativeEvent: { actionName: string } }): void => {
                if (event.nativeEvent.actionName === 'expand') onToggleExpanded(issue.id)
              },
            }
          : {})}
        onPress={() => onOpen(issue.id)}
        onLongPress={() => onOpenActions(issue)}
        style={({ pressed }) => [
          styles.card,
          hex ? { backgroundColor: flow.rowBg(hex) } : null,
          pressed && styles.cardPressed,
        ]}
      >
        <View style={styles.topRow}>
          <IdSquare
            issue={issue}
            state={
              issue.stage === 'done'
                ? 'done'
                : issue.needsHuman
                  ? 'waiting'
                  : resting
                    ? 'queued'
                    : 'working'
            }
            ringColor={hex ? flow.rowBg(hex) : color.surface}
          />
          <Text style={[styles.title, hex ? { color: flow.text(hex) } : null]} numberOfLines={2}>
            {issue.title}
          </Text>
        </View>
        <View style={styles.metaRow}>
          <Pill label={issue.type} />
          <Pill label={`P${issue.priority}`} />
          {state ? (
            <Text style={[styles.rowState, { color: stateColor }]}>{state.text}</Text>
          ) : null}
          {childCount > 0 ? (
            <PressableScale
              // The row carries this control's accessibility (see its
              // `accessibilityActions`); announcing it twice would put a second,
              // unreachable button in the tree.
              accessibilityElementsHidden
              importantForAccessibility="no-hide-descendants"
              onPress={() => onToggleExpanded(issue.id)}
              hitSlop={10}
              scaleTo={0.94}
              style={styles.subTasks}
            >
              <Icon
                as={row.expanded ? ChevronDown : ChevronRight}
                size={13}
                color={color.textDim}
              />
              <Pill label={`${childCount} sub-task${childCount === 1 ? '' : 's'}`} />
            </PressableScale>
          ) : null}
          {parent ? <Text style={styles.from}>from {issueDisplayRef(parent)}</Text> : null}
          <Text style={styles.repo} numberOfLines={1}>
            {repo}
          </Text>
        </View>
      </PressableScale>
    </View>
  )
}

/** How far a revealed child sits in from its parent — one step, and only one:
 *  deep decomposition is read on the task page, not at 390pt. */
const CHILD_INDENT = space.md

const styles = StyleSheet.create({
  listContent: {
    flexGrow: 1,
  },
  subTasks: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 2,
  },
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
  searchInput: {
    ...sans(400),
    flex: 1,
    minHeight: 44,
    color: color.text,
    fontSize: font.body,
  },
  filterSummary: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
    paddingHorizontal: space.md,
    paddingTop: space.sm,
  },
  filterChip: {
    minHeight: 36,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    paddingHorizontal: space.sm + 2,
    borderRadius: radius.full,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.border,
    backgroundColor: color.surface,
  },
  filterChipPressed: { backgroundColor: color.surfacePressed },
  filterChipText: { ...sans(500), color: color.textDim, fontSize: font.tiny },
  toggle: {
    ...sans(600),
    // A view filter is not the primary action; it stopped competing with the
    // needs-you bisque and the New Task button [POD-366].
    color: color.textDim,
    fontSize: font.small,
  },
  screenRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm + 2,
    marginHorizontal: space.sm + 2,
    marginTop: space.sm,
    // Owns the gap below itself now that the sticky header cannot carry a
    // marginTop of its own.
    marginBottom: space.sm,
    paddingHorizontal: 9,
    paddingVertical: 9,
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.accentBorder,
    backgroundColor: color.accentSoft,
  },
  screenRowPressed: {
    backgroundColor: alpha(color.accent, 0.2),
  },
  screenIcon: {
    width: 26,
    height: 26,
    borderRadius: radius.md,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: color.bgSunken,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.accentBorder,
  },
  screenText: {
    flex: 1,
    minWidth: 0,
    gap: 1,
  },
  screenTitle: {
    ...sans(600),
    color: color.text,
    fontSize: font.small,
  },
  screenSub: {
    ...mono(400),
    color: color.textDim,
    fontSize: font.micro,
  },
  header: {
    minHeight: 44,
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    paddingLeft: space.md + 2,
    paddingRight: space.sm,
    // NO EXTERNAL MARGIN — sticky geometry. Native pins a sticky header by
    // translating the view to the viewport top, and a margin is layout the
    // translation cannot take along: the pinned bar floated 8pt low with rows
    // scrolling through the see-through strip above it. The breath between
    // stages is the previous section's footer spacer instead.
    // OPAQUE, and the darkest tier the theme has — a sticky header shares no
    // ground with the rows travelling behind it.
    backgroundColor: color.bar,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: color.hairlineBar,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: color.hairlineBar,
    overflow: 'hidden',
    zIndex: 1,
  },
  headerPressed: {
    backgroundColor: color.bgSunken,
  },
  headerEdge: {
    position: 'absolute',
    left: 0,
    top: 0,
    bottom: 0,
    width: 3,
  },
  headerTitle: {
    ...monoLabel(font.micro),
    flex: 1,
  },
  headerCount: {
    minWidth: 22,
    alignItems: 'center',
    paddingHorizontal: 5,
    paddingVertical: 1,
    borderRadius: radius.full,
    borderWidth: StyleSheet.hairlineWidth,
    backgroundColor: color.bgSunken,
  },
  headerCountText: {
    ...mono(600),
    color: color.textDim,
    fontSize: font.micro,
  },
  headerChevron: {
    width: 24,
    alignItems: 'center',
  },
  sectionGap: {
    height: space.sm,
  },
  rowWrap: {
    flexDirection: 'row',
    alignItems: 'center',
    marginHorizontal: space.sm + 2,
    marginBottom: 3,
  },
  card: {
    flex: 1,
    minWidth: 0,
    backgroundColor: color.surface,
    borderRadius: radius.md,
    paddingHorizontal: 9,
    paddingVertical: 7,
    gap: 6,
  },
  cardPressed: {
    backgroundColor: color.surfacePressed,
  },
  topRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 9,
  },
  title: {
    ...sans(500),
    flex: 1,
    color: color.text,
    fontSize: font.small,
    lineHeight: leading(font.body),
  },
  metaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    flexWrap: 'wrap',
  },
  rowState: {
    ...mono(600),
    fontSize: font.micro,
    fontVariant: ['tabular-nums'],
  },
  from: {
    ...mono(400),
    color: color.textDim,
    fontSize: font.micro,
  },
  repo: {
    ...mono(400),
    color: color.textFaint,
    fontSize: font.micro,
    marginLeft: 'auto',
  },
  errorBand: {
    position: 'absolute',
    left: space.md,
    right: space.md,
    bottom: space.lg,
    minHeight: 44,
    justifyContent: 'center',
    paddingHorizontal: space.md,
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.danger,
    backgroundColor: color.dangerSoft,
  },
  errorText: { ...sans(500), color: color.dangerText, fontSize: font.small },
})

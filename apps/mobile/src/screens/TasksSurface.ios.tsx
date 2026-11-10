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
  accessibilityAddTraits,
  accessibilityElement,
  accessibilityHidden,
  accessibilityHint,
  accessibilityIdentifier,
  accessibilityLabel,
  accessibilityValue,
  alignmentGuide,
  buttonStyle,
  contentShape,
  font,
  foregroundStyle,
  frame,
  lineLimit,
  listRowInsets,
  listStyle,
  monospacedDigit,
  pickerStyle,
  refreshable,
  shapes,
  tag,
  tint,
} from '@expo/ui/swift-ui/modifiers'
import { relativeTime } from '@podium/client-core/focus'
import { discoveredPlacement, type IssueNavigationModel } from '@podium/client-core/values'
import type { BoardListRow } from '@podium/client-graph/issue-board-schema'
import { here } from '@podium/client-graph/lookup'
import type { MobileTasksBoard } from '@podium/client-graph/mobile-tasks'
import { LOADING } from '@podium/client-graph/worklist/rollup'
import { issueStatusMenuEntries, issueStatusValueOf } from '@podium/model'
import { isFinished } from '@podium/model/browser'
import { issueDisplayRef } from '@podium/protocol'
import { Stack } from 'expo-router'
import { observer } from 'mobx-react-lite'
import { useCallback } from 'react'
import { StyleSheet, View } from 'react-native'
import { useMobilePool } from '../client/mobile-pool'
import { Filter, Plus } from '../components/icons'
import { RefreshOffer } from '../components/RefreshOffer'
import { Screen } from '../components/Screen'
import { StorageNoticeAlert } from '../components/StorageNoticeAlert'
import { MIN_REFRESH_CONFIRMATION_MS } from '../hooks/useRefreshableTab'
import { useAgeNow } from '../lib/clock-hooks'
import { workMenuActionIds } from '../lib/work-menu'
import { color } from '../theme/theme'
import {
  type TaskRowMark,
  type TasksSurfaceProps,
  taskRowFigure,
  taskRowMark,
  tasksSubtitle,
} from './TasksSurface.types'
import { useStageFolds } from './tasks-folds'

/** Leading edge of a row's title: 12 inset + 14 mark + 8 gap, the board's axis. */
const ROW_AXIS = 34
const rowInsets = listRowInsets({ leading: 12, trailing: 12, top: 0, bottom: 0 })

const MARK_SYMBOL: Record<TaskRowMark, string> = {
  needs: 'circle.fill',
  working: 'circle',
  resting: 'circle',
  done: 'checkmark.circle',
}
const MARK_COLOR: Record<TaskRowMark, string> = {
  needs: color.needsYouText,
  working: color.workingText,
  resting: color.textFaint,
  done: color.successText,
}

/**
 * THE TASKS TAB ON iOS — a real SwiftUI inset-grouped list. UIKit owns the
 * navigation bar, its large title, the search field and the tab bar; SwiftUI
 * owns the rows, their swipe actions and their context menus, so iOS draws the
 * Liquid Glass and the gestures itself.
 *
 * Stage groups open in the board's order. Backlog, Proposed and Done start
 * folded; Proposed is ONE row whose trailing "Screen" opens the screening deck,
 * because 700 proposals are a decision queue, not a list to scroll.
 */
export const TasksSurface = observer(function TasksSurface(props: TasksSurfaceProps) {
  const { board } = props
  const folds = useStageFolds()
  // The shared board's groups: non-empty lanes plus the Proposed screening group.
  const groups = board?.groups ?? LOADING
  const pending = props.booting || groups === LOADING
  const ordered = groups === LOADING ? [] : groups
  const proposals = board?.proposals ?? LOADING
  const screenable = proposals !== LOADING && proposals > 0
  const counts = board?.stageCounts ?? LOADING
  const subtitle = tasksSubtitle(board?.filter.projectPaths, counts === LOADING ? null : counts)
  const { onRefresh: refresh } = props.refresh
  const onRefresh = useCallback(async () => {
    refresh()
    await new Promise((resolve) => setTimeout(resolve, MIN_REFRESH_CONFIRMATION_MS))
  }, [refresh])
  const filtered = props.chips.length > 0

  return (
    // The shell's Screen: large title, the subtitle in the native bar (iOS 26),
    // trailing actions as system glass bar buttons. The native subtitle is not
    // tappable; the project scope it names is the filter sheet's first row.
    <Screen
      large
      title="Tasks"
      subtitle={subtitle.counts ? `${subtitle.project} · ${subtitle.counts}` : subtitle.project}
      actions={[
        {
          label: filtered
            ? `Filter and display, ${props.chips.length} active`
            : 'Filter and display',
          icon: Filter,
          onPress: props.onFilters,
        },
        { label: 'New task', icon: Plus, onPress: props.onNewTask },
      ]}
    >
      <Stack.SearchBar
        placeholder="Search tasks or ID"
        hideWhenScrolling
        autoCapitalize="none"
        onChangeText={(event) => board?.search(event.nativeEvent.text)}
        onCancelButtonPress={() => board?.search('')}
      />
      {/* React Native notices cannot sit inside a SwiftUI List. */}
      <View>
        <StorageNoticeAlert />
        <RefreshOffer />
      </View>
      <Host style={styles.host} seedColor={color.accentTint}>
        <List
          modifiers={[
            listStyle('insetGrouped'),
            refreshable(onRefresh),
            accessibilityIdentifier('tasks-list'),
          ]}
        >
          {filtered ? (
            <Section title="Filters">
              {props.chips.map((chip) => (
                <Button
                  key={chip.key}
                  onPress={() => props.onRemoveFilter(chip.key)}
                  modifiers={[accessibilityHint('Removes this filter.')]}
                >
                  <HStack spacing={8}>
                    <Text modifiers={[foregroundStyle({ type: 'hierarchical', style: 'primary' })]}>
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
          {pending ? <ProgressView /> : null}
          {ordered.map((section) => {
            const [folded, toggle] = folds[section.stage]
            const proposed = section.stage === 'proposed'
            return (
              <Section
                key={section.stage}
                header={
                  <GroupHeader
                    title={section.title}
                    count={section.total}
                    folded={folded}
                    onToggle={toggle}
                    {...(proposed && screenable ? { onScreen: props.onScreenProposals } : {})}
                  />
                }
              >
                {folded || !board
                  ? null
                  : section.rows.map((row) => (
                      <TaskRow key={row.id} row={row} board={board} props={props} />
                    ))}
              </Section>
            )
          })}
          {!pending && ordered.length === 0 ? (
            <VStack alignment="leading" spacing={4}>
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
    </Screen>
  )
})

/**
 * A stage group's header: chevron, name, count. The whole row folds; the
 * Proposed group adds a trailing "Screen" that opens the screening deck.
 */
function GroupHeader({
  title,
  count,
  folded,
  onToggle,
  onScreen,
}: {
  title: string
  count: number
  folded: boolean
  onToggle: () => void
  onScreen?: () => void
}) {
  return (
    <HStack spacing={8} modifiers={[frame({ minHeight: 28, maxWidth: Infinity })]}>
      <Button
        onPress={onToggle}
        modifiers={[
          buttonStyle('plain'),
          accessibilityLabel(title),
          accessibilityValue(`${folded ? 'Collapsed' : 'Expanded'}, ${count} tasks`),
          accessibilityHint(folded ? 'Shows this group.' : 'Folds this group away.'),
          accessibilityAddTraits(['isHeader']),
        ]}
      >
        <HStack
          spacing={8}
          modifiers={[
            frame({ minHeight: 44, maxWidth: Infinity, alignment: 'leading' }),
            contentShape(shapes.rectangle()),
          ]}
        >
          <Image
            systemName={folded ? 'chevron.right' : 'chevron.down'}
            modifiers={[
              font({ textStyle: 'caption2', weight: 'semibold' }),
              foregroundStyle({ type: 'hierarchical', style: 'tertiary' }),
              frame({ width: 14 }),
              accessibilityHidden(),
            ]}
          />
          <Text
            modifiers={[
              font({ textStyle: 'footnote', weight: 'semibold' }),
              foregroundStyle({ type: 'hierarchical', style: 'secondary' }),
            ]}
          >
            {title}
          </Text>
          <Text
            modifiers={[
              font({ textStyle: 'caption' }),
              foregroundStyle({ type: 'hierarchical', style: 'tertiary' }),
              monospacedDigit(),
            ]}
          >
            {String(count)}
          </Text>
          <Spacer />
        </HStack>
      </Button>
      {onScreen ? (
        <Button
          onPress={onScreen}
          modifiers={[
            buttonStyle('borderless'),
            accessibilityLabel('Screen proposals'),
            accessibilityHint(`Decide on ${count} proposals one at a time.`),
          ]}
        >
          <Text
            modifiers={[
              font({ textStyle: 'footnote', weight: 'medium' }),
              foregroundStyle(color.accentTint),
            ]}
          >
            Screen
          </Text>
        </Button>
      ) : null}
    </HStack>
  )
}

/**
 * One 44pt task row: mark, ref, title, then child progress ("21/25") or age.
 * Swipe left for Status and Close; long press for Work's menu (Rename, Mark as
 * unread, Status, Move out of mission, Delete) plus the sub-task disclosure.
 */
const TaskRow = observer(function TaskRow({
  row,
  board,
  props,
}: {
  row: BoardListRow
  board: MobileTasksBoard
  props: TasksSurfaceProps
}) {
  const pool = useMobilePool()
  const issue = board.issue(row.id)
  const stamp = here(issue.row) ? issue.updatedAt : undefined
  const now = useAgeNow(stamp ?? new Date(0).toISOString())
  if (!here(issue.row)) return null
  const finished = isFinished(issue)
  const mark = taskRowMark(issue, finished)
  const ref = issueDisplayRef(issue)
  const figure = taskRowFigure(issue, stamp ? relativeTime(stamp, now) : null)
  const unread = Boolean((issue as unknown as { unread?: boolean }).unread)
  const notSaved = pool?.notSaved('issue', issue.id) ?? false
  const nav = issue as unknown as IssueNavigationModel
  const placement = discoveredPlacement(nav)
  const actions = workMenuActionIds(nav, 'live', { placement: Boolean(placement?.originId) })
  const progress = issue.childCount > 0 ? `${figure} sub-tasks done` : figure

  return (
    <SwipeActions
      modifiers={[rowInsets, alignmentGuide('listRowSeparatorLeading', ROW_AXIS + row.depth * 16)]}
    >
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
              <Text
                modifiers={[
                  font({ size: 11, design: 'monospaced' }),
                  foregroundStyle({ type: 'hierarchical', style: 'tertiary' }),
                  lineLimit(1),
                  frame({ width: 60, alignment: 'leading' }),
                ]}
              >
                {ref}
              </Text>
              <Text
                modifiers={[
                  font({ textStyle: 'body', weight: unread ? 'semibold' : 'regular' }),
                  foregroundStyle({
                    type: 'hierarchical',
                    style: finished ? 'secondary' : 'primary',
                  }),
                  lineLimit(1),
                  frame({ maxWidth: Infinity, alignment: 'leading' }),
                ]}
              >
                {issue.title}
              </Text>
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
              <Text
                modifiers={[
                  font({ size: 12, design: 'monospaced' }),
                  foregroundStyle({ type: 'hierarchical', style: 'tertiary' }),
                  monospacedDigit(),
                  lineLimit(1),
                ]}
              >
                {figure}
              </Text>
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

const styles = StyleSheet.create({
  root: { flex: 1, minHeight: 0 },
  host: { flex: 1 },
})

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
  background,
  buttonStyle,
  contentShape,
  disabled,
  font,
  foregroundStyle,
  frame,
  lineLimit,
  listRowBackground,
  listRowInsets,
  listRowSeparator,
  listRowSeparatorTint,
  listStyle,
  monospacedDigit,
  onAppear,
  pickerStyle,
  refreshable,
  scrollContentBackground,
  shapes,
  tag,
} from '@expo/ui/swift-ui/modifiers'
import { relativeTime } from '@podium/client-core/focus'
import { discoveredPlacement, type IssueNavigationModel } from '@podium/client-core/values'
import { observer, useWorklistModel } from '@podium/client-graph/react'
import type { WorklistIssue } from '@podium/client-graph/worklist/issue'
import { mobileWorkView } from '@podium/client-graph/worklist/mobile'
import type { PhoneWorkLane, PhoneWorkSection } from '@podium/client-graph/worklist/phone'
import { issueStatusMenuEntries, issueStatusValueOf, type SessionId } from '@podium/model'
import { issueDisplayRef } from '@podium/protocol'
import { Stack, useFocusEffect } from 'expo-router'
import { useCallback, useEffect, useRef, useState } from 'react'
import { StyleSheet, useWindowDimensions, View } from 'react-native'
import type { SearchBarCommands } from 'react-native-screens'
import { NewWorkButton } from '../components/NewWorkButton'
import { MIN_REFRESH_CONFIRMATION_MS } from '../hooks/useRefreshableTab'
import { useAgeNow } from '../lib/clock-hooks'
import { workMenuActionIds } from '../lib/work-menu'
import { mobileRowStamp } from '../lib/work-sections'
import { color } from '../theme/theme'
import { NAV_LOADER_DELAY_MS, useDelayedFlag } from './WorkListRow'
import { WORK_LANE_LABELS, WORK_LANES, type WorkSurfaceProps } from './WorkSurface.types'
import { workPaper as paper } from './work-paper'
import { workSectionWindow } from './work-section-window'

const PAGE_SIZE = 120
const plainRow = [
  listRowBackground(paper.ground),
  listRowSeparatorTint(paper.separator),
  listRowInsets({ leading: 20, trailing: 20, top: 11, bottom: 11 }),
]
const quietRow = [...plainRow, listRowSeparator('hidden')]

/** A real SwiftUI plain list. UIKit owns the stack, search, toolbar and tab bar. */
export const WorkSurface = observer(function WorkSurface(props: WorkSurfaceProps) {
  const { phone } = props
  const searchRef = useRef<SearchBarCommands | null>(null)
  const nativeQuery = useRef<string | undefined>(undefined)
  const restoreQuery = useCallback(() => {
    if (searchRef.current && nativeQuery.current !== phone.query) {
      searchRef.current.setText(phone.query)
      nativeQuery.current = phone.query
    }
  }, [phone, phone.query])
  useEffect(restoreQuery, [restoreQuery])
  useFocusEffect(
    useCallback(() => {
      const frame = requestAnimationFrame(restoreQuery)
      return () => cancelAnimationFrame(frame)
    }, [restoreQuery]),
  )
  // Native List virtualizes the views; bound the number of JS row observers as well.
  const [window, setWindow] = useState({ scope: '', size: PAGE_SIZE })
  const scope = `${phone.lane}:${phone.needle}`
  const { sections, more } = workSectionWindow(
    phone.sections,
    props.collapsed,
    Boolean(phone.needle),
    window.scope === scope ? window.size : PAGE_SIZE,
  )
  const onRefresh = useCallback(async () => {
    props.refresh.onRefresh()
    await new Promise((resolve) => setTimeout(resolve, MIN_REFRESH_CONFIRMATION_MS))
  }, [props.refresh.onRefresh])
  const loadMore = () =>
    setWindow((current) => ({
      scope,
      size: (current.scope === scope ? current.size : PAGE_SIZE) + PAGE_SIZE,
    }))

  return (
    <View style={styles.root}>
      <Stack.Screen
        options={{
          title: 'Work',
          headerLargeTitleEnabled: true,
          headerLargeTitleShadowVisible: false,
          headerShadowVisible: false,
          contentStyle: { backgroundColor: paper.ground },
          headerTintColor: color.accentTint,
        }}
      />
      <Stack.Toolbar placement="left">
        <Stack.Toolbar.Menu accessibilityLabel={`Work list: ${WORK_LANE_LABELS[phone.lane]}`}>
          <Stack.Toolbar.Label>{WORK_LANE_LABELS[phone.lane]}</Stack.Toolbar.Label>
          {WORK_LANES.map((lane) => (
            <Stack.Toolbar.MenuAction
              key={lane}
              isOn={phone.lane === lane}
              onPress={() => phone.setLane(lane)}
            >
              {WORK_LANE_LABELS[lane]}
            </Stack.Toolbar.MenuAction>
          ))}
        </Stack.Toolbar.Menu>
      </Stack.Toolbar>
      <NewWorkButton
        renderTrigger={(open) => (
          <Stack.Toolbar placement="right">
            <Stack.Toolbar.Button
              icon="square.and.pencil"
              accessibilityLabel="New work"
              onPress={open}
            >
              New work
            </Stack.Toolbar.Button>
          </Stack.Toolbar>
        )}
      />
      <Stack.SearchBar
        ref={searchRef}
        placeholder="Search tasks or ID"
        hideWhenScrolling
        autoCapitalize="none"
        onChangeText={(event) => {
          nativeQuery.current = event.nativeEvent.text
          phone.setQuery(event.nativeEvent.text)
        }}
        onCancelButtonPress={() => {
          nativeQuery.current = ''
          phone.setQuery('')
        }}
      />
      <View>{props.notices}</View>
      <Host style={styles.host} seedColor={color.accentTint}>
        <List
          key={phone.lane}
          modifiers={[
            listStyle('plain'),
            scrollContentBackground('hidden'),
            background(paper.ground),
            refreshable(onRefresh),
            accessibilityIdentifier('work-list'),
          ]}
        >
          {props.loading && !sections.length ? <ProgressView modifiers={quietRow} /> : null}
          {sections.map(({ section, folded, visible }) => (
            <Section
              key={section.key}
              header={
                <NativeGroupHeader section={section} folded={folded} onToggle={props.onToggle} />
              }
            >
              {visible.map((id) => (
                <NativeWorkRow
                  key={id}
                  id={id}
                  lane={phone.lane}
                  pending={props.pendingNav === id}
                  onOpenIssue={props.onOpenIssue}
                  onOpenSession={props.onOpenSession}
                  onAction={props.onAction}
                  onStatus={props.onStatus}
                />
              ))}
              {!folded && !section.ids.length ? (
                <Text
                  modifiers={[
                    ...quietRow,
                    font({ textStyle: 'subheadline' }),
                    foregroundStyle(paper.tertiary),
                  ]}
                >
                  No open tasks
                </Text>
              ) : null}
            </Section>
          ))}
          {more ? (
            <Text
              modifiers={[
                ...quietRow,
                onAppear(loadMore),
                font({ textStyle: 'footnote' }),
                foregroundStyle(paper.secondary),
              ]}
            >
              Loading more tasks…
            </Text>
          ) : null}
          {!props.loading && !sections.length ? (
            <VStack alignment="leading" spacing={8} modifiers={quietRow}>
              <Text modifiers={[font({ textStyle: 'headline' }), foregroundStyle(paper.ink)]}>
                {phone.needle
                  ? 'No matching tasks'
                  : phone.lane === 'open'
                    ? 'No work yet'
                    : `No ${phone.lane} tasks`}
              </Text>
              <Text
                modifiers={[font({ textStyle: 'subheadline' }), foregroundStyle(paper.secondary)]}
              >
                {phone.needle
                  ? 'Try a title, reference or status.'
                  : phone.lane === 'closed'
                    ? 'Tasks closed in the last 7 days appear here.'
                    : phone.lane === 'snoozed'
                      ? 'Snoozed tasks will appear here until they return to Open.'
                      : 'Your tasks will appear here, grouped by project.'}
              </Text>
            </VStack>
          ) : null}
          {phone.lane === 'closed' && sections.length ? (
            <Text
              modifiers={[
                ...quietRow,
                font({ textStyle: 'footnote' }),
                foregroundStyle(paper.secondary),
              ]}
            >
              Closed in the last 7 days
            </Text>
          ) : null}
          {WORK_LANES.filter((lane) => phone.otherLaneHits[lane] > 0).map((lane) => (
            <Button
              key={lane}
              label={`${phone.otherLaneHits[lane]} in ${WORK_LANE_LABELS[lane]}`}
              onPress={() => phone.setLane(lane)}
              modifiers={quietRow}
            />
          ))}
        </List>
      </Host>
    </View>
  )
})

const NativeGroupHeader = observer(function NativeGroupHeader({
  section,
  folded,
  onToggle,
}: {
  section: PhoneWorkSection
  folded: boolean
  onToggle: (key: string) => void
}) {
  return (
    <Button
      onPress={() => onToggle(section.key)}
      modifiers={[
        buttonStyle('plain'),
        background(paper.ground),
        accessibilityLabel(section.label),
        accessibilityValue(`${folded ? 'Collapsed' : 'Expanded'}, ${section.ids.length} tasks`),
        accessibilityHint('Double tap to fold or unfold this project.'),
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
        <Text
          modifiers={[font({ textStyle: 'body', weight: 'semibold' }), foregroundStyle(paper.ink)]}
        >
          {section.label}
        </Text>
        <Spacer />
        {folded ? (
          <Text
            modifiers={[
              font({ textStyle: 'footnote' }),
              foregroundStyle(paper.secondary),
              monospacedDigit(),
            ]}
          >
            {String(section.ids.length)}
          </Text>
        ) : null}
        <Image
          systemName={folded ? 'chevron.right' : 'chevron.down'}
          modifiers={[
            font({ textStyle: 'caption2', weight: 'semibold' }),
            foregroundStyle(paper.tertiary),
            accessibilityHidden(),
          ]}
        />
      </HStack>
    </Button>
  )
})

type RowProps = Pick<
  WorkSurfaceProps,
  'onOpenIssue' | 'onOpenSession' | 'onAction' | 'onStatus'
> & { id: string; lane: PhoneWorkLane; pending: boolean }
const NativeWorkRow = observer(function NativeWorkRow(props: RowProps) {
  const model = useWorklistModel()
  const row = model?.knownRow(props.id)
  const { fontScale } = useWindowDimensions()
  const expanded = fontScale >= 1.6
  const loading = useDelayedFlag(props.pending, NAV_LOADER_DELAY_MS)
  if (row?.ready !== 'ready') return null
  const word =
    props.lane === 'snoozed'
      ? row.snoozeLabel
      : props.lane === 'closed'
        ? row.statusWord === 'Landed'
          ? 'Landed'
          : 'Closed'
        : row.statusWord
  const tone =
    props.lane === 'snoozed'
      ? 'idle'
      : props.lane === 'closed'
        ? word === 'Landed'
          ? 'done'
          : 'closed'
        : row.statusTone
  const ref = issueDisplayRef(row.issue)
  const unread = row.emphasizeUnread
  const open = () => {
    if (!model) return
    const current = mobileWorkView(model.pool).mobileRow(row.id)
    if (!current || typeof current === 'symbol') return
    if (current.navigation.kind === 'session')
      props.onOpenSession(current.navigation.id as SessionId, row.id)
    else props.onOpenIssue(current.issue as unknown as IssueNavigationModel)
  }
  const mark =
    props.lane === 'snoozed'
      ? 'moon'
      : tone === 'working'
        ? 'circle.dotted'
        : tone === 'done'
          ? 'checkmark.circle'
          : tone === 'closed'
            ? 'minus.circle'
            : tone === 'needs' || tone === 'error'
              ? 'circle.fill'
              : tone === 'draft'
                ? 'circle.dashed'
                : 'circle'
  const signal =
    tone === 'error'
      ? color.dangerText
      : tone === 'needs'
        ? color.needsYouText
        : tone === 'working' || tone === 'done' || tone === 'active'
          ? color.workingText
          : paper.tertiary
  return (
    <ContextMenu
      modifiers={[
        ...plainRow,
        listRowBackground(props.pending ? paper.fill : paper.ground),
        alignmentGuide('listRowSeparatorLeading', 34),
      ]}
    >
      <ContextMenu.Trigger>
        <Button
          onPress={open}
          modifiers={[
            buttonStyle('plain'),
            accessibilityElement('ignore'),
            accessibilityLabel(
              `${row.title}. ${word}. ${ref}${unread ? '. Unread' : ''}${model?.pool.notSaved('issue', row.id) ? '. Not saved' : ''}`,
            ),
            accessibilityHint('Opens task. Actions available in the context menu.'),
          ]}
        >
          <HStack
            alignment="top"
            spacing={14}
            modifiers={[
              frame({ minHeight: 44, maxWidth: Infinity, alignment: 'leading' }),
              contentShape(shapes.rectangle()),
            ]}
          >
            <Image
              systemName={mark}
              modifiers={[
                font({ textStyle: 'caption2' }),
                foregroundStyle(signal),
                frame({ width: 20, minHeight: 24 }),
                accessibilityHidden(),
              ]}
            />
            <VStack
              alignment="leading"
              spacing={5}
              modifiers={[frame({ maxWidth: Infinity, alignment: 'leading' })]}
            >
              <Text
                modifiers={[
                  font({ textStyle: 'body', weight: unread ? 'semibold' : 'regular' }),
                  foregroundStyle(props.lane === 'closed' ? paper.secondary : paper.ink),
                  ...(expanded ? [] : [lineLimit(2)]),
                ]}
              >
                {row.title}
              </Text>
              <HStack spacing={6}>
                <Text
                  modifiers={[
                    font({ textStyle: 'subheadline' }),
                    foregroundStyle(
                      tone === 'error'
                        ? color.dangerText
                        : tone === 'needs'
                          ? color.needsYouText
                          : paper.secondary,
                    ),
                  ]}
                >
                  {word}
                </Text>
              </HStack>
              {model?.pool.notSaved('issue', row.id) ? (
                <Text
                  modifiers={[font({ textStyle: 'caption' }), foregroundStyle(color.dangerText)]}
                >
                  Not saved
                </Text>
              ) : null}
              {expanded ? (
                <HStack spacing={10}>
                  <Text
                    modifiers={[
                      font({ textStyle: 'footnote' }),
                      foregroundStyle(paper.tertiary),
                      lineLimit(1),
                    ]}
                  >
                    {ref}
                  </Text>
                  <NativeRowStamp row={row} lane={props.lane} />
                </HStack>
              ) : null}
            </VStack>
            {!expanded ? (
              <VStack alignment="trailing" spacing={5}>
                <HStack spacing={5}>
                  {unread ? (
                    <Image
                      systemName="circle.fill"
                      size={5}
                      color={color.workingText}
                      modifiers={[accessibilityHidden()]}
                    />
                  ) : null}
                  <Image
                    systemName="chevron.right"
                    modifiers={[
                      font({ textStyle: 'caption', weight: 'semibold' }),
                      foregroundStyle(paper.tertiary),
                      frame({ minHeight: 44 }),
                      accessibilityHidden(),
                    ]}
                  />
                  {loading ? <ProgressView /> : <NativeRowStamp row={row} lane={props.lane} />}
                </HStack>
                <Text
                  modifiers={[
                    font({ textStyle: 'caption' }),
                    foregroundStyle(paper.tertiary),
                    lineLimit(1),
                  ]}
                >
                  {ref}
                </Text>
              </VStack>
            ) : null}
          </HStack>
        </Button>
      </ContextMenu.Trigger>
      <ContextMenu.Items>
        <NativeRowActions
          row={row}
          lane={props.lane}
          onAction={props.onAction}
          onStatus={props.onStatus}
        />
      </ContextMenu.Items>
    </ContextMenu>
  )
})

const NativeRowStamp = observer(function NativeRowStamp({
  row,
  lane,
}: {
  row: WorklistIssue
  lane: PhoneWorkLane
}) {
  const timing = row.timing
  const updated =
    lane === 'closed'
      ? (row.issue.tuckedAt ?? row.issue.closedAt ?? row.issue.updatedAt)
      : row.issue.updatedAt
  const live = lane === 'open' && (timing.phase === 'working' || timing.phase === 'waiting')
  const now = useAgeNow(live ? timing.sinceMs : updated, live ? (timing.baseMs ?? 0) : 0)
  const stamp = (live ? mobileRowStamp(timing, now) : relativeTime(updated, now))
    ?.replace(/ ago$/, '')
    .replace('just now', 'now')
  return (
    <Text
      modifiers={[
        font({ textStyle: 'caption' }),
        foregroundStyle(live && timing.phase === 'working' ? color.workingText : paper.tertiary),
        monospacedDigit(),
        lineLimit(1),
      ]}
    >
      {stamp ?? ''}
    </Text>
  )
})

const NativeRowActions = observer(function NativeRowActions({
  row,
  lane,
  onAction,
  onStatus,
}: Pick<RowProps, 'lane' | 'onAction' | 'onStatus'> & { row: WorklistIssue }) {
  const issue = row.issue as unknown as IssueNavigationModel
  const placement = discoveredPlacement(issue)
  const actions = workMenuActionIds(issue, lane === 'open' ? 'live' : lane, {
    placement: Boolean(placement?.originId),
  })
  return (
    <>
      {actions.map((action) => {
        if (action === 'status')
          return (
            <Picker
              key={action}
              label="Status"
              selection={issueStatusValueOf(issue)}
              onSelectionChange={(value) => onStatus(row.id, value)}
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
              ? issue.unread
                ? 'Mark as Read'
                : 'Mark as Unread'
              : action === 'undefer'
                ? 'Unsnooze'
                : action === 'bringBack'
                  ? 'Bring Back from Closed'
                  : action === 'placement'
                    ? placement?.placement === 'mission'
                      ? 'Move to Top Level'
                      : 'Move into Parent Task'
                    : 'Delete…'
        return (
          <Button
            key={action}
            label={label}
            role={action === 'delete' ? 'destructive' : 'default'}
            onPress={() => onAction(row.id, action)}
            modifiers={action === 'bringBack' ? [disabled(!row.canBringBack)] : []}
          />
        )
      })}
    </>
  )
})

const styles = StyleSheet.create({
  root: { flex: 1, minHeight: 0, backgroundColor: paper.ground },
  host: { flex: 1 },
})

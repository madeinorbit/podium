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
  listSectionSpacing,
  listStyle,
  monospacedDigit,
  onAppear,
  pickerStyle,
  refreshable,
  scrollContentBackground,
  shapes,
  tag,
  tint,
} from '@expo/ui/swift-ui/modifiers'
import { relativeTime } from '@podium/client-core/focus'
import { discoveredPlacement, type IssueNavigationModel } from '@podium/client-core/values'
import { headerView } from '@podium/client-graph/header-views'
import { omitGone } from '@podium/client-graph/lookup'
import type { MobxPool } from '@podium/client-graph/pool'
import { observer, useWorklistModel } from '@podium/client-graph/react'
import type { WorklistIssue } from '@podium/client-graph/worklist/issue'
import { mobileWorkView } from '@podium/client-graph/worklist/mobile'
import type {
  PhoneWorkLane,
  PhoneWorklist,
  PhoneWorkSection,
} from '@podium/client-graph/worklist/phone'
import {
  issueStatusMenuEntries,
  issueStatusValue,
  issueStatusValueOf,
  type SessionId,
} from '@podium/model'
import { issueDisplayRef } from '@podium/protocol'
import * as Haptics from 'expo-haptics'
import { Stack, useFocusEffect } from 'expo-router'
import { type ComponentProps, Fragment, useCallback, useEffect, useRef, useState } from 'react'
import { StyleSheet, useWindowDimensions, View } from 'react-native'
import type { SearchBarCommands } from 'react-native-screens'
import { useMobilePoolProjection } from '../client/mobile-pool'
import { NewWorkButton } from '../components/NewWorkButton'
import { MIN_REFRESH_CONFIRMATION_MS } from '../hooks/useRefreshableTab'
import { useAgeNow } from '../lib/clock-hooks'
import { workMenuActionIds } from '../lib/work-menu'
import { quietProjectsLabel, workLaneTitle, workMenuItem, workSubtitle } from '../lib/work-row-copy'
import { mobileRowStamp } from '../lib/work-sections'
import { headerSubtitleOptions, nativeSubtitleAvailable } from '../navigation/native-stack'
import { color } from '../theme/theme'
import { NAV_LOADER_DELAY_MS, useDelayedFlag } from './WorkListRow'
import { WORK_LANE_LABELS, WORK_LANES, type WorkSurfaceProps } from './WorkSurface.types'
import { workPaper as paper } from './work-paper'
import { workSectionWindow } from './work-section-window'

const PAGE_SIZE = 120
/** Card rows: 12 inset, 14 status column + 8 gap, so titles and separators share x=34. */
const CARD_INSET = 12
const MARK_WIDTH = 14
const MARK_GAP = 8
const cardRow = [
  listRowBackground(paper.card),
  listRowSeparatorTint(paper.separator),
  listRowInsets({ leading: CARD_INSET, trailing: CARD_INSET, top: 8, bottom: 8 }),
]
/** Rows that sit on the ground rather than in a card (lane control, notes, empty state). */
const quietRow = [
  listRowBackground(paper.ground),
  listRowSeparator('hidden'),
  listRowInsets({ leading: 0, trailing: 0, top: 4, bottom: 4 }),
]
const noteRow = [
  ...quietRow,
  listRowInsets({ leading: CARD_INSET, trailing: CARD_INSET, top: 8, bottom: 8 }),
]

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
  const quiet = phone.quietSections
  const { sections, more } = workSectionWindow(
    phone.quietExpanded && quiet.length
      ? [...phone.activeSections, ...quiet]
      : phone.activeSections,
    props.collapsed,
    Boolean(phone.needle),
    window.scope === scope ? window.size : PAGE_SIZE,
  )
  const onRefresh = useCallback(async () => {
    props.refresh.onRefresh()
    await new Promise((resolve) => setTimeout(resolve, MIN_REFRESH_CONFIRMATION_MS))
  }, [props.refresh.onRefresh])
  const { onAction, onStatus } = props
  const onSwipe = useCallback(
    (id: string, action: WorkSwipeAction) => {
      void Haptics.selectionAsync()
      if (action === 'close') onStatus(id, issueStatusValue('done'))
      else onAction(id, action)
    },
    [onAction, onStatus],
  )
  // W3: two existing shared counts, joined for the title's subtitle.
  const needYou = useMobilePoolProjection(readNeedYouCount, 0)
  const working = useMobilePoolProjection(readWorkingCount, 0)
  const subtitle = props.mode === 'tab' ? workSubtitle(needYou, working) : undefined
  // W8: one launcher for every project header's +, opened with that project picked.
  const [projectRepo, setProjectRepo] = useState<string | null>(null)
  const openProjectWork = useRef<(() => void) | null>(null)
  const onNewInProject = useCallback((repoPath: string) => {
    setProjectRepo(repoPath)
    openProjectWork.current?.()
  }, [])
  const loadMore = () =>
    setWindow((current) => ({
      scope,
      size: (current.scope === scope ? current.size : PAGE_SIZE) + PAGE_SIZE,
    }))

  return (
    <View collapsable={false} style={styles.root}>
      <Stack.Screen
        options={{
          title: props.mode === 'search' ? 'Search' : 'Work',
          headerLargeTitleEnabled: true,
          headerLargeTitleShadowVisible: false,
          headerShadowVisible: false,
          contentStyle: { backgroundColor: paper.ground },
          headerTintColor: color.accentTint,
          // The tint is for bar buttons; titles keep the system label colour.
          headerTitleStyle: { color: color.text },
          headerLargeTitleStyle: { color: color.text },
          ...headerSubtitleOptions(nativeSubtitleAvailable ? subtitle : undefined, { large: true }),
        }}
      />
      {props.mode === 'tab' ? (
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
      ) : (
        <Stack.SearchBar
          ref={searchRef}
          placeholder="Search tasks or ID"
          hideWhenScrolling={false}
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
      )}
      {props.mode === 'tab' ? (
        <NewWorkButton
          repoPath={projectRepo}
          renderTrigger={(open) => {
            // No trigger of its own: the project headers' + buttons open it.
            openProjectWork.current = open
            return null
          }}
        />
      ) : null}
      <View>{props.notices}</View>
      <Host style={styles.host} seedColor={color.accentTint}>
        <List
          key={phone.lane}
          modifiers={[
            listStyle('insetGrouped'),
            listSectionSpacing(0),
            scrollContentBackground('hidden'),
            background(paper.ground),
            refreshable(onRefresh),
            accessibilityIdentifier('work-list'),
          ]}
        >
          <Section>
            {subtitle && !nativeSubtitleAvailable ? (
              <Text
                modifiers={[
                  ...noteRow,
                  font({ textStyle: 'subheadline' }),
                  foregroundStyle(paper.secondary),
                ]}
              >
                {subtitle}
              </Text>
            ) : null}
            <WorkLanePicker phone={phone} />
          </Section>
          {props.loading && !sections.length ? <ProgressView modifiers={noteRow} /> : null}
          {sections.map(({ section, folded, visible }) => (
            <Fragment key={section.key}>
              {/* The project name is its own quiet row: SwiftUI uppercases grouped headers. */}
              <Section>
                <NativeGroupHeader
                  section={section}
                  folded={folded}
                  onToggle={props.onToggle}
                  onNew={props.mode === 'tab' ? onNewInProject : undefined}
                />
              </Section>
              {folded ? null : (
                <Section>
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
                      onSwipe={onSwipe}
                      phone={phone}
                    />
                  ))}
                  {section.ids.length ? null : (
                    <Text
                      modifiers={[
                        ...cardRow,
                        font({ textStyle: 'subheadline' }),
                        foregroundStyle(paper.tertiary),
                      ]}
                    >
                      No open tasks
                    </Text>
                  )}
                </Section>
              )}
            </Fragment>
          ))}
          {quiet.length && !more ? (
            <Section>
              <NativeQuietRow phone={phone} />
            </Section>
          ) : null}
          {more ? (
            <Text
              modifiers={[
                ...noteRow,
                onAppear(loadMore),
                font({ textStyle: 'footnote' }),
                foregroundStyle(paper.secondary),
              ]}
            >
              Loading more tasks…
            </Text>
          ) : null}
          {!props.loading && !sections.length ? (
            <VStack alignment="leading" spacing={8} modifiers={noteRow}>
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
                ...noteRow,
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
              modifiers={noteRow}
            />
          ))}
        </List>
      </Host>
    </View>
  )
})

/** Open / Snoozed / Closed as the system segmented control, with counts. */
const WorkLanePicker = observer(function WorkLanePicker({ phone }: { phone: PhoneWorklist }) {
  return (
    <Picker
      label="Work list"
      selection={phone.lane}
      onSelectionChange={(lane: PhoneWorkLane) => phone.setLane(lane)}
      modifiers={[...quietRow, pickerStyle('segmented'), accessibilityIdentifier('work-lanes')]}
    >
      {WORK_LANES.map((lane) => (
        <Text key={lane} modifiers={[tag(lane)]}>
          {workLaneTitle(lane, phone.counts[lane])}
        </Text>
      ))}
    </Picker>
  )
})

const NativeGroupHeader = observer(function NativeGroupHeader({
  section,
  folded,
  onToggle,
  onNew,
}: {
  section: PhoneWorkSection
  folded: boolean
  onToggle: (key: string) => void
  onNew?: (repoPath: string) => void
}) {
  const repoPath = section.repoPath
  return (
    <HStack
      spacing={MARK_GAP}
      modifiers={[
        ...quietRow,
        listRowInsets({ leading: CARD_INSET, trailing: CARD_INSET, top: 16, bottom: 4 }),
      ]}
    >
      <Button
        onPress={() => onToggle(section.key)}
        modifiers={[
          buttonStyle('borderless'),
          accessibilityLabel(section.label),
          accessibilityValue(`${folded ? 'Collapsed' : 'Expanded'}, ${section.ids.length} tasks`),
          accessibilityHint('Double tap to fold or unfold this project.'),
          accessibilityAddTraits(['isHeader']),
        ]}
      >
        <HStack
          spacing={MARK_GAP}
          modifiers={[
            frame({ minHeight: 28, maxWidth: Infinity, alignment: 'leading' }),
            contentShape(shapes.rectangle()),
          ]}
        >
          <Image
            systemName={folded ? 'chevron.right' : 'chevron.down'}
            modifiers={[
              font({ textStyle: 'caption2', weight: 'semibold' }),
              foregroundStyle(paper.tertiary),
              frame({ width: MARK_WIDTH }),
              accessibilityHidden(),
            ]}
          />
          <Text
            modifiers={[
              font({ textStyle: 'footnote', weight: 'semibold' }),
              foregroundStyle(paper.secondary),
              lineLimit(1),
            ]}
          >
            {section.label}
          </Text>
          <Text
            modifiers={[
              font({ textStyle: 'caption', design: 'monospaced' }),
              foregroundStyle(paper.tertiary),
              monospacedDigit(),
            ]}
          >
            {String(section.ids.length)}
          </Text>
          <Spacer />
        </HStack>
      </Button>
      {onNew && repoPath ? (
        <Button
          onPress={() => onNew(repoPath)}
          modifiers={[
            buttonStyle('borderless'),
            accessibilityLabel(`New work in ${section.label}`),
          ]}
        >
          <Image
            systemName="plus"
            modifiers={[
              font({ textStyle: 'footnote', weight: 'semibold' }),
              foregroundStyle(paper.tertiary),
              frame({ width: 28, height: 28 }),
              contentShape(shapes.rectangle()),
            ]}
          />
        </Button>
      ) : null}
    </HStack>
  )
})

/** W4: projects with nothing open fold into this one row; a tap shows them. */
const NativeQuietRow = observer(function NativeQuietRow({ phone }: { phone: PhoneWorklist }) {
  const count = phone.quietSections.length
  return (
    <Button
      onPress={() => phone.toggleQuiet()}
      modifiers={[
        ...quietRow,
        listRowInsets({ leading: CARD_INSET, trailing: CARD_INSET, top: 16, bottom: 4 }),
        buttonStyle('borderless'),
        accessibilityValue(phone.quietExpanded ? 'Expanded' : 'Collapsed'),
      ]}
    >
      <HStack
        spacing={MARK_GAP}
        modifiers={[
          frame({ minHeight: 28, maxWidth: Infinity, alignment: 'leading' }),
          contentShape(shapes.rectangle()),
        ]}
      >
        <Image
          systemName={phone.quietExpanded ? 'chevron.down' : 'chevron.right'}
          modifiers={[
            font({ textStyle: 'caption2', weight: 'semibold' }),
            foregroundStyle(paper.tertiary),
            frame({ width: MARK_WIDTH }),
            accessibilityHidden(),
          ]}
        />
        <Text modifiers={[font({ textStyle: 'footnote' }), foregroundStyle(paper.tertiary)]}>
          {quietProjectsLabel(count)}
        </Text>
        <Spacer />
      </HStack>
    </Button>
  )
})

/** W7: the sub-task a search matched, under its top-level task. */
const NativeChildHit = observer(function NativeChildHit({ id }: { id: string }) {
  const model = useWorklistModel()
  const issue = model ? omitGone(model.pool.model('issue', id)) : undefined
  if (!issue || typeof issue === 'symbol') return null
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
          font({ size: 11, design: 'monospaced' }),
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
          lineLimit(1),
        ]}
      >
        {issue.title}
      </Text>
    </HStack>
  )
})

const readNeedYouCount = (pool: MobxPool) => mobileWorkView(pool).mobileSections().attentionCount
const readWorkingCount = (pool: MobxPool) => headerView(pool).workingCount()

/** Swipe actions reuse the menu's handlers; only the gesture is new. */
export type WorkSwipeAction = 'close' | 'status' | 'undefer' | 'bringBack'

type RowProps = Pick<
  WorkSurfaceProps,
  'onOpenIssue' | 'onOpenSession' | 'onAction' | 'onStatus'
> & {
  id: string
  lane: PhoneWorkLane
  pending: boolean
  onSwipe: (id: string, action: WorkSwipeAction) => void
  phone: PhoneWorklist
}
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
  const notSaved = model?.pool.notSaved('issue', row.id) ?? false
  const childHit = props.phone.childHit(row.id)
  const open = () => {
    if (!model) return
    const current = mobileWorkView(model.pool).mobileRow(row.id)
    if (!current || typeof current === 'symbol') return
    if (current.navigation.kind === 'session')
      props.onOpenSession(current.navigation.id as SessionId, row.id)
    else props.onOpenIssue(current.issue as unknown as IssueNavigationModel)
  }
  const mark = props.lane === 'snoozed' ? MOON_MARK : (TONE_MARKS[tone] ?? IDLE_MARK)
  const wordColor =
    tone === 'error' ? color.dangerText : tone === 'needs' ? color.needsYouText : paper.secondary
  const refText = (
    <Text
      modifiers={[
        font({ size: 11, design: 'monospaced' }),
        foregroundStyle(paper.tertiary),
        lineLimit(1),
      ]}
    >
      {ref}
    </Text>
  )
  return (
    <SwipeActions
      modifiers={[
        ...cardRow,
        listRowBackground(props.pending ? paper.fill : paper.card),
        alignmentGuide('listRowSeparatorLeading', MARK_WIDTH + MARK_GAP),
      ]}
    >
      <ContextMenu>
        <ContextMenu.Trigger>
          <Button
            onPress={open}
            modifiers={[
              buttonStyle('plain'),
              accessibilityElement('ignore'),
              accessibilityLabel(
                `${row.title}. ${word}. ${ref}${unread ? '. Unread' : ''}${notSaved ? '. Not saved' : ''}`,
              ),
              accessibilityHint('Opens task. Swipe or long press for actions.'),
            ]}
          >
            <HStack
              alignment="top"
              spacing={MARK_GAP}
              modifiers={[
                frame({ minHeight: 36, maxWidth: Infinity, alignment: 'leading' }),
                contentShape(shapes.rectangle()),
              ]}
            >
              <Image
                systemName={mark.symbol}
                size={mark.size}
                color={mark.signal ? toneColor(tone) : paper.tertiary}
                modifiers={[frame({ width: MARK_WIDTH, height: 20 }), accessibilityHidden()]}
              />
              <VStack
                alignment="leading"
                spacing={2}
                modifiers={[frame({ maxWidth: Infinity, alignment: 'leading' })]}
              >
                <HStack alignment="firstTextBaseline" spacing={MARK_GAP}>
                  <Text
                    modifiers={[
                      font({ textStyle: 'body', weight: unread ? 'semibold' : 'regular' }),
                      foregroundStyle(props.lane === 'closed' ? paper.secondary : paper.ink),
                      lineLimit(expanded ? 3 : 1),
                      frame({ maxWidth: Infinity, alignment: 'leading' }),
                    ]}
                  >
                    {row.title}
                  </Text>
                  {unread ? (
                    <Image
                      systemName="circle.fill"
                      size={6}
                      color={color.workingText}
                      modifiers={[accessibilityHidden()]}
                    />
                  ) : null}
                  {expanded ? null : loading ? (
                    <ProgressView />
                  ) : (
                    <NativeRowStamp row={row} lane={props.lane} />
                  )}
                </HStack>
                <HStack alignment="firstTextBaseline" spacing={MARK_GAP}>
                  <Text
                    modifiers={[
                      font({ textStyle: 'footnote' }),
                      foregroundStyle(wordColor),
                      lineLimit(expanded ? 2 : 1),
                      frame({ maxWidth: Infinity, alignment: 'leading' }),
                    ]}
                  >
                    {word}
                  </Text>
                  {expanded ? null : refText}
                </HStack>
                {childHit ? <NativeChildHit id={childHit} /> : null}
                {notSaved ? (
                  <Text
                    modifiers={[font({ textStyle: 'caption' }), foregroundStyle(color.dangerText)]}
                  >
                    Not saved
                  </Text>
                ) : null}
                {expanded ? (
                  <HStack spacing={MARK_GAP}>
                    {refText}
                    <NativeRowStamp row={row} lane={props.lane} />
                  </HStack>
                ) : null}
              </VStack>
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
      <NativeSwipeActions id={row.id} lane={props.lane} onSwipe={props.onSwipe} />
    </SwipeActions>
  )
})

/** Trailing swipe: Close (full swipe) and Status on open rows; the fold's inverse elsewhere. */
function NativeSwipeActions({
  id,
  lane,
  onSwipe,
}: {
  id: string
  lane: PhoneWorkLane
  onSwipe: RowProps['onSwipe']
}) {
  if (lane === 'snoozed')
    return (
      <SwipeActions.Actions edge="trailing">
        <Button
          label="Unsnooze"
          systemImage="sun.max"
          onPress={() => onSwipe(id, 'undefer')}
          modifiers={[tint(color.workingText)]}
        />
      </SwipeActions.Actions>
    )
  if (lane === 'closed')
    return (
      <SwipeActions.Actions edge="trailing">
        <Button
          label="Bring Back"
          systemImage="arrow.uturn.backward"
          onPress={() => onSwipe(id, 'bringBack')}
          modifiers={[tint(color.workingText)]}
        />
      </SwipeActions.Actions>
    )
  return (
    <SwipeActions.Actions edge="trailing">
      <Button
        label="Close"
        systemImage="checkmark.circle"
        onPress={() => onSwipe(id, 'close')}
        modifiers={[tint(SWIPE_CLOSE)]}
      />
      <Button
        label="Status"
        systemImage="circle.dashed"
        onPress={() => onSwipe(id, 'status')}
        modifiers={[tint(color.workingText)]}
      />
    </SwipeActions.Actions>
  )
}

type SFSymbol = NonNullable<ComponentProps<typeof Image>['systemName']>
const SWIPE_CLOSE = '#8e8e93'
type Mark = { symbol: SFSymbol; size: number; signal: boolean }
const IDLE_MARK: Mark = { symbol: 'circle', size: 9, signal: false }
const MOON_MARK: Mark = { symbol: 'moon', size: 11, signal: false }
/** The board's glyphs: dot needs you, dotted grid working, ring idle, check landed. */
const TONE_MARKS: Partial<Record<string, Mark>> = {
  needs: { symbol: 'circle.fill', size: 8, signal: true },
  error: { symbol: 'circle.fill', size: 8, signal: true },
  working: { symbol: 'circle.grid.2x2.fill', size: 10, signal: true },
  active: { symbol: 'circle', size: 9, signal: true },
  done: { symbol: 'checkmark.circle', size: 12, signal: true },
  closed: { symbol: 'minus.circle', size: 12, signal: false },
  draft: { symbol: 'circle.dashed', size: 9, signal: false },
}
function toneColor(tone: string): string {
  if (tone === 'error') return color.dangerText
  if (tone === 'needs') return color.needsYouText
  if (tone === 'working' || tone === 'active' || tone === 'done') return color.workingText
  return paper.tertiary
}

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
              systemImage="circle.dashed"
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
        const { label, symbol } = workMenuItem(action, {
          unread: Boolean(issue.unread),
          inMission: placement?.placement === 'mission',
        })
        return (
          <Button
            key={action}
            label={label}
            systemImage={symbol}
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

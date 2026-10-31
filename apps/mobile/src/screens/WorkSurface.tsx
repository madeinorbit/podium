import { observer } from '@podium/client-graph/react'
import type { MobileWorkRef } from '@podium/client-graph/worklist/mobile'
import type { PhoneListSection, PhoneWorkSection } from '@podium/client-graph/worklist/phone'
import { useFocusEffect } from 'expo-router'
import { useCallback, useEffect, useId, useMemo, useRef } from 'react'
import { SectionList, StyleSheet, Text, TextInput, View } from 'react-native'
import { Icon } from '../components/Icon'
import { ChevronDown, ChevronRight, Search, X } from '../components/icons'
import { BootstrapCrossfade, WorkSkeleton } from '../components/LaunchPlaceholders'
import { listWindow } from '../components/list-window'
import { NewWorkButton } from '../components/NewWorkButton'
import { PressableScale } from '../components/PressableScale'
import { PullToRefreshBoundary } from '../components/PullToRefreshBoundary'
import { Screen } from '../components/Screen'
import { useMinimizeTabBarOnScroll } from '../hooks/useMinimizeTabBarOnScroll'
import { color, mono, radius, sans } from '../theme/theme'
import { PoolWorkRowSlot } from './WorkListRow'
import { WORK_LANE_LABELS, WORK_LANES, type WorkSurfaceProps } from './WorkSurface.types'
import { restoreWorkFocus } from './work-restoration'

/** Web keeps the desktop row grammar; iOS resolves WorkSurface.ios instead. */
export const WorkSurface = observer(function WorkSurface(props: WorkSurfaceProps) {
  const { phone, collapsed, onToggle, pendingNav, refresh, bottomInset } = props
  const searching = Boolean(phone.needle)
  const sections = phone.listSections
  const display = useMemo(
    () =>
      sections.map((section) =>
        !searching && collapsed.has(section.key) ? section.source.foldedListSection : section,
      ),
    [sections, collapsed, searching],
  )
  const minimizeOnScroll = useMinimizeTabBarOnScroll()
  // A stack may retain an older Work screen with the same task IDs.
  const focusPrefix = useId()
  const restored = useRef(false)
  const restore = useCallback(() => {
    if (restored.current || !props.returnFocus) return
    const scroller = refresh.listRef.current?.getScrollResponder?.()
    if (!scroller) return
    scroller.scrollTo({ y: props.returnOffset, animated: false })
    restored.current = restoreWorkFocus(`${focusPrefix}--${props.returnFocus}`)
  }, [props.returnFocus, props.returnOffset, refresh.listRef, focusPrefix])
  useFocusEffect(
    useCallback(() => {
      restored.current = false
      const frame = requestAnimationFrame(restore)
      return () => cancelAnimationFrame(frame)
    }, [restore]),
  )
  const previousLane = useRef(phone.lane)
  useEffect(() => {
    if (previousLane.current === phone.lane) return
    previousLane.current = phone.lane
    props.scrollOffset.current = 0
    if (display.length)
      refresh.listRef.current?.scrollToLocation?.({
        sectionIndex: 0,
        itemIndex: 0,
        animated: false,
      })
  }, [phone.lane, display.length, refresh.listRef, props.scrollOffset])
  const renderItem = useCallback(
    ({ item }: { item: MobileWorkRef }) => (
      <PoolWorkRowSlot
        item={item}
        lane={phone.lane}
        navPending={pendingNav === item.id}
        focusId={`${focusPrefix}--${item.id}`}
        onRestore={props.returnFocus === item.id ? restore : undefined}
        onOpenIssue={props.onOpenIssue}
        onOpenSession={props.onOpenSession}
        onLongPress={props.onMenu}
        onTuck={props.onTuck}
      />
    ),
    [
      phone.lane,
      pendingNav,
      props.onOpenIssue,
      props.onOpenSession,
      props.onMenu,
      props.onTuck,
      props.returnFocus,
      restore,
      focusPrefix,
    ],
  )
  return (
    <Screen large title="Work" right={<NewWorkButton size={34} />}>
      <View style={styles.controls}>
        <View style={styles.search}>
          <Icon as={Search} size={16} color={color.textFaint} />
          <TextInput
            accessibilityLabel="Search work"
            placeholder="Filter tasks"
            value={phone.query}
            onChangeText={(text) => phone.setQuery(text)}
            placeholderTextColor={color.textFaint}
            autoCorrect={false}
            autoCapitalize="none"
            returnKeyType="search"
            style={styles.input}
          />
          {phone.query ? (
            <PressableScale
              accessibilityRole="button"
              accessibilityLabel="Clear search"
              onPress={() => phone.setQuery('')}
              style={styles.clear}
            >
              <Icon as={X} size={15} color={color.textDim} />
            </PressableScale>
          ) : null}
        </View>
        <View accessibilityRole="tablist" style={styles.lanes}>
          {WORK_LANES.map((lane) => (
            <PressableScale
              key={lane}
              accessibilityRole="tab"
              accessibilityState={{ selected: phone.lane === lane }}
              aria-selected={phone.lane === lane}
              onPress={() => phone.setLane(lane)}
              scaleTo={1}
              style={[styles.lane, phone.lane === lane && styles.laneSelected]}
            >
              <Text style={[styles.laneLabel, phone.lane === lane && styles.laneLabelSelected]}>
                {WORK_LANE_LABELS[lane]} <Text style={styles.count}>{phone.counts[lane]}</Text>
              </Text>
            </PressableScale>
          ))}
        </View>
      </View>
      <BootstrapCrossfade resolved={!props.loading} placeholder={<WorkSkeleton />}>
        <PullToRefreshBoundary
          connected={refresh.connected}
          refreshing={refresh.refreshing}
          onRefresh={refresh.onRefresh}
        >
          <SectionList<MobileWorkRef, PhoneListSection>
            {...listWindow}
            {...minimizeOnScroll}
            {...refresh.refreshAccessibilityProps}
            onScroll={(event) => {
              props.scrollOffset.current = event.nativeEvent.contentOffset.y
              minimizeOnScroll.onScroll?.(event)
            }}
            onContentSizeChange={restore}
            ref={refresh.listRef as never}
            sections={display}
            keyExtractor={(ref) => ref.listKey}
            renderItem={renderItem}
            refreshControl={refresh.refreshControl}
            keyboardDismissMode="on-drag"
            keyboardShouldPersistTaps="handled"
            contentInsetAdjustmentBehavior="automatic"
            stickySectionHeadersEnabled
            contentContainerStyle={{ paddingBottom: bottomInset + 24 }}
            ListHeaderComponent={<View>{props.notices}</View>}
            renderSectionHeader={({ section }) => (
              <WebGroupHeader
                section={section.source}
                collapsed={!searching && collapsed.has(section.key)}
                onToggle={onToggle}
              />
            )}
            renderSectionFooter={({ section }) =>
              !section.source.ids.length && !collapsed.has(section.key) ? (
                <Text style={styles.emptyProject}>No open tasks</Text>
              ) : null
            }
            ListEmptyComponent={
              <View style={styles.empty}>
                <Text style={styles.emptyTitle}>
                  {searching
                    ? 'No matching tasks'
                    : phone.lane === 'open'
                      ? 'No work yet'
                      : `No ${phone.lane} tasks`}
                </Text>
                <Text style={styles.emptyBody}>
                  {searching
                    ? 'Try a title, reference or status.'
                    : phone.lane === 'closed'
                      ? 'Tasks closed in the last 7 days appear here.'
                      : phone.lane === 'snoozed'
                        ? 'Snoozed tasks will appear here until they return to Open.'
                        : 'Your tasks will appear here, grouped by project.'}
                </Text>
              </View>
            }
            ListFooterComponent={
              <View style={styles.footer}>
                {phone.lane === 'closed' && sections.length ? (
                  <Text style={styles.note}>Closed in the last 7 days</Text>
                ) : null}
                {WORK_LANES.filter((lane) => phone.otherLaneHits[lane] > 0).map((lane) => (
                  <PressableScale
                    key={lane}
                    accessibilityRole="button"
                    onPress={() => phone.setLane(lane)}
                    style={styles.otherLane}
                  >
                    <Text style={styles.otherLaneLabel}>
                      {phone.otherLaneHits[lane]} in {WORK_LANE_LABELS[lane]}
                    </Text>
                    <Icon as={ChevronRight} size={14} color={color.textFaint} />
                  </PressableScale>
                ))}
              </View>
            }
          />
        </PullToRefreshBoundary>
      </BootstrapCrossfade>
    </Screen>
  )
})

const WebGroupHeader = observer(function WebGroupHeader({
  section,
  collapsed,
  onToggle,
}: {
  section: PhoneWorkSection
  collapsed: boolean
  onToggle: (key: string) => void
}) {
  return (
    <PressableScale
      accessibilityRole="button"
      accessibilityLabel={`${section.label} · ${section.ids.length}`}
      accessibilityState={{ expanded: !collapsed }}
      onPress={() => onToggle(section.key)}
      scaleTo={1}
      style={styles.group}
    >
      <Icon as={collapsed ? ChevronRight : ChevronDown} size={11} color={color.textFaint} />
      <Text style={styles.groupLabel} numberOfLines={1}>
        {section.label}
      </Text>
      <Text style={styles.count}>{section.ids.length}</Text>
    </PressableScale>
  )
})

const styles = StyleSheet.create({
  controls: { gap: 12, paddingTop: 4 },
  search: {
    flexDirection: 'row',
    alignItems: 'center',
    marginHorizontal: 16,
    paddingHorizontal: 12,
    minHeight: 44,
    borderRadius: radius.lg,
    backgroundColor: color.bgSunken,
    gap: 9,
  },
  input: {
    ...sans(400),
    flex: 1,
    minWidth: 0,
    color: color.body,
    fontSize: 15,
    paddingVertical: 10,
    outlineWidth: 0,
  },
  clear: { minWidth: 32, minHeight: 44, alignItems: 'center', justifyContent: 'center' },
  lanes: {
    flexDirection: 'row',
    backgroundColor: color.bgSunken,
    padding: 3,
    borderRadius: radius.md,
  },
  lane: {
    flex: 1,
    minHeight: 38,
    justifyContent: 'center',
    alignItems: 'center',
    borderRadius: radius.sm,
  },
  laneSelected: { backgroundColor: color.surfaceHigh },
  laneLabel: { ...sans(400), color: color.textDim, fontSize: 13 },
  laneLabelSelected: { ...sans(600), color: color.text },
  count: { ...mono(400), fontSize: 11, color: color.textFaint },
  group: {
    minHeight: 44,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 7,
    paddingHorizontal: 16,
    backgroundColor: color.bgSunken,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: color.border,
  },
  groupLabel: { ...sans(500), color: color.body, fontSize: 13, flexShrink: 1 },
  emptyProject: {
    ...sans(400),
    paddingLeft: 34,
    paddingVertical: 14,
    color: color.textFaint,
    fontSize: 13,
  },
  empty: { paddingHorizontal: 24, paddingVertical: 48, gap: 8, alignItems: 'center' },
  emptyTitle: { ...sans(500), fontSize: 16, color: color.body },
  emptyBody: {
    ...sans(400),
    fontSize: 14,
    color: color.textDim,
    textAlign: 'center',
    lineHeight: 21,
  },
  footer: { paddingHorizontal: 16 },
  note: { ...sans(400), color: color.textFaint, fontSize: 12, paddingVertical: 18 },
  otherLane: {
    minHeight: 48,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  otherLaneLabel: { ...sans(400), fontSize: 14, color: color.textDim },
})

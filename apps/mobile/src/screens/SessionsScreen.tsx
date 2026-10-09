import { useRouter } from 'expo-router'
import { useMemo, useState } from 'react'
import { SectionList, StyleSheet, Text, View } from 'react-native'
import { listWindow } from '../components/list-window'
import { observer } from 'mobx-react-lite'
import { useInboxData } from '../client/use-inbox-data'
import { useIssueModel } from '../client/use-issue-model'
import { InboxSessionRow } from '../components/InboxSessionRow'
import { BootstrapCrossfade, WorkSkeleton } from '../components/LaunchPlaceholders'
import { NewWorkButton } from '../components/NewWorkButton'
import { PullToRefreshBoundary } from '../components/PullToRefreshBoundary'
import { Screen } from '../components/Screen'
import { CountPill } from '../components/StatusGlyphs'
import { TaskSheet } from '../components/TaskSheet'
import { useMobilePool } from '../client/mobile-pool'
import { EmptyState } from '../components/ui'
import { useContentBottomInset } from '../hooks/useContentBottomInset'
import { useRefreshableList } from '../hooks/useRefreshableTab'
import { sessionHref } from '../lib/session-route'
import { color, font, mono, monoLabel, space } from '../theme/theme'

/**
 * Agents — the roster [POD-131]. Sessions grouped by attention (needs you /
 * working / idle), each row naming its attached task via the ID square.
 * Long-press peeks the task in the shared inspector sheet, without leaving the
 * roster.
 */
export const SessionsScreen = observer(function SessionsScreen() {
  const pool = useMobilePool()
  const router = useRouter()
  const { groups, booting } = useInboxData()
  const { connected, onRefresh, refreshing, refreshControl, refreshAccessibilityProps } =
    useRefreshableList()
  const bottomInset = useContentBottomInset()
  const [peekId, setPeekId] = useState<string | undefined>()
  const peekIssue = useIssueModel(peekId)

  const sections = useMemo(
    () =>
      [
        { key: 'needsYou' as const, title: 'Needs you', data: groups.needsYou },
        { key: 'working' as const, title: 'Working', data: groups.working },
        { key: 'idle' as const, title: 'Idle', data: groups.idle },
      ].filter((s) => s.data.length > 0),
    [groups],
  )

  return (
    <Screen
      large
      title="Agents"
      subtitle={
        connected
          ? `${groups.working.length} working · ${groups.idle.length} idle`
          : 'reconnecting…'
      }
      right={<NewWorkButton />}
    >
      <BootstrapCrossfade resolved={!booting} placeholder={<WorkSkeleton />}>
        <PullToRefreshBoundary connected={connected} refreshing={refreshing} onRefresh={onRefresh}>
          <SectionList
            {...listWindow}
            sections={sections}
            keyExtractor={(id) => id}
            stickySectionHeadersEnabled={false}
            contentContainerStyle={[styles.listContent, { paddingBottom: bottomInset + space.lg }]}
            refreshControl={refreshControl}
            {...refreshAccessibilityProps}
            renderSectionHeader={({ section }) => (
              <View style={styles.sectionHeader}>
                <Text
                  style={[
                    styles.sectionLabel,
                    section.key === 'needsYou' && styles.needsYouLabel,
                    section.key === 'working' && styles.workingLabel,
                  ]}
                >
                  {section.title.toUpperCase()}
                </Text>
                {section.key === 'needsYou' ? (
                  <CountPill count={section.data.length} />
                ) : (
                  <Text style={styles.sectionCount}>{section.data.length}</Text>
                )}
                <View style={styles.sectionRule} />
              </View>
            )}
            renderItem={({ item: id }) => <InboxSessionRow id={id} onLongPress={setPeekId} />}
            ListEmptyComponent={
              // Guarded on `booting` even though the crossfade covers this
              // screen: ListEmptyComponent is rendered by the list whenever its
              // data is empty, with no notion of whether loading has finished, so
              // without this the empty state is CONSTRUCTED during bootstrap and
              // sits in the tree — and in the accessibility tree — underneath an
              // opaque placeholder. The crossfade stops it being SEEN; this stops
              // it being built. Related conditions, not the same one.
              booting ? null : (
                <EmptyState
                  title="No agents running"
                  body="Start a session with the + button, or fire off a task from the board."
                />
              )
            }
          />
        </PullToRefreshBoundary>
      </BootstrapCrossfade>
      <TaskSheet
        pool={pool}
        issue={peekIssue ?? null}
        onClose={() => setPeekId(undefined)}
        onOpenSession={(session) => {
          setPeekId(undefined)
          router.push(sessionHref(session.sessionId, '/'))
        }}
      />
    </Screen>
  )
})

const styles = StyleSheet.create({
  // Bottom padding is paid inline from useContentBottomInset: the last card has
  // to scroll clear of the tab bar, whose height is a runtime measurement, not
  // a constant.
  listContent: {
    flexGrow: 1,
  },
  sectionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    paddingHorizontal: space.md + 2,
    paddingTop: space.lg,
    paddingBottom: 5,
  },
  sectionLabel: {
    ...monoLabel(),
    color: color.label,
  },
  needsYouLabel: {
    color: color.needsYouText,
  },
  workingLabel: {
    color: color.workingText,
  },
  sectionCount: {
    ...mono(600),
    color: color.textFaint,
    fontSize: font.micro,
  },
  sectionRule: {
    flex: 1,
    height: StyleSheet.hairlineWidth,
    backgroundColor: color.hairline,
  },
})

import { InboxSessionRow } from '../components/InboxSessionRow'

import { useRouter } from 'expo-router'
import { observer } from 'mobx-react-lite'
import { useMemo } from 'react'
import { SectionList, StyleSheet, Text, View } from 'react-native'
import { useInboxData } from '../client/use-inbox-data'
import { Icon } from '../components/Icon'
import { Inbox as InboxIcon, Settings } from '../components/icons'
import { BootstrapCrossfade, WorkSkeleton } from '../components/LaunchPlaceholders'
import { NewWorkButton } from '../components/NewWorkButton'
import { PullToRefreshBoundary } from '../components/PullToRefreshBoundary'
import { RefreshOffer } from '../components/RefreshOffer'
import { HeaderButton, Screen } from '../components/Screen'
import { CountPill } from '../components/StatusGlyphs'
import { StorageNoticeAlert } from '../components/StorageNoticeAlert'
import { EmptyState } from '../components/ui'
import { useContentBottomInset } from '../hooks/useContentBottomInset'
import { useRefreshableList } from '../hooks/useRefreshableTab'
import { color, font, mono, monoLabel, space } from '../theme/theme'

function inboxSubtitle(needsYou: number, working: number, connected: boolean): string {
  if (!connected) return 'reconnecting…'
  if (needsYou > 0) return `${needsYou} waiting on you · ${working} working`
  if (working > 0) return `all clear · ${working} agent${working > 1 ? 's' : ''} working`
  return 'all clear'
}

export const InboxScreen = observer(function InboxScreen() {
  const router = useRouter()
  const { groups, booting, outboxSize } = useInboxData()
  const { connected, onRefresh, refreshing, refreshControl, refreshAccessibilityProps } =
    useRefreshableList()
  const bottomInset = useContentBottomInset()

  const sections = useMemo(
    () =>
      [
        { key: 'needsYou' as const, title: 'Needs you', data: groups.needsYou },
        { key: 'idle' as const, title: 'Idle', data: groups.idle },
        { key: 'working' as const, title: 'Working', data: groups.working },
      ].filter((s) => s.data.length > 0),
    [groups],
  )

  return (
    <Screen
      large
      title="Inbox"
      subtitle={inboxSubtitle(groups.needsYou.length, groups.working.length, connected)}
      right={
        <>
          {outboxSize > 0 ? <Text style={styles.queued}>{outboxSize} queued</Text> : null}
          <NewWorkButton />
          <HeaderButton label="Settings" onPress={() => router.push('/settings')}>
            <Icon as={Settings} size={17} color={color.textDim} />
          </HeaderButton>
        </>
      }
    >
      {/* Never silent (ADR 6 D4.4): queued work a storage migration could not
          attribute to this account, and storage degradation, are both things the
          user is owed rather than log lines. */}
      <StorageNoticeAlert />
      {/* The phone's own interface is replaced whenever an update lands, by
          someone who was not holding this phone (spec §8c decision 11). */}
      <RefreshOffer />
      <BootstrapCrossfade resolved={!booting} placeholder={<WorkSkeleton />}>
        <PullToRefreshBoundary connected={connected} refreshing={refreshing} onRefresh={onRefresh}>
          <SectionList
            sections={sections}
            keyExtractor={(id) => id}
            stickySectionHeadersEnabled={false}
            refreshControl={refreshControl}
            {...refreshAccessibilityProps}
            renderSectionHeader={({ section }) => (
              <View style={styles.sectionHeader}>
                <Text
                  style={[styles.sectionLabel, section.key === 'needsYou' && styles.needsYouLabel]}
                >
                  {section.title.toUpperCase()}
                </Text>
                {section.key === 'needsYou' ? (
                  <CountPill count={section.data.length} />
                ) : (
                  <Text style={styles.sectionCountText}>{section.data.length}</Text>
                )}
                <View style={styles.sectionRule} />
              </View>
            )}
            renderItem={({ item: id, section }) => (
              <InboxSessionRow id={id} needsYou={section.key === 'needsYou'} />
            )}
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
                  icon={<Icon as={InboxIcon} size={26} color={color.textFaint} />}
                  title="Inbox zero"
                  body="No agents are waiting on you. Start a session or hand something to the superagent."
                />
              )
            }
            contentContainerStyle={[styles.listContent, { paddingBottom: bottomInset + space.lg }]}
          />
        </PullToRefreshBoundary>
      </BootstrapCrossfade>
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
  sectionRule: {
    flex: 1,
    height: StyleSheet.hairlineWidth,
    backgroundColor: color.hairline,
  },
  sectionCountText: {
    ...mono(600),
    color: color.textFaint,
    fontSize: font.micro,
  },
  queued: {
    ...mono(600),
    color: color.needsYouText,
    fontSize: font.tiny,
  },
})

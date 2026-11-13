import { InboxSessionRow } from '../components/InboxSessionRow'
import { listWindow } from '../components/list-window'

import { here } from '@podium/client-graph/lookup'
import {
  inboxNoticeIds,
  markNoticeRead,
  noticeDestination,
  unreadNoticeCount,
} from '@podium/client-graph/notice-inbox'
import type { MobxPool } from '@podium/client-graph/pool'
import type { SessionId } from '@podium/model'
import { useRouter } from 'expo-router'
import { observer } from 'mobx-react-lite'
import { useMemo } from 'react'
import { Pressable, SectionList, StyleSheet, Text, View } from 'react-native'
import { useTrpc } from '../client/hooks'
import { useMobilePool, useMobilePoolProjection } from '../client/mobile-pool'
import { useInboxData } from '../client/use-inbox-data'
import { sessionHref } from '../lib/session-route'
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

const NO_NOTICES: readonly string[] = []
const readNoticeIds = (pool: MobxPool) => inboxNoticeIds(pool)
const readUnread = (pool: MobxPool) => unreadNoticeCount(pool)

/**
 * ONE NOTICE FOR ME (POD-6881, spec §13): tapping it marks it read and opens
 * what it is about. Read from my synced `inboxNotice` record.
 */
const InboxNoticeRow = observer(function InboxNoticeRow({ id }: { id: string }) {
  const pool = useMobilePool()
  const router = useRouter()
  const trpc = useTrpc()
  const notice = pool ? here(pool.model('inboxNotice', id)) : undefined
  if (notice === undefined) return null
  const open = () => {
    if (notice.unread) void markNoticeRead(trpc, notice.noticeId).catch(() => {})
    const to = noticeDestination(notice)
    if (to.kind === 'issue') router.push(`/issue/${encodeURIComponent(to.issueId)}`)
    else if (to.kind === 'session') router.push(sessionHref(to.sessionId as SessionId, '/inbox'))
    else if (to.kind === 'credential') router.push('/settings')
  }
  return (
    <Pressable
      testID="inbox-notice-row"
      accessibilityRole="button"
      accessibilityLabel={notice.unread ? `Unread: ${notice.title}` : notice.title}
      onPress={open}
      style={({ pressed }) => [styles.noticeRow, pressed && styles.noticePressed]}
    >
      <View style={[styles.noticeDot, !notice.unread && styles.noticeDotRead]} />
      <View style={styles.noticeText}>
        <Text style={[styles.noticeTitle, notice.unread && styles.noticeTitleUnread]} numberOfLines={2}>
          {notice.title}
        </Text>
        {notice.body ? (
          <Text style={styles.noticeBody} numberOfLines={1}>
            {notice.body}
          </Text>
        ) : null}
      </View>
    </Pressable>
  )
})

export const InboxScreen = observer(function InboxScreen() {
  const router = useRouter()
  const { groups, booting, outboxSize } = useInboxData()
  const noticeIds = useMobilePoolProjection(readNoticeIds, NO_NOTICES)
  const unreadNotices = useMobilePoolProjection(readUnread, 0)
  const { connected, onRefresh, refreshing, refreshControl, refreshAccessibilityProps } =
    useRefreshableList()
  const bottomInset = useContentBottomInset()

  const sections = useMemo(
    () =>
      [
        // My notices first (POD-6881): what needs me beyond my own agents.
        { key: 'forYou' as const, title: 'For you', data: [...noticeIds] },
        { key: 'needsYou' as const, title: 'Needs you', data: groups.needsYou },
        { key: 'idle' as const, title: 'Idle', data: groups.idle },
        { key: 'working' as const, title: 'Working', data: groups.working },
      ].filter((s) => s.data.length > 0),
    [groups, noticeIds],
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
            {...listWindow}
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
                ) : section.key === 'forYou' ? (
                  unreadNotices > 0 ? (
                    <CountPill count={unreadNotices} />
                  ) : (
                    <Text style={styles.sectionCountText}>{section.data.length}</Text>
                  )
                ) : (
                  <Text style={styles.sectionCountText}>{section.data.length}</Text>
                )}
                <View style={styles.sectionRule} />
              </View>
            )}
            renderItem={({ item: id, section }) =>
              section.key === 'forYou' ? (
                <InboxNoticeRow id={id} />
              ) : (
                <InboxSessionRow id={id} needsYou={section.key === 'needsYou'} />
              )
            }
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
  noticeRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: space.sm,
    paddingHorizontal: space.md + 2,
    paddingVertical: space.sm + 2,
  },
  noticePressed: {
    backgroundColor: color.hairline,
  },
  noticeDot: {
    width: 6,
    height: 6,
    marginTop: 7,
    borderRadius: 3,
    backgroundColor: color.needsYouText,
  },
  noticeDotRead: {
    backgroundColor: 'transparent',
  },
  noticeText: {
    flex: 1,
    gap: 2,
  },
  noticeTitle: {
    color: color.textDim,
    fontSize: font.body,
  },
  noticeTitleUnread: {
    color: color.text,
    fontWeight: '600',
  },
  noticeBody: {
    color: color.textFaint,
    fontSize: font.small,
  },
  queued: {
    ...mono(600),
    color: color.needsYouText,
    fontSize: font.tiny,
  },
})

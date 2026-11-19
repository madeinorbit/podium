/**
 * MY NOTICES ON THE PHONE (POD-6881, credential management spec §13): the
 * notices the Work tab's bell counts, newest first. Tapping one marks it read
 * and opens what it is about. The session roster lives on the Work tab; this
 * screen holds only what needs me beyond my own agents.
 */
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
import { FlatList, Pressable, StyleSheet, Text, View } from 'react-native'
import { useTrpc } from '../client/hooks'
import { useMobilePool, useMobilePoolProjection } from '../client/mobile-pool'
import { Icon } from '../components/Icon'
import { Inbox as InboxIcon } from '../components/icons'
import { listWindow } from '../components/list-window'
import { Screen } from '../components/Screen'
import { EmptyState } from '../components/ui'
import { useContentBottomInset } from '../hooks/useContentBottomInset'
import { sessionHref } from '../lib/session-route'
import { color, font, space } from '../theme/theme'

const NO_NOTICES: readonly string[] = []
const readNoticeIds = (pool: MobxPool) => inboxNoticeIds(pool)
const readUnread = (pool: MobxPool) => unreadNoticeCount(pool)

/** One notice for me, read from my synced `inboxNotice` record. */
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
        <Text
          style={[styles.noticeTitle, notice.unread && styles.noticeTitleUnread]}
          numberOfLines={2}
        >
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
  const noticeIds = useMobilePoolProjection(readNoticeIds, NO_NOTICES)
  const unread = useMobilePoolProjection(readUnread, 0)
  const bottomInset = useContentBottomInset()
  return (
    <Screen large title="Inbox" subtitle={unread > 0 ? `${unread} unread` : 'all read'}>
      <FlatList
        {...listWindow}
        data={noticeIds}
        keyExtractor={(id) => id}
        renderItem={({ item }) => <InboxNoticeRow id={item} />}
        ListEmptyComponent={
          <EmptyState
            icon={<Icon as={InboxIcon} size={26} color={color.textFaint} />}
            title="Inbox zero"
            body="Nothing needs you: no mentions, and every credential works."
          />
        }
        contentContainerStyle={[styles.listContent, { paddingBottom: bottomInset + space.lg }]}
      />
    </Screen>
  )
})

const styles = StyleSheet.create({
  listContent: { flexGrow: 1 },
  noticeRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: space.sm,
    paddingHorizontal: space.md + 2,
    paddingVertical: space.sm + 2,
  },
  noticePressed: { backgroundColor: color.hairline },
  noticeDot: {
    width: 6,
    height: 6,
    marginTop: 7,
    borderRadius: 3,
    backgroundColor: color.needsYouText,
  },
  noticeDotRead: { backgroundColor: 'transparent' },
  noticeText: { flex: 1, gap: 2 },
  noticeTitle: { color: color.textDim, fontSize: font.body },
  noticeTitleUnread: { color: color.text, fontWeight: '600' },
  noticeBody: { color: color.textFaint, fontSize: font.small },
})

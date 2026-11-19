/**
 * THE BELL ON THE WORK HEADER (POD-6881, spec §13): my unread notices at a
 * glance, and the way to the inbox that lists them.
 */

import { unreadNoticeCount } from '@podium/client-graph/notice-inbox'
import type { MobxPool } from '@podium/client-graph/pool'
import { useRouter } from 'expo-router'
import { observer } from 'mobx-react-lite'
import { StyleSheet, View } from 'react-native'
import { useMobilePoolProjection } from '../client/mobile-pool'
import { color } from '../theme/theme'
import { Icon } from './Icon'
import { Bell, BellRing } from './icons'
import { HeaderButton } from './Screen'
import { CountPill } from './StatusGlyphs'

const readUnread = (pool: MobxPool) => unreadNoticeCount(pool)

/** How many of my notices I have not read; 0 while the pool attaches. */
export function useUnreadNotices(): number {
  return useMobilePoolProjection(readUnread, 0)
}

export const NoticeBell = observer(function NoticeBell({ size = 34 }: { size?: 28 | 32 | 34 }) {
  const router = useRouter()
  const unread = useUnreadNotices()
  return (
    <HeaderButton
      size={size}
      label={unread === 0 ? 'Inbox' : `Inbox, ${unread} unread`}
      onPress={() => router.push('/inbox')}
    >
      <View testID="notice-bell">
        <Icon as={unread > 0 ? BellRing : Bell} size={17} color={color.textDim} />
        {unread > 0 ? (
          <View style={styles.pill} testID="notice-bell-count">
            <CountPill count={unread} size={14} />
          </View>
        ) : null}
      </View>
    </HeaderButton>
  )
})

const styles = StyleSheet.create({
  pill: {
    position: 'absolute',
    top: -7,
    right: -10,
  },
})

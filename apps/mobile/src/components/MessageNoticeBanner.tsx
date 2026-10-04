import type { MessageNotice } from '@podium/client-core/viewmodels'
import { useRouter } from 'expo-router'
import { useContext, useState } from 'react'
import { StyleSheet, Text, View } from 'react-native'
import { SafeAreaInsetsContext } from 'react-native-safe-area-context'
import { useTrpc } from '../client/hooks'
import { usePoolMessageNotices } from '../client/use-pool-notices'
import { color, elevation, font, leading, radius, sans, space } from '../theme/theme'
import { Icon } from './Icon'
import { AlertTriangle, X } from './icons'
import { PressableScale } from './PressableScale'

/**
 * MESSAGES THAT DID NOT ARRIVE, OVER EVERY ROUTE (POD-4764).
 *
 * A chat message the server says will not be delivered, or that nobody can
 * vouch for, shows in its chat — and here, so the phone says so on whatever
 * screen it is on. The newest one is named; tapping it opens its chat, where
 * "Send again" puts the words back in the composer. Dismiss clears its notice
 * on every device. Read from the synced records, like the chat.
 */
export function MessageNoticeBanner() {
  const notices = usePoolMessageNotices()
  return <MessageNoticeBannerBody notices={notices} />
}

function MessageNoticeBannerBody({ notices }: { notices: readonly MessageNotice[] }) {
  const trpc = useTrpc()
  const router = useRouter()
  const [error, setError] = useState<string | null>(null)
  const insets = useContext(SafeAreaInsetsContext)
  const newest = notices[0]
  if (!newest) return null
  const more = notices.length - 1

  return (
    <View
      pointerEvents="box-none"
      style={[styles.host, { paddingTop: (insets?.top ?? 0) + space.xs }]}
    >
      <View accessibilityRole="alert" style={styles.card} testID="message-notice-banner">
        <View style={styles.tint}>
          <Icon as={AlertTriangle} size={17} color={color.dangerText} />
          <PressableScale
            accessibilityRole="button"
            accessibilityLabel={`Open the chat with ${newest.sessionLabel}`}
            haptic={false}
            onPress={() => router.push(`/session/${encodeURIComponent(newest.sessionId)}`)}
            style={styles.body}
          >
            <Text style={styles.message} numberOfLines={2}>
              {`To ${newest.sessionLabel}: “${newest.excerpt}” — ${newest.line}`}
            </Text>
            {more > 0 ? <Text style={styles.more}>{`and ${more} more not delivered`}</Text> : null}
            {error ? <Text style={styles.more}>{error}</Text> : null}
          </PressableScale>
          <PressableScale
            accessibilityRole="button"
            accessibilityLabel="Dismiss this notice"
            hitSlop={10}
            haptic={false}
            onPress={() => {
              setError(null)
              trpc.messages.dismissNotice
                .mutate({ id: newest.messageId })
                .catch((cause: unknown) =>
                  setError(cause instanceof Error ? cause.message : String(cause)),
                )
            }}
            style={styles.dismiss}
          >
            <Icon as={X} size={16} color={color.textDim} />
          </PressableScale>
        </View>
      </View>
    </View>
  )
}

const styles = StyleSheet.create({
  host: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    zIndex: 999,
    paddingHorizontal: space.sm + 2,
  },
  card: {
    ...elevation.card,
    backgroundColor: color.surface,
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(229, 48, 63, 0.4)',
  },
  tint: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: space.sm,
    paddingHorizontal: space.md,
    paddingVertical: space.sm + 2,
    borderRadius: radius.md,
    backgroundColor: color.dangerSoft,
  },
  body: {
    flex: 1,
  },
  message: {
    ...sans(500),
    color: color.body,
    fontSize: font.small,
    lineHeight: leading(font.small),
  },
  more: {
    ...sans(400),
    color: color.textDim,
    fontSize: font.small,
    lineHeight: leading(font.small),
  },
  dismiss: {
    padding: 2,
  },
})

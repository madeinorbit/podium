import { useRouter } from 'expo-router'
import { StyleSheet, Text, View } from 'react-native'
import { useConnected } from '../client/hooks'
import { useServerProfile } from '../client/ServerProfileGate'
import { usePoolContinuity } from '../client/use-pool-notices'
import { useWorkspaceSyncPhase } from '../client/workspace-refresh'
import { color, font, leading, radius, sans, space } from '../theme/theme'
import { Icon } from './Icon'
import { AlertTriangle } from './icons'
import { NoticeLayout } from './notice-layout'
import { PressableScale } from './PressableScale'

function plural(count: number, singular: string, multiple: string): string {
  return `${count} ${count === 1 ? singular : multiple}`
}

/** Recovery facts are immediate; offline waits for the shared sync lifecycle. */
export function WorkspaceContinuityNotice() {
  const { outboxSize, deadLetters } = usePoolContinuity()
  return <ContinuityNoticeBody outboxSize={outboxSize} deadLetters={deadLetters} />
}

function ContinuityNoticeBody({
  outboxSize,
  deadLetters,
}: {
  outboxSize: number
  deadLetters: number
}) {
  const router = useRouter()
  const connected = useConnected()
  const phase = useWorkspaceSyncPhase()
  const { profile } = useServerProfile()
  const offline = !connected && (phase === 'offline' || phase === 'error')

  const lines = [
    offline ? `Offline. Showing saved data for ${profile.name}.` : null,
    offline && outboxSize > 0
      ? `${plural(outboxSize, 'change is', 'changes are')} queued and will send when connected.`
      : null,
    deadLetters > 0
      ? `${plural(deadLetters, 'change needs', 'changes need')} review in Settings.`
      : null,
  ].filter((line): line is string => line !== null)
  if (lines.length === 0) return null

  return (
    <NoticeLayout>
      <View style={styles.container}>
        <PressableScale
          accessibilityRole="button"
          accessibilityLabel={`${lines.join(' ')} Open Settings.`}
          onPress={() => router.push('/settings')}
          style={({ pressed }) => [styles.notice, pressed && styles.pressed]}
          testID="workspace-continuity-notice"
        >
          <Icon as={AlertTriangle} size={17} color={color.needsYouText} />
          <View style={styles.copy}>
            {lines.map((line) => (
              <Text key={line} style={styles.text}>
                {line}
              </Text>
            ))}
          </View>
          <Text style={styles.link}>Settings</Text>
        </PressableScale>
      </View>
    </NoticeLayout>
  )
}

const styles = StyleSheet.create({
  // The hosted root fills the native row; its padding keeps the card inside it.
  container: { paddingHorizontal: space.md, paddingBottom: space.sm },
  notice: {
    minHeight: 52,
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: space.sm,
    borderRadius: radius.card,
    borderCurve: 'continuous',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.borderStrong,
    backgroundColor: color.groupedCard,
    paddingHorizontal: space.md,
    paddingVertical: space.md,
  },
  pressed: { opacity: 0.84 },
  copy: { flex: 1, minWidth: 0, gap: space.xs },
  text: { color: color.body, fontSize: font.tiny, lineHeight: leading(font.tiny, 'prose') },
  link: {
    flexShrink: 0,
    alignSelf: 'center',
    color: color.needsYouText,
    ...sans(600),
    fontSize: font.tiny,
  },
})

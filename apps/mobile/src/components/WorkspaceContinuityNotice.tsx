import { useRouter } from 'expo-router'
import { StyleSheet, Text, View } from 'react-native'
import { useConnected, useMobileStore } from '../client/hooks'
import { useServerProfile } from '../client/ServerProfileGate'
import { color, font, leading, radius, sans, space } from '../theme/theme'
import { Icon } from './Icon'
import { AlertTriangle } from './icons'
import { PressableScale } from './PressableScale'

function plural(count: number, singular: string, multiple: string): string {
  return `${count} ${count === 1 ? singular : multiple}`
}

/** Persistent, first-snapshot status for facts that survive a relaunch. */
export function WorkspaceContinuityNotice() {
  const router = useRouter()
  const connected = useConnected()
  const { outboxDeadLetters, outboxSize } = useMobileStore()
  const { profile } = useServerProfile()
  if (connected && outboxSize === 0 && outboxDeadLetters.length === 0) return null

  const lines = [
    !connected ? `Offline. Showing saved data for ${profile.name}.` : null,
    outboxSize > 0
      ? `${plural(outboxSize, 'change is', 'changes are')} queued and will send when connected.`
      : null,
    outboxDeadLetters.length > 0
      ? `${plural(outboxDeadLetters.length, 'change needs', 'changes need')} review in Settings.`
      : null,
  ].filter((line): line is string => line !== null)

  return (
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
  )
}

const styles = StyleSheet.create({
  notice: {
    minHeight: 52,
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.borderStrong,
    backgroundColor: color.surface,
    marginHorizontal: space.sm + 2,
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
  },
  pressed: { opacity: 0.84 },
  copy: { flex: 1, minWidth: 0, gap: 2 },
  text: { color: color.body, fontSize: font.tiny, lineHeight: leading(font.tiny, 'prose') },
  link: { color: color.needsYouText, ...sans(600), fontSize: font.tiny },
})

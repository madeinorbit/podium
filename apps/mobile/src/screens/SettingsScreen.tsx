import { useRouter } from 'expo-router'
import { Monitor } from 'lucide-react-native'
import { useState } from 'react'
import { Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native'
import { logout } from '../client/auth'
import { useMobileClient } from '../client/MobileClientProvider'
import { Icon } from '../components/Icon'
import { Screen } from '../components/Screen'
import { SectionHeader } from '../components/ui'
import { color, font, radius, space } from '../theme/theme'

function openDesktop() {
  // The web shell is the default at / for every device now [spec:SP-902c]; /desktop is
  // just a stable link back, no opt-out cookie involved.
  if (typeof window !== 'undefined') {
    window.location.assign('/desktop' + window.location.search)
  }
}

export function SettingsScreen() {
  const router = useRouter()
  const { connected, conversations, cursor, issues, outboxSize, serverConfig, sessions } =
    useMobileClient()
  const [loggedOut, setLoggedOut] = useState(false)

  const doLogout = async () => {
    await logout(serverConfig.httpOrigin)
    setLoggedOut(true)
    if (typeof window !== 'undefined') window.location.reload()
  }

  return (
    <Screen title="Settings" onBack={() => router.back()}>
      <ScrollView contentContainerStyle={styles.content}>
        {Platform.OS === 'web' ? (
          <Pressable
            style={({ pressed }) => [styles.action, pressed && styles.actionPressed]}
            onPress={openDesktop}
            accessibilityRole="button"
            accessibilityLabel="Open desktop"
          >
            <Icon as={Monitor} size={18} color={color.accentText} />
            <Text style={styles.actionText}>Open desktop</Text>
          </Pressable>
        ) : null}

        <SectionHeader label="Connection" />
        <View style={styles.panel}>
          <Row label="Server" value={serverConfig.httpOrigin} />
          <Row label="Status" value={connected ? 'live' : 'reconnecting'} />
          <Row label="Platform" value={Platform.OS} />
          <Row label="Sync cursor" value={String(cursor ?? 'none')} />
        </View>

        <SectionHeader label="Data" />
        <View style={styles.panel}>
          <Row label="Sessions" value={String(sessions.length)} />
          <Row label="Tasks" value={String(issues.length)} />
          <Row label="Conversations" value={String(conversations.length)} />
          <Row label="Queued sends" value={String(outboxSize)} />
        </View>

        <SectionHeader label="Account" />
        <Pressable
          style={({ pressed }) => [styles.logout, pressed && styles.actionPressed]}
          onPress={() => void doLogout()}
          accessibilityRole="button"
          accessibilityLabel="Log out"
        >
          <Text style={styles.logoutText}>{loggedOut ? 'Logged out' : 'Log out'}</Text>
        </Pressable>
        <Text style={styles.hint}>
          Notifications: set an ntfy topic or a Telegram bot in the desktop app's settings to get
          pushed when an agent needs you.
        </Text>
      </ScrollView>
    </Screen>
  )
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.row}>
      <Text style={styles.rowLabel}>{label}</Text>
      <Text style={styles.rowValue} numberOfLines={1}>
        {value}
      </Text>
    </View>
  )
}

const styles = StyleSheet.create({
  content: {
    padding: space.lg,
    paddingBottom: space.xxl,
  },
  action: {
    minHeight: 44,
    borderRadius: radius.sm,
    backgroundColor: color.accent,
    flexDirection: 'row',
    gap: space.sm,
    alignItems: 'center',
    justifyContent: 'center',
  },
  actionPressed: {
    opacity: 0.85,
  },
  actionText: {
    color: color.accentText,
    fontWeight: '700',
    fontSize: font.body,
  },
  panel: {
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.border,
    backgroundColor: color.card,
    paddingHorizontal: space.md,
    paddingVertical: space.xs,
  },
  row: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: space.md,
    paddingVertical: space.sm + 2,
  },
  rowLabel: {
    color: color.textDim,
    fontSize: font.small,
  },
  rowValue: {
    color: color.text,
    fontSize: font.small,
    flexShrink: 1,
  },
  logout: {
    minHeight: 44,
    borderRadius: radius.sm,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.danger,
    alignItems: 'center',
    justifyContent: 'center',
  },
  logoutText: {
    color: color.danger,
    fontWeight: '700',
    fontSize: font.body,
  },
  hint: {
    color: color.textFaint,
    fontSize: font.small,
    lineHeight: 19,
    marginTop: space.lg,
  },
})

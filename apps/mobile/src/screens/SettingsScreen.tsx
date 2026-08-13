import { useRouter } from 'expo-router'
import { Monitor } from 'lucide-react-native'
import { useState } from 'react'
import { Alert, Platform, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native'
import { logout } from '../client/auth'
import { useConnected, useMobileStore } from '../client/hooks'
import { useServerProfile } from '../client/ServerProfileGate'
import { useMobileShell } from '../client/shell'
import { Icon } from '../components/Icon'
import { PressableScale } from '../components/PressableScale'
import { Screen } from '../components/Screen'
import { SectionHeader } from '../components/ui'
import { color, font, leading, radius, sans, space } from '../theme/theme'

function openDesktop() {
  // The web shell is the default at / for every device now [spec:SP-902c]; /desktop is
  // just a stable link back, no opt-out cookie involved.
  if (typeof window !== 'undefined') {
    window.location.assign('/desktop' + window.location.search)
  }
}

export function SettingsScreen() {
  const router = useRouter()
  const { conversations, issues, outboxSize, replica, sessions, httpOrigin } = useMobileStore()
  const connected = useConnected()
  const { eraseLocalData } = useMobileShell()
  const {
    profile,
    profiles,
    bearer,
    isEphemeralOverride,
    beginAddServer,
    switchProfile,
    renameProfile,
    removeProfile,
    updateCredential,
  } = useServerProfile()
  const [loggedOut, setLoggedOut] = useState(false)
  const [profileName, setProfileName] = useState(profile.name)
  const [accountBusy, setAccountBusy] = useState(false)

  const finishLocalLogout = async () => {
    await eraseLocalData()
    setLoggedOut(true)
    await updateCredential(null)
    if (typeof window !== 'undefined') window.location.reload()
  }

  const doLogout = async () => {
    if (accountBusy) return
    setAccountBusy(true)
    try {
      try {
        await logout(httpOrigin, bearer)
      } catch {
        Alert.alert(
          'Remote logout failed',
          'This phone still has the credential needed to retry. Keep it, or remove local data now and later revoke this phone from Settings → Connected devices on the server.',
          [
            { text: 'Keep signed in', style: 'cancel' },
            {
              text: 'Remove locally',
              style: 'destructive',
              onPress: () => {
                void finishLocalLogout().then(() => {
                  if (Platform.OS !== 'web') {
                    Alert.alert(
                      'Removed locally',
                      'The remote phone session may still be active. Revoke it from Settings → Connected devices on the server.',
                    )
                  }
                })
              },
            },
          ],
        )
        return
      }
      await finishLocalLogout().catch((cause: unknown) =>
        Alert.alert(
          'Logged out remotely',
          `The server session was revoked, but local cleanup failed: ${cause instanceof Error ? cause.message : String(cause)}`,
        ),
      )
    } finally {
      setAccountBusy(false)
    }
  }

  const removeCurrent = () => {
    Alert.alert(
      `Remove ${profile.name}?`,
      'Podium will first revoke this phone session, then remove this server account and its local offline data.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Remove',
          style: 'destructive',
          onPress: () => {
            void (async () => {
              if (accountBusy) return
              setAccountBusy(true)
              const removeLocally = async () => {
                // The mounted replica owns exactly profileId + userId; erase it
                // before profile selection remounts or unmounts the client stack.
                await eraseLocalData()
                await removeProfile(profile.id)
                router.replace('/')
              }
              try {
                try {
                  await logout(httpOrigin, bearer)
                } catch {
                  Alert.alert(
                    'Remote revocation failed',
                    'Keep this server to retry with its credential, or remove it locally and later revoke the phone from Settings → Connected devices on the server.',
                    [
                      { text: 'Keep server', style: 'cancel' },
                      {
                        text: 'Remove locally',
                        style: 'destructive',
                        onPress: () => {
                          void removeLocally().then(() =>
                            Alert.alert(
                              'Removed locally',
                              'The remote phone session may still be active. Revoke it from Settings → Connected devices on the server.',
                            ),
                          )
                        },
                      },
                    ],
                  )
                  return
                }
                await removeLocally().catch((cause: unknown) =>
                  Alert.alert(
                    'Session revoked',
                    `The remote phone session is gone, but local removal failed: ${cause instanceof Error ? cause.message : String(cause)}`,
                  ),
                )
              } finally {
                setAccountBusy(false)
              }
            })()
          },
        },
      ],
    )
  }

  return (
    <Screen title="Settings" onBack={() => router.back()} backAs="text" backLabel="Done">
      <ScrollView contentContainerStyle={styles.content}>
        {Platform.OS === 'web' ? (
          <PressableScale
            style={({ pressed }) => [styles.action, pressed && styles.actionPressed]}
            onPress={openDesktop}
            accessibilityRole="button"
            accessibilityLabel="Open desktop"
          >
            <Icon as={Monitor} size={18} color={color.accentText} />
            <Text style={styles.actionText}>Open desktop</Text>
          </PressableScale>
        ) : null}

        <SectionHeader label="Connection" />
        <View style={styles.panel}>
          <Row label="Server" value={httpOrigin} />
          <Row label="Status" value={connected ? 'live' : 'reconnecting'} />
          <Row label="Platform" value={Platform.OS} />
          <Row label="Sync cursor" value={String(replica.getCursor() ?? 'none')} />
        </View>

        {Platform.OS !== 'web' ? (
          <>
            <SectionHeader label="Servers" />
            <View style={styles.panel}>
              {profiles.map((row) => (
                <PressableScale
                  key={row.id}
                  style={({ pressed }) => [styles.serverRow, pressed && styles.actionPressed]}
                  onPress={() =>
                    void switchProfile(row.id).catch((cause: unknown) =>
                      Alert.alert(
                        'Could not switch safely',
                        cause instanceof Error ? cause.message : String(cause),
                      ),
                    )
                  }
                  accessibilityRole="button"
                  accessibilityLabel={`Switch to ${row.name}`}
                >
                  <View
                    style={[styles.serverDot, row.id === profile.id && styles.serverDotActive]}
                  />
                  <View style={styles.serverDetails}>
                    <Text style={styles.serverTitle}>{row.name}</Text>
                    <Text style={styles.serverHost} numberOfLines={1}>
                      {row.userId ? `${row.httpOrigin} · ${row.userId}` : row.httpOrigin}
                    </Text>
                  </View>
                  <Text style={styles.serverMode}>
                    {row.transport === 'insecure-lan'
                      ? 'INSECURE'
                      : row.id === profile.id
                        ? connected
                          ? 'LIVE'
                          : 'RECONNECTING'
                        : 'SWITCH'}
                  </Text>
                </PressableScale>
              ))}
            </View>
            {!isEphemeralOverride ? (
              <>
                <View style={styles.renameRow}>
                  <TextInput
                    style={styles.renameInput}
                    value={profileName}
                    onChangeText={setProfileName}
                    accessibilityLabel="Server name"
                  />
                  <PressableScale
                    style={styles.renameButton}
                    onPress={() => void renameProfile(profile.id, profileName)}
                    accessibilityRole="button"
                    accessibilityLabel="Rename server"
                  >
                    <Text style={styles.renameButtonText}>Rename</Text>
                  </PressableScale>
                </View>
                <PressableScale
                  style={styles.addServer}
                  onPress={beginAddServer}
                  accessibilityRole="button"
                  accessibilityLabel="Add server"
                >
                  <Text style={styles.addServerText}>Add server</Text>
                </PressableScale>
                <PressableScale
                  style={styles.removeServer}
                  onPress={removeCurrent}
                  accessibilityRole="button"
                  accessibilityLabel={`Remove ${profile.name}`}
                >
                  <Text style={styles.logoutText}>Remove this server</Text>
                </PressableScale>
              </>
            ) : (
              <Text style={styles.hint}>
                This development server override is ephemeral and cannot be edited or saved.
              </Text>
            )}
          </>
        ) : null}

        <SectionHeader label="Data" />
        <View style={styles.panel}>
          <Row label="Sessions" value={String(sessions.length)} />
          <Row label="Tasks" value={String(issues.length)} />
          <Row label="Conversations" value={String(conversations.length)} />
          <Row label="Queued sends" value={String(outboxSize)} />
        </View>

        <SectionHeader label="Account" />
        <PressableScale
          style={({ pressed }) => [styles.logout, pressed && styles.actionPressed]}
          onPress={() => void doLogout()}
          disabled={accountBusy}
          accessibilityRole="button"
          accessibilityLabel="Log out"
          accessibilityState={{ disabled: accountBusy, busy: accountBusy }}
        >
          <Text style={styles.logoutText}>{loggedOut ? 'Logged out' : 'Log out'}</Text>
        </PressableScale>
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
    ...sans(700),
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
  serverRow: {
    minHeight: 62,
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: color.border,
  },
  serverDot: { width: 9, height: 9, borderRadius: 99, backgroundColor: color.idle },
  serverDotActive: { backgroundColor: color.success },
  serverDetails: { flex: 1, minWidth: 0, gap: 2 },
  serverTitle: { color: color.text, ...sans(600), fontSize: font.small },
  serverHost: { color: color.textFaint, fontSize: font.tiny },
  serverMode: { color: color.textMicro, ...sans(700), fontSize: font.micro },
  renameRow: { flexDirection: 'row', gap: space.sm, marginTop: space.md },
  renameInput: {
    flex: 1,
    minHeight: 44,
    borderRadius: radius.sm,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.borderStrong,
    backgroundColor: color.surface,
    color: color.text,
    paddingHorizontal: space.md,
    fontSize: font.small,
  },
  renameButton: {
    minHeight: 44,
    paddingHorizontal: space.lg,
    borderRadius: radius.sm,
    backgroundColor: color.surfaceHigh,
    alignItems: 'center',
    justifyContent: 'center',
  },
  renameButtonText: { color: color.text, ...sans(600), fontSize: font.small },
  addServer: {
    minHeight: 46,
    marginTop: space.sm,
    borderRadius: radius.sm,
    backgroundColor: color.accent,
    alignItems: 'center',
    justifyContent: 'center',
  },
  addServerText: { color: color.onAccent, ...sans(700), fontSize: font.body },
  removeServer: {
    minHeight: 44,
    marginTop: space.sm,
    borderRadius: radius.sm,
    alignItems: 'center',
    justifyContent: 'center',
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
    ...sans(700),
    fontSize: font.body,
  },
  hint: {
    color: color.textFaint,
    fontSize: font.small,
    lineHeight: leading(font.small, 'prose'),
    marginTop: space.lg,
  },
})

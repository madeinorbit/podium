import { relativeTime } from '@podium/client-core/focus'
import {
  devicePlatformLabel,
  formatCount,
  visibleFleetOperations,
} from '@podium/client-core/values'
import type { MobileClientSession } from '@podium/protocol'
import { useRouter } from 'expo-router'
import { observer } from 'mobx-react-lite'
import { useMemo, useState } from 'react'
import { Alert, Platform, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native'
import { logout } from '../client/auth'
import { useConnectedDevices } from '../client/connected-devices'
import { DEMO_HOST_METRICS, DEMO_MACHINES, demoEnabled } from '../client/demoData'
import { useConnected, useHttpOrigin } from '../client/hooks'
import { useServerProfile } from '../client/ServerProfileGate'
import { useMobileShell } from '../client/shell'
import { Icon } from '../components/Icon'
import { Check, Monitor } from '../components/icons'
import { OutboxRecoveryPanel } from '../components/OutboxRecoveryPanel'
import { PressableScale } from '../components/PressableScale'
import { Screen } from '../components/Screen'
import { useContentBottomInset } from '../hooks/useContentBottomInset'
import { useBuildStamp } from '../lib/build-stamp'
import { useAgeNow } from '../lib/clock-hooks'
import { color, font, grid, leading, radius, sans } from '../theme/theme'
import { SettingsOpening } from './settings-opening'
import {
  type SettingsMachineStatus,
  useSettingsData,
  useSettingsMachineStatus,
} from './settings-readers'

function openDesktop() {
  // The web shell is the default at / for every device now [spec:SP-902c]; /desktop is
  // just a stable link back, no opt-out cookie involved.
  if (typeof window !== 'undefined') {
    window.location.assign(`/desktop${window.location.search}`)
  }
}

export function SettingsScreen() {
  return (
    <SettingsOpening>
      <SettingsScreenBody />
    </SettingsOpening>
  )
}

const SettingsScreenBody = observer(function SettingsScreenBody() {
  const router = useRouter()
  // The last row clears the tab bar on native and the home indicator on web.
  const bottomInset = useContentBottomInset()
  const {
    machineIds,
    machineCount,
    fleetLabel,
    updateLabel,
    sessionCount,
    issueCount,
    outboxDeadLetterCount,
    outboxSize,
    cursor,
  } = useSettingsData()
  const httpOrigin = useHttpOrigin()
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
  const deviceFeed = useConnectedDevices()
  const buildStamp = useBuildStamp()
  const demo = demoEnabled()
  const demoFleet = useMemo(
    () =>
      demo ? visibleFleetOperations({ machines: DEMO_MACHINES, hosts: DEMO_HOST_METRICS }) : null,
    [demo],
  )
  const devices = deviceFeed.sessions ?? []

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
        await logout(httpOrigin, bearer, profile.workspaceId)
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
                  await logout(httpOrigin, bearer, profile.workspaceId)
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

  const host = hostOf(httpOrigin)
  const machines = demoFleet?.visibleCount ?? machineCount
  return (
    <Screen
      title="Settings"
      large={Platform.OS !== 'web'}
      onBack={Platform.OS === 'web' ? () => router.back() : undefined}
      backAs="text"
      backLabel="Done"
    >
      <ScrollView
        style={styles.scroll}
        contentInsetAdjustmentBehavior="automatic"
        contentContainerStyle={[styles.content, { paddingBottom: bottomInset + grid(6) }]}
      >
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

        <OutboxRecoveryPanel />

        <View style={styles.card}>
          <View style={styles.server}>
            <Text style={styles.serverName} numberOfLines={1}>
              {host}
            </Text>
            <Text style={styles.serverLine} numberOfLines={1}>
              <Text style={connected ? styles.liveDot : styles.offlineDot}>● </Text>
              {connected ? 'Connected' : 'Offline, showing saved data'}
              {` · ${machines} ${machines === 1 ? 'machine' : 'machines'}`}
            </Text>
            <Text
              style={styles.serverLine}
              numberOfLines={1}
              accessibilityLabel="Data on this phone"
            >
              {`${formatCount(sessionCount)} sessions · ${formatCount(issueCount)} tasks`}
            </Text>
          </View>
        </View>

        <GroupHeader label="Machines" />
        <View style={styles.card}>
          <Row label="Visible fleet" value={demoFleet?.fleetLabel ?? fleetLabel} />
          <Row label="Updates" value={demoFleet?.updateLabel ?? updateLabel} />
          {demoFleet
            ? demoFleet.machines
                .slice(0, 12)
                .map((machine) => <MachineStatusRow key={machine.id} machine={machine} />)
            : machineIds.map((id) => <SettingsMachineRow key={id} id={id} />)}
          {machines > 12 ? (
            <Row label="More machines" value={`${machines - 12} · see Pulse`} />
          ) : null}
        </View>
        <Text style={styles.footer}>
          This phone shows status only. Fleet, network, host, and update changes stay on authorized
          desktop or server surfaces.
        </Text>

        <GroupHeader label="Connected devices" />
        <View style={styles.card}>
          {deviceFeed.loading && devices.length === 0 ? (
            <Row label="Devices" value="Loading…" />
          ) : deviceFeed.failed && devices.length === 0 ? (
            <Row label="Devices" value="Unavailable" />
          ) : devices.length === 0 ? (
            <Row label="Devices" value="None" />
          ) : (
            devices.map((device) => <ConnectedDeviceRow key={device.sessionId} device={device} />)
          )}
          {deviceFeed.failed && devices.length > 0 ? (
            <Row label="Refresh" value="Failed · showing prior list" />
          ) : null}
        </View>
        <Text style={styles.footer}>
          This list belongs to the signed-in account on {profile.name}. Pairing and revocation stay
          in Connected devices on the desktop.
        </Text>

        {Platform.OS !== 'web' ? (
          <>
            <GroupHeader label="Servers" />
            <View style={styles.card}>
              {profiles.map((row) => (
                <PressableScale
                  key={row.id}
                  style={({ pressed }) => [styles.serverRow, pressed && styles.rowPressed]}
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
                  accessibilityState={{ selected: row.id === profile.id }}
                >
                  <View style={styles.serverDetails}>
                    <Text style={styles.rowTitle} numberOfLines={1}>
                      {row.name}
                    </Text>
                    <Text style={styles.rowDetail} numberOfLines={1}>
                      {row.userId ? `${row.httpOrigin} · ${row.userId}` : row.httpOrigin}
                    </Text>
                  </View>
                  {row.transport === 'insecure-lan' ? (
                    <Text style={styles.rowWarning}>Insecure</Text>
                  ) : null}
                  {row.id === profile.id ? (
                    <Icon as={Check} size={17} color={color.accentTint} />
                  ) : null}
                </PressableScale>
              ))}
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
                      <Text style={styles.tintLabel}>Rename</Text>
                    </PressableScale>
                  </View>
                  <PressableScale
                    style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
                    onPress={beginAddServer}
                    accessibilityRole="button"
                    accessibilityLabel="Add server"
                  >
                    <Text style={styles.tintLabel}>Add server</Text>
                  </PressableScale>
                </>
              ) : null}
            </View>
            {isEphemeralOverride ? (
              <Text style={styles.footer}>
                This development server override is ephemeral and cannot be edited or saved.
              </Text>
            ) : null}
          </>
        ) : null}

        <GroupHeader label="About" />
        <View style={styles.card}>
          <Row label="Server build" value={buildStamp.text.replace(/\n/g, ' · ')} />
          <Row label="Queued sends" value={String(outboxSize)} />
          <Row label="Needs recovery" value={String(outboxDeadLetterCount)} />
          <Row label="Sync cursor" value={String(cursor ?? 'none')} />
        </View>
        <Text style={styles.footer}>
          Notifications: set an ntfy topic or a Telegram bot in the desktop app's settings to get
          pushed when an agent needs you.
        </Text>

        <View style={[styles.card, styles.lastCard]}>
          <PressableScale
            style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
            onPress={() => void doLogout()}
            disabled={accountBusy}
            accessibilityRole="button"
            accessibilityLabel="Log out"
            // `aria-busy` beside `accessibilityState`: react-native-web 0.21 reads
            // only the former. The disabled half already reaches the browser via
            // the `disabled` prop above. [POD-1664]
            accessibilityState={{ disabled: accountBusy, busy: accountBusy }}
            aria-busy={accountBusy}
          >
            <Text style={styles.destructiveLabel}>{loggedOut ? 'Logged out' : 'Log out'}</Text>
          </PressableScale>
          {Platform.OS !== 'web' && !isEphemeralOverride ? (
            <PressableScale
              style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
              onPress={removeCurrent}
              accessibilityRole="button"
              accessibilityLabel={`Remove ${profile.name}`}
            >
              <Text style={styles.destructiveLabel}>Remove this server</Text>
            </PressableScale>
          ) : null}
        </View>
        {Platform.OS !== 'web' && !isEphemeralOverride ? (
          <Text style={styles.footer}>
            Removing signs this phone out of {host}. Nothing on the server is deleted.
          </Text>
        ) : null}
      </ScrollView>
    </Screen>
  )
})

function hostOf(origin: string): string {
  try {
    return new URL(origin).host || origin
  } catch {
    return origin
  }
}

function GroupHeader({ label }: { label: string }) {
  return (
    <Text style={styles.groupHeader} accessibilityRole="header">
      {label}
    </Text>
  )
}

const ConnectedDeviceRow = observer(function ConnectedDeviceRow({
  device,
}: {
  device: MobileClientSession
}) {
  const now = useAgeNow(
    device.lastSeenAt ?? device.createdAt,
    0,
    !device.current && !!device.lastSeenAt,
  )
  const activity = device.current
    ? 'This device · active now'
    : device.lastSeenAt
      ? `Active ${relativeTime(device.lastSeenAt, now)}`
      : 'No activity reported'
  return (
    <View style={styles.tallRow}>
      <View style={styles.serverDetails}>
        <Text style={styles.rowTitle} numberOfLines={1}>
          {device.deviceName}
        </Text>
        <Text style={styles.rowDetail} numberOfLines={1}>
          {devicePlatformLabel(device.platform)} · {activity}
        </Text>
      </View>
      {device.current ? <Text style={styles.rowValueQuiet}>This phone</Text> : null}
    </View>
  )
})

function SettingsMachineRow({ id }: { id: string }) {
  const machine = useSettingsMachineStatus(id)
  return machine ? <MachineStatusRow machine={machine} /> : null
}

function MachineStatusRow({ machine }: { machine: SettingsMachineStatus }) {
  return (
    <View style={styles.tallRow}>
      <View style={[styles.statusDot, machine.online ? styles.statusDotLive : null]} />
      <View style={styles.serverDetails}>
        <Text style={styles.rowTitle} numberOfLines={1}>
          {machine.name}
        </Text>
        <Text style={styles.rowDetail} numberOfLines={1}>
          {machine.updateLabel}
        </Text>
      </View>
      <Text style={styles.rowValueQuiet} numberOfLines={1}>
        {`${machine.statusLabel}${machine.updateChannel ? ` · ${machine.updateChannel}` : ''}`}
      </Text>
    </View>
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

/**
 * Grouped list on the 4pt grid (Settings board): 16 screen margin, cards with
 * radius 8 and a 12 inset, 44pt rows with hairline separators inset to the
 * text, 13pt section headers sitting on the card's own axis.
 */
const separator = {
  borderTopWidth: StyleSheet.hairlineWidth,
  borderTopColor: color.border,
} as const

const styles = StyleSheet.create({
  scroll: { flex: 1, backgroundColor: color.groupedBg },
  content: { paddingHorizontal: grid(4), paddingTop: grid(2) },
  action: {
    minHeight: 44,
    marginBottom: grid(4),
    borderRadius: radius.control,
    backgroundColor: color.accent,
    flexDirection: 'row',
    gap: grid(2),
    alignItems: 'center',
    justifyContent: 'center',
  },
  actionPressed: { opacity: 0.85 },
  actionText: { color: color.accentText, ...sans(600), fontSize: font.small },
  card: {
    borderRadius: radius.card,
    backgroundColor: color.groupedCard,
    overflow: 'hidden',
  },
  lastCard: { marginTop: grid(7) },
  server: { paddingHorizontal: grid(3), paddingVertical: grid(3), gap: 2 },
  serverName: { ...sans(600), color: color.text, fontSize: font.body, lineHeight: leading(17) },
  serverLine: { ...sans(400), color: color.textDim, fontSize: font.tiny, lineHeight: leading(13) },
  liveDot: { color: color.workingText },
  offlineDot: { color: color.idle },
  groupHeader: {
    ...sans(600),
    color: color.textDim,
    fontSize: font.tiny,
    lineHeight: 16,
    paddingHorizontal: grid(3),
    marginTop: grid(4),
    paddingVertical: grid(1.5),
    marginBottom: grid(1),
  },
  footer: {
    ...sans(400),
    color: color.textFaint,
    fontSize: 12,
    lineHeight: 16,
    paddingHorizontal: grid(3),
    paddingTop: grid(1.5),
  },
  row: {
    minHeight: 44,
    flexDirection: 'row',
    alignItems: 'center',
    gap: grid(2),
    paddingHorizontal: grid(3),
    ...separator,
  },
  rowPressed: { backgroundColor: color.surfacePressed },
  tallRow: {
    minHeight: 56,
    flexDirection: 'row',
    alignItems: 'center',
    gap: grid(2),
    paddingHorizontal: grid(3),
    paddingVertical: grid(2),
    ...separator,
  },
  rowLabel: { ...sans(400), color: color.text, fontSize: font.small },
  rowValue: {
    ...sans(400),
    color: color.textDim,
    fontSize: font.small,
    flexShrink: 1,
    marginLeft: 'auto',
    textAlign: 'right',
  },
  rowValueQuiet: { ...sans(400), color: color.textFaint, fontSize: font.tiny, flexShrink: 0 },
  rowTitle: { ...sans(400), color: color.text, fontSize: font.small, lineHeight: leading(15) },
  rowDetail: { ...sans(400), color: color.textDim, fontSize: font.tiny, lineHeight: leading(13) },
  rowWarning: { ...sans(600), color: color.dangerText, fontSize: font.tiny },
  serverRow: {
    minHeight: 56,
    flexDirection: 'row',
    alignItems: 'center',
    gap: grid(2),
    paddingHorizontal: grid(3),
    paddingVertical: grid(2),
    ...separator,
  },
  serverDetails: { flex: 1, minWidth: 0, gap: 2 },
  statusDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: color.idle },
  statusDotLive: { backgroundColor: color.working },
  renameRow: {
    minHeight: 44,
    flexDirection: 'row',
    alignItems: 'center',
    gap: grid(2),
    paddingLeft: grid(3),
    ...separator,
  },
  renameInput: {
    flex: 1,
    minHeight: 44,
    color: color.text,
    fontSize: font.small,
  },
  renameButton: { minHeight: 44, paddingHorizontal: grid(3), justifyContent: 'center' },
  tintLabel: { ...sans(400), color: color.accentTint, fontSize: font.small },
  destructiveLabel: { ...sans(400), color: color.dangerText, fontSize: font.small },
})

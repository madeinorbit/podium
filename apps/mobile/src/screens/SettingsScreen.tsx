import { relativeTime } from '@podium/client-core/focus'
import {
  devicePlatformLabel,
  formatCount,
  visibleFleetOperations,
} from '@podium/client-core/values'
import type { MobileClientSession } from '@podium/protocol'
import { useRouter } from 'expo-router'
import { observer } from 'mobx-react-lite'
import { Fragment, type ReactNode, useMemo, useState } from 'react'
import {
  Alert,
  Platform,
  ScrollView,
  type StyleProp,
  StyleSheet,
  Text,
  TextInput,
  useWindowDimensions,
  View,
  type ViewStyle,
} from 'react-native'
import { logout } from '../client/auth'
import { type ConnectedDevicesFeed, useConnectedDevices } from '../client/connected-devices'
import { DEMO_HOST_METRICS, DEMO_MACHINES, demoEnabled } from '../client/demoData'
import { useConnected, useHttpOrigin } from '../client/hooks'
import { useServerProfile } from '../client/ServerProfileGate'
import { useMobileShell } from '../client/shell'
import { Icon } from '../components/Icon'
import { InsetGroup } from '../components/InsetGroup'
import { type AppIcon, Check, ChevronRight, Info, Monitor, Plus, Trash2 } from '../components/icons'
import { OutboxRecoveryPanel } from '../components/OutboxRecoveryPanel'
import { PressableScale } from '../components/PressableScale'
import { Screen } from '../components/Screen'
import { useContentBottomInset } from '../hooks/useContentBottomInset'
import { useLayoutMargin } from '../hooks/useLayoutMargin'
import { useBuildStamp } from '../lib/build-stamp'
import { useAgeNow } from '../lib/clock-hooks'
import { appVersion } from '../lib/logging'
import { color, font, grid, leading, radius, sans } from '../theme/theme'
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

/**
 * Settings follows the Settings board: one screen of summary rows, with the
 * detail behind pushed screens in the same tab stack (Connected devices,
 * Servers, Version). Every screen reads the same settings opening; nothing
 * here adds a read.
 */
export function SettingsScreen() {
  return <SettingsHome />
}

export function SettingsDevicesScreen() {
  return <SettingsDevices />
}

export function SettingsServersScreen() {
  return <SettingsServers />
}

export function SettingsVersionScreen() {
  return <SettingsVersion />
}

/** Log out keeps the server on this phone and drops its credential; Remove also forgets the server. */
function useAccountActions() {
  const router = useRouter()
  const httpOrigin = useHttpOrigin()
  const { eraseLocalData } = useMobileShell()
  const { profile, bearer, removeProfile, updateCredential } = useServerProfile()
  const [loggedOut, setLoggedOut] = useState(false)
  const [busy, setBusy] = useState(false)

  const finishLocalLogout = async () => {
    await eraseLocalData()
    setLoggedOut(true)
    await updateCredential(null)
    if (Platform.OS === 'web') {
      if (typeof window !== 'undefined') window.location.reload()
    }
  }

  const doLogout = async () => {
    if (busy) return
    setBusy(true)
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
      setBusy(false)
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
              if (busy) return
              setBusy(true)
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
                setBusy(false)
              }
            })()
          },
        },
      ],
    )
  }

  return { doLogout, removeCurrent, loggedOut, busy }
}

function useDemoFleet() {
  const demo = demoEnabled()
  return useMemo(
    () =>
      demo ? visibleFleetOperations({ machines: DEMO_MACHINES, hosts: DEMO_HOST_METRICS }) : null,
    [demo],
  )
}

/** A pushed detail screen: inline bar with the native back button; web draws its own. */
function DetailScreen({ title, children }: { title: string; children: ReactNode }) {
  const router = useRouter()
  const bottomInset = useContentBottomInset()
  const layoutMargin = useLayoutMargin()
  const { fontScale } = useWindowDimensions()
  return (
    <Screen
      title={title}
      onBack={Platform.OS === 'web' ? () => router.back() : undefined}
      underHeader
    >
      <ScrollView
        style={styles.scroll}
        contentInsetAdjustmentBehavior="automatic"
        contentContainerStyle={[
          styles.content,
          { paddingHorizontal: layoutMargin, paddingBottom: bottomInset + grid(6) },
        ]}
      >
        <Fragment key={fontScale}>{children}</Fragment>
      </ScrollView>
    </Screen>
  )
}

function deviceCountLabel(feed: ConnectedDevicesFeed): string {
  const count = feed.sessions?.length ?? 0
  if (count > 0) return String(count)
  if (feed.loading) return '…'
  return feed.failed ? 'Unavailable' : 'None'
}

const SettingsHome = observer(function SettingsHome() {
  const router = useRouter()
  // The last row clears the tab bar on native and the home indicator on web.
  const bottomInset = useContentBottomInset()
  const { machineCount, sessionCount, issueCount } = useSettingsData()
  const httpOrigin = useHttpOrigin()
  const connected = useConnected()
  const { profile, isEphemeralOverride } = useServerProfile()
  const account = useAccountActions()
  const deviceFeed = useConnectedDevices()
  const demoFleet = useDemoFleet()

  const host = hostOf(httpOrigin)
  const machines = demoFleet?.visibleCount ?? machineCount
  // Accessibility sizes wrap the server card's status lines instead of cutting them.
  const { fontScale } = useWindowDimensions()
  const layoutMargin = useLayoutMargin()
  const serverLines = fontScale >= STACKED_ROW_SCALE ? 0 : 1
  const native = Platform.OS !== 'web'
  return (
    <Screen
      title="Settings"
      large={native}
      onBack={native ? undefined : () => router.back()}
      backAs="text"
      backLabel="Done"
    >
      <ScrollView
        style={styles.scroll}
        contentInsetAdjustmentBehavior="automatic"
        contentContainerStyle={[
          styles.content,
          { paddingHorizontal: layoutMargin, paddingBottom: bottomInset + grid(6) },
        ]}
      >
        {/* Rebuild text measurement after both text-size increases and decreases.
            Keep the ScrollView mounted so its offset and native bar survive. */}
        <Fragment key={fontScale}>
          {!native ? (
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

          <Card>
            <View style={styles.server}>
              {/* Accessibility sizes keep the full server name in a growing row. */}
              <Text
                style={styles.serverName}
                numberOfLines={serverLines}
                adjustsFontSizeToFit={serverLines === 1}
                minimumFontScale={0.5}
                lineBreakStrategyIOS="standard"
              >
                {host}
              </Text>
              <Text style={styles.serverLine} numberOfLines={serverLines}>
                <Text style={connected ? styles.liveDot : styles.offlineDot}>● </Text>
                {connected ? 'Connected' : 'Offline, showing saved data'}
                {` · ${machines} ${machines === 1 ? 'machine' : 'machines'}`}
              </Text>
              <Text
                style={styles.serverLine}
                numberOfLines={serverLines}
                accessibilityLabel="Data on this phone"
              >
                {`${formatCount(sessionCount)} sessions · ${formatCount(issueCount)} tasks`}
              </Text>
            </View>
          </Card>

          <GroupHeader label="Server" />
          <Card>
            <NavRow
              icon={Monitor}
              label="Connected devices"
              value={deviceCountLabel(deviceFeed)}
              onPress={() => router.push('/settings/devices')}
            />
            {native ? (
              <NavRow
                icon={Plus}
                label={isEphemeralOverride ? 'Servers' : 'Add server'}
                onPress={() => router.push('/settings/servers')}
              />
            ) : null}
          </Card>

          <GroupHeader label="About" />
          <Card>
            <NavRow
              icon={Info}
              label="Version"
              value={appVersion()}
              onPress={() => router.push('/settings/version')}
            />
          </Card>

          {native && !isEphemeralOverride ? (
            <>
              <Card style={styles.lastCard}>
                <PressableScale
                  style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
                  onPress={account.removeCurrent}
                  accessibilityRole="button"
                  accessibilityLabel={`Remove ${profile.name}`}
                >
                  <Icon as={Trash2} size={ROW_ICON} color={color.dangerText} />
                  <Text style={styles.destructiveLabel}>Remove this server</Text>
                </PressableScale>
              </Card>
              <Text style={styles.footer}>
                Signs this phone out of {host}. Nothing on the server is deleted.
              </Text>
            </>
          ) : !native ? (
            <Card style={styles.lastCard}>
              <LogoutRow account={account} />
            </Card>
          ) : null}
        </Fragment>
      </ScrollView>
    </Screen>
  )
})

const SettingsDevices = observer(function SettingsDevices() {
  const { profile } = useServerProfile()
  const deviceFeed = useConnectedDevices()
  const devices = deviceFeed.sessions ?? []
  return (
    <DetailScreen title="Connected devices">
      <Card>
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
      </Card>
      <Text style={styles.footer}>
        This list belongs to the signed-in account on {profile.name}. Pairing and revocation stay in
        Connected devices on the desktop.
      </Text>
    </DetailScreen>
  )
})

const SettingsServers = observer(function SettingsServers() {
  const { profile, profiles, isEphemeralOverride, beginAddServer, switchProfile, renameProfile } =
    useServerProfile()
  const connected = useConnected()
  const [profileName, setProfileName] = useState(profile.name)
  const account = useAccountActions()
  // At large sizes the name and origin wrap and the Insecure badge moves under
  // them; beside them it left "Ser…" and "http:…" at AX5.
  const stacked = useWindowDimensions().fontScale >= STACKED_ROW_SCALE
  const lines = stacked ? 0 : 1
  return (
    <DetailScreen title="Servers">
      <Card>
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
              <Text style={styles.rowTitle} numberOfLines={lines}>
                {row.name}
              </Text>
              <Text style={styles.rowDetail} numberOfLines={lines}>
                {row.id === profile.id && !connected ? 'Reconnecting · ' : ''}
                {row.userId ? `${row.httpOrigin} · ${row.userId}` : row.httpOrigin}
              </Text>
              {stacked && row.transport === 'insecure-lan' ? (
                <Text style={styles.rowWarning}>Insecure</Text>
              ) : null}
            </View>
            {!stacked && row.transport === 'insecure-lan' ? (
              <Text style={styles.rowWarning}>Insecure</Text>
            ) : null}
            {row.id === profile.id ? <Icon as={Check} size={17} color={color.accentTint} /> : null}
          </PressableScale>
        ))}
      </Card>
      {isEphemeralOverride ? (
        <Text style={styles.footer}>
          This development server override is ephemeral and cannot be edited or saved.
        </Text>
      ) : (
        <>
          <GroupHeader label="This server" />
          <Card>
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
          </Card>
        </>
      )}
      <Card style={styles.lastCard}>
        <LogoutRow account={account} />
      </Card>
      <Text style={styles.footer}>
        Log out signs this phone out and keeps {profile.name} in the list.
      </Text>
    </DetailScreen>
  )
})

const SettingsVersion = observer(function SettingsVersion() {
  const {
    machineIds,
    machineCount,
    fleetLabel,
    updateLabel,
    outboxDeadLetterCount,
    outboxSize,
    cursor,
  } = useSettingsData()
  const buildStamp = useBuildStamp()
  const demoFleet = useDemoFleet()
  const machines = demoFleet?.visibleCount ?? machineCount
  return (
    <DetailScreen title="Version">
      <Card>
        <Row label="Server build" value={buildStamp.text.replace(/\n/g, ' · ')} />
        <Row label="Queued sends" value={String(outboxSize)} />
        <Row label="Needs recovery" value={String(outboxDeadLetterCount)} />
        <Row label="Sync cursor" value={String(cursor ?? 'none')} />
      </Card>

      <GroupHeader label="Machines" />
      <Card>
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
      </Card>
      <Text style={styles.footer}>
        This phone shows status only. Fleet, network, host, and update changes stay on authorized
        desktop or server surfaces.
      </Text>
      <Text style={[styles.footer, styles.footerGap]}>
        Notifications: set an ntfy topic or a Telegram bot in the desktop app's settings to get
        pushed when an agent needs you.
      </Text>
    </DetailScreen>
  )
})

function LogoutRow({ account }: { account: ReturnType<typeof useAccountActions> }) {
  return (
    <PressableScale
      style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
      onPress={() => void account.doLogout()}
      disabled={account.busy}
      accessibilityRole="button"
      accessibilityLabel="Log out"
      // `aria-busy` beside `accessibilityState`: react-native-web 0.21 reads
      // only the former. The disabled half already reaches the browser via
      // the `disabled` prop above. [POD-1664]
      accessibilityState={{ disabled: account.busy, busy: account.busy }}
      aria-busy={account.busy}
    >
      <Text style={styles.destructiveLabel}>{account.loggedOut ? 'Logged out' : 'Log out'}</Text>
    </PressableScale>
  )
}

/** Row glyph size on the Settings board: 20pt in the label colour, 8pt before the text. */
const ROW_ICON = 20

/**
 * From the first accessibility text size the value moves under its label, as in
 * iOS Settings: side by side, a label that fills the row squeezes the value to
 * nothing. Same threshold as the Work and Tasks rows.
 */
const STACKED_ROW_SCALE = 1.6

/** A row that pushes a detail screen: glyph, label, trailing value, chevron. */
function NavRow({
  icon,
  label,
  value,
  onPress,
}: {
  icon?: AppIcon
  label: string
  value?: string
  onPress: () => void
}) {
  const { fontScale } = useWindowDimensions()
  const stacked = fontScale >= STACKED_ROW_SCALE
  const glyphScale = Math.min(fontScale, 2)
  // Decorative glyphs must not force a label's longest word into a narrow column.
  const hideRowIcon = fontScale >= 2.5
  return (
    <PressableScale
      style={({ pressed }) => [
        styles.row,
        stacked && styles.stackedRow,
        pressed && styles.rowPressed,
      ]}
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityValue={value ? { text: value } : undefined}
    >
      {icon && !hideRowIcon ? (
        <Icon as={icon} size={ROW_ICON * glyphScale} color={color.text} />
      ) : null}
      {stacked ? (
        <View style={styles.stackedText}>
          <Text style={styles.rowLabel} lineBreakStrategyIOS="standard">
            {label}
          </Text>
          {value ? <Text style={styles.stackedValue}>{value}</Text> : null}
        </View>
      ) : (
        <Text style={styles.rowLabel}>{label}</Text>
      )}
      <View style={styles.navTrail}>
        {value && !stacked ? (
          <Text style={styles.navValue} numberOfLines={1}>
            {value}
          </Text>
        ) : null}
        <Icon as={ChevronRight} size={14 * glyphScale} color={color.textFaint} />
      </View>
    </PressableScale>
  )
}

function hostOf(origin: string): string {
  try {
    return new URL(origin).host || origin
  } catch {
    return origin
  }
}

/** A grouped-list card: hairline separators between rows, inset to the text. */
function Card({ style, children }: { style?: StyleProp<ViewStyle>; children: ReactNode }) {
  return <InsetGroup style={style}>{children}</InsetGroup>
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
  const stacked = useWindowDimensions().fontScale >= STACKED_ROW_SCALE
  if (stacked) {
    return (
      <View style={[styles.row, styles.stackedRow]}>
        <View style={styles.stackedText}>
          <Text style={styles.rowLabel}>{label}</Text>
          <Text style={styles.stackedValue}>{value}</Text>
        </View>
      </View>
    )
  }
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
 * Native layout margins and inset-grouped cards, with 12pt row insets and
 * hairline separators. Section headers sit on the card's text axis.
 */
const styles = StyleSheet.create({
  scroll: { flex: 1, backgroundColor: color.groupedBg },
  content: { paddingTop: grid(2) },
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
  navTrail: {
    marginLeft: 'auto',
    flexShrink: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: grid(1),
  },
  navValue: { ...sans(400), color: color.textDim, fontSize: font.small, flexShrink: 1 },
  footerGap: { paddingTop: grid(3) },
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
  },
  rowPressed: { backgroundColor: color.surfacePressed },
  stackedRow: { paddingVertical: grid(2) },
  stackedText: { flex: 1, minWidth: 0, gap: 2 },
  stackedValue: { ...sans(400), color: color.textDim, fontSize: font.small },
  tallRow: {
    minHeight: 56,
    flexDirection: 'row',
    alignItems: 'center',
    gap: grid(2),
    paddingHorizontal: grid(3),
    paddingVertical: grid(2),
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

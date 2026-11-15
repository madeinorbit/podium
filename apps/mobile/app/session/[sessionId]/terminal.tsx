import { panelLabel, sessionTitle } from '@podium/client-core/values'
import { asSessionId, type SessionId } from '@podium/model'
import { issueDisplayRef } from '@podium/protocol'
import { useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router'
import { useCallback, useState } from 'react'
import { Platform, StyleSheet, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { useScreenReadFocus } from '../../../src/client/screen-read-focus'
import {
  useSessionContextIssue as useIssue,
  useSessionContextSession as useSession,
} from '../../../src/client/use-session-context'
import { Icon } from '../../../src/components/Icon'
import { ExternalLink, MoreVertical } from '../../../src/components/icons'
import { HeaderButton, Screen, type ScreenMenuItem } from '../../../src/components/Screen'
import {
  TerminalControlAction,
  terminalControlMenuItem,
} from '../../../src/terminal/TerminalControlAction'
import { TerminalPane } from '../../../src/terminal/TerminalPane'
import {
  type TerminalControlState,
  terminalControlCopy,
} from '../../../src/terminal/terminal-control'
import { appearancePalette, color } from '../../../src/theme/theme'

/** Native CLI for the same session and task shown by the chat view. */
export default function TerminalRoute() {
  const router = useRouter()
  const insets = useSafeAreaInsets()
  // Route params are RAW URL values, so the brand is applied once here — the
  // DECODE EDGE for this screen, mirroring SessionScreen (POD-362).
  const params = useLocalSearchParams<{ sessionId: SessionId | string[] }>()
  const raw = Array.isArray(params.sessionId) ? params.sessionId[0] : params.sessionId
  const sessionId = raw ? asSessionId(raw) : undefined
  const session = useSession(sessionId)
  const issue = useIssue(session?.issueId)
  useScreenReadFocus(issue?.id, session?.sessionId, 'native')

  const [active, setActive] = useState(true)
  useFocusEffect(
    useCallback(() => {
      setActive(true)
      return () => setActive(false)
    }, []),
  )

  // Published by the pane, which owns the mount. The header owns the ACTION —
  // a phone action belongs on the 44pt bar, not floating over the grid.
  const [control, setControl] = useState<TerminalControlState | null>(null)
  const controlCopy = control?.ready ? terminalControlCopy(control) : null
  const kindLabel = session ? panelLabel(session.agentKind) : undefined
  const openIssue = () => {
    if (issue) router.push(`/issue/${encodeURIComponent(issue.id)}`)
  }
  const menuItems: ScreenMenuItem[] = [
    ...(issue
      ? [{ label: `Open task ${issueDisplayRef(issue)}`, icon: ExternalLink, onPress: openIssue }]
      : []),
    ...(control?.ready ? [terminalControlMenuItem(control)] : []),
  ]

  return (
    <Screen
      title={session ? sessionTitle(session) : 'Session'}
      subtitle={controlCopy && kindLabel ? `${kindLabel} · ${controlCopy.status}` : kindLabel}
      onBack={() => router.back()}
      backButtonDisplayMode="default"
      // UIKit owns the title, subtitle, back label and pull-down menu. There
      // is no context strip below the bar. Screen pays its measured inset
      // once, since the terminal's fixed webview cannot scroll under it.
      actions={
        Platform.OS === 'ios' && menuItems.length
          ? [{ label: 'Console actions', icon: MoreVertical, items: menuItems }]
          : undefined
      }
      right={
        Platform.OS !== 'ios' ? (
          <>
            {issue ? (
              <HeaderButton label={`Open task ${issueDisplayRef(issue)}`} onPress={openIssue}>
                <Icon as={ExternalLink} size={17} color={color.textDim} />
              </HeaderButton>
            ) : null}
            {control?.ready ? <TerminalControlAction control={control} /> : null}
          </>
        ) : undefined
      }
    >
      <View testID="console-ground" style={[styles.pane, { paddingBottom: insets.bottom }]}>
        {sessionId ? (
          <TerminalPane
            sessionId={sessionId}
            active={active}
            onOpenIssue={(issueId) => router.push(`/issue/${encodeURIComponent(issueId)}`)}
            onControlState={setControl}
          />
        ) : null}
      </View>
    </Screen>
  )
}

const styles = StyleSheet.create({
  pane: {
    flex: 1,
    // The terminal DOM page stays dark in either system appearance. Its
    // container owns the home-indicator inset so it cannot expose white paper.
    backgroundColor: appearancePalette.dark.bg,
  },
})

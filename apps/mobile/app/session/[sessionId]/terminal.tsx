import { panelLabel, sessionDotTone, sessionTitle } from '@podium/client-core/viewmodels'
import { asSessionId, type SessionId } from '@podium/model'
import { issueDisplayRef } from '@podium/protocol'
import { useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router'
import { useCallback, useState } from 'react'
import { StyleSheet, View } from 'react-native'
import { useIssue, useSession } from '../../../src/client/hooks'
import { IdSquare } from '../../../src/components/IdSquare'
import { PressableScale } from '../../../src/components/PressableScale'
import { Screen } from '../../../src/components/Screen'
import { TerminalControlAction } from '../../../src/terminal/TerminalControlAction'
import { TerminalPane } from '../../../src/terminal/TerminalPane'
import {
  type TerminalControlState,
  terminalControlCopy,
} from '../../../src/terminal/terminal-control'
import { FLOW_HEX, flow, issueColorHex } from '../../../src/theme/issueColors'
import { color } from '../../../src/theme/theme'

/**
 * The native-CLI view of a session.
 *
 * IT IS THE SAME TASK AS THE CHAT, SO IT MUST LOOK LIKE IT (POD-724). This
 * screen used to render `<Screen title="Session">` over a grey pane while the
 * chat view of the SAME session wore the issue colour, the ID square, and the
 * session's real name. Two views of one piece of work wearing two identities is
 * how an operator loses their place — so identity is resolved here exactly as
 * SessionScreen resolves it, from the same hooks and the same colour flow.
 */
export default function TerminalRoute() {
  const router = useRouter()
  // Route params are RAW URL values, so the brand is applied once here — the
  // DECODE EDGE for this screen, mirroring SessionScreen (POD-362).
  const params = useLocalSearchParams<{ sessionId: SessionId | string[] }>()
  const raw = Array.isArray(params.sessionId) ? params.sessionId[0] : params.sessionId
  const sessionId = raw ? asSessionId(raw) : undefined
  const session = useSession(sessionId)
  const issue = useIssue(session?.issueId)
  // The issue colour flows through the chrome; slate when the issue is
  // uncoloured, nothing at all when the session carries no task.
  const accent = issue ? (issueColorHex(issue.color) ?? FLOW_HEX) : undefined

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
  const controlCopy = control ? terminalControlCopy(control.role) : null
  const kindLabel = session ? panelLabel(session.agentKind) : undefined

  return (
    <Screen
      title={session ? sessionTitle(session) : 'Session'}
      subtitle={controlCopy && kindLabel ? `${kindLabel} · ${controlCopy.status}` : kindLabel}
      onBack={() => router.back()}
      backLabel="Chat"
      accent={accent}
      safeBottom
      leading={
        issue && session ? (
          <PressableScale
            accessibilityRole="button"
            accessibilityLabel={`Task ${issueDisplayRef(issue)} — open`}
            onPress={() => router.push(`/issue/${encodeURIComponent(issue.id)}`)}
            hitSlop={8}
          >
            <IdSquare
              issue={issue}
              state={
                issue.needsHuman || sessionDotTone(session) === 'attention' ? 'waiting' : 'working'
              }
              size={18}
            />
          </PressableScale>
        ) : undefined
      }
      // Offered only once the mount is attached: a control request before the
      // attach lands has nothing to claim, and a dead tap is worse than no tap.
      right={control?.ready ? <TerminalControlAction control={control} /> : undefined}
    >
      <View style={[styles.pane, accent ? { backgroundColor: flow.paneBg(accent) } : null]}>
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
    // The terminal paints its own dark canvas, so this shows only in the crop
    // gutters around the server grid — exactly where the task tint belongs,
    // which is why `accent` overrides it above.
    backgroundColor: color.bgSunken,
  },
})

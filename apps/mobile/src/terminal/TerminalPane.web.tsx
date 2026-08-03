import type { SessionId } from '@podium/model'
import { MobileTerminalKeyboard, useTerminalSession } from '@podium/terminal-client-react'
import { Mic } from 'lucide-react-native'
import { Text, View } from 'react-native'
import { useConnected, useHub, useSpawnPending } from '../client/hooks'
import { Icon } from '../components/Icon'
import { color, font, mono } from '../theme/theme'

// This accessory intentionally retains the pre-redesign mobile-web palette.
// Parity includes its contrast hierarchy, not only its controls and gestures.
const LEGACY_MOBILE_KEYBOARD_THEME = {
  bar: '#08080c',
  card: '#16161c',
  border: '#2a2a34',
  secondary: '#25252f',
  hairlineSoft: '#25252f',
  hairlineBar: '#2e2e38',
  muted: '#9a9aa8',
  accent: '#f59e0b',
  onAccent: '#161006',
  danger: '#f87171',
  fontFamily: 'GeistMono_400Regular, ui-monospace, Menlo, monospace',
} as const

/**
 * Mobile default appearance for the native agent view [POD-131]: a much
 * smaller mono size than the desktop default (13px) so agent TUI frames fit a
 * phone width crisply on retina screens. Applied via the terminal-client
 * appearance channel — the same one the web's terminal themability settings
 * use — so a future mobile settings surface can override it live.
 */
const MOBILE_APPEARANCE = {
  fontSize: 10,
  // Expo registers this exact static-face name. The shared desktop stack starts
  // with `Geist Mono Variable`, which this bundle does not ship; leaving it in
  // place made xterm measure/rasterize a browser fallback instead.
  fontFamily: 'GeistMono_400Regular, ui-monospace, Menlo, monospace',
  lineHeight: 1.12,
} as const

export function TerminalPane({ sessionId, active }: { sessionId: SessionId; active: boolean }) {
  const hub = useHub()
  const connected = useConnected()
  // HOLD THE MOUNT UNTIL THE SPAWN IS CONFIRMED (POD-1613). The create path
  // lands here with an OPTIMISTIC session: the row is painted, so the screen
  // renders, but the server has not created the session and there is no PTY to
  // bind. `hub.attach` gets exactly one shot — it sends its frame at connection
  // construction and re-sends only across a socket reconnect — so attaching now
  // spends it on a frame the server drops, and nothing ever retries. The ready
  // backstop then hides "Attaching terminal…" over a grid that stays empty
  // forever, which is precisely what the operator saw. Leaving the screen
  // disposed the mount (`hub.detach`) and coming back built a fresh connection
  // whose attach finally landed — the "go to work and back and it's there".
  // Flipping this false→true remounts, so the attach that runs is the one with
  // a live PTY behind it. Same gate the desktop spends as `spawnConfirmed`.
  const spawnPending = useSpawnPending(sessionId)
  const { containerRef, toolbarRef, mountedRef, ready } = useTerminalSession({
    hub,
    sessionId,
    enabled: connected && !spawnPending,
    // Match the desktop AgentPanel lifecycle exactly: stay mounted while hidden,
    // flip eligibility on the live session, and focus only after reveal/attach.
    // This is what drives the shared reveal -> fit -> WebGL recovery sequence.
    active,
    focusOnMount: false,
    focusWhenReady: true,
    appearance: MOBILE_APPEARANCE,
    test: new URLSearchParams(window.location.search).get('e2e') === '1',
  })

  return (
    <View style={{ flex: 1, minHeight: 0, overflow: 'hidden' }}>
      {!connected ? <Text style={statusStyle}>Connecting terminal…</Text> : null}
      {/* Three waits, three sentences. "Attaching" while the spawn is still
          pending would name a step that has not begun — the create path waits
          on the SERVER, not on the socket. */}
      {connected && spawnPending ? <Text style={statusStyle}>Starting agent…</Text> : null}
      {connected && !spawnPending && !ready ? (
        <Text style={statusStyle}>Attaching terminal…</Text>
      ) : null}
      {/* `minHeight: 0` (the desktop AgentPanel's `min-h-0`) lets this flex child
          SHRINK to the viewport. The old `minHeight: 260` floor meant a short
          phone screen could not contain the pane and the agent frame ran off the
          bottom of the screen (POD-338). `overflow: hidden` keeps a mid-resize
          xterm frame from spilling either. */}
      <div
        ref={containerRef}
        style={{ flex: 1, minHeight: 0, width: '100%', overflow: 'hidden' }}
      />
      <MobileTerminalKeyboard
        mountedRef={mountedRef}
        toolbarRef={toolbarRef}
        ready={ready}
        voiceIcon={<Icon as={Mic} size={16} color={color.textDim} />}
        theme={LEGACY_MOBILE_KEYBOARD_THEME}
      />
    </View>
  )
}

const statusStyle = {
  ...mono(400),
  color: color.textDim,
  fontSize: font.small,
  padding: 12,
} as const

import { MobileTerminalKeyboard, useTerminalSession } from '@podium/terminal-client-react'
import { Mic } from 'lucide-react-native'
import { Text, View } from 'react-native'
import { useMobileClient } from '../client/MobileClientProvider'
import { Icon } from '../components/Icon'
import { color, font, mono } from '../theme/theme'

/**
 * Mobile default appearance for the native agent view [POD-131]: a much
 * smaller mono size than the desktop default (13px) so agent TUI frames fit a
 * phone width crisply on retina screens. Applied via the terminal-client
 * appearance channel — the same one the web's terminal themability settings
 * use — so a future mobile settings surface can override it live.
 */
const MOBILE_APPEARANCE = {
  fontSize: 10,
  lineHeight: 1.12,
} as const

export function TerminalPane({ sessionId }: { sessionId: string }) {
  const client = useMobileClient()
  const { containerRef, toolbarRef, mountedRef, ready } = useTerminalSession({
    hub: client.hub,
    sessionId,
    enabled: client.connected,
    focusOnMount: true,
    appearance: MOBILE_APPEARANCE,
    test: new URLSearchParams(window.location.search).get('e2e') === '1',
  })

  return (
    <View style={{ flex: 1, minHeight: 0, overflow: 'hidden' }}>
      {!client.connected ? <Text style={statusStyle}>Connecting terminal…</Text> : null}
      {client.connected && !ready ? <Text style={statusStyle}>Attaching terminal…</Text> : null}
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
        theme={{
          bar: color.bar,
          card: color.card,
          border: color.hairlineBar,
          muted: color.textDim,
          accent: color.accent,
          onAccent: color.onAccent,
          danger: color.danger,
          fontFamily: 'GeistMono_400Regular, ui-monospace, Menlo, monospace',
        }}
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

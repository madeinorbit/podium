import { useSocketHub, useTerminalSession } from '@podium/terminal-client-react'
import { useMemo } from 'react'
import { Text, View } from 'react-native'
import { readServerConfig } from '../client/trpc'
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
  const config = useMemo(readServerConfig, [])
  const { hub, connected } = useSocketHub({
    url: config.wsClientUrl,
    viewport: { cols: 80, rows: 24, dpr: window.devicePixelRatio || 1 },
  })
  // Only attach once the hub has actually connected — mountSession attaches
  // synchronously on mount, so gating on `connected` avoids attaching against a
  // socket that isn't open yet.
  const { containerRef, ready } = useTerminalSession({
    hub,
    sessionId,
    enabled: connected,
    focusOnMount: true,
    appearance: MOBILE_APPEARANCE,
  })

  return (
    <View style={{ flex: 1, minHeight: 0, overflow: 'hidden' }}>
      {!connected ? <Text style={statusStyle}>Connecting terminal…</Text> : null}
      {connected && !ready ? <Text style={statusStyle}>Attaching terminal…</Text> : null}
      {/* `minHeight: 0` (the desktop AgentPanel's `min-h-0`) lets this flex child
          SHRINK to the viewport. The old `minHeight: 260` floor meant a short
          phone screen could not contain the pane and the agent frame ran off the
          bottom of the screen (POD-338). `overflow: hidden` keeps a mid-resize
          xterm frame from spilling either. */}
      <div
        ref={containerRef}
        style={{ flex: 1, minHeight: 0, width: '100%', overflow: 'hidden' }}
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

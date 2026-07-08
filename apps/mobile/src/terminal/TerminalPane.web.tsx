import { useSocketHub, useTerminalSession } from '@podium/terminal-client-react'
import { useMemo } from 'react'
import { Text, View } from 'react-native'
import { readServerConfig } from '../client/trpc'

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
  })

  return (
    <View style={{ flex: 1 }}>
      {!connected ? (
        <Text style={{ color: '#94a3b8', padding: 12 }}>Connecting terminal...</Text>
      ) : null}
      {connected && !ready ? (
        <Text style={{ color: '#94a3b8', padding: 12 }}>Attaching terminal...</Text>
      ) : null}
      <div
        ref={containerRef}
        style={{ flex: 1, minHeight: 420, height: 'calc(100vh - 92px)', width: '100%' }}
      />
    </View>
  )
}

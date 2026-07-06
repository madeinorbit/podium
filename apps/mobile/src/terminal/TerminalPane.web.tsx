import { SocketHub } from '@podium/terminal-client/connection'
import { mountSession, type MountedSession } from '@podium/terminal-client/session-mount'
import { useEffect, useMemo, useRef, useState } from 'react'
import { Text, View } from 'react-native'
import { readServerConfig } from '../client/trpc'

export function TerminalPane({ sessionId }: { sessionId: string }) {
  const el = useRef<HTMLDivElement | null>(null)
  const mounted = useRef<MountedSession | null>(null)
  const [ready, setReady] = useState(false)
  const [connected, setConnected] = useState(false)
  const config = useMemo(readServerConfig, [])
  const hub = useMemo(
    () =>
      new SocketHub({
        url: config.wsClientUrl,
        viewport: { cols: 80, rows: 24, dpr: window.devicePixelRatio || 1 },
      }),
    [config.wsClientUrl],
  )

  useEffect(() => {
    hub.connect()
    const tick = () => setConnected(hub.connected)
    tick()
    const timer = window.setInterval(tick, 100)
    return () => {
      window.clearInterval(timer)
      hub.dispose()
    }
  }, [hub])

  useEffect(() => {
    if (!connected || !el.current) return
    setReady(false)
    mounted.current = mountSession(el.current, {
      hub,
      sessionId,
      active: true,
      focusOnMount: true,
      onReady: () => setReady(true),
    })
    return () => {
      mounted.current?.dispose()
      mounted.current = null
    }
  }, [connected, hub, sessionId])

  return (
    <View style={{ flex: 1 }}>
      {!connected ? <Text style={{ color: '#94a3b8', padding: 12 }}>Connecting terminal...</Text> : null}
      {connected && !ready ? <Text style={{ color: '#94a3b8', padding: 12 }}>Attaching terminal...</Text> : null}
      <div ref={el} style={{ flex: 1, minHeight: 420, height: 'calc(100vh - 92px)', width: '100%' }} />
    </View>
  )
}

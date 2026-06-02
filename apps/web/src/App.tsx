import { type ConnectionState, type MountedSession, mountSession } from '@podium/terminal-client'
import { useEffect, useRef, useState } from 'react'

export function App(): JSX.Element {
  const termRef = useRef<HTMLDivElement>(null)
  const barRef = useRef<HTMLDivElement>(null)
  const sessionRef = useRef<MountedSession | null>(null)
  const [st, setSt] = useState<{ connected: boolean; role: string; cols: number; rows: number }>({
    connected: false,
    role: 'spectator',
    cols: 0,
    rows: 0,
  })

  useEffect(() => {
    const term = termRef.current
    const bar = barRef.current
    if (!term || !bar) return
    const params = new URLSearchParams(globalThis.location.search)
    const server = params.get('server') ?? `ws://${globalThis.location.hostname}:8787`
    const session = mountSession(term, {
      url: `${server}/client`,
      toolbarEl: bar,
      test: params.get('test') === '1',
      onState: (s: ConnectionState) =>
        setSt({ connected: s.connected, role: s.role, cols: s.cols, rows: s.rows }),
    })
    sessionRef.current = session
    return () => {
      session.dispose()
      sessionRef.current = null
    }
  }, [])

  return (
    <div>
      <div id="topbar">
        <button
          type="button"
          data-action="take-control"
          onClick={() => sessionRef.current?.connection.requestControl()}
        >
          Take control
        </button>
        <span id="status">
          {st.connected ? `● ${st.role} ${st.cols}×${st.rows}` : '○ disconnected'}
        </span>
      </div>
      <div id="term" ref={termRef} />
      <div id="toolbar" ref={barRef} />
    </div>
  )
}

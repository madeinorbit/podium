import {
  type ConnectionState,
  ctrlSequence,
  keySequence,
  type MountedSession,
  mountSession,
} from '@podium/terminal-client'
import { useEffect, useRef, useState } from 'react'

// Key toolbar definition: order matters per spec
// Esc, Ctrl-C, Tab, ↑, ↓, ←, →, Enter
const TOOLBAR_KEYS = [
  {
    label: 'Esc',
    dataKey: 'Escape',
    send: (s: MountedSession) => s.connection.sendInput(keySequence('Escape')),
  },
  {
    label: 'Ctrl-C',
    dataKey: 'Ctrl-C',
    send: (s: MountedSession) => s.connection.sendInput(ctrlSequence('c')),
  },
  {
    label: 'Tab',
    dataKey: 'Tab',
    send: (s: MountedSession) => s.connection.sendInput(keySequence('Tab')),
  },
  {
    label: '↑',
    dataKey: 'ArrowUp',
    send: (s: MountedSession) => s.connection.sendInput(keySequence('ArrowUp')),
  },
  {
    label: '↓',
    dataKey: 'ArrowDown',
    send: (s: MountedSession) => s.connection.sendInput(keySequence('ArrowDown')),
  },
  {
    label: '←',
    dataKey: 'ArrowLeft',
    send: (s: MountedSession) => s.connection.sendInput(keySequence('ArrowLeft')),
  },
  {
    label: '→',
    dataKey: 'ArrowRight',
    send: (s: MountedSession) => s.connection.sendInput(keySequence('ArrowRight')),
  },
  {
    label: 'Enter',
    dataKey: 'Enter',
    send: (s: MountedSession) => s.connection.sendInput(keySequence('Enter')),
  },
] as const

export function App(): JSX.Element {
  const termRef = useRef<HTMLDivElement>(null)
  const appRef = useRef<HTMLDivElement>(null)
  const sessionRef = useRef<MountedSession | null>(null)
  const [st, setSt] = useState<{ connected: boolean; role: string; cols: number; rows: number }>({
    connected: false,
    role: 'spectator',
    cols: 0,
    rows: 0,
  })

  // Mount the terminal session
  useEffect(() => {
    const term = termRef.current
    if (!term) return
    const params = new URLSearchParams(globalThis.location.search)
    const server = params.get('server') ?? `ws://${globalThis.location.hostname}:8787`
    const session = mountSession(term, {
      url: `${server}/client`,
      // no toolbarEl — we render the toolbar ourselves in React
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

  // Track visual viewport so content floats above the soft keyboard
  useEffect(() => {
    const app = appRef.current
    if (!app) return

    function updateLayout() {
      if (!app) return
      const vv = globalThis.visualViewport
      if (vv) {
        app.style.height = `${vv.height}px`
        app.style.transform = `translateY(${vv.offsetTop}px)`
      } else {
        app.style.height = `${globalThis.innerHeight}px`
        app.style.transform = 'translateY(0px)'
      }
    }

    updateLayout()

    const vv = globalThis.visualViewport
    if (vv) {
      vv.addEventListener('resize', updateLayout)
      vv.addEventListener('scroll', updateLayout)
    }
    globalThis.addEventListener('resize', updateLayout)

    return () => {
      if (vv) {
        vv.removeEventListener('resize', updateLayout)
        vv.removeEventListener('scroll', updateLayout)
      }
      globalThis.removeEventListener('resize', updateLayout)
    }
  }, [])

  return (
    <div id="app" ref={appRef}>
      {/* HUD — always visible floating overlay top-right */}
      <div id="hud">
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
      {/* Terminal — flex:1 so it fills all available space; xterm manages its own focus/keyboard */}
      {/* biome-ignore lint/a11y/noStaticElementInteractions: xterm handles keyboard internally */}
      {/* biome-ignore lint/a11y/useKeyWithClickEvents: xterm handles keyboard internally */}
      <div id="term" ref={termRef} onClick={() => sessionRef.current?.view.focus()} />
      {/* Mobile key toolbar — CSS hides this on desktop (pointer:fine) */}
      <div id="toolbar">
        {TOOLBAR_KEYS.map((k) => (
          <button
            key={k.dataKey}
            type="button"
            data-key={k.dataKey}
            onClick={() => {
              const s = sessionRef.current
              if (s) k.send(s)
            }}
          >
            {k.label}
          </button>
        ))}
      </div>
    </div>
  )
}

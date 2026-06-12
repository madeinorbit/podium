import { type MountedSession, mountSession } from '@podium/terminal-client'
import { MessageSquareText, Moon, Terminal as TerminalIcon } from 'lucide-react'
import type { JSX } from 'react'
import { useEffect, useRef, useState } from 'react'
import { ChatView } from './ChatView'
import { useStore } from './store'
import { WorkerLabel } from './WorkerLabel'

// Opt-in browser-test hook: `?e2e=1` exposes `globalThis.__podium` on the mounted
// session (screenText/sendInput/simulateKeyboard/…) for the Playwright harness under
// tests/e2e/browser. Off by default, so normal sessions never expose the input API.
const E2E = typeof window !== 'undefined' && new URLSearchParams(window.location.search).has('e2e')

type PanelMode = 'native' | 'chat'
const MODE_KEY = 'podium.panelMode'

/**
 * Per-device default: chat reads best on a phone (native terminals reflow
 * painfully there); the real PTY is the desktop default. A user toggle
 * overrides and sticks for the device.
 */
function initialMode(): PanelMode {
  const saved = localStorage.getItem(MODE_KEY)
  if (saved === 'native' || saved === 'chat') return saved
  return window.matchMedia('(max-width: 768px)').matches ? 'chat' : 'native'
}

export function AgentPanel({ sessionId }: { sessionId: string }): JSX.Element {
  const { hub, sessions } = useStore()
  const session = sessions.find((s) => s.sessionId === sessionId)
  const termRef = useRef<HTMLDivElement | null>(null)
  const toolbarRef = useRef<HTMLDivElement | null>(null)
  const mountedRef = useRef<MountedSession | null>(null)
  const [role, setRole] = useState('detached')
  // Chat exists only where a structured transcript does (claude-code today).
  const chatCapable = session?.agentKind === 'claude-code'
  const [mode, setMode] = useState<PanelMode>(() => (chatCapable ? initialMode() : 'native'))
  const effectiveMode: PanelMode = chatCapable ? mode : 'native'

  const pickMode = (m: PanelMode) => {
    setMode(m)
    localStorage.setItem(MODE_KEY, m)
  }

  const hibernated = session?.status === 'hibernated'

  useEffect(() => {
    if (effectiveMode !== 'native' || hibernated) return
    if (!termRef.current) return
    const mounted = mountSession(termRef.current, {
      hub,
      sessionId,
      ...(toolbarRef.current ? { toolbarEl: toolbarRef.current } : {}),
      ...(E2E ? { test: true } : {}),
      onState: (s) => setRole(`${s.role} ${s.cols}x${s.rows}`),
    })
    mountedRef.current = mounted
    return () => {
      mounted.dispose()
      mountedRef.current = null
    }
  }, [hub, sessionId, effectiveMode, hibernated])

  return (
    <div className="agent-panel">
      <div className="agent-panel-bar">
        {session && <WorkerLabel session={session} />}
        {effectiveMode === 'native' && <span className="state">{role}</span>}
        {chatCapable && (
          <span className="panel-mode" role="group" aria-label="Panel view">
            <button
              type="button"
              className={effectiveMode === 'chat' ? 'active' : ''}
              title="Chat view"
              onClick={() => pickMode('chat')}
            >
              <MessageSquareText size={13} aria-hidden="true" />
            </button>
            <button
              type="button"
              className={effectiveMode === 'native' ? 'active' : ''}
              title="Native terminal"
              onClick={() => pickMode('native')}
            >
              <TerminalIcon size={13} aria-hidden="true" />
            </button>
          </span>
        )}
        {effectiveMode === 'native' && (
          <button type="button" onClick={() => mountedRef.current?.connection.requestControl()}>
            Take control
          </button>
        )}
      </div>
      {hibernated ? (
        <HibernatedPane sessionId={sessionId} />
      ) : effectiveMode === 'chat' ? (
        <ChatView sessionId={sessionId} />
      ) : (
        <>
          <div ref={termRef} className="term" />
          <div ref={toolbarRef} className="toolbar" />
        </>
      )}
    </div>
  )
}

/** Firefox-snoozed-tab moment: the process is parked, one click wakes it. */
function HibernatedPane({ sessionId }: { sessionId: string }): JSX.Element {
  const { resurrectSession } = useStore()
  const [waking, setWaking] = useState(false)
  return (
    <div className="hibernated-pane">
      <Moon size={28} aria-hidden="true" />
      <p>
        This session is hibernated — its process was stopped to free memory, but the conversation is
        intact.
      </p>
      <button
        type="button"
        disabled={waking}
        onClick={() => {
          setWaking(true)
          void resurrectSession(sessionId)
        }}
      >
        {waking ? 'Waking…' : 'Resume session'}
      </button>
    </div>
  )
}

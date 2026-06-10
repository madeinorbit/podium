import { type MountedSession, mountSession } from '@podium/terminal-client'
import type { JSX } from 'react'
import { useEffect, useRef, useState } from 'react'
import { useStore } from './store'
import { WorkerLabel } from './WorkerLabel'

// Opt-in browser-test hook: `?e2e=1` exposes `globalThis.__podium` on the mounted
// session (screenText/sendInput/simulateKeyboard/…) for the Playwright harness under
// tests/e2e/browser. Off by default, so normal sessions never expose the input API.
const E2E = typeof window !== 'undefined' && new URLSearchParams(window.location.search).has('e2e')

export function AgentPanel({ sessionId }: { sessionId: string }): JSX.Element {
  const { hub, sessions } = useStore()
  const session = sessions.find((s) => s.sessionId === sessionId)
  const termRef = useRef<HTMLDivElement | null>(null)
  const toolbarRef = useRef<HTMLDivElement | null>(null)
  const mountedRef = useRef<MountedSession | null>(null)
  const [role, setRole] = useState('detached')

  useEffect(() => {
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
  }, [hub, sessionId])

  return (
    <div className="agent-panel">
      <div className="agent-panel-bar">
        {session && <WorkerLabel session={session} />}
        <span className="state">{role}</span>
        <button type="button" onClick={() => mountedRef.current?.connection.requestControl()}>
          Take control
        </button>
      </div>
      <div ref={termRef} className="term" />
      <div ref={toolbarRef} className="toolbar" />
    </div>
  )
}

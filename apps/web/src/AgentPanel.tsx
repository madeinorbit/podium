import { type MountedSession, mountSession } from '@podium/terminal-client'
import { MessageSquareText, Mic, Moon, RotateCcw, Terminal as TerminalIcon } from 'lucide-react'
import type { JSX } from 'react'
import { useEffect, useRef, useState } from 'react'
import { ChatView } from './ChatView'
import { useStore } from './store'
import { useVoiceInput } from './voice'
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
  // The e2e harness drives the real terminal substrate — its test API lives on
  // the mounted xterm session, so chat-by-default would hide it.
  if (E2E) return 'native'
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
  const exited = session?.status === 'exited'
  // Native-mode dictation: transcribed speech types straight into the PTY as
  // keystrokes — no auto-submit, so the user can edit before hitting Enter.
  const voice = useVoiceInput((text) => mountedRef.current?.connection.sendInput(`${text} `))

  useEffect(() => {
    if (effectiveMode !== 'native' || hibernated || exited) return
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
  }, [hub, sessionId, effectiveMode, hibernated, exited])

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
        {effectiveMode === 'native' && !hibernated && voice.supported && (
          <button
            type="button"
            className={voice.listening ? 'panel-mic active' : 'panel-mic'}
            title={voice.listening ? 'Stop voice input' : 'Voice input — speaks into the terminal'}
            onClick={voice.toggle}
          >
            <Mic size={13} aria-hidden="true" />
          </button>
        )}
        {effectiveMode === 'native' && (
          <button type="button" onClick={() => mountedRef.current?.connection.requestControl()}>
            Take control
          </button>
        )}
      </div>
      {hibernated ? (
        <HibernatedPane sessionId={sessionId} />
      ) : exited && session ? (
        <ExitedPane
          sessionId={sessionId}
          exitCode={session.exitCode}
          resumable={session.resumable === true}
        />
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

/**
 * The process is gone but the row survived (crash, external kill, or plain
 * exit). Dead-end panels are forbidden: say what happened and offer the way
 * back — resume when the agent left a conversation ref, remove otherwise.
 */
function ExitedPane({
  sessionId,
  exitCode,
  resumable,
}: {
  sessionId: string
  exitCode: number | undefined
  resumable: boolean
}): JSX.Element {
  const { resurrectSession, killSession } = useStore()
  const [waking, setWaking] = useState(false)
  // Exit code 0 can still be an external kill of the durable host (the PTY
  // reports the attach client's exit, not the agent's) — stay neutral about why.
  const detail =
    exitCode === undefined || exitCode === 0
      ? 'The agent process is no longer running.'
      : exitCode === -1
        ? 'The agent process failed to start.'
        : `The agent process exited with code ${exitCode}.`
  return (
    <div className="hibernated-pane exited-pane">
      <RotateCcw size={28} aria-hidden="true" />
      <p>
        {detail}{' '}
        {resumable
          ? 'The conversation is intact — resume to pick up where it left off.'
          : 'It left no conversation to resume.'}
      </p>
      {resumable ? (
        <button
          type="button"
          disabled={waking}
          onClick={() => {
            setWaking(true)
            void resurrectSession(sessionId)
          }}
        >
          {waking ? 'Resuming…' : 'Resume session'}
        </button>
      ) : (
        <button type="button" onClick={() => void killSession(sessionId)}>
          Remove session
        </button>
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

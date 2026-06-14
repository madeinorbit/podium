import { type MountedSession, mountSession } from '@podium/terminal-client'
import { MessageSquareText, Mic, Moon, RotateCcw, Terminal as TerminalIcon } from 'lucide-react'
import type { JSX } from 'react'
import { useEffect, useRef, useState } from 'react'
import { ChatView } from './ChatView'
import { panelLabel } from './derive'
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
  // Chat exists where a structured transcript does. Prefer the server's
  // observed signal (lights up any future transcript provider with no edit
  // here); fall back to the kind so claude offers chat immediately, before its
  // first transcript frame arrives.
  const chatCapable = session?.transcriptAvailable ?? session?.agentKind === 'claude-code'
  const [mode, setMode] = useState<PanelMode>(() => (chatCapable ? initialMode() : 'native'))
  const effectiveMode: PanelMode = chatCapable ? mode : 'native'

  const pickMode = (m: PanelMode) => {
    setMode(m)
    localStorage.setItem(MODE_KEY, m)
  }

  const hibernated = session?.status === 'hibernated'
  const exited = session?.status === 'exited'
  // Empty is never good: hold a "Starting…" overlay over the terminal until the
  // first real PTY frame lands, so a slow-starting (or wedged) agent reads as
  // booting rather than a blank panel. A healthy session clears it instantly —
  // the server replays its buffer on attach.
  const [hasOutput, setHasOutput] = useState(false)
  // Native-mode dictation: transcribed speech types straight into the PTY as
  // keystrokes — no auto-submit, so the user can edit before hitting Enter.
  const voice = useVoiceInput((text) => mountedRef.current?.connection.sendInput(`${text} `))

  useEffect(() => {
    if (effectiveMode !== 'native' || hibernated || exited) return
    if (!termRef.current) return
    setHasOutput(false)
    const mounted = mountSession(termRef.current, {
      hub,
      sessionId,
      ...(toolbarRef.current ? { toolbarEl: toolbarRef.current } : {}),
      ...(E2E ? { test: true } : {}),
      onState: (s) => setRole(`${s.role} ${s.cols}x${s.rows}`),
      onFirstFrame: () => setHasOutput(true),
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
          isShell={session.agentKind === 'shell'}
          resumable={session.resumable === true}
        />
      ) : effectiveMode === 'chat' ? (
        <ChatView sessionId={sessionId} />
      ) : (
        <>
          <div className="term-wrap">
            <div ref={termRef} className="term" />
            {!hasOutput && (
              <div className="term-loading" role="status" aria-live="polite">
                <span className="spinner" aria-hidden="true" />
                <span>Starting {session ? panelLabel(session.agentKind) : 'session'}…</span>
              </div>
            )}
          </div>
          <div ref={toolbarRef} className="toolbar" />
        </>
      )}
    </div>
  )
}

/**
 * The process is gone but the row survived (crash, external kill, or plain
 * exit). Dead-end panels are forbidden: say what happened and offer the way
 * back — a shell restarts fresh in its directory (nothing to lose), an agent
 * resumes its conversation when it left a ref, and Remove covers the rest.
 */
function ExitedPane({
  sessionId,
  exitCode,
  isShell,
  resumable,
}: {
  sessionId: string
  exitCode: number | undefined
  isShell: boolean
  resumable: boolean
}): JSX.Element {
  const { resurrectSession, killSession } = useStore()
  const [waking, setWaking] = useState(false)
  const what = isShell ? 'shell' : 'agent process'
  // Exit code 0 can still be an external kill of the durable host (the PTY
  // reports the attach client's exit, not the agent's) — stay neutral about why.
  const detail =
    exitCode === undefined || exitCode === 0
      ? `The ${what} is no longer running.`
      : exitCode === -1
        ? `The ${what} failed to start.`
        : `The ${what} exited with code ${exitCode}.`
  const recoverable = isShell || resumable
  const restart = () => {
    setWaking(true)
    void resurrectSession(sessionId)
  }
  return (
    <div className="hibernated-pane exited-pane">
      <RotateCcw size={28} aria-hidden="true" />
      <p>
        {detail}{' '}
        {isShell
          ? 'Restart opens a fresh shell in the same directory.'
          : resumable
            ? 'The conversation is intact — resume to pick up where it left off.'
            : 'It left no conversation to resume.'}
      </p>
      {recoverable ? (
        <button type="button" disabled={waking} onClick={restart}>
          {waking
            ? isShell
              ? 'Restarting…'
              : 'Resuming…'
            : isShell
              ? 'Restart shell'
              : 'Resume session'}
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

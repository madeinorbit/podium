import {
  keySequence,
  type MountedSession,
  mountSession,
  type SpecialKey,
} from '@podium/terminal-client'
import {
  Archive,
  ArrowDownToLine,
  MessageSquareText,
  Mic,
  Moon,
  RotateCcw,
  Terminal as TerminalIcon,
} from 'lucide-react'
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

export function AgentPanel({
  sessionId,
  active = true,
}: {
  sessionId: string
  /** False when this panel is mounted but hidden (an inactive tab kept warm so
   *  switching back catches up instead of wiping). Gates focus, nothing else. */
  active?: boolean
}): JSX.Element {
  const { hub, sessions, archiveSession } = useStore()
  const session = sessions.find((s) => s.sessionId === sessionId)
  const termRef = useRef<HTMLDivElement | null>(null)
  const toolbarRef = useRef<HTMLDivElement | null>(null)
  const mountedRef = useRef<MountedSession | null>(null)
  // Chat exists where a structured transcript does. Prefer the server's
  // observed signal (lights up any future transcript provider with no edit
  // here); fall back to known transcript harnesses so chat is offered
  // immediately, before the first transcript frame arrives.
  const chatCapable =
    session?.transcriptAvailable ??
    (session?.agentKind === 'claude-code' || session?.agentKind === 'grok')
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
  // Pinned to the live tail? Drives the "Jump to bottom" pill when the user has
  // scrolled back through the scrollback.
  const [atBottom, setAtBottom] = useState(true)
  // Native-mode dictation: transcribed speech types straight into the PTY as
  // keystrokes — no auto-submit, so the user can edit before hitting Enter.
  const voice = useVoiceInput((text) => mountedRef.current?.connection.sendInput(`${text} `))

  useEffect(() => {
    if (effectiveMode !== 'native' || hibernated || exited) return
    if (!termRef.current) return
    setHasOutput(false)
    setAtBottom(true)
    const mounted = mountSession(termRef.current, {
      hub,
      sessionId,
      ...(toolbarRef.current ? { toolbarEl: toolbarRef.current } : {}),
      ...(E2E ? { test: true } : {}),
      onFirstFrame: () => setHasOutput(true),
    })
    mountedRef.current = mounted
    const offScroll = mounted.view.onScroll(() => setAtBottom(mounted.view.atBottom()))
    return () => {
      offScroll()
      mounted.dispose()
      mountedRef.current = null
    }
  }, [hub, sessionId, effectiveMode, hibernated, exited])

  // Kept mounted while hidden (inactive tab) so its terminal state survives a tab
  // switch — when it becomes the visible tab again, return focus to it.
  useEffect(() => {
    if (active && effectiveMode === 'native' && !hibernated && !exited) {
      mountedRef.current?.view.focus()
    }
  }, [active, effectiveMode, hibernated, exited])

  const sendKey = (key: SpecialKey): void => {
    mountedRef.current?.connection.sendInput(keySequence(key))
  }

  return (
    <div className="agent-panel">
      <div className="agent-panel-bar">
        {session && <WorkerLabel session={session} />}
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
        {!hibernated && !exited && (
          <button
            type="button"
            className="panel-archive"
            title="Archive session — files it under Done"
            onClick={() => void archiveSession(sessionId, true)}
          >
            <Archive size={13} aria-hidden="true" />
          </button>
        )}
        {effectiveMode === 'native' && (
          <button type="button" onClick={() => mountedRef.current?.connection.requestControl()}>
            Take control
          </button>
        )}
      </div>
      {hibernated ? (
        chatCapable ? (
          // The transcript outlives the process — a hibernated agent's history is
          // still worth reading. Show it (read-only; the composer disables itself
          // when the session isn't live) with a banner to wake it back up.
          <>
            <HibernatedBanner sessionId={sessionId} />
            <ChatView sessionId={sessionId} />
          </>
        ) : (
          <HibernatedPane sessionId={sessionId} />
        )
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
            {hasOutput && !atBottom && (
              <button
                type="button"
                className="jump-bottom"
                onClick={() => mountedRef.current?.view.scrollToBottom()}
              >
                <ArrowDownToLine size={13} aria-hidden="true" /> Jump to bottom
              </button>
            )}
          </div>
          {/* Second key row above the soft-keyboard bar: submit/newline/paste +
              voice, plus the Blink-style arrow D-pad. preventDefault on pointerdown
              keeps the terminal focused so a tap doesn't drop the soft keyboard.
              Hidden until the first PTY frame lands — the key bar over a "Starting…"
              screen is just noise (and the D-pad floated oddly above the overlay). */}
          <div
            className={hasOutput ? 'key-actions' : 'key-actions kb-hidden'}
            onPointerDown={(e) => e.preventDefault()}
          >
            <button
              type="button"
              className="key-act"
              title="Submit — send the prompt (Enter)"
              onClick={() => mountedRef.current?.connection.sendInput('\r')}
            >
              Submit
            </button>
            <button
              type="button"
              className="key-act"
              title="Newline — insert a line break without submitting (Option+Enter)"
              onClick={() => mountedRef.current?.connection.sendInput('\x1b\r')}
            >
              Newline
            </button>
            <button
              type="button"
              className="key-act"
              title="Paste — insert clipboard text at the prompt"
              onClick={() => void mountedRef.current?.view.requestPaste()}
            >
              Paste
            </button>
            {voice.supported && (
              <button
                type="button"
                className={voice.listening ? 'key-mic active' : 'key-mic'}
                title={
                  voice.listening ? 'Stop voice input' : 'Voice input — speaks into the terminal'
                }
                onClick={voice.toggle}
              >
                <Mic size={16} aria-hidden="true" />
              </button>
            )}
            <ArrowPad onFire={sendKey} />
          </div>
          <div ref={toolbarRef} className={hasOutput ? 'toolbar' : 'toolbar kb-hidden'} />
        </>
      )}
    </div>
  )
}

type Direction = 'up' | 'down' | 'left' | 'right'
const DIR_KEY: Record<Direction, SpecialKey> = {
  up: 'ArrowUp',
  down: 'ArrowDown',
  left: 'ArrowLeft',
  right: 'ArrowRight',
}

/**
 * Blink-style arrow pad: one key with the four arrows pointing outward. Press and
 * swipe toward a direction — the matching arrow lights up and that arrow key
 * repeat-fires until you let go. A small dead zone in the center means a dead-on
 * tap does nothing; nudging toward an arrow (or tapping it directly) fires it.
 */
function ArrowPad({ onFire }: { onFire: (key: SpecialKey) => void }): JSX.Element {
  const [active, setActive] = useState<Direction | null>(null)
  const padRef = useRef<HTMLButtonElement | null>(null)
  const activeRef = useRef<Direction | null>(null)
  const pressed = useRef(false)
  const timer = useRef<ReturnType<typeof setInterval> | null>(null)
  const onFireRef = useRef(onFire)
  onFireRef.current = onFire

  const clearTimer = (): void => {
    if (timer.current !== null) {
      clearInterval(timer.current)
      timer.current = null
    }
  }
  const setDir = (dir: Direction | null): void => {
    activeRef.current = dir
    setActive(dir)
  }
  const fireDir = (dir: Direction): void => {
    onFireRef.current(DIR_KEY[dir])
    clearTimer()
    // Brief hold-off, then steady auto-repeat — like a held keyboard key.
    timer.current = setInterval(() => onFireRef.current(DIR_KEY[dir]), 110)
  }
  const directionAt = (clientX: number, clientY: number): Direction | null => {
    const el = padRef.current
    if (!el) return null
    const r = el.getBoundingClientRect()
    const dx = clientX - (r.left + r.width / 2)
    const dy = clientY - (r.top + r.height / 2)
    const DEAD = 5
    if (Math.abs(dx) < DEAD && Math.abs(dy) < DEAD) return null
    return Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 'right' : 'left') : dy > 0 ? 'down' : 'up'
  }
  const aim = (clientX: number, clientY: number): void => {
    const dir = directionAt(clientX, clientY)
    if (dir === activeRef.current) return
    if (!dir) {
      clearTimer()
      setDir(null)
      return
    }
    setDir(dir)
    fireDir(dir)
  }
  const stop = (): void => {
    pressed.current = false
    clearTimer()
    setDir(null)
  }
  // Clear the repeat timer if the pad unmounts mid-press (refs only — no deps).
  useEffect(
    () => () => {
      if (timer.current !== null) clearInterval(timer.current)
    },
    [],
  )

  return (
    <button
      type="button"
      ref={padRef}
      className="arrow-pad"
      aria-label="Arrow keys — press and swipe toward a direction"
      onPointerDown={(e) => {
        e.preventDefault()
        pressed.current = true
        e.currentTarget.setPointerCapture(e.pointerId)
        aim(e.clientX, e.clientY)
      }}
      onPointerMove={(e) => {
        if (pressed.current) aim(e.clientX, e.clientY)
      }}
      onPointerUp={stop}
      onPointerCancel={stop}
    >
      <span className={active === 'up' ? 'ap up on' : 'ap up'}>▲</span>
      <span className={active === 'right' ? 'ap right on' : 'ap right'}>▶</span>
      <span className={active === 'down' ? 'ap down on' : 'ap down'}>▼</span>
      <span className={active === 'left' ? 'ap left on' : 'ap left'}>◀</span>
    </button>
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

/** Thin bar over a hibernated session's (read-only) transcript: explains the
 *  state and offers one-click resume, without hiding the conversation. */
function HibernatedBanner({ sessionId }: { sessionId: string }): JSX.Element {
  const { resurrectSession } = useStore()
  const [waking, setWaking] = useState(false)
  return (
    <div className="hibernated-banner">
      <Moon size={14} aria-hidden="true" />
      <span>Hibernated — transcript is read-only until you resume.</span>
      <button
        type="button"
        disabled={waking}
        onClick={() => {
          setWaking(true)
          void resurrectSession(sessionId)
        }}
      >
        {waking ? 'Waking…' : 'Resume'}
      </button>
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

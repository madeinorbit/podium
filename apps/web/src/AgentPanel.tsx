import {
  extractClaudePromptDraft,
  extractCodexPromptDraft,
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
  Sparkles,
  Terminal as TerminalIcon,
} from 'lucide-react'
import type { JSX } from 'react'
import { useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { ChatView } from './ChatView'
import { defaultChatCapable, panelLabel } from './derive'
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
  const { hub, sessions, archiveSession, startBtw, setSessionDraft, hibernateSession } = useStore()
  const session = sessions.find((s) => s.sessionId === sessionId)
  const termRef = useRef<HTMLDivElement | null>(null)
  const toolbarRef = useRef<HTMLDivElement | null>(null)
  const mountedRef = useRef<MountedSession | null>(null)
  // Chat exists where a structured transcript does. Prefer the server's
  // observed signal (lights up any future transcript provider with no edit
  // here); fall back to known transcript harnesses so chat is offered
  // immediately, before the first transcript frame arrives.
  const chatCapable =
    session?.transcriptAvailable ?? (session ? defaultChatCapable(session.agentKind) : false)
  const [mode, setMode] = useState<PanelMode>(() => (chatCapable ? initialMode() : 'native'))
  const effectiveMode: PanelMode = chatCapable ? mode : 'native'

  const pickMode = (m: PanelMode) => {
    setMode(m)
    localStorage.setItem(MODE_KEY, m)
  }

  const hibernated = session?.status === 'hibernated'
  const exited = session?.status === 'exited'
  // Manual hibernation is offered for a live, resumable agent (a resume ref means
  // it can come back), but disabled while it's actively working — parking a
  // working agent would kill its in-flight turn (the server refuses it too).
  const phase = session?.agentState?.phase
  const agentWorking = phase === 'working' || phase === 'compacting'
  const canHibernate = !hibernated && !exited && session?.resumable === true
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
    // Mirror the in-progress native prompt into the shared chat draft (Claude and
    // Codex). Best-effort + clobber-safe: only the controlling client publishes
    // (cross-client), and only while THIS terminal holds focus, so a chat composer
    // being typed in another pane/device wins. Publish only on change; a null
    // extraction (slash menu / no composer / other agent) never clobbers; and a
    // freshly-focused EMPTY composer won't publish '' as its first act (which would
    // wipe a draft another device is typing — a real clear still propagates after).
    const agentKind = session?.agentKind
    let lastPublished: string | null = null
    let sampleTimer: ReturnType<typeof setTimeout> | null = null
    const sample = () => {
      const m = mountedRef.current
      if (!m) return
      if (m.connection.state().role !== 'controller') return
      if (!termRef.current?.contains(document.activeElement)) return
      // Codex's empty composer shows a DIM placeholder suggestion — blank dim cells
      // (screenText dropDim) so it isn't mistaken for typed text; Claude's box needs
      // no such filter.
      let draft: string | null = null
      if (agentKind === 'claude-code')
        draft = extractClaudePromptDraft(m.view.screenText().split('\n'))
      else if (agentKind === 'codex')
        draft = extractCodexPromptDraft(m.view.screenText({ dropDim: true }).split('\n'))
      else return
      if (draft === null || draft === lastPublished) return
      if (draft === '' && lastPublished === null) return
      lastPublished = draft
      setSessionDraft(sessionId, draft)
    }
    const scheduleSample = () => {
      if (sampleTimer) return
      sampleTimer = setTimeout(() => {
        sampleTimer = null
        sample()
      }, 150)
    }
    const mounted = mountSession(termRef.current, {
      hub,
      sessionId,
      ...(toolbarRef.current ? { toolbarEl: toolbarRef.current } : {}),
      ...(E2E ? { test: true } : {}),
      // Don't grab focus on mount — that pops the soft keyboard over the
      // "Starting…" overlay. The focus effect below takes over once output lands.
      focusOnMount: false,
      onFirstFrame: () => setHasOutput(true),
      onFrame: scheduleSample,
    })
    mountedRef.current = mounted
    const offScroll = mounted.view.onScroll(() => setAtBottom(mounted.view.atBottom()))
    return () => {
      if (sampleTimer) clearTimeout(sampleTimer)
      offScroll()
      mounted.dispose()
      mountedRef.current = null
    }
  }, [hub, sessionId, effectiveMode, hibernated, exited, session?.agentKind, setSessionDraft])

  // Kept mounted while hidden (inactive tab) so its terminal state survives a tab
  // switch — when it becomes the visible tab again, return focus to it. Gated on
  // hasOutput so focus (and the soft keyboard it raises on mobile) waits for the
  // terminal to actually be live instead of landing over the "Starting…" overlay.
  useEffect(() => {
    if (active && effectiveMode === 'native' && !hibernated && !exited && hasOutput) {
      mountedRef.current?.view.focus()
    }
  }, [active, effectiveMode, hibernated, exited, hasOutput])

  const sendKey = (key: SpecialKey): void => {
    mountedRef.current?.connection.sendInput(keySequence(key))
  }

  return (
    <div className="flex min-w-0 flex-1 flex-col">
      <div className="flex items-center gap-2.5 border-b border-border bg-card px-2.5 py-[5px]">
        {session && <WorkerLabel session={session} />}
        {/* The chat/native toggle only makes sense with a live PTY behind it — a
            hibernated/exited session has no terminal to switch to, so hide it
            rather than render a control that visibly does nothing. */}
        {chatCapable && !hibernated && !exited && (
          <span className="inline-flex gap-1" role="group" aria-label="Panel view">
            <Button
              type="button"
              variant={effectiveMode === 'chat' ? 'default' : 'outline'}
              size="sm"
              title="Chat view"
              onClick={() => pickMode('chat')}
            >
              <MessageSquareText size={13} aria-hidden="true" />
            </Button>
            <Button
              type="button"
              variant={effectiveMode === 'native' ? 'default' : 'outline'}
              size="sm"
              title="Native terminal"
              onClick={() => pickMode('native')}
            >
              <TerminalIcon size={13} aria-hidden="true" />
            </Button>
          </span>
        )}
        {chatCapable && (
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="ml-auto"
            title="Ask the superagent about this session (BTW)"
            onClick={() => void startBtw(sessionId)}
          >
            <Sparkles size={13} aria-hidden="true" />
          </Button>
        )}
        {canHibernate && (
          <Button
            type="button"
            variant="ghost"
            size="icon"
            disabled={agentWorking}
            title={
              agentWorking
                ? 'Agent is working — hibernate once it reaches idle'
                : 'Hibernate — stop the process to free memory, keep the conversation'
            }
            onClick={() => void hibernateSession(sessionId)}
          >
            <Moon size={13} aria-hidden="true" />
          </Button>
        )}
        {/* Archive stays available while hibernated — you can read the transcript
            in chat and decide to file it away without waking the agent first.
            Exited sessions get Resume/Remove in ExitedPane instead. */}
        {!exited && (
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className={cn(!chatCapable && 'ml-auto')}
            title="Archive session — files it under Done"
            onClick={() => void archiveSession(sessionId, true)}
          >
            <Archive size={13} aria-hidden="true" />
          </Button>
        )}
        {effectiveMode === 'native' && !hibernated && !exited && (
          <Button
            type="button"
            variant="secondary"
            size="sm"
            className={cn(!chatCapable && 'ml-auto')}
            onClick={() => mountedRef.current?.connection.requestControl()}
          >
            Take control
          </Button>
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
          {/* The xterm surface is hard-pinned to its own dark background (#0e0e12,
              matching the terminal theme in terminal-client) regardless of the app
              theme — otherwise a light theme shows a white container edge around the
              still-dark terminal. Revisit when the terminal itself becomes theme-aware. */}
          <div className="relative flex min-h-0 flex-1 flex-col bg-[#0e0e12]">
            <div ref={termRef} className="term min-h-0 flex-1 px-1.5 py-1" />
            {!hasOutput && (
              <div
                className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-3 bg-[#0e0e12] text-[13px] text-zinc-400"
                role="status"
                aria-live="polite"
              >
                <span
                  className="size-[22px] animate-spin rounded-full border-2 border-zinc-700 border-t-zinc-300"
                  aria-hidden="true"
                />
                <span>Starting {session ? panelLabel(session.agentKind) : 'session'}…</span>
              </div>
            )}
            {hasOutput && !atBottom && (
              <Button
                type="button"
                variant="secondary"
                size="sm"
                className="absolute bottom-3 left-1/2 z-[4] -translate-x-1/2 rounded-full bg-muted text-foreground shadow-[0_4px_14px_rgba(0,0,0,0.4)] hover:border-primary"
                onClick={() => mountedRef.current?.view.scrollToBottom()}
              >
                <ArrowDownToLine size={13} aria-hidden="true" /> Jump to bottom
              </Button>
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

// Barely past the dead zone → slow repeat; a full swipe toward an arrow → faster.
const ARROW_DEAD_PX = 5
const ARROW_SLOW_REPEAT_MS = 340
const ARROW_FAST_REPEAT_MS = 85

function arrowRepeatMs(extent: number): number {
  const t = Math.max(0, Math.min(1, extent))
  return Math.round(ARROW_SLOW_REPEAT_MS + (ARROW_FAST_REPEAT_MS - ARROW_SLOW_REPEAT_MS) * t)
}

/**
 * Blink-style arrow pad: one key with the four arrows pointing outward. Press and
 * swipe toward a direction — the matching arrow lights up and that arrow key
 * repeat-fires until you let go. A small dead zone in the center means a dead-on
 * tap does nothing; nudging toward an arrow (or tapping it directly) fires it.
 * Repeat rate scales with swipe distance: a light nudge is slow, a committed swipe
 * is faster.
 */
function ArrowPad({ onFire }: { onFire: (key: SpecialKey) => void }): JSX.Element {
  const [active, setActive] = useState<Direction | null>(null)
  const padRef = useRef<HTMLButtonElement | null>(null)
  const activeRef = useRef<Direction | null>(null)
  const pressed = useRef(false)
  const timer = useRef<ReturnType<typeof setInterval> | null>(null)
  const repeatMsRef = useRef(ARROW_SLOW_REPEAT_MS)
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
  const scheduleRepeat = (dir: Direction, extent: number, fireNow: boolean): void => {
    const ms = arrowRepeatMs(extent)
    repeatMsRef.current = ms
    clearTimer()
    if (fireNow) onFireRef.current(DIR_KEY[dir])
    timer.current = setInterval(() => onFireRef.current(DIR_KEY[dir]), ms)
  }
  const directionAt = (
    clientX: number,
    clientY: number,
  ): { dir: Direction; extent: number } | null => {
    const el = padRef.current
    if (!el) return null
    const r = el.getBoundingClientRect()
    const dx = clientX - (r.left + r.width / 2)
    const dy = clientY - (r.top + r.height / 2)
    if (Math.abs(dx) < ARROW_DEAD_PX && Math.abs(dy) < ARROW_DEAD_PX) return null
    const horizontal = Math.abs(dx) > Math.abs(dy)
    const dir: Direction = horizontal
      ? dx > 0
        ? 'right'
        : 'left'
      : dy > 0
        ? 'down'
        : 'up'
    const primary = horizontal ? Math.abs(dx) : Math.abs(dy)
    const maxPrimary = horizontal ? r.width / 2 : r.height / 2
    const travel = Math.max(0, maxPrimary - ARROW_DEAD_PX)
    const extent = travel > 0 ? Math.min(1, (primary - ARROW_DEAD_PX) / travel) : 1
    return { dir, extent }
  }
  const aim = (clientX: number, clientY: number): void => {
    const hit = directionAt(clientX, clientY)
    if (!hit) {
      clearTimer()
      setDir(null)
      return
    }
    const { dir, extent } = hit
    if (dir !== activeRef.current) {
      setDir(dir)
      scheduleRepeat(dir, extent, true)
      return
    }
    const ms = arrowRepeatMs(extent)
    if (Math.abs(ms - repeatMsRef.current) >= 12) scheduleRepeat(dir, extent, false)
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
      {/* CSS triangles — the classic Blink outward-pointing pad, monochrome on every
          platform (emoji ▲▶▼◀ tint and scale inconsistently; Lucide chevrons read
          too chunky in a 40×30 key). */}
      <span className={active === 'up' ? 'ap up on' : 'ap up'} aria-hidden="true" />
      <span className={active === 'right' ? 'ap right on' : 'ap right'} aria-hidden="true" />
      <span className={active === 'down' ? 'ap down on' : 'ap down'} aria-hidden="true" />
      <span className={active === 'left' ? 'ap left on' : 'ap left'} aria-hidden="true" />
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
    <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center text-warning">
      <RotateCcw size={28} aria-hidden="true" />
      <p className="m-0 max-w-[42ch] text-[13px] text-muted-foreground">
        {detail}{' '}
        {isShell
          ? 'Restart opens a fresh shell in the same directory.'
          : resumable
            ? 'The conversation is intact — resume to pick up where it left off.'
            : 'It left no conversation to resume.'}
      </p>
      {recoverable ? (
        <Button type="button" disabled={waking} onClick={restart}>
          {waking
            ? isShell
              ? 'Restarting…'
              : 'Resuming…'
            : isShell
              ? 'Restart shell'
              : 'Resume session'}
        </Button>
      ) : (
        <Button type="button" variant="secondary" onClick={() => void killSession(sessionId)}>
          Remove session
        </Button>
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
    <div className="flex shrink-0 items-center gap-2 border-b border-primary/30 bg-primary/10 px-3 py-1.5 text-xs text-primary">
      <Moon size={14} aria-hidden="true" />
      <span className="min-w-0 flex-1">Hibernated — transcript is read-only until you resume.</span>
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="shrink-0 border-primary/50 text-primary hover:bg-primary/10 hover:text-primary"
        disabled={waking}
        onClick={() => {
          setWaking(true)
          void resurrectSession(sessionId)
        }}
      >
        {waking ? 'Waking…' : 'Resume'}
      </Button>
    </div>
  )
}

/** Firefox-snoozed-tab moment: the process is parked, one click wakes it. */
function HibernatedPane({ sessionId }: { sessionId: string }): JSX.Element {
  const { resurrectSession } = useStore()
  const [waking, setWaking] = useState(false)
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center text-primary">
      <Moon size={28} aria-hidden="true" />
      <p className="m-0 max-w-[42ch] text-[13px] text-muted-foreground">
        This session is hibernated — its process was stopped to free memory, but the conversation is
        intact.
      </p>
      <Button
        type="button"
        disabled={waking}
        onClick={() => {
          setWaking(true)
          void resurrectSession(sessionId)
        }}
      >
        {waking ? 'Waking…' : 'Resume session'}
      </Button>
    </div>
  )
}

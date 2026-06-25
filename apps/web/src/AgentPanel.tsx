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
  Copy,
  Folder,
  MessageSquareText,
  Mic,
  Moon,
  RotateCcw,
  Sparkles,
  Terminal as TerminalIcon,
} from 'lucide-react'
import type { JSX } from 'react'
import { useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { ArrowSwipeKey } from '@/ArrowSwipeKey'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { useSessionGuard } from '@/hooks/use-session-guard'
import { cn } from '@/lib/utils'
import { ChatView } from './ChatView'
import { accumulateFileLinkPaths } from './chat'
import {
  defaultChatCapable,
  exitedRecovery,
  isKnownWorktreePath,
  isSnoozed,
  panelLabel,
  resumeCommand,
} from './derive'
import { attentionGroup } from './home'
import { SnoozeControl } from './SnoozeControl'
import { useStore } from './store'
import { useNow } from './useNow'
import { useVoiceInput } from './voice'
import { WorkerLabel } from './WorkerLabel'

// Opt-in browser-test hook: `?e2e=1` exposes `globalThis.__podium` on the mounted
// session (screenText/sendInput/simulateKeyboard/…) for the Playwright harness under
// tests/e2e/browser. Off by default, so normal sessions never expose the input API.
const E2E = typeof window !== 'undefined' && new URLSearchParams(window.location.search).has('e2e')

type PanelMode = 'native' | 'chat'

/**
 * localStorage key for the per-device default mode pick (#35). The last mode a
 * user picked anywhere becomes the device default for sessions that have no
 * remembered per-session mode yet; per-session overrides live in the store
 * (`panelMode`, persisted under `podium.panelMode`).
 */
const MODE_KEY = 'podium.panelModeDefault'

/**
 * Determine the default panel mode for a session that has no persisted
 * per-session override in the store yet.
 *
 * Priority:
 * 1. The per-device default pick (the last mode the user picked anywhere,
 *    saved under MODE_KEY) — chat reads best on a phone, the real PTY is the
 *    desktop default.
 * 2. The `startScreen` setting:
 *    - 'native'  → native terminal (always)
 *    - 'chat'    → chat view (if capable; else native)
 *    - 'auto'    → chat on mobile, native on desktop
 * 3. Non-chat-capable sessions always show the native terminal.
 */
export function initialPanelMode({
  startScreen,
  chatCapable,
  isMobile,
  saved,
}: {
  startScreen: 'native' | 'chat' | 'auto'
  chatCapable: boolean
  isMobile: boolean
  /** The persisted per-session mode (from the store, #35) when known — wins over
   *  the per-device default and the startScreen setting. */
  saved?: PanelMode | null
}): PanelMode {
  if (!chatCapable) return 'native'
  if (saved === 'native' || saved === 'chat') return saved
  const devdefault = typeof localStorage !== 'undefined' ? localStorage.getItem(MODE_KEY) : null
  if (devdefault === 'native' || devdefault === 'chat') return devdefault
  if (startScreen === 'auto') return isMobile ? 'chat' : 'native'
  if (startScreen === 'chat') return 'chat'
  return 'native'
}

/** Collapse the user's home directory to `~` for a compact cwd display. */
export function prettyCwd(path: string): string {
  return path.replace(/^\/(?:home|Users)\/[^/]+/, '~')
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
  const {
    hub,
    sessions,
    repos,
    trpc,
    drafts,
    startBtw,
    setSessionDraft,
    hibernateSession,
    openFile,
    panelMode,
    setPanelMode,
  } = useStore()
  const { guardedArchive } = useSessionGuard()
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
  // Fetch the startScreen setting once; default to 'native' while loading. This
  // drives the configurable default mode for sessions the user has never toggled.
  const [startScreen, setStartScreen] = useState<'native' | 'chat' | 'auto'>('native')
  useEffect(() => {
    trpc.settings.get
      .query()
      .then((s) => {
        setStartScreen(s.sessionDefaults.startScreen)
      })
      .catch(() => {
        /* keep default */
      })
  }, [trpc])

  // Per-session mode is restored from the store (persisted to localStorage) so a
  // reload returns this session to the view it was last left in (#35). A session
  // the user never toggled falls back to the configurable default: the per-device
  // pick (MODE_KEY) → the `startScreen` setting → chat-on-mobile/native-on-desktop.
  const isMobile = typeof window !== 'undefined' && window.matchMedia('(max-width: 768px)').matches
  const mode: PanelMode = initialPanelMode({
    startScreen,
    chatCapable,
    isMobile,
    saved: panelMode[sessionId],
  })
  // The hibernated/exited-forces-chat rule still wins over any persisted 'native'.
  const effectiveMode: PanelMode = chatCapable ? mode : 'native'

  const pickMode = (m: PanelMode) => {
    // Persist the per-session override in the store (#35)…
    setPanelMode(sessionId, m)
    // …and remember the latest pick as the per-device default for not-yet-seen sessions.
    if (typeof localStorage !== 'undefined') localStorage.setItem(MODE_KEY, m)
  }

  const hibernated = session?.status === 'hibernated'
  const exited = session?.status === 'exited'
  // The session's worktree was removed out from under it (an orphaned session):
  // its cwd no longer matches any scanned worktree. Gate on repos being loaded so
  // the boot window (no repos yet) doesn't transiently flag every session. Feeds
  // the exited banners — a missing worktree forces "remove" (can't resume in a
  // directory that's gone), while the header's copy-resume-command stays for
  // resuming by hand elsewhere.
  const worktreeMissing = !!session && repos.length > 0 && !isKnownWorktreePath(repos, session.cwd)
  // The native CLI resume command for this session (#119), or null when no
  // resume ref is known. Also the first right-aligned header control, so the
  // `ml-auto` fallbacks below defer to it when present.
  const resumeCmd = session ? resumeCommand(session) : null
  // Manual hibernation is offered for a live, resumable agent (a resume ref means
  // it can come back), but disabled while it's actively working — parking a
  // working agent would kill its in-flight turn (the server refuses it too).
  const phase = session?.agentState?.phase
  const agentWorking = phase === 'working' || phase === 'compacting'
  const snoozeNow = useNow(60_000)
  // Offer snooze in the full view when the session is in (or already snoozed out
  // of) the attention surface — not for actively-working or parked sessions.
  const showSnooze =
    !!session &&
    !hibernated &&
    !exited &&
    (attentionGroup(session) !== 'working' || isSnoozed(session, snoozeNow))
  const canHibernate = !hibernated && !exited && session?.resumable === true
  // Hold a "Starting…" overlay over the terminal until the session is READY — the
  // server confirms the attach (PTY bound), the first frame lands, or a timeout
  // backstop fires (see mountSession's onReady). Gating on attach rather than on
  // output is what lets a session idling at a prompt with an empty replay buffer
  // (e.g. after a server restart) reveal as usable instead of hanging "Starting…".
  const [ready, setReady] = useState(false)
  // Pinned to the live tail? Drives the "Jump to bottom" pill when the user has
  // scrolled back through the scrollback.
  const [atBottom, setAtBottom] = useState(true)
  // Native-mode dictation: transcribed speech types straight into the PTY as
  // keystrokes — no auto-submit, so the user can edit before hitting Enter.
  const voice = useVoiceInput((text) => mountedRef.current?.connection.sendInput(`${text} `))
  const knownPathsRef = useRef<Set<string>>(new Set())
  // Latest shared chat draft for this session, mirrored into a ref so the native
  // mount effect can read it at flush time (chat→native sync, #17/#62) WITHOUT
  // depending on `drafts` — a dep there would tear down and remount the whole
  // terminal on every keystroke.
  const draftRef = useRef('')
  draftRef.current = drafts[sessionId] ?? ''

  // Subscribe to the transcript to build the set of known absolute paths for
  // the file-link provider. Updates mountedRef.current?.view.setFileLinks so
  // links stay fresh as new tool calls land. The hub now forwards per-frame
  // DELTAS, so accumulate paths into a growing set (a reset re-seeds it empty).
  useEffect(() => {
    knownPathsRef.current = new Set()
    return hub.subscribeTranscript(sessionId, undefined, (delta, meta) => {
      // accumulateFileLinkPaths returns a fresh Set each frame, so we hand the
      // view a copy (not the live ref identity) — defensive against the view
      // mutating or aliasing our accumulator.
      const set = accumulateFileLinkPaths(knownPathsRef.current, delta, meta.reset)
      knownPathsRef.current = set
      mountedRef.current?.view.setFileLinks({
        cwd: session?.cwd ?? '/',
        knownPaths: new Set(set),
        onOpen: (abs) => openFile(sessionId, abs),
      })
    })
  }, [hub, sessionId, session?.cwd, openFile])

  useEffect(() => {
    // The terminal stays mounted across a chat<->native toggle (Task 6): it's
    // kept alive (hidden under the chat overlay) and marked inactive via the
    // eligibility effect below, so a toggle neither disposes nor re-attaches it.
    // Only hibernated/exited (no live PTY) skip mounting; the container is null
    // then too. Crucially this effect no longer depends on effectiveMode, so a
    // mode flip doesn't re-run it.
    if (hibernated || exited) return
    if (!termRef.current) return
    setReady(false)
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
    // Read the native composer's current text via the same scrape both directions
    // share. Returns the typed text, '' for an empty composer, or null when no
    // clean composer box is on screen yet (splash/overlay/menu) — callers must
    // not act on null. Claude draws a box; Codex a single dim-stripped `›` line.
    const scrapeComposer = (m: MountedSession): string | null => {
      if (agentKind === 'claude-code')
        return extractClaudePromptDraft(m.view.screenText().split('\n'))
      if (agentKind === 'codex')
        return extractCodexPromptDraft(m.view.screenText({ dropDim: true }).split('\n'))
      return null
    }
    const sample = () => {
      const m = mountedRef.current
      if (!m) return
      if (m.connection.state().role !== 'controller') return
      if (!termRef.current?.contains(document.activeElement)) return
      // Codex's empty composer shows a DIM placeholder suggestion — blank dim cells
      // (screenText dropDim) so it isn't mistaken for typed text; Claude's box needs
      // no such filter.
      const draft = scrapeComposer(m)
      if (draft === null || draft === lastPublished) return
      if (draft === '' && lastPublished === null) return
      lastPublished = draft
      setSessionDraft(sessionId, draft)
    }
    // chat→native (#17/#62): one-shot flush of the shared chat draft into the
    // native composer on entering native mode, so text typed in chat lands in the
    // real PTY prompt. The terminal is UNMOUNTED during chat mode (chat renders
    // ChatView, not the xterm), so realtime key-by-key injection while chat-typing
    // is impossible — the realistic, safe sync point is this mode switch.
    //
    // SAFETY (never clobber text the user typed directly in the native composer):
    //   - only the controller injects, and only while the terminal holds focus
    //     (mirrors the sampler's directional guard #53 so the two never fight);
    //   - we scrape the live composer first and ONLY inject when it is empty (or
    //     already equals what we're about to type — an idempotent retry). A null
    //     scrape (splash/overlay not yet a clean box) or unrelated typed text →
    //     SKIP, and we retry on later frames until the box settles or we bail;
    //   - empty shared draft → nothing to do.
    // ANTI-FEEDBACK ("sent keys + reconcile"): we send Ctrl-U (clear-line, a no-op
    // on an already-empty composer) then the draft, remember it as `lastPublished`,
    // and let the existing 150ms sampler reconcile — it now sees the scrape return
    // exactly what we injected (=== lastPublished) and stays quiet, so our own
    // injection is never re-published as a "new" draft.
    let flushTried = false
    // Returns true when it actually injected on this tick — the caller then SKIPS
    // the sampler for this tick, because the injected bytes haven't echoed back to
    // the screen yet (the scrape would still read the pre-injection empty composer
    // and, with lastPublished now set to the draft, publish '' — wiping it). The
    // next frame's scrape sees the echo, matches lastPublished, and stays quiet.
    const flushDraftToNative = (): boolean => {
      if (flushTried) return false
      const m = mountedRef.current
      if (!m) return false
      if (m.connection.state().role !== 'controller') return false
      if (!termRef.current?.contains(document.activeElement)) return false
      const want = draftRef.current
      // Nothing to push — let the native→chat sampler own this session's draft.
      if (want === '') {
        flushTried = true
        return false
      }
      const current = scrapeComposer(m)
      // No clean composer box yet (splash/overlay): wait for a later frame.
      if (current === null) return false
      // The composer already holds text the user typed directly in native — never
      // overwrite it. Stand down for this mode-entry (idempotent if it happens to
      // already equal what we'd type).
      if (current !== '' && current !== want) {
        flushTried = true
        return false
      }
      flushTried = true
      // Clear the line (safe no-op when empty) then type the draft. Seed the
      // sampler so the reconcile scrape of our own injection isn't re-published.
      lastPublished = want
      m.connection.sendInput('\x15') // Ctrl-U
      m.connection.sendInput(want)
      return true
    }
    const scheduleSample = () => {
      if (sampleTimer) return
      sampleTimer = setTimeout(() => {
        sampleTimer = null
        if (flushDraftToNative()) return
        sample()
      }, 150)
    }
    const mounted = mountSession(termRef.current, {
      hub,
      sessionId,
      active: active && effectiveMode === 'native' && !hibernated && !exited,
      ...(toolbarRef.current ? { toolbarEl: toolbarRef.current } : {}),
      ...(E2E ? { test: true } : {}),
      // Don't grab focus on mount — that pops the soft keyboard over the
      // "Starting…" overlay. The focus effect below takes over once the session
      // is ready (attached).
      focusOnMount: false,
      onReady: () => setReady(true),
      onFrame: scheduleSample,
    })
    mountedRef.current = mounted
    // Seed the file-link provider immediately after mount with whatever paths
    // are already known (from the transcript subscription above). Without this
    // the provider is a no-op until the next transcript callback fires.
    mounted.view.setFileLinks({
      cwd: session?.cwd ?? '/',
      knownPaths: knownPathsRef.current,
      onOpen: (abs) => openFile(sessionId, abs),
    })
    const offScroll = mounted.view.onScroll(() => setAtBottom(mounted.view.atBottom()))
    // The flush above piggy-backs on onFrame, but an already-idle composer may emit
    // no frames after focus lands (and focus itself arrives a beat after the first
    // frame, via the effect below). Poll a bounded number of times so the one-shot
    // chat→native flush still fires on a quiet session; it self-stops once the flush
    // resolves (injected, or skipped because empty/occupied/wrong-agent).
    let flushAttempts = 0
    const flushPoll = setInterval(() => {
      if (flushTried || flushAttempts++ >= 40) {
        clearInterval(flushPoll)
        return
      }
      if (flushDraftToNative()) clearInterval(flushPoll)
    }, 150)
    return () => {
      if (sampleTimer) clearTimeout(sampleTimer)
      clearInterval(flushPoll)
      offScroll()
      mounted.dispose()
      mountedRef.current = null
    }
  }, [hub, sessionId, hibernated, exited, session?.agentKind, setSessionDraft])

  // Drive the terminal's size eligibility from the tab's active/visible/mode
  // state. Separate from the mount effect so a tab switch (active flip) never
  // tears down and re-attaches the terminal — it only flips eligibility.
  //
  // A native<->chat (or *->hibernated/exited) switch DOES remount/unmount the
  // terminal (the mount effect owns that), and React runs that effect's cleanup
  // — which nulls `mountedRef.current` — before this effect's body. So on the
  // switch INTO chat the ref is already gone and this is a harmless no-op; the
  // disposed terminal stops driving size by virtue of being disposed. The case
  // that needs this push is a pure `active` flip while staying native, where the
  // terminal stays mounted and only its eligibility must change.
  const terminalActive = active && effectiveMode === 'native' && !hibernated && !exited
  useEffect(() => {
    mountedRef.current?.setActive(terminalActive)
  }, [terminalActive])

  // Kept mounted while hidden (inactive tab) so its terminal state survives a tab
  // switch — when it becomes the visible tab again, return focus to it. Gated on
  // `ready` so focus (and the soft keyboard it raises on mobile) waits for the
  // session to attach instead of landing over the "Starting…" overlay.
  useEffect(() => {
    if (active && effectiveMode === 'native' && !hibernated && !exited && ready) {
      mountedRef.current?.view.focus()
    }
  }, [active, effectiveMode, hibernated, exited, ready])

  const sendKey = (key: SpecialKey): void => {
    mountedRef.current?.connection.sendInput(keySequence(key))
  }

  return (
    <div className="flex min-w-0 flex-1 flex-col">
      <div className="flex items-center gap-2.5 border-b border-border bg-card px-2.5 py-[5px]">
        {session && <WorkerLabel session={session} />}
        {/* The agent's working directory — context for which checkout/worktree this
            session runs in. Truncates; full path on hover. */}
        {session?.cwd && (
          <span
            className="hidden min-w-0 max-w-[40%] items-center gap-1 truncate text-[11px] text-muted-foreground/70 sm:inline-flex"
            title={session.cwd}
          >
            <Folder size={11} aria-hidden="true" className="flex-none" />
            <span className="truncate">{prettyCwd(session.cwd)}</span>
          </span>
        )}
        {/* The chat/native toggle only makes sense with a live PTY behind it — a
            hibernated/exited session has no terminal to switch to, so hide it
            rather than render a control that visibly does nothing. */}
        {chatCapable && !hibernated && !exited && (
          <div className="inline-flex flex-none items-center rounded-md border border-input p-0.5">
            <button
              type="button"
              aria-pressed={effectiveMode === 'chat'}
              aria-label="Chat view"
              title="Chat view"
              onClick={() => pickMode('chat')}
              className={cn(
                'flex items-center justify-center rounded-[5px] px-2 py-1 transition-colors',
                effectiveMode === 'chat'
                  ? 'bg-primary text-primary-foreground'
                  : 'text-muted-foreground hover:text-foreground',
              )}
            >
              <MessageSquareText size={13} aria-hidden="true" />
            </button>
            <button
              type="button"
              aria-pressed={effectiveMode === 'native'}
              aria-label="Native terminal"
              title="Native terminal"
              onClick={() => pickMode('native')}
              className={cn(
                'flex items-center justify-center rounded-[5px] px-2 py-1 transition-colors',
                effectiveMode === 'native'
                  ? 'bg-primary text-primary-foreground'
                  : 'text-muted-foreground hover:text-foreground',
              )}
            >
              <TerminalIcon size={13} aria-hidden="true" />
            </button>
          </div>
        )}
        {/* Native resume command (#119): the literal `claude --resume <id>` etc.
            so you can pick the conversation back up in your own terminal. Shown
            whenever the harness has handed us a resume ref. As the first
            right-aligned control it carries `ml-auto`; the snooze/BTW controls
            only take it when the controls before them are absent. */}
        {resumeCmd && <ResumeCommandMenu command={resumeCmd} className="ml-auto" />}
        {showSnooze && session && (
          <SnoozeControl
            session={session}
            iconSize={15}
            dimmed={false}
            className={cn(!resumeCmd && 'ml-auto')}
          />
        )}
        {chatCapable && (
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className={cn(!resumeCmd && !showSnooze && 'ml-auto')}
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
            className={cn(!chatCapable && !resumeCmd && 'ml-auto')}
            title="Archive session — files it under Done"
            onClick={() => void guardedArchive(sessionId, true)}
          >
            <Archive size={13} aria-hidden="true" />
          </Button>
        )}
        {effectiveMode === 'native' && !hibernated && !exited && (
          <Button
            type="button"
            variant="secondary"
            size="sm"
            className={cn(!chatCapable && !resumeCmd && 'ml-auto')}
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
            <ChatView sessionId={sessionId} active={active} />
          </>
        ) : (
          <HibernatedPane sessionId={sessionId} />
        )
      ) : exited && session ? (
        chatCapable ? (
          // The process is gone but the transcript outlives it — keep the chat
          // readable (and resumable via the composer) with a banner, instead of
          // replacing it with a dead-end pane. Shells (no transcript) still get it.
          <>
            <ExitedBanner
              sessionId={sessionId}
              exitCode={session.exitCode}
              isShell={session.agentKind === 'shell'}
              resumable={session.resumable === true}
              worktreeMissing={worktreeMissing}
              worktreePath={prettyCwd(session.cwd)}
            />
            <ChatView sessionId={sessionId} active={active} />
          </>
        ) : (
          <ExitedPane
            sessionId={sessionId}
            exitCode={session.exitCode}
            isShell={session.agentKind === 'shell'}
            resumable={session.resumable === true}
            worktreeMissing={worktreeMissing}
            worktreePath={prettyCwd(session.cwd)}
          />
        )
      ) : (
        // Warm chat<->native toggle (Task 6): the terminal container stays
        // mounted in BOTH modes — `hidden` (display:none) when in chat — so
        // switching modes never disposes and re-attaches the PTY. ChatView is
        // rendered as a sibling overlay on top when in chat mode.
        <>
          {effectiveMode === 'chat' && <ChatView sessionId={sessionId} active={active} />}
          {/* The xterm surface is hard-pinned to its own dark background (#0e0e12,
              matching the terminal theme in terminal-client) regardless of the app
              theme — otherwise a light theme shows a white container edge around the
              still-dark terminal. Revisit when the terminal itself becomes theme-aware. */}
          <div
            className={cn(
              'relative flex min-h-0 flex-1 flex-col bg-[#0e0e12]',
              effectiveMode === 'chat' && 'hidden',
            )}
          >
            <div ref={termRef} className="term min-h-0 flex-1 px-1.5 py-1" />
            {!ready && (
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
            {ready && !atBottom && (
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
          {/* Second key row above the soft-keyboard bar: submit/newline/paste, then the
              Blink-style arrow D-pad, then voice. D-pad left of the mic so the right
              arrow isn't flush with the screen edge. preventDefault on pointerdown
              keeps the terminal focused so a tap doesn't drop the soft keyboard.
              Hidden until the session is ready — the key bar over a "Starting…"
              screen is just noise (and the D-pad floated oddly above the overlay). */}
          <div
            className={cn(
              ready ? 'key-actions' : 'key-actions kb-hidden',
              effectiveMode === 'chat' && 'hidden',
            )}
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
            <ArrowSwipeKey onFire={sendKey} />
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
          </div>
          <div
            ref={toolbarRef}
            className={cn(
              ready ? 'toolbar' : 'toolbar kb-hidden',
              effectiveMode === 'chat' && 'hidden',
            )}
          />
        </>
      )}
    </div>
  )
}

/**
 * Header affordance for #119: a small overflow menu that shows the session's
 * native CLI resume command (e.g. `claude --resume <id>`) and copies it to the
 * clipboard. The id is what lets you reopen the exact conversation in your own
 * terminal, outside Podium.
 */
function ResumeCommandMenu({
  command,
  className,
}: {
  command: string
  className?: string
}): JSX.Element {
  const copy = () => {
    void navigator.clipboard
      ?.writeText(command)
      .then(() => toast('Resume command copied'))
      .catch(() => toast.error('Could not copy to clipboard'))
  }
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className={className}
            title="Resume command — copy the CLI command to reopen this conversation"
          >
            <TerminalIcon size={13} aria-hidden="true" />
          </Button>
        }
      />
      <DropdownMenuContent align="end" className="w-auto min-w-[260px] max-w-[90vw]">
        <DropdownMenuLabel>Resume in your terminal</DropdownMenuLabel>
        <code className="mx-1.5 block overflow-x-auto rounded bg-muted px-2 py-1.5 font-mono text-[11px] whitespace-pre text-foreground">
          {command}
        </code>
        <DropdownMenuItem onClick={copy}>
          <Copy size={13} aria-hidden="true" /> Copy command
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
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
  worktreeMissing,
  worktreePath,
}: {
  sessionId: string
  exitCode: number | undefined
  isShell: boolean
  resumable: boolean
  worktreeMissing: boolean
  worktreePath?: string
}): JSX.Element {
  const { resurrectSession, killSession } = useStore()
  const [waking, setWaking] = useState(false)
  const { detail, action } = exitedRecovery({
    exitCode,
    isShell,
    resumable,
    worktreeMissing,
    ...(worktreePath ? { worktreePath } : {}),
  })
  const secondary =
    action === 'restart'
      ? 'Restart opens a fresh shell in the same directory.'
      : action === 'resume'
        ? 'The conversation is intact — resume to pick up where it left off.'
        : worktreeMissing
          ? 'Remove it to clear it away.'
          : 'It left no conversation to resume.'
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center text-warning">
      <RotateCcw size={28} aria-hidden="true" />
      <p className="m-0 max-w-[42ch] text-[13px] text-muted-foreground">
        {detail} {secondary}
      </p>
      {action === 'remove' ? (
        <Button type="button" variant="secondary" onClick={() => void killSession(sessionId)}>
          Remove session
        </Button>
      ) : (
        <Button
          type="button"
          disabled={waking}
          onClick={() => {
            setWaking(true)
            void resurrectSession(sessionId)
          }}
        >
          {waking
            ? action === 'restart'
              ? 'Restarting…'
              : 'Resuming…'
            : action === 'restart'
              ? 'Restart shell'
              : 'Resume session'}
        </Button>
      )}
    </div>
  )
}

/** Thin bar over an exited session's (read-only) transcript: says the process is
 *  gone but keeps the conversation readable, with resume/restart or remove. */
function ExitedBanner({
  sessionId,
  exitCode,
  isShell,
  resumable,
  worktreeMissing,
  worktreePath,
}: {
  sessionId: string
  exitCode: number | undefined
  isShell: boolean
  resumable: boolean
  worktreeMissing: boolean
  worktreePath?: string
}): JSX.Element {
  const { resurrectSession, killSession } = useStore()
  const [waking, setWaking] = useState(false)
  const { detail, action } = exitedRecovery({
    exitCode,
    isShell,
    resumable,
    worktreeMissing,
    ...(worktreePath ? { worktreePath } : {}),
  })
  return (
    // items-start (not -center) so the action stays put when the notice wraps to
    // a second line — the worktree-missing message is longer than a bare exit line.
    <div className="flex shrink-0 items-start gap-2 border-b border-warning/30 bg-warning/10 px-3 py-1.5 text-xs text-warning">
      <RotateCcw size={14} aria-hidden="true" className="mt-0.5 shrink-0" />
      <span className="min-w-0 flex-1">{detail} Transcript is read-only.</span>
      {action === 'remove' ? (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="shrink-0"
          onClick={() => void killSession(sessionId)}
        >
          Remove
        </Button>
      ) : (
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="shrink-0 border-warning/50 text-warning hover:bg-warning/10 hover:text-warning"
          disabled={waking}
          onClick={() => {
            setWaking(true)
            void resurrectSession(sessionId)
          }}
        >
          {waking
            ? action === 'restart'
              ? 'Restarting…'
              : 'Resuming…'
            : action === 'restart'
              ? 'Restart'
              : 'Resume'}
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

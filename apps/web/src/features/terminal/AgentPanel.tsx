import { shallowEqual } from '@podium/client-core/store'
import {
  extractClaudePromptDraft,
  extractCodexPromptDraft,
  keySequence,
  type MountedSession,
  type SpecialKey,
} from '@podium/terminal-client'
import { useTerminalSession } from '@podium/terminal-client-react'
import {
  Archive,
  ArrowDownToLine,
  Copy,
  Folder,
  Keyboard,
  MessageSquareText,
  Mic,
  Moon,
  RotateCcw,
  Sparkles,
  SquareTerminal,
  Terminal as TerminalIcon,
} from 'lucide-react'
import type { JSX } from 'react'
import { useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { useStoreSelector } from '@/app/store'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { ChatView } from '@/features/chat/ChatView'
import { accumulateFileLinkPaths } from '@/features/chat/chat'
import {
  defaultChatCapable,
  exitedRecovery,
  isKnownWorktreePath,
  isSnoozed,
  panelLabel,
  resumeCommand,
} from '@/lib/derive'
import { attentionGroup } from '@/lib/home'
import { useSessionGuard } from '@/lib/hooks/use-session-guard'
import { SnoozeControl } from '@/lib/SnoozeControl'
import { useNow } from '@/lib/useNow'
import { cn } from '@/lib/utils'
import { useVoiceInput } from '@/lib/voice'
import { KindIcon, sessionDisplayName } from '@/lib/WorkerLabel'
import { ArrowSwipeKey } from './ArrowSwipeKey'
import { TERMINAL_DEFAULTS } from './appearance'
import { EchoHud, echoHudEnabled } from './EchoHud'
import { useTerminalAppearance } from './use-terminal-appearance'

// Opt-in browser-test hook: `?e2e=1` exposes `globalThis.__podium` on the mounted
// session (screenText/sendInput/simulateKeyboard/…) for the Playwright harness under
// tests/e2e/browser. Off by default, so normal sessions never expose the input API.
const E2E = typeof window !== 'undefined' && new URLSearchParams(window.location.search).has('e2e')

type PanelMode = 'native' | 'chat'

/**
 * ui-state key for the per-device default mode pick (#35). The last mode a
 * user picked anywhere becomes the device default for sessions that have no
 * remembered per-session mode yet; per-session overrides live in the store
 * (`panelMode`, persisted under `podium.panelMode`). The legacy localStorage
 * key of the same name migrates into ui-state once (replica.uiState()).
 */
export const PANEL_MODE_DEFAULT_KEY = 'podium.panelModeDefault'

/**
 * Determine the default panel mode for a session that has no persisted
 * per-session override in the store yet.
 *
 * Priority:
 * 1. The per-device default pick (the last mode the user picked anywhere,
 *    saved under PANEL_MODE_DEFAULT_KEY) — chat reads best on a phone, the
 *    real PTY is the desktop default.
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
  deviceDefault,
}: {
  startScreen: 'native' | 'chat' | 'auto'
  chatCapable: boolean
  isMobile: boolean
  /** The persisted per-session mode (from the store, #35) when known — wins over
   *  the per-device default and the startScreen setting. */
  saved?: PanelMode | null
  /** The per-device default pick (ui-state PANEL_MODE_DEFAULT_KEY), if any. */
  deviceDefault?: string | null
}): PanelMode {
  if (!chatCapable) return 'native'
  if (saved === 'native' || saved === 'chat') return saved
  if (deviceDefault === 'native' || deviceDefault === 'chat') return deviceDefault
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
    pendingSpawnIds,
    machines,
    repos,
    trpc,
    drafts,
    startBtw,
    setSessionDraft,
    hibernateSession,
    openFile,
    panelMode,
    setPanelMode,
    setPanelRenderMode,
    uiState,
  } = useStoreSelector(
    (s) => ({
      hub: s.hub,
      sessions: s.sessions,
      pendingSpawnIds: s.pendingSpawnIds,
      machines: s.machines,
      repos: s.repos,
      trpc: s.trpc,
      drafts: s.drafts,
      startBtw: s.startBtw,
      setSessionDraft: s.setSessionDraft,
      hibernateSession: s.hibernateSession,
      openFile: s.openFile,
      panelMode: s.panelMode,
      setPanelMode: s.setPanelMode,
      setPanelRenderMode: s.setPanelRenderMode,
      uiState: s.uiState,
    }),
    shallowEqual,
  )
  const { guardedArchive } = useSessionGuard()
  const session = sessions.find((s) => s.sessionId === sessionId)
  // An optimistically-spawned session doesn't exist server-side yet (#119): the
  // terminal's one-shot `hub.attach` would be dropped and never retried, leaving
  // the pane black. Hold the mount until the real session reconciles in — the
  // "Starting…" overlay covers the wait, and the mount effect (which depends on
  // this) fires the instant it flips true.
  const spawnConfirmed = !pendingSpawnIds.has(sessionId)
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
        setStartScreen(s.roles.coding.startScreen)
      })
      .catch(() => {
        /* keep default */
      })
  }, [trpc])

  // Per-session mode is restored from the store (persisted via ui-state) so a
  // reload returns this session to the view it was last left in (#35). A session
  // the user never toggled falls back to the configurable default: the per-device
  // pick (PANEL_MODE_DEFAULT_KEY) → the `startScreen` setting →
  // chat-on-mobile/native-on-desktop.
  const isMobile = typeof window !== 'undefined' && window.matchMedia('(max-width: 768px)').matches
  const mode: PanelMode = initialPanelMode({
    startScreen,
    chatCapable,
    isMobile,
    saved: panelMode[sessionId],
    deviceDefault: uiState.get(PANEL_MODE_DEFAULT_KEY),
  })
  // The hibernated/exited-forces-chat rule still wins over any persisted 'native'.
  const effectiveMode: PanelMode = chatCapable ? mode : 'native'

  // Report the EFFECTIVE rendered mode up to the store so it's wired through the
  // viewState channel to the server (available signal; does not change streaming).
  useEffect(() => {
    setPanelRenderMode(sessionId, effectiveMode)
  }, [sessionId, effectiveMode, setPanelRenderMode])

  const pickMode = (m: PanelMode) => {
    // Persist the per-session override in the store (#35)…
    setPanelMode(sessionId, m)
    // …and remember the latest pick as the per-device default for not-yet-seen sessions.
    uiState.set(PANEL_MODE_DEFAULT_KEY, m)
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
  // The terminal stays mounted across a chat<->native toggle (Task 6): it's kept
  // alive (hidden under the chat overlay) with eligibility flipped via `active`
  // instead of a remount — see useTerminalSession's own setActive effect.
  const terminalActive = active && effectiveMode === 'native' && !hibernated && !exited
  const knownPathsRef = useRef<Set<string>>(new Set())
  // Latest shared chat draft for this session, mirrored into a ref so the
  // draft-flush machinery (onMounted, below) can read it at flush time
  // (chat→native sync, #17/#62) WITHOUT depending on `drafts` directly — a dep
  // there would tear down and remount the whole terminal on every keystroke.
  const draftRef = useRef('')
  draftRef.current = drafts[sessionId] ?? ''
  // Re-arm hook for the chat→native draft flush, published by onMounted below.
  // The flush machinery (one-shot guard + bounded poll) lives inside onMounted's
  // closure and otherwise only runs once, at mount. Since the terminal stays
  // mounted across a chat↔native toggle (Task 6), onMounted doesn't re-fire on
  // each toggle, so the mode-transition effect further down calls this re-arm
  // fn whenever the panel ENTERS native — re-running the flush so a chat-
  // authored draft lands in the native composer on every toggle, not just the
  // first mount.
  const rearmFlushRef = useRef<(() => void) | null>(null)
  // Latest per-frame sampler, published by onMounted. Forwarded into
  // useTerminalSession's onFrame via a stable wrapper defined before the hook
  // call (onFrame is bound at mountSession-construction time, before onMounted
  // — by the time any frame actually fires, onMounted has already run and
  // reassigned this ref, since both happen synchronously in the same effect).
  const scheduleSampleRef = useRef<() => void>(() => {})

  // Device-level terminal appearance (font size/family, line height, background).
  // `appearance` is memoized on the stored blob, so a settings change applies to
  // the LIVE terminal via useTerminalSession's setAppearance effect — no remount.
  const { settings: termSettings, appearance: termAppearance } = useTerminalAppearance()
  const termBg = termSettings.background ?? TERMINAL_DEFAULTS.background

  const {
    containerRef: termRef,
    toolbarRef,
    mountedRef,
    ready,
    atBottom,
  } = useTerminalSession({
    hub,
    sessionId,
    // Hibernated/exited (no live PTY) skip mounting. An optimistically-spawned
    // session doesn't exist server-side yet (#119) either — its one-shot attach
    // would be dropped and never retried, so hold the mount until spawnConfirmed
    // flips true (the reconcile).
    enabled: !hibernated && !exited && spawnConfirmed,
    active: terminalActive,
    // Don't grab focus on mount — that pops the soft keyboard over the
    // "Starting…" overlay. focusWhenReady takes over once the session is ready
    // (attached) AND this is the active terminal.
    focusOnMount: false,
    focusWhenReady: true,
    test: E2E,
    appearance: termAppearance,
    onFrame: () => scheduleSampleRef.current(),
    onMounted: (mounted) => {
      // Seed the file-link provider immediately after mount with whatever paths
      // are already known (from the transcript subscription effect below).
      // Without this the provider is a no-op until the next transcript callback.
      mounted.view.setFileLinks({
        cwd: session?.cwd ?? '/',
        knownPaths: knownPathsRef.current,
        onOpen: (abs) => openFile(sessionId, abs),
      })
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
        if (mounted.connection.state().role !== 'controller') return
        if (!termRef.current?.contains(document.activeElement)) return
        // Codex's empty composer shows a DIM placeholder suggestion — blank dim cells
        // (screenText dropDim) so it isn't mistaken for typed text; Claude's box needs
        // no such filter.
        const draft = scrapeComposer(mounted)
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
        if (mounted.connection.state().role !== 'controller') return false
        if (!termRef.current?.contains(document.activeElement)) return false
        const want = draftRef.current
        // Nothing to push — let the native→chat sampler own this session's draft.
        if (want === '') {
          flushTried = true
          return false
        }
        const current = scrapeComposer(mounted)
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
        mounted.connection.sendInput('\x15') // Ctrl-U
        mounted.connection.sendInput(want)
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
      scheduleSampleRef.current = scheduleSample
      // The flush above piggy-backs on onFrame, but an already-idle composer may
      // emit no frames after focus lands (and focus itself arrives a beat after
      // the first frame, via focusWhenReady above). Poll a bounded number of
      // times so the one-shot chat→native flush still fires on a quiet session;
      // it self-stops once the flush resolves (injected, or skipped because
      // empty/occupied/wrong-agent).
      let flushPoll: ReturnType<typeof setInterval> | null = null
      const startFlushPoll = () => {
        if (flushPoll) clearInterval(flushPoll)
        let flushAttempts = 0
        flushPoll = setInterval(() => {
          if (flushTried || flushAttempts++ >= 40) {
            if (flushPoll) clearInterval(flushPoll)
            flushPoll = null
            return
          }
          if (flushDraftToNative()) {
            if (flushPoll) clearInterval(flushPoll)
            flushPoll = null
          }
        }, 150)
      }
      startFlushPoll()
      // Publish the re-arm hook: reset the one-shot guard and restart the bounded
      // poll. Called by the mode-transition effect on each chat→native entry so the
      // flush re-fires for a fresh chat draft (its own guards still protect against
      // clobbering native-typed text / empty drafts).
      rearmFlushRef.current = () => {
        flushTried = false
        startFlushPoll()
      }
      return () => {
        rearmFlushRef.current = null
        scheduleSampleRef.current = () => {}
        if (sampleTimer) clearTimeout(sampleTimer)
        if (flushPoll) clearInterval(flushPoll)
      }
    },
  })

  // Native-mode dictation: transcribed speech types straight into the PTY as
  // keystrokes — no auto-submit, so the user can edit before hitting Enter.
  const voice = useVoiceInput((text) => mountedRef.current?.connection.sendInput(`${text} `))

  // Subscribe to the transcript to build the set of known absolute paths for
  // the file-link provider. Updates mountedRef.current?.view.setFileLinks so
  // links stay fresh as new tool calls land. The hub now forwards per-frame
  // DELTAS, so accumulate paths into a growing set (a reset re-seeds it empty).
  // biome-ignore lint/correctness/useExhaustiveDependencies: mountedRef is a stable ref from useTerminalSession, not app state
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

  // Re-arm the chat→native draft flush whenever the panel ENTERS native mode
  // while the terminal stays mounted (Task 6's warm toggle). The flush itself is
  // a one-shot inside the mount effect; without this it would only run at first
  // mount, so a draft typed in chat and then carried into native on a later
  // toggle would never be injected. We skip the initial mount-in-native double
  // (prevModeRef starts unset) — the mount effect already armed the poll there —
  // and only re-arm on a real chat→native transition. native→chat (and the
  // sampler direction) are untouched.
  const prevModeRef = useRef<PanelMode | null>(null)
  useEffect(() => {
    const prev = prevModeRef.current
    prevModeRef.current = effectiveMode
    if (effectiveMode !== 'native') return
    // Only a *transition* into native re-arms; the first observation (prev null)
    // is the mount-in-native case already handled by the mount effect.
    if (prev === null || prev === 'native') return
    rearmFlushRef.current?.()
  }, [effectiveMode])

  const sendKey = (key: SpecialKey): void => {
    mountedRef.current?.connection.sendInput(keySequence(key))
  }

  return (
    <div className="flex min-w-0 flex-1 flex-col">
      {/* overflow-hidden: the header's flex-none controls must CLIP at the pane
          edge. Without it a pane squeezed narrow (e.g. by an open right dock)
          spills its toolbar over the neighbouring panel. */}
      <div className="flex h-[49px] flex-none items-center gap-[9px] overflow-hidden border-b border-border bg-card px-2.5">
        {/* Agent-kind chip (Claude Code / Codex / …) + surface label + session name,
            mirroring the native pane header in the design. */}
        {session && (
          <>
            <span className="inline-flex flex-none items-center gap-[5px] rounded-md border border-border bg-secondary px-[7px] py-[3px]">
              <KindIcon kind={session.agentKind} />
              <span className="whitespace-nowrap text-xs font-semibold text-secondary-foreground">
                {panelLabel(session.agentKind)}
              </span>
            </span>
            <span className="flex-none text-[10px] font-semibold tracking-[0.06em] text-[#6c6c78]">
              {effectiveMode === 'chat' ? 'CHAT' : 'NATIVE'}
            </span>
            <span className="inline-flex min-w-0 items-center gap-[5px]">
              <span className="h-4 w-px flex-none bg-border" aria-hidden="true" />
              <span
                className="overflow-hidden text-ellipsis whitespace-nowrap text-[13px] text-foreground"
                title={sessionDisplayName(session)}
              >
                {sessionDisplayName(session)}
              </span>
            </span>
          </>
        )}
        {/* Machine badge: only when > 1 machine is connected, so single-machine
            users see no change. Shows which daemon host this session runs on. */}
        {machines.length > 1 && session?.machineName && (
          <Badge
            variant="secondary"
            className="shrink-0 font-normal text-muted-foreground"
            aria-label={`Running on ${session.machineName}`}
          >
            {session.machineName}
          </Badge>
        )}
        {/* The agent's working directory — context for which checkout/worktree this
            session runs in. Truncates; full path on hover. */}
        {session?.cwd && (
          <span
            className="hidden min-w-0 max-w-[34%] items-center gap-1 truncate text-[11px] text-muted-foreground sm:inline-flex"
            title={session.cwd}
          >
            <Folder size={11} aria-hidden="true" className="flex-none" />
            <span className="truncate">{prettyCwd(session.cwd)}</span>
          </span>
        )}
        {/* Chat/native view toggle, restored per #20 [spec:SP-9e10]. A single
            icon button showing the view a click switches TO (the header's
            CHAT/NATIVE eyebrow states the current one). SquareTerminal, not the
            plain Terminal glyph — the resume-command menu in this same row
            already uses that one. Only offered with a live PTY behind it — a
            hibernated/exited session has no terminal to switch to, so hide it
            rather than render a control that visibly does nothing. */}
        {chatCapable && !hibernated && !exited && (
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-7 flex-none text-muted-foreground"
            aria-label={
              effectiveMode === 'chat' ? 'Switch to native terminal' : 'Switch to chat view'
            }
            title={effectiveMode === 'chat' ? 'Switch to native terminal' : 'Switch to chat view'}
            onClick={() => pickMode(effectiveMode === 'chat' ? 'native' : 'chat')}
          >
            {effectiveMode === 'chat' ? (
              <SquareTerminal size={13} aria-hidden="true" />
            ) : (
              <MessageSquareText size={13} aria-hidden="true" />
            )}
          </Button>
        )}
        {/* Native resume command (#119): the literal `claude --resume <id>` etc.
            so you can pick the conversation back up in your own terminal. Shown
            whenever the harness has handed us a resume ref. As the first
            right-aligned control it carries `ml-auto`; the snooze/BTW controls
            only take it when the controls before them are absent. */}
        {resumeCmd && (
          <ResumeCommandMenu command={resumeCmd} className="ml-auto size-7 text-muted-foreground" />
        )}
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
            className={cn('size-7 text-muted-foreground', !resumeCmd && !showSnooze && 'ml-auto')}
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
            className="size-7 text-muted-foreground"
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
        {/* Archive stays available in every read-only state — both hibernated
            (process paused to free memory) and exited (process gone, transcript
            read-only). You can read the transcript and file it under Done without
            waking/resuming first. Only hidden when there's no session at all. */}
        {session && (
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className={cn('size-7 text-muted-foreground', !chatCapable && !resumeCmd && 'ml-auto')}
            title="Archive session — files it under Done"
            onClick={() => void guardedArchive(sessionId, true)}
          >
            <Archive size={13} aria-hidden="true" />
          </Button>
        )}
        {effectiveMode === 'native' && !hibernated && !exited && (
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className={cn('size-7 text-muted-foreground', !chatCapable && !resumeCmd && 'ml-auto')}
            title="Take control of the terminal"
            onClick={() => mountedRef.current?.connection.requestControl()}
          >
            <Keyboard size={13} aria-hidden="true" />
          </Button>
        )}
      </div>
      {/* Native session status line: agent dot + kind, the literal resume command
          as a copy pill, and the CLI hint — mono, like the design's sub-bar. */}
      {session && !hibernated && !exited && effectiveMode === 'native' && (
        <div className="flex h-[37px] flex-none items-center gap-2.5 overflow-hidden border-b border-border px-3 font-mono text-[11px] text-[#6c6c78]">
          <span className="inline-flex flex-none items-center gap-[5px] whitespace-nowrap text-muted-foreground">
            <span className="size-[6px] flex-none rounded-full bg-[#D97757]" aria-hidden="true" />
            {panelLabel(session.agentKind).toLowerCase()}
          </span>
          {resumeCmd && (
            <>
              <span className="flex-none text-[#3a3a46]" aria-hidden="true">
                │
              </span>
              <button
                type="button"
                title="Copy resume command"
                className="inline-flex min-w-0 flex-none items-center gap-1.5 overflow-hidden rounded-[5px] border border-border bg-background px-[7px] py-0.5 whitespace-nowrap text-muted-foreground transition-colors hover:border-muted-foreground hover:text-foreground"
                onClick={() => {
                  void navigator.clipboard
                    ?.writeText(resumeCmd)
                    .then(() => toast('Resume command copied'))
                    .catch(() => toast.error('Could not copy to clipboard'))
                }}
              >
                <span className="truncate">{resumeCmd}</span>
                <Copy size={11} aria-hidden="true" className="flex-none" />
              </button>
            </>
          )}
          <span className="ml-auto flex-none truncate text-[#6c6c78]">
            esc to interrupt · / for commands
          </span>
        </div>
      )}
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
          {/* The container is pinned to the TERMINAL's background (the default dark,
              or the user's custom color from the appearance settings) regardless of
              the app theme — otherwise a light theme shows a white container edge
              around the terminal, and a custom background a dark one. */}
          <div
            className={cn(
              'relative flex min-h-0 flex-1 flex-col',
              effectiveMode === 'chat' && 'hidden',
            )}
            style={{ backgroundColor: termBg }}
          >
            <div ref={termRef} className="term min-h-0 flex-1 px-3 py-2" />
            {!ready && (
              <div
                className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-3 text-[13px] text-zinc-400"
                style={{ backgroundColor: termBg }}
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
            {echoHudEnabled() && <EchoHud hub={hub} mountedRef={mountedRef} />}
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
  const { resurrectSession, killSession } = useStoreSelector(
    (s) => ({ resurrectSession: s.resurrectSession, killSession: s.killSession }),
    shallowEqual,
  )
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
  const { resurrectSession, killSession } = useStoreSelector(
    (s) => ({ resurrectSession: s.resurrectSession, killSession: s.killSession }),
    shallowEqual,
  )
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
  const resurrectSession = useStoreSelector((s) => s.resurrectSession)
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
  const resurrectSession = useStoreSelector((s) => s.resurrectSession)
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

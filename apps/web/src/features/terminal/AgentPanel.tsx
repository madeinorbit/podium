import { randomUUID } from '@podium/client-core/id'
import { beginSwitch, isSwitchTraced, markSwitch } from '@podium/client-core/perf'
import { shallowEqual } from '@podium/client-core/store'
import { effectivePanelMode, type PanelMode } from '@podium/client-core/ui-state'

export { effectivePanelMode, effectivePanelMode as initialPanelMode, type PanelMode }

import { attentionGroup } from '@podium/client-core/focus'
import { formatClock, panelLabel, resumeCommand } from '@podium/client-core/viewmodels'
import type { SessionId } from '@podium/model'
import { isSnoozed } from '@podium/model'
import { SWITCH_TRACE_MARKS } from '@podium/protocol'
import { keySequence, type SpecialKey } from '@podium/terminal-client'
import { ArrowSwipeKey, useTerminalSession, useVoiceInput } from '@podium/terminal-client-react'
import {
  Archive,
  ArrowDownToLine,
  Ellipsis,
  Folder,
  Keyboard,
  MessageSquareText,
  Mic,
  Moon,
  Sparkles,
  SquareTerminal,
  Terminal as TerminalIcon,
} from 'lucide-react'
import type { JSX } from 'react'
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import { OPEN_RIGHT_PANEL_EVENT } from '@/app/shell-state'
import { useReplicaIssues, useStoreSelector } from '@/app/store'
import { GitStamp } from '@/components/GitStamp'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { ChatView } from '@/features/chat/ChatView'
import { accumulateFileLinkPaths } from '@/features/chat/chat'
import { OfferBar } from '@/features/chat/OfferBar'
import { agentBrandDot } from '@/lib/agent-tone'
import { useSessionGuard } from '@/lib/hooks/use-session-guard'
import { effectiveIssueColorHex } from '@/lib/issueColors'
import { isKnownRefPrefix } from '@/lib/markdown'
import { activateRef } from '@/lib/ref-activation'
import { SnoozeControl } from '@/lib/SnoozeControl'
import { useNow } from '@/lib/useNow'
import { cn } from '@/lib/utils'
import { KindIcon, sessionDisplayName } from '@/lib/WorkerLabel'
import { applyInitialTerminalAppearance, paneTintedBackground, withBackground } from './appearance'
import { createDraftSync } from './draft-sync'
import { EchoHud, echoHudEnabled } from './EchoHud'
import { HandoverPane, useHandoverView } from './HandoverPane'
import { hibernateAction } from './lifecycle-actions'
import { ExitedBanner, ExitedPane, HibernatedBanner, HibernatedPane } from './SessionLifecyclePanes'
import { SessionWatchers } from './SessionWatchers'
import { sessionAgeMs, startupOverlay } from './startup-overlay'
import { usePanelSurface } from './use-panel-surface'
import { useTerminalAppearance } from './use-terminal-appearance'

// Opt-in browser-test hook: `?e2e=1` exposes `globalThis.__podium` on the mounted
// session (screenText/sendInput/simulateKeyboard/…) for the Playwright harness under
// tests/e2e/browser. Off by default, so normal sessions never expose the input API.
const E2E = typeof window !== 'undefined' && new URLSearchParams(window.location.search).has('e2e')

/** Collapse the user's home directory to `~` for a compact cwd display. */
export function prettyCwd(path: string): string {
  return path.replace(/^\/(?:home|Users)\/[^/]+/, '~')
}

/** Effort tiers, compacted to header width. Unknown spellings pass through. */
const EFFORT_SHORT: Record<string, string> = {
  low: 'low',
  medium: 'med',
  high: 'high',
  xhigh: 'xhigh',
  max: 'max',
}

/**
 * The header's model token [POD-121]: "fable 5 · med". The model is the
 * transcript-OBSERVED one when known (`observedModel` — resolves a spawn-time
 * `auto` and follows `/model` switches), else the spawn selection — including
 * an explicit "auto", shown literally until observation resolves it [POD-158].
 * Effort renders even before any model is known ("· med"→ effort-only label).
 * Null only when neither a model nor an effort is known.
 *
 * Id compaction: "claude-fable-5" → "fable 5", "claude-opus-4-8" → "opus 4.8",
 * "claude-haiku-4-5-20251001" → "haiku 4.5" (date suffix dropped, consecutive
 * numeric parts join as a dotted version).
 */
export function modelToken(session: {
  observedModel?: string
  observedEffort?: string
  model?: string
  effort?: string
}): string | null {
  const raw = session.observedModel ?? session.model
  let label: string | undefined
  if (raw === 'auto') {
    label = 'auto'
  } else if (raw) {
    const parts = raw
      .replace(/^claude-/, '')
      .replace(/-\d{8}$/, '')
      .split('-')
    const words: string[] = []
    for (const part of parts) {
      const last = words.at(-1)
      if (/^\d+$/.test(part) && last !== undefined && /^\d/.test(last)) {
        words[words.length - 1] = `${last}.${part}`
      } else {
        words.push(part)
      }
    }
    label = words.join(' ')
  }
  const rawEffort =
    session.observedEffort ??
    (session.effort && session.effort !== 'auto' ? session.effort : undefined)
  const effort = rawEffort ? (EFFORT_SHORT[rawEffort] ?? rawEffort) : undefined
  if (!label) return effort ?? null
  return effort ? `${label} · ${effort}` : label
}

export function AgentPanel({
  sessionId,
  active = true,
}: {
  sessionId: SessionId
  /** False when this panel is mounted but hidden (an inactive tab kept warm so
   *  switching back catches up instead of wiping). Gates focus, nothing else. */
  active?: boolean
}): JSX.Element {
  const {
    hub,
    sessions,
    pendingSpawnIds,
    machines,
    trpc,
    drafts,
    startBtw,
    setSessionDraft,
    hibernateSession,
    openFile,
    uiState,
    selectedIssueId,
  } = useStoreSelector(
    (s) => ({
      hub: s.hub,
      sessions: s.sessions,
      pendingSpawnIds: s.pendingSpawnIds,
      machines: s.machines,
      // `repos` is deliberately NOT selected (POD-1704). Its only use here was the
      // worktree-missing guess; subscribing to it re-rendered every agent panel on
      // each repo scan for a fact the panel had no business deriving.
      trpc: s.trpc,
      drafts: s.drafts,
      startBtw: s.startBtw,
      setSessionDraft: s.setSessionDraft,
      hibernateSession: s.hibernateSession,
      openFile: s.openFile,
      uiState: s.uiState,
      selectedIssueId: s.selectedIssueId,
    }),
    shallowEqual,
  )
  const issues = useReplicaIssues()
  const { guardedArchive } = useSessionGuard()
  const session = sessions.find((s) => s.sessionId === sessionId)
  // An optimistically-spawned session doesn't exist server-side yet (#119): the
  // terminal's one-shot `hub.attach` would be dropped and never retried, leaving
  // the pane black. Hold the mount until the real session reconciles in — the
  // "Starting…" overlay covers the wait, and the mount effect (which depends on
  // this) fires the instant it flips true.
  const spawnConfirmed = !pendingSpawnIds.has(sessionId)
  const traceIssueId = session?.issueId ?? selectedIssueId ?? null
  const freshStartTracedRef = useRef(false)
  // A fresh optimistic spawn has no existing session-tab click to start a
  // trace. Fast spawns can already be reconciled by the time this panel lays
  // out, so use the first active layout as the fallback boundary too. Do not
  // replace a trace already armed by Workspace's tab gesture.
  useLayoutEffect(() => {
    if (freshStartTracedRef.current || !active) return
    freshStartTracedRef.current = true
    if (!isSwitchTraced(sessionId)) beginSwitch({ sessionId, issueId: traceIssueId })
  }, [active, sessionId, traceIssueId])
  // Moving to another machine ([spec:SP-3f7a]) is one deliberate state, not the
  // sequence of read-only states the move happens to pass through: the session is
  // stopped here, shipped, and resumed there. `handover` covers the pane for the
  // whole window (and one beat past it, over the reattaching terminal), so
  // `inTransit` suppresses the parked-transcript fallback underneath it.
  const handover = useHandoverView(session)
  const inTransit = handover?.phase === 'transit'
  // Re-arm hook for the chat→native draft flush, published by onMounted below.
  // Declared here because the arbitration hook owns the chat→native EDGE and
  // calls it; the flush machinery itself lives in the mount closure.
  const rearmFlushRef = useRef<(() => void) | null>(null)
  // THE ARBITRATION (POD-408). `surface` says which of the four states this panel
  // is in and, when live, which view; `gates` are every "may I" the panel used to
  // re-spell from `!hibernated && !exited && …` at eight separate call sites.
  const {
    surface,
    gates,
    mode: effectiveMode,
    chatCapable,
    pickMode,
  } = usePanelSurface({
    sessionId,
    session,
    paneActive: active,
    spawnConfirmed,
    inTransit,
    onEnterNative: () => rearmFlushRef.current?.(),
  })
  const pickModeWithTrace = (mode: PanelMode): void => {
    if (active && mode !== effectiveMode) {
      beginSwitch({ sessionId, issueId: traceIssueId })
    }
    pickMode(mode)
  }

  // Switch-latency trace marks [POD-701] — both are no-ops (one null check in
  // markSwitch) unless a switch to THIS session is being traced.
  // `panel:mount`: this panel mounted cold (evicted from the warm set, or a
  // first open) during the switch — the trace's `cold` indicator.
  useEffect(() => {
    markSwitch(sessionId, 'panel:mount')
  }, [sessionId])
  // `panel:active`: the pane became the visible one.
  const prevActiveForTrace = useRef(false)
  useEffect(() => {
    if (active && !prevActiveForTrace.current) {
      markSwitch(sessionId, 'panel:active', { mode: effectiveMode })
    }
    prevActiveForTrace.current = active
  }, [active, sessionId, effectiveMode])

  // The native CLI resume command for this session (#119), or null when no
  // resume ref is known. Also the first right-aligned header control, so the
  // `ml-auto` fallbacks below defer to it when present.
  const resumeCmd = session ? resumeCommand(session) : null
  // Manual hibernation, as a descriptor: whether it applies at all and why it is
  // blocked come from the SHARED eligibility rule (`sessionMenuEligibility`, also
  // read by the session context menu and the command palette) rather than from a
  // fourth local spelling of it.
  const hibernate = hibernateAction(session)
  // Device fact, not arbitration: the header drops the snooze control on a narrow
  // screen. (The arbitration hook reads the same query for the mode default; that
  // one is a MODE input, this one is a layout one, so they stay separate.)
  const isMobile = typeof window !== 'undefined' && window.matchMedia('(max-width: 768px)').matches
  const snoozeNow = useNow(60_000)
  // Offer snooze in the full view when the session is in (or already snoozed out
  // of) the attention surface — not for actively-working or parked sessions.
  const showSnooze =
    !!session &&
    surface.kind === 'live' &&
    (attentionGroup(session) !== 'working' || isSnoozed(session, snoozeNow))
  // Agent action offer [spec:SP-c7f1] in NATIVE mode: chat renders its own bar
  // above the composer; this one sits beneath the PTY so an offer is visible in
  // both views. Same optimistic-hide contract as chat: dismissed the moment a
  // button is clicked (keyed by createdAt so a NEW offer re-shows), and the
  // prompt goes out via sessions.sendText — the user-turn path the server
  // auto-clears the offer on. Raw PTY keystrokes deliberately don't clear it.
  const [dismissedOfferAt, setDismissedOfferAt] = useState<string | null>(null)
  const nativeOffer =
    gates.offerDockOffered && session?.offer && session.offer.createdAt !== dismissedOfferAt
      ? session.offer
      : null
  // Keep the last offer rendered while the dock animates closed (POD-178): the
  // grid-rows collapse needs content in the DOM to animate over.
  const lastOfferRef = useRef<NonNullable<typeof session>['offer'] | null>(null)
  if (nativeOffer) lastOfferRef.current = nativeOffer
  const dockOffer = nativeOffer ?? lastOfferRef.current
  const sendOfferPrompt = async (prompt: string, offerAt: string) => {
    setDismissedOfferAt(offerAt)
    try {
      await trpc.sessions.sendText.mutate({ sessionId, text: prompt, mutationId: randomUUID() })
    } catch (cause) {
      setDismissedOfferAt(null) // send failed — let the offer reappear
      toast.error('Could not send the suggested action')
      throw cause
    }
  }
  // Dock <-> PTY resize sync [POD-201]: the 340ms slide used to fight the
  // mount's debounced ResizeObserver — the PTY re-gridded at an arbitrary
  // mid-animation size, then again after transitionEnd. Instead the terminal
  // surface is PINNED at a fixed height for the duration of the slide (its box
  // never changes mid-animation, so the observer stays quiet) and the PTY fits
  // exactly once at the synced moment: on OPEN it snaps to its final grid as
  // the slide starts, and the dock animates into the vacated band; on CLOSE it
  // grows once at transitionEnd (which also unpins). `dockOpen` lags the offer
  // by one frame so a freshly mounted dock still gets its enter transition.
  const dockOpenTarget = Boolean(nativeOffer)
  const [dockOpen, setDockOpen] = useState(false)
  const termSurfaceRef = useRef<HTMLDivElement | null>(null)
  const dockInnerRef = useRef<HTMLDivElement | null>(null)
  const dockUnpinRef = useRef<(() => void) | null>(null)
  const dockUnpinFallbackRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  // biome-ignore lint/correctness/useExhaustiveDependencies: mountedRef is a stable ref from useTerminalSession, not app state
  useLayoutEffect(() => {
    if (dockOpen === dockOpenTarget) return
    const termSurface = termSurfaceRef.current
    const reduced =
      typeof window !== 'undefined' &&
      window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
    // `ptySizingAllowed` — not `mode === 'native'` — is the gate. A warm panel
    // that is not the visible pane is `display:none` (PanelDeck) and measures
    // ZERO, so pinning and fitting from here would re-grid a live PTY to a box
    // nobody is looking at. Same flag the engine derives viewState `visible`
    // from, which is what makes this the visibility foundation and not a
    // second, private opinion about what is on screen.
    if (!termSurface || reduced || !gates.ptySizingAllowed) {
      setDockOpen(dockOpenTarget)
      return
    }
    dockUnpinRef.current?.()
    const height = termSurface.getBoundingClientRect().height
    const dockHeight = dockInnerRef.current?.offsetHeight ?? 0
    termSurface.style.flex = 'none'
    termSurface.style.height = `${Math.max(0, dockOpenTarget ? height - dockHeight : height)}px`
    dockUnpinRef.current = () => {
      dockUnpinRef.current = null
      termSurface.style.flex = ''
      termSurface.style.height = ''
    }
    if (dockOpenTarget) {
      void termSurface.offsetHeight // reflow so fit() measures the pinned size
      const m = mountedRef.current
      if (m) {
        const grid = m.view.fit()
        if (grid) m.connection.sendResize(grid.cols, grid.rows)
        m.view.scrollToBottom()
      }
    }
    requestAnimationFrame(() => setDockOpen(dockOpenTarget))
    // Backstop: transitionEnd is the normal unpin; if it never fires (hidden
    // tab, interrupted transition) release the surface after the slide should
    // have settled so the terminal doesn't stay frozen at a stale height.
    if (dockUnpinFallbackRef.current !== undefined) clearTimeout(dockUnpinFallbackRef.current)
    dockUnpinFallbackRef.current = setTimeout(() => dockUnpinRef.current?.(), 700)
  }, [dockOpen, dockOpenTarget, gates.ptySizingAllowed])
  const knownPathsRef = useRef<Set<string>>(new Set())
  // Latest shared chat draft for this session, mirrored into a ref so the
  // draft-flush machinery (onMounted, below) can read it at flush time
  // (chat→native sync, #17/#62) WITHOUT depending on `drafts` directly — a dep
  // there would tear down and remount the whole terminal on every keystroke.
  const draftRef = useRef('')
  draftRef.current = drafts[sessionId] ?? ''
  // Draft Sync v2 (POD-859): when the session's daemon runs the composer engine, it
  // owns native scrape + chat→native inject — so this client retires BOTH its 150ms
  // native sampler and its one-shot chat→native flush. Read via a ref so the runtime
  // check needs no effect dep (no terminal remount when the capability flips on).
  const draftEngineRef = useRef(false)
  draftEngineRef.current = session?.draftSyncEngine === true
  // (`rearmFlushRef` is declared above the arbitration hook, which owns the
  // chat→native edge that calls it: the flush machinery — one-shot guard plus
  // bounded poll — lives inside onMounted's closure and otherwise only runs once,
  // at mount. The terminal stays mounted across a chat↔native toggle (Task 6), so
  // onMounted does NOT re-fire per toggle; without the re-arm a draft typed in
  // chat and carried into native on a later toggle would never be injected.)
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
  // The terminal floats on the pane's issue-tinted surface (native-pane spec
  // §2.5): the selected issue's colour (slate flow when uncoloured) mixed over
  // the terminal base, mirrored into the xterm theme via setAppearance — no
  // remount. A user-set custom background wins over the tint (Q6).
  const selectedIssue = selectedIssueId
    ? issues.find((i) => i.id === selectedIssueId && !i.archived && !i.deletedAt)
    : undefined
  // The SESSION's own issue (not the pane selection) — owns the git stamp
  // [POD-98]. Explicit attachment wins; else the worktree containing the cwd.
  const stampIssue = (issues ?? []).find(
    (i) =>
      !i.deletedAt &&
      !i.archived &&
      (session?.issueId === i.id ||
        (i.worktreePath !== null &&
          session?.cwd !== undefined &&
          (session.cwd === i.worktreePath || session.cwd.startsWith(`${i.worktreePath}/`)))),
  )
  // Same flow-colour resolution as the shell root (own colour, else nearest
  // coloured ancestor) so the terminal never disagrees with the pane chrome.
  const issueHex = effectiveIssueColorHex(selectedIssue, (id) => issues.find((i) => i.id === id))
  const termBg = termSettings.background ?? paneTintedBackground(issueHex)
  const appearance = useMemo(
    () => (termSettings.background ? termAppearance : withBackground(termAppearance, termBg)),
    [termSettings.background, termAppearance, termBg],
  )
  // The hook's mount effect already receives the terminal-client defaults. Apply
  // the panel tint directly after mount so its initial appearance does not
  // schedule a second, identical fit. Custom font metrics still get one fit
  // when the pane is eligible; hidden panes wait for their normal reveal path.
  const initialAppearanceAppliedRef = useRef<typeof appearance | null>(null)
  const canFitInitialAppearance =
    gates.ptySizingAllowed &&
    (typeof document === 'undefined' || document.visibilityState === 'visible')

  const {
    containerRef: termRef,
    toolbarRef,
    mountedRef,
    ready,
    outputSeen,
    atBottom,
  } = useTerminalSession({
    hub,
    sessionId,
    // Only a LIVE surface has a PTY behind it: hibernated/exited have no process,
    // and a session in transit is about to lose its PTY and come back on another
    // machine (stay unmounted until it lands, so the attach that runs is the one
    // against the new daemon). An optimistically-spawned session doesn't exist
    // server-side yet (#119) either — its one-shot attach would be dropped and
    // never retried, so `spawnConfirmed` holds the mount until the reconcile.
    enabled: gates.terminalMounted,
    // The terminal stays mounted across a chat<->native toggle (Task 6): it's
    // kept alive (hidden under the chat overlay) with eligibility flipped here
    // instead of by a remount — see useTerminalSession's own setActive effect.
    active: gates.terminalActive,
    // Don't grab focus on mount — that pops the soft keyboard over the
    // "Starting…" overlay. focusWhenReady takes over once the session is ready
    // (attached) AND this is the active terminal.
    focusOnMount: false,
    focusWhenReady: true,
    test: E2E,
    // Applied synchronously in onMounted below. Passing it here would make
    // useTerminalSession apply it a second time in its initial appearance
    // effect, which also schedules a redundant fit.
    onFrame: () => scheduleSampleRef.current(),
    onMounted: (mounted) => {
      applyInitialTerminalAppearance(mounted, appearance, canFitInitialAppearance)
      initialAppearanceAppliedRef.current = appearance
      // Seed the file-link provider immediately after mount with whatever paths
      // are already known (from the transcript subscription effect below).
      // Without this the provider is a no-op until the next transcript callback.
      mounted.view.setFileLinks({
        cwd: session?.cwd ?? '/',
        knownPaths: knownPathsRef.current,
        onOpen: (abs) => openFile(sessionId, abs),
      })
      // Human-facing ref links (#474): PREFIX-N tokens in agent output become
      // clickable — plain opens the miniview, Cmd/Ctrl jumps to the full view.
      mounted.view.setRefLinks({
        isKnownPrefix: (p) => isKnownRefPrefix(p),
        onActivate: (ref, event) => activateRef(ref, event),
      })
      // Draft sync between the PTY and chat, both directions (#17/#62/#53,
      // POD-859). Everything it needs from React arrives as a getter, so no
      // closure here can capture a stale render's value; the chat->native edge
      // that re-arms the one-shot flush is owned by the arbitration hook above.
      const sync = createDraftSync({
        mounted,
        agentKind: session?.agentKind,
        hasFocus: () => !!termRef.current?.contains(document.activeElement),
        draft: () => draftRef.current,
        engineActive: () => draftEngineRef.current,
        publish: (text) => setSessionDraft(sessionId, text),
      })
      scheduleSampleRef.current = sync.scheduleSample
      rearmFlushRef.current = sync.rearm
      return () => {
        rearmFlushRef.current = null
        scheduleSampleRef.current = () => {}
        sync.dispose()
      }
    },
  })

  // Keep later appearance changes on the shared, eligibility-gated path. The
  // initial mount is handled directly above because the hook's first appearance
  // effect would otherwise fit the same theme twice.
  useEffect(() => {
    const mounted = mountedRef.current
    const previous = initialAppearanceAppliedRef.current
    if (!mounted || previous === appearance) return
    mounted.setAppearance(appearance)
    initialAppearanceAppliedRef.current = appearance
  }, [appearance, mountedRef])

  // `term:ready` is transport/UI-ready: it can come from attach, first output,
  // or the timeout backstop. The interactable mark is stricter: this visible
  // mounted terminal has a connected PTY, so xterm can receive keystrokes.
  // Retry through reveal/layout frames for warm native switches; a timeout
  // trace remains evidence if the terminal never reaches this boundary.
  // There is no shorter frame cap: the collector's 10s deadline is the
  // confirmation window. timedOut means keystroke readiness was unconfirmed,
  // not that the terminal took 10s.
  // biome-ignore lint/correctness/useExhaustiveDependencies: mountedRef is a stable ref from useTerminalSession, not app state.
  useEffect(() => {
    if (!active || !gates.terminalActive || !ready || !isSwitchTraced(sessionId)) return
    let cancelled = false
    let frame: number | undefined

    const check = (): void => {
      if (cancelled || !isSwitchTraced(sessionId)) return
      const mounted = mountedRef.current
      const surface = termSurfaceRef.current
      const rects = surface?.getClientRects() ?? []
      if (!mounted || rects.length === 0 || !mounted.connection.state().connected) {
        if (typeof requestAnimationFrame === 'function') frame = requestAnimationFrame(check)
        else return
        return
      }
      markSwitch(sessionId, SWITCH_TRACE_MARKS.termInteractable, {
        terminalConnected: true,
        terminalVisible: true,
        terminalReady: true,
      })
    }

    if (typeof requestAnimationFrame === 'function') frame = requestAnimationFrame(check)
    else check()
    return () => {
      cancelled = true
      if (frame !== undefined) cancelAnimationFrame(frame)
    }
  }, [active, gates.terminalActive, ready, sessionId])

  // A terminal that has painted NOTHING keeps its startup affordance instead of
  // revealing a blank surface [POD-385]. `outputSeen` is the server's durable
  // "has this PTY ever spoken", so a child that is genuinely still booting — a
  // CLI that self-updates on launch went four minutes silent once — is told
  // apart from a session whose screen we merely don't hold (POD-379's case,
  // where dropping the overlay at attach is right). The per-second clock runs
  // only while such a wait is actually on screen in this pane.
  const silenceNow = useNow(1_000, gates.terminalActive && (!ready || !outputSeen))
  const overlay = startupOverlay({
    ready,
    outputSeen,
    ageMs: sessionAgeMs(session?.createdAt, silenceNow),
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

  const sendKey = (key: SpecialKey): void => {
    mountedRef.current?.connection.sendInput(keySequence(key))
  }

  return (
    // `relative` anchors the handover veil below the header (the terminal surface
    // positions its own overlays against itself, so nothing else moves).
    <div className="relative flex min-w-0 flex-1 flex-col">
      {/* Session header, revised Variant A [POD-121]: 40px, issue-tinted surface
          + hairline. Identity is de-boxed (kind glyph + name as the anchor), the
          mode lives in ONE segmented control on the right (no eyebrow), and the
          right cluster is model token · segment · snooze · archive · overflow. */}
      <div
        data-testid="agent-panel-header"
        className="flex h-[40px] flex-none items-center overflow-hidden gap-2 border-b issue-hairline-45 issue-hairline-slate-40 issue-mix-24 issue-mix-slate-18 px-[10px]"
      >
        {session && (
          <>
            <KindIcon kind={session.agentKind} />
            <span
              className="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap text-[12.5px] font-semibold text-text-strong"
              title={sessionDisplayName(session)}
            >
              {sessionDisplayName(session)}
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
            className="hidden min-w-0 max-w-[34%] items-center gap-1 truncate text-[10.5px] text-(--issue-muted-bright) sm:inline-flex"
            title={session.cwd}
          >
            <Folder size={11} aria-hidden="true" className="flex-none" />
            <span className="truncate">{prettyCwd(session.cwd)}</span>
          </span>
        )}
        {/* Git stamp [POD-98]: has this task committed, and on which branch —
            always visible for the session you're reading; click opens the Git
            dock panel. Hidden when the session's issue has no probed state. */}
        {stampIssue && (
          <GitStamp
            issueBranch={stampIssue.branch}
            git={stampIssue.gitState}
            density="chip"
            className="hidden flex-none md:inline-flex"
            onClick={() =>
              window.dispatchEvent(new CustomEvent(OPEN_RIGHT_PANEL_EVENT, { detail: 'git' }))
            }
          />
        )}
        {/* Right cluster [POD-121]: model token · mode segment · the triage pair
            (snooze, archive) · overflow. Transient utilities (take control, copy
            resume, ask superagent, hibernate) live in the overflow menu. */}
        <span className="ml-auto inline-flex flex-none items-center gap-2">
          {/* Who else is on this session [POD-1535] — ADR 7's rooms, surfaced.
              Renders in every session state (a watcher may be reading an
              exited transcript with you), and distinguishes "only you" from
              "we do not know" rather than collapsing both to blank. */}
          <SessionWatchers sessionId={sessionId} view={effectiveMode} />
          {/* The running model + requested effort ("fable 5 · med"): observed
              model from the transcript tail (resolves a spawn-time `auto`),
              effort from the spawn selection — hidden until either is known. */}
          {session && modelToken(session) && (
            <span
              className="hidden flex-none items-center gap-[5px] font-mono text-[10px] text-(--issue-muted) lg:inline-flex"
              title={
                session.observedModel
                  ? `Model observed in the transcript${session.effort ? ' · effort as requested at spawn' : ''}`
                  : 'Model as requested at spawn'
              }
            >
              {/* Brand mark for harnesses that have one — a table lookup, so a new
                  harness adds a row rather than another branch here. */}
              {agentBrandDot(session.agentKind) && (
                <span
                  className={cn(
                    'size-[6px] flex-none rounded-full',
                    agentBrandDot(session.agentKind),
                  )}
                  aria-hidden="true"
                />
              )}
              {modelToken(session)}
            </span>
          )}
          {/* Mode switch [POD-121, replaces #20's toggle]: one two-segment
              control — both views always visible and labeled, the filled segment
              is the current one. Only offered with a live PTY behind it — a
              hibernated/exited session has no terminal to switch to. */}
          {gates.modeSwitchOffered && (
            <span
              role="tablist"
              aria-label="Panel view"
              className="inline-flex h-[26px] flex-none items-stretch overflow-hidden rounded-[7px] border issue-hairline-30 bg-background/45"
            >
              {(['chat', 'native'] as const).map((m) => (
                <button
                  data-pressable
                  key={m}
                  type="button"
                  role="tab"
                  aria-selected={effectiveMode === m}
                  data-testid={`mode-${m}`}
                  className={cn(
                    'inline-flex cursor-pointer items-center gap-[5px] px-[9px] text-[11px] font-medium transition-colors',
                    m === 'native' && 'border-l issue-hairline-20',
                    effectiveMode === m
                      ? 'bg-secondary text-text-strong'
                      : 'text-(--issue-muted) hover:text-(--issue-bright)',
                  )}
                  onClick={() => pickModeWithTrace(m)}
                >
                  {m === 'chat' ? (
                    <MessageSquareText size={12} aria-hidden="true" />
                  ) : (
                    <SquareTerminal size={12} aria-hidden="true" />
                  )}
                  {m === 'chat' ? 'Chat' : 'Native'}
                </button>
              ))}
            </span>
          )}
          <span className="inline-flex flex-none items-center gap-[3px]">
            {!isMobile && showSnooze && session && (
              <SnoozeControl session={session} iconSize={15} dimmed={false} />
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
                className="size-[26px] rounded-[6px] text-(--issue-muted-bright)"
                title="Archive session — files it under Done"
                onClick={() => void guardedArchive(sessionId, true)}
              >
                <Archive size={13} aria-hidden="true" />
              </Button>
            )}
            {session && (
              // modal={false}: a modal menu loses the focus fight with the
              // terminal underneath (xterm re-grabs focus, the menu closes on
              // open) — same setting the issue-page property menus use.
              <DropdownMenu modal={false}>
                <DropdownMenuTrigger
                  render={
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      data-testid="header-menu"
                      className="size-[26px] rounded-[6px] text-(--issue-muted-bright)"
                      title="More session actions"
                      aria-label="More session actions"
                    >
                      <Ellipsis size={14} aria-hidden="true" />
                    </Button>
                  }
                />
                <DropdownMenuContent
                  align="end"
                  className="w-auto min-w-[236px] max-w-[90vw] p-[5px] **:data-[slot=dropdown-menu-item]:gap-[9px] **:data-[slot=dropdown-menu-item]:px-[9px] **:data-[slot=dropdown-menu-item]:py-[6px] **:data-[slot=dropdown-menu-item]:text-[12px]"
                >
                  {gates.takeControlOffered && (
                    <DropdownMenuItem
                      data-testid="take-control"
                      aria-label="Take control of the terminal"
                      onClick={() => mountedRef.current?.connection.requestControl()}
                    >
                      <Keyboard size={13} aria-hidden="true" /> Take control
                    </DropdownMenuItem>
                  )}
                  {/* Native resume command (#119): one glanceable item — the verb
                      up top, the literal command as a mono sub-line. (No
                      DropdownMenuLabel here: Base UI's GroupLabel throws outside a
                      Group and the popup then silently never opens.) */}
                  {resumeCmd && (
                    <DropdownMenuItem
                      onClick={() => {
                        void navigator.clipboard
                          ?.writeText(resumeCmd)
                          .then(() => toast('Resume command copied'))
                          .catch(() => toast.error('Could not copy to clipboard'))
                      }}
                    >
                      <TerminalIcon
                        size={13}
                        aria-hidden="true"
                        className="translate-y-[3px] self-start"
                      />
                      <span className="min-w-0">
                        Copy resume command
                        <span
                          className="mt-px block max-w-[26ch] truncate font-mono text-[9.5px] text-muted-foreground"
                          title={resumeCmd}
                        >
                          {resumeCmd}
                        </span>
                      </span>
                    </DropdownMenuItem>
                  )}
                  {chatCapable && (
                    <DropdownMenuItem onClick={() => void startBtw(sessionId)}>
                      <Sparkles size={13} aria-hidden="true" /> Ask superagent
                      <DropdownMenuShortcut>/btw</DropdownMenuShortcut>
                    </DropdownMenuItem>
                  )}
                  {hibernate && (
                    <>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem
                        data-testid="lifecycle-hibernate"
                        disabled={hibernate.disabledReason !== null}
                        {...(hibernate.disabledReason ? { title: hibernate.disabledReason } : {})}
                        onClick={() => void hibernateSession(sessionId)}
                      >
                        <Moon size={13} aria-hidden="true" /> {hibernate.label}
                      </DropdownMenuItem>
                    </>
                  )}
                </DropdownMenuContent>
              </DropdownMenu>
            )}
          </span>
        </span>
      </div>
      {session?.condition === 'logged-out' && (
        <div
          role="status"
          className="flex flex-none items-center gap-2 border-b border-warning/30 bg-warning/10 px-3 py-2 text-xs text-warning"
        >
          <strong>{panelLabel(session.agentKind)} isn&apos;t logged in</strong>
          <span>Run its login command in this pane to continue.</span>
        </div>
      )}
      {handover && <HandoverPane view={handover} background={termBg} />}
      {surface.kind === 'transit' ? (
        // The veil owns this window; underneath it only the pane's own surface
        // shows, so a mid-move status change (live → parked) never repaints a
        // view the operator didn't ask for.
        <div className="flex-1" style={{ backgroundColor: termBg }} />
      ) : surface.kind === 'parked' ? (
        surface.view === 'transcript' ? (
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
      ) : surface.kind === 'ended' && session ? (
        surface.view === 'transcript' ? (
          // The process is gone but the transcript outlives it — keep the chat
          // readable (and resumable via the composer) with a banner, instead of
          // replacing it with a dead-end pane. Shells (no transcript) still get it.
          <>
            <ExitedBanner
              sessionId={sessionId}
              exitCode={session.exitCode}
              spawnFailure={session.spawnFailure}
              isShell={session.agentKind === 'shell'}
              resumable={session.resumable === true}
            />
            <ChatView sessionId={sessionId} active={active} />
          </>
        ) : (
          <ExitedPane
            sessionId={sessionId}
            exitCode={session.exitCode}
            spawnFailure={session.spawnFailure}
            isShell={session.agentKind === 'shell'}
            resumable={session.resumable === true}
          />
        )
      ) : (
        // Warm chat<->native toggle (Task 6): the terminal container stays
        // mounted in BOTH modes — `hidden` (display:none) when in chat — so
        // switching modes never disposes and re-attaches the PTY. ChatView is
        // rendered as a sibling overlay on top when in chat mode.
        <>
          {effectiveMode === 'chat' && <ChatView sessionId={sessionId} active={active} />}
          {/* The container is pinned to the TERMINAL's background — the pane's
              issue tint (§2.5), or the user's custom color from the appearance
              settings — regardless of the app theme: otherwise a light theme
              shows a white container edge around the terminal, and a custom
              background a dark one. */}
          <div
            ref={termSurfaceRef}
            data-testid="terminal-surface"
            className={cn(
              'relative flex min-h-0 flex-1 flex-col',
              effectiveMode === 'chat' && 'hidden',
            )}
            style={{ backgroundColor: termBg }}
          >
            <div ref={termRef} className="term min-h-0 flex-1 px-[13px] pt-3 pb-5" />
            {overlay.kind !== 'hidden' && (
              <div
                className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-3 px-8 text-center text-[13px] text-zinc-400"
                style={{ backgroundColor: termBg }}
                data-testid="terminal-startup-overlay"
                role="status"
                aria-live="polite"
              >
                <span
                  className="size-[22px] animate-spin rounded-full border-2 border-zinc-700 border-t-zinc-300"
                  aria-hidden="true"
                />
                <span>Starting {session ? panelLabel(session.agentKind) : 'session'}…</span>
                {/* Machine voice, mono and tabular so the digits don't jitter.
                    aria-hidden: a per-second counter inside a live region would
                    re-announce itself every tick; the lines around it carry the
                    meaning a screen reader needs. */}
                {overlay.kind === 'silent' && overlay.elapsedMs !== null && (
                  <span
                    className="font-mono text-[11px] text-zinc-500 tabular-nums"
                    data-testid="startup-silence"
                    aria-hidden="true"
                  >
                    no output yet · {formatClock(overlay.elapsedMs)}
                  </span>
                )}
                {overlay.kind === 'silent' && overlay.hint && (
                  <span className="max-w-[44ch] text-[11px] text-balance text-zinc-500 leading-relaxed">
                    Still attached — some CLIs update themselves or run first-time setup before
                    printing anything.
                  </span>
                )}
              </div>
            )}
            {ready && !atBottom && (
              <Button
                type="button"
                variant="secondary"
                size="sm"
                className="absolute bottom-3 left-1/2 z-[4] -translate-x-1/2 rounded-full bg-muted text-foreground shadow-[0_4px_14px_var(--carve-popover-near)] hover:border-primary"
                onClick={() => mountedRef.current?.view.scrollToBottom()}
              >
                <ArrowDownToLine size={13} aria-hidden="true" /> Jump to bottom
              </Button>
            )}
            {echoHudEnabled(uiState) && <EchoHud hub={hub} mountedRef={mountedRef} />}
          </div>
          {/* Prompt-area chrome (§2.6, Q1 default): a tinted rule + mono hint
              row hugging the PTY's bottom edge — the composer itself is the
              CLI's own pixels, never re-drawn here. Only hints the CLI really
              honours are shown (Q2): Claude Code's shift+tab mode cycle and
              `?` shortcut help; other agents get the rule alone. */}
          {ready && (
            <div
              data-testid="prompt-chrome"
              className={cn('flex-none px-[13px] font-mono', effectiveMode === 'chat' && 'hidden')}
              style={{ backgroundColor: termBg }}
            >
              <div className="border-t issue-hairline-35" aria-hidden="true" />
              {session?.harnessPromptModeHints === true && (
                <div className="flex items-center gap-1.5 px-[2px] pt-[5px] pb-[7px] text-[9.5px] text-text-dim">
                  <span>(shift+tab to cycle modes)</span>
                  <span className="ml-auto">? for shortcuts</span>
                </div>
              )}
            </div>
          )}
          {/* Agent action offer bar [spec:SP-c7f1] beneath the PTY — the native
              counterpart of the chat composer's bar, so offers aren't invisible
              in native mode. Clicking a button sends its prompt as a user turn. */}
          {dockOffer && (
            <div
              className={cn('offer-dock flex-none', dockOpen && 'offer-dock--open')}
              data-testid="native-offer-dock"
              aria-hidden={!nativeOffer}
              onTransitionEnd={(e) => {
                // The dock's height change must WINCH the PTY to its FINAL
                // size, or a TUI that draws to the old grid (Codex) paints its
                // prompt box under the dock. Don't rely on the debounced
                // ResizeObserver alone: force a fit at the settled size, send
                // the resize if the grid changed, and re-pin the viewport so
                // any in-place-repaint ghost frame scrolls away. Unpin the
                // surface FIRST so flex resumes before the settled-size fit
                // (on open this fit is a no-op — the grid snapped at start).
                if (e.propertyName !== 'grid-template-rows') return
                dockUnpinRef.current?.()
                setTimeout(() => {
                  const m = mountedRef.current
                  if (!m) return
                  const grid = m.view.fit()
                  if (grid) m.connection.sendResize(grid.cols, grid.rows)
                  m.view.scrollToBottom()
                }, 120)
              }}
            >
              <div className="offer-dock-clip">
                <div ref={dockInnerRef} className="offer-dock-inner">
                  <OfferBar
                    offer={dockOffer}
                    disabled={!nativeOffer}
                    onAction={sendOfferPrompt}
                    {...(session ? { session } : {})}
                  />
                </div>
              </div>
            </div>
          )}
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
              data-pressable
              type="button"
              className="key-act key-submit"
              title="Submit — send the prompt (Enter)"
              onClick={() => mountedRef.current?.connection.sendInput('\r')}
            >
              ⏎ Submit
            </button>
            <button
              data-pressable
              type="button"
              className="key-act"
              title="Newline — insert a line break without submitting (Option+Enter)"
              onClick={() => mountedRef.current?.connection.sendInput('\x1b\r')}
            >
              Newline
            </button>
            <button
              data-pressable
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
                data-pressable
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

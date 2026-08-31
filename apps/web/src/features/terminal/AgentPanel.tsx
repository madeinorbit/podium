import { randomUUID } from '@podium/client-core/id'
import { beginSwitch, isSwitchTraced, markSwitch } from '@podium/client-core/perf'
import { shallowEqual } from '@podium/client-core/store'
import { effectivePanelMode, type PanelMode } from '@podium/client-core/ui-state'

export { effectivePanelMode, effectivePanelMode as initialPanelMode, type PanelMode }

import { attentionGroup } from '@podium/client-core/focus'
import {
  formatClock,
  panelLabel,
  resolveIssueReference,
  resumeCommand,
  sessionWaking,
} from '@podium/client-core/viewmodels'
import type { SessionId } from '@podium/model/browser'
import { isSnoozed } from '@podium/model/browser'
import { SWITCH_TRACE_MARKS } from '@podium/protocol'
import { keySequence, type SpecialKey } from '@podium/terminal-client/keys'
import {
  ArrowSwipeKey,
  preloadTerminalRuntime,
  useTerminalSession,
  useVoiceInput,
} from '@podium/terminal-client-react'
import {
  ArrowDownToLine,
  Ellipsis,
  Folder,
  Keyboard,
  MessageSquareText,
  Mic,
  Moon,
  Sparkles,
  Square,
  SquareTerminal,
  Terminal as TerminalIcon,
} from 'lucide-react'
import type { JSX } from 'react'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import { OPEN_RIGHT_PANEL_EVENT } from '@/app/shell-state'
import { useSession, useSessionDraft, useStoreSelector } from '@/app/store'
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
import { FileLinkPathIndex } from '@/features/chat/chat'
import { OfferBar } from '@/features/chat/OfferBar'
import { OfferDismissalContext, useOfferDismissalHost } from '@/features/chat/offer-dismissal'
import { OfferLiftContext, useOfferLiftHost } from '@/features/chat/offer-lift'
import { agentBrandDot } from '@/lib/agent-tone'
import { assertSendAccepted } from '@/lib/assert-send-accepted'
import { useSessionGuard } from '@/lib/hooks/use-session-guard'
import { effectiveIssueColorHex } from '@/lib/issueColors'
import { issueAgentKind } from '@/lib/issue-agents'
import { isKnownRefPrefix } from '@/lib/markdown-references'
import { EffortPicker, ModelPicker } from '@/lib/ModelEffortPicker'
import { activateRef } from '@/lib/ref-activation'
import { SnoozeControl } from '@/lib/SnoozeControl'
import { sessionMenuEligibility } from '@/lib/session-context-menu'
import { useNow } from '@/lib/useNow'
import { cn } from '@/lib/utils'
import { KindIcon, sessionDisplayName } from '@/lib/WorkerLabel'
import type { AgentPanelProps } from './agent-panel-props'
import { applyInitialTerminalAppearance, paneTintedBackground, withBackground } from './appearance'
import { createDraftSync } from './draft-sync'
import { EchoHud, echoHudEnabled } from './EchoHud'
import { HandoverPane, useHandoverView } from './HandoverPane'
import { hibernateAction } from './lifecycle-actions'
import { ExitedBanner, ExitedPane, HibernatedBanner, HibernatedPane } from './SessionLifecyclePanes'
import { SessionWatchers } from './SessionWatchers'
import { sessionAgeMs, startupOverlay } from './startup-overlay'
import { usePanelSurface } from './use-panel-surface'
import { prettyCwd } from './pretty-cwd'
import { useTerminalAppearance } from './use-terminal-appearance'

// Opt-in browser-test hook: `?e2e=1` exposes `globalThis.__podium` on the mounted
// session (screenText/sendInput/simulateKeyboard/…) for the Playwright harness under
// tests/e2e/browser. Off by default, so normal sessions never expose the input API.
const E2E = typeof window !== 'undefined' && new URLSearchParams(window.location.search).has('e2e')

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
 * `auto` and follows `/model` switches), then the one last REQUESTED at runtime
 * (`requestedModel`, POD-3081), then the spawn selection — including an explicit
 * "auto", shown literally until observation resolves it [POD-158].
 *
 * THE MIDDLE ARM IS WHY THE ORDER IS THREE AND NOT TWO. A sticky configure on a
 * headless session takes effect on the NEXT turn, so between the change and the
 * next assistant message there is no observation of the new model — and without
 * this arm the token would fall all the way through to the SPAWN selection and
 * show a model two changes out of date. It sits BELOW the observation because
 * the observation is the stronger claim: during that window the session really
 * is still answering as the old model, and the dotted rule below says so.
 * Effort renders even before any model is known ("· med"→ effort-only label).
 * Null only when neither a model nor an effort is known.
 *
 * Id compaction: "claude-fable-5" → "fable 5", "claude-opus-4-8" → "opus 4.8",
 * "claude-haiku-4-5-20251001" → "haiku 4.5" (date suffix dropped, consecutive
 * numeric parts join as a dotted version).
 */
/**
 * MAY A CLIENT OFFER A MODEL / EFFORT CONTROL ON THIS RUNNING SESSION?
 * (POD-3087.)
 *
 * The one fact that answers it is `configureFields`, reported by the daemon on
 * bind out of the live driver's own `configure.fields`. Nothing else on
 * `SessionMeta` can: `driverFamily` is the nearest, and it is wrong here —
 * `grok-acp` is family `server` and declares `configure` for `permissionMode`
 * alone, so a family-gated picker appears on a session that can only refuse it.
 *
 * ABSENT IS NOT "NO", and this function exists as much for that rule as for the
 * lookup. Undefined means we have not been told — an older daemon mid-upgrade,
 * or a session that has not bound yet — and reading it as "cannot" would hide
 * the control on every session in the fleet during a rolling upgrade, silently.
 * So absent answers `unknown`, and the caller decides; only an EMPTY array,
 * which is a daemon that answered "nothing", is a real no.
 */
export type ConfigurableVerdict = 'yes' | 'no' | 'unknown'

export function canConfigureModel(session: {
  configureFields?: readonly string[]
}): ConfigurableVerdict {
  if (session.configureFields === undefined) return 'unknown'
  return session.configureFields.includes('model') ? 'yes' : 'no'
}

export function modelToken(session: {
  observedModel?: string
  observedEffort?: string
  requestedModel?: string
  requestedEffort?: string
  model?: string
  effort?: string
}): string | null {
  const raw = session.observedModel ?? session.requestedModel ?? session.model
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
    session.requestedEffort ??
    (session.effort && session.effort !== 'auto' ? session.effort : undefined)
  const effort = rawEffort ? (EFFORT_SHORT[rawEffort] ?? rawEffort) : undefined
  if (!label) return effort ?? null
  return effort ? `${label} · ${effort}` : label
}

/** The native draft bridge is deliberately its own leaf: chat typing updates
 * the latest-value ref without re-running the terminal panel. */
function SessionDraftRef({
  sessionId,
  valueRef,
}: {
  sessionId: SessionId
  valueRef: { current: string }
}): null {
  valueRef.current = useSessionDraft(sessionId)
  return null
}

type DesktopSessionGlobals = {
  __PODIUM_FOCUS_SESSION_PROMPT__?: () => void
  __PODIUM_TOGGLE_SESSION_VIEW__?: () => void
}

export function AgentPanel({
  sessionId,
  active = true,
  focused = active,
  showHeader = true,
}: AgentPanelProps): JSX.Element {
  const {
    hub,
    machines,
    trpc,
    startBtw,
    setSessionDraft,
    hibernateSession,
    dismissOffer: dismissOfferWrite,
    openFile,
    uiState,
    selectedIssueId,
    navigateToSession,
  } = useStoreSelector(
    (s) => ({
      hub: s.hub,
      machines: s.machines,
      // `repos` is deliberately NOT selected (POD-1704). Its only use here was the
      // worktree-missing guess; subscribing to it re-rendered every agent panel on
      // each repo scan for a fact the panel had no business deriving.
      trpc: s.trpc,
      startBtw: s.startBtw,
      setSessionDraft: s.setSessionDraft,
      hibernateSession: s.hibernateSession,
      dismissOffer: s.dismissOffer,
      openFile: s.openFile,
      uiState: s.uiState,
      selectedIssueId: s.selectedIssueId,
      navigateToSession: s.navigateToSession,
    }),
    shallowEqual,
  )
  const session = useSession(sessionId)
  const [loginTerminalBusy, setLoginTerminalBusy] = useState(false)
  const [loginTerminalError, setLoginTerminalError] = useState<string | null>(null)
  const [pendingLoginSessionId, setPendingLoginSessionId] = useState<SessionId | null>(null)
  const pendingLoginSession = useSession(pendingLoginSessionId ?? undefined)
  useEffect(() => {
    if (!pendingLoginSession) return
    navigateToSession(pendingLoginSession.sessionId)
    setPendingLoginSessionId(null)
  }, [navigateToSession, pendingLoginSession])
  const openLoginTerminal = useCallback(async (): Promise<void> => {
    const harness = issueAgentKind(session?.agentKind)
    if (!session || !harness || loginTerminalBusy) return
    setLoginTerminalBusy(true)
    setLoginTerminalError(null)
    try {
      const result = await trpc.accounts.login.mutate({
        harness,
        ...(session.machineId ? { machineId: session.machineId } : {}),
      })
      setPendingLoginSessionId(result.sessionId)
    } catch (cause) {
      setLoginTerminalError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setLoginTerminalBusy(false)
    }
  }, [loginTerminalBusy, session, trpc])
  const spawnConfirmed = useStoreSelector((s) => !s.pendingSpawnIds.has(sessionId))
  const observedOptimisticFirstPrompt = useStoreSelector((s) =>
    s.pendingSpawnPrompts.get(sessionId),
  )
  // Replica confirmation retires the engine's prompt seed at the same time it
  // can move this panel between live/parked/ended surface branches. Those
  // branches remount ChatView, so retain the seed one level higher until the
  // transcript explicitly echoes it; otherwise a fast terminal row can flash
  // an empty conversation between confirmation and the transcript write.
  const [heldOptimisticFirstPrompt, setHeldOptimisticFirstPrompt] = useState<{
    sessionId: SessionId
    text: string
  } | null>(
    observedOptimisticFirstPrompt === undefined
      ? null
      : { sessionId, text: observedOptimisticFirstPrompt },
  )
  useEffect(() => {
    if (observedOptimisticFirstPrompt !== undefined) {
      setHeldOptimisticFirstPrompt({ sessionId, text: observedOptimisticFirstPrompt })
    }
  }, [observedOptimisticFirstPrompt, sessionId])
  const optimisticFirstPrompt =
    observedOptimisticFirstPrompt ??
    (heldOptimisticFirstPrompt?.sessionId === sessionId
      ? heldOptimisticFirstPrompt.text
      : undefined)
  const settleOptimisticFirstPrompt = useCallback(() => {
    setHeldOptimisticFirstPrompt((current) => (current?.sessionId === sessionId ? null : current))
  }, [sessionId])
  // Agent chrome needs durable issue fields (colour, branch, git state), not
  // session-derived rollups. `useReplicaIssues` intentionally invalidates on
  // every session row change to refresh those rollups, which would wake all
  // warm panels again; the engine's issue rows stay stable across session-only
  // publications and carry every field used below.
  const issues = useStoreSelector((s) => s.issues)
  // Live stage lookup for native-terminal ref underlines (POD-529). A ref keeps
  // the getter fresh without remounting the terminal when the replica updates.
  const issuesRef = useRef(issues)
  issuesRef.current = issues
  const { guardedEnd } = useSessionGuard(sessionId)
  // An optimistically-spawned session doesn't exist server-side yet (#119): the
  // terminal's one-shot `hub.attach` would be dropped and never retried, leaving
  // the pane black. Hold the mount until the real session reconciles in — the
  // "Starting…" overlay covers the wait, and the mount effect (which depends on
  // this) fires the instant it flips true.
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
    modeSettled,
    chatCapable,
    terminalOutlook,
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
  // Chat-first sessions do not need xterm. Native-first sessions begin loading
  // after this paint, and the CLI tab starts the same cached import on intent.
  // Once requested, keep the PTY mounted across later chat/native switches.
  const terminalLikely = modeSettled && surface.kind === 'live' && effectiveMode === 'native'
  const terminalRuntimeRequestedRef = useRef(terminalLikely)
  if (terminalLikely) terminalRuntimeRequestedRef.current = true
  useEffect(() => {
    if (terminalLikely && !gates.terminalMounted) preloadTerminalRuntime()
  }, [terminalLikely, gates.terminalMounted])

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
  // A running-session control is deliberately a separate path from the model
  // readout below. The daemon reports `configureFields` from the live driver's
  // own capabilities; only an explicit `model` capability may expose these
  // controls. `undefined` remains unknown during an older-daemon/rolling-bind
  // window, and PATCH-shaped mutations preserve the other sticky field.
  const runtimeAgentKind = session ? issueAgentKind(session.agentKind) : null
  const canConfigureRuntime =
    session !== undefined && runtimeAgentKind !== null && canConfigureModel(session) === 'yes'
  const canConfigureRuntimeEffort =
    canConfigureRuntime && session?.configureFields?.includes('effort') === true
  const runtimeModel = session?.requestedModel ?? session?.model ?? 'auto'
  const runtimeEffort = session?.requestedEffort ?? session?.effort ?? 'auto'
  const configureRuntime = useCallback(
    async (patch: { model?: string; effort?: string }) => {
      try {
        const result = await trpc.sessions.configure.mutate({ sessionId, ...patch })
        if ('ok' in result) {
          toast.success(
            result.effective === 'next-turn'
              ? 'The change applies from the next turn.'
              : 'The running session changed.',
          )
          return
        }
        toast.error(result.detail ?? `Could not change the running session (${result.reason}).`)
      } catch {
        toast.error('Could not change the running session.')
      }
    },
    [sessionId, trpc],
  )
  // Manual hibernation, as a descriptor: whether it applies at all and why it is
  // blocked come from the SHARED eligibility rule (`sessionMenuEligibility`, also
  // read by the session context menu and the command palette) rather than from a
  // fourth local spelling of it.
  const hibernate = hibernateAction(session)
  // Same shared rule, same reason as `hibernate` above — the header must not be
  // a fifth local spelling of "can this session be ended".
  const canEnd = session ? sessionMenuEligibility(session).canEnd : false
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
      const result = await trpc.sessions.sendText.mutate({
        sessionId,
        text: prompt,
        mutationId: randomUUID(),
      })
      // Substrate refuses with HTTP 200 + ok:false — must not dismiss the offer
      // as if the prompt reached the agent (POD-552).
      assertSendAccepted(result)
    } catch (cause) {
      setDismissedOfferAt(null) // send failed — let the offer reappear
      toast.error('Could not send the suggested action')
      throw cause
    }
  }
  /** "None of these" [spec:SP-c7f1] — a write that clears the offer everywhere
   *  instead of sending a turn, and QUEUED since POD-1110 so it survives an
   *  offline gap like every other row edit. Unlike the answer above it takes no
   *  local hide: the queued entry paints the offer away on this session, which
   *  hides both of the panel's bars, holds across a reload while the write
   *  waits, and un-hides by itself if the server refuses it. */
  const dismissOffer = async (offerAt: string) => {
    await dismissOfferWrite(sessionId, offerAt)
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
  const panelRootRef = useRef<HTMLDivElement | null>(null)
  // An opened offer fold is absorbed by PUSHING this panel's surface up under
  // the header rather than by resizing it (POD-1068) — see `offer-lift.ts`.
  const offerLift = useOfferLiftHost(panelRootRef)
  // The undo window for a dismissed offer, held once for the whole panel: both
  // of its bars show the same decision, so both must leave on the same click
  // (POD-1103) rather than the unclicked one waiting out the ten seconds.
  const offerDismissal = useOfferDismissalHost()
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
  const fileLinkPathsRef = useRef(new FileLinkPathIndex())
  // Latest shared chat draft for this session, mirrored into a ref so the
  // draft-flush machinery (onMounted, below) can read it at flush time
  // (chat→native sync, #17/#62) WITHOUT depending on `drafts` directly — a dep
  // there would tear down and remount the whole terminal on every keystroke.
  const draftRef = useRef('')
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
  const echoLatencyEnabled = echoHudEnabled(uiState)

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
    enabled: gates.terminalMounted && terminalRuntimeRequestedRef.current,
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
    echoLatencyEnabled,
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
        knownPaths: fileLinkPathsRef.current.knownPaths,
        onOpen: (abs) => openFile(sessionId, abs),
      })
      // Human-facing ref links (#474 / POD-529): PREFIX-N tokens in agent output
      // become clickable (plain = miniview, Cmd/Ctrl = full view) and painted
      // with a live stage-coloured underline when the issue is known.
      mounted.view.setRefLinks({
        isKnownPrefix: (p) => isKnownRefPrefix(p),
        onActivate: (ref, event) => activateRef(ref, event),
        resolveStage: (ref) => resolveIssueReference(ref, issuesRef.current)?.stage ?? null,
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

  // macOS menu accelerators are consumed before WKWebView sees a keydown. The
  // focused panel therefore publishes the two hooks the native menu evaluates.
  useEffect(() => {
    if (!active || !focused) return
    const globals = globalThis as DesktopSessionGlobals
    const focusPrompt = (): void => {
      if (effectiveMode === 'chat') {
        panelRootRef.current?.querySelector<HTMLTextAreaElement>('textarea:not(:disabled)')?.focus()
      } else if (gates.terminalActive) {
        mountedRef.current?.view.focus()
      }
    }
    const toggleView = (): void => {
      if (!gates.modeSwitchOffered) return
      pickModeWithTrace(effectiveMode === 'chat' ? 'native' : 'chat')
    }
    globals.__PODIUM_FOCUS_SESSION_PROMPT__ = focusPrompt
    globals.__PODIUM_TOGGLE_SESSION_VIEW__ = toggleView
    return () => {
      if (globals.__PODIUM_FOCUS_SESSION_PROMPT__ === focusPrompt)
        delete globals.__PODIUM_FOCUS_SESSION_PROMPT__
      if (globals.__PODIUM_TOGGLE_SESSION_VIEW__ === toggleView)
        delete globals.__PODIUM_TOGGLE_SESSION_VIEW__
    }
  }, [active, focused, gates.terminalActive, gates.modeSwitchOffered, effectiveMode, mountedRef])

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
  // …and it also has to tick while a reconnecting session's machine is away,
  // which is a wait with no output and no attach to end it [POD-2290 round 2].
  const silenceNow = useNow(
    1_000,
    gates.terminalActive && (!ready || !outputSeen || session?.status === 'reconnecting'),
  )
  // When THIS mount started waiting for its attach [POD-2290] — zero while
  // attached, restamped on the next wait, so a re-attach is judged on its own
  // window instead of inheriting the first one's age. A render-phase ref write,
  // like `issuesRef`/`savedModeRef`: it derives from `ready`, holds no state the
  // renderer can disagree with, and an effect would lag the very frame it dates.
  const attachWaitSinceRef = useRef(0)
  if (ready) attachWaitSinceRef.current = 0
  else if (attachWaitSinceRef.current === 0) attachWaitSinceRef.current = Date.now()
  /**
   * …and the second clock: how long this mount has been looking at a session
   * whose MACHINE is away and whose driver family nobody has stated
   * [POD-2290 round 2]. Both conditions, because either alone is ordinary — a
   * reconnecting row usually reconnects, and a family-unknown row is usually a
   * legacy one that is perfectly fine — while together they are the window the
   * reviewer photographed the original bug in.
   */
  const machineAway = session?.status === 'reconnecting' && terminalOutlook === 'unknown'
  const awaitingSinceRef = useRef(0)
  if (!machineAway) awaitingSinceRef.current = 0
  else if (awaitingSinceRef.current === 0) awaitingSinceRef.current = Date.now()
  const overlay = startupOverlay({
    ready,
    outputSeen,
    ageMs: sessionAgeMs(session?.createdAt, silenceNow),
    attachWaitMs:
      attachWaitSinceRef.current === 0
        ? null
        : Math.max(0, silenceNow - attachWaitSinceRef.current),
    awaitingMachineMs:
      awaitingSinceRef.current === 0 ? null : Math.max(0, silenceNow - awaitingSinceRef.current),
  })

  // Native-mode dictation: transcribed speech types straight into the PTY as
  // keystrokes — no auto-submit, so the user can edit before hitting Enter.
  const voice = useVoiceInput((text) => mountedRef.current?.connection.sendInput(`${text} `))

  // Subscribe to the transcript to build the bounded, incrementally-maintained
  // path index for the file-link provider. The hub forwards per-frame DELTAS;
  // reset/re-attach starts the index over, while ordinary frames mutate one
  // owned Set instead of cloning the entire transcript history.
  // biome-ignore lint/correctness/useExhaustiveDependencies: mountedRef is a stable ref from useTerminalSession, not app state
  useEffect(() => {
    fileLinkPathsRef.current.reset()
    return hub.subscribeTranscript(sessionId, undefined, (delta, meta) => {
      if (meta.reset) fileLinkPathsRef.current.reset()
      fileLinkPathsRef.current.add(delta)
      mountedRef.current?.view.setFileLinks({
        cwd: session?.cwd ?? '/',
        // TerminalView/file-link-provider only reads this set. Its stable
        // identity lets each delta update membership without another full copy.
        knownPaths: fileLinkPathsRef.current.knownPaths,
        onOpen: (abs) => openFile(sessionId, abs),
      })
    })
  }, [hub, sessionId, session?.cwd, openFile])

  // Keep the provider's cwd and open callback current even when the session's
  // transcript has not emitted a new delta yet (for example after a reconnect
  // that changes its worktree). The path Set remains owned by the index.
  useEffect(() => {
    mountedRef.current?.view.setFileLinks({
      cwd: session?.cwd ?? '/',
      knownPaths: fileLinkPathsRef.current.knownPaths,
      onOpen: (abs) => openFile(sessionId, abs),
    })
  }, [mountedRef, openFile, session?.cwd, sessionId])

  // Re-paint stage-coloured underlines when the issue replica changes (POD-529).
  // resolveStage always reads issuesRef; setRefLinks only needs to schedule.
  // biome-ignore lint/correctness/useExhaustiveDependencies: mountedRef is a stable ref from useTerminalSession
  useEffect(() => {
    const view = mountedRef.current?.view
    if (!view) return
    view.setRefLinks({
      isKnownPrefix: (p) => isKnownRefPrefix(p),
      onActivate: (ref, event) => activateRef(ref, event),
      resolveStage: (ref) => resolveIssueReference(ref, issuesRef.current)?.stage ?? null,
    })
  }, [issues, mountedRef])

  const sendKey = (key: SpecialKey): void => {
    mountedRef.current?.connection.sendInput(keySequence(key))
  }

  // `relative` anchors the handover veil below the header (the terminal surface
  // positions its own overlays against itself, so nothing else moves).
  const panel = (
    <div ref={panelRootRef} className="relative flex min-w-0 flex-1 flex-col">
      <SessionDraftRef sessionId={sessionId} valueRef={draftRef} />
      {/* Session header [POD-121, remetered POD-725]: 36px, no surface of its own
          — the sheet's card tone runs straight through it and a soft hairline is
          the only thing under it. It was a 24%-issue-tinted band, which made
          sense when the pane was a column on the app ground; inside a white sheet
          whose tab strip is already nearly white, a coloured band across the
          third row down was the one thing in the stage you could not stop
          looking at. Identity is de-boxed (kind glyph + name as the anchor), the
          mode lives in ONE segmented control on the right, and the right cluster
          is model token · segment · snooze · archive · overflow. */}
      {showHeader && (
        <div
          data-testid="agent-panel-header"
          // `offer-lift-header`: the band the pane slides under when an offer
          // fold opens. It has to outrank the lifted surface to cast its shadow
          // over it, hence the z-rung.
          className="offer-lift-header relative z-[1] flex h-[36px] flex-none items-center overflow-hidden gap-3 border-b border-hairline-soft px-4"
        >
          {session && (
            <>
              <KindIcon kind={session.agentKind} />
              <span
                className="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap text-[11.5px] font-medium text-text-strong"
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
              className="hidden min-w-0 max-w-[34%] items-center gap-1 truncate font-mono text-[10.5px] text-text-dim sm:inline-flex"
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
              effort from the spawn selection — hidden until either is known.

              PROVENANCE IS THE POINT (POD-413). This is a READOUT, and the one
              thing a reader must not conclude from it is that Podium chose the
              model. It does not: across Claude Code, Codex, Grok and shells the
              harness owns model selection, and a `/model` typed into the harness
              changes it under us. So the token says which of two things it is —
              OBSERVED in the transcript (plain, because it is simply true) or
              merely REQUESTED at spawn and not yet seen (dotted rule, the
              typographic mark for provisional). The tooltip names it in words. */}
            {session && modelToken(session) && (
              <span
                className="model-token hidden flex-none items-center gap-[5px] font-mono text-[10px] text-(--issue-muted) lg:inline-flex"
                data-provenance={session.observedModel ? 'observed' : 'requested'}
                title={
                  // POD-3087: whether the model can be changed HERE is now a
                  // reported fact rather than a guess, so the readout can say so.
                  // Appended to whichever provenance sentence applies, because
                  // "what is running" and "can I change it" are two different
                  // questions and collapsing them is how a readout starts
                  // implying it is a control.
                  (session.observedModel
                    ? `Observed — the model this agent is actually running, read from its transcript. The harness owns this; Podium reports it.${session.effort ? ' Effort is the spawn request.' : ''}`
                    : session.requestedModel
                      ? // POD-3081: a RUNTIME change, not a spawn one, and the
                        // difference is the whole reason the wording branches —
                        // a sticky configure on a headless session takes effect
                        // on the next message, so "not yet seen" here means
                        // "not yet asked", not "the harness ignored you".
                        'Requested — you changed this on the running session. It applies from its next message, and this becomes Observed once a turn answers on it.'
                      : 'Requested at spawn — not yet seen in the transcript. The harness owns model selection; Podium reports it rather than setting it.') +
                  (canConfigureModel(session) === 'yes'
                    ? ' This session can be moved to another model while it runs.'
                    : canConfigureModel(session) === 'no'
                      ? ' This harness takes its model at launch; changing it is a relaunch.'
                      : // UNKNOWN says nothing at all. A sentence claiming either
                        // answer for a session whose daemon has not reported would
                        // be an invention, and silence is the honest shape of "we
                        // have not been told".
                        '')
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
                <span className="model-token-text">{modelToken(session)}</span>
              </span>
            )}
            {/* Runtime model/effort controls [POD-3087]. These are offered only
              after the daemon has positively reported the live driver's fields;
              a missing report is not permission to guess from driver family. */}
            {session && runtimeAgentKind && canConfigureRuntime && (
              <>
                <ModelPicker
                  agentKind={runtimeAgentKind}
                  value={runtimeModel}
                  onChange={(model) => {
                    void configureRuntime({ model })
                  }}
                  variant="pill"
                  className="hidden flex-none lg:inline-flex"
                  machineId={session.machineId}
                />
                {canConfigureRuntimeEffort && (
                  <EffortPicker
                    agentKind={runtimeAgentKind}
                    model={runtimeModel}
                    value={runtimeEffort}
                    onChange={(effort) => {
                      void configureRuntime({ effort })
                    }}
                    variant="pill"
                    className="hidden flex-none lg:inline-flex"
                    machineId={session.machineId}
                  />
                )}
              </>
            )}
            {/* Mode switch [POD-121, replaces #20's toggle]: one two-segment
              control — both views always visible and labeled, the filled segment
              is the current one. Only offered with a live PTY behind it — a
              hibernated/exited session has no terminal to switch to. */}
            {gates.modeSwitchOffered && (
              <span
                role="tablist"
                aria-label="Panel view"
                // A TRACK WITH A CELL IN IT (POD-725), not two half-boxes divided by
                // a rule: the track is the app ground recessed into the sheet and
                // the current view is a white cell raised out of it — the same
                // machined-segmented-control grammar the command bar's instrument
                // uses, which is what stops two adjacent labels reading as two
                // buttons where only one can be pressed.
                className="inline-flex flex-none items-center gap-0 rounded-lg bg-background p-[2px]"
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
                      'inline-flex cursor-pointer items-center gap-[5px] rounded-md px-[10px] py-[4px] text-[10.5px] transition-colors',
                      effectiveMode === m
                        ? 'bg-card font-semibold text-text-strong shadow-[0_1px_1px_var(--carve-drop)]'
                        : 'text-text-dim hover:text-text-strong',
                    )}
                    onClick={() => pickModeWithTrace(m)}
                    onPointerEnter={m === 'native' ? preloadTerminalRuntime : undefined}
                    onFocus={m === 'native' ? preloadTerminalRuntime : undefined}
                  >
                    {m === 'chat' ? (
                      <MessageSquareText size={12} aria-hidden="true" />
                    ) : (
                      <SquareTerminal size={12} aria-hidden="true" />
                    )}
                    {m === 'chat' ? 'Chat' : 'CLI'}
                  </button>
                ))}
              </span>
            )}
            <span className="inline-flex flex-none items-center gap-[3px]">
              {!isMobile && showSnooze && session && (
                <SnoozeControl session={session} iconSize={15} dimmed={false} />
              )}
              {/* THE ARCHIVE BUTTON IS GONE (POD-1077). Its tooltip promised
                "files it under Done" while `parkArchivedSession` sent a kill to
                the daemon — the most misleading label in the shell, on a bare
                one-click icon with no confirm, sitting in the header of the very
                session it would stop. Teardown now lives in the ⋯ menu below,
                spelled by what survives; filing a finished mission away is the
                ISSUE's archive, which cascades to its sessions (#133). */}
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
                  <DropdownMenuContent align="end" className="w-auto min-w-[236px] max-w-[90vw]">
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
                          aria-hidden="true"
                          className="size-3.5 flex-none translate-y-[3px] self-start"
                        />
                        <span className="min-w-0">
                          Copy resume command
                          <span
                            className="mt-px block max-w-[26ch] truncate font-mono shell-type-micro text-text-faint"
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
                    {(hibernate || canEnd) && <DropdownMenuSeparator />}
                    {hibernate && (
                      <DropdownMenuItem
                        data-testid="lifecycle-hibernate"
                        disabled={hibernate.disabledReason !== null}
                        {...(hibernate.disabledReason ? { title: hibernate.disabledReason } : {})}
                        onClick={() => void hibernateSession(sessionId)}
                      >
                        <Moon size={13} aria-hidden="true" /> {hibernate.label}
                      </DropdownMenuItem>
                    )}
                    {/* The teardown verb the header lost with the archive button
                        — and the honest version of it: the process stops and the
                        worktree frees, the branch and transcript stay, Resume
                        rebuilds. Deleting is deliberately NOT offered here: this
                        header belongs to the session you are reading, and a
                        row-removing action belongs where rows live. */}
                    {canEnd && (
                      <DropdownMenuItem
                        data-testid="lifecycle-end"
                        onClick={() => void guardedEnd(sessionId)}
                      >
                        <Square size={13} aria-hidden="true" /> End session
                      </DropdownMenuItem>
                    )}
                  </DropdownMenuContent>
                </DropdownMenu>
              )}
            </span>
          </span>
        </div>
      )}
      {showHeader && session && runtimeAgentKind && canConfigureRuntime && (
        <div
          data-testid="runtime-configure-mobile"
          className="flex min-w-0 flex-none items-center gap-2 border-b border-hairline-soft px-3 py-1.5 lg:hidden"
        >
          <span className="flex-none text-[10px] font-medium text-text-dim">Next turn</span>
          <ModelPicker
            agentKind={runtimeAgentKind}
            value={runtimeModel}
            onChange={(model) => {
              void configureRuntime({ model })
            }}
            variant="pill"
            className="min-w-0 max-w-[min(14rem,58vw)] flex-1 truncate"
            machineId={session.machineId}
          />
          {canConfigureRuntimeEffort && (
            <EffortPicker
              agentKind={runtimeAgentKind}
              model={runtimeModel}
              value={runtimeEffort}
              onChange={(effort) => {
                void configureRuntime({ effort })
              }}
              variant="pill"
              className="min-w-0 max-w-[8rem] flex-1 truncate"
              machineId={session.machineId}
            />
          )}
        </div>
      )}
      {session?.condition === 'logged-out' && (
        <div
          role="status"
          className="flex flex-none items-center gap-2 border-b border-warning/30 bg-warning/10 px-3 py-2 text-xs text-warning"
        >
          <strong>{panelLabel(session.agentKind)} isn&apos;t logged in</strong>
          <span>
            {terminalOutlook === 'none'
              ? 'Open a sign-in terminal to authenticate, then retry here.'
              : 'Run its login command in this pane to continue.'}
          </span>
        </div>
      )}
      {handover && <HandoverPane view={handover} background={termBg} />}
      {surface.kind === 'pending' ? (
        // WAITING TO BE TOLD WHICH VIEW THIS SESSION HAS [POD-2290]. One
        // placeholder, no controls: the panel does not know yet whether there
        // is a terminal behind this agent, and the honest thing during a wait
        // that ends by itself is to say the session is starting and offer
        // nothing it might have to take away a second later.
        <div
          className="flex flex-1 flex-col items-center justify-center gap-3 px-8 text-center text-[13px] text-zinc-400"
          style={{ backgroundColor: termBg }}
          data-testid="panel-pending"
          role="status"
          aria-live="polite"
        >
          <span
            className="size-[22px] animate-spin rounded-full border-2 border-zinc-700 border-t-zinc-300"
            aria-hidden="true"
          />
          <span>Starting {session ? panelLabel(session.agentKind) : 'session'}…</span>
        </div>
      ) : surface.kind === 'transit' ? (
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
            <HibernatedBanner
              sessionId={sessionId}
              waking={sessionWaking(session)}
              queuedCount={session?.queuedMessageCount ?? 0}
            />
            <ChatView
              sessionId={sessionId}
              active={active}
              initialPendingText={optimisticFirstPrompt}
              onInitialPendingSettled={settleOptimisticFirstPrompt}
              deferInitialTranscript={!spawnConfirmed}
            />
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
              {...(session.neverBound ? { neverBound: true as const } : {})}
              waking={sessionWaking(session)}
            />
            <ChatView
              sessionId={sessionId}
              active={active}
              initialPendingText={optimisticFirstPrompt}
              onInitialPendingSettled={settleOptimisticFirstPrompt}
              deferInitialTranscript={!spawnConfirmed}
            />
          </>
        ) : (
          <ExitedPane
            sessionId={sessionId}
            exitCode={session.exitCode}
            spawnFailure={session.spawnFailure}
            isShell={session.agentKind === 'shell'}
            resumable={session.resumable === true}
            {...(session.neverBound ? { neverBound: true as const } : {})}
          />
        )
      ) : (
        // Warm chat<->native toggle (Task 6): the terminal container stays
        // mounted in BOTH modes — `hidden` (display:none) when in chat — so
        // Switching modes never disposes and re-attaches the PTY. Both surfaces
        // stay mounted; the inactive one is hidden so subscriptions and terminal
        // state survive a warm mode switch.
        <>
          <div
            className={cn('flex min-h-0 flex-1 flex-col', effectiveMode !== 'chat' && 'hidden')}
            data-testid="chat-surface"
          >
            <ChatView
              sessionId={sessionId}
              active={active && effectiveMode === 'chat'}
              initialPendingText={optimisticFirstPrompt}
              onInitialPendingSettled={settleOptimisticFirstPrompt}
              deferInitialTranscript={!spawnConfirmed}
            />
          </div>
          {/* THE ONE HONEST NATIVE PANE [POD-2290]. Reachable only through the
              switcher's stickiness — a session that once had a terminal and
              stopped having one — because the switch is never withdrawn under
              the operator's cursor. What it must not do is what the original
              bug did: animate a spinner over an attach that is never coming.
              It names the reason and points at the view that works. */}
          {gates.noTerminalPaneShown && (
            <div
              className="flex flex-1 flex-col items-center justify-center gap-2 px-8 text-center"
              style={{ backgroundColor: termBg }}
              data-testid="no-terminal-pane"
              role="status"
            >
              <SquareTerminal size={22} className="text-zinc-600" aria-hidden="true" />
              <span className="text-[13px] text-zinc-400">
                {session?.condition === 'logged-out'
                  ? `${panelLabel(session.agentKind)} needs sign-in`
                  : `${session ? panelLabel(session.agentKind) : 'This agent'} is running without a terminal`}
              </span>
              <span className="max-w-[44ch] text-[11px] text-balance text-zinc-500 leading-relaxed">
                {session?.condition === 'logged-out'
                  ? 'This headless session has no command-line screen. Open a temporary terminal to sign in, then retry the session here.'
                  : 'It is driven over its own protocol rather than a shell, so there is no screen to attach to. Everything it does shows up in Chat.'}
              </span>
              <span className="mt-1 flex flex-wrap items-center justify-center gap-2">
                {session?.condition === 'logged-out' && (
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    data-testid="open-login-terminal"
                    disabled={loginTerminalBusy}
                    onClick={() => void openLoginTerminal()}
                  >
                    <SquareTerminal size={13} aria-hidden="true" />
                    {loginTerminalBusy ? 'Opening…' : 'Open sign-in terminal'}
                  </Button>
                )}
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  onClick={() => pickModeWithTrace('chat')}
                >
                  <MessageSquareText size={13} aria-hidden="true" /> Open Chat
                </Button>
              </span>
              {loginTerminalError && (
                <span className="max-w-[44ch] text-[11px] text-danger" role="alert">
                  {loginTerminalError}
                </span>
              )}
            </div>
          )}
          {/* …but a session with NO terminal keeps nothing warm [POD-2290]: the
              container below never gets a PTY, and the startup overlay inside
              it would paint a spinner over a wait that has no end. `hidden`
              would have been enough to keep it off screen and is not enough to
              make it honest — an animation nobody can see is still a claim the
              panel is making. */}
          {gates.nativePaneRendered && (
            <>
              {/* The container is pinned to the TERMINAL's background — the pane's
              issue tint (§2.5), or the user's custom color from the appearance
              settings — regardless of the app theme: otherwise a light theme
              shows a white container edge around the terminal, and a custom
              background a dark one. */}
              <div
                ref={termSurfaceRef}
                data-testid="terminal-surface"
                className={cn(
                  // `offer-lift-region`: the PTY is what an opened offer fold
                  // pushes up under the header. Its box never changes, so the
                  // terminal is never re-gridded and the TUI never repaints.
                  'offer-lift-region relative flex min-h-0 flex-1 flex-col',
                  effectiveMode === 'chat' && 'hidden',
                )}
                style={{ backgroundColor: termBg }}
              >
                <div ref={termRef} className="term min-h-0 flex-1" />
                {overlay.kind !== 'hidden' && (
                  <div
                    className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-3 px-8 text-center text-[13px] text-zinc-400"
                    style={{ backgroundColor: termBg }}
                    data-testid="terminal-startup-overlay"
                    role="status"
                    aria-live="polite"
                  >
                    {/* The spinner is a CLAIM that something is still happening, so
                    it is dropped the moment that claim stops being credible
                    [POD-2290] — a stalled mount says so in words instead of
                    animating over a wait that is not going to end. */}
                    {overlay.kind !== 'stalled' && overlay.kind !== 'awaiting-machine' && (
                      <span
                        className="size-[22px] animate-spin rounded-full border-2 border-zinc-700 border-t-zinc-300"
                        aria-hidden="true"
                      />
                    )}
                    <span data-testid="startup-headline">
                      {overlay.kind === 'awaiting-machine'
                        ? 'Waiting for this machine'
                        : overlay.kind === 'stalled'
                          ? `${session ? panelLabel(session.agentKind) : 'This session'} hasn’t started`
                          : `Starting ${session ? panelLabel(session.agentKind) : 'session'}…`}
                    </span>
                    {/* The one overlay arm that names a cause, because here the
                    panel actually knows it: the session row is `reconnecting`
                    and no driver fact has arrived, so what is missing is the
                    MACHINE, not the harness. Saying "Starting OpenCode…" over
                    this is the round-two bug in miniature — a claim about a
                    process nobody is talking to. [POD-2290] */}
                    {overlay.kind === 'awaiting-machine' && (
                      <span className="max-w-[44ch] text-[11px] text-balance text-zinc-500 leading-relaxed">
                        Podium hasn’t heard from this machine in {formatClock(overlay.elapsedMs)}.
                        The session is still here — it will pick up again once the machine
                        reconnects.
                      </span>
                    )}
                    {/* What the operator can actually do about it. Deliberately
                    silent on the CAUSE: nothing here can tell a spawn that
                    failed from a machine that went away, and naming the wrong
                    one is worse than naming none. */}
                    {overlay.kind === 'stalled' && (
                      <span className="max-w-[44ch] text-[11px] text-balance text-zinc-500 leading-relaxed">
                        Nothing has attached to this terminal in {formatClock(overlay.elapsedMs)}.
                        The session may have failed to start — check its status, or spawn it again.
                      </span>
                    )}
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
                {echoLatencyEnabled && <EchoHud hub={hub} mountedRef={mountedRef} />}
              </div>
              {/* Prompt-area chrome (§2.6, Q1 default): a tinted rule + mono hint
              row hugging the PTY's bottom edge — the composer itself is the
              CLI's own pixels, never re-drawn here. Only hints the CLI really
              honours are shown (Q2): Claude Code's shift+tab mode cycle and
              `?` shortcut help; other agents get the rule alone. */}
              {ready && (
                <div
                  data-testid="prompt-chrome"
                  // Rides up with the PTY it hugs, but is never clipped: it is a
                  // 20px strip, and clipping it by the lift would erase it.
                  className={cn(
                    'offer-lift-rise flex-none px-[13px] font-mono',
                    effectiveMode === 'chat' && 'hidden',
                  )}
                  style={{ backgroundColor: termBg }}
                >
                  <div className="border-t issue-hairline-35" aria-hidden="true" />
                  {session?.harnessPromptModeHints === true && (
                    <div className="flex items-center gap-1.5 px-[2px] pt-[5px] pb-[7px] shell-type-micro text-text-dim">
                      <span>(shift+tab to cycle modes)</span>
                      <span className="ml-auto">? for shortcuts</span>
                    </div>
                  )}
                </div>
              )}
            </>
          )}
          {/* Agent action offer bar [spec:SP-c7f1] beneath the PTY — the native
              counterpart of the chat composer's bar, so offers aren't invisible
              in native mode. Clicking a button sends its prompt as a user turn. */}
          {dockOffer && (
            <div
              // `offer-lift-seat`: the fold's height grows this dock, and the
              // dock's own negative top margin hands the same pixels back to
              // the flex solver, so nothing above it is ever re-measured.
              className={cn('offer-dock offer-lift-seat flex-none', dockOpen && 'offer-dock--open')}
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
                // Own transition only. React's synthetic transitionend BUBBLES,
                // so without the target check any descendant animating the same
                // property re-grids the PTY behind the user's back.
                if (e.target !== e.currentTarget || e.propertyName !== 'grid-template-rows') return
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
                    onDismiss={dismissOffer}
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
  // Every OfferBar below — native dock and chat composer alike — reaches this
  // panel's lift through the provider, and the panel root carries the one
  // number (`--offer-lift`) the seat, the surface and the fold all read. The
  // same two bars share one dismissal, for the same reason: they are two views
  // of one decision, so neither may still be offering it after the other has
  // been dismissed.
  return (
    <OfferDismissalContext.Provider value={offerDismissal}>
      <OfferLiftContext.Provider value={offerLift}>{panel}</OfferLiftContext.Provider>
    </OfferDismissalContext.Provider>
  )
}

/**
 * THE ARBITRATION HOOK (POD-408) — the store/effect half of `panel-surface.ts`.
 *
 * `panelSurface` names the STATES. This hook owns the TRANSITIONS: what fetches
 * the configurable default, what materializes the derived mode back into the
 * store (which is what the engine's `reportViewState` reads to tell the server
 * which sessions are rendering native), what a mode pick persists, and — the one
 * transition that carries product behaviour rather than bookkeeping — chat →
 * native, which re-arms the chat draft flush.
 *
 * TRANSITIONS, NAMED:
 *   mount            → the surface is arbitrated for the first time; the mode is
 *                      written back to the store so viewState reports it.
 *   pick(chat|native)→ persists per-session (#35) AND as the per-device default.
 *   chat → native    → `onEnterNative` fires. The terminal stays MOUNTED across
 *                      the toggle (the warm toggle), so the mount effect's
 *                      one-shot draft flush does not re-fire on its own; this is
 *                      the edge that re-arms it. Mount-in-native is deliberately
 *                      NOT this edge (the mount effect already armed it).
 *   native → chat    → nothing here: the terminal simply stops being `active`.
 *   pane shown/hidden→ nothing here either; `paneActive` flows into the gates.
 *
 * The startScreen fetch and the panelMode write both live here rather than in
 * `AgentPanel` so that the component holds no arbitration state at all.
 */
import { shallowEqual } from '@podium/client-core/store'
import {
  effectivePanelMode,
  PANEL_MODE_DEFAULT_KEY,
  type PanelMode,
} from '@podium/client-core/ui-state'
import { defaultChatCapable } from '@podium/client-core/viewmodels'
import type { SessionId, SessionMeta } from '@podium/model'
import { useEffect, useRef, useState } from 'react'
import { useStoreSelector } from '@/app/store'
import {
  type PanelGates,
  type PanelSurface,
  panelChatCapable,
  panelGates,
  panelSurface,
} from './panel-surface'

export interface PanelArbitration {
  readonly surface: PanelSurface
  readonly gates: PanelGates
  /** The effective chat-vs-native pick. Meaningful only while live, but reported
   *  unconditionally because viewState carries it for every visible session. */
  readonly mode: PanelMode
  readonly chatCapable: boolean
  readonly pickMode: (mode: PanelMode) => void
}

export function usePanelSurface(input: {
  sessionId: SessionId
  session: SessionMeta | undefined
  /** This pane is the visible one (PanelDeck's `visible`). */
  paneActive: boolean
  /** The optimistic spawn has reconciled server-side (#119). */
  spawnConfirmed: boolean
  /** The handover veil owns the pane ([spec:SP-3f7a]). */
  inTransit: boolean
  /** Fired on a chat → native transition, never on mount-in-native. */
  onEnterNative?: () => void
}): PanelArbitration {
  const { panelMode, setPanelMode, uiState, trpc } = useStoreSelector(
    (s) => ({
      panelMode: s.panelMode,
      setPanelMode: s.setPanelMode,
      uiState: s.uiState,
      trpc: s.trpc,
    }),
    shallowEqual,
  )
  const { sessionId, session, paneActive, spawnConfirmed, inTransit, onEnterNative } = input
  const chatCapable = panelChatCapable(session, defaultChatCapable)

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
  // chat-on-mobile/native-on-desktop. ONE derivation (client-core ui-state) makes
  // the modeled, persisted and reported mode the same value.
  const isMobile = typeof window !== 'undefined' && window.matchMedia('(max-width: 768px)').matches
  const savedMode = panelMode[sessionId]
  const mode: PanelMode = effectivePanelMode({
    startScreen,
    chatCapable,
    isMobile,
    saved: savedMode,
    deviceDefault: uiState.get(PANEL_MODE_DEFAULT_KEY),
  })
  // Effects can run after a newer render has already handled a user click. Read
  // the current saved value at effect time so the initial materialization cannot
  // write the mode captured by an older render back over that pick.
  const savedModeRef = useRef(savedMode)
  savedModeRef.current = savedMode
  useEffect(() => {
    // An explicit per-session choice is already durable. Rewriting it from the
    // derived fallback creates a stale writer when a warm/hidden panel mounts
    // while another panel is being switched.
    if (savedModeRef.current !== undefined) return
    setPanelMode(sessionId, mode)
  }, [sessionId, mode, setPanelMode])

  const pickMode = (m: PanelMode): void => {
    // Persist the per-session override in the store (#35)…
    setPanelMode(sessionId, m)
    // …and remember the latest pick as the per-device default for not-yet-seen sessions.
    uiState.set(PANEL_MODE_DEFAULT_KEY, m)
  }

  // chat → native. Read `onEnterNative` through a ref so a caller that passes an
  // inline closure cannot make this effect fire on every render — the edge is
  // the MODE change and nothing else.
  const enterNativeRef = useRef(onEnterNative)
  enterNativeRef.current = onEnterNative
  const prevModeRef = useRef<PanelMode | null>(null)
  useEffect(() => {
    const prev = prevModeRef.current
    prevModeRef.current = mode
    if (mode !== 'native') return
    // Only a *transition* into native fires; the first observation (prev null)
    // is the mount-in-native case, already handled by the mount effect.
    if (prev === null || prev === 'native') return
    enterNativeRef.current?.()
  }, [mode])

  const surface = panelSurface({
    status: session?.status,
    inTransit,
    chatCapable,
    mode,
  })
  const gates = panelGates(surface, { paneActive, spawnConfirmed, chatCapable })

  return { surface, gates, mode, chatCapable, pickMode }
}

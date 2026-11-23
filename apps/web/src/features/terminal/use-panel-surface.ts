import { useUiValue } from '@podium/client-core/react'
import type { SessionView } from '@podium/client-core/session-values'
import { effectivePanelMode, type PanelMode } from '@podium/client-core/ui-state'
import {
  defaultChatCapable,
  sessionTerminalOutlook,
  type TerminalOutlook,
} from '@podium/client-core/values'
import { createLogger } from '@podium/logger'
import type { SessionId } from '@podium/model/browser'
import { useEffect, useRef } from 'react'
import { useMyStartScreen } from '@/lib/my-preferences'
import { useFeature } from '@/lib/use-feature'
import {
  type PanelGates,
  type PanelSurface,
  panelChatCapable,
  panelGates,
  panelOfflineMachine,
  panelSurface,
} from './panel-surface'
import { usePaneMachines, usePanePanelModes } from './use-session-pane-inputs'

const log = createLogger('web:panel-mode')

/**
 * WHICH RULE DECIDED THE MODE (POD-3932). The operator watched a session flip
 * chat → CLI seconds after picking chat and could not tell whether the login
 * override, a capability collapse, or another device's replicated pick did
 * it. The mode alone cannot say; this names the rule, in the same order
 * `effectivePanelMode` applies them, so the debug line can.
 */
type PanelModeProducer =
  | 'concertmaster'
  | 'login-required'
  | 'no-terminal'
  | 'not-chat-capable'
  | 'saved'
  | 'server-family'
  | 'start-screen'

function panelModeProducer(input: {
  curated: boolean
  loginRequired: boolean
  terminalCapable: boolean
  chatCapable: boolean
  saved: PanelMode | undefined
  serverFamily: boolean
}): PanelModeProducer {
  if (input.curated) return 'concertmaster'
  if (input.loginRequired) return 'login-required'
  if (!input.terminalCapable) return 'no-terminal'
  if (!input.chatCapable) return 'not-chat-capable'
  if (input.saved === 'native' || input.saved === 'chat') return 'saved'
  if (input.serverFamily) return 'server-family'
  return 'start-screen'
}

export interface PanelArbitration {
  readonly surface: PanelSurface
  readonly gates: PanelGates
  /** The effective chat-vs-native pick. Meaningful only while live, but reported
   *  unconditionally because viewState carries it for every visible session. */
  readonly mode: PanelMode
  /** True once the effective mode no longer depends on the settings request. */
  readonly modeSettled: boolean
  readonly chatCapable: boolean
  /**
   * The session is shown as a Concertmaster (POD-7211): it carries the mark and
   * the feature is on. Its pane is the curated chat in every state: no terminal
   * view, no switch between views, no take-control.
   */
  readonly curated: boolean
  /** Three-valued "does this session have a terminal" — `unknown` until the
   *  daemon has said. The panel needs the third value to tell an honest wait
   *  from an ordinary one (POD-2290). */
  readonly terminalOutlook: TerminalOutlook
  /** The machine this session runs on, by name, when it is known and offline. */
  readonly offlineMachine: string | null
  readonly pickMode: (mode: PanelMode) => void
}

export function usePanelSurface(input: {
  sessionId: SessionId
  session: SessionView | undefined
  /** This pane is the visible one (PanelDeck's `visible`). */
  paneActive: boolean
  /** The optimistic spawn has reconciled server-side (#119). */
  spawnConfirmed: boolean
  /** The handover veil owns the pane. */
  inTransit: boolean
}): PanelArbitration {
  const setPanelMode = useUiValue('setPanelMode')
  const panelMode = usePanePanelModes()
  const machines = usePaneMachines()
  const { sessionId, session, paneActive, spawnConfirmed, inTransit } = input
  // A CONCERTMASTER IS ITS CURATED CHAT AND NOTHING ELSE (POD-7211). The rule
  // is stated once, here, by answering the two questions every later decision
  // asks: it has a chat, and it has no terminal to show. Rule 0 of
  // `effectivePanelMode` then keeps it on chat whatever was saved, and every
  // gate that needs a terminal (the mount, the switch, take-control) stays
  // shut, exactly as for a session whose driver has none.
  const concertmasterEnabled = useFeature('concertmaster')
  const curated = concertmasterEnabled && session?.concertmaster === true
  const chatCapable = curated || panelChatCapable(session, defaultChatCapable)
  // Does the native view have anything behind it (POD-2290)? Three-valued, and
  // the third value is the whole of round two: `unknown` is not "probably a
  // terminal", it is "the daemon has not said yet", and `panelSurface` holds the
  // panel neutral rather than committing to a pane it may have to take back.
  const terminal: TerminalOutlook = curated ? 'none' : sessionTerminalOutlook(session)
  const terminalCapable = terminal !== 'none'

  // My startScreen setting, from my synced settings (POD-6673); 'native'
  // until my settings are in the pool. This drives the configurable default
  // mode for sessions the user has never toggled.
  const syncedStartScreen = useMyStartScreen()
  const startScreen = syncedStartScreen ?? 'native'
  const startScreenSettled = syncedStartScreen !== undefined

  // Per-session mode is restored from the store (persisted via ui-state) so a
  // reload returns this session to the view it was last left in (#35). A session
  // the user never toggled follows the live `startScreen` setting →
  // chat-on-mobile/native-on-desktop. ONE derivation (client-core ui-state) makes
  // the modeled, persisted and reported mode the same value.
  const isMobile = typeof window !== 'undefined' && window.matchMedia('(max-width: 768px)').matches
  const savedMode = panelMode[sessionId]
  // A login failure is only actionable in the native terminal, where the user
  // can run the agent's login command. Force that surface transiently; do not
  // persist the forced mode over the user's chat preference.
  // Never for a Concertmaster: it has no terminal view to repair a login in, so
  // the login bar above the pane says what to do instead.
  const loginRequired = !curated && session?.condition === 'logged-out'
  const mode: PanelMode = loginRequired
    ? 'native'
    : effectivePanelMode({
        startScreen,
        chatCapable,
        isMobile,
        terminalCapable,
        serverFamily: session?.driverFamily === 'server',
        saved: savedMode,
      })
  // Shells cannot show chat, and explicit per-session choices are already
  // authoritative. Fresh chat-capable sessions wait for the setting request so
  // the provisional native fallback cannot pull xterm into a chat-first load.
  //
  // A forced login surface is settled by the same rule: the mode is not a
  // provisional fallback there, it is the one surface the failure is actionable
  // on, so it must not wait on a setting it will ignore.
  const modeSettled =
    curated || loginRequired || !chatCapable || savedMode !== undefined || startScreenSettled
  const producer = panelModeProducer({
    curated,
    loginRequired,
    terminalCapable,
    chatCapable,
    saved: savedMode,
    serverFamily: session?.driverFamily === 'server',
  })
  // One line per EFFECTIVE change, naming the rule and every input it read.
  // Debug: it fires on user picks too, and a flip the user did not ask for is
  // diagnosed by reading the producer of the line that followed their pick.
  const loggedModeRef = useRef<{ sessionId: SessionId; mode: PanelMode } | null>(null)
  useEffect(() => {
    const prev = loggedModeRef.current
    loggedModeRef.current = { sessionId, mode }
    if (prev !== null && prev.sessionId === sessionId && prev.mode === mode) return
    log.debug('panel mode decided', {
      sessionId,
      from: prev?.sessionId === sessionId ? prev.mode : null,
      to: mode,
      producer,
      saved: savedMode ?? null,
      startScreen,
      startScreenSettled,
      chatCapable,
      transcriptAvailable: session?.transcriptAvailable ?? null,
      terminal,
      condition: session?.condition ?? null,
      status: session?.status ?? null,
    })
  }, [
    sessionId,
    mode,
    producer,
    savedMode,
    startScreen,
    startScreenSettled,
    chatCapable,
    session?.transcriptAvailable,
    terminal,
    session?.condition,
    session?.status,
  ])
  const pickMode = (m: PanelMode): void => {
    log.debug('panel mode picked', { sessionId, from: mode, to: m })
    // Only an explicit choice is durable. Other sessions keep following Agents.
    setPanelMode(sessionId, m)
  }

  const surface = panelSurface({
    status: session?.status,
    inTransit,
    chatCapable,
    mode,
    terminal,
  })
  /**
   * THE SWITCHER IS MONOTONE PER SESSION (POD-2290 round two).
   *
   * The operator watched it disappear mid-session — "the native and chat button
   * vanished?!" — when a late driver fact turned a terminal session into a
   * headless one under them. A ref, not state: it only ever latches true, and a
   * render that latches it has already computed the gate that reads it, so
   * there is nothing to re-render for. Keyed on the session so a panel reused
   * for a different session starts clean.
   */
  const switchOfferedRef = useRef<{ sessionId: SessionId; offered: boolean }>({
    sessionId,
    offered: false,
  })
  if (switchOfferedRef.current.sessionId !== sessionId) {
    switchOfferedRef.current = { sessionId, offered: false }
  }
  const offlineMachine = panelOfflineMachine(session, machines)
  const gates = panelGates(surface, {
    paneActive,
    spawnConfirmed,
    chatCapable,
    terminalCapable,
    // The sticky switch is for a terminal that went away under the operator.
    // A Concertmaster's was taken away on purpose, by their own mark.
    switchAlreadyOffered: !curated && switchOfferedRef.current.offered,
    loginRequired,
    machineOffline: offlineMachine !== null,
  })
  if (gates.modeSwitchOffered) switchOfferedRef.current.offered = true

  return {
    surface,
    gates,
    mode,
    modeSettled,
    chatCapable,
    curated,
    terminalOutlook: terminal,
    offlineMachine,
    pickMode,
  }
}

/**
 * OPEN "SET UP AGENTS" FROM ANYWHERE (POD-6858). The one call a harness menu,
 * onboarding step or recovery control makes; `SetupAgentsDialogHost` (mounted
 * once in the app shell) renders the panel for the latest request.
 *
 *   openSetupAgents({
 *     machineId,              // the machine whose agents the panel shows
 *     origin: 'menu',         // 'menu' | 'settings' | 'onboarding'
 *     focus: 'codex',         // optional: the harness the opener asked about
 *     onStart: (harness) => { // optional: the footer's "Start <harness>" hands it back
 *       launchSession(harness)
 *     },
 *   })
 *
 * With `focus` and `onStart`, the footer offers "Start <harness>" once that
 * harness is installed and signed in (or the person chose to sign in later);
 * pressing it calls `onStart` and closes the panel. Without them the footer
 * says Done. Opening never installs anything: the panel only ticks the focused
 * harness so one press installs it.
 *
 * This file has no React or panel imports, so a caller pays nothing for the
 * panel until it opens.
 */

import type { BuiltinHarnessKind, MachineId } from '@podium/model'
import { action, observableRef } from 'mobx'

export interface SetupAgentsRequest {
  readonly machineId: MachineId
  readonly origin: 'menu' | 'settings' | 'onboarding'
  readonly focus?: BuiltinHarnessKind
  readonly onStart?: (harness: BuiltinHarnessKind) => void
}

interface OpenRequest extends SetupAgentsRequest {
  /** A new number per opening: a second open of the same machine starts fresh. */
  readonly opening: number
}

class SetupAgentsState {
  @observableRef accessor request: OpenRequest | null = null
}
const state = new SetupAgentsState()
let openings = 0

/** Open the panel (replacing any open one). */
export const openSetupAgents = action((request: SetupAgentsRequest): void => {
  state.request = { ...request, opening: ++openings }
})

/** Close the panel, if open. */
export const closeSetupAgents = action((): void => {
  state.request = null
})

/** The open request, observed by the host. */
export function setupAgentsRequest(): OpenRequest | null {
  return state.request
}

/** Point the open panel at another machine (the header's machine chip). */
export const switchSetupAgentsMachine = action((machineId: MachineId): void => {
  const current = state.request
  if (!current || current.machineId === machineId) return
  // The opener's focus and hand-back belong to the machine it asked about.
  state.request = { machineId, origin: current.origin, opening: ++openings }
})

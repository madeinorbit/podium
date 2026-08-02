/**
 * WHAT AN AGENT SPAWN IS CONFIGURED WITH (POD-1396, from POD-1385's god-object
 * audit).
 *
 * One job: given a harness kind and any per-session override, resolve the model,
 * effort, subagent model, CLI theme seed and managed credential that ride the
 * spawn frame. Two callers need exactly this and nothing else — the initial
 * spawn, and the resurrect path that re-spawns a parked session — which is what
 * makes it a shared capability rather than a helper on one of them.
 *
 * READ LIVE AT SPAWN, NEVER SNAPSHOTTED. Both halves re-read settings on every
 * call so a resurrected session picks up the configuration as it is now, not as
 * it was when the session was first created.
 *
 * THE ROLE-DEFAULTS RULE, which is the part most likely to be "simplified" by a
 * later reader: the coding role's model and effort apply ONLY when the session's
 * harness IS the coding harness. Selecting a different harness must not inherit
 * the coding harness's model or effort [spec:SP-7ff1]. An explicit override
 * always wins, and the literal string `'auto'` means "no opinion" rather than a
 * model named auto — which is why it is compared rather than passed through.
 *
 * 'shell' IS NOT AN AGENT, and both halves special-case it for the same reason
 * of shape. A shell is an interactive prompt the user drives: it gets no model,
 * no theme seed, and — load-bearing for security, not tidiness — NO managed
 * credential. Injecting one would put it a single `env` away from being streamed
 * to the browser and written into persisted scrollback.
 *
 * WHOSE PREFERENCES ARE READ is deliberately NOT decided here. The viewer
 * arrives through the `settingsViewer` port because that question belongs to the
 * service that knows the calling principal; POD-315 replaces it with the
 * requesting principal, and this module needs no change when it does.
 */

import { harnessCapabilitiesFor, harnessSupportsEffort } from '../../harness-manifest'
import type { AgentKind, UserId } from '@podium/model'
import { resolveRole } from '@podium/runtime'
import type { SessionStore } from '../../store'
import { resolveAccountEnv } from './account-env'

export interface LaunchConfigPorts {
  store: Pick<SessionStore, 'settings' | 'accounts'>
  /** Whose preferences a spawning read uses. Not this module's decision. */
  settingsViewer(): UserId
}

export interface LaunchModelDefaults {
  model?: string
  subagentModel?: string
  effort?: string
  seedCliTheme?: boolean
}

export class SessionLaunchConfig {
  constructor(private readonly ports: LaunchConfigPorts) {}

  modelDefaults(
    agentKind: AgentKind,
    override?: { model?: string; effort?: string },
  ): LaunchModelDefaults {
    const settings = this.ports.store.settings.getSettingsFor(this.ports.settingsViewer())
    const coding = settings.roles.coding
    const useCodingDefaults = agentKind === resolveRole(settings, 'coding').harness
    const explicitModel = override?.model
    const explicitEffort = override?.effort
    const model =
      explicitModel !== undefined && explicitModel !== 'auto'
        ? explicitModel
        : useCodingDefaults
          ? coding.model
          : 'auto'
    const effort =
      explicitEffort !== undefined && explicitEffort !== 'auto'
        ? explicitEffort
        : useCodingDefaults
          ? coding.effort
          : 'auto'
    const subagentModel = coding.subagentModel
    return {
      ...(model !== 'auto' && agentKind !== 'shell' ? { model } : {}),
      ...(subagentModel !== 'auto' && harnessCapabilitiesFor(agentKind)?.subagentModelEnv
        ? { subagentModel }
        : {}),
      // Cursor + shell have no effort flag; agentLaunchCommand also drops it, but
      // gating here keeps the spawn message clean (capability lookup, #158).
      ...(effort !== 'auto' && harnessSupportsEffort(agentKind) ? { effort } : {}),
      // Per-session CLI theme seeding rides every (re)spawn so a resurrected
      // session keeps the configured behaviour too [spec:SP-a04d].
      ...(agentKind !== 'shell' ? { seedCliTheme: coding.seedCliTheme } : {}),
    }
  }

  /**
   * The managed credential (if any) for the coding role, as spawn env (#216).
   * Native accounts yield {} — the CLI uses its own login and the frame is
   * unchanged.
   */
  accountEnv(
    agentKind: AgentKind,
    // KEPT AS A DEFAULT PARAMETER, not rewritten to an `=== undefined` check
    // inside the body. A default parameter is evaluated at CALL time, before the
    // body runs, so the original performed this settings read even for 'shell'
    // — which then returns {} and discards it. Moving the read inside the body
    // would skip it for shell: almost certainly harmless, and still a behaviour
    // change made silently during a move, which is the thing this decomposition
    // is under instruction not to do.
    accountId: string = resolveRole(
      this.ports.store.settings.getSettingsFor(this.ports.settingsViewer()),
      'coding',
    ).accountId,
  ): { env?: Record<string, string> } {
    if (agentKind === 'shell') return {}
    return resolveAccountEnv(this.ports.store.accounts, accountId)
  }
}

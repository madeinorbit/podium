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
import type { AccountId, AgentKind, MachineId, UserId } from '@podium/model'
import { resolveRole } from '@podium/runtime'
import type { SessionStore } from '../../store'
import { vetLaunchSelection } from '../../model-validation'
import { resolveAccountEnv } from './account-env'

export interface LaunchConfigPorts {
  store: Pick<SessionStore, 'settings' | 'accounts'>
  /** Whose preferences a spawning read uses. Not this module's decision. */
  settingsViewer(): UserId | Promise<UserId>
}

export interface LaunchModelDefaults {
  model?: string
  subagentModel?: string
  effort?: string
  seedCliTheme?: boolean
}

export class SessionLaunchConfig {
  constructor(private readonly ports: LaunchConfigPorts) {}

  /**
   * The model/effort a spawn runs with: the caller's values, else the coding
   * role's Settings defaults when the spawn is on that role's harness.
   *
   * The caller's values were already accepted by the entry point that took them
   * and pass through untouched. The Settings defaults are INHERITED: with a
   * `machineId` they are checked against that machine's catalog, and one it does
   * not know is dropped to `auto` rather than handed to the CLI as `--model`
   * (POD-3911). Without a `machineId` nothing is checked, as before.
   */
  async modelDefaults(
    agentKind: AgentKind,
    override?: { model?: string; effort?: string },
    machineId?: MachineId,
  ): Promise<LaunchModelDefaults> {
    const settings = await this.ports.store.settings.getSettingsFor((await this.ports.settingsViewer()))
    const coding = settings.roles.coding
    const useCodingDefaults = agentKind === resolveRole(settings, 'coding').harness
    const given = (value: string | undefined): value is string =>
      value !== undefined && value !== 'auto'
    const fromSettings = {
      ...(useCodingDefaults && !given(override?.model) ? { model: coding.model } : {}),
      ...(useCodingDefaults && !given(override?.effort) ? { effort: coding.effort } : {}),
    }
    const vetted = vetLaunchSelection(
      machineId !== undefined && (fromSettings.model || fromSettings.effort)
        ? await this.ports.store.settings.getModelCatalog(machineId)
        : null,
      // A Settings effort beside a caller's model is checked against the
      // harness's efforts as a whole, not that one model's: the caller's model
      // is not this function's to re-check.
      { agentKind, inherited: fromSettings },
    )
    const model = given(override?.model) ? override.model : vetted.model
    const effort = given(override?.effort) ? override.effort : vetted.effort
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
  async accountEnv(
    agentKind: AgentKind,
    accountId?: AccountId,
  ): Promise<{ env?: Record<string, string> }> {
    // Resolve before the shell arm to preserve the old default-parameter timing:
    // an omitted account still performs this live settings read for every call.
    const selectedAccountId =
      accountId ??
      resolveRole(
        await this.ports.store.settings.getSettingsFor((await this.ports.settingsViewer())),
        'coding',
      ).accountId
    if (agentKind === 'shell') return {}
    return await resolveAccountEnv(this.ports.store.accounts, selectedAccountId)
  }
}

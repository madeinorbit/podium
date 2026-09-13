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
 * WHOSE PREFERENCES ARE READ is a REQUIRED PARAMETER (PDM-295), not a port.
 *
 * It used to arrive through a `settingsViewer()` port whose single implementation
 * returned `firstAdminMemberId()`, so every spawn on the instance ran on the
 * earliest admin's model, effort and account slot. Making the viewer a parameter
 * is the repair PDM-291 used for the read path: a TYPE rather than a flag, so a
 * caller with no human to name does not compile instead of resolving to one.
 *
 * WHOSE CREDENTIAL IS INJECTED is a different question, and `accountEnv` takes it
 * as `owner`. It is now answered by the SAME person as the slot — which is what
 * closes the split PDM-280 §7.4 recorded, where a member could be refused on a
 * slot somebody else had chosen and that they could not change from their own
 * settings. The two remain separate parameters because they are separate
 * questions: preference versus ownership. They simply no longer disagree.
 */

import type { AccountId, AgentKind, UserId } from '@podium/model'
import { resolveRole } from '@podium/runtime'
import { harnessCapabilitiesFor, harnessSupportsEffort } from '../../harness-manifest'
import type { SessionStore } from '../../store'
import { resolveAccountEnv } from './account-env'

export interface LaunchConfigPorts {
  store: Pick<SessionStore, 'settings' | 'accounts'>
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
   * `viewer` IS THE HUMAN WHOSE PREFERENCES THESE ARE, and it is required
   * (PDM-295). Both callers hold one: `spawn()` takes `ownerUserId` as a
   * required parameter since B1, and `create()` resolves its owner before it
   * asks this question.
   */
  async modelDefaults(
    agentKind: AgentKind,
    viewer: UserId,
    override?: { model?: string; effort?: string },
  ): Promise<LaunchModelDefaults> {
    const settings = await this.ports.store.settings.getSettingsFor(viewer)
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
   *
   * `owner` IS THE SESSION'S OWNER AND ARRIVES FROM THE CALLER (PDM-280). It now
   * answers BOTH halves, which is the PDM-295 repair:
   *
   *  - WHICH SLOT this role runs on is a PREFERENCE, and it is read for `owner`.
   *  - WHOSE CREDENTIAL fills that slot is OWNERSHIP, also `owner`.
   *
   * They are still two questions and the code still spells them separately; what
   * changed is that the first one stopped being answered by the earliest admin.
   * Before PDM-295 the slot came from `settingsViewer()` and the credential from
   * this owner's rows, so a member could be refused on a slot they never chose
   * and could not change from their own settings (PDM-280 §7.4). A person who
   * picks a managed slot and connects its key now spawns; one who picks a slot
   * and connects nothing is still refused, by name, and never borrows.
   *
   * A `shell` still gets nothing and is checked BEFORE the credential lookup:
   * refusing to open a terminal because a provider key is missing would be
   * absurd, and a shell was never given a credential to begin with (injecting
   * one would put it a single `env` away from the browser).
   */
  async accountEnv(
    agentKind: AgentKind,
    owner: UserId,
    accountId?: AccountId,
  ): Promise<{ env?: Record<string, string> }> {
    // Resolve before the shell arm to preserve the old default-parameter timing:
    // an omitted account still performs this live settings read for every call.
    const selectedAccountId =
      accountId ??
      resolveRole(await this.ports.store.settings.getSettingsFor(owner), 'coding').accountId
    if (agentKind === 'shell') return {}
    return await resolveAccountEnv(this.ports.store.accounts, owner, selectedAccountId)
  }
}

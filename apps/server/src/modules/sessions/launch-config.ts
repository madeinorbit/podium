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
 * service that knows the calling principal. POD-315 was supposed to replace that
 * port's body with the requesting principal and closed without doing it, so it
 * still answers `firstAdminMemberId()` — PDM-295. This module needs no change
 * when that is fixed.
 *
 * WHOSE CREDENTIAL IS INJECTED is a different question with a different answer,
 * and `accountEnv` takes it as a parameter rather than reading the port. See
 * there.
 */

import type { AccountId, AgentKind, UserId } from '@podium/model'
import { resolveRole } from '@podium/runtime'
import { harnessCapabilitiesFor, harnessSupportsEffort } from '../../harness-manifest'
import type { SessionStore } from '../../store'
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

  async modelDefaults(
    agentKind: AgentKind,
    override?: { model?: string; effort?: string },
  ): Promise<LaunchModelDefaults> {
    const settings = await this.ports.store.settings.getSettingsFor(
      await this.ports.settingsViewer(),
    )
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
   * `owner` IS THE SESSION'S OWNER AND ARRIVES FROM THE CALLER (PDM-280), which
   * is a different question from `settingsViewer()` and must not be folded into
   * it. The two answer different things and, until PDM-295, different people:
   *
   *  - WHICH SLOT this role runs on is a PREFERENCE, read through
   *    `settingsViewer()` — today the earliest admin's for everyone.
   *  - WHOSE CREDENTIAL fills that slot is OWNERSHIP, and belongs to the human
   *    the session belongs to.
   *
   * So a member can be refused on a slot chosen by somebody else. That is a real
   * consequence rather than an oversight, it is the PDM-295 orphan's to remove,
   * and the refusal message says "connect a key" for exactly that reason.
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
      resolveRole(
        await this.ports.store.settings.getSettingsFor(await this.ports.settingsViewer()),
        'coding',
      ).accountId
    if (agentKind === 'shell') return {}
    return await resolveAccountEnv(this.ports.store.accounts, owner, selectedAccountId)
  }
}

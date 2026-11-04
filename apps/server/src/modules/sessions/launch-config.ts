/** Spawn companions shared by new sessions and revival: subagent model,
 * theme seed and account environment. Model/effort belong to the launch resolver. */

import type { AccountId, AgentKind, MachineId, UserId } from '@podium/model'
import { resolveRole } from '@podium/runtime'
import { harnessCapabilitiesFor } from '../../harness-manifest'
import type { SessionStore } from '../../store'
import { type AccountEnvTarget, resolveAccountEnv } from './account-env'

export interface LaunchConfigPorts {
  store: Pick<SessionStore, 'settings' | 'accounts' | 'machines'>
  /** Whose preferences a spawning read uses. Not this module's decision. */
  settingsViewer(): UserId | Promise<UserId>
}

export interface LaunchModelDefaults {
  subagentModel?: string
  seedCliTheme?: boolean
}

export class SessionLaunchConfig {
  constructor(private readonly ports: LaunchConfigPorts) {}

  /** Companions only. Legacy arguments remain until the restart caller moves. */
  async modelDefaults(
    agentKind: AgentKind,
    _override?: { model?: string; effort?: string },
    _machineId?: MachineId,
  ): Promise<LaunchModelDefaults> {
    const settings = await this.ports.store.settings.getSettingsFor(
      await this.ports.settingsViewer(),
    )
    const coding = settings.roles.coding
    const subagentModel = coding.subagentModel
    return {
      ...(subagentModel !== 'auto' && harnessCapabilitiesFor(agentKind)?.subagentModelEnv
        ? { subagentModel }
        : {}),
      // Per-session CLI theme seeding rides every (re)spawn so a resurrected
      // session keeps the configured behaviour too [spec:SP-a04d].
      ...(agentKind !== 'shell' ? { seedCliTheme: coding.seedCliTheme } : {}),
    }
  }

  /**
   * The managed credential (if any) for the coding role, as spawn env (#216),
   * resolved for the session's OWNER on its machine (POD-6300): the owner's own
   * selection and the owner's own connection, never anyone else's. Native
   * accounts yield {} on the owner's machine — the CLI uses its own login and
   * the frame is unchanged. A refusal (`SpawnAccountRefusal`) says why.
   */
  async accountEnv(
    agentKind: AgentKind,
    accountId: AccountId | undefined,
    target: AccountEnvTarget,
  ): Promise<{ env?: Record<string, string> }> {
    if (agentKind === 'shell') return {}
    const selectedAccountId =
      accountId ??
      resolveRole(await this.ports.store.settings.getSettingsFor(target.ownerUserId), 'coding')
        .accountId
    return await resolveAccountEnv(this.ports.store, selectedAccountId, target)
  }
}

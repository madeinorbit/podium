/** Spawn companions shared by new sessions and revival: subagent model,
 * theme seed and account environment. Model/effort belong to the launch resolver. */

import type { AccountId, AgentKind, UserId } from '@podium/model'
import { resolveRole } from '@podium/runtime'
import { harnessCapabilitiesFor } from '../../harness-manifest'
import type { SessionStore } from '../../store'
import { type AccountEnvTarget, resolveAccountEnv } from './account-env'

export interface LaunchConfigPorts {
  store: Pick<SessionStore, 'settings' | 'accounts' | 'machines'>
}

export interface LaunchModelDefaults {
  subagentModel?: string
  seedCliTheme?: boolean
}

export class SessionLaunchConfig {
  constructor(private readonly ports: LaunchConfigPorts) {}

  /** Companions only, from the preferences of `owner`, the person the session
   *  runs for (POD-6285): Bob's spawn uses Bob's choices, never Alice's. */
  async modelDefaults(agentKind: AgentKind, owner: UserId): Promise<LaunchModelDefaults> {
    const settings = await this.ports.store.settings.getSettingsFor(owner)
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

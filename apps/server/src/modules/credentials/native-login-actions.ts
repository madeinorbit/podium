/** Default-home login and the D11 choice; both act only for the signed-in owner. */
import { asUserId, type MachineId, type UserId } from '@podium/model'
import type { RegistryModules, SessionRegistry } from '../../relay'

export interface NativeLoginState {
  readonly store: Pick<SessionRegistry['sessionStore'], 'nativeLogins' | 'machines'>
  readonly machineService: RegistryModules['machines']
  readonly nativeLogin: RegistryModules['nativeLogin']
  readonly loginPropagation?: Pick<RegistryModules['loginPropagation'], 'propagate'>
  readonly machineStanding: () => Promise<ReadonlyMap<MachineId, 'custody' | 'use'>>
  readonly now?: () => Date
}

export async function useOnMyMachines(
  native: NativeLoginState,
  callerUserId: UserId,
  input: { harness: Parameters<NativeLoginState['nativeLogin']['start']>[0]['harness']; fingerprint: string; enabled: boolean },
) {
      const owner = asUserId(callerUserId)
      const custody = [...(await native.machineStanding())]
        .filter(([, standing]) => standing === 'custody')
        .map(([id]) => id)
      if (input.enabled) {
        // Only a login observed on one of the caller's own machines can be
        // ticked: it is theirs (design §2.5), and nobody else's is nameable.
        const observed = [...(await native.store.machines.getMachines(custody)).values()].some(
          (machine) =>
            !machine.revokedAt &&
            machine.inventory?.agents.some(
              (agent) =>
                agent.kind === input.harness &&
                agent.login.state === 'in' &&
                agent.login.identity?.fingerprint === input.fingerprint,
            ),
        )
        if (!observed) {
          throw new Error(`none of your machines is signed in to that ${input.harness} account`)
        }
      }
      await native.store.nativeLogins.setOptIn(
        owner,
        input.harness,
        input.fingerprint,
        input.enabled,
        (native.now?.() ?? new Date()).toISOString(),
      )
      // A tick reaches the caller's current machines now; future ones get it
      // when they enroll or first run that harness. Unticking copies nothing
      // more and recalls nothing already installed.
      if (input.enabled) {
        const refused: string[] = []
        for (const machineId of custody) {
          const result = await native.loginPropagation?.propagate({
            targetMachineId: machineId,
            agentKind: input.harness,
            principalUserId: owner,
            fingerprint: input.fingerprint,
            // A machine that has not reported this harness yet still gets it;
            // the daemon keeps any login already there.
            force: true,
          })
          if (result?.status === 'failed') refused.push(result.reason)
        }
        if (refused.length > 0)
          throw new Error(
            `The connection is enabled, but copying was refused: ${refused.join('; ')}`,
          )
      }
      return { ok: true as const, enabled: input.enabled }

}

/**
 * HOW A PLACEMENT'S REMOVAL REACHES A MACHINE (credential management §8
 * "cleanup", §10 "Homes"; epic Tasks 8 and 13).
 *
 * The two removers `Placements` calls, bound to the daemon's home requests:
 * a propagated login file goes by `credentialRemoveRequest` (only while its
 * fingerprint still matches), a home by `homeRemoveRequest`. Each answers
 * `true` only on the machine's confirmation. A daemon without
 * `CAP_HARNESS_HOMES` is not asked: its placements stay `removal-pending`.
 *
 * A home is removed by the id its placement recorded (a home a sign-in for
 * another credential made, §10 review focus 5), else by the credential's own.
 *
 * THE VENDOR'S SIGN-OUT IS OFF (Task 9). §8 says removing a home runs the
 * vendor's sign-out in it first, and the daemon can (`signOut` on the
 * request). Whether a sign-out also ends other logins of the same account, a
 * person's default login among them, is not measured yet, and Podium never
 * signs out of a login it did not make. Until that measurement says siblings
 * survive, {@link HOME_SIGN_OUT_ON_REMOVE} stays false: the home's files are
 * deleted, which ends the login on that machine, and its tokens stay valid at
 * the provider until they expire or the person signs out there.
 */

import { harnessAccepts } from '@podium/harness/metadata'
import { createLogger } from '@podium/logger'
import type { MachineId } from '@podium/model'
import {
  CAP_HARNESS_HOMES,
  type CredentialRemoveResultMessage,
  HOME_HARNESSES,
  type HomeHarness,
  type HomeRemoveResultMessage,
  homeIdFor,
} from '@podium/protocol'
import type { CredentialRecord, PlacementRecord } from '../../store/credentials'
import type { PlacementTransport } from './placements'

const log = createLogger('server:credentials')

type Payload<M> = Omit<M, 'type' | 'requestId'>

/** Whether removing a home asks the daemon to run the vendor's sign-out in it first. */
export const HOME_SIGN_OUT_ON_REMOVE = false

export interface PlacementRemoverDeps {
  daemonSupports(machineId: MachineId, cap: string): boolean
  rpc: {
    credentialRemove(
      harness: HomeHarness,
      fingerprint: string,
      machineId: MachineId,
    ): Promise<Payload<CredentialRemoveResultMessage>>
    homeRemove(
      homeId: string,
      machineId: MachineId,
      options?: { signOut?: boolean },
    ): Promise<Payload<HomeRemoveResultMessage>>
  }
  /** Run the vendor's sign-out before deleting a home. Default {@link HOME_SIGN_OUT_ON_REMOVE}. */
  signOut?: boolean
}

/** The harness whose home holds a login of `type`, if any. */
export function homeHarnessFor(type: string): HomeHarness | undefined {
  return HOME_HARNESSES.find((harness) =>
    harnessAccepts(harness).some((line) => line.type === type && line.deliver.kind === 'home'),
  )
}

export function placementRemovers(deps: PlacementRemoverDeps): PlacementTransport['removers'] {
  return {
    'propagated-file': async (machineId: MachineId, credential: CredentialRecord) => {
      const harness = homeHarnessFor(credential.type)
      const fingerprint = credential.identity.fingerprint
      if (!harness || !fingerprint || !deps.daemonSupports(machineId, CAP_HARNESS_HOMES))
        return false
      const { outcome, error } = await deps.rpc.credentialRemove(harness, fingerprint, machineId)
      if (outcome === 'changed') {
        // Someone signed in to another login there since: that one is not
        // Podium's copy, it stays, and this credential's copy is gone.
        log.info('a propagated login was replaced since; left in place', {
          credentialId: credential.id,
          machineId,
        })
      }
      if (outcome === 'failed') {
        log.warn('a machine could not remove a propagated login', {
          credentialId: credential.id,
          machineId,
          error,
        })
      }
      return outcome !== 'failed'
    },
    home: async (machineId: MachineId, credential: CredentialRecord, placement: PlacementRecord) => {
      const harness = homeHarnessFor(credential.type)
      if (!harness || !deps.daemonSupports(machineId, CAP_HARNESS_HOMES)) return false
      const homeId = placement.homeId ?? homeIdFor(credential.id, harness)
      const signOut = deps.signOut ?? HOME_SIGN_OUT_ON_REMOVE
      const result = await deps.rpc.homeRemove(homeId, machineId, signOut ? { signOut } : {})
      if (!result.ok) {
        log.warn('a machine could not remove a home', {
          credentialId: credential.id,
          machineId,
          error: result.error,
        })
      }
      return result.ok
    },
  }
}

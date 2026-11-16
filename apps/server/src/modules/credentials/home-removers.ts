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
 * The vendor's sign-out before a home is removed is Task 9's, in front of the
 * `home` remover here.
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
import type { CredentialRecord } from '../../store/credentials'
import type { PlacementTransport } from './placements'

const log = createLogger('server:credentials')

type Payload<M> = Omit<M, 'type' | 'requestId'>

export interface PlacementRemoverDeps {
  daemonSupports(machineId: MachineId, cap: string): boolean
  rpc: {
    credentialRemove(
      harness: HomeHarness,
      fingerprint: string,
      machineId: MachineId,
    ): Promise<Payload<CredentialRemoveResultMessage>>
    homeRemove(homeId: string, machineId: MachineId): Promise<Payload<HomeRemoveResultMessage>>
  }
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
    home: async (machineId: MachineId, credential: CredentialRecord) => {
      const harness = homeHarnessFor(credential.type)
      if (!harness || !deps.daemonSupports(machineId, CAP_HARNESS_HOMES)) return false
      const result = await deps.rpc.homeRemove(homeIdFor(credential.id, harness), machineId)
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

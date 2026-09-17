import type { z } from 'zod'
import type { MachineKeyCredential } from '../envelope'
import { machinePrincipalOf } from './machine-principal'
import type {
  AuthInput,
  AuthOutcome,
  CapabilityMinter,
  MachineDirectory,
  PeerAuthStrategy,
} from './types'

type Credential = z.infer<typeof MachineKeyCredential>

export interface MachineKeyDeps {
  readonly machines: MachineDirectory
  readonly mint: Pick<CapabilityMinter, 'forMachine'>
}

export const createMachineKeyStrategy = (
  deps: MachineKeyDeps,
): PeerAuthStrategy<Credential> => ({
  role: 'machine',
  credentialKind: 'machineKey',
  name: 'machine-key',
  authenticate({ credential, hello, transport }: AuthInput<Credential>): AuthOutcome {
    const machine = deps.machines.verifyMachineKey?.(credential, {
      // Host metadata the directory records; never identity.
      ...(hello.claims?.hostname === undefined ? {} : { hostname: hello.claims.hostname }),
    }) ?? null
    if (machine === null)
      return { ok: false, reason: 'auth-failed', diagnostic: 'machine signature did not verify' }
    return {
      ok: true,
      name: machine.name,
      assignedId: machine.machine,
      legacyBindingOwners: machine.legacyBindingOwners,
      bindingConfirmations: machine.bindingConfirmations,
      ...(machine.directoryContext === undefined
        ? {}
        : { directoryContext: machine.directoryContext }),
      ...(machine.updatePubkey === undefined ? {} : { updatePubkey: machine.updatePubkey }),
      ...(machine.updateKeyRotations === undefined
        ? {}
        : { updateKeyRotations: machine.updateKeyRotations }),
      principal: machinePrincipalOf(machine, transport, deps.mint),
    }
  },
})

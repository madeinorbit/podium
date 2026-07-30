/**
 * MACHINE (remote, reconnect) — long-lived machine token. ADR 5 D5 row 3, second
 * half: "reconnects use `hello` + token".
 *
 * What authenticates it: the token minted by the pairing branch, verified through
 * {@link MachineDirectory}.
 *
 * What it may then address: what its machine principal is authorized for, with
 * the owner and grants the directory returns.
 *
 * What it is refused: an unknown, rotated or revoked token — `auth-failed`, with
 * no peer-visible detail (a token failure must not tell an unauthenticated peer
 * whether the machine exists).
 *
 * THE HINT IS NOT THE IDENTITY. `credential.machineHint` may narrow the
 * directory's lookup — today's store indexes credentials per machine row — but the
 * resolved principal's machine id is whatever record the directory VERIFIED the
 * token against. `machine-token.test.ts` pins it: a hello whose hint (and whose
 * `claims.machineId`) name a different machine still resolves to the token's own
 * machine.
 */

import type { z } from 'zod'
import type { MachineTokenCredential } from '../envelope'
import { machinePrincipalOf } from './machine-principal'
import type {
  AuthInput,
  AuthOutcome,
  CapabilityMinter,
  MachineDirectory,
  PeerAuthStrategy,
} from './types'

type Credential = z.infer<typeof MachineTokenCredential>

export interface MachineTokenDeps {
  readonly machines: MachineDirectory
  readonly mint: Pick<CapabilityMinter, 'forMachine'>
}

export const createMachineTokenStrategy = (
  deps: MachineTokenDeps,
): PeerAuthStrategy<Credential> => ({
  role: 'machine',
  credentialKind: 'machineToken',
  name: 'machine-token',
  authenticate({ credential, hello, transport }: AuthInput<Credential>): AuthOutcome {
    const machine = deps.machines.verifyMachineToken(credential.token, credential.machineHint, {
      // Host metadata the directory records; never identity.
      ...(hello.claims?.hostname === undefined ? {} : { hostname: hello.claims.hostname }),
    })
    if (machine === null)
      return { ok: false, reason: 'auth-failed', diagnostic: 'machine token did not verify' }
    return {
      ok: true,
      name: machine.name,
      assignedId: machine.machine,
      ...(machine.directoryContext === undefined
        ? {}
        : { directoryContext: machine.directoryContext }),
      principal: machinePrincipalOf(machine, transport, deps.mint),
    }
  },
})

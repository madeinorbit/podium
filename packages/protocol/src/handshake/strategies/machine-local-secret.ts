/**
 * MACHINE (local) — shared host secret. ADR 5 D5 row 2.
 *
 * What authenticates it: the secret from `readOrCreateDaemonSecret`
 * (`@podium/runtime/local-machine`), presented as a hello credential on the
 * `/daemon` endpoint. THE SAME HELLO PATH AS REMOTE — not a pairing ceremony, and
 * not a bootstrap special case: the server pre-registers the local machine
 * (`ensureHostMachine`) with a server-owned credential and its same-host daemon
 * comes through here like any other.
 *
 * What it may then address: what its MACHINE principal is authorized for. A
 * machine is not a person, so `attributionOf` gives it `onBehalfOf: null`.
 *
 * What it is refused: everything without the secret. Explicitly NOT accepted as
 * proof: the connection being loopback, the peer claiming
 * `machineId: 'local'`, or the caller having authenticated to the server as a
 * human. Readiness §3.1.4 M4 is the case: on an all-in-one install the local
 * daemon IS the server host's machine, and an authenticated human must not
 * inherit execute on it. `machineUseAllowed` is the gate that keeps that true
 * even after a successful handshake; this module's job is to not hand out a
 * machine principal for anything other than the secret.
 *
 * OPERATIONAL NOTE (ADR 5 D5 invariants): the secret file lives in the instance
 * state dir. Deleting it under a running split daemon causes auth rejection until
 * restart — an availability blip, not data loss. Fail closed is the correct
 * behavior there, and it is what this module does.
 */

import type { z } from 'zod'
import type { DaemonSecretCredential } from '../envelope'
import { machinePrincipalOf } from './machine-principal'
import type {
  AuthInput,
  AuthOutcome,
  CapabilityMinter,
  MachineDirectory,
  PeerAuthStrategy,
} from './types'

type Credential = z.infer<typeof DaemonSecretCredential>

export interface MachineLocalSecretDeps {
  readonly machines: MachineDirectory
  readonly mint: Pick<CapabilityMinter, 'forMachine'>
}

export const createMachineLocalSecretStrategy = (
  deps: MachineLocalSecretDeps,
): PeerAuthStrategy<Credential> => ({
  role: 'machine',
  credentialKind: 'daemonSecret',
  name: 'machine-local-secret',
  authenticate({ credential, hello, transport }: AuthInput<Credential>): AuthOutcome {
    // Identity comes from the record the directory verified the secret against —
    // never from `hello.claims.machineId`, which this module does not read. The
    // hostname is passed through as host METADATA (the directory records it) and
    // takes no part in resolving who the peer is.
    const machine = deps.machines.verifyDaemonSecret(credential.secret, {
      ...(hello.claims?.hostname === undefined ? {} : { hostname: hello.claims.hostname }),
    })
    if (machine === null)
      return { ok: false, reason: 'auth-failed', diagnostic: 'daemon secret did not verify' }
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

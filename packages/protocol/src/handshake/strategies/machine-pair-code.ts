/**
 * MACHINE (remote, first contact) — one-shot pair code. ADR 5 D5 row 3.
 *
 * What authenticates it: a pair code from the join token (`JoinPayload` embeds
 * `serverUrl` + `pairCode`), redeemed through {@link MachineDirectory}. Codes are
 * single-use, short-TTL and memory-held (`PairingManager`), so a redeemed or
 * expired code authenticates nothing.
 *
 * What it may then address: what its machine principal is authorized for. The
 * pairer becomes the machine's OWNER (readiness §3.1.4 M3) and a newly paired
 * machine is PRIVATE to its pairer — the directory records that; this module does
 * not widen it.
 *
 * What it is refused: an unknown, expired or already-redeemed code, a server with
 * pairing disabled, and a requested machineId that already has a row (POD-1125 —
 * a pair code must not rebind another machine's credential). This is the one
 * branch that may return a peer-visible message, because "invalid or expired code"
 * is the pairing ceremony's own UX and discloses nothing about any identity.
 *
 * INERT: `claims.name` / `claims.hostname` are a DISPLAY-NAME REQUEST. They are
 * passed to the directory as a requested label and can never select which machine
 * row is resolved — the row comes from redeeming the code.
 */

import type { z } from 'zod'
import type { PairCodeCredential } from '../envelope'
import { machinePrincipalOf } from './machine-principal'
import type {
  AuthInput,
  AuthOutcome,
  CapabilityMinter,
  MachineDirectory,
  PeerAuthStrategy,
} from './types'

type Credential = z.infer<typeof PairCodeCredential>

export interface MachinePairCodeDeps {
  readonly machines: MachineDirectory
  readonly mint: Pick<CapabilityMinter, 'forMachine'>
}

export const createMachinePairCodeStrategy = (
  deps: MachinePairCodeDeps,
): PeerAuthStrategy<Credential> => ({
  role: 'machine',
  credentialKind: 'pairCode',
  name: 'machine-pair-code',
  authenticate({ credential, hello, transport }: AuthInput<Credential>): AuthOutcome {
    const paired = deps.machines.redeemPairCode(credential.code, {
      // A brand-new machine has no prior identity to authenticate, so these are
      // its REQUEST. The directory decides what row results (see PairingRequest).
      ...(hello.claims?.machineId === undefined ? {} : { machineId: hello.claims.machineId }),
      ...(hello.claims?.name === undefined ? {} : { name: hello.claims.name }),
      ...(hello.claims?.hostname === undefined ? {} : { hostname: hello.claims.hostname }),
    })
    if (paired === null)
      return {
        ok: false,
        reason: 'auth-failed',
        diagnostic:
          'pair code invalid, expired, already used, pairing disabled, or machine id already registered',
        peerMessage: 'invalid or expired code',
      }
    return {
      ok: true,
      name: paired.name,
      assignedId: paired.machine,
      ...(paired.directoryContext === undefined
        ? {}
        : { directoryContext: paired.directoryContext }),
      // Handed back exactly once; the peer persists it and reconnects with the
      // machine-token strategy from then on.
      issuedToken: paired.issuedToken,
      ...(paired.updatePubkey === undefined ? {} : { updatePubkey: paired.updatePubkey }),
      principal: machinePrincipalOf(paired, transport, deps.mint),
    }
  },
})

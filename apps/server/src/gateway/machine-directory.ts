/**
 * The server-side {@link MachineDirectory} — the credential half of ADR 5 D5's
 * three `machine` rows, backed by `MachinesService.authenticateDaemon`.
 *
 * WHY IT WRAPS RATHER THAN REPLACES `authenticateDaemon`: that method owns the
 * token-hash comparison, the `touchMachine` bookkeeping, the pairing redemption
 * and the pairing grant, and all four must keep behaving exactly as they do
 * today. This adapter re-expresses them as the three credential rows so the
 * handshake sees three DIFFERENT credentials instead of one polymorphic frame —
 * which is the distinction ADR 5 D5 draws and the reason each row is a separate
 * strategy module.
 *
 * WHAT IS NOT HERE YET: `owner` and `grants`. The `machines` table has neither
 * (POD-1079 / POD-318 own machine ownership), so every resolution reports
 * `owner: null` and no grants, and `machineUseAllowed` therefore refuses `use` to
 * everyone. That is the fail-closed direction: on an all-in-one install nobody
 * inherits execute on the host machine by authenticating to the server (readiness
 * §3.1.4 M4 / ADR 3 Amendment 1 D18.6). The type already carries both fields, so
 * POD-1079 fills them in without touching the handshake.
 */

import type { MachineId } from '@podium/protocol'
import type {
  MachineDirectory,
  PairedMachine,
  PairingRequest,
  PeerObservations,
  ResolvedMachine,
} from '@podium/protocol'
import { LOCAL_MACHINE_ID } from '../local-machine'
import type { PairingGrant } from '../modules/machines/service'

/** The slice of `MachinesService` this adapter needs. */
export interface MachineAuthenticator {
  authenticateDaemon(frame: {
    type: 'pair' | 'hello'
    code?: string
    machineId: string
    token?: string
    hostname: string
    name?: string
  }): { ok: true; machineId: string; name: string; token?: string; pairingGrant?: PairingGrant } | {
    ok: false
    reason: string
  }
}

const resolved = (
  machineId: string,
  name: string,
  pairingGrant?: PairingGrant,
): ResolvedMachine => ({
  machine: machineId as MachineId,
  // POD-1079's deliverable. `null` means "grants `use` to nobody" — see the
  // header note and `machineUseAllowed`.
  owner: null,
  grants: [],
  name,
  ...(pairingGrant === undefined ? {} : { directoryContext: pairingGrant }),
})

export const createMachineDirectory = (machines: MachineAuthenticator): MachineDirectory => ({
  /**
   * ADR 5 D5 row 2. The local machine's shared host secret IS its stored
   * credential (`ensureLocalMachine` registers `local` with it at startup), so
   * verifying the secret is verifying `local`'s credential — the same hello path
   * as any remote, not a bootstrap special case.
   */
  verifyDaemonSecret(secret: string, observed?: PeerObservations): ResolvedMachine | null {
    const auth = machines.authenticateDaemon({
      type: 'hello',
      machineId: LOCAL_MACHINE_ID,
      token: secret,
      hostname: observed?.hostname ?? LOCAL_MACHINE_ID,
    })
    return auth.ok ? resolved(auth.machineId, auth.name) : null
  },

  /**
   * ADR 5 D5 row 3, reconnect. The hint narrows the lookup because today's store
   * indexes a credential per machine row (`getMachineByToken(machineId, token)`);
   * a token with no hint therefore cannot be resolved and FAILS CLOSED rather
   * than scanning. The resolved identity is the row the token verified against —
   * a hint naming another machine does not move it, because the token would not
   * verify against that row.
   */
  verifyMachineToken(
    token: string,
    machineHint?: string,
    observed?: PeerObservations,
  ): ResolvedMachine | null {
    if (machineHint === undefined) return null
    const auth = machines.authenticateDaemon({
      type: 'hello',
      machineId: machineHint,
      token,
      hostname: observed?.hostname ?? machineHint,
    })
    return auth.ok ? resolved(auth.machineId, auth.name) : null
  },

  /** ADR 5 D5 row 3, first contact. Single-use, short-TTL codes (`PairingManager`). */
  redeemPairCode(code: string, request?: PairingRequest): PairedMachine | null {
    // A brand-new machine has no prior identity to authenticate, so it proposes
    // one. `MachinesService` decides what row results; this adapter passes the
    // proposal through and reports back whatever came out.
    if (request?.machineId === undefined) return null
    const auth = machines.authenticateDaemon({
      type: 'pair',
      code,
      machineId: request.machineId,
      hostname: request.hostname ?? request.machineId,
      ...(request.name === undefined ? {} : { name: request.name }),
    })
    if (!auth.ok || auth.token === undefined) return null
    return { ...resolved(auth.machineId, auth.name, auth.pairingGrant), issuedToken: auth.token }
  },
})

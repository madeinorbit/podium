/**
 * The one place a MachinePrincipal is built, shared by the three `machine` rows
 * of ADR 5 D5 (local secret, pair code, machine token).
 *
 * The rows differ ONLY in how the credential is verified — that difference is the
 * whole reason they are separate modules. What must not differ is the shape of
 * the principal they produce, so it is built here rather than three times: a
 * machine that authenticated by pair code must be indistinguishable, downstream,
 * from the same machine reconnecting with its token.
 */

import { asDeviceId, type MachinePrincipal } from '../../planes/principal'
import type { CapabilityMinter, ResolvedMachine, TransportFacts } from './types'

export const machinePrincipalOf = (
  machine: ResolvedMachine,
  transport: TransportFacts,
  mint: Pick<CapabilityMinter, 'forMachine'>,
): MachinePrincipal => ({
  kind: 'machine',
  machine: machine.machine,
  /**
   * The DEVICE half is the connection this call arrived on (ADR 3 Amendment 1
   * D14.1). A daemon that reconnects is the same machine on a new binding, which
   * is why the connection id is preferred over the machine id when the gateway
   * assigned one.
   */
  device: asDeviceId(transport.connectionId ?? machine.machine),
  capability: mint.forMachine(machine.machine),
})

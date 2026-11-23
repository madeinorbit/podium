/** The vault commands on the plain path (ADR 12 D8). Routes: `trpc.ts`. */

import { asUserId } from '@podium/model'
import { TRPCError } from '@trpc/server'
import { recordCredentialEvent } from '../credentials/events'
import { definePlainFamily } from '../plain-command/declare'
import { VAULT_COMMANDS_TRPC, type VaultState } from './registry'

export const VAULT_PLAIN_FAMILY = definePlainFamily({
  family: 'vault',
  service: (state): VaultState => ({
    vault: state.store.vault,
    recordEvent: (event) => recordCredentialEvent(state.store, event),
    callerUserId: asUserId(state.caller.userId),
    requireAdmin: () => {
      if (state.principal.kind !== 'user' || state.principal.capability.role !== 'admin') {
        throw new TRPCError({ code: 'FORBIDDEN', message: 'Administrator required' })
      }
    },
  }),
  commands: VAULT_COMMANDS_TRPC,
})

/** The credential commands on the plain path (ADR 12 D8). Routes: `trpc.ts`. */

import { asUserId } from '@podium/model'
import { definePlainFamily } from '../plain-command/declare'
import { CREDENTIAL_COMMANDS_TRPC, type CredentialsState } from './commands'

export const CREDENTIALS_PLAIN_FAMILY = definePlainFamily({
  family: 'credentials',
  service: (state): CredentialsState => ({
    store: state.store,
    callerUserId: asUserId(state.caller.userId),
    health: state.modules.credentialHealth,
  }),
  commands: CREDENTIAL_COMMANDS_TRPC,
})

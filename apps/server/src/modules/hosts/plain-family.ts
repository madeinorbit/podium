import { definePlainFamily } from '../plain-command/declare'
import { HOST_COMMANDS_TRPC } from './registry'

/** The host writes on the plain path (ADR 12 D8): their declaration. */
export const HOST_PLAIN_FAMILY = definePlainFamily({
  family: 'hosts',
  service: (state) => ({
    hosts: state.modules.hosts,
    rpc: state.modules.rpc,
    issues: state.modules.issues,
    repos: state.repos,
  }),
  commands: HOST_COMMANDS_TRPC,
})

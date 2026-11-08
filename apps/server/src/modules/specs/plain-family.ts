import { definePlainFamily } from '../plain-command/declare'
import { SPEC_COMMANDS_TRPC } from './registry'

/** The three spec writes on the plain path (ADR 12 D8): their declaration. */
export const SPEC_PLAIN_FAMILY = definePlainFamily({
  family: 'specs',
  service: (state) => state.modules.specs,
  // `podium spec` writes come over the relay too (`write-routes/relay.ts`).
  fromModules: (modules) => modules.specs,
  commands: SPEC_COMMANDS_TRPC,
})

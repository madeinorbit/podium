import { definePlainFamily } from '../plain-command/declare'
import { MODEL_COMMANDS_TRPC, selectModelState } from './registry'

/** The model catalogue's writes on the plain path (ADR 12 D8): their declaration. */
export const MODEL_PLAIN_FAMILY = definePlainFamily({
  family: 'models',
  service: (state) => selectModelState(state.modules),
  commands: MODEL_COMMANDS_TRPC,
})

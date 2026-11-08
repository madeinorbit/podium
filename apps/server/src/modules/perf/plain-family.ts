import { definePlainFamily } from '../plain-command/declare'
import { PERF_COMMANDS_TRPC } from './commands'

/** The performance reports on the plain path (ADR 12 D8): their declaration. */
export const PERF_PLAIN_FAMILY = definePlainFamily({
  family: 'perf',
  service: (state) => ({
    perf: state.modules.perf,
    feedPrincipal: state.feedPrincipal,
    // This process's rings (absent at level `off`) and the fleet's latest
    // minutes. `loopMinutes` is passed as a bound reader, not a value: the
    // hosts service keeps updating the map after this bundle is built.
    ...(state.loopAccounting ? { loopAccounting: state.loopAccounting } : {}),
    loopMinutes: () => state.modules.hosts.loopMinutes(),
  }),
  commands: PERF_COMMANDS_TRPC,
})

import { definePlainFamily } from '../plain-command/declare'
import { LOGS_COMMANDS_TRPC } from './registry'

/** Log ingestion on the plain path (ADR 12 D8): its declaration. */
export const LOGS_PLAIN_FAMILY = definePlainFamily({
  family: 'logs',
  // The emitter is `Pick`ed to the crash tier's entry point by `LogsState`, so
  // the widening a reviewer sees here is exactly what the handler can do.
  service: (state) => ({
    ingest: state.modules.logs,
    levels: state.modules.clientLogLevels,
    fleetLevels: state.modules.fleetLogLevels,
    telemetry: state.telemetry?.emitter,
  }),
  commands: LOGS_COMMANDS_TRPC,
})

/**
 * THE JOIN — the two log-ingestion contracts (L1) paired with the
 * `LogIngestService` methods that implement them (L3), per ADR 3 D1.
 *
 * The service bundle carries the telemetry emitter beside the ingest service,
 * for the reason `perf` carries the feed principal: exactly one handler needs a
 * second thing, the widening is VISIBLE on the family, and the handler still
 * never sees a `ctx`. It is `Pick`ed down to `recordCrash` so a handler here
 * cannot read consent, build a report, or flush the queue.
 */

import {
  type AnyCommandContract,
  LOGS_CONTRACT_NAMES,
  LOGS_CONTRACTS,
  type LogsContractName,
  registryClassificationErrors,
  type TransportTag,
} from '@podium/commands'
import type { z } from 'zod'
import type { CrashTelemetry, LogIngestService } from './service'

/** Exactly what the logs family reaches. */
export interface LogsState {
  readonly ingest: LogIngestService
  /** Absent on a server assembled without telemetry — the crash still stores. */
  readonly telemetry?: CrashTelemetry | undefined
}

export type LogsHandler<In, Out> = (state: LogsState, input: In) => Out

export interface LogsCommand {
  readonly contract: AnyCommandContract
  // biome-ignore lint/suspicious/noExplicitAny: heterogeneous table; each entry's
  // input type is pinned by its own contract through the `satisfies` below.
  readonly handler: LogsHandler<any, unknown>
}

export const LOGS_COMMANDS_TRPC = {
  forward: {
    contract: LOGS_CONTRACTS.forward,
    handler: ((state, input) => state.ingest.forward(input)) satisfies LogsHandler<
      z.infer<(typeof LOGS_CONTRACTS)['forward']['input']>,
      unknown
    >,
  },
  crash: {
    contract: LOGS_CONTRACTS.crash,
    handler: ((state, input) => state.ingest.crash(input, state.telemetry)) satisfies LogsHandler<
      z.infer<(typeof LOGS_CONTRACTS)['crash']['input']>,
      unknown
    >,
  },
} as const satisfies Record<LogsContractName, LogsCommand>

export type LogsCommandName = keyof typeof LOGS_COMMANDS_TRPC

export const isLogsCommand = (name: string): name is LogsCommandName =>
  Object.hasOwn(LOGS_COMMANDS_TRPC, name)

/** ADR 3 D3, default-closed. */
export function isLogsCommandExposedOn(name: string, transport: TransportTag): boolean {
  if (!isLogsCommand(name)) return false
  return LOGS_COMMANDS_TRPC[name].contract.exposure.includes(transport)
}

export const logsCommandsOn = (transport: TransportTag): LogsCommandName[] =>
  LOGS_CONTRACT_NAMES.filter((n) => isLogsCommandExposedOn(n, transport))

export const logsRegistryClassificationErrors = (): string[] =>
  registryClassificationErrors(Object.values(LOGS_COMMANDS_TRPC).map((c) => c.contract))

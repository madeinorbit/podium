/**
 * THE JOIN — the two perf diagnostic contracts (L1) paired with the
 * `PerfRegistry` methods that implement them (L3), per ADR 3 D1.
 *
 * NAMED `commands.ts` AND NOT `registry.ts`, which every other family in this
 * cutover uses, because this module's `registry.ts` is already taken by the
 * PerfRegistry itself — the switch-latency ring [POD-701]. Two different things
 * called "registry" in one directory is how a reader ends up importing the wrong
 * one, so the newcomer yields the name.
 */

import {
  type AnyCommandContract,
  PERF_CONTRACT_NAMES,
  PERF_CONTRACTS,
  type PerfContractName,
  registryClassificationErrors,
  type TransportTag,
} from '@podium/commands'
import type { z } from 'zod'
import type { PerfRegistry } from './registry'

export type PerfHandler<In, Out> = (svc: PerfRegistry, input: In) => Out

export interface PerfCommand {
  readonly contract: AnyCommandContract
  // biome-ignore lint/suspicious/noExplicitAny: heterogeneous table; each entry's
  // input type is pinned by its own contract through the `satisfies` below.
  readonly handler: PerfHandler<any, unknown>
}

export const PERF_COMMANDS_TRPC = {
  report: {
    contract: PERF_CONTRACTS.report,
    handler: ((svc, input) => {
      svc.pushClientTrace(input)
      // Live visibility, MOVED VERBATIM from the router procedure it replaces:
      // one compact line per reported switch with the three slowest gaps between
      // consecutive marks (offsets are relative to t0). Kept because operators
      // read this line in the server log; a cutover that silently dropped it
      // would be a behaviour change wearing a refactor's clothes.
      const marks = [...input.marks].sort(
        (a: { atMs: number }, b: { atMs: number }) => a.atMs - b.atMs,
      )
      const gaps: { name: string; ms: number }[] = []
      let prevAt = 0
      for (const m of marks as { name: string; atMs: number }[]) {
        gaps.push({ name: m.name, ms: m.atMs - prevAt })
        prevAt = m.atMs
      }
      const slowest = gaps
        .sort((a, b) => b.ms - a.ms)
        .slice(0, 3)
        .map((g) => `${g.name}+${Math.round(g.ms)}ms`)
        .join(' ')
      console.log(
        `[perf] switch ${input.sessionId.slice(0, 8)} mode=${input.mode} cold=${input.cold} ` +
          `total=${Math.round(input.totalMs)}ms${input.timedOut ? ' TIMEOUT' : ''}` +
          (slowest ? ` slowest: ${slowest}` : ''),
      )
      return { ok: true as const }
    }) satisfies PerfHandler<z.infer<(typeof PERF_CONTRACTS)['report']['input']>, unknown>,
  },
  reset: {
    contract: PERF_CONTRACTS.reset,
    handler: ((svc) => {
      svc.reset()
      return { ok: true as const }
    }) satisfies PerfHandler<z.infer<(typeof PERF_CONTRACTS)['reset']['input']>, unknown>,
  },
} as const satisfies Record<PerfContractName, PerfCommand>

export type PerfCommandName = keyof typeof PERF_COMMANDS_TRPC

export const isPerfCommand = (name: string): name is PerfCommandName =>
  Object.hasOwn(PERF_COMMANDS_TRPC, name)

/** ADR 3 D3, default-closed. */
export function isPerfCommandExposedOn(name: string, transport: TransportTag): boolean {
  if (!isPerfCommand(name)) return false
  return PERF_COMMANDS_TRPC[name].contract.exposure.includes(transport)
}

export const perfCommandsOn = (transport: TransportTag): PerfCommandName[] =>
  PERF_CONTRACT_NAMES.filter((n) => isPerfCommandExposedOn(n, transport))

export const perfRegistryClassificationErrors = (): string[] =>
  registryClassificationErrors(Object.values(PERF_COMMANDS_TRPC).map((c) => c.contract))

/**
 * THE JOIN — the two perf diagnostic contracts (L1) paired with the
 * `PerfRegistry` methods that implement them (L3), per ADR 3 D1.
 *
 * NAMED `commands.ts` AND NOT `registry.ts`, which every other family in this
 * cutover uses, because this module's `registry.ts` is already taken by the
 * PerfRegistry itself — the switch-latency ring [POD-701]. Two different things
 * called "registry" in one directory is how a reader ends up importing the wrong
 * one, so the newcomer yields the name.
 *
 * ---------------------------------------------------------------------------
 * THE SERVICE BUNDLE CARRIES THE TRANSPORT PRINCIPAL (POD-1230)
 * ---------------------------------------------------------------------------
 *
 * `perf.report` used to call `pushClientTrace(…, DEPLOYMENT)` because the handler
 * only saw the registry and /trpc was assumed to have no principal. That was
 * true when this table was written; it is not true now.
 *
 * `FamilyState.feedPrincipal` is already derived from the authenticated cookie
 * principal (`derived-family.ts` → `requestPrincipal` in `server.ts`). Handing
 * it here is the same pattern `files` uses for a multi-member selector: the
 * widening is VISIBLE on the family, the handler never sees a `ctx`, and the
 * attribution cannot come from the trace payload (ADR 3 Am1 D17). A client that
 * forges another session's id in the body still lands on ITS OWN partition.
 */

import { type Principal } from '@podium/protocol'
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
import { perfPrincipal } from './principal'

/**
 * Exactly what the perf family reaches. `feedPrincipal` is the transport-
 * derived feed identity for this /trpc call — the same key the feed serving
 * path uses — or absent when the caller is not a user/agent (there is no
 * honest partition for a system principal's "switch trace").
 */
export interface PerfState {
  readonly perf: PerfRegistry
  readonly feedPrincipal?: Principal
}

export type PerfHandler<In, Out> = (state: PerfState, input: In) => Out

export interface PerfCommand {
  readonly contract: AnyCommandContract
  // biome-ignore lint/suspicious/noExplicitAny: heterogeneous table; each entry's
  // input type is pinned by its own contract through the `satisfies` below.
  readonly handler: PerfHandler<any, unknown>
}

export const PERF_COMMANDS_TRPC = {
  report: {
    contract: PERF_CONTRACTS.report,
    handler: ((state, input) => {
      // Transport principal only. The trace carries sessionId/issueId and those
      // MUST NOT decide the partition — a client could otherwise write into
      // another principal's ring (ADR 3 Am1 D17; POD-1230).
      if (state.feedPrincipal === undefined) {
        throw new Error('authenticated feed principal required to report a client switch trace')
      }
      state.perf.pushClientTrace(input, perfPrincipal(state.feedPrincipal))
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
    handler: ((state) => {
      state.perf.reset()
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

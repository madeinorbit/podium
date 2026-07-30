/**
 * THE JOIN — the one host-metrics contract (L1) paired with the L3 code that
 * implements it, per ADR 3 D1.
 *
 * Like `files`, this family selects more than one thing and names exactly what:
 * the hosts service that asks the daemon, the daemon RPC that enumerates repos
 * and worktrees, and the repo registry the roots are derived from.
 *
 * THE ROOTS ARE DERIVED SERVER-SIDE AND THAT IS A SECURITY PROPERTY, not an
 * implementation detail — it is why the contract can say the command cannot be
 * pointed at an arbitrary path. The caller supplies at most a `machineId`; the
 * roots are that machine's registered repos plus their worktrees. Worktrees often
 * live OUTSIDE the repo path as siblings, so the repo path alone would miss their
 * dev servers, and scoping to the clicked machine's repos keeps foreign paths out
 * of its /proc walk. All of that is moved verbatim from the router procedure.
 */

import {
  type AnyCommandContract,
  HOST_CONTRACT_NAMES,
  HOST_CONTRACTS,
  type HostContractName,
  registryClassificationErrors,
  type TransportTag,
} from '@podium/commands'
import { TRPCError } from '@trpc/server'
import type { z } from 'zod'
import type { RegistryModules } from '../../relay'
import type { RepoRegistry } from '../../repo-registry'

/** Exactly what the host family reaches, named. */
export interface HostState {
  readonly hosts: RegistryModules['hosts']
  readonly rpc: RegistryModules['rpc']
  readonly repos: RepoRegistry
}

export type HostHandler<In, Out> = (state: HostState, input: In) => Out

export interface HostCommand {
  readonly contract: AnyCommandContract
  // biome-ignore lint/suspicious/noExplicitAny: heterogeneous table; each entry's
  // input type is pinned by its own contract through the `satisfies` below.
  readonly handler: HostHandler<any, unknown>
}

export const HOST_COMMANDS_TRPC = {
  memoryBreakdown: {
    contract: HOST_CONTRACTS.memoryBreakdown,
    handler: (async (state, input) => {
      const machineId = input?.machineId
      const repoPaths = state.repos.list(machineId)
      const { repositories } = await state.rpc.scanRepos(
        repoPaths,
        { includeHome: false, maxDepth: 0 },
        machineId ?? undefined,
      )
      const roots = [
        ...new Set(repositories.flatMap((r) => [r.path, ...r.worktrees.map((w) => w.path)])),
      ]
      const breakdown = await state.hosts.memoryBreakdown(roots, machineId)
      if (!breakdown) {
        // The M5 refusal the contract's errorConsistency points at: unreachable
        // is a TIMEOUT and stays distinguishable from an unauthorized machine.
        throw new TRPCError({
          code: 'TIMEOUT',
          message: 'no daemon answered the memory breakdown request',
        })
      }
      return breakdown
    }) satisfies HostHandler<z.infer<(typeof HOST_CONTRACTS)['memoryBreakdown']['input']>, unknown>,
  },
} as const satisfies Record<HostContractName, HostCommand>

export type HostCommandName = keyof typeof HOST_COMMANDS_TRPC

export const isHostCommand = (name: string): name is HostCommandName =>
  Object.hasOwn(HOST_COMMANDS_TRPC, name)

/** ADR 3 D3, default-closed. */
export function isHostCommandExposedOn(name: string, transport: TransportTag): boolean {
  if (!isHostCommand(name)) return false
  return HOST_COMMANDS_TRPC[name].contract.exposure.includes(transport)
}

export const hostCommandsOn = (transport: TransportTag): HostCommandName[] =>
  HOST_CONTRACT_NAMES.filter((n) => isHostCommandExposedOn(n, transport))

export const hostRegistryClassificationErrors = (): string[] =>
  registryClassificationErrors(Object.values(HOST_COMMANDS_TRPC).map((c) => c.contract))

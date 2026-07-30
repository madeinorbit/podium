/**
 * THE JOIN — the one file-write contract (L1) paired with the L3 code that
 * implements it, per ADR 3 D1.
 *
 * ---------------------------------------------------------------------------
 * THIS FAMILY SELECTS THREE THINGS, NOT ONE, AND SAYS SO
 * ---------------------------------------------------------------------------
 *
 * Most families in this cutover hand their handlers a single service. `files`
 * genuinely needs three: the daemon RPC that performs the write, the repo
 * registry that backs the root allowlist, and the artifact store that serves
 * immutable snapshots on the read side. So its `service` selector returns a small
 * record naming exactly those, which keeps the widening VISIBLE in this file
 * rather than hidden in the builder — the builder still reads the state seam in
 * one place, and the handler still never sees a `ctx`.
 *
 * THE ROOT ALLOWLIST STAYS IN THE HANDLER, deliberately. It is the shipped gate,
 * moved verbatim: `isAllowedRoot(repos.list(), root)` throwing FORBIDDEN. It is
 * not promoted into the contract because a contract may not encode a rule that
 * has to READ OTHER ROWS — the registered repo set is state, not classification —
 * which is the same line `modules/specs` draws by leaving `requireRepoRoot`
 * inside `SpecsService`.
 */

import {
  type AnyCommandContract,
  FILE_CONTRACT_NAMES,
  FILE_CONTRACTS,
  type FileContractName,
  registryClassificationErrors,
  type TransportTag,
} from '@podium/commands'
import { TRPCError } from '@trpc/server'
import type { z } from 'zod'
import type { RegistryModules } from '../../relay'
import type { RepoRegistry } from '../../repo-registry'
import { isAllowedRoot } from '../../root-allowlist'

/** Exactly what the file family reaches, named. Nothing else is reachable from a
 *  handler here — in particular no capability and no registry. */
export interface FileState {
  readonly rpc: RegistryModules['rpc']
  readonly artifacts: RegistryModules['issueArtifacts']
  readonly repos: RepoRegistry
}

export type FileHandler<In, Out> = (state: FileState, input: In) => Out

export interface FileCommand {
  readonly contract: AnyCommandContract
  // biome-ignore lint/suspicious/noExplicitAny: heterogeneous table; each entry's
  // input type is pinned by its own contract through the `satisfies` below.
  readonly handler: FileHandler<any, unknown>
}

/** The shipped FORBIDDEN, moved verbatim. Shared by the write and the two reads
 *  so the three cannot drift into three notions of "an allowed root". */
export const assertAllowedRoot = (state: FileState, root: string): void => {
  if (!isAllowedRoot(state.repos.list(), root)) {
    throw new TRPCError({ code: 'FORBIDDEN', message: 'root is not a known repository path' })
  }
}

export const FILE_COMMANDS_TRPC = {
  write: {
    contract: FILE_CONTRACTS.write,
    handler: ((state, input) => {
      // The union's session-addressed arm resolves its root from the session and
      // carries no `root` to check; the explicit arm is gated. Shipped behaviour,
      // moved rather than rewritten.
      if ('root' in input) assertAllowedRoot(state, input.root)
      return state.rpc.writeFile(input)
    }) satisfies FileHandler<z.infer<(typeof FILE_CONTRACTS)['write']['input']>, unknown>,
  },
} as const satisfies Record<FileContractName, FileCommand>

export type FileCommandName = keyof typeof FILE_COMMANDS_TRPC

export const isFileCommand = (name: string): name is FileCommandName =>
  Object.hasOwn(FILE_COMMANDS_TRPC, name)

/** ADR 3 D3, default-closed. */
export function isFileCommandExposedOn(name: string, transport: TransportTag): boolean {
  if (!isFileCommand(name)) return false
  return FILE_COMMANDS_TRPC[name].contract.exposure.includes(transport)
}

export const fileCommandsOn = (transport: TransportTag): FileCommandName[] =>
  FILE_CONTRACT_NAMES.filter((n) => isFileCommandExposedOn(n, transport))

export const fileRegistryClassificationErrors = (): string[] =>
  registryClassificationErrors(Object.values(FILE_COMMANDS_TRPC).map((c) => c.contract))

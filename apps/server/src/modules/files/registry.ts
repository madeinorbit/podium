/**
 * THE JOIN — the one file-write contract (L1) paired with the L3 code that
 * implements it, per ADR 3 D1.
 *
 * ---------------------------------------------------------------------------
 * THIS FAMILY SELECTED THREE THINGS, AND THAT WAS THE DEFECT
 * ---------------------------------------------------------------------------
 *
 * Most families in this cutover hand their handlers a single service. `files`
 * appeared to genuinely need three: the daemon RPC that performs the write, the
 * repo registry that backs the root allowlist, and the artifact store that serves
 * immutable snapshots on the read side. Its `service` selector returned a small
 * record naming exactly those, which kept the widening VISIBLE in this file
 * rather than hidden in the builder.
 *
 * What that list never contained was an IDENTITY, and PDM-272 is what came of
 * it — see the section below. The selector returns ONE member now, and it is not
 * a narrower list of the same kind of thing: it is a set of verbs that have
 * already asked who is calling.
 *
 * ---------------------------------------------------------------------------
 * PDM-272 REPLACED THE THREE-MEMBER SERVICE WITH ONE GATE
 * ---------------------------------------------------------------------------
 *
 * The paragraph above used to end here, and what it said was true and was the
 * defect. `files` reached three things, said so, and named NO IDENTITY — so its
 * three reads authorized on the only thing in their seam, the path. The root
 * allowlist did stay in the handler; it answered "is this a known repository
 * path", which is containment, and no handler here could ask anything about the
 * caller because nothing about the caller was reachable.
 *
 * So the selector now returns ONE member, `FileAccessGate`, and the daemon RPC,
 * the artifact store and the repo registry are gone from this seam. The root
 * allowlist moved INTO the gate unchanged and still runs first on every
 * root-addressed door — it was never wrong, only insufficient. What a handler
 * can do with a file is now exactly the set of methods on that port, and each of
 * them refuses or acts.
 *
 * A contract still may not encode a rule that has to READ OTHER ROWS — the
 * registered repo set is state, not classification, and so is a session's owner.
 * That line is unchanged; the gate is where such rules live, which is the same
 * line `modules/specs` draws by leaving `requireRepoRoot` inside `SpecsService`.
 */

import {
  type AnyCommandContract,
  FILE_CONTRACT_NAMES,
  FILE_CONTRACTS,
  type FileContractName,
  registryClassificationErrors,
  type TransportTag,
} from '@podium/commands'
import type { z } from 'zod'
import type { FileAccessGate } from './file-access-gate'

/** Exactly what the file family reaches, named. Nothing else is reachable from a
 *  handler here — in particular no capability, no registry, and since PDM-272 no
 *  daemon RPC, artifact store or repo registry either. ONE member, and it is a
 *  set of pre-authorized verbs rather than the things they act on. */
export interface FileState {
  readonly files: FileAccessGate
}

export type FileHandler<In, Out> = (state: FileState, input: In) => Out

export interface FileCommand {
  readonly contract: AnyCommandContract
  // biome-ignore lint/suspicious/noExplicitAny: heterogeneous table; each entry's
  // input type is pinned by its own contract through the `satisfies` below.
  readonly handler: FileHandler<any, unknown>
}

export const FILE_COMMANDS_TRPC = {
  write: {
    contract: FILE_CONTRACTS.write,
    // BEHAVIOUR UNCHANGED (PDM-272). The root allowlist and the untouched
    // session-addressed arm both moved into `FileAccessGate.writeFile` verbatim;
    // see that method's note on why a read-authorization issue does not
    // re-authorize a write in passing.
    handler: (async (state, input) =>
      await state.files.writeFile(input)) satisfies FileHandler<
      z.infer<(typeof FILE_CONTRACTS)['write']['input']>,
      unknown
    >,
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

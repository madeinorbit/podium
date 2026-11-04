/**
 * THE DERIVED FILE SURFACE (POD-314) — `write` from the contract table, `read`
 * and `list` from the query table.
 *
 * The selector returns the three things this family reaches (see `registry.ts`),
 * so the widening past a single service is visible in the family rather than in
 * the builder.
 *
 * `write` IS AN EFFECT RECORD (POD-6395). The derived procedure is replaced by
 * an adapter with the same input and answer: it keeps the shipped root gate,
 * creates a `file.write` effect record through `sync.submit` as its caller, and
 * answers once the record settles (`write-effect.ts`). The table entry stays the
 * contract's declaration; the executor does the write.
 */

import { FILE_CONTRACTS } from '@podium/commands'
import { type Context, t } from '../../trpc'
import { derivedFamilyProcedures, type FamilyProcedures, familyState } from '../derived-family'
import { refusalAsTrpcError, submitFromRoute } from '../sync-write/route-adapter'
import { FILE_QUERIES } from './queries'
import { assertAllowedRoot, FILE_COMMANDS_TRPC, type FileState } from './registry'
import {
  FILE_WRITE_EFFECT_KIND,
  FILE_WRITE_WAIT_MS,
  type FileWriteAnswer,
  type FileWriteInput,
  fileWriteAnswer,
  fileWriteTarget,
  newFileEffectId,
} from './write-effect'

export type FileProcedures = FamilyProcedures<typeof FILE_COMMANDS_TRPC, typeof FILE_QUERIES>

const fileState = (ctx: Context): FileState => {
  const state = familyState(ctx)
  return { rpc: state.modules.rpc, artifacts: state.modules.issueArtifacts, repos: state.repos }
}

/** `files.write` through an effect record, answering as the route always did. */
async function writeThroughEffect(ctx: Context, input: FileWriteInput): Promise<FileWriteAnswer> {
  // The shipped FORBIDDEN, with its message, before anything is recorded.
  if ('root' in input) await assertAllowedRoot(fileState(ctx), input.root)
  const state = familyState(ctx)
  const effects = state.modules.effects
  if (effects === undefined) throw new Error('files.write: the effect path is not wired')
  // A fresh envelope id: a save is never replayed (online-only, ADR 3 D18.3).
  const id = newFileEffectId()
  const { reply, cause } = await submitFromRoute(ctx, {
    command: 'effects.create',
    input: {
      id,
      kind: FILE_WRITE_EFFECT_KIND,
      target: fileWriteTarget(input, ctx.registry.sessionStore.hostMachineId),
      input,
    },
  })
  if (reply.outcome !== 'applied') {
    if (cause !== undefined) throw cause
    throw refusalAsTrpcError('files.write', reply.refusal)
  }
  return fileWriteAnswer(await effects.awaitSettled(id, FILE_WRITE_WAIT_MS))
}

/** THE DERIVED PROCEDURES, spread into `router.ts`'s `files` router. */
export const fileFamilyProcedures = (): FileProcedures => {
  const derived = derivedFamilyProcedures({
    family: 'files',
    service: (state) => ({
      rpc: state.modules.rpc,
      artifacts: state.modules.issueArtifacts,
      repos: state.repos,
    }),
    commands: FILE_COMMANDS_TRPC,
    queries: FILE_QUERIES,
  })
  return {
    ...derived,
    write: t.procedure
      .input(FILE_CONTRACTS.write.input)
      .mutation(async ({ ctx, input }) => await writeThroughEffect(ctx, input)),
  } as FileProcedures
}

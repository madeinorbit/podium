/**
 * Dock-shell tRPC surface (POD-4436) — `shells.forWorktree`.
 *
 * Returns-or-creates the calling principal's dock shell for one worktree, so
 * the same dock shell opens on every device. Tab shells (New Shell from the +
 * menu) are unmapped by design (SP-75b1): they go through `sessions.create`
 * directly and never touch this router.
 *
 * ON THE SYNC WRITE ENTRY POINT since POD-6419 (`sync-write.ts`): the write
 * claims the mapping and asks for the shell's start as a `session.launch`
 * effect record; the spawn runs after the commit.
 */

import type { TRPCMutationProcedure } from '@trpc/server'
import { t } from '../../trpc'
import { routeThroughEntry } from '../sync-write/route-adapter'
import type { ForWorktreeInput, ForWorktreeOutput } from './sync-write'

type ForWorktreeProcedure = TRPCMutationProcedure<{
  meta: unknown
  input: ForWorktreeInput
  output: ForWorktreeOutput
}>

/** The input is parsed by the entry point, after the coarse check. */
const unparsed = (raw: unknown): unknown => raw

/** Shell procedures for the root router under the `shells` namespace. */
export function shellFamilyProcedures(): { forWorktree: ForWorktreeProcedure } {
  return {
    /**
     * LEGACY(remove-after: 2027-03): a thin adapter onto `sync.submit` for the
     * desktop app's bundled web, which calls this route. Removing it breaks that
     * app's dock shell against this server.
     */
    forWorktree: t.procedure.input(unparsed).mutation(
      async ({ ctx, input }) =>
        (await routeThroughEntry(ctx, {
          command: 'shells.forWorktree',
          input,
        })) as ForWorktreeOutput,
    ) as unknown as ForWorktreeProcedure,
  }
}
